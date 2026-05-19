#!/usr/bin/env bash
# Build LLVM trunk for the e1 RISC-V Android target inside the canonical Linux container.
#
# This script encodes the pinned recipe in compiler/llvm-build/llvm-pin.json. It is
# canonical only when executed inside the e1-chip Linux container (per
# packages/chip/Dockerfile). On macOS arm64 host it fails closed with BLOCKED;
# release evidence must come from the container build.
#
# Outputs (all relative to repo root):
#   build/llvm-stage1/                          stage-1 host-bootstrap clang+lld
#   build/llvm-stage2/                          stage-2 RISC-V cross-targeted clang
#   build/reports/compiler/llvm-version.txt     clang --version (stage 2)
#   build/reports/compiler/llvm-build-sha.txt   resolved LLVM commit SHA
#   build/reports/compiler/llvm-hello-rva23.elf hello-world RVA23 cross-compile artifact
#   build/reports/compiler/llvm-hello-rva23.dump objdump of the cross-compile artifact
#
# Status terms (printed as `STATUS: <status> llvm.<stage>`):
#   PASS    stage completed and produced artifact
#   BLOCKED stage skipped because external dependency is absent
#   FAIL    stage executed and a check inside it failed
set -euo pipefail

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$repo_dir"

PIN_FILE="compiler/llvm-build/llvm-pin.json"
BUILD_REPORT_DIR="build/reports/compiler"
STAGE1_DIR="build/llvm-stage1"
STAGE2_DIR="build/llvm-stage2"
SRC_DIR="external/llvm-project"

mkdir -p "$BUILD_REPORT_DIR"

emit_status() {
    printf 'STATUS: %s %s\n' "$1" "$2"
}

require_linux_container() {
    if [ "$(uname -s)" != "Linux" ]; then
        emit_status "BLOCKED" "llvm.environment_check"
        echo "build_llvm_riscv: host is $(uname -s); LLVM build requires Linux container per docs/toolchain/llvm-trunk-pin.md" >&2
        exit 2
    fi
    if [ "$(uname -m)" != "x86_64" ] && [ "$(uname -m)" != "aarch64" ]; then
        emit_status "BLOCKED" "llvm.environment_check"
        echo "build_llvm_riscv: arch $(uname -m) not supported for canonical build" >&2
        exit 2
    fi
    emit_status "PASS" "llvm.environment_check"
}

require_tool() {
    local tool="$1"
    if ! command -v "$tool" >/dev/null 2>&1; then
        emit_status "BLOCKED" "llvm.tool_check[$tool]"
        echo "build_llvm_riscv: required tool $tool missing" >&2
        exit 2
    fi
}

verify_only=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --verify)
            verify_only=1
            ;;
        -h|--help)
            sed -n '2,32p' "$0"
            exit 0
            ;;
        *)
            echo "unknown argument: $1" >&2
            exit 2
            ;;
    esac
    shift
done

if [ "$verify_only" = "1" ]; then
    if [ ! -x "$STAGE2_DIR/bin/clang" ]; then
        emit_status "BLOCKED" "llvm.verify"
        echo "build_llvm_riscv --verify: stage-2 clang missing at $STAGE2_DIR/bin/clang" >&2
        exit 2
    fi
    "$STAGE2_DIR/bin/clang" --version | tee "$BUILD_REPORT_DIR/llvm-version.txt"
    emit_status "PASS" "llvm.verify"
    exit 0
fi

require_linux_container
require_tool cmake
require_tool ninja
require_tool git
require_tool python3
require_tool jq
require_tool clang || require_tool gcc

LLVM_SHA="$(jq -r '.upstream.commit_sha' "$PIN_FILE")"
LLVM_URL="$(jq -r '.upstream.url' "$PIN_FILE")"

if [ -z "$LLVM_SHA" ] || [ "$LLVM_SHA" = "null" ]; then
    emit_status "BLOCKED" "llvm.pin_sha"
    echo "build_llvm_riscv: LLVM SHA missing in $PIN_FILE; refresh per docs/toolchain/llvm-trunk-pin.md" >&2
    exit 2
