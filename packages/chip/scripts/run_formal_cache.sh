#!/usr/bin/env sh
# Formal property runner for the cache coherence layer. Wraps SymbiYosys (sby).
#
# What it proves: the SWMR (single-writer / multiple-reader) coherence invariant
# over the REAL MESI directory RTL (rtl/cache/coherence/e1_coherence_dir.sv).
# e1_cache_coherence.sby instantiates the directory with two cores, leaves every
# request/probe/grant channel free for the BMC engine, and binds the SWMR
# property pack onto the directory's authoritative coherence record
# (dir_state_q / dir_sharers_q). The proof therefore shows the protocol itself
# maintains SWMR; it does not assume it. e1_cache_coherence_cover.sby is the
# non-vacuity companion: it proves the directory can actually reach the writable
# (M, E) and two-way-shared states the SWMR asserts guard.
#
# Fail-closed contract:
#   * SymbiYosys (sby) is REQUIRED; BLOCKED when missing.
#   * The directory declares `module e1_coherence_dir import e1_cache_pkg::*;`,
#     which the stock yosys Verilog frontend cannot parse, so the proof reads
#     the RTL through the yosys-slang frontend. slang ships with the
#     oss-cad-suite yosys that sby drives; BLOCKED when it cannot be loaded.
set -eu

REPO_ROOT="$(CDPATH=; cd -- "$(dirname "$0")/.." && pwd)"
FORMAL_DIR="$REPO_ROOT/verify/formal/cache"
REPORT_DIR="$REPO_ROOT/build/reports/formal/cache"

if [ -d "$REPO_ROOT/external/oss-cad-suite/bin" ]; then
    PATH="$REPO_ROOT/external/oss-cad-suite/bin:$PATH"
fi

mkdir -p "$REPORT_DIR"

write_blocked() {
    reason="$1"
    remediation="$2"
    cat >"$REPORT_DIR/cache-formal-status.yaml" <<EOF
schema: eliza.cache_formal_status.v1
status: BLOCKED
reason: "$reason"
remediation: "$remediation"
EOF
}

if ! command -v sby >/dev/null 2>&1; then
    echo "STATUS: BLOCKED cache.formal - SymbiYosys (sby) is not installed."
    echo "Install via oss-cad-suite or add sby to PATH, then re-run make formal-cache."
    write_blocked "sby (SymbiYosys) missing from PATH" \
        "install SymbiYosys; re-run make formal-cache"
    [ "${REQUIRE_FORMAL:-0}" = "1" ] && exit 2
    exit 0
fi

# The yosys that sby drives must be able to load the slang frontend; otherwise
# it cannot parse the directory's package-import module header.
if ! { command -v yosys >/dev/null 2>&1 && yosys -p "plugin -i slang" -qq >/dev/null 2>&1; }; then
    echo "STATUS: BLOCKED cache.formal - the yosys-slang frontend could not be loaded."
    echo "The real directory uses 'module e1_coherence_dir import e1_cache_pkg::*;', which"
    echo "needs read_slang; slang ships with the oss-cad-suite yosys (share/yosys/plugins/"
    echo "slang.so). Install/repair oss-cad-suite so 'yosys -p \"plugin -i slang\"' succeeds,"
    echo "then re-run make formal-cache."
    write_blocked "yosys-slang frontend (slang.so) could not be loaded" \
        "install/repair oss-cad-suite so 'yosys -p \"plugin -i slang\"' succeeds; re-run make formal-cache"
    [ "${REQUIRE_FORMAL:-0}" = "1" ] && exit 2
    exit 0
fi

cd "$FORMAL_DIR"

# 1. SWMR BMC proof over the real directory RTL. 2. Non-vacuity cover. sby exits
# non-zero on FAIL; capture the result instead of letting `set -e` abort so the
# status file reflects what actually happened (pass vs fail), never an
# unconditional pass.
proof_rc=0
cover_rc=0
# shellcheck disable=SC2086
sby -f ${FORMAL_EXTRA:-} e1_cache_coherence.sby || proof_rc=$?
sby -f e1_cache_coherence_cover.sby || cover_rc=$?

# Mirror the workdirs into the report area for downstream gates.
for wd in e1_cache_coherence e1_cache_coherence_cover; do
    [ -d "$wd" ] && cp -r "$wd" "$REPORT_DIR/$wd" 2>/dev/null || true
done

# The sby status file holds "PASS|FAIL ..." (status keyword plus timing); take
# the leading keyword only.
proof_status="$(awk 'NR==1{print $1}' "$FORMAL_DIR/e1_cache_coherence/status" 2>/dev/null || echo unknown)"
cover_status="$(awk 'NR==1{print $1}' "$FORMAL_DIR/e1_cache_coherence_cover/status" 2>/dev/null || echo unknown)"
: "${proof_status:=unknown}"
: "${cover_status:=unknown}"

if [ "$proof_rc" = "0" ] && [ "$cover_rc" = "0" ] && \
   [ "$proof_status" = "PASS" ] && [ "$cover_status" = "PASS" ]; then
    overall="pass"
else
    overall="fail"
fi

cat >"$REPORT_DIR/cache-formal-status.yaml" <<EOF
schema: eliza.cache_formal_status.v1
status: $overall
claim_boundary: bounded_bmc_swmr_over_real_directory_rtl_not_full_coherence_signoff
proof_engine: symbiyosys_smtbmc
bmc_depth: 16
dut: rtl/cache/coherence/e1_coherence_dir.sv
harness: verify/formal/cache/e1_coherence_dir_formal.sv
property_pack: verify/formal/cache/e1_coherence_dir_swmr_props.sv
sby_proof_status: $proof_status
sby_cover_status: $cover_status
properties:
  - P1_swmr_writable_line_single_owner
  - P2_no_dirty_shared
  - P3_state_legal
  - P4_invalid_no_sharers
non_vacuity_covers:
  - dir_reaches_modified
  - dir_reaches_exclusive
  - dir_reaches_two_way_shared
EOF
echo "cache formal completed (status=$overall proof=$proof_status cover=$cover_status)"

if [ "$overall" != "pass" ]; then
    exit 1
fi
