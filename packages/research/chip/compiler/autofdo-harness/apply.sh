#!/usr/bin/env bash
# Apply an AutoFDO profile to a clang rebuild and emit BasicBlockSections
# for downstream Propeller.
#
# Usage:
#   compiler/autofdo-harness/apply.sh \
#       --profile <path-to-autofdo.prof> \
#       --source <c-or-cxx-source> \
#       --output <output-elf>
set -euo pipefail

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$repo_dir"

profile=""
source_file=""
output=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --profile) profile="$2"; shift 2 ;;
        --source) source_file="$2"; shift 2 ;;
        --output) output="$2"; shift 2 ;;
        -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

emit_status() { printf 'STATUS: %s %s\n' "$1" "$2"; }

if [ -z "$profile" ] || [ -z "$source_file" ] || [ -z "$output" ]; then
    emit_status "FAIL" "autofdo.apply.usage"
    exit 2
fi

CLANG="${CLANG:-build/llvm-stage2/bin/clang}"
if [ ! -x "$CLANG" ]; then
    emit_status "BLOCKED" "autofdo.apply.clang_missing"
    echo "apply: $CLANG not built; run scripts/build_llvm_riscv.sh first" >&2
    exit 2
fi
if [ ! -f "$profile" ]; then
    emit_status "FAIL" "autofdo.apply.profile_missing"
    exit 1
fi

"$CLANG" \
    --target=riscv64-unknown-linux-gnu \
    -march=rva23u64 -mcpu=eliza-e1 -mtune=eliza-e1 \
    -O3 -flto=thin -fvectorize \
    -fbasic-block-sections=labels \
    -fcf-protection=full -fstack-clash-protection -fstack-protector-strong \
    -fprofile-sample-use="$profile" \
    -c "$source_file" -o "$output"

emit_status "PASS" "autofdo.apply"
