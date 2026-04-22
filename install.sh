#!/usr/bin/env bash
#
# KiroLink installer
#
# Installs kirolink as a systemd service running as the `kirolink` user,
# from the current repo checkout. Re-runnable (upgrades an existing install).
#
# Usage (as root):
#   sudo bash install.sh
#
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo bash install.sh" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/kirolink"
STAGING_DIR="${INSTALL_DIR}.new"
ROLLBACK_DIR="${INSTALL_DIR}.old"
DATA_DIR="/var/lib/kirolink"
SERVICE_USER="kirolink"
SERVICE_FILE="/etc/systemd/system/kirolink.service"
MIN_NODE_MAJOR=20

# Rollback on failure: if the live dir got swapped out but we aborted,
# restore from .old; always clean up the staging dir.
cleanup() {
  local rc=$?
  if [[ ${rc} -ne 0 ]]; then
    if [[ ! -d "${INSTALL_DIR}" && -d "${ROLLBACK_DIR}" ]]; then
      mv "${ROLLBACK_DIR}" "${INSTALL_DIR}"
      echo "⚠️  Installer failed — rolled back to previous install." >&2
    elif [[ -d "${STAGING_DIR}" ]]; then
      echo "⚠️  Installer failed — live install untouched. Staging left at ${STAGING_DIR} for inspection." >&2
    fi
  fi
  rm -rf "${STAGING_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  local v
  v="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  [[ "${v}" -ge "${MIN_NODE_MAJOR}" ]]
}

install_node() {
  echo "    Node.js >= ${MIN_NODE_MAJOR} not found, installing..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | bash - >/dev/null
    apt-get install -y nodejs >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | bash - >/dev/null
    dnf install -y nodejs >/dev/null
  else
    echo "Automatic Node.js install not supported on this distro." >&2
    echo "Install Node.js >= ${MIN_NODE_MAJOR} manually, then re-run." >&2
    exit 1
  fi
}

# Detect fresh install vs upgrade early.
IS_UPGRADE=false
if [[ -f "${INSTALL_DIR}/.env" ]] && systemctl list-unit-files kirolink.service &>/dev/null; then
  IS_UPGRADE=true
fi

echo "--> Checking prerequisites"

if check_node; then
  echo "    node: $(node -v) ✓"
else
  install_node
  check_node || { echo "Node install failed" >&2; exit 1; }
  echo "    node: $(node -v) ✓ (installed)"
fi

# Check kiro-cli in system PATH and in the service user's local bin.
KIRO_CLI_PATH=""
if command -v kiro-cli >/dev/null 2>&1; then
  KIRO_CLI_PATH="$(command -v kiro-cli)"
elif [[ -x "${DATA_DIR}/.local/bin/kiro-cli" ]]; then
  KIRO_CLI_PATH="${DATA_DIR}/.local/bin/kiro-cli"
fi

if [[ -n "${KIRO_CLI_PATH}" ]]; then
  echo "    kiro-cli: ${KIRO_CLI_PATH} ✓"
else
  echo "    kiro-cli: NOT FOUND"
  echo "    Install it as the service user before starting:"
  echo "      sudo -u ${SERVICE_USER} -H bash -c 'curl -fsSL https://cli.kiro.dev/install | bash'"
  echo "    (Or set KIRO_API_KEY in ${INSTALL_DIR}/.env.)"
fi

SERVICE_WAS_ACTIVE=false
if systemctl is-active --quiet kirolink 2>/dev/null; then
  echo "--> Stopping running kirolink service for upgrade"
  systemctl stop kirolink
  SERVICE_WAS_ACTIVE=true
fi

echo "--> Creating service user '${SERVICE_USER}'"
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${DATA_DIR}" --create-home --shell /bin/bash "${SERVICE_USER}"
  echo "    created"
else
  # Ensure existing user has a usable shell (may have been /usr/sbin/nologin
  # from an older install). Allows `sudo -su kirolink` for admin tasks.
  current_shell="$(getent passwd "${SERVICE_USER}" | cut -d: -f7)"
  if [[ "${current_shell}" == */nologin ]]; then
    chsh -s /bin/bash "${SERVICE_USER}"
    echo "    already exists (shell upgraded to /bin/bash)"
  else
    echo "    already exists"
  fi
fi
mkdir -p "${DATA_DIR}"
chown "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}"

