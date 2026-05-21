#!/usr/bin/env bash
# verify-patches.sh
#
# Verifies the integrity of patches/ against patches/CHECKSUMS.sha256.
# Any patch change requires the CHECKSUMS file to be regenerated and reviewed
# as part of the same PR (enforced via CI). SOC2 CC6.8 / CC8.1.
#
# Usage:
#   scripts/security/verify-patches.sh             # verify
#   scripts/security/verify-patches.sh --generate  # regenerate CHECKSUMS
#
# Exit codes:
#   0  all checksums match
#   1  mismatch or missing patches
#   2  CHECKSUMS file missing

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
PATCHES_DIR="${REPO_ROOT}/patches"
CHECKSUMS="${PATCHES_DIR}/CHECKSUMS.sha256"

if [[ ! -d "$PATCHES_DIR" ]]; then
  echo "no patches/ directory at ${PATCHES_DIR}; nothing to verify"
  exit 0
fi

# Pick a sha256 tool. macOS has shasum, Linux has sha256sum.
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
  SHA_CHECK="sha256sum --check --strict"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
  SHA_CHECK="shasum -a 256 --check --strict"
else
  echo "error: neither sha256sum nor shasum found" >&2
  exit 1
fi

generate() {
  ( cd "$PATCHES_DIR" && \
    find . -type f \( -name '*.patch' -o -name '*.diff' \) ! -name 'CHECKSUMS.sha256' \
      -print0 | sort -z | xargs -0 $SHA_CMD ) > "$CHECKSUMS"
  echo "wrote $(wc -l < "$CHECKSUMS") entries to $CHECKSUMS"
}

verify() {
  if [[ ! -f "$CHECKSUMS" ]]; then
    echo "error: $CHECKSUMS missing. Run with --generate to create the baseline." >&2
    exit 2
  fi
  # Reject any patch on disk not listed in CHECKSUMS.
  local known_count actual_count
  known_count=$(grep -cE '\.(patch|diff)$' "$CHECKSUMS" 2>/dev/null || true)
  known_count=${known_count:-0}
  actual_count=$(find "$PATCHES_DIR" -type f \( -name '*.patch' -o -name '*.diff' \) | wc -l | tr -d ' ')
  if [[ "$known_count" -ne "$actual_count" ]]; then
    echo "error: patch count mismatch — CHECKSUMS lists $known_count files, disk has $actual_count" >&2
    echo "Run with --generate after reviewing the change." >&2
    exit 1
  fi
  ( cd "$PATCHES_DIR" && $SHA_CHECK CHECKSUMS.sha256 ) >/dev/null
  echo "patches/: all $known_count checksums verified"
}

case "${1:-verify}" in
  --generate|-g) generate ;;
  --verify|verify|"") verify ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  *) echo "unknown arg: $1" >&2; exit 2 ;;
esac
