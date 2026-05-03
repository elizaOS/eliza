#!/bin/bash
set -euo pipefail

# =============================================================================
# Steward Node Deployer
# Usage: ./scripts/deploy.sh <node-ip> [--migrate] [--restart] [--skip-install]
# =============================================================================

GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
CYAN='\033[36m'
RESET='\033[0m'

log()  { echo -e "${CYAN}[deploy]${RESET} $*"; }
ok()   { echo -e "${GREEN}[deploy]${RESET} $*"; }
warn() { echo -e "${YELLOW}[deploy]${RESET} $*"; }
fail() { echo -e "${RED}[deploy]${RESET} $*"; }

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
NODE_IP=""
DO_MIGRATE=false
DO_RESTART=false
SKIP_INSTALL=false

for arg in "$@"; do
  case "$arg" in
    --migrate)      DO_MIGRATE=true ;;
    --restart)      DO_RESTART=true ;;
    --skip-install) SKIP_INSTALL=true ;;
    -h|--help)
      echo "Usage: $0 <node-ip> [--migrate] [--restart] [--skip-install]"
      exit 0
      ;;
    -*)
      fail "Unknown flag: $arg"
      exit 1
      ;;
    *)
      if [[ -z "$NODE_IP" ]]; then
        NODE_IP="$arg"
      else
        fail "Unexpected argument: $arg"
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$NODE_IP" ]]; then
  fail "Missing required argument: <node-ip>"
  echo "Usage: $0 <node-ip> [--migrate] [--restart] [--skip-install]"
  exit 1
fi

# Validate IP-ish format (IPv4 or hostname)
if ! [[ "$NODE_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || "$NODE_IP" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  fail "Invalid node address: $NODE_IP"
  exit 1
fi

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REMOTE_DIR="/opt/steward"
BUN="/root/.bun/bin/bun"

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes"

remote() {
  ssh $SSH_OPTS "root@${NODE_IP}" "$@"
}

# ---------------------------------------------------------------------------
# 1. Rsync source
# ---------------------------------------------------------------------------
log "Syncing source to $NODE_IP:$REMOTE_DIR ..."

rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='web' \
  --exclude='.turbo' \
  --exclude='.next' \
  --exclude='dist' \
  --exclude='coverage' \
  --exclude='.env' \
  -e "ssh $SSH_OPTS" \
  "$REPO_ROOT/" "root@${NODE_IP}:${REMOTE_DIR}/"

ok "Source synced"

# ---------------------------------------------------------------------------
# 2. Install dependencies
# ---------------------------------------------------------------------------
if ! $SKIP_INSTALL; then
  log "Installing dependencies ..."
  remote "cd $REMOTE_DIR && $BUN install --frozen-lockfile 2>&1 || $BUN install 2>&1" | tail -3
  ok "Dependencies installed"
else
  warn "Skipping install (--skip-install)"
fi

# ---------------------------------------------------------------------------
# 3. Migrations
# ---------------------------------------------------------------------------
if $DO_MIGRATE; then
  log "Running migrations on $NODE_IP ..."

  MIGRATION_DIR="$REMOTE_DIR/packages/db/drizzle"
  SQL_FILES=$(remote "find $MIGRATION_DIR -maxdepth 1 -name '[0-9][0-9][0-9][0-9]_*.sql' | sort")

  if [[ -z "$SQL_FILES" ]]; then
    warn "No migration files found on remote"
  else
    # Read DATABASE_URL from remote .env
    REMOTE_DB_URL=$(remote "grep -E '^DATABASE_URL=' $REMOTE_DIR/.env | head -1 | cut -d'=' -f2-" 2>/dev/null || true)
    REMOTE_DB_URL="${REMOTE_DB_URL#\"}"
    REMOTE_DB_URL="${REMOTE_DB_URL%\"}"
    REMOTE_DB_URL="${REMOTE_DB_URL#\'}"
    REMOTE_DB_URL="${REMOTE_DB_URL%\'}"

    if [[ -z "$REMOTE_DB_URL" ]]; then
      fail "Could not read DATABASE_URL from $REMOTE_DIR/.env on $NODE_IP"
      exit 1
    fi

    MIGRATE_FAILED=false
    while IFS= read -r sql_file; do
      [[ -z "$sql_file" ]] && continue
      name="$(basename "$sql_file")"
      echo -n "  $name ... "

      if remote "psql '$REMOTE_DB_URL' -v ON_ERROR_STOP=1 -f '$sql_file'" > /dev/null 2>&1; then
        echo -e "${GREEN}OK${RESET}"
      else
        echo -e "${RED}FAILED${RESET}"
        MIGRATE_FAILED=true
        break
      fi
    done <<< "$SQL_FILES"

    if $MIGRATE_FAILED; then
      fail "Migration failed, aborting"
      exit 1
    fi
    ok "Migrations complete"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Restart services
# ---------------------------------------------------------------------------
if $DO_RESTART; then
  log "Restarting steward + steward-proxy on $NODE_IP ..."
  remote "systemctl restart steward steward-proxy"
  # Give services a moment to start
  sleep 3
  ok "Services restarted"
fi

# ---------------------------------------------------------------------------
# 5. Health check
# ---------------------------------------------------------------------------
log "Health check ..."

HEALTH_RESPONSE=$(remote "curl -sf http://localhost:3200/health" 2>/dev/null || true)

if [[ -z "$HEALTH_RESPONSE" ]]; then
  fail "Health check FAILED on $NODE_IP (no response from :3200/health)"
  exit 1
fi

VERSION=$(echo "$HEALTH_RESPONSE" | grep -o '"version":"[^"]*"' | cut -d'"' -f4 || echo "unknown")

ok "Health check passed on $NODE_IP (version: $VERSION)"
echo "$HEALTH_RESPONSE" | head -1
