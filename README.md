<p align="center">
  <img src="docs/kirolink-logo.png" alt="KiroLink logo" width="240" />
</p>

# KiroLink

**Chat with your local Kiro CLI agent from your phone, via Telegram.**

<p align="center">
  <img src="docs/KiroLink-Demo.gif" alt="KiroLink demo — chatting with Kiro via Telegram" width="320" />
</p>

KiroLink is a small Node.js daemon that turns a Telegram bot into a frontend for `kiro-cli` running on your Linux home server. You message the bot, your server runs Kiro, the answer comes back as a Telegram message — no cloud relay, no phone number for the bot.

```
📱 Telegram → 🌍 Telegram API → 🖥️ KiroLink → kiro-cli chat --no-interactive
       ↑                                              │
       └──────────── response ────────────────────────┘
```

### Quick start (if you know what you're doing)

```bash
# 1. Create a bot via @BotFather, get your user ID via @userinfobot
# 2. On your server:
git clone https://github.com/schnidrc/KiroLink ~/git/KiroLink
cd ~/git/KiroLink && sudo bash install.sh
# 3. Switch to the service user, install + log in Kiro CLI:
sudo -su kirolink
curl -fsSL https://cli.kiro.dev/install | bash
export PATH="$HOME/.local/bin:$PATH"
kiro-cli login
exit
# 4. Edit /opt/kirolink/.env — set BOT_TOKEN, ALLOWED_USERS, KIRO_COMMAND
sudo systemctl enable --now kirolink
```

Detailed walkthrough below.

