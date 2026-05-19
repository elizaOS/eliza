#!/usr/bin/env bash
# Propeller relink: use AutoFDO + perf branch traces to reorder basic blocks
# and emit an optimized symbol order file consumed by lld.
#
# Steps:
#   1. Build with `-fbasic-block-sections=labels` (handled by autofdo apply).
#   2. Capture branch traces with perf.
#   3. `create_llvm_prof` derives a Propeller basic-block layout.
#   4. lld consumes `--symbol-ordering-file=...` plus `--no-keep-text-section-prefix`.
#
# This script wraps step 4. Steps 1-3 are handled by autofdo-harness.
#
# Usage:
#   compiler/propeller-harness/relink.sh \
#       --inputs <a.o> <b.o> ... \
#       --symbol-order <propeller-order.txt> \
#       --output <output-elf>
set -euo pipefail

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$repo_dir"

inputs=()
symbol_order=""
output=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --inputs) shift; while [ "$#" -gt 0 ] && [[ "$1" != --* ]]; do inputs+=("$1"); shift; done ;;
        --symbol-order) symbol_order="$2"; shift 2 ;;
        --output) output="$2"; shift 2 ;;
        -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

emit_status() { printf 'STATUS: %s %s\n' "$1" "$2"; }

LLD="${LLD:-build/llvm-stage2/bin/ld.lld}"
if [ ! -x "$LLD" ]; then
    emit_status "BLOCKED" "propeller.lld_missing"
    echo "relink: $LLD not built; run scripts/build_llvm_riscv.sh first" >&2
    exit 2
fi
if [ -z "$symbol_order" ] || [ ! -f "$symbol_order" ]; then
    emit_status "FAIL" "propeller.symbol_order_missing"
    exit 1
fi
if [ -z "$output" ] || [ "${#inputs[@]}" -eq 0 ]; then
    emit_status "FAIL" "propeller.usage"
    exit 2
fi

"$LLD" \
    --symbol-ordering-file="$symbol_order" \
    --no-keep-text-section-prefix \
    --reproduce="$output.reproduce.tar" \
    -o "$output" \
    "${inputs[@]}"

emit_status "PASS" "propeller.relink"
