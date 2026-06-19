#!/usr/bin/env bash
# Capture an AutoFDO sample profile from a representative workload.
#
# Usage:
#   compiler/autofdo-harness/capture.sh \
#       --binary <path-to-target-binary> \
#       --workload <path-to-runner-script> \
#       --duration <seconds> \
#       --output <path-to-output.prof>
#
# Status terms: PASS / BLOCKED / FAIL on `autofdo.<stage>`.
set -euo pipefail

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$repo_dir"

binary=""
workload=""
duration=30
output=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --binary) binary="$2"; shift 2 ;;
        --workload) workload="$2"; shift 2 ;;
        --duration) duration="$2"; shift 2 ;;
        --output) output="$2"; shift 2 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ -z "$binary" ] || [ -z "$workload" ] || [ -z "$output" ]; then
    echo "STATUS: FAIL autofdo.usage" >&2
    sed -n '2,12p' "$0" >&2
    exit 2
fi

emit_status() { printf 'STATUS: %s %s\n' "$1" "$2"; }

if ! command -v perf >/dev/null 2>&1; then
    emit_status "BLOCKED" "autofdo.perf_missing"
    echo "capture: perf not installed; AutoFDO requires perf record with LBR or BB stacks" >&2
    exit 2
fi

if ! command -v create_llvm_prof >/dev/null 2>&1 \
        && ! command -v llvm-profgen >/dev/null 2>&1; then
    emit_status "BLOCKED" "autofdo.converter_missing"
    echo "capture: install create_llvm_prof (google/autofdo) or llvm-profgen (LLVM>=17)" >&2
    exit 2
fi

emit_status "PASS" "autofdo.environment_check"

perf_data="$(mktemp -t autofdo-XXXXXX.perf.data)"
trap 'rm -f "$perf_data"' EXIT

# Record branches. On RISC-V, the kernel supports `-e br_inst_retired` etc.;
# fall back to PMU sample events if LBR-like sampling is not available.
perf record \
    --output "$perf_data" \
    --event cycles:u \
    --call-graph fp \
    --freq 999 \
    --timeout "$((duration * 1000))" \
    -- "$workload" "$binary"

if command -v llvm-profgen >/dev/null 2>&1; then
    llvm-profgen \
        --binary "$binary" \
        --perfdata "$perf_data" \
        --output "$output" \
        --sample-period 1000
else
    create_llvm_prof \
        --binary "$binary" \
        --profile "$perf_data" \
        --out "$output"
fi

emit_status "PASS" "autofdo.profile_generated"
