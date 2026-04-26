# KiroLink — Project Status

**Last updated:** 2026-04-20

## What is KiroLink?

A lightweight bridge that connects a Telegram bot to Kiro CLI. Chat with your Kiro agent from your phone, anywhere. Full spec in `SPEC.md`.

**Naming note**: Originally called "Greenline" during development (M1–M5). Renamed to **KiroLink** at v0.4.0 and flattened out of a `greenline/` subdirectory into the repo root.

## Current State: Feature-complete (M1–M5)

### Files

```
KiroLink/
├── src/
│   ├── index.ts          # Bot, middleware chain, commands
│   ├── kiro-headless.ts  # Spawns `kiro-cli chat --no-interactive`, cancellable
│   ├── conversation.ts   # File-backed conversation log with pruning
│   ├── system-context.ts # Runtime-derived system prompt (trust, cwd, constraints)
│   └── security.ts       # RateLimiter, PinGate, AuditLog, env perm check
├── install.sh            # systemd installer (creates kirolink user, /opt/kirolink, service)
├── kirolink.service      # hardened systemd unit
├── README.md             # full setup guide (BotFather, Kiro login, install, troubleshooting)
├── SPEC.md
├── package.json
├── tsconfig.json
├── .env.example
└── .gitignore
```

### Commands

- `/help` — list available commands
- `/new` — reset conversation
- `/status` — show config, Kiro version, selected model, idle time, running state, security status. Conversation context is kept across idle periods; reset explicitly with `/new`.
- `/history` — last ~10 turns preview
- `/cancel` — SIGTERM the current Kiro invocation
- `/cd [path]` — show or change Kiro's working dir (whitelist via `KIROLINK_ALLOWED_CWDS`)
- `/model [name|auto]` — show supported models, or set which one Kiro uses (persisted via `kiro-cli settings chat.defaultModel`)
- `/unlock <PIN>` — authenticate when `KIROLINK_BOT_PIN` is set
- `/lock` — lock the session (require /unlock again)

### Security behavior

- **Allowlist** — unauthorized Telegram users dropped silently
- **PIN gate** — optional `KIROLINK_BOT_PIN`; when set, each user must `/unlock <PIN>` before messages flow. Brute-force lockout after 5 failed attempts (15-minute cooldown). Clear user feedback for locked/locked-out states.
- **Rate limiting** — sliding 60s window, default 10 msg/min per user
- **Audit log** — JSON-lines at `$HOME/.local/share/kirolink/audit.log`
- **`.env` permission check** — warns on startup if `.env` is group/world readable/writable
- **`/cd` whitelist** — `KIROLINK_ALLOWED_CWDS` restricts directories the bot can point Kiro at; symlinks resolved via `realpathSync` to prevent escapes
- **Child env sanitization** — only `PATH`, `HOME`, `NODE_ENV`, `LANG` (+ optional `KIRO_API_KEY`) passed to kiro-cli; bot token never leaked to child
- **Stderr sanitization** — secret-like patterns stripped from error output before forwarding to user
- **Output buffer cap** — stdout/stderr capped at 50 MB; child killed on overflow

### Packaging

- **No Docker**: containerizing would require mounting Kiro CLI's login state (or an API key) and either bundling or mounting `kiro-cli` itself. systemd is simpler for a single-process daemon.
- **install.sh is re-runnable**: checks Node ≥20 (auto-installs via NodeSource on apt/dnf only if missing), warns without installing if `kiro-cli` is missing, uses `tar` over a pipe for code sync (no `rsync` dependency), preserves `.env` and `node_modules` across reruns, stops + restarts the service on upgrade, only reloads systemd when the unit actually changed. EXIT trap restores `.env` if the script fails mid-upgrade.
- **Hardened `kirolink.service`**: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp`, `ReadWritePaths=/var/lib/kirolink` (extend as needed), `CapabilityBoundingSet=`, `RestrictAddressFamilies`, `RestrictNamespaces`, `MemoryMax=512M`, `TasksMax=512`, restart loop protection (`StartLimitBurst=5`). `SystemCallFilter` was removed after it caused SIGSYS crashes on some kernel/Node combos.
- **Three-tier tool trust**: default is `--trust-tools=read,grep,glob,code` (read-only file exploration, no shell, no writes); opt-in `--trust-tools=read,grep,glob,code,shell` for troubleshooting, add `write` for edits, or `--trust-all-tools` for everything; or custom kiro-cli agent for tailored, per-command access.

## Milestones

| Milestone | Status | Summary |
|-----------|--------|---------|
| M1: Echo Bot | ✅ Done | grammy bot, allowlist, systemd |
| M2: Kiro Integration | ✅ Done | Headless mode, conversation log |
| M3: Session Polish | ✅ Done | /cancel, /history, idle timeout, log pruning |
| M4: Security Hardening | ✅ Done | PIN gate, rate limit, audit log, env check |
| M5: Packaging | ✅ Done | install.sh, hardened systemd unit, README |
| M6: Photo Forwarding | ✅ Done | Telegram photos saved to disk, path included in Kiro prompt |

## Ideas (not in SPEC, not committed)

Just some directions the project could grow in — maybe they inspire a contribution.

- **Voice/audio messages** — transcribe Telegram voice notes (Whisper, AWS Transcribe, or similar) and feed the text to Kiro. Handy for dictating longer prompts on the go.
- **File/document forwarding** — send a PDF, log file, or source file as a Telegram attachment and have Kiro read it.
- **Example agent configurations** — ship a few ready-to-use kiro-cli agent configs (e.g. read-only code reviewer, infra-ops helper, journaling assistant) under an `agents/` directory so users have a starting point for `KIROLINK_KIRO_EXTRA_ARGS=--agent ...`.
- **Log rotation** for the audit log and conversation log
- **Per-user rate limits** (currently shared across the single bot instance)
- **Simple web UI** for reviewing audit/conversation logs
- **Tests** (unit + integration) — highest-value targets: PIN gate, rate limiter, allowlist, conversation log, `isCwdAllowed`
- **CI** (lint + build)
- **Conversation context summarization** — compress older turns instead of dropping them
