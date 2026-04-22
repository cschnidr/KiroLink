import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Bot, InputFile } from "grammy";
import { runKiro, cleanKiroOutput, type KiroHandle } from "./kiro-headless.js";
import { ConversationLog } from "./conversation.js";
import { RateLimiter, PinGate, AuditLog, checkEnvPermissions } from "./security.js";
import { buildSystemContext } from "./system-context.js";

const execFileP = promisify(execFile);

async function getKiroVersion(command: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP(command, ["--version"], {
      cwd,
      timeout: 5000,
    });
    return stdout.trim() || "(unknown)";
  } catch (err) {
    return `unavailable (${String(err).split("\n")[0].slice(0, 120)})`;
  }
}

interface KiroModel {
  name: string;
  description?: string;
}

async function listKiroModels(command: string, cwd: string): Promise<KiroModel[]> {
  const { stdout } = await execFileP(
    command,
    ["chat", "--list-models", "--format", "json"],
    { cwd, timeout: 10000 },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    // Kiro 2.x returns { models: [...], default_model: "..." }
    // where each model has model_name, description, model_id, etc.
    // Older versions may return a flat array.
    const arr: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.models)
        ? ((parsed as Record<string, unknown>).models as unknown[])
        : [];
    return arr
      .map((m: unknown): KiroModel => {
        if (typeof m === "string") return { name: m };
        const obj = m as Record<string, unknown>;
        const name = String(obj.model_name ?? obj.name ?? obj.model_id ?? obj.id ?? "");
        const description = typeof obj.description === "string" ? obj.description : undefined;
        return { name, description };
      })
      .filter((m) => m.name);
  } catch {
    // Fallback: plain-text list (best-effort)
    return trimmed
      .split("\n")
      .map((l: string) => l.replace(/^[*\s]+/, "").split(/\s{2,}/)[0].trim())
      .filter((n: string) => n && !/^Available models/i.test(n))
      .map((name: string) => ({ name }));
  }
}

async function getCurrentModel(command: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileP(
      command,
      ["settings", "chat.defaultModel"],
      { cwd, timeout: 5000 },
    );
    const out = stdout.trim();
    return out || "auto";
  } catch {
    return "auto";
  }
}

async function setCurrentModel(command: string, cwd: string, model: string | null): Promise<void> {
  if (model === null) {
    await execFileP(command, ["settings", "--delete", "chat.defaultModel"], {
      cwd,
      timeout: 5000,
    });
    return;
  }
  await execFileP(command, ["settings", "chat.defaultModel", model], {
    cwd,
    timeout: 5000,
  });
}

const token = process.env.KIROLINK_BOT_TOKEN;
if (!token) {
  console.error(JSON.stringify({ level: "error", msg: "KIROLINK_BOT_TOKEN is not set" }));
  process.exit(1);
}

// Startup security checks
checkEnvPermissions(path.join(process.cwd(), ".env"));

const allowedUsers = new Set(
  (process.env.KIROLINK_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
);

const kiroCommand = process.env.KIROLINK_KIRO_COMMAND ?? "kiro-cli";
const kiroExtraArgs = (process.env.KIROLINK_KIRO_EXTRA_ARGS ?? "--trust-all-tools")
  .split(/\s+/)
  .filter(Boolean);
const defaultKiroCwd = process.env.KIROLINK_KIRO_CWD || process.env.HOME || process.cwd();
let kiroCwd = defaultKiroCwd;
const allowedCwds = (process.env.KIROLINK_ALLOWED_CWDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => path.resolve(expandPath(p)));
const kiroTimeoutMs = Number(process.env.KIROLINK_KIRO_TIMEOUT_MS ?? 300000);
const kiroApiKey = process.env.KIRO_API_KEY;

function expandPath(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function isCwdAllowed(candidate: string): boolean {
  if (allowedCwds.length === 0) return true;
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return false;
  }
  const resolved = real + path.sep;
  return allowedCwds.some((root) => {
    const rootWithSep = root + path.sep;
    return resolved === rootWithSep || resolved.startsWith(rootWithSep);
  });
}

const conversationPath = process.env.KIROLINK_CONVERSATION_PATH ??
  path.join(process.env.HOME ?? process.cwd(), ".local/share/kirolink/conversation.log");
const conversationMaxTurns = Number(process.env.KIROLINK_CONVERSATION_MAX_TURNS ?? 10);
const conversation = new ConversationLog(conversationPath, conversationMaxTurns);

const idleTimeoutMinutes = Number(process.env.KIROLINK_IDLE_TIMEOUT_MINUTES ?? 30);
const rateLimitPerMin = Number(process.env.KIROLINK_RATE_LIMIT_PER_MIN ?? 10);
const auditLogPath = process.env.KIROLINK_AUDIT_LOG_PATH ??
  path.join(process.env.HOME ?? process.cwd(), ".local/share/kirolink/audit.log");

const rateLimiter = new RateLimiter(rateLimitPerMin);
const pinGate = new PinGate(process.env.KIROLINK_BOT_PIN, idleTimeoutMinutes);
const audit = new AuditLog(auditLogPath);

const maxMessageLength = 4096;
const fileUploadThreshold = Number(process.env.KIROLINK_FILE_UPLOAD_THRESHOLD ?? 10000);

const bot = new Bot(token);

// Allowlist middleware
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !allowedUsers.has(userId)) {
    audit.record({ userId, kind: "denied", detail: "not in allowlist" });
    console.log(JSON.stringify({ level: "debug", msg: "dropped unauthorized user", userId }));
    return;
  }
  await next();
});