echo "--> Staging new code to ${STAGING_DIR}"
rm -rf "${STAGING_DIR}"
mkdir -p "${STAGING_DIR}"

# Use tar over a pipe: works with just POSIX tools, no extra deps.
# Use pipefail so a failed tar-cf doesn't get masked by tar-xf succeeding.
set -o pipefail
tar -C "${REPO_DIR}" \
  --exclude=node_modules --exclude=dist --exclude=.env --exclude=.git --exclude=.sisyphus \
  -cf - . | tar -C "${STAGING_DIR}" -xf -

# Verify the staging dir actually got populated.
if [[ ! -f "${STAGING_DIR}/package.json" || ! -d "${STAGING_DIR}/src" ]]; then
  echo "Staging failed: package.json or src/ missing in ${STAGING_DIR}" >&2
  echo "Source dir was: ${REPO_DIR}" >&2
  exit 1
fi

# Carry .env and node_modules forward from the existing install, if present.
if [[ -f "${INSTALL_DIR}/.env" ]]; then
  cp -p "${INSTALL_DIR}/.env" "${STAGING_DIR}/.env"
fi
if [[ -d "${INSTALL_DIR}/node_modules" ]]; then
  cp -a "${INSTALL_DIR}/node_modules" "${STAGING_DIR}/node_modules"
fi

echo "--> Swapping ${INSTALL_DIR} -> new install (atomic)"
rm -rf "${ROLLBACK_DIR}"
if [[ -d "${INSTALL_DIR}" ]]; then
  mv "${INSTALL_DIR}" "${ROLLBACK_DIR}"
fi
mv "${STAGING_DIR}" "${INSTALL_DIR}"

echo "--> Setting ownership on ${INSTALL_DIR}"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

echo "--> Installing npm dependencies + building"
(cd "${INSTALL_DIR}" && sudo -u "${SERVICE_USER}" HOME="${DATA_DIR}" npm install >/dev/null)
(cd "${INSTALL_DIR}" && sudo -u "${SERVICE_USER}" HOME="${DATA_DIR}" ./node_modules/.bin/tsc)
(cd "${INSTALL_DIR}" && sudo -u "${SERVICE_USER}" HOME="${DATA_DIR}" npm prune --omit=dev >/dev/null)

echo "--> Configuring ${INSTALL_DIR}/.env"
if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
  cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
  echo "    created from template — edit with your bot token + user ID"
else
  echo "    already present (not overwriting)"
fi
chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/.env"
chmod 600 "${INSTALL_DIR}/.env"

echo "--> Installing systemd unit"
INSTALL_UNIT=true
if [[ -f "${SERVICE_FILE}" ]] && cmp -s "${INSTALL_DIR}/kirolink.service" "${SERVICE_FILE}"; then
  echo "    unit unchanged"
  INSTALL_UNIT=false
fi
if ${INSTALL_UNIT}; then
  cp "${INSTALL_DIR}/kirolink.service" "${SERVICE_FILE}"
  systemctl daemon-reload
  echo "    unit installed + daemon reloaded"
fi

if ${SERVICE_WAS_ACTIVE}; then
  echo "--> Restarting kirolink service"
  systemctl start kirolink
fi

# All good — discard the rollback copy.
rm -rf "${ROLLBACK_DIR}"

if ${IS_UPGRADE}; then
  echo ""
  echo "✅ KiroLink upgraded."
  if ${SERVICE_WAS_ACTIVE}; then
    echo "   Service restarted. Watch logs: sudo journalctl -u kirolink -f"
  else
    echo "   Start with: sudo systemctl start kirolink"
  fi
  echo ""
else
  cat <<EOF

✅ KiroLink is installed.

Next steps:
  1. Edit ${INSTALL_DIR}/.env with your Telegram bot token and allowed user IDs.
     (Get a bot token from @BotFather on Telegram; get your user ID from @userinfobot.)

  2. Switch to the service user and install + log in Kiro CLI:
       sudo -su ${SERVICE_USER}
       curl -fsSL https://cli.kiro.dev/install | bash
       export PATH="\$HOME/.local/bin:\$PATH"
       kiro-cli login
       exit
     (or set KIRO_API_KEY=... in ${INSTALL_DIR}/.env)

  3. Enable + start the service:
       sudo systemctl enable --now kirolink

  4. Watch logs:
       sudo journalctl -u kirolink -f

EOF
fi
