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
BACKUP_OFFSITE_REMOTE_RECEIPT="${BACKUP_OFFSITE_REMOTE_RECEIPT:-}"
BACKUP_OFFSITE_ALLOWED_REMOTE="${BACKUP_OFFSITE_ALLOWED_REMOTE:-${BACKUP_OFFSITE_REMOTE:-}}"
BACKUP_OFFSITE_EXPECTED_RECEIPT_SHA256="${BACKUP_OFFSITE_EXPECTED_RECEIPT_SHA256:-}"
BACKUP_AGE_IDENTITY_FILE="${BACKUP_AGE_IDENTITY_FILE:-}"
BACKUP_OFFSITE_RESTORE_DRY_RUN="${BACKUP_OFFSITE_RESTORE_DRY_RUN:-true}"
BACKUP_OFFSITE_RESTORE_RECEIPT_OUTPUT="${BACKUP_OFFSITE_RESTORE_RECEIPT_OUTPUT:-$(eliza_artifact_path eliza-hub-backup-offsite-restore-receipt.json)}"
ARG_REMOTE_RECEIPT=""
ARG_EXPECTED_RECEIPT_SHA256=""
ARG_DRY_RUN=""
WORK_DIR=""

log() {
  printf '[restore-offsite-check] %s\n' "$*"
}

fail() {
  printf '[restore-offsite-check] error: %s\n' "$*" >&2
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
Usage: restore-offsite-check.sh --receipt-remote REMOTE
                                --expected-receipt-sha256 SHA256 [--apply]

Downloads an off-site backup receipt and ciphertext, verifies both, decrypts
into an isolated disk-backed directory, validates archive paths, and runs the
non-destructive structural restore check.

Required private configuration:
  BACKUP_OFFSITE_ALLOWED_REMOTE   Allowed rclone prefix
  BACKUP_OFFSITE_EXPECTED_RECEIPT_SHA256
                                  Upload receipt digest obtained separately
                                  from the off-site bucket
  BACKUP_AGE_IDENTITY_FILE       age identity with mode 0600 or stricter

The default is a non-mutating dry run. Pass --apply to download and decrypt.
USAGE
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      --receipt-remote)
        shift
        (($# > 0)) || fail "--receipt-remote requires an rclone path"
        ARG_REMOTE_RECEIPT="$1"
        ;;
      --receipt-remote=*)
        ARG_REMOTE_RECEIPT="${1#--receipt-remote=}"
        ;;
      --expected-receipt-sha256)
        shift
        (($# > 0)) || fail "--expected-receipt-sha256 requires a digest"
        ARG_EXPECTED_RECEIPT_SHA256="$1"
        ;;
      --expected-receipt-sha256=*)
        ARG_EXPECTED_RECEIPT_SHA256="${1#--expected-receipt-sha256=}"
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
  safe_load_env_file "$ENV_FILE" "${ALLOW_ENV_ONLY:-false}" "restore-offsite-check"

  BACKUP_OFFSITE_REMOTE_RECEIPT="${BACKUP_OFFSITE_REMOTE_RECEIPT:-}"
  BACKUP_OFFSITE_ALLOWED_REMOTE="${BACKUP_OFFSITE_ALLOWED_REMOTE:-${BACKUP_OFFSITE_REMOTE:-}}"
  BACKUP_OFFSITE_EXPECTED_RECEIPT_SHA256="${BACKUP_OFFSITE_EXPECTED_RECEIPT_SHA256:-}"
  BACKUP_AGE_IDENTITY_FILE="${BACKUP_AGE_IDENTITY_FILE:-}"
  BACKUP_OFFSITE_RESTORE_RECEIPT_OUTPUT="${BACKUP_OFFSITE_RESTORE_RECEIPT_OUTPUT:-$(eliza_artifact_path eliza-hub-backup-offsite-restore-receipt.json)}"

  if [[ -n "$ARG_REMOTE_RECEIPT" ]]; then
    BACKUP_OFFSITE_REMOTE_RECEIPT="$ARG_REMOTE_RECEIPT"
  fi
  if [[ -n "$ARG_EXPECTED_RECEIPT_SHA256" ]]; then
    BACKUP_OFFSITE_EXPECTED_RECEIPT_SHA256="$ARG_EXPECTED_RECEIPT_SHA256"
  fi
  if [[ -n "$ARG_DRY_RUN" ]]; then
    BACKUP_OFFSITE_RESTORE_DRY_RUN="$ARG_DRY_RUN"
  fi
}

