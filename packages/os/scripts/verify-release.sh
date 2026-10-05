#!/usr/bin/env bash
# elizaOS release verification helper.
#
# Walks the layered trust stack that the OS release pipeline ships:
#
#   1. SHA256SUMS roundtrip            (required; uses sha256sum or shasum -a 256)
#   2. GitHub artifact attestations    (optional; uses gh CLI)
#   3. GPG signature on SHA256SUMS     (optional; uses gpg)
#   4. SBOM summary                    (optional; uses jq)
#
# Each optional layer is skipped with a notice if its tool is missing —
# the script is useful even with only coreutils installed. Every layer
# runs to completion so the user sees the full picture before the
# script exits.
#
# Usage:
#   verify-release.sh [DIR]
#     DIR  Directory containing downloaded release artifacts + SHA256SUMS.
#          Defaults to the current directory.
#
# Exit codes:
#   0  every required check passed (optional layers may have been
#      skipped or warned)
#   1  SHA256SUMS missing or roundtrip failed
#   2  an optional layer detected real corruption / tampering
#      (e.g. a mix of valid and invalid attestations, or a bad GPG
#      signature). Pure-absence does NOT trigger exit 2.
set -euo pipefail

DIR="${1:-.}"
cd "$DIR" || { echo "ERROR: cannot enter $DIR" >&2; exit 1; }

note() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[--]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[XX]\033[0m %s\n' "$*" >&2; }

EXIT=0

# ---- 1. SHA256SUMS ---------------------------------------------------------
note "Checking SHA256SUMS"
if [ ! -f SHA256SUMS ]; then
  fail "SHA256SUMS not found in $(pwd)"
  exit 1
fi

# sha256sum is Linux coreutils; fall back to shasum -a 256 on macOS.
SHA256CMD=sha256sum
if ! command -v sha256sum >/dev/null 2>&1; then
  if command -v shasum >/dev/null 2>&1; then
    SHA256CMD="shasum -a 256"
  else
    fail "neither sha256sum nor shasum found; cannot verify checksums"
    exit 1
  fi
fi

entries=()
while read -r checksum filename extra; do
  case "$checksum" in ''|'#'*) continue ;; esac
  filename="${filename#\*}"
  if [[ ! "$checksum" =~ ^[a-f0-9]{64}$ ]] || [ -z "$filename" ] || [ -n "${extra:-}" ]; then
    fail "malformed SHA256SUMS entry"
    exit 1
  fi
  if [ "$(basename "$filename")" != "$filename" ] || [ -L "$filename" ] || [ ! -f "$filename" ] || [ ! -s "$filename" ]; then
    fail "required checksum payload is missing, empty, unsafe, or not a regular file: $filename"
    exit 1
  fi
  if [ "${#entries[@]}" -gt 0 ]; then
    for existing in "${entries[@]}"; do
      if [ "$existing" = "$filename" ]; then
        fail "duplicate SHA256SUMS entry: $filename"
        exit 1
      fi
    done
  fi
  entries+=("$filename")
done < SHA256SUMS

entry_count=${#entries[@]}
if [ "$entry_count" -eq 0 ]; then
  fail "SHA256SUMS contains no artifact entries"
  exit 1
fi

if [ "$SHA256CMD" = sha256sum ]; then
  checksum_ok=0
  sha256sum --check --strict SHA256SUMS || checksum_ok=$?
else
  checksum_ok=0
  shasum -a 256 --check SHA256SUMS || checksum_ok=$?
fi
if [ "$checksum_ok" -eq 0 ]; then
  ok "SHA256SUMS roundtrip verified (${entry_count} entries)"
else
  fail "SHA256SUMS roundtrip FAILED — re-download required"
  exit 1
fi

# ---- 2. GitHub attestations ------------------------------------------------
if [ "${ELIZAOS_VERIFY_ATTESTATIONS:-auto}" = skip ]; then
  warn "skipping GitHub attestation verification by explicit request"
elif command -v gh >/dev/null 2>&1; then
  note "Checking GitHub artifact attestations (gh attestation verify)"
  attest_pass=0
  attest_fail=0
  attestation_files=("${entries[@]}" SHA256SUMS)
  shopt -s nullglob
  attestation_files+=(elizaos-os-*-manifest.json)
  shopt -u nullglob
  for file in "${attestation_files[@]}"; do
    if gh attestation verify "$file" --owner elizaOS >/dev/null 2>&1; then
      ok "attestation valid: $file"
      attest_pass=$((attest_pass + 1))
    else
      fail "attestation NOT verified: $file"
      attest_fail=$((attest_fail + 1))
    fi
  done
  note "attestations: ${attest_pass} valid, ${attest_fail} not verified"
  if [ "$attest_fail" -gt 0 ]; then
    fail "one or more required release attestations did not verify"
    EXIT=2
  fi
else
  warn "skipping GitHub attestation verification (gh CLI not installed)"
fi

# ---- 3. GPG signature on SHA256SUMS ---------------------------------------
SIG=""
if [ -f SHA256SUMS.asc ]; then
  SIG=SHA256SUMS.asc
elif [ -f SHA256SUMS.sig ]; then
  SIG=SHA256SUMS.sig
fi
if [ -n "$SIG" ]; then
  if command -v gpg >/dev/null 2>&1; then
    note "Checking GPG signature on SHA256SUMS"
    if gpg --verify "$SIG" SHA256SUMS 2>&1 | grep -q "Good signature"; then
      ok "GPG signature verified"
    else
      fail "GPG signature FAILED — output:"
      gpg --verify "$SIG" SHA256SUMS 2>&1 | sed 's/^/    /'
      EXIT=2
    fi
  else
    warn "${SIG} present but gpg is not installed; skipping"
  fi
else
  warn "no SHA256SUMS.asc or .sig found; skipping GPG verification (release may not be GPG-signed yet)"
fi

# ---- 4. SBOM summary -------------------------------------------------------
shopt -s nullglob
sboms=( *.spdx.json )
shopt -u nullglob
if [ "${#sboms[@]}" -gt 0 ]; then
  if command -v jq >/dev/null 2>&1; then
    note "SBOM summary (jq)"
    for sbom in "${sboms[@]}"; do
      count=$(jq '.packages | length' "$sbom" 2>/dev/null || echo "?")
      ok "${sbom}: ${count} packages"
    done
  else
    warn "${#sboms[@]} SBOM file(s) found but jq is not installed; skipping package count"
  fi
else
  warn "no .spdx.json SBOM found in $(pwd); skipping SBOM summary"
fi

note "Verification complete."
exit "$EXIT"
