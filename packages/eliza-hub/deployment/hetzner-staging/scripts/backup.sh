#!/usr/bin/env bash
set -euo pipefail

umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/../.." && pwd)"

# shellcheck source=env-loader.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/env-loader.sh"

ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/compose.yml}"
BACKUP_ROOT="${BACKUP_ROOT:-}"
BACKUP_COMPOSE_PROFILES="${BACKUP_COMPOSE_PROFILES:-steward}"
TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
BACKUP_NAME="${BACKUP_NAME:-}"
BACKUP_DIR=""
POSTGRES_DIR=""
ARCHIVES_DIR=""
HOST_DIR=""
SKIPPED=()

log() {
  printf '[backup] %s\n' "$*"
}

fail() {
  printf '[backup] error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

load_env_file() {
  safe_load_env_file "$ENV_FILE" "${ALLOW_ENV_ONLY:-false}" "backup"
}

compose_args() {
  local args=()

  if [[ -n "$BACKUP_COMPOSE_PROFILES" ]]; then
    IFS=',' read -r -a profiles <<< "$BACKUP_COMPOSE_PROFILES"
    for profile in "${profiles[@]}"; do
      [[ -n "$profile" ]] && args+=(--profile "$profile")
    done
  fi

  if [[ -f "$ENV_FILE" ]]; then
    args+=(--env-file "$ENV_FILE")
  fi

  args+=(-f "$COMPOSE_FILE")
  printf '%s\0' "${args[@]}"
}

compose() {
  local args=()
  while IFS= read -r -d '' arg; do
    args+=("$arg")
  done < <(compose_args)

  docker compose "${args[@]}" "$@"
}

service_container_id() {
  compose ps -q "$1" 2>/dev/null || true
}

archive_service_path() {
  local service="$1"
  local source_path="$2"
  local target="$3"
  local required="$4"
  local container_id

  container_id="$(service_container_id "$service")"
  if [[ -z "$container_id" ]]; then
    if [[ "$required" == "required" ]]; then
      fail "service '$service' is not running; cannot back up $source_path"
    fi
    SKIPPED+=("$service:$source_path (service not running)")
    log "skipping $service:$source_path because the service is not running"
    return 0
  fi

  log "archiving $service:$source_path"
  compose exec -T "$service" sh -c "test -d '$source_path' && tar -C '$source_path' -czf - ." > "$target"
}

archive_host_dir() {
  local source="$1"
  local target="$2"
  local label="$3"

  if [[ ! -d "$source" ]]; then
    SKIPPED+=("$label (directory missing)")
    log "skipping $label because $source is missing"
    return 0
  fi

  log "archiving $label"
  tar -C "$source" -czf "$target" .
}

write_env_key_manifest() {
  if [[ -f "$ENV_FILE" ]]; then
    sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$ENV_FILE" \
      | LC_ALL=C sort -u > "$BACKUP_DIR/env.keys"
  else
    : > "$BACKUP_DIR/env.keys"
  fi
}

write_manifest() {
  local git_rev
  git_rev="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"

  {
    printf 'name=%s\n' "$BACKUP_NAME"
    printf 'created_utc=%s\n' "$TIMESTAMP"
    printf 'repo_root=%s\n' "$REPO_ROOT"
    printf 'git_rev=%s\n' "$git_rev"
    printf 'compose_file=%s\n' "$COMPOSE_FILE"
    printf 'env_file_keys_only=%s\n' "$ENV_FILE"
    printf 'secrets_included=false\n'
    printf 'restore_target=empty-staging-host-only\n'
    printf '\nartifacts:\n'
    find "$BACKUP_DIR" -type f ! -name 'SHA256SUMS' -printf '%P\n' | LC_ALL=C sort | sed 's/^/- /'

    if ((${#SKIPPED[@]})); then
      printf '\nskipped:\n'
      printf -- '- %s\n' "${SKIPPED[@]}"
    fi

    printf '\nnotes:\n'
    printf -- '- This backup intentionally records env keys, not env values.\n'
    printf -- '- Recover secrets from the host secret store before restore.\n'
    printf -- '- Verify with scripts/restore-check.sh before any restore drill.\n'
  } > "$BACKUP_DIR/MANIFEST.txt"
}

write_checksums() {
  (
    cd "$BACKUP_DIR"
    find . -type f ! -name 'SHA256SUMS' -print \
      | sed 's#^\./##' \
      | LC_ALL=C sort \
      | while IFS= read -r file; do
          sha256sum "$file"
        done > SHA256SUMS
  )
}

main() {
  require_command docker
  require_command realpath
  require_command tar
  require_command sha256sum
  load_env_file
  unset TAR_OPTIONS

  BACKUP_ROOT="${BACKUP_ROOT:-$DEPLOY_DIR/backups}"
  BACKUP_NAME="${BACKUP_NAME:-eliza-forgejo-staging-$TIMESTAMP}"
  if [[ "$BACKUP_ROOT" != /* ]]; then
    BACKUP_ROOT="$DEPLOY_DIR/$BACKUP_ROOT"
  fi
  BACKUP_ROOT="$(realpath -m "$BACKUP_ROOT")"
  [[ "$BACKUP_ROOT" != "/" ]] || fail "BACKUP_ROOT must not be the filesystem root"
  BACKUP_DIR="$BACKUP_ROOT/$BACKUP_NAME"
  POSTGRES_DIR="$BACKUP_DIR/postgres"
  ARCHIVES_DIR="$BACKUP_DIR/archives"
  HOST_DIR="$BACKUP_DIR/host"

  [[ "$BACKUP_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ ]] || fail "BACKUP_NAME is unsafe"
  [[ ! -e "$BACKUP_DIR" ]] || fail "backup destination already exists: $BACKUP_DIR"

  mkdir -p "$POSTGRES_DIR" "$ARCHIVES_DIR" "$HOST_DIR"

  log "writing backup to $BACKUP_DIR"
  log "dumping Postgres cluster"
  compose exec -T postgres pg_dumpall -U "${FORGEJO_DB_USER:-forgejo}" > "$POSTGRES_DIR/pg_dumpall.sql"

  archive_service_path forgejo /var/lib/gitea "$ARCHIVES_DIR/forgejo-data.tar.gz" required
  archive_service_path forgejo /etc/gitea "$ARCHIVES_DIR/forgejo-config.tar.gz" required
  archive_service_path merge-steward /state "$ARCHIVES_DIR/merge-steward-state.tar.gz" optional
  archive_host_dir "$REPO_ROOT/custom" "$ARCHIVES_DIR/eliza-custom.tar.gz" "Eliza custom layer"
  archive_host_dir "$REPO_ROOT/templates" "$ARCHIVES_DIR/eliza-templates.tar.gz" "Eliza templates"

  cp "$COMPOSE_FILE" "$HOST_DIR/compose.yml"
  cp "$DEPLOY_DIR/.env.example" "$HOST_DIR/.env.example"
  write_env_key_manifest
  write_manifest
  write_checksums

  log "backup complete"
  log "verify with: $SCRIPT_DIR/restore-check.sh '$BACKUP_DIR'"
}

main "$@"
