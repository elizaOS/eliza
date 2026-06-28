#!/usr/bin/env bash
# BOLT post-link optimization.
#
# Steps:
#   1. Instrument the binary with `llvm-bolt --instrument`.
#   2. Run a workload on the instrumented binary.
#   3. Convert the trace to a BOLT profile.
#   4. Optimize: `--reorder-blocks=ext-tsp --reorder-functions=hfsort+
#                  --split-functions --split-all-cold`.
#
# Usage:
#   compiler/bolt-harness/optimize.sh \
#       --binary <input-elf> \
#       --workload <runner-script> \
#       --output <output-elf>
set -euo pipefail

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$repo_dir"

binary=""
workload=""
output=""
profile=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --binary) binary="$2"; shift 2 ;;
        --workload) workload="$2"; shift 2 ;;
        --output) output="$2"; shift 2 ;;
        --profile) profile="$2"; shift 2 ;;
        -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

emit_status() { printf 'STATUS: %s %s\n' "$1" "$2"; }

BOLT="${BOLT:-build/llvm-stage2/bin/llvm-bolt}"
if [ ! -x "$BOLT" ]; then
    emit_status "BLOCKED" "bolt.binary_missing"
    echo "optimize: $BOLT not built; run scripts/build_llvm_riscv.sh first" >&2
    exit 2
fi

if [ -z "$binary" ] || [ -z "$output" ]; then
    emit_status "FAIL" "bolt.usage"
    exit 2
fi

if [ -n "$workload" ] && [ -z "$profile" ]; then
    instrumented="$(mktemp -t bolt-XXXXXX.inst)"
    trap 'rm -f "$instrumented"' EXIT
    "$BOLT" --instrument --instrumentation-file-append-pid \
        "$binary" -o "$instrumented"
    "$workload" "$instrumented"
    profile="$(find /tmp -maxdepth 1 -name 'prof.fdata*' -type f -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk 'NR == 1 {print $2}')"
    if [ -z "$profile" ]; then
        emit_status "FAIL" "bolt.profile_missing"
        echo "optimize: instrumented run produced no /tmp/prof.fdata*" >&2
        exit 1
    fi
fi

if [ -z "$profile" ] || [ ! -f "$profile" ]; then
    emit_status "FAIL" "bolt.profile_missing"
    exit 1
fi

"$BOLT" "$binary" \
    --data "$profile" \
    --reorder-blocks=ext-tsp \
    --reorder-functions=hfsort+ \
    --split-functions \
    --split-all-cold \
    --use-gnu-stack \
    --dyno-stats \
    -o "$output"

emit_status "PASS" "bolt.optimize"
