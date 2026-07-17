#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=../deployment/hetzner-staging/scripts/artifact-paths.sh
# shellcheck disable=SC1091
. "$REPO_ROOT/deployment/hetzner-staging/scripts/artifact-paths.sh"

APPLY_PRUNE="${APPLY_PRUNE:-false}"
PRUNE_MIN_AGE_DAYS="${PRUNE_MIN_AGE_DAYS:-7}"
PRUNE_TMP="${PRUNE_TMP:-true}"
PRUNE_ARTIFACTS="${PRUNE_ARTIFACTS:-false}"

log() {
  printf '[prune-local-artifacts] %s\n' "$*"
}

fail() {
  printf '[prune-local-artifacts] error: %s\n' "$*" >&2
  exit 1
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

safe_root() {
  local root="$1"

  [[ -n "$root" ]] || return 1
  [[ "$root" != "/" ]] || return 1
  [[ "$root" != "/tmp" ]] || return 1
  [[ "$root" != "/var/tmp" ]] || return 1
  [[ "$root" == *"eliza-hub"* ]] || return 1
}

prune_root() {
  local label="$1"
  local root="$2"

  if ! safe_root "$root"; then
    fail "refusing to prune unsafe $label root: $root"
  fi

  if [[ ! -d "$root" ]]; then
    log "$label root does not exist: $root"
    return 0
  fi

  log "$label root: $root"
  if is_true "$APPLY_PRUNE"; then
    find "$root" -mindepth 1 -maxdepth 1 -mtime "+$PRUNE_MIN_AGE_DAYS" -exec rm -rf {} +
  else
    find "$root" -mindepth 1 -maxdepth 1 -mtime "+$PRUNE_MIN_AGE_DAYS" -print
  fi
}

main() {
  case "$PRUNE_MIN_AGE_DAYS" in
    ''|*[!0-9]*) fail "PRUNE_MIN_AGE_DAYS must be a non-negative integer" ;;
  esac

  log "APPLY_PRUNE=$APPLY_PRUNE PRUNE_MIN_AGE_DAYS=$PRUNE_MIN_AGE_DAYS"
  log "dry-run by default; set APPLY_PRUNE=true to delete listed entries"
  log "external browser profiles such as /tmp/eliza-live-profiles are intentionally out of scope"

  if is_true "$PRUNE_TMP"; then
    prune_root "tmp" "$ELIZA_TMP_ROOT"
  fi

  if is_true "$PRUNE_ARTIFACTS"; then
    prune_root "artifact" "$ELIZA_ARTIFACT_ROOT"
  else
    log "artifact pruning disabled; set PRUNE_ARTIFACTS=true to include $ELIZA_ARTIFACT_ROOT"
  fi
}

main "$@"
