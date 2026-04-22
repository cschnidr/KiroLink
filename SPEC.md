# Project: KiroLink

A lightweight bridge that connects a Telegram bot to Kiro CLI on a Linux home server. Chat with your Kiro agent from your phone, anywhere.

## Messenger: Telegram

Official Bot API, no phone number needed for the bot, single BotFather command to create. Using grammy (TypeScript). E2E encryption not available for bot chats — accepted trade-off since the bot runs on your own machine.

## Architecture

```
Phone (Telegram) → Telegram API → Bridge (grammy) → spawn kiro-cli chat --no-interactive
                 ←              ←                    ← stdout
```

For each incoming Telegram message the bridge spawns a fresh `kiro-cli chat --no-interactive <prompt>` process with configurable tool trust, captures stdout, and sends it back to Telegram. Kiro CLI's headless mode is designed for one-shot invocations and produces clean, streamable output.

Kiro CLI tool-trust presets are supported via `KIROLINK_KIRO_EXTRA_ARGS`. Built-in tools: `read`, `grep`, `glob`, `code`, `write`, `shell`, `aws`, `report`.
- **Safe (default):** `--trust-tools=read,grep,glob,code` — read-only file exploration, no shell, no writes.
- **Read + shell:** `--trust-tools=read,grep,glob,code,shell` — adds shell for troubleshooting. No writes.
- **Read + write + shell:** `--trust-tools=read,grep,glob,code,shell,write` — full non-AWS access.
- **Trust all:** `--trust-all-tools` — every tool auto-approved. Opt-in only.
- **Custom agent:** `--agent ~/.kiro/agents/<name>` — the only way to get per-command trust in headless mode (via `allowedCommands` regex).

### Why not PTY / interactive mode?

The original design kept one long-lived `kiro-cli chat` process attached to a PTY. This turned out to be infeasible against the current Kiro CLI because its interactive UX is a full TUI — ASCII art, cursor moves, carriage-return redraws, color sequences, spinners, tool-call panels — with no stable text-based prompt to detect. Fighting the TUI through a PTY proxy was brittle against every Kiro release and resulted in significant parsing/filtering code.

Headless mode sidesteps all of it at the cost of per-call session state.

### Session continuity

Because `--no-interactive` starts fresh on every invocation, the bridge keeps a local **conversation log** (JSON-lines file) of recent user and assistant turns. Each new invocation prepends the last N turns as context in the prompt. This preserves "remember what we just talked about" behavior for typical chat interactions. It's not a perfect substitute for in-process session state (agent caches, tool-call history, etc.), but it's good enough for mobile chat use cases.

To keep context efficient:
- **Assistant turn cap:** Responses longer than 2000 chars are truncated before storage, preventing a single verbose reply from consuming the context window.
- **File reference carry-forward:** Absolute file paths mentioned in assistant responses are extracted and prepended as a "Files previously examined" section, so Kiro remembers which files were discussed without the user repeating them.
- **Disk-full resilience:** Log writes are wrapped in try/catch; compaction uses atomic write-to-temp + rename to prevent corruption.

## Kiro CLI Behavior (confirmed)