// PIN gate + rate limit middleware (applies to text messages, not all commands)
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  // Let /unlock always through; other commands still require unlock when enabled.
  const text = ctx.message?.text?.trim() ?? "";
  const isUnlockCmd = text.startsWith("/unlock");

  if (pinGate.enabled() && pinGate.isLockedOut(userId)) {
    audit.record({ userId, kind: "denied", detail: "brute-force lockout" });
    await ctx.reply("🔒 Too many failed PIN attempts. Try again in 15 minutes.");
    return;
  }

  if (pinGate.enabled() && !pinGate.isUnlocked(userId) && !isUnlockCmd) {
    audit.record({ userId, kind: "locked_out" });
    await ctx.reply("🔒 Session locked. Send /unlock <PIN> to start.");
    return;
  }

  if (!rateLimiter.allow(userId)) {
    audit.record({ userId, kind: "denied", detail: "rate limit" });
    await ctx.reply(`Rate limit: max ${rateLimitPerMin} messages/minute. Try again shortly.`);
    return;
  }

  await next();
});

// Commands
bot.command("unlock", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (!pinGate.enabled()) {
    await ctx.reply("PIN is not configured. Nothing to unlock.");
    return;
  }
  const candidate = ctx.match?.toString().trim() ?? "";
  if (!candidate) {
    await ctx.reply("Usage: /unlock <PIN>");
    return;
  }
  if (pinGate.tryUnlock(userId, candidate)) {
    audit.record({ userId, kind: "unlock" });
    await ctx.reply("Unlocked. Session active.");
  } else if (pinGate.isLockedOut(userId)) {
    audit.record({ userId, kind: "denied", detail: "lockout" });
    await ctx.reply("Too many failed attempts. Locked out for 15 minutes.");
  } else {
    audit.record({ userId, kind: "denied", detail: "bad pin" });
    await ctx.reply("Wrong PIN.");
  }
});

bot.command("lock", async (ctx) => {
  const userId = ctx.from?.id;
  if (userId) pinGate.lock(userId);
  audit.record({ userId, kind: "command", detail: "/lock" });
  await ctx.reply("Locked. Send /unlock <PIN> to resume.");
});

bot.command("new", async (ctx) => {
  audit.record({ userId: ctx.from?.id, kind: "command", detail: "/new" });
  conversation.reset();
  await ctx.reply("New conversation started.");
});

bot.command("status", async (ctx) => {
  audit.record({ userId: ctx.from?.id, kind: "command", detail: "/status" });
  const turns = conversation.getRecentTurns(1000).length;
  const last = conversation.getLastActivityAt();
  const idleMins = last ? Math.round((Date.now() - last) / 60000) : 0;
  const kiroVersion = await getKiroVersion(kiroCommand, kiroCwd);
  const model = await getCurrentModel(kiroCommand, kiroCwd);
  const lines = [
    `Kiro: ${kiroCommand} ${kiroExtraArgs.join(" ")}`,
    `Kiro version: ${kiroVersion}`,
    `Model: ${model}`,
    `Working dir: ${kiroCwd}${kiroCwd !== defaultKiroCwd ? " (changed via /cd)" : ""}`,
    `Allowed roots: ${allowedCwds.length ? allowedCwds.join(", ") : "any"}`,
    `Timeout: ${kiroTimeoutMs}ms`,
    `Turns in memory: ${turns}`,
    `Idle for: ${last ? `${idleMins}m` : "(no activity)"}`,
    `PIN unlock window: ${idleTimeoutMinutes}m`,
    `Rate limit: ${rateLimitPerMin}/min`,
    `PIN gate: ${pinGate.enabled() ? "enabled" : "disabled"}`,
    `Auth: ${kiroApiKey ? "API key" : "inherited"}`,
    `Running: ${activeHandle ? "yes (use /cancel)" : "no"}`,
  ];
  await ctx.reply(lines.join("\n"));
});

