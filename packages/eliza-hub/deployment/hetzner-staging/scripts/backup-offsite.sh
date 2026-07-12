#!/usr/bin/env bash
set -euo pipefail

umask 077
unset TAR_OPTIONS

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=artifact-paths.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/artifact-paths.sh"
# shellcheck source=env-loader.sh
# shellcheck disable=SC1091
. "$SCRIPT_DIR/env-loader.sh"

ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
BACKUP_DIR="${BACKUP_DIR:-}"
BACKUP_OFFSITE_REMOTE="${BACKUP_OFFSITE_REMOTE:-}"
BACKUP_AGE_RECIPIENTS_FILE="${BACKUP_AGE_RECIPIENTS_FILE:-}"
BACKUP_OFFSITE_DRY_RUN="${BACKUP_OFFSITE_DRY_RUN:-true}"
BACKUP_OFFSITE_RECEIPT_OUTPUT="${BACKUP_OFFSITE_RECEIPT_OUTPUT:-$(eliza_artifact_path eliza-hub-backup-offsite-receipt.json)}"
BACKUP_OFFSITE_KEEP_CIPHERTEXT="${BACKUP_OFFSITE_KEEP_CIPHERTEXT:-}"
ARG_BACKUP_DIR=""
ARG_DRY_RUN=""
WORK_DIR=""

log() {
  printf '[backup-offsite] %s\n' "$*"
}

