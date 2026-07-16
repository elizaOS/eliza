#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SELF_SCAN_FILE="$SCRIPT_DIR/private-reference-scan.sh"

TERMS=(
  "sanitized private handoff"
  "inspired by"
  "reference project"
  "source project"
)

SECRET_PATTERNS=(
  "github_pat:github_pat_[A-Za-z0-9_]{20,}"
  "github_classic_pat:gh[pousr]_[A-Za-z0-9]{36,}"
  "private_key:-----BEGIN (RSA |DSA |EC |OPENSSH |)?PRIVATE KEY-----"
  "openai_key:sk-(proj-)?[A-Za-z0-9_-]{32,}"
  "anthropic_key:sk-ant-[A-Za-z0-9_-]{32,}"
  "npm_token:npm_[A-Za-z0-9]{36,}"
)

RG_GLOBS=(
  --glob '!node_modules/**'
  --glob '!vendor/**'
  --glob '!data/**'
  --glob '!backups/**'
  --glob '!deployment/hetzner-staging/runner/data/**'
  --glob '!scripts/private-reference-scan.sh'
)

GREP_EXCLUDES=(
  --exclude-dir=.git
  --exclude-dir=node_modules
  --exclude-dir=vendor
  --exclude-dir=data
  --exclude-dir=backups
  --exclude=private-reference-scan.sh
)

main() {
  local matches=""
  local term

  for term in "${TERMS[@]}"; do
    local found
    found="$(scan_term "$term" || true)"
    if [[ -n "$found" ]]; then
      matches+="$found"$'\n'
    fi
  done

  local pattern
  for pattern in "${SECRET_PATTERNS[@]}"; do
    local label="${pattern%%:*}"
    local regex="${pattern#*:}"
    local found
    found="$(scan_pattern "$label" "$regex" || true)"
    if [[ -n "$found" ]]; then
      matches+="$found"$'\n'
    fi
  done

  if [[ -n "$matches" ]]; then
    printf '[private-reference-scan] disallowed private/reference text or secret-shaped material found:\n' >&2
    printf '%s' "$matches" >&2
    exit 1
  fi

  printf '[private-reference-scan] no disallowed private/reference text or secret-shaped material found\n'
}

scan_term() {
  local term="$1"

  if command -v rg >/dev/null 2>&1; then
    rg -n -i -F "${RG_GLOBS[@]}" -- "$term" "$REPO_ROOT" | filter_self_matches
  else
    grep -RInI -i -F "${GREP_EXCLUDES[@]}" -- "$term" "$REPO_ROOT" | filter_self_matches
  fi
}

scan_pattern() {
  local label="$1"
  local regex="$2"

  if command -v rg >/dev/null 2>&1; then
    rg -n -I -P "${RG_GLOBS[@]}" -- "$regex" "$REPO_ROOT" | filter_self_matches | sed "s/^/[$label] /"
  else
    grep -RInIE "${GREP_EXCLUDES[@]}" -e "$regex" "$REPO_ROOT" | filter_self_matches | sed "s/^/[$label] /"
  fi
}

filter_self_matches() {
  local line
  while IFS= read -r line; do
    case "$line" in
      "$SELF_SCAN_FILE":*) ;;
      *) printf '%s\n' "$line" ;;
    esac
  done
}

main "$@"