bot.command("history", async (ctx) => {
  audit.record({ userId: ctx.from?.id, kind: "command", detail: "/history" });
  const turns = conversation.getRecentTurns(10);
  if (turns.length === 0) {
    await ctx.reply("No conversation history.");
    return;
  }
  const body = turns
    .map((t) => {
      const who = t.role === "user" ? "You" : "Kiro";
      const text = t.text.length > 300 ? t.text.slice(0, 300) + "…" : t.text;
      return `${who}: ${text}`;
    })
    .join("\n\n");
  const preview = body.length > maxMessageLength ? body.slice(-maxMessageLength) : body;
  await ctx.reply(preview);
});

bot.command("cancel", async (ctx) => {
  audit.record({ userId: ctx.from?.id, kind: "command", detail: "/cancel" });
  if (!activeHandle) {
    await ctx.reply("Nothing to cancel.");
    return;
  }
  activeHandle.cancel();
  await ctx.reply("Cancelling Kiro...");
});

bot.command("help", async (ctx) => {
  audit.record({ userId: ctx.from?.id, kind: "command", detail: "/help" });
  const lines = [
    "KiroLink — Kiro CLI over Telegram",
    "",
    "Just send a message to talk to Kiro. Commands:",
    "",
    "/new — reset the conversation context",
    "/status — show config, idle time, running state",
    "/history — preview recent turns",
    "/cancel — abort the current Kiro invocation",
    "/cd [path] — show or change Kiro's working dir",
    "/model [name|auto] — show/set the model Kiro should use",
  ];
  if (pinGate.enabled()) {
    lines.push("/unlock <PIN> — unlock a session");
    lines.push("/lock — lock the session");
  }
  lines.push("/help — show this message");
  await ctx.reply(lines.join("\n"));
});

bot.command("cd", async (ctx) => {
  const userId = ctx.from?.id;
  const arg = ctx.match?.toString().trim() ?? "";
  audit.record({ userId, kind: "command", detail: `/cd ${arg}` });

  if (!arg) {
    await ctx.reply(`Current Kiro working dir:\n${kiroCwd}`);
    return;
  }  if (activeHandle) {
    await ctx.reply("Kiro is currently running. Use /cancel first, then /cd.");
    return;
  }

  const expanded = path.resolve(expandPath(arg));
  if (!isCwdAllowed(expanded)) {
    await ctx.reply(
      `Directory not in allowed roots.\nAllowed: ${allowedCwds.join(", ") || "(none configured)"}`,
    );
    return;
  }

  try {
    const stat = fs.statSync(expanded);
    if (!stat.isDirectory()) {
      await ctx.reply(`Not a directory: ${expanded}`);
      return;
    }
  } catch (err) {
    await ctx.reply(`Can't access ${expanded}: ${String(err).split("\n")[0]}`);
    return;
  }

  kiroCwd = expanded;
  conversation.reset();
  await ctx.reply(`Working dir changed to:\n${kiroCwd}\nConversation was reset.`);
});

bot.command("model", async (ctx) => {
  const userId = ctx.from?.id;
  const arg = ctx.match?.toString().trim() ?? "";
  audit.record({ userId, kind: "command", detail: `/model ${arg}` });

  // Without arg: list supported models + current selection.
  if (!arg) {
    let models: KiroModel[];
    try {
      models = await listKiroModels(kiroCommand, kiroCwd);
    } catch (err) {
      await ctx.reply(`Couldn't list models: ${String(err).split("\n")[0]}`);
      return;
    }
    const current = await getCurrentModel(kiroCommand, kiroCwd);
    if (models.length === 0) {
      await ctx.reply(`Current model: ${current}\n(No models returned by Kiro CLI.)`);
      return;
    }
    const list = models
      .map((m) => (m.name === current ? `• ${m.name} ← current` : `• ${m.name}`))
      .join("\n");
    await ctx.reply(
      `Current model: ${current}\n\nAvailable models:\n${list}\n\nSet with: /model <name>  (or /model auto to revert)`,
    );
    return;
  }

  // /model auto → clear the override, revert to Kiro's default model.
  if (arg === "auto") {
    try {
      await setCurrentModel(kiroCommand, kiroCwd, null);
      await ctx.reply("Model reverted to auto (Kiro default).");
    } catch (err) {
      await ctx.reply(`Couldn't reset model: ${String(err).split("\n")[0]}`);
    }
    return;
  }

  // /model <name> → validate against the list, then set.
  let models: KiroModel[];
  try {
    models = await listKiroModels(kiroCommand, kiroCwd);
  } catch (err) {
    await ctx.reply(`Couldn't list models to validate: ${String(err).split("\n")[0]}`);
    return;
  }
  const match = models.find((m) => m.name === arg);
  if (!match) {
    const suggestions = models.map((m) => m.name).join(", ") || "(none)";
    await ctx.reply(`Unknown model: ${arg}\nAvailable: ${suggestions}`);
    return;
  }
  try {
    await setCurrentModel(kiroCommand, kiroCwd, match.name);
    await ctx.reply(`Model set to: ${match.name}`);
  } catch (err) {
    await ctx.reply(`Couldn't set model: ${String(err).split("\n")[0]}`);
  }
});

