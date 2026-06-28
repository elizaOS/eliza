#!/usr/bin/env bash
# AutoFDO end-to-end roundtrip on CoreMark.
#
# Steps:
#   1. Cross-build CoreMark (rv64gc baseline) with the pinned LLVM clang and
#      -fbasic-block-sections=labels so AutoFDO can rebind by basic block.
#   2. Run perf record under qemu-user (or hardware DUT) to capture a sample
#      profile.
#   3. Convert with llvm-profgen.
#   4. Rebuild CoreMark with -fprofile-sample-use=<profile>.
#   5. Measure CoreMark/MHz delta between the two builds and write
#      build/reports/compiler/coremark-autofdo-delta.json.
#
# Status terms: PASS / BLOCKED / FAIL on `autofdo.coremark.<stage>`.
#
# This script fails closed if any of:
#   - build/llvm-stage2/bin/clang is missing
#   - external/coremark/ is missing (per benchmarks/cpu/coremark/manifest.json)
#   - qemu-user-riscv64 is missing
#   - perf is missing inside the canonical container
#
# It produces no fake "PASS" lines under any failure.
set -euo pipefail

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$repo_dir"

emit_status() { printf 'STATUS: %s %s\n' "$1" "$2"; }

CLANG="${CLANG:-build/llvm-stage2/bin/clang}"
LLVM_PROFGEN="${LLVM_PROFGEN:-build/llvm-stage2/bin/llvm-profgen}"
QEMU="${QEMU:-qemu-riscv64}"
OUTPUT_DIR="${AUTOFDO_COREMARK_OUTPUT_DIR:-build/reports/compiler/coremark-autofdo}"
COREMARK_DIR="${COREMARK_DIR:-external/coremark}"

if [ ! -x "$CLANG" ]; then
    emit_status "BLOCKED" "autofdo.coremark.clang_missing"
    echo "$CLANG not built; run scripts/build_llvm_riscv.sh first" >&2
    exit 2
fi

if [ ! -d "$COREMARK_DIR" ]; then
    emit_status "BLOCKED" "autofdo.coremark.source_missing"
    echo "expected CoreMark checkout at $COREMARK_DIR per benchmarks/cpu/coremark/manifest.json" >&2
    exit 2
fi

if ! command -v "$QEMU" >/dev/null 2>&1; then
    emit_status "BLOCKED" "autofdo.coremark.qemu_missing"
    echo "qemu-user-riscv64 is required for the workload capture step" >&2
    exit 2
fi

if ! command -v perf >/dev/null 2>&1; then
    emit_status "BLOCKED" "autofdo.coremark.perf_missing"
    echo "perf record is required for AutoFDO capture" >&2
    exit 2
fi

if [ ! -x "$LLVM_PROFGEN" ] && ! command -v llvm-profgen >/dev/null 2>&1; then
    emit_status "BLOCKED" "autofdo.coremark.profgen_missing"
    echo "llvm-profgen not found at $LLVM_PROFGEN or on PATH" >&2
    exit 2
fi

mkdir -p "$OUTPUT_DIR"

# Common flags for both builds. -fbasic-block-sections=labels is required so
# the sample profile carries enough symbol granularity for llvm-profgen.
COMMON_FLAGS=(
    --target=riscv64-unknown-linux-gnu
    -march=rva23u64
    -mcpu=eliza-e1
    -mtune=eliza-e1
    -O3
    -flto=thin
    -fvectorize
    -fbasic-block-sections=labels
    -fcf-protection=full
    -fstack-clash-protection
    -fstack-protector-strong
)

build_coremark() {
    local label="$1"; shift
    local extra_flags=("$@")
    local out="$OUTPUT_DIR/coremark-${label}.elf"
    "$CLANG" "${COMMON_FLAGS[@]}" "${extra_flags[@]}" \
        -I "$COREMARK_DIR" \
        "$COREMARK_DIR"/core_*.c \
        "$COREMARK_DIR"/posix/core_portme.c \
        -o "$out"
    echo "$out"
}

emit_status "PASS" "autofdo.coremark.environment_check"

BASE_ELF="$(build_coremark "stage0")"
emit_status "PASS" "autofdo.coremark.stage0_built"

# Capture perf data under qemu-user.
PERF_DATA="$OUTPUT_DIR/coremark.perf.data"
perf record \
    --output "$PERF_DATA" \
    --event cycles:u \
    --call-graph fp \
    --freq 999 \
    --timeout 15000 \
    -- "$QEMU" "$BASE_ELF" 0x0 0x0 0x66 0 7 1 2000
emit_status "PASS" "autofdo.coremark.perf_captured"

PROFILE="$OUTPUT_DIR/coremark.prof"
if [ -x "$LLVM_PROFGEN" ]; then
    "$LLVM_PROFGEN" --binary "$BASE_ELF" --perfdata "$PERF_DATA" --output "$PROFILE" --sample-period 1000
else
    llvm-profgen --binary "$BASE_ELF" --perfdata "$PERF_DATA" --output "$PROFILE" --sample-period 1000
fi
emit_status "PASS" "autofdo.coremark.profile_generated"

PGO_ELF="$(build_coremark "stage1-autofdo" -fprofile-sample-use="$PROFILE")"
emit_status "PASS" "autofdo.coremark.stage1_built"

# Measure both binaries under qemu-user. CoreMark reports its own iterations/sec.
measure_elf() {
    local elf="$1"
    local label="$2"
    local log="$OUTPUT_DIR/coremark-${label}.log"
    "$QEMU" "$elf" 0x0 0x0 0x66 0 7 1 2000 > "$log" 2>&1
    grep -E "Iterations/Sec" "$log" | head -n 1 | awk '{print $NF}'
}

BASELINE_SCORE="$(measure_elf "$BASE_ELF" "stage0")"
PGO_SCORE="$(measure_elf "$PGO_ELF" "stage1-autofdo")"

DELTA_JSON="$OUTPUT_DIR/coremark-autofdo-delta.json"
python3 - <<PY > "$DELTA_JSON"
import json, sys
baseline = float("${BASELINE_SCORE:-0}" or 0)
pgo = float("${PGO_SCORE:-0}" or 0)
ratio = (pgo / baseline) if baseline > 0 else None
out = {
    "schema": "eliza.autofdo_coremark_delta.v1",
    "baseline_iter_per_sec": baseline,
    "pgo_iter_per_sec": pgo,
    "pgo_over_baseline_ratio": ratio,
    "pgo_uplift_pct": (None if ratio is None else (ratio - 1.0) * 100.0),
}
print(json.dumps(out, indent=2, sort_keys=True))
PY
emit_status "PASS" "autofdo.coremark.delta_written"
