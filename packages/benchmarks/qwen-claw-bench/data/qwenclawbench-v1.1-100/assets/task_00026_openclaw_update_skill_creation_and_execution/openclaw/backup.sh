#!/usr/bin/env bash
# OpenClaw Backup Script
# Creates a timestamped backup of config and workspace data
# Usage: ./backup.sh [destination_dir]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$SCRIPT_DIR/.backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="openclaw-backup-$TIMESTAMP"

mkdir -p "$DEST"

echo "Creating backup: $BACKUP_NAME"

tar czf "$DEST/$BACKUP_NAME.tar.gz" \
  --exclude='node_modules' \
  --exclude='.backups' \
  --exclude='logs/*.log' \
  -C "$(dirname "$SCRIPT_DIR")" \
  "$(basename "$SCRIPT_DIR")"

# Calculate size
SIZE=$(du -h "$DEST/$BACKUP_NAME.tar.gz" | cut -f1)
echo "Backup complete: $DEST/$BACKUP_NAME.tar.gz ($SIZE)"

# Keep only last 5 backups
cd "$DEST"
ls -t openclaw-backup-*.tar.gz 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
echo "Cleanup: keeping last 5 backups"