> **⚠️ Understand the trust model.** KiroLink forwards your Telegram messages as prompts to an AI agent running on your server. By default, the agent can only *read* files — but you can grant it write access or full tool use. This means a compromised Telegram account could instruct the agent to act on your behalf. KiroLink mitigates this with an allowlist, optional PIN, rate limiting, brute-force lockout, systemd sandboxing, and secret isolation — but you should understand these controls before deploying. See [Security posture](#security-posture) and [Tool trust & custom agents](#tool-trust--custom-agents).

---

## What you get

- Talk to Kiro from anywhere as long as your home server is online
- Multi-turn conversations (KiroLink remembers recent context)
- Useful bot commands: `/help`, `/new`, `/status`, `/history`, `/cancel`, `/cd`, `/unlock`, `/lock`
- Allowlist so only **you** can use the bot
- Optional PIN gate and per-minute rate limiting
- Typing indicator while Kiro is thinking
- Long responses auto-chunked (>4096 chars) or uploaded as `.txt` (>10k chars)
- Structured JSON logs + append-only audit log
- Systemd service with sensible hardening

---

## Prerequisites

Before you start:

1. **A Linux home server** (tested on Ubuntu 22.04 and Debian 12)
2. **Node.js ≥ 20** — KiroLink's installer will install this for you on apt/dnf systems if it's missing
3. **[Kiro CLI](https://kiro.dev/cli/)** — you'll install this during setup. Kiro gives you limited but free credits on signup.
4. **A Telegram account** — regular user account, nothing special

---

## 1. Create your Telegram bot

[BotFather](https://core.telegram.org/bots/features#botfather) is the official Telegram bot that creates and manages other bots. To make yours:

1. Open Telegram, search for `@BotFather`, and start a chat
2. Send `/newbot`
3. Pick a display name (e.g. "My Kiro")
4. Pick a username ending in `bot` (e.g. `my_kiro_bot`)
5. BotFather replies with a **bot token** like `123456:ABC-DEF...` — save it

Also get your own Telegram user ID:

1. Search for `@userinfobot`, send any message
2. It replies with your numeric ID — save that too

---

## 2. Install KiroLink on your server

Clone the repo (to a durable location — **not** `/tmp`, which gets wiped on reboot) and run the installer as root:

```bash
git clone https://github.com/schnidrc/KiroLink ~/git/KiroLink
cd ~/git/KiroLink
sudo bash install.sh
```

> Keep this checkout around — future upgrades are just `git pull && sudo bash install.sh` from the same directory.

What the installer does:

- Checks Node.js ≥ 20 (auto-installs via NodeSource on apt/dnf if missing)
- Warns if `kiro-cli` isn't yet installed (expected — next step)
- Creates a `kirolink` system user with its home at `/var/lib/kirolink`
- Copies the project to `/opt/kirolink`
- Runs `npm install` + builds the TypeScript
- Installs the systemd unit at `/etc/systemd/system/kirolink.service`
- Seeds `/opt/kirolink/.env` from the template with `chmod 600`

---

## 3. Install Kiro CLI as the service user

The `kirolink` user has a real shell (`/bin/bash`), so you can switch into it for any admin work:

```bash
sudo -su kirolink
```

From there, install Kiro CLI and log in:

```bash
curl -fsSL https://cli.kiro.dev/install | bash
export PATH="$HOME/.local/bin:$PATH"
kiro-cli login
```

If you use SSO / AWS IAM Identity Center (e.g. a Pro subscription under a corporate account), you'll need extra flags. Example using device flow:

```bash
kiro-cli login \
  --license pro \
  --identity-provider <your-sso-start-url> \
  --region <your-aws-region> \
  --use-device-flow
```

Replace:
- `<your-sso-start-url>` — your Identity Center start URL (e.g. `https://example.awsapps.com/start`)
- `<your-aws-region>` — the region your Identity Center instance lives in

Type `exit` when done to return to your own user.

> **Tip:** any time you need to run something as the `kirolink` user (create an agent, check kiro-cli version, etc.), just `sudo -su kirolink` first. No more `sudo -u kirolink -H` prefix on every command.

**Alternative: API key.** If your Kiro subscription supports it, you can skip `kiro-cli login` entirely by setting `KIRO_API_KEY` in `/opt/kirolink/.env` (see [Authentication](https://kiro.dev/docs/cli/authentication)).

---

## 4. Configure KiroLink

Edit the env file:

```bash
sudo -e /opt/kirolink/.env
```

Minimum required settings:

```env
KIROLINK_BOT_TOKEN=123456:your-bot-token-from-botfather
KIROLINK_ALLOWED_USERS=987654321
KIROLINK_KIRO_COMMAND=/var/lib/kirolink/.local/bin/kiro-cli
```

- `KIROLINK_BOT_TOKEN` — the token BotFather gave you
- `KIROLINK_ALLOWED_USERS` — your numeric Telegram ID (comma-separated if you want multiple users)
- `KIROLINK_KIRO_COMMAND` — full path to the `kiro-cli` binary

---

## 5. Start the service

```bash
sudo systemctl enable --now kirolink
sudo journalctl -u kirolink -f
```

You should see a `"bot started"` log line. Now open your bot in Telegram and say "hi" — Kiro will reply within a few seconds.

---

## Using the bot

Just chat with it. Kiro sees each message as a prompt and replies.

### Commands

| Command | What it does |
|---------|--------------|
| `/help` | List commands |
| `/new` | Reset the conversation context |
| `/status` | Show config, Kiro version, idle time, whether a request is in flight |
| `/history` | Preview recent turns |
| `/cancel` | Abort the currently running Kiro invocation |
| `/cd [path]` | Show or change Kiro's working directory |
| `/model [name\|auto]` | Show, list, or set which Kiro model to use (`auto` reverts to default) |
| `/unlock <PIN>` | Enter the PIN (when `KIROLINK_BOT_PIN` is set) |
| `/lock` | Lock the session manually |

> **💡 Credit tip:** Kiro gives you limited but free credits. Open-weight models (like `deepseek-3.2` or `minimax-m2.1`) use significantly fewer credits per message than Claude models. Use `/model` in KiroLink or `kiro-cli chat --list-models` to see the credit multiplier for each model and switch to a cheaper one for routine tasks.

### Changing working directory

By default Kiro runs with `cwd` set to the `kirolink` user's home (`/var/lib/kirolink`). To have Kiro work on a specific project:

```
/cd /path/to/my/project
```

This auto-resets the conversation (different project = different context).

**Restrict which directories the bot may switch to** by setting `KIROLINK_ALLOWED_CWDS` (comma-separated roots). If unset, any directory is allowed.

### PIN gate

If `KIROLINK_BOT_PIN` is set, the bot will reply with "🔒 Session locked. Send `/unlock <PIN>` to start." until you authenticate. After 5 wrong attempts, you're locked out for 15 minutes. The unlock stays valid for `KIROLINK_IDLE_TIMEOUT_MINUTES` (default 30).

---

## Configuration reference

All config via env vars in `/opt/kirolink/.env`. Full defaults in [`.env.example`](./.env.example).

### Required

| Variable | Purpose |
|----------|---------|
| `KIROLINK_BOT_TOKEN` | Telegram bot token from BotFather |
| `KIROLINK_ALLOWED_USERS` | Comma-separated Telegram user IDs |

### Kiro invocation

| Variable | Default | Purpose |
|----------|---------|---------|
| `KIROLINK_KIRO_COMMAND` | `kiro-cli` | Path or name of the Kiro CLI binary |
| `KIROLINK_KIRO_EXTRA_ARGS` | `--trust-tools=read,grep,glob,code` | Args passed to each `kiro-cli chat --no-interactive` call |
| `KIROLINK_KIRO_CWD` | `$HOME` of the service user | Default working dir |
| `KIROLINK_ALLOWED_CWDS` | (unset) | Comma-separated roots `/cd` may switch into |
| `KIROLINK_KIRO_TIMEOUT_MS` | `300000` | Per-invocation timeout (5 min) |
| `KIRO_API_KEY` | (unset) | API-key auth — alternative to `kiro-cli login` |

### Behavior

| Variable | Default | Purpose |
|----------|---------|---------|
| `KIROLINK_CONVERSATION_MAX_TURNS` | `10` | Recent turns prepended as context in each call |
| `KIROLINK_IDLE_TIMEOUT_MINUTES` | `30` | How long a `/unlock` stays valid when PIN gate is enabled (0 disables re-lock) |
| `KIROLINK_FILE_UPLOAD_THRESHOLD` | `10000` | Reply length above which we upload `.txt` |
| `KIROLINK_CONVERSATION_PATH` | `~/.local/share/kirolink/conversation.log` | Where the conversation log lives |

### Security

| Variable | Default | Purpose |
|----------|---------|---------|
| `KIROLINK_BOT_PIN` | (unset) | If set, require `/unlock <PIN>` per session |
| `KIROLINK_RATE_LIMIT_PER_MIN` | `10` | Max messages per minute per user (0 disables) |
| `KIROLINK_AUDIT_LOG_PATH` | `~/.local/share/kirolink/audit.log` | Append-only JSON-lines audit log |

---

## Tool trust & custom agents

KiroLink controls what Kiro is allowed to do via `KIROLINK_KIRO_EXTRA_ARGS`. Built-in Kiro CLI tools include `read`, `grep`, `glob`, `code`, `shell`, `write`, `aws`, `report` (run `kiro-cli chat --help` on your install to confirm the exact set). Four presets are provided in `.env.example`:

### Safe (default) — read-only, no shell

```env
KIROLINK_KIRO_EXTRA_ARGS=--trust-tools=read,grep,glob,code
```

Kiro can read files, search with grep, glob for paths, and explore code. Can't run shell commands, can't write.

> ⚠️ **Practical note:** this profile is narrow. Kiro **cannot** tail logs, list directories, run `systemctl status`, or do most home-server troubleshooting — all of that needs `shell`. If you want "read-only troubleshooting" in a useful sense, use the **Read + shell** profile below.

### Read + shell (recommended for troubleshooting)

```env
KIROLINK_KIRO_EXTRA_ARGS=--trust-tools=read,grep,glob,code,shell
```

Adds `shell` so Kiro can run `tail`, `ls`, `cat`, `head`, `systemctl status`, etc. No file writes. Good for log inspection, service status, troubleshooting. The `shell` tool can still run destructive commands like `rm` — relies on the systemd sandbox (`ProtectSystem=strict`, `ReadWritePaths`, `CapabilityBoundingSet=`) to contain damage.

### Read + shell + write

```env
KIROLINK_KIRO_EXTRA_ARGS=--trust-tools=read,grep,glob,code,shell,write
```

Full non-AWS access. Kiro can read, write, and run commands. Lets Kiro actually fix problems (edit config files, restart services). Pair with careful `ReadWritePaths` in the systemd unit to scope damage.

### Trust all

```env
KIROLINK_KIRO_EXTRA_ARGS=--trust-all-tools
```

All tools auto-approved, including `aws` and `report`. Most convenient, most risk. **Any message you send is a prompt, and Kiro will execute whatever it interprets.**

### Custom agent

```env
KIROLINK_KIRO_EXTRA_ARGS=--agent ~/.kiro/agents/my-homelab-agent
```

By default KiroLink uses plain `kiro-cli` with no agent — Kiro has no domain knowledge about your setup. For specific use cases (home automation, dev server, monitoring), a custom agent gives Kiro a system prompt with context about your environment and fine-grained tool trust.

**Example: openHAB home automation agent**

```bash
# Switch to the service user
sudo -su kirolink

# Create the agent
kiro-cli agent create openhab
```

Then edit `~/.kiro/agents/openhab/agent.md`:

```markdown
# openHAB Assistant

You are a home automation assistant managing an openHAB 4.x instance.

## Environment
- openHAB config: /etc/openhab/
- openHAB logs: /var/log/openhab/
- Rules: /etc/openhab/rules/
- Items: /etc/openhab/items/
- Things: /etc/openhab/things/

## Guidelines
- When asked about device states, read the relevant items files.
- For troubleshooting, check /var/log/openhab/openhab.log and events.log.
- When editing rules, always back up the original file first.
- Keep answers concise — replies go to a Telegram chat.
```

Wire it into `.env` and restart:

```env
KIROLINK_KIRO_EXTRA_ARGS=--agent ~/.kiro/agents/openhab
```

```bash
exit  # back to your own user
sudo systemctl restart kirolink
```

The agent's system prompt is prepended to every Kiro invocation, so Kiro always knows where your configs and logs live without you repeating it. Tool trust is still controlled by the agent's configuration — see [Kiro's agent docs](https://kiro.dev/docs/cli/agents/) for the full spec.

See [Kiro's headless docs](https://kiro.dev/docs/cli/headless/) for more on headless-mode permissions.

---

## Giving Kiro write access to specific paths

By default the service is sandboxed — `ProtectSystem=strict` + `ProtectHome=read-only` mean Kiro can read almost anything but can only **write** to `/var/lib/kirolink`. If you want Kiro to edit files elsewhere (say, project repos, config dirs, etc.), three things need to line up:

1. **Tool trust** — the default `--trust-tools=read,grep,glob,code` is read-only file exploration (no shell, no writes). To let Kiro run shell commands add `shell`; to let it edit files add `write`; or switch to `--trust-all-tools` / a custom agent.
2. **Systemd sandbox** — edit `/etc/systemd/system/kirolink.service` and add the path to `ReadWritePaths`. If the path is under `/home`, also change `ProtectHome=read-only` to `ProtectHome=false` (or keep `read-only` and add the specific home path to `ReadWritePaths`). Then `sudo systemctl daemon-reload && sudo systemctl restart kirolink`.
3. **OS permissions** — the `kirolink` user must have real filesystem write permission. Either `chown -R kirolink:kirolink <path>`, add kirolink to an existing group (`sudo usermod -aG <group> kirolink`), or use ACLs (`sudo setfacl -R -m u:kirolink:rwX <path>`).

All three gates must open for Kiro to actually write. If a write fails, check them in order: tool trust first (Kiro will say it's not allowed), then OS permissions (Kiro sees EACCES), then the sandbox (Kiro sees EROFS).

A GitOps-style workflow often sidesteps all of this: clone your config repo into the kirolink user's data dir, let Kiro edit files there, push, and have a CI/deploy pipeline apply the changes to production. That keeps the service user's filesystem surface tiny.

---

## Logs & files

| Path | What's there |
|------|--------------|
| `journalctl -u kirolink` | Runtime logs (JSON, one event per line) |
| `/var/lib/kirolink/.local/share/kirolink/audit.log` | Every allow/deny/command/message |
| `/var/lib/kirolink/.local/share/kirolink/conversation.log` | Current conversation history |
| `/opt/kirolink/.env` | Config (chmod 600) |

---

## Upgrading

### KiroLink itself

Keep your clone in a durable location — e.g. `~/git/KiroLink` — then `git pull` and re-run the installer:

```bash
cd ~/git/KiroLink
git pull
sudo bash install.sh
```

`install.sh` is idempotent: it stops the service, re-deploys the code to `/opt/kirolink`, preserves your existing `.env` and `node_modules`, rebuilds, and restarts the service. It also only reloads systemd if the unit file actually changed.

### Kiro CLI

```bash
sudo -su kirolink
curl -fsSL https://cli.kiro.dev/install | bash
exit
sudo systemctl restart kirolink
```

---

## Uninstalling

To completely remove KiroLink from your server:

```bash
# Stop and remove the service
sudo systemctl disable --now kirolink
sudo rm /etc/systemd/system/kirolink.service
sudo systemctl daemon-reload

# Remove the install directory and service user data
sudo rm -rf /opt/kirolink
sudo rm -rf /var/lib/kirolink

# Remove the service user
sudo userdel kirolink
```

Your source checkout (e.g. `~/git/KiroLink`) is not touched — delete it manually if you no longer need it.

---

## Troubleshooting

### Bot doesn't respond at all

- Check your numeric Telegram ID is actually in `KIROLINK_ALLOWED_USERS`
- Tail the logs: `sudo journalctl -u kirolink -n 50`
- Confirm the service is running: `sudo systemctl status kirolink`

### Every reply is "(empty response)" or mentions login

- The `kirolink` user isn't logged into Kiro. Run `sudo -su kirolink` then `kiro-cli login`.
- Or set `KIRO_API_KEY` in `/opt/kirolink/.env` and `sudo systemctl restart kirolink`.

### Error: `spawn kiro-cli EACCES`

The service can't find or execute Kiro CLI. Make sure:
- You installed Kiro as the `kirolink` user (step 3): `sudo -su kirolink` then `kiro-cli --version`
- `KIROLINK_KIRO_COMMAND=/var/lib/kirolink/.local/bin/kiro-cli` is set in `.env`

### Startup warning: `.env has overly permissive permissions`

```bash
sudo chmod 600 /opt/kirolink/.env
```

### Testing without systemd

```bash
cd /opt/kirolink
sudo -u kirolink -H npm run dev
```

Ctrl-C stops it.

---

## Security posture

- **Telegram is the only external dependency.** Everything else is local to your server.
- **Only allowlisted user IDs** can interact. Everyone else is silently dropped.
- **`.env` is chmod 600** (readable only by the service user).
- **Child process isolation**: only `PATH`, `HOME`, `NODE_ENV`, `LANG` are passed to kiro-cli — bot token and other secrets never leak to the child.
- **Systemd hardening**: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp`, `CapabilityBoundingSet=`, `RestrictAddressFamilies`, `RestrictNamespaces`, `MemoryMax=512M`, `TasksMax=512`, restart loop protection.
- **Audit log** records every event with timestamp + user ID.
- **Optional PIN gate** adds a second factor per session, with brute-force lockout after 5 failed attempts.
- **Rate limiting** caps per-user message rate.
- **Output buffer cap** (50 MB) prevents memory exhaustion from runaway Kiro output.
- **Stderr sanitization** strips secret-like patterns before forwarding errors to the user.

⚠️ **Prompt injection risk**: if you enable `--trust-all-tools`, any message is a prompt and Kiro will execute whatever it interprets. A compromised Telegram account or a careless message could cause real damage. The default (`--trust-tools=read,grep,glob,code`) keeps shell and writes off. For tailored access including per-command trust, use a custom agent (see [Tool trust & custom agents](#tool-trust--custom-agents)).

---

## Development

Running locally (not as a service):

```bash
git clone <this-repo> kirolink
cd kirolink
npm install
cp .env.example .env
# fill in token + user id, and KIROLINK_KIRO_COMMAND pointing at your local kiro-cli
npm run dev
```

Project layout:

```
kirolink/
├── src/
│   ├── index.ts          # Bot, middleware, commands, reply routing
│   ├── kiro-headless.ts  # Spawns `kiro-cli chat --no-interactive`
│   ├── conversation.ts   # File-backed conversation log
│   ├── system-context.ts # Runtime-derived system prompt (trust, cwd, etc.)
│   └── security.ts       # Allowlist helpers, rate limiter, PIN gate, audit log
├── kirolink.service      # Hardened systemd unit
├── install.sh            # Idempotent installer
├── package.json
├── tsconfig.json
└── .env.example
```

See [`SPEC.md`](./SPEC.md) for the full design and [`STATUS.md`](./STATUS.md) for milestone history.

---

## Inspiration

This project was inspired by [OpenClaw](https://github.com/openclaw/openclaw) — when Kiro CLI shipped headless mode, I wanted to talk to it from my phone. KiroLink is the result.

---

## Disclaimer

This is a personal project by [schnidrc](https://github.com/schnidrc). It is not affiliated with, endorsed by, or related to my employer (Amazon Web Services) in any way.

## License

[MIT](./LICENSE) — use it freely, no warranty.