- `kiro-cli chat --no-interactive "<prompt>"` runs one-shot, prints answer to stdout, exits.
- `--trust-all-tools` auto-approves tool calls (required in headless mode since there's no user to prompt).
- `--trust-tools=read,grep,...` can restrict to specific tool categories.
- Output still includes ANSI color codes and a `> ` reply marker; the bridge strips these.
- A "▸ Credits: X • Time: Ys" footer may appear at the end; the bridge strips it.
- Authentication uses the inherited `kiro-cli` login, or `KIRO_API_KEY` if set.

## Requirements

### Functional

1. Receive Telegram messages, invoke Kiro headless, send cleaned stdout back.
2. Multi-turn conversations via file-backed conversation log (last N turns as context).
3. Long responses: chunk at 4096 chars (Telegram limit). If >10k chars, upload as `.txt` file.
4. Strip ANSI escape codes and Kiro reply markers (`> ` prefix, `▸ Credits:` footer) before sending.
5. Commands:
   - `/help` — list available commands
   - `/new` — reset conversation log (start a fresh context)
   - `/status` — show config, Kiro version, current model, idle time, whether a Kiro invocation is currently running
   - `/history` — preview of recent turns
   - `/cancel` — SIGTERM the in-flight Kiro process
   - `/cd [path]` — show or change Kiro's working dir (resets conversation); may be restricted via `KIROLINK_ALLOWED_CWDS`
   - `/model [name|auto]` — show supported models, or set which one Kiro should use. Stored as a `kiro-cli settings chat.defaultModel` under the service user.
6. Typing indicator (refreshed every 4s) while Kiro is running.
7. Idle timeout: when a PIN gate is configured, an `/unlock` stays valid for N min before re-locking (default 30, configurable). Conversation context is kept across idle periods and only reset by `/new`, `/cd`, or restart.
8. Serialize Kiro invocations — one at a time per bot instance.

### Security

1. **Allowlist:** Only configured Telegram user ID(s) can interact. All other messages silently dropped.
2. **No secrets in code:** Bot token, user IDs, API key via `.env` file (chmod 600).
3. **Rate limiting:** Sliding 60s window, default 10 msg/min per user.
4. **Optional session PIN:** First message after boot or idle timeout requires `/unlock <PIN>`. Brute-force lockout after 5 failed attempts (15-minute cooldown).
5. **Audit log:** JSON-lines file of every allow/deny/command/message event.
6. **`.env` permission check:** Warn on startup if `.env` is group/world readable/writable.
7. **`/cd` whitelist:** Optional `KIROLINK_ALLOWED_CWDS` restricts which directories the bot can switch Kiro into. Symlinks are resolved (`realpathSync`) before validation to prevent escapes.
8. **No cloud relay:** Telegram API is the only external dependency. Bridge ↔ Kiro CLI is local.
9. **Child process env sanitization:** Only `PATH`, `HOME`, `NODE_ENV`, `LANG` (and optionally `KIRO_API_KEY`) are passed to kiro-cli. Bot token and other secrets are not leaked to the child.
10. **Stderr sanitization:** Error output from kiro-cli is filtered for secret-like patterns (`TOKEN=`, `API_KEY=`, etc.) before forwarding to the user.
11. **Output buffer cap:** stdout/stderr from kiro-cli is capped at 50 MB; child is killed if exceeded (prevents OOM).

### Non-Functional

1. Language: TypeScript (Node.js ≥20).
2. Dependencies: `grammy`, `dotenv`, `strip-ansi`.
3. Runs as systemd service.
4. Config: env vars via `.env`.
5. Logs: structured JSON to stdout (journald captures it).
6. Error handling: Kiro CLI non-zero exits, timeouts, and cancellations surfaced to the user.

## Config (env vars)

| Variable | Default | Purpose |
|----------|---------|---------|
| `KIROLINK_BOT_TOKEN` | (required) | Telegram bot token from BotFather |
| `KIROLINK_ALLOWED_USERS` | (required) | Comma-separated Telegram user IDs |
| `KIROLINK_KIRO_COMMAND` | `kiro-cli` | Kiro CLI binary |
| `KIROLINK_KIRO_EXTRA_ARGS` | `--trust-tools=read,grep,glob,code` | Extra args passed to `kiro-cli chat --no-interactive` |
| `KIROLINK_KIRO_CWD` | `$HOME` | Default working directory for Kiro invocations |
| `KIROLINK_ALLOWED_CWDS` | (unset = any) | Comma-separated roots the `/cd` command may switch into |
| `KIROLINK_KIRO_TIMEOUT_MS` | `300000` | Per-invocation timeout |
| `KIRO_API_KEY` | (optional) | API-key auth for Kiro; otherwise inherited login is used |
| `KIROLINK_CONVERSATION_PATH` | `~/.local/share/kirolink/conversation.log` | Path to the conversation log |
| `KIROLINK_CONVERSATION_MAX_TURNS` | `10` | Turns prepended as context in each prompt |
| `KIROLINK_IDLE_TIMEOUT_MINUTES` | `30` | PIN unlock window in minutes (0 = never re-lock). Only relevant when `KIROLINK_BOT_PIN` is set. |
| `KIROLINK_FILE_UPLOAD_THRESHOLD` | `10000` | Reply length (chars) above which we upload as `.txt` |
| `KIROLINK_BOT_PIN` | (optional) | PIN required on first message after idle/boot |
| `KIROLINK_RATE_LIMIT_PER_MIN` | `10` | Max messages per minute per allowed user |
| `KIROLINK_AUDIT_LOG_PATH` | `~/.local/share/kirolink/audit.log` | Append-only JSON-lines audit log |

## Module layout

```
kirolink/
├── src/
│   ├── index.ts          # Bot, middleware chain, commands, reply routing
│   ├── kiro-headless.ts  # Spawns `kiro-cli chat --no-interactive`, cancellable
│   ├── conversation.ts   # File-backed conversation log for context
│   ├── system-context.ts # Runtime-derived system prompt (trust, cwd, constraints)
│   └── security.ts       # RateLimiter, PinGate, AuditLog, env perm check
├── package.json
├── tsconfig.json
├── .env.example
├── install.sh            # re-runnable installer
└── kirolink.service      # hardened systemd unit
```

## Milestones (all complete)

### M1: Echo Bot ✅
- grammy bot + BotFather
- Allowlist enforcement
- systemd unit
- **Done when:** send message from phone, get echo back

### M2: Kiro Integration ✅
- Headless spawn per message (`kiro-cli chat --no-interactive`)
- Conversation log with recent-turns context
- ANSI + reply-marker stripping
- **Done when:** send question from phone, get Kiro answer back

### M3: Session Polish ✅
- `/new`, `/status`, `/history`, `/cancel` commands
- Typing indicator during invocation
- Idle timeout auto-reset
- Long-response chunking + `.txt` file upload fallback
- Conversation log pruned in place when it grows too large
- **Done when:** robust multi-turn chat from phone with cancel/reset controls

### M4: Security Hardening ✅
- Optional PIN on session start / after idle (`/unlock`, `/lock`)
- Rate limiting per authorized user
- Audit log (who said what, when)
- `.env` permission check on startup
- **Done when:** security checklist passes

### M5: Packaging ✅
- `install.sh` (re-runnable): checks Node ≥20, auto-installs via NodeSource if missing on apt/dnf; warns (without installing) if `kiro-cli` is missing; creates `kirolink` service user + `/var/lib/kirolink` data dir; installs code to `/opt/kirolink` using `tar` over a pipe (no `rsync` dependency), preserving `.env` and `node_modules` across re-runs; runs `npm install --omit=dev` + `tsc` as the service user; installs systemd unit only if changed; stops + restarts the service when upgrading a running install. EXIT trap restores `.env` if the script fails mid-upgrade.
- Hardened `kirolink.service` (`ProtectSystem=strict`, `NoNewPrivileges`, `ProtectHome=read-only`, `PrivateTmp`, `ReadWritePaths=/var/lib/kirolink`, `CapabilityBoundingSet=`, `RestrictAddressFamilies`, `RestrictNamespaces`, `MemoryMax=512M`, `TasksMax=512`, restart loop protection). `SystemCallFilter` removed after SIGSYS crashes on some kernel/Node combos.
- `README.md` with full setup guide (BotFather, Kiro login, install, troubleshooting).
- Docker explicitly dropped: containerizing would require mounting Kiro CLI's login state (or an API key) and either bundling or mounting `kiro-cli` itself. systemd on a home server is simpler for a single-process daemon that shells out to a locally-installed CLI.
- **Done when:** fresh Ubuntu/Debian box → working bot in <5 min

### Additional commands (added after initial SPEC)

Originally M3 only specified `/new`, `/status`, `/history`, `/cancel`. These were added later and are fully documented in README.md:

- `/help` — command discovery
- `/cd [path]` — change Kiro's working dir at runtime (with optional `KIROLINK_ALLOWED_CWDS` whitelist)
- `/model [name|auto]` — list and select the underlying Kiro model
- Kiro version + selected model in `/status` output

## Risks

1. **Headless mode session boundaries.** Every Kiro invocation is independent; tool-call state and agent caches don't persist. We mitigate with the conversation log, but complex multi-step agent workflows (e.g. "now continue the refactor from earlier") may need explicit context the user wouldn't normally type.
2. **Kiro CLI output format drift.** Even headless output contains ANSI + reply markers that could change. Mitigate with defensive parsing (`strip-ansi`, footer/marker regex) and integration-test on each Kiro version bump.
3. **Prompt injection via Telegram.** Since every message is passed as a prompt, a malicious authorized user (or compromised Telegram account) could ask Kiro to do dangerous things. Mitigated by: running the bot as a low-privilege user, defaulting to read-only tools (`--trust-tools=read,grep,glob,code`), sanitizing the child process environment (bot token not leaked), and offering custom agents with per-command `allowedCommands` regex for fine-grained access control.
4. **Long-running Kiro invocations.** Complex requests can take >30s. We use a typing indicator and a configurable timeout; `/cancel` aborts in flight.

## Historical naming

This project was originally called **Greenline** during development. It was renamed to **KiroLink** before v0.4.0. If you encounter lingering `greenline` references in git history or backups, it's the same project.

## Test Plan

- **Unit:** allowlist logic, config parsing, ANSI stripping, conversation-log persistence + pruning, prompt building, PIN gate, rate limiter
- **Integration:** mock Telegram update → bridge → mock `kiro-cli` child → verify cleaned response sent back; cancellation path
- **E2E:** real Telegram bot + real Kiro CLI on test machine
