#!/usr/bin/env bash
# Build the IREE compiler with the elizanpu backend enabled.
#
# Canonical environment: Linux container per docs/toolchain/iree-eliza-npu.md.
# Prerequisite: `scripts/build_llvm_riscv.sh` must have produced
# build/llvm-stage2/ with MLIR+LLVM cmake exports.
#
# Outputs (relative to repo root):
#   build/iree/                           IREE build tree
#   build/iree/install/                   installed iree-compile + iree-opt
#   build/reports/compiler/iree-version.txt
#   build/reports/compiler/elizanpu-opt-roundtrip.log
#
# Status terms (printed as `STATUS: <status> iree.<stage>`):
#   PASS BLOCKED FAIL
set -euo pipefail

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$repo_dir"

PIN_FILE="compiler/iree-eliza-npu/iree-pin.json"
SRC_DIR="external/iree"
BUILD_DIR="build/iree"
REPORT_DIR="build/reports/compiler"
STAGE2_DIR="build/llvm-stage2"

mkdir -p "$REPORT_DIR"

emit_status() {
    printf 'STATUS: %s %s\n' "$1" "$2"
}

require_tool() {
    local tool="$1"
    if ! command -v "$tool" >/dev/null 2>&1; then
        emit_status "BLOCKED" "iree.tool_check[$tool]"
        echo "build_iree: required tool $tool missing" >&2
        exit 2
    fi
}

if [ "$(uname -s)" != "Linux" ]; then
    emit_status "BLOCKED" "iree.environment_check"
    echo "build_iree: requires Linux container per docs/toolchain/iree-eliza-npu.md" >&2
    exit 2
fi

if [ ! -d "$STAGE2_DIR/lib/cmake/mlir" ]; then
    emit_status "BLOCKED" "iree.llvm_dependency"
    echo "build_iree: LLVM stage 2 missing at $STAGE2_DIR; run scripts/build_llvm_riscv.sh first" >&2
    exit 2
fi

require_tool cmake
require_tool ninja
require_tool git
require_tool jq

IREE_SHA="$(jq -r '.upstream.commit_sha' "$PIN_FILE")"
IREE_URL="$(jq -r '.upstream.url' "$PIN_FILE")"

if [ -z "$IREE_SHA" ] || [ "$IREE_SHA" = "null" ]; then
    emit_status "BLOCKED" "iree.pin_sha"
    echo "build_iree: IREE SHA missing in $PIN_FILE; refresh per docs/toolchain/iree-eliza-npu.md" >&2
    exit 2
fi
if ! printf '%s' "$IREE_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
    emit_status "BLOCKED" "iree.pin_sha_format"
    echo "build_iree: IREE SHA '$IREE_SHA' is not a 40-character hex string" >&2
    exit 2
fi

if [ ! -d "$SRC_DIR/.git" ]; then
    emit_status "BLOCKED" "iree.clone"
    echo "build_iree: clone $IREE_URL into $SRC_DIR (out of band; not committed)" >&2
    exit 2
fi

git -C "$SRC_DIR" fetch --recurse-submodules origin "$IREE_SHA"
git -C "$SRC_DIR" checkout --detach "$IREE_SHA"
git -C "$SRC_DIR" submodule update --init --recursive --depth 1

# Mount the external dialect tree.
mount_dir="$SRC_DIR/compiler/plugins/target/elizanpu"
mkdir -p "$(dirname "$mount_dir")"
if [ -L "$mount_dir" ] || [ -d "$mount_dir" ]; then
    rm -rf "$mount_dir"
fi
ln -s "$repo_dir/compiler/iree-eliza-npu" "$mount_dir"

mapfile -t CMAKE_ARGS < <(jq -r '.cmake_args[]' "$PIN_FILE")

cmake -G Ninja \
    -S "$SRC_DIR" \
    -B "$BUILD_DIR" \
    -DCMAKE_INSTALL_PREFIX="$repo_dir/$BUILD_DIR/install" \
    -DMLIR_DIR="$repo_dir/$STAGE2_DIR/lib/cmake/mlir" \
    -DLLVM_DIR="$repo_dir/$STAGE2_DIR/lib/cmake/llvm" \
    "${CMAKE_ARGS[@]}"

ninja -C "$BUILD_DIR" iree-compile iree-opt elizanpu-opt
ninja -C "$BUILD_DIR" install

emit_status "PASS" "iree.build"

"$repo_dir/$BUILD_DIR/install/bin/iree-compile" --version | tee "$REPORT_DIR/iree-version.txt"

"$repo_dir/$BUILD_DIR/install/bin/elizanpu-opt" \
    --verify-roundtrip \
    "$repo_dir/compiler/iree-eliza-npu/tests/roundtrip.mlir" \
    > "$REPORT_DIR/elizanpu-opt-roundtrip.log"
emit_status "PASS" "iree.elizanpu_roundtrip"
