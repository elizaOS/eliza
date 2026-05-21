#!/usr/bin/env bash
# pin-action-shas.sh
#
# Rewrites `uses: owner/repo@vTAG` references in .github/workflows to use the
# resolved commit SHA, preserving the original tag in a trailing comment.
# This implements the OpenSSF Scorecard "Pinned-Dependencies" check (SOC2
# CC9.2 supply-chain integrity).
#
# Resolves SHAs via `gh api repos/<owner>/<repo>/git/refs/tags/<tag>`,
# following annotated tags to their commit. Requires `gh` authenticated.
#
# Usage:
#   scripts/security/pin-action-shas.sh              # dry-run (default)
#   scripts/security/pin-action-shas.sh --apply      # rewrite files
#   scripts/security/pin-action-shas.sh --apply path/to/workflow.yml
#
# Skipped:
#   - References that already use a 40-char SHA (`@<sha>`).
#   - Local (`uses: ./.github/actions/...`) and docker (`uses: docker://...`).
#   - Reusable workflow references (`uses: ./.github/workflows/...`).
#
# Idempotent and safe to re-run.

set -euo pipefail

MODE="dry-run"
TARGETS=()
for arg in "$@"; do
  case "$arg" in
    --apply) MODE="apply" ;;
    -h|--help)
      sed -n '2,25p' "$0"; exit 0 ;;
    *) TARGETS+=("$arg") ;;
  esac
done

REPO_ROOT=$(git rev-parse --show-toplevel)
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  shopt -s nullglob
  TARGETS=("${REPO_ROOT}/.github/workflows/"*.yml "${REPO_ROOT}/.github/workflows/"*.yaml)
fi

command -v gh >/dev/null || { echo "gh CLI required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh not authenticated" >&2; exit 1; }

declare -A SHA_CACHE

resolve_sha() {
  local owner_repo="$1" ref="$2" key sha obj_type obj_sha
  key="${owner_repo}@${ref}"
  if [[ -n "${SHA_CACHE[$key]:-}" ]]; then
    echo "${SHA_CACHE[$key]}"
    return 0
  fi
  # Try tag first.
  local json
  json=$(gh api "repos/${owner_repo}/git/refs/tags/${ref}" 2>/dev/null) || \
    json=$(gh api "repos/${owner_repo}/git/refs/heads/${ref}" 2>/dev/null) || {
      echo ""
      return 1
    }
  obj_type=$(printf '%s' "$json" | python3 -c "import sys,json;print(json.load(sys.stdin)['object']['type'])")
  obj_sha=$(printf '%s' "$json" | python3 -c "import sys,json;print(json.load(sys.stdin)['object']['sha'])")
  if [[ "$obj_type" == "tag" ]]; then
    # Annotated tag — dereference to commit.
    sha=$(gh api "repos/${owner_repo}/git/tags/${obj_sha}" 2>/dev/null \
      | python3 -c "import sys,json;print(json.load(sys.stdin)['object']['sha'])")
  else
    sha="$obj_sha"
  fi
  SHA_CACHE[$key]="$sha"
  echo "$sha"
}

process_file() {
  local f="$1"
  local tmp
  tmp=$(mktemp)
  local changed=0
  while IFS= read -r line; do
    # Match: optional indent + `- uses: ` or `  uses: ` + owner/repo@ref
    if [[ "$line" =~ ^([[:space:]]*-?[[:space:]]*uses:[[:space:]]+)([^/[:space:]@]+/[^@[:space:]]+)@([^[:space:]#]+)(.*)$ ]]; then
      local prefix="${BASH_REMATCH[1]}"
      local owner_repo="${BASH_REMATCH[2]}"
      local ref="${BASH_REMATCH[3]}"
      local rest="${BASH_REMATCH[4]}"
      # Skip local actions / reusable workflows.
      if [[ "$owner_repo" == .* || "$owner_repo" == docker:* ]]; then
        echo "$line" >> "$tmp"; continue
      fi
      # Already a 40-char SHA?
      if [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then
        echo "$line" >> "$tmp"; continue
      fi
      local sha
      sha=$(resolve_sha "$owner_repo" "$ref" || true)
      if [[ -z "$sha" ]]; then
        echo "  ! could not resolve ${owner_repo}@${ref}" >&2
        echo "$line" >> "$tmp"; continue
      fi
      local new_line="${prefix}${owner_repo}@${sha}  # ${ref}"
      if [[ -n "$rest" ]] && [[ ! "$rest" =~ ^[[:space:]]*$ ]]; then
        new_line="${new_line}${rest}"
      fi
      echo "$new_line" >> "$tmp"
      changed=1
      echo "  ${owner_repo}@${ref} -> ${sha:0:12}"
    else
      echo "$line" >> "$tmp"
    fi
  done < "$f"

  if [[ $changed -eq 1 ]]; then
    if [[ "$MODE" == "apply" ]]; then
      mv "$tmp" "$f"
    else
      rm -f "$tmp"
    fi
    return 0
  fi
  rm -f "$tmp"
  return 1
}

echo "Mode: $MODE (use --apply to rewrite files)"
for f in "${TARGETS[@]}"; do
  [[ -f "$f" ]] || continue
  echo "==> $f"
  process_file "$f" || true
done