fi
if ! printf '%s' "$LLVM_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
    emit_status "BLOCKED" "llvm.pin_sha_format"
    echo "build_llvm_riscv: LLVM SHA '$LLVM_SHA' is not a 40-character hex string" >&2
    exit 2
fi

if [ ! -d "$SRC_DIR/.git" ]; then
    emit_status "BLOCKED" "llvm.clone"
    echo "build_llvm_riscv: clone $LLVM_URL into $SRC_DIR (out of band; not committed)" >&2
    exit 2
fi

git -C "$SRC_DIR" fetch --depth 1 origin "$LLVM_SHA"
git -C "$SRC_DIR" checkout --detach "$LLVM_SHA"

mapfile -t STAGE1_ARGS < <(jq -r '.cmake.stage1_args[]' "$PIN_FILE")
mapfile -t STAGE2_ARGS < <(jq -r '.cmake.stage2_args[]' "$PIN_FILE")

mkdir -p "$STAGE1_DIR" "$STAGE2_DIR"

cmake -G "Ninja" \
    -S "$SRC_DIR/llvm" \
    -B "$STAGE1_DIR" \
    "${STAGE1_ARGS[@]}"
ninja -C "$STAGE1_DIR"

STAGE1_CLANG="$repo_dir/$STAGE1_DIR/bin/clang"
STAGE1_CLANGXX="$repo_dir/$STAGE1_DIR/bin/clang++"

if [ ! -x "$STAGE1_CLANG" ]; then
    emit_status "FAIL" "llvm.stage1"
    exit 1
fi
emit_status "PASS" "llvm.stage1"

cmake -G "Ninja" \
    -S "$SRC_DIR/llvm" \
    -B "$STAGE2_DIR" \
    -DCMAKE_C_COMPILER="$STAGE1_CLANG" \
    -DCMAKE_CXX_COMPILER="$STAGE1_CLANGXX" \
    "${STAGE2_ARGS[@]}"
ninja -C "$STAGE2_DIR"

STAGE2_CLANG="$repo_dir/$STAGE2_DIR/bin/clang"
if [ ! -x "$STAGE2_CLANG" ]; then
    emit_status "FAIL" "llvm.stage2"
    exit 1
fi
emit_status "PASS" "llvm.stage2"

"$STAGE2_CLANG" --version | tee "$BUILD_REPORT_DIR/llvm-version.txt"
git -C "$SRC_DIR" rev-parse HEAD | tee "$BUILD_REPORT_DIR/llvm-build-sha.txt"

cat > "$BUILD_REPORT_DIR/hello-rva23.c" <<'C'
#include <stdint.h>
int32_t hello(int32_t a, int32_t b) { return a + b; }
int main(void) { return hello(2, 3) - 5; }
C

"$STAGE2_CLANG" \
    --target=riscv64-unknown-linux-gnu \
    -march=rva23u64 -mcpu=eliza-e1 -mtune=eliza-e1 \
    -O3 -flto=thin \
    -fcf-protection=full -fstack-clash-protection -fstack-protector-strong \
    -c "$BUILD_REPORT_DIR/hello-rva23.c" \
    -o "$BUILD_REPORT_DIR/llvm-hello-rva23.o"

"$repo_dir/$STAGE2_DIR/bin/llvm-objdump" -d --mattr=+v "$BUILD_REPORT_DIR/llvm-hello-rva23.o" \
    > "$BUILD_REPORT_DIR/llvm-hello-rva23.dump"

emit_status "PASS" "llvm.cross_compile_smoke"

# Capture the stage-2 clang's reported RVA23 extension list so
# scripts/check_rva23_compliance.py --toolchain build/llvm-stage2 has a
# deterministic input even when the binary is not available later.
"$STAGE2_CLANG" --print-supported-extensions \
    > "$BUILD_REPORT_DIR/llvm-rva23-extensions.txt" 2>&1

emit_status "PASS" "llvm.rva23_extensions_dump"
