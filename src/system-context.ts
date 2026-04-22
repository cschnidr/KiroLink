/**
 * Build a runtime-derived system context header that's prepended to every
 * Kiro CLI invocation. Kiro CLI in --no-interactive mode has no way to
 * tell the model which tools are trusted, so without this the agent
 * wastes turns probing disallowed tools (classic case: trying shell for
 * `tail` when only `read` is trusted).
 *
 * Everything here is derived from the current runtime state — .env values
 * plus live state like /cd changes — so there's never drift between
 * what's configured and what Kiro is told.
 */

const ALL_TOOLS = ["read", "write", "shell", "grep", "glob", "code", "aws", "report"];

interface TrustInfo {
  mode: "all" | "list" | "agent" | "default";
  trusted: string[]; // only populated when mode === "list"
  denied: string[];  // only populated when mode === "list"
  agentPath?: string;
}

function parseTrust(extraArgs: string[]): TrustInfo {
  if (extraArgs.includes("--trust-all-tools")) {
    return { mode: "all", trusted: [], denied: [] };
  }

  const agentFlagIdx = extraArgs.findIndex((a) => a === "--agent" || a.startsWith("--agent="));
  if (agentFlagIdx >= 0) {
    const flag = extraArgs[agentFlagIdx];
    const agentPath = flag.startsWith("--agent=")
      ? flag.slice("--agent=".length)
      : extraArgs[agentFlagIdx + 1];
    return { mode: "agent", trusted: [], denied: [], agentPath };
  }

  const trustFlag = extraArgs.find((a) => a.startsWith("--trust-tools="));
  if (trustFlag) {
    const list = trustFlag
      .slice("--trust-tools=".length)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const denied = ALL_TOOLS.filter((t) => !list.includes(t));
    return { mode: "list", trusted: list, denied };
  }

  // No explicit flag → code falls back to --trust-all-tools (see index.ts).
  return { mode: "default", trusted: [], denied: [] };
}

export interface SystemContextInput {
  extraArgs: string[];
  cwd: string;
  allowedCwds: string[];
  timeoutMs: number;
}

export function buildSystemContext(input: SystemContextInput): string {
  const trust = parseTrust(input.extraArgs);
  const lines: string[] = [];

  lines.push(
    "You are running in Kiro CLI headless mode, invoked by the KiroLink",
    "Telegram bridge. Your reply will be posted verbatim into a Telegram",
    "chat, so keep output concise and plain-text friendly (no huge tables,",
    "no wide code blocks).",
    "",
    "Runtime constraints:",
  );

  switch (trust.mode) {
    case "all":
    case "default":
      lines.push(
        "- Tool trust: ALL tools trusted (read, write, shell, aws, etc.).",
        "  Proceed directly with tool calls as needed.",
      );
      break;
    case "list":
      lines.push(
        `- Trusted tools: ${trust.trusted.join(", ")}.`,
        `- Denied tools (DO NOT attempt — calls will fail): ${trust.denied.join(", ") || "(none)"}.`,
      );
      if (trust.denied.includes("shell")) {
        lines.push(
          "- Shell is denied: do NOT try to run `tail`, `ls`, `cat`, `grep` via shell.",
          "  Use the `read` and `grep` tools for file contents and searches instead.",
        );
      }
      if (trust.denied.includes("write")) {
        lines.push(
          "- Writes are denied: do NOT attempt to edit or create files. Tell the",
          "  user they need write permission granted in KIROLINK_KIRO_EXTRA_ARGS.",
        );
      }
      break;
    case "agent":
      lines.push(
        `- Custom agent in use: ${trust.agentPath}.`,
        "  Tool trust is defined by the agent's configuration.",
      );
      break;
  }

  lines.push(`- Working directory: ${input.cwd}`);
  if (input.allowedCwds.length) {
    lines.push(`- Allowed roots for /cd: ${input.allowedCwds.join(", ")}`);
  }
  lines.push(`- Per-invocation timeout: ${Math.round(input.timeoutMs / 1000)}s`);

  return lines.join("\n");
}