validate_private_inputs() {
  [[ -n "$BACKUP_OFFSITE_REMOTE_RECEIPT" ]] || fail "--receipt-remote or BACKUP_OFFSITE_REMOTE_RECEIPT is required"
  [[ -n "$BACKUP_OFFSITE_ALLOWED_REMOTE" ]] || fail "BACKUP_OFFSITE_ALLOWED_REMOTE is required"
  [[ "$BACKUP_OFFSITE_REMOTE_RECEIPT" == "$BACKUP_OFFSITE_ALLOWED_REMOTE/"* ]] || fail "remote receipt is outside BACKUP_OFFSITE_ALLOWED_REMOTE"
  [[ "$BACKUP_OFFSITE_REMOTE_RECEIPT" != *$'\n'* && "$BACKUP_OFFSITE_REMOTE_RECEIPT" != *$'\r'* ]] || fail "remote receipt contains a newline"
  [[ "$BACKUP_OFFSITE_REMOTE_RECEIPT" != *"/../"* && "$BACKUP_OFFSITE_REMOTE_RECEIPT" != *"/./"* && "$BACKUP_OFFSITE_REMOTE_RECEIPT" != */.. && "$BACKUP_OFFSITE_REMOTE_RECEIPT" != */. ]] || fail "remote receipt contains an unsafe path segment"

  [[ "$BACKUP_OFFSITE_EXPECTED_RECEIPT_SHA256" =~ ^[a-f0-9]{64}$ ]] || fail "BACKUP_OFFSITE_EXPECTED_RECEIPT_SHA256 must be a SHA-256 digest"

  [[ -n "$BACKUP_AGE_IDENTITY_FILE" ]] || fail "BACKUP_AGE_IDENTITY_FILE is required"
  [[ -f "$BACKUP_AGE_IDENTITY_FILE" ]] || fail "age identity file not found: $BACKUP_AGE_IDENTITY_FILE"
  [[ ! -L "$BACKUP_AGE_IDENTITY_FILE" ]] || fail "age identity file must not be a symbolic link"
  [[ -z "$(find "$BACKUP_AGE_IDENTITY_FILE" -perm /077 -print -quit)" ]] || fail "age identity file permissions must not allow group or other access"
  [[ ! -L "$BACKUP_OFFSITE_RESTORE_RECEIPT_OUTPUT" ]] || fail "restore receipt output must not be a symbolic link"
}

