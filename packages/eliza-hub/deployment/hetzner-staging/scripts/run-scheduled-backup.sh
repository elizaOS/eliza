#!/usr/bin/env bash
set -euo pipefail

umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=env-loader.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/env-loader.sh"

ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
BACKUP_ROOT="${BACKUP_ROOT:-$DEPLOY_DIR/backups}"
BACKUP_OFFSITE_REMOTE="${BACKUP_OFFSITE_REMOTE:-}"
BACKUP_AGE_RECIPIENTS_FILE="${BACKUP_AGE_RECIPIENTS_FILE:-}"
BACKUP_SCHEDULE_DRY_RUN="${BACKUP_SCHEDULE_DRY_RUN:-true}"
BACKUP_SCHEDULE_LOCK_FILE="${BACKUP_SCHEDULE_LOCK_FILE:-}"
ARG_DRY_RUN=""

log() {
  printf '[scheduled-backup] %s\n' "$*"
}

fail() {
  printf '[scheduled-backup] error: %s\n' "$*" >&2
  exit 1
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<'USAGE'
Usage: run-scheduled-backup.sh [--apply]

Creates one Forgejo backup, runs its structural check, encrypts and uploads it,
then verifies the remote ciphertext. Concurrent runs fail closed through flock.

The default is a non-mutating dry run. Pass --apply from an operator-reviewed
systemd service or an interactive shell to create and upload a backup.
USAGE
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      --apply)
        ARG_DRY_RUN=false
        ;;
      --dry-run)
        ARG_DRY_RUN=true
        ;;
      *)
        fail "unknown argument: $1"
        ;;
    esac
    shift
  done
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

load_private_config() {
  safe_load_env_file "$ENV_FILE" "${ALLOW_ENV_ONLY:-false}" "scheduled-backup"

  BACKUP_ROOT="${BACKUP_ROOT:-$DEPLOY_DIR/backups}"
  BACKUP_OFFSITE_REMOTE="${BACKUP_OFFSITE_REMOTE:-}"
  BACKUP_AGE_RECIPIENTS_FILE="${BACKUP_AGE_RECIPIENTS_FILE:-}"
  BACKUP_SCHEDULE_LOCK_FILE="${BACKUP_SCHEDULE_LOCK_FILE:-}"

  if [[ -n "$ARG_DRY_RUN" ]]; then
    BACKUP_SCHEDULE_DRY_RUN="$ARG_DRY_RUN"
  fi
}

validate_config() {
  if [[ "$BACKUP_ROOT" != /* ]]; then
    BACKUP_ROOT="$DEPLOY_DIR/$BACKUP_ROOT"
  fi
  BACKUP_ROOT="$(realpath -m "$BACKUP_ROOT")"
  [[ "$BACKUP_ROOT" != "/" ]] || fail "BACKUP_ROOT must not be the filesystem root"

  [[ -n "$BACKUP_OFFSITE_REMOTE" ]] || fail "BACKUP_OFFSITE_REMOTE is required"
  [[ "$BACKUP_OFFSITE_REMOTE" =~ ^[a-zA-Z0-9._-]+:.+[^/]$ ]] || fail "BACKUP_OFFSITE_REMOTE must be an rclone prefix without a trailing slash"
  [[ "$BACKUP_OFFSITE_REMOTE" != *$'\n'* && "$BACKUP_OFFSITE_REMOTE" != *$'\r'* ]] || fail "BACKUP_OFFSITE_REMOTE contains a newline"
  [[ "$BACKUP_OFFSITE_REMOTE" != *"/../"* && "$BACKUP_OFFSITE_REMOTE" != *"/./"* && "$BACKUP_OFFSITE_REMOTE" != */.. && "$BACKUP_OFFSITE_REMOTE" != */. ]] || fail "BACKUP_OFFSITE_REMOTE contains an unsafe path segment"

  [[ -n "$BACKUP_AGE_RECIPIENTS_FILE" ]] || fail "BACKUP_AGE_RECIPIENTS_FILE is required"
  [[ -f "$BACKUP_AGE_RECIPIENTS_FILE" ]] || fail "age recipients file not found: $BACKUP_AGE_RECIPIENTS_FILE"

  BACKUP_SCHEDULE_LOCK_FILE="$(realpath -m "${BACKUP_SCHEDULE_LOCK_FILE:-$BACKUP_ROOT/.scheduled-backup.lock}")"
  [[ "$BACKUP_SCHEDULE_LOCK_FILE" == "$BACKUP_ROOT/"* ]] || fail "BACKUP_SCHEDULE_LOCK_FILE must stay under BACKUP_ROOT"
}

write_dry_run() {
  jq -n \
    --arg backupRoot "$BACKUP_ROOT" \
    --arg remotePrefix "$BACKUP_OFFSITE_REMOTE" \
    --arg recipientsFile "$BACKUP_AGE_RECIPIENTS_FILE" \
    '{
      dryRun: true,
      backupRoot: $backupRoot,
      remotePrefix: $remotePrefix,
      recipientsFile: $recipientsFile,
      nextAction: "rerun with --apply after reviewing the timer host and off-site destination"
    }'
}

main() {
  parse_args "$@"
  load_private_config

  require_command flock
  require_command jq
  require_command realpath
  require_command sha256sum
  validate_config

  if is_true "$BACKUP_SCHEDULE_DRY_RUN"; then
    log "validated scheduled backup configuration; no local or remote writes performed"
    write_dry_run
    return 0
  fi

  mkdir -p "$BACKUP_ROOT"
  exec 9>"$BACKUP_SCHEDULE_LOCK_FILE"
  flock -n 9 || fail "another scheduled backup is already running"

  local timestamp
  local backup_name
  local backup_dir
  local receipt_dir
  local upload_receipt
  timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
  backup_name="eliza-forgejo-$timestamp"
  backup_dir="$BACKUP_ROOT/$backup_name"
  receipt_dir="$BACKUP_ROOT/receipts/$backup_name"
  upload_receipt="$receipt_dir/upload-receipt.json"

  mkdir -p "$receipt_dir"
  log "creating $backup_name"
  ENV_FILE="$ENV_FILE" BACKUP_ROOT="$BACKUP_ROOT" BACKUP_NAME="$backup_name" \
    "$SCRIPT_DIR/backup.sh"

  "$SCRIPT_DIR/restore-check.sh" "$backup_dir" >/dev/null

  log "encrypting and uploading $backup_name"
  ENV_FILE="$ENV_FILE" \
    BACKUP_OFFSITE_RECEIPT_OUTPUT="$upload_receipt" \
    "$SCRIPT_DIR/backup-offsite.sh" --backup-dir "$backup_dir" --apply >/dev/null

  jq -n \
    --arg status "verified" \
    --arg backupDir "$backup_dir" \
    --arg uploadReceipt "$upload_receipt" \
    --arg uploadReceiptSha256 "$(sha256sum "$upload_receipt" | awk '{print $1}')" \
    --arg remoteReceipt "$(jq -r '.remoteReceipt' "$upload_receipt")" \
    '{
      status: $status,
      backupDir: $backupDir,
      uploadReceipt: $uploadReceipt,
      uploadReceiptSha256: $uploadReceiptSha256,
      remoteReceipt: $remoteReceipt
    }'
}

main "$@"