fail() {
  printf '[backup-offsite] error: %s\n' "$*" >&2
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
Usage: backup-offsite.sh --backup-dir PATH [--apply]

Encrypts one verified backup with age, uploads it through rclone, downloads the
remote ciphertext to verify its SHA-256, and writes a non-secret JSON receipt.

Required private configuration:
  BACKUP_OFFSITE_REMOTE          Rclone destination prefix, for example
                                 r2:eliza-hub-backups/staging
  BACKUP_AGE_RECIPIENTS_FILE     File containing one or more age recipients

Optional:
  BACKUP_OFFSITE_RECEIPT_OUTPUT  Local receipt path outside Git
  BACKUP_OFFSITE_KEEP_CIPHERTEXT Keep a local encrypted copy at this path

The default is a non-mutating dry run. Pass --apply to upload.
USAGE
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      --backup-dir)
        shift
        (($# > 0)) || fail "--backup-dir requires a path"
        ARG_BACKUP_DIR="$1"
        ;;
      --backup-dir=*)
        ARG_BACKUP_DIR="${1#--backup-dir=}"
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

require_file() {
  [[ -f "$BACKUP_DIR/$1" ]] || fail "missing backup file: $1"
}

load_private_config() {
  safe_load_env_file "$ENV_FILE" "${ALLOW_ENV_ONLY:-false}" "backup-offsite"

  BACKUP_OFFSITE_REMOTE="${BACKUP_OFFSITE_REMOTE:-}"
  BACKUP_AGE_RECIPIENTS_FILE="${BACKUP_AGE_RECIPIENTS_FILE:-}"
  BACKUP_OFFSITE_RECEIPT_OUTPUT="${BACKUP_OFFSITE_RECEIPT_OUTPUT:-$(eliza_artifact_path eliza-hub-backup-offsite-receipt.json)}"
  BACKUP_OFFSITE_KEEP_CIPHERTEXT="${BACKUP_OFFSITE_KEEP_CIPHERTEXT:-}"

  if [[ -n "$ARG_BACKUP_DIR" ]]; then
    BACKUP_DIR="$ARG_BACKUP_DIR"
  fi
  if [[ -n "$ARG_DRY_RUN" ]]; then
    BACKUP_OFFSITE_DRY_RUN="$ARG_DRY_RUN"
  fi
}

validate_inputs() {
  [[ -n "$BACKUP_DIR" ]] || fail "--backup-dir or BACKUP_DIR is required"
  [[ -d "$BACKUP_DIR" ]] || fail "backup directory not found: $BACKUP_DIR"
  BACKUP_DIR="$(realpath "$BACKUP_DIR")"

  BACKUP_NAME="$(basename "$BACKUP_DIR")"
  [[ "$BACKUP_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ ]] || fail "backup directory name is unsafe"
  [[ -z "$(find "$BACKUP_DIR" -type l -print -quit)" ]] || fail "backup directory must not contain symbolic links"

  require_file MANIFEST.txt
  require_file SHA256SUMS
  require_file postgres/pg_dumpall.sql

  [[ -n "$BACKUP_OFFSITE_REMOTE" ]] || fail "BACKUP_OFFSITE_REMOTE is required"
  [[ "$BACKUP_OFFSITE_REMOTE" =~ ^[a-zA-Z0-9._-]+:.+[^/]$ ]] || fail "BACKUP_OFFSITE_REMOTE must be an rclone remote prefix without a trailing slash"
  [[ "$BACKUP_OFFSITE_REMOTE" != *$'\n'* && "$BACKUP_OFFSITE_REMOTE" != *$'\r'* ]] || fail "BACKUP_OFFSITE_REMOTE contains a newline"
  [[ "$BACKUP_OFFSITE_REMOTE" != *"/../"* && "$BACKUP_OFFSITE_REMOTE" != *"/./"* && "$BACKUP_OFFSITE_REMOTE" != */.. && "$BACKUP_OFFSITE_REMOTE" != */. ]] || fail "BACKUP_OFFSITE_REMOTE contains an unsafe path segment"

  [[ -n "$BACKUP_AGE_RECIPIENTS_FILE" ]] || fail "BACKUP_AGE_RECIPIENTS_FILE is required"
  [[ -f "$BACKUP_AGE_RECIPIENTS_FILE" ]] || fail "age recipients file not found: $BACKUP_AGE_RECIPIENTS_FILE"
  grep -Eq '^[[:space:]]*(age1|ssh-|plugin:)' "$BACKUP_AGE_RECIPIENTS_FILE" || fail "age recipients file contains no supported recipients"

  [[ ! -L "$BACKUP_OFFSITE_RECEIPT_OUTPUT" ]] || fail "BACKUP_OFFSITE_RECEIPT_OUTPUT must not be a symbolic link"
  if [[ -n "$BACKUP_OFFSITE_KEEP_CIPHERTEXT" ]]; then
    [[ ! -L "$BACKUP_OFFSITE_KEEP_CIPHERTEXT" ]] || fail "BACKUP_OFFSITE_KEEP_CIPHERTEXT must not be a symbolic link"
  fi

  local manifest_created_at
  manifest_created_at="$(sed -n 's/^created_utc=//p' "$BACKUP_DIR/MANIFEST.txt" | head -n 1)"
  [[ "$manifest_created_at" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "MANIFEST.txt has no valid created_utc timestamp"
  BACKUP_CREATED_AT="${manifest_created_at:0:4}-${manifest_created_at:4:2}-${manifest_created_at:6:2}T${manifest_created_at:9:2}:${manifest_created_at:11:2}:${manifest_created_at:13:2}Z"
}

write_dry_run() {
  jq -n \
    --arg backupName "$BACKUP_NAME" \
    --arg backupDir "$BACKUP_DIR" \
    --arg remotePrefix "$BACKUP_OFFSITE_REMOTE" \
    '{
      dryRun: true,
      backupName: $backupName,
      backupDir: $backupDir,
      remotePrefix: $remotePrefix,
      nextAction: "rerun with --apply after reviewing the destination and age recipients"
    }'
}

main() {
  parse_args "$@"
  load_private_config
  unset TAR_OPTIONS

  require_command age
  require_command awk
  require_command find
  require_command jq
  require_command rclone
  require_command realpath
  require_command sha256sum
  require_command stat
  require_command tar

  validate_inputs
  "$SCRIPT_DIR/restore-check.sh" "$BACKUP_DIR" >/dev/null

  if is_true "$BACKUP_OFFSITE_DRY_RUN"; then
    log "validated backup and private transfer configuration; no remote writes performed"
    write_dry_run
    return 0
  fi

  eliza_prepare_artifact_dirs
  WORK_DIR="$(mktemp -d "$(eliza_tmp_path backup-offsite.XXXXXX)")"
  trap 'rm -rf "${WORK_DIR:-}"' EXIT

  local ciphertext="$WORK_DIR/$BACKUP_NAME.tar.gz.age"
  local receipt="$WORK_DIR/receipt.json"
  local remote_dir="$BACKUP_OFFSITE_REMOTE/$BACKUP_NAME"
  local remote_archive="$remote_dir/$BACKUP_NAME.tar.gz.age"
  local remote_receipt="$remote_dir/receipt.json"

  log "encrypting verified backup without a plaintext aggregate archive"
  tar -C "$(dirname "$BACKUP_DIR")" -czf - "$BACKUP_NAME" \
    | age -R "$BACKUP_AGE_RECIPIENTS_FILE" -o "$ciphertext"

  local ciphertext_sha256
  local ciphertext_bytes
  local recipients_sha256
  local manifest_sha256
  local checksum_manifest_sha256
  ciphertext_sha256="$(sha256sum "$ciphertext" | awk '{print $1}')"
  ciphertext_bytes="$(stat -c '%s' "$ciphertext")"
  recipients_sha256="$(sha256sum "$BACKUP_AGE_RECIPIENTS_FILE" | awk '{print $1}')"
  manifest_sha256="$(sha256sum "$BACKUP_DIR/MANIFEST.txt" | awk '{print $1}')"
  checksum_manifest_sha256="$(sha256sum "$BACKUP_DIR/SHA256SUMS" | awk '{print $1}')"

  log "uploading immutable ciphertext to $remote_archive"
  rclone copyto "$ciphertext" "$remote_archive" --immutable

  log "verifying remote ciphertext by streamed download"
  local remote_sha256
  remote_sha256="$(rclone cat "$remote_archive" | sha256sum | awk '{print $1}')"
  [[ "$remote_sha256" == "$ciphertext_sha256" ]] || fail "remote ciphertext SHA-256 mismatch"

  local checked_at
  checked_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  jq -n \
    --arg schema "https://eliza.hub/schemas/offsite-backup-receipt.v1" \
    --arg checkedAt "$checked_at" \
    --arg backupName "$BACKUP_NAME" \
    --arg backupCreatedAt "$BACKUP_CREATED_AT" \
    --arg sourceManifestSha256 "$manifest_sha256" \
    --arg sourceChecksumsSha256 "$checksum_manifest_sha256" \
    --arg recipientsFileSha256 "$recipients_sha256" \
    --arg remoteArchive "$remote_archive" \
    --arg remoteReceipt "$remote_receipt" \
    --arg ciphertextSha256 "$ciphertext_sha256" \
    --argjson ciphertextBytes "$ciphertext_bytes" \
    '{
      schema: $schema,
      status: "verified",
      checkedAt: $checkedAt,
      backupName: $backupName,
      backupCreatedAt: $backupCreatedAt,
      sourceManifestSha256: $sourceManifestSha256,
      sourceChecksumsSha256: $sourceChecksumsSha256,
      encryption: {
        format: "age",
        recipientsFileSha256: $recipientsFileSha256
      },
      ciphertext: {
        sha256: $ciphertextSha256,
        bytes: $ciphertextBytes
      },
      remoteArchive: $remoteArchive,
      remoteReceipt: $remoteReceipt,
      uploadVerified: true,
      verificationMethod: "download_sha256"
    }' >"$receipt"

  mkdir -p "$(dirname "$BACKUP_OFFSITE_RECEIPT_OUTPUT")"
  install -m 0600 "$receipt" "$BACKUP_OFFSITE_RECEIPT_OUTPUT"

  log "uploading immutable verification receipt to $remote_receipt"
  rclone copyto "$receipt" "$remote_receipt" --immutable

  local receipt_sha256
  local remote_receipt_sha256
  receipt_sha256="$(sha256sum "$receipt" | awk '{print $1}')"
  remote_receipt_sha256="$(rclone cat "$remote_receipt" | sha256sum | awk '{print $1}')"
  [[ "$remote_receipt_sha256" == "$receipt_sha256" ]] || fail "remote receipt SHA-256 mismatch"

  if [[ -n "$BACKUP_OFFSITE_KEEP_CIPHERTEXT" ]]; then
    mkdir -p "$(dirname "$BACKUP_OFFSITE_KEEP_CIPHERTEXT")"
    install -m 0600 "$ciphertext" "$BACKUP_OFFSITE_KEEP_CIPHERTEXT"
  fi

  log "encrypted off-host backup verified"
  cat "$receipt"
}

main "$@"