// Serialize Kiro invocations: one at a time to avoid conflicting tool calls.
let activeHandle: KiroHandle | null = null;

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text) return;
  const userId = ctx.from?.id;

  audit.record({ userId, kind: "message", detail: text.length > 200 ? text.slice(0, 200) + "…" : text });

  if (activeHandle) {
    await ctx.reply("Still working on the previous message. Use /cancel if needed.");
    return;
  }

  // Note: conversation is no longer auto-reset on idle. The log is pruned by
  // turn count (KIROLINK_CONVERSATION_MAX_TURNS), and users can explicitly
  // reset with /new. KIROLINK_IDLE_TIMEOUT_MINUTES now only controls how long
  // a PIN-gate unlock remains valid.

  const typingTimer = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);
  ctx.replyWithChatAction("typing").catch(() => {});

  try {
    conversation.append("user", text);
    const systemContext = buildSystemContext({
      extraArgs: kiroExtraArgs,
      cwd: kiroCwd,
      allowedCwds,
      timeoutMs: kiroTimeoutMs,
    });
    const prompt = conversation.buildPromptWithContext(systemContext);

    console.log(JSON.stringify({
      level: "info",
      msg: "invoking kiro",
      userId,
      promptLen: prompt.length,
    }));

    activeHandle = runKiro(prompt, {
      command: kiroCommand,
      extraArgs: kiroExtraArgs,
      cwd: kiroCwd,
      timeoutMs: kiroTimeoutMs,
      apiKey: kiroApiKey,
    });

    const result = await activeHandle.promise;

    console.log(JSON.stringify({
      level: "info",
      msg: "kiro returned",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdoutLen: result.stdout.length,
    }));

    const cleaned = cleanKiroOutput(result.stdout);
    const reply = cleaned || cleanKiroOutput(result.stderr) || "(empty response)";

    if (result.exitCode !== 0 && !cleaned) {
      const safeStderr = result.stderr
        .split("\n")
        .filter((l) => !/(?:TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL)=/i.test(l))
        .join("\n")
        .slice(0, 2000);
      await ctx.reply(`Kiro CLI exited with code ${result.exitCode}:\n${safeStderr}`);
      return;
    }

    conversation.append("assistant", reply);
    if (userId) pinGate.touch(userId);
    await sendReply(ctx, reply);
  } catch (err) {
    const msg = String(err);
    console.log(JSON.stringify({ level: "error", msg: "kiro invocation failed", err: msg }));
    try {
      await ctx.reply(msg.includes("Cancelled") ? "Cancelled." : `Error: ${msg}`);
    } catch {
      // ignore
    }
  } finally {
    clearInterval(typingTimer);
    activeHandle = null;
  }
});

async function sendReply(ctx: import("grammy").Context, reply: string): Promise<void> {
  if (reply.length > fileUploadThreshold) {
    const buffer = Buffer.from(reply, "utf8");
    await ctx.replyWithDocument(new InputFile(buffer, "response.txt"));
    return;
  }
  if (reply.length <= maxMessageLength) {
    await ctx.reply(reply);
    return;
  }
  for (let i = 0; i < reply.length; i += maxMessageLength) {
    await ctx.reply(reply.slice(i, i + maxMessageLength));
  }
}

// Graceful shutdown
const shutdown = () => {
  activeHandle?.cancel();
  bot.stop();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

bot.start({
  onStart: (botInfo) => {
    console.log(JSON.stringify({
      level: "info",
      msg: "bot started",
      username: botInfo.username,
      allowedUsers: allowedUsers.size,
      kiroCommand,
      kiroExtraArgs,
      kiroCwd,
      conversationPath,
      idleTimeoutMinutes,
      rateLimitPerMin,
      pinGateEnabled: pinGate.enabled(),
      auditLogPath,
    }));
  },
});
