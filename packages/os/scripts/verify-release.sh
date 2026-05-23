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
fail() { printf '\033[1;31m[XX]\033[0m %s\n' "$*"; }

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

# grep -c returns exit 1 when there are 0 matching lines; || true prevents
# set -e from aborting if SHA256SUMS contains only comment lines.
entry_count=$(grep -cE '^[a-f0-9]{64}' SHA256SUMS || true)

if $SHA256CMD -c SHA256SUMS --ignore-missing --quiet; then
  ok "SHA256SUMS roundtrip verified (${entry_count} entries)"
else
  fail "SHA256SUMS roundtrip FAILED — re-download required"
  exit 1
fi

# ---- 2. GitHub attestations ------------------------------------------------
if command -v gh >/dev/null 2>&1; then
  note "Checking GitHub artifact attestations (gh attestation verify)"
  attest_pass=0
  attest_fail=0
  while IFS= read -r line; do
    case "$line" in '' | '#'*) continue ;; esac
    file=$(printf '%s\n' "$line" | awk '{print $2}' | sed 's|^\*||')
    [ -z "$file" ] && continue
    [ -f "$file" ] || continue
    if gh attestation verify "$file" --owner elizaOS >/dev/null 2>&1; then
      ok "attestation valid: $file"
      attest_pass=$((attest_pass + 1))
    else
      fail "attestation NOT verified: $file"
      attest_fail=$((attest_fail + 1))
    fi
  done < SHA256SUMS
  note "attestations: ${attest_pass} valid, ${attest_fail} not verified"
  # Classification:
  #   pass>0, fail>0  : mixed — likely tampering or pipeline issue. Exit 2.
  #   pass=0, fail>0  : either pre-attestation release OR full-on tampering.
  #                     Cannot distinguish from this client. Warn, do not
  #                     exit 2, so users get the rest of the report.
  #   pass>0, fail=0  : clean.
  if [ "$attest_pass" -gt 0 ] && [ "$attest_fail" -gt 0 ]; then
    fail "mixed attestation results — some valid, some not. Investigate."
    EXIT=2
  elif [ "$attest_pass" -eq 0 ] && [ "$attest_fail" -gt 0 ]; then
    warn "no artifact attestations verified. Expected for releases predating attestation rollout; treat as untrusted otherwise."
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
