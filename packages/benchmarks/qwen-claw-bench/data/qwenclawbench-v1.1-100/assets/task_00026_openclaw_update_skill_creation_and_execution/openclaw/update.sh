#!/usr/bin/env bash
# OpenClaw Update Script
# Usage: ./update.sh [--force] [--backup] [--dry-run]
# Updates OpenClaw to the latest version via npm

set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="$INSTALL_DIR/.backups"
VERSION_FILE="$INSTALL_DIR/package.json"
LOG_FILE="/var/log/openclaw/update.log"

FORCE=false
BACKUP=false
DRY_RUN=false

for arg in "$@"; do
  case $arg in
    --force)   FORCE=true ;;
    --backup)  BACKUP=true ;;
    --dry-run) DRY_RUN=true ;;
    *)         echo "Unknown option: $arg"; exit 1 ;;
  esac
done

current_version() {
  node -e "console.log(require('$VERSION_FILE').version)" 2>/dev/null || echo "unknown"
}

latest_version() {
  npm view openclaw version 2>/dev/null || echo "unknown"
}

log() {
  local msg="[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $1"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE" 2>/dev/null || true
}

CURRENT=$(current_version)
LATEST=$(latest_version)

log "Current version: $CURRENT"
log "Latest version:  $LATEST"

if [ "$CURRENT" = "$LATEST" ] && [ "$FORCE" = false ]; then
  log "Already up to date (v$CURRENT). Use --force to reinstall."
  exit 0
fi

if [ "$DRY_RUN" = true ]; then
  log "[DRY RUN] Would update from v$CURRENT to v$LATEST"
  exit 0
fi

if [ "$BACKUP" = true ]; then
  log "Creating backup..."
  mkdir -p "$BACKUP_DIR"
  BACKUP_NAME="openclaw-$CURRENT-$(date +%Y%m%d%H%M%S).tar.gz"
  tar czf "$BACKUP_DIR/$BACKUP_NAME" \
    --exclude=node_modules \
    --exclude=.backups \
    -C "$(dirname "$INSTALL_DIR")" "$(basename "$INSTALL_DIR")"
  log "Backup saved: $BACKUP_DIR/$BACKUP_NAME"
fi

log "Stopping gateway..."
openclaw gateway stop 2>/dev/null || true
sleep 2

log "Updating OpenClaw..."
npm install -g openclaw@latest 2>&1 | tee -a "$LOG_FILE"

log "Restarting gateway..."
openclaw gateway start

NEW_VERSION=$(current_version)
log "Update complete: v$CURRENT → v$NEW_VERSION"
