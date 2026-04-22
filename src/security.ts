import fs from "node:fs";
import path from "node:path";

/**
 * Sliding-window rate limiter: tracks message timestamps per user and
 * rejects messages that would exceed `maxPerMinute` within a 60s window.
 */
export class RateLimiter {
  private readonly timestamps = new Map<number, number[]>();
  constructor(private readonly maxPerMinute: number) {}

  allow(userId: number): boolean {
    if (this.maxPerMinute <= 0) return true;
    const now = Date.now();
    const cutoff = now - 60_000;
    const prev = this.timestamps.get(userId) ?? [];
    const recent = prev.filter((t) => t > cutoff);
    if (recent.length >= this.maxPerMinute) {
      this.timestamps.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.timestamps.set(userId, recent);
    return true;
  }
}

/**
 * PIN gate: when enabled, requires each user to enter the correct PIN
 * once per "session", where a session ends when the process restarts or
 * after `idleTimeoutMinutes` of inactivity.
 */
export class PinGate {
  private readonly unlockedUntil = new Map<number, number>();
  private readonly failedAttempts = new Map<number, number>();
  private readonly lockedOutUntil = new Map<number, number>();
  private static readonly MAX_ATTEMPTS = 5;
  private static readonly LOCKOUT_MS = 15 * 60_000; // 15 minutes
  constructor(
    private readonly pin: string | undefined,
    private readonly idleTimeoutMinutes: number,
  ) {}

  /** True if the gate is enabled (a PIN is configured). */
  enabled(): boolean {
    return !!this.pin;
  }

  /** Is this user currently authenticated (and not idle-timed-out)? */
  isUnlocked(userId: number): boolean {
    if (!this.pin) return true;
    const until = this.unlockedUntil.get(userId);
    if (!until) return false;
    if (Date.now() > until) {
      this.unlockedUntil.delete(userId);
      return false;
    }
    return true;
  }

  /** Is this user locked out due to too many failed attempts? */
  isLockedOut(userId: number): boolean {
    const until = this.lockedOutUntil.get(userId);
    if (!until) return false;
    if (Date.now() > until) {
      this.lockedOutUntil.delete(userId);
      this.failedAttempts.delete(userId);
      return false;
    }
    return true;
  }

  /** Try to unlock for this user using the provided candidate PIN. */
  tryUnlock(userId: number, candidate: string): boolean {
    if (!this.pin) return true;
    if (this.isLockedOut(userId)) return false;
    if (candidate.trim() !== this.pin) {
      const fails = (this.failedAttempts.get(userId) ?? 0) + 1;
      this.failedAttempts.set(userId, fails);
      if (fails >= PinGate.MAX_ATTEMPTS) {
        this.lockedOutUntil.set(userId, Date.now() + PinGate.LOCKOUT_MS);
      }
      return false;
    }
    this.failedAttempts.delete(userId);
    this.touch(userId);
    return true;
  }

  /** Extend the unlock window after a successful interaction. */
  touch(userId: number): void {
    if (!this.pin) return;
    const minutes = this.idleTimeoutMinutes > 0 ? this.idleTimeoutMinutes : 60;
    this.unlockedUntil.set(userId, Date.now() + minutes * 60_000);
  }

  lock(userId: number): void {
    this.unlockedUntil.delete(userId);
  }
}

/**
 * Minimal append-only audit log (JSON lines) of who said what when.
 */
export class AuditLog {
  constructor(private readonly filePath: string) {
    if (filePath) fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  record(event: {
    userId: number | undefined;
    kind: "message" | "command" | "denied" | "unlock" | "locked_out";
    detail?: string;
  }): void {
    if (!this.filePath) return;
    const line = JSON.stringify({ at: Date.now(), ...event }) + "\n";
    try {
      fs.appendFileSync(this.filePath, line);
    } catch (err) {
      console.log(JSON.stringify({ level: "warn", msg: "audit write failed", err: String(err) }));
    }
  }
}

/**
 * Warn if `.env` is world-readable/writable. Best-effort only.
 */
export function checkEnvPermissions(envPath: string): void {
  try {
    const stat = fs.statSync(envPath);
    const mode = stat.mode & 0o777;
    // Anything group/world readable or writable is a warning.
    if (mode & 0o077) {
      console.log(JSON.stringify({
        level: "warn",
        msg: ".env has overly permissive permissions",
        path: envPath,
        mode: mode.toString(8),
        hint: "run: chmod 600 .env",
      }));
    }
  } catch {
    // ignore - .env may not exist in all deployments
  }
}