validate_archive_paths() {
  local archive="$1"
  local backup_name="$2"
  local entry

  while IFS= read -r entry; do
    [[ -n "$entry" ]] || fail "decrypted archive contains an empty path"
    [[ "$entry" == "$backup_name" || "$entry" == "$backup_name/"* ]] || fail "decrypted archive contains a path outside the backup root"
    [[ "$entry" != /* && "$entry" != *"/../"* && "$entry" != ../* && "$entry" != *"/.." ]] || fail "decrypted archive contains an unsafe path"
  done < <(tar -tzf "$archive")
}

validate_archive_types() {
  local archive="$1"
  local listing
  local entry_type

  while IFS= read -r listing; do
    [[ -n "$listing" ]] || fail "decrypted archive contains an invalid entry"
    entry_type="${listing:0:1}"
    case "$entry_type" in
      -|d) ;;
      *) fail "decrypted archive contains a link or special file" ;;
    esac
  done < <(LC_ALL=C tar --list --verbose --gzip --file "$archive")
}

write_dry_run() {
  jq -n \
    --arg remoteReceipt "$BACKUP_OFFSITE_REMOTE_RECEIPT" \
    --arg allowedRemote "$BACKUP_OFFSITE_ALLOWED_REMOTE" \
    --arg expectedReceiptSha256 "$BACKUP_OFFSITE_EXPECTED_RECEIPT_SHA256" \
    '{
      dryRun: true,
      remoteReceipt: $remoteReceipt,
      allowedRemote: $allowedRemote,
      expectedReceiptSha256: $expectedReceiptSha256,
      nextAction: "rerun with --apply in an isolated recovery environment"
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
  require_command sha256sum
  require_command stat
  require_command tar

  validate_private_inputs

  if is_true "$BACKUP_OFFSITE_RESTORE_DRY_RUN"; then
    log "validated recovery inputs; no remote reads or decryption performed"
    write_dry_run
    return 0
  fi

  eliza_prepare_artifact_dirs
  WORK_DIR="$(mktemp -d "$(eliza_tmp_path backup-offsite-restore.XXXXXX)")"
  trap 'rm -rf "${WORK_DIR:-}"' EXIT

  local upload_receipt="$WORK_DIR/upload-receipt.json"
  log "downloading off-host receipt"
  rclone copyto "$BACKUP_OFFSITE_REMOTE_RECEIPT" "$upload_receipt"

  local upload_receipt_sha256
  upload_receipt_sha256="$(sha256sum "$upload_receipt" | awk '{print $1}')"
  [[ "$upload_receipt_sha256" == "$BACKUP_OFFSITE_EXPECTED_RECEIPT_SHA256" ]] || fail "off-host receipt SHA-256 does not match the independently supplied digest"

  jq -e '
    .schema == "https://eliza.hub/schemas/offsite-backup-receipt.v1" and
    .status == "verified" and
    .uploadVerified == true and
    .verificationMethod == "download_sha256" and
    .encryption.format == "age" and
    (.encryption.recipientsFileSha256 | test("^[a-f0-9]{64}$")) and
    (.sourceManifestSha256 | test("^[a-f0-9]{64}$")) and
    (.sourceChecksumsSha256 | test("^[a-f0-9]{64}$")) and
    (.ciphertext.sha256 | test("^[a-f0-9]{64}$")) and
    (.ciphertext.bytes | type == "number" and . > 0)
  ' "$upload_receipt" >/dev/null || fail "off-host receipt is invalid or unverified"

  local backup_name
  local remote_archive
  local receipt_remote
  local expected_sha256
  local expected_bytes
  backup_name="$(jq -r '.backupName' "$upload_receipt")"
  remote_archive="$(jq -r '.remoteArchive' "$upload_receipt")"
  receipt_remote="$(jq -r '.remoteReceipt' "$upload_receipt")"
  expected_sha256="$(jq -r '.ciphertext.sha256' "$upload_receipt")"
  expected_bytes="$(jq -r '.ciphertext.bytes' "$upload_receipt")"

  [[ "$backup_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ ]] || fail "off-host receipt has an unsafe backup name"
  [[ "$receipt_remote" == "$BACKUP_OFFSITE_REMOTE_RECEIPT" ]] || fail "off-host receipt path does not match its remote source"
  [[ "$remote_archive" == "$BACKUP_OFFSITE_ALLOWED_REMOTE/"* ]] || fail "remote archive is outside BACKUP_OFFSITE_ALLOWED_REMOTE"
  [[ "$remote_archive" != *$'\n'* && "$remote_archive" != *$'\r'* ]] || fail "remote archive contains a newline"
  [[ "$remote_archive" != *"/../"* && "$remote_archive" != *"/./"* && "$remote_archive" != */.. && "$remote_archive" != */. ]] || fail "remote archive contains an unsafe path segment"
  [[ "$remote_archive" == "${receipt_remote%/receipt.json}/$backup_name.tar.gz.age" ]] || fail "remote archive and receipt do not identify the same backup"

  local ciphertext="$WORK_DIR/$backup_name.tar.gz.age"
  local plaintext_archive="$WORK_DIR/$backup_name.tar.gz"
  log "downloading encrypted backup"
  rclone copyto "$remote_archive" "$ciphertext"

  local actual_sha256
  local actual_bytes
  actual_sha256="$(sha256sum "$ciphertext" | awk '{print $1}')"
  actual_bytes="$(stat -c '%s' "$ciphertext")"
  [[ "$actual_sha256" == "$expected_sha256" ]] || fail "downloaded ciphertext SHA-256 mismatch"
  [[ "$actual_bytes" == "$expected_bytes" ]] || fail "downloaded ciphertext size mismatch"

  log "decrypting into isolated recovery storage"
  age --decrypt -i "$BACKUP_AGE_IDENTITY_FILE" -o "$plaintext_archive" "$ciphertext"
  validate_archive_paths "$plaintext_archive" "$backup_name"
  validate_archive_types "$plaintext_archive"

  local extract_dir="$WORK_DIR/extracted"
  mkdir -p "$extract_dir"
  tar --extract --gzip --file "$plaintext_archive" --directory "$extract_dir" \
    --no-same-owner --no-same-permissions --delay-directory-restore

  "$SCRIPT_DIR/restore-check.sh" "$extract_dir/$backup_name" >/dev/null

  local checked_at
  checked_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

  mkdir -p "$(dirname "$BACKUP_OFFSITE_RESTORE_RECEIPT_OUTPUT")"
  jq -n \
    --arg schema "https://eliza.hub/schemas/offsite-restore-receipt.v1" \
    --arg checkedAt "$checked_at" \
    --arg backupName "$backup_name" \
    --arg remoteReceipt "$BACKUP_OFFSITE_REMOTE_RECEIPT" \
    --arg remoteArchive "$remote_archive" \
    --arg uploadReceiptSha256 "$upload_receipt_sha256" \
    --arg ciphertextSha256 "$actual_sha256" \
    --argjson ciphertextBytes "$actual_bytes" \
    '{
      schema: $schema,
      status: "verified",
      checkedAt: $checkedAt,
      backupName: $backupName,
      remoteReceipt: $remoteReceipt,
      remoteArchive: $remoteArchive,
      uploadReceiptSha256: $uploadReceiptSha256,
      ciphertext: {
        sha256: $ciphertextSha256,
        bytes: $ciphertextBytes
      },
      downloadVerified: true,
      decryptionVerified: true,
      archivePathsVerified: true,
      structuralRestoreCheckPassed: true
    }' >"$BACKUP_OFFSITE_RESTORE_RECEIPT_OUTPUT"
  chmod 0600 "$BACKUP_OFFSITE_RESTORE_RECEIPT_OUTPUT"

  log "off-host recovery check passed"
  cat "$BACKUP_OFFSITE_RESTORE_RECEIPT_OUTPUT"
}

main "$@"
