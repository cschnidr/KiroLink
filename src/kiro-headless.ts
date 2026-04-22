import { spawn } from "node:child_process";
import stripAnsi from "strip-ansi";

export interface KiroInvocation {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

/**
 * Clean Kiro CLI headless output for display:
 *  - strip ANSI color codes
 *  - strip tool-call output blocks (everything up to and including the
 *    trailing "- Completed in X.XXs" line Kiro emits after each tool run)
 *  - strip the leading "> " reply marker Kiro still prints in --no-interactive
 *  - strip the trailing "▸ Credits: ... • Time: ..." footer
 */
export function cleanKiroOutput(raw: string): string {
  let text = stripAnsi(raw);
  // Remove tool-call output blocks. Each block ends in a line like
  // "  - Completed in 0.39s". Consume everything up to and including that
  // marker line. Anchored to end-of-line so narrative prose can't trigger.
  text = text.replace(/^[\s\S]*?-\s*Completed in \d+(?:\.\d+)?s\s*$/gm, "");
  // Remove the footer line(s) at the end.
  text = text.replace(/\n?\s*▸\s*Credits:[^\n]*(\n|$)/g, "");
  // Remove leading "> " reply markers on individual lines.
  text = text.replace(/^\s*>\s?/gm, "");
  return text.trim();
}

export interface KiroOptions {
  command: string;
  extraArgs: string[];
  cwd: string;
  timeoutMs: number;
  apiKey?: string;
}

/**
 * Handle returned alongside a running invocation; lets callers abort it.
 */
export interface KiroHandle {
  promise: Promise<KiroInvocation>;
  cancel(): void;
}

/**
 * Invoke Kiro CLI in headless (non-interactive) mode and return its stdout.
 * Each call is independent - no session state is preserved between invocations.
 */
export function runKiro(prompt: string, opts: KiroOptions): KiroHandle {
  let cancelled = false;
  let cancelFn: () => void = () => { cancelled = true; };

  const promise = new Promise<KiroInvocation>((resolve, reject) => {
    const start = Date.now();
    const args = ["chat", "--no-interactive", ...opts.extraArgs, prompt];

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: process.env.NODE_ENV,
      LANG: process.env.LANG,
    };
    if (opts.apiKey) env.KIRO_API_KEY = opts.apiKey;

    const child = spawn(opts.command, args, {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    cancelFn = () => {
      cancelled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000).unref();
    };

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const maxBuffer = 50 * 1024 * 1024; // 50 MB

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length + stderr.length > maxBuffer) {
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stdout.length + stderr.length > maxBuffer) {
        child.kill("SIGKILL");
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (cancelled) {
        reject(new Error("Cancelled by user"));
        return;
      }
      if (timedOut) {
        reject(new Error(`Kiro CLI timed out after ${opts.timeoutMs}ms`));
        return;
      }
      resolve({
        stdout,
        stderr,
        exitCode: code,
        durationMs: Date.now() - start,
      });
    });
  });

  return { promise, cancel: () => cancelFn() };
}
