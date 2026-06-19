#!/bin/bash
# backup_config.sh - Backup openclaw configuration files
# Distractor: not relevant to process monitoring

BACKUP_DIR="/home/node/backups/openclaw"
CONFIG_DIR="/etc/openclaw"
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')

mkdir -p "$BACKUP_DIR"

echo "Backing up OpenClaw configuration..."
tar czf "$BACKUP_DIR/openclaw_config_${TIMESTAMP}.tar.gz" \
    -C / \
    etc/openclaw/gateway.yaml \
    etc/systemd/system/openclaw.service \
    home/node/workspace/AGENTS.md \
    home/node/workspace/SOUL.md \
    2>/dev/null

# Keep only last 10 backups
ls -t "$BACKUP_DIR"/openclaw_config_*.tar.gz 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null

echo "Backup completed: $BACKUP_DIR/openclaw_config_${TIMESTAMP}.tar.gz"
