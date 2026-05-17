#!/bin/bash
# PostgreSQL backup script
# Dumps maindb and rotates old backups

set -euo pipefail

BACKUP_DIR="/home/admin/server/backups/postgres"
RETENTION_DAYS=14
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')

mkdir -p "$BACKUP_DIR"

echo "[$(date)] Starting PostgreSQL backup..."

docker exec postgres pg_dump -U appuser maindb | gzip > "${BACKUP_DIR}/maindb_${TIMESTAMP}.sql.gz"

echo "[$(date)] Backup saved to maindb_${TIMESTAMP}.sql.gz"

# Cleanup old backups
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +${RETENTION_DAYS} -delete
echo "[$(date)] Cleaned up backups older than ${RETENTION_DAYS} days"
