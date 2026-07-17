#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/../.." && pwd)"

BACKUP_DIR="${1:-${RESTORE_BACKUP_DIR:-}}"
POSTGRES_IMAGE="${RESTORE_DRILL_POSTGRES_IMAGE:-${POSTGRES_IMAGE:-postgres:16-alpine}}"
CONTAINER_NAME="${RESTORE_DRILL_CONTAINER_NAME:-eliza-hub-restore-drill-$$}"
RESTORE_DRILL_DATABASE="${RESTORE_DRILL_DATABASE:-forgejo}"
RESTORE_DRILL_TIMEOUT_SECONDS="${RESTORE_DRILL_TIMEOUT_SECONDS:-60}"
STARTED_CONTAINER=false

EXPECTED_TABLES=(
  steward_schema_migrations
  steward_queue_items
  steward_runs
  steward_events
  steward_agent_claims
  steward_worker_leases
)

log() {
  printf '[restore-drill] %s\n' "$*"
}

fail() {
  printf '[restore-drill] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: RESTORE_DRILL_CONFIRM_EMPTY_TARGET=true $0 /path/to/backup

Restores postgres/pg_dumpall.sql into a disposable loopback-only Postgres
container, runs Merge Steward migrations, verifies steward tables, and removes
the container. This never writes to the live Compose stack.

Environment:
  RESTORE_DRILL_CONFIRM_EMPTY_TARGET=true  required safety acknowledgement
  RESTORE_DRILL_POSTGRES_IMAGE             default: postgres:16-alpine
  RESTORE_DRILL_DATABASE                   default: forgejo
  RESTORE_DRILL_CONTAINER_NAME             default: eliza-hub-restore-drill-\$\$
  RESTORE_DRILL_TIMEOUT_SECONDS            default: 60
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

cleanup() {
  if [[ "$STARTED_CONTAINER" == "true" ]]; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}

validate_database_name() {
  [[ "$RESTORE_DRILL_DATABASE" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
    || fail "RESTORE_DRILL_DATABASE must be an unquoted Postgres identifier"
}

container_exists() {
  docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"
}

wait_for_postgres() {
  local deadline
  deadline=$(( $(date +%s) + RESTORE_DRILL_TIMEOUT_SECONDS ))

  until docker exec "$CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; do
    if (( $(date +%s) >= deadline )); then
      fail "Postgres did not become ready within ${RESTORE_DRILL_TIMEOUT_SECONDS}s"
    fi
    sleep 1
  done
}

database_exists() {
  local result
  result="$(
    docker exec "$CONTAINER_NAME" \
      psql -v ON_ERROR_STOP=1 -U postgres -d postgres -tA \
      -c "SELECT 1 FROM pg_database WHERE datname = '$RESTORE_DRILL_DATABASE';"
  )"
  [[ "$result" == "1" ]]
}

host_port() {
  local port
  port="$(docker port "$CONTAINER_NAME" 5432/tcp | awk -F: 'NR == 1 {print $NF}')"
  [[ -n "$port" ]] || fail "could not resolve disposable Postgres host port"
  printf '%s\n' "$port"
}

verify_expected_tables() {
  local table
  for table in "${EXPECTED_TABLES[@]}"; do
    local exists
    exists="$(
      docker exec "$CONTAINER_NAME" \
        psql -v ON_ERROR_STOP=1 -U postgres -d "$RESTORE_DRILL_DATABASE" -tA \
        -c "SELECT to_regclass('public.$table') IS NOT NULL;"
    )"
    [[ "$exists" == "t" ]] || fail "expected restored database to contain table: $table"
  done
}

main() {
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    return 0
  fi

  [[ -n "$BACKUP_DIR" ]] || fail "usage: $0 /path/to/backup"
  [[ -d "$BACKUP_DIR" ]] || fail "backup directory not found: $BACKUP_DIR"
  [[ "${RESTORE_DRILL_CONFIRM_EMPTY_TARGET:-false}" == "true" ]] \
    || fail "set RESTORE_DRILL_CONFIRM_EMPTY_TARGET=true to confirm this disposable empty-target drill"

  validate_database_name
  require_command docker
  require_command node

  "$SCRIPT_DIR/restore-check.sh" "$BACKUP_DIR" >/dev/null
  [[ -f "$BACKUP_DIR/postgres/pg_dumpall.sql" ]] || fail "missing postgres/pg_dumpall.sql"

  if container_exists; then
    fail "container already exists: $CONTAINER_NAME"
  fi

  trap cleanup EXIT

  log "starting disposable Postgres container $CONTAINER_NAME from $POSTGRES_IMAGE"
  docker run \
    -d \
    --rm \
    --name "$CONTAINER_NAME" \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -p 127.0.0.1::5432 \
    "$POSTGRES_IMAGE" >/dev/null
  STARTED_CONTAINER=true

  wait_for_postgres

  log "restoring pg_dumpall.sql"
  docker exec -i "$CONTAINER_NAME" \
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    < "$BACKUP_DIR/postgres/pg_dumpall.sql" >/dev/null

  database_exists || fail "restored dump did not create database: $RESTORE_DRILL_DATABASE"

  local port
  port="$(host_port)"

  log "running Merge Steward migrations against restored $RESTORE_DRILL_DATABASE database"
  DATABASE_URL="postgres://postgres@127.0.0.1:$port/$RESTORE_DRILL_DATABASE" \
    node "$REPO_ROOT/services/merge-steward/src/migrate.js" >/dev/null

  log "verifying steward runtime tables"
  verify_expected_tables

  log "restore drill passed"
  printf 'backup=%s\n' "$BACKUP_DIR"
  printf 'postgres_image=%s\n' "$POSTGRES_IMAGE"
  printf 'database=%s\n' "$RESTORE_DRILL_DATABASE"
  printf 'verified_tables=%s\n' "$(IFS=,; printf '%s' "${EXPECTED_TABLES[*]}")"
}

main "$@"
