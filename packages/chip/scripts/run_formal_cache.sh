#!/usr/bin/env sh
# Formal property runner for the cache hierarchy. Wraps SymbiYosys (sby).
# Falls back to STATUS: BLOCKED when sby is not installed, matching the
# repository's fail-closed evidence-gate contract.
set -eu

REPO_ROOT="$(CDPATH=; cd -- "$(dirname "$0")/.." && pwd)"
FORMAL_DIR="$REPO_ROOT/verify/formal/cache"
REPORT_DIR="$REPO_ROOT/build/reports/formal/cache"

if [ -d "$REPO_ROOT/external/oss-cad-suite/bin" ]; then
    PATH="$REPO_ROOT/external/oss-cad-suite/bin:$PATH"
fi

if ! command -v sby >/dev/null 2>&1; then
    cat <<EOF
STATUS: BLOCKED cache.formal - SymbiYosys (sby) is not installed.
Install via oss-cad-suite or pip, or use the chip-package Nix/Docker shell.
EOF
    mkdir -p "$REPORT_DIR"
    cat >"$REPORT_DIR/cache-formal-status.yaml" <<EOF
schema: eliza.cache_formal_status.v1
status: BLOCKED
reason: "sby (SymbiYosys) missing from PATH"
remediation: "install SymbiYosys; re-run make formal-cache"
EOF
    if [ "${REQUIRE_FORMAL:-0}" = "1" ]; then
        exit 2
    fi
    exit 0
fi

mkdir -p "$REPORT_DIR"
cd "$FORMAL_DIR"

# Run the canonical cache coherence formal task. Pass through additional sby
# args via FORMAL_EXTRA if needed.
# shellcheck disable=SC2086
sby -f ${FORMAL_EXTRA:-} e1_cache_coherence.sby

# Mirror the workdir into the report area for downstream gates.
if [ -d e1_cache_coherence ]; then
    cp -r e1_cache_coherence "$REPORT_DIR/e1_cache_coherence" 2>/dev/null || true
fi

cat >"$REPORT_DIR/cache-formal-status.yaml" <<EOF
schema: eliza.cache_formal_status.v1
status: pass
properties:
  - P1_swmr
  - P2_no_dirty_shared
  - P3_probe_liveness
  - P4_tlc_progress
  - P_reset
EOF
echo "cache formal completed"
