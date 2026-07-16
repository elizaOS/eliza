#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${1:-${RESTORE_BACKUP_DIR:-}}"

log() {
  printf '[restore-check] %s\n' "$*"
}

fail() {
  printf '[restore-check] error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_file() {
  [[ -f "$BACKUP_DIR/$1" ]] || fail "missing backup file: $1"
}

check_archive() {
  local file="$1"
  require_file "$file"
  tar -tzf "$BACKUP_DIR/$file" >/dev/null || fail "archive is not readable: $file"
}

main() {
  [[ -n "$BACKUP_DIR" ]] || fail "usage: $0 /path/to/backup"
  [[ -d "$BACKUP_DIR" ]] || fail "backup directory not found: $BACKUP_DIR"

  require_command sha256sum
  require_command tar

  require_file MANIFEST.txt
  require_file SHA256SUMS
  require_file env.keys
  require_file host/compose.yml
  require_file host/.env.example
  require_file postgres/pg_dumpall.sql

  log "verifying checksums"
  (cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS >/dev/null)

  if ! grep -Eq 'PostgreSQL database (cluster )?dump' "$BACKUP_DIR/postgres/pg_dumpall.sql"; then
    fail "postgres/pg_dumpall.sql does not look like a pg_dumpall output"
  fi

  log "checking required archives"
  check_archive archives/forgejo-data.tar.gz
  check_archive archives/forgejo-config.tar.gz
  check_archive archives/eliza-custom.tar.gz
  check_archive archives/eliza-templates.tar.gz

  if [[ -f "$BACKUP_DIR/archives/merge-steward-state.tar.gz" ]]; then
    check_archive archives/merge-steward-state.tar.gz
  fi

  log "backup is structurally valid"
  printf '\nRestore drill outline for an empty staging host:\n'
  printf '1. Provision the same compose file and a fresh private .env from the host secret store.\n'
  printf '2. Start Postgres only, then restore postgres/pg_dumpall.sql with psql as the postgres superuser.\n'
  printf '3. Restore forgejo-data.tar.gz to /var/lib/gitea and forgejo-config.tar.gz to /etc/gitea.\n'
  printf '4. Restore the Eliza custom layer and templates from the archived host artifacts.\n'
  printf '5. Start Forgejo, run the Merge Steward migrations, then start the steward profile.\n'
  printf '6. Run: npm run doctor --prefix services/merge-steward -- <steward-url>\n'
}

main "$@"
