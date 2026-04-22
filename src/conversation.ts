import fs from "node:fs";
import path from "node:path";

export interface Turn {
  role: "user" | "assistant";
  text: string;
  at: number;
}

/**
 * File-backed append-only conversation log. Kiro CLI in --no-interactive
 * mode starts fresh each call, so we prepend the recent turns as context.
 */
export class ConversationLog {
  private readonly filePath: string;
  private turns: Turn[] = [];
  private readonly maxTurns: number;
  private lastActivityAt = 0;

  constructor(filePath: string, maxTurns = 10) {
    this.filePath = filePath;
    this.maxTurns = maxTurns;
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this.turns = raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Turn);
      this.lastActivityAt = this.turns[this.turns.length - 1]?.at ?? 0;
    } catch (err) {
      console.log(JSON.stringify({ level: "warn", msg: "conversation load failed", err: String(err) }));
      this.turns = [];
    }
  }

  private persist(turn: Turn): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(turn) + "\n");
    } catch (err) {
      console.log(JSON.stringify({ level: "warn", msg: "conversation persist failed", err: String(err) }));
    }
  }

  /**
   * Rewrite the log to contain only the currently retained turns.
   * Keeps the file from growing unbounded over time.
   */
  private rewriteLog(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const data = this.turns.map((t) => JSON.stringify(t)).join("\n") + (this.turns.length ? "\n" : "");
      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.log(JSON.stringify({ level: "warn", msg: "conversation rewrite failed", err: String(err) }));
    }
  }

  private static readonly MAX_TURN_CHARS = 2000;

  append(role: Turn["role"], text: string): void {
    const capped =
      role === "assistant" && text.length > ConversationLog.MAX_TURN_CHARS
        ? text.slice(0, ConversationLog.MAX_TURN_CHARS) + "\n…(truncated)"
        : text;
    const turn: Turn = { role, text: capped, at: Date.now() };
    this.turns.push(turn);
    this.lastActivityAt = turn.at;

    // Keep in-memory turns bounded; rewrite the log when we prune.
    const hardCap = this.maxTurns * 3;
    if (this.turns.length > hardCap) {
      this.turns = this.turns.slice(-hardCap);
      this.rewriteLog();
    } else {
      this.persist(turn);
    }
  }

  reset(): void {
    this.turns = [];
    this.lastActivityAt = 0;
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // ignore
    }
  }

  getRecentTurns(n = 5): Turn[] {
    return this.turns.slice(-n);
  }

  getLastActivityAt(): number {
    return this.lastActivityAt;
  }

  /** Match absolute paths that look like real files (not URLs or noise). */
  private static readonly FILE_PATH_RE = /(?:^|\s)(\/[\w./-]+\.[\w]{1,10})\b/g;

  /** Extract unique file paths mentioned in assistant turns. */
  private extractFileRefs(turns: Turn[]): string[] {
    const seen = new Set<string>();
    for (const t of turns) {
      if (t.role !== "assistant") continue;
      for (const m of t.text.matchAll(ConversationLog.FILE_PATH_RE)) {
        seen.add(m[1]);
      }
    }
    return [...seen];
  }

  /**
   * Build a prompt that includes recent context. The newest user message
   * is assumed to already be appended to the log before calling this.
   *
   * Optional `systemContext` is prepended as a system header so Kiro
   * knows what it can and cannot do (tool trust, cwd, etc.) without
   * having to probe-and-fail.
   */
  buildPromptWithContext(systemContext?: string): string {
    const recent = this.turns.slice(-this.maxTurns);
    if (recent.length === 0) return "";

    // All turns except the last one become "context"; the last (user) turn is the actual prompt.
    const history = recent.slice(0, -1);
    const current = recent[recent.length - 1];

    const fileRefs = this.extractFileRefs(history);

    const sections: string[] = [];

    if (systemContext && systemContext.trim()) {
      sections.push("[System context]", systemContext, "");
    }

    sections.push("You are responding to a user chatting with you over Telegram.");

    if (fileRefs.length) {
      sections.push(
        "Files previously examined:",
        fileRefs.join("\n"),
      );
    }

    if (history.length > 0) {
      const historyText = history
        .map((t) => (t.role === "user" ? `User: ${t.text}` : `Assistant: ${t.text}`))
        .join("\n\n");
      sections.push(
        "Previous conversation context:",
        "---",
        historyText,
        "---",
      );
    }

    sections.push(`Current user message: ${current.text}`);

    return sections.join("\n");
  }
}
