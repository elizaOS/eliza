#!/usr/bin/env bash

set -euo pipefail

export PATH="/opt/cross/bin:/usr/local/cargo/bin:${PATH}"
export RUSTUP_HOME="${RUSTUP_HOME:-/usr/local/rustup}"
export CARGO_HOME="/home/builder/.cargo"

log() { printf '[bun-riscv64] %s\n' "$*"; }
die() { printf '[bun-riscv64][FATAL] %s\n' "$*" >&2; exit 1; }

RM_PATH_RECURSIVE="${RM_PATH_RECURSIVE:-/opt/rm-path-recursive.ts}"
remove_path_recursive() {
    [ -r "$RM_PATH_RECURSIVE" ] || die "recursive cleanup helper not mounted at $RM_PATH_RECURSIVE"
    bun "$RM_PATH_RECURSIVE" "$@"
}

prepare_ninja_object_dirs() {
    local ninja_file="$1"
    local ninja_dir
    ninja_dir="$(dirname "$ninja_file")"
    [ -f "$ninja_file" ] || return 0
    awk '/^build .*\.o: / { for (i = 2; i <= NF; i++) if ($i ~ /\.o$/) print $i }' "$ninja_file" \
        | while IFS= read -r obj; do
            [ -n "$obj" ] || continue
            mkdir -p "$ninja_dir/$(dirname "$obj")"
        done
}

VERSION_FILE="${VERSION_FILE:-/opt/bun-version.json}"
[ -r "$VERSION_FILE" ] || die "bun-version.json not mounted at $VERSION_FILE"

bun_jq() {
    bun -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(process.argv[2].split(".").slice(1).reduce((value, key) => value[key], v));' "$VERSION_FILE" "$1"
}

BUN_COMMIT="$(bun_jq 'v.bun.commit')"
RUST_NIGHTLY="$(bun_jq 'v.toolchain.rust.channel')"
WEBKIT_COMMIT="$(bun_jq 'v.webkit.commit')"
WEBKIT_FORK="$(bun_jq 'v.webkit.fork')"
LLVM_VERSION="$(bun_jq 'v.toolchain.llvm.version')"
ALPINE_BRANCH="$(bun_jq 'v.toolchain.musl.alpine_branch')"
[[ "$BUN_COMMIT" =~ ^[a-f0-9]{40}$ ]] || die "BUN_COMMIT must be an exact source commit"
[[ "$WEBKIT_COMMIT" =~ ^[a-f0-9]{40}$ ]] || die "WEBKIT_COMMIT must be an exact source commit"

log "Pins:"
log "  Bun commit      : $BUN_COMMIT"
log "  WebKit fork     : $WEBKIT_FORK"
log "  WebKit commit   : $WEBKIT_COMMIT"
log "  Rust nightly    : $RUST_NIGHTLY"
log "  LLVM            : $LLVM_VERSION"
log "  Alpine branch   : $ALPINE_BRANCH"

JOBS="${JOBS:-$(nproc)}"
log "  Build jobs      : $JOBS"

ARTIFACT_DIR="${ARTIFACT_DIR:-/artifact}"
mkdir -p "$ARTIFACT_DIR"
LOG_FILE="$ARTIFACT_DIR/build-log.txt"
exec > >(tee -a "$LOG_FILE") 2>&1

log "── stage 0: workspace setup ─────────────────────────────────────────"
SRC_ROOT="${SRC_ROOT:-/work/src}"
mkdir -p "$SRC_ROOT"
cd "$SRC_ROOT"

git config --global http.version HTTP/1.1
git config --global http.postBuffer 1048576000

log "── stage 1: WebKit checkout + patches ───────────────────────────────"

if [ ! -d "$SRC_ROOT/WebKit" ]; then
    log "Cloning ${WEBKIT_FORK} @ ${WEBKIT_COMMIT}"
    git init --initial-branch=main "$SRC_ROOT/WebKit"
    git -C "$SRC_ROOT/WebKit" remote add origin "https://github.com/${WEBKIT_FORK}.git"
fi
git -C "$SRC_ROOT/WebKit" config http.version HTTP/1.1
git -C "$SRC_ROOT/WebKit" config http.postBuffer 1048576000
for attempt in 1 2 3 4 5; do
    if git -C "$SRC_ROOT/WebKit" fetch --depth=1 --filter=blob:none origin "${WEBKIT_COMMIT}" \
       && git -C "$SRC_ROOT/WebKit" reset --hard "${WEBKIT_COMMIT}"; then
        break
    fi
    [ "$attempt" -eq 5 ] && die "WebKit fetch/checkout failed after 5 attempts (network) @ ${WEBKIT_COMMIT}"
    log "WebKit fetch attempt ${attempt} failed (network); retrying in $((attempt * 10))s…"
    sleep $((attempt * 10))
done

if compgen -G "/opt/webkit-patches/*.patch" >/dev/null; then
    log "Applying webkit-patches/*.patch (in lexical order):"
    cd "$SRC_ROOT/WebKit"
    git config user.email "bun-riscv64@eliza.local"
    git config user.name "bun-riscv64 build"
    while IFS= read -r p; do
        log "  -> $p"
        git apply "$p" || die "WebKit patch failed: $p"
    done < <(find /opt/webkit-patches -maxdepth 1 -type f -name '*.patch' | sort)
    cd "$SRC_ROOT"
else
    log "No webkit-patches/*.patch present; building WebKit @ ${WEBKIT_COMMIT} as-is."
fi

log "── stage 2: Bun checkout + patches ──────────────────────────────────"

if [ ! -d "$SRC_ROOT/bun" ]; then
    log "Fetching oven-sh/bun @ ${BUN_COMMIT}"
    git init -q "$SRC_ROOT/bun"
    git -C "$SRC_ROOT/bun" remote add origin https://github.com/oven-sh/bun.git
fi
git -C "$SRC_ROOT/bun" fetch --depth=1 origin "${BUN_COMMIT}"
git -C "$SRC_ROOT/bun" reset --hard FETCH_HEAD >/dev/null
git -C "$SRC_ROOT/bun" submodule update --init --recursive --depth=1

if compgen -G "/opt/bun-patches/*.patch" >/dev/null; then
    log "Applying bun-patches/*.patch (in lexical order):"
    cd "$SRC_ROOT/bun"
    git config user.email "bun-riscv64@eliza.local"
    git config user.name "bun-riscv64 build"
    while IFS= read -r p; do
        log "  -> $p"
        git apply "$p" || die "Bun patch failed: $p"
    done < <(find /opt/bun-patches -maxdepth 1 -type f -name '*.patch' | sort)
    cd "$SRC_ROOT"
else
    die "No bun-patches/*.patch present — Bun's build system needs riscv64 awareness (Arch type, cpu flags, WebKit pin, etc.). Populate bun-patches/ before running build.sh."
fi

log "── stage 4: WebKit build ────────────────────────────────────────────"

WEBKIT_BUILD_DIR="$SRC_ROOT/WebKit/WebKitBuild/riscv64-Release"
mkdir -p "$WEBKIT_BUILD_DIR"
cd "$WEBKIT_BUILD_DIR"

WK_JIT_FLAGS=(
    -DENABLE_C_LOOP=ON
    -DENABLE_JIT=OFF
    -DENABLE_DFG_JIT=OFF
    -DENABLE_FTL_JIT=OFF
    -DENABLE_WEBASSEMBLY=OFF
    -DENABLE_WEBASSEMBLY_BBQJIT=OFF
    -DENABLE_WEBASSEMBLY_OMGJIT=OFF
)

WK_LINKER_FLAGS="-fuse-ld=lld"

cmake \
    -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_SYSTEM_NAME=Linux \
    -DCMAKE_SYSTEM_PROCESSOR=riscv64 \
    -DCMAKE_SYSROOT=/sysroot \
    -DCMAKE_FIND_ROOT_PATH=/sysroot \
    -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER \
    -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY \
    -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY \
    -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=ONLY \
    -DCMAKE_C_COMPILER=/opt/cross/bin/riscv64-linux-musl-clang \
    -DCMAKE_CXX_COMPILER=/opt/cross/bin/riscv64-linux-musl-clang++ \
    -DCMAKE_AR=/usr/local/bin/llvm-ar \
    -DCMAKE_RANLIB=/usr/local/bin/llvm-ranlib \
    -DCMAKE_LINKER=/usr/local/bin/ld.lld \
    -DCMAKE_C_FLAGS="-march=rv64gc -mabi=lp64d -O3 -I$SRC_ROOT/WebKit/Source/bmalloc/mimalloc/mimalloc/include" \
    -DCMAKE_CXX_FLAGS="-march=rv64gc -mabi=lp64d -O3 -I$SRC_ROOT/WebKit/Source/bmalloc/mimalloc/mimalloc/include" \
    -DCMAKE_EXE_LINKER_FLAGS_INIT="${WK_LINKER_FLAGS}" \
    -DCMAKE_SHARED_LINKER_FLAGS_INIT="${WK_LINKER_FLAGS}" \
    -DCMAKE_MODULE_LINKER_FLAGS_INIT="${WK_LINKER_FLAGS}" \
    -DPORT=JSCOnly \
    -DENABLE_STATIC_JSC=ON \
    -DUSE_BUN_JSC_ADDITIONS=ON \
    -DUSE_THIN_ARCHIVES=OFF \
    -DUSE_SYSTEM_MALLOC=OFF \
    "${WK_JIT_FLAGS[@]}" \
    "$SRC_ROOT/WebKit" \
    || die "WebKit cmake configure failed."

ninja -j"$JOBS" jsc \
    || die "WebKit ninja build failed."
prepare_ninja_object_dirs "$WEBKIT_BUILD_DIR/build.ninja"

log "── stage 5: Bun build ───────────────────────────────────────────────"

cd "$SRC_ROOT/bun"

export RUSTUP_TOOLCHAIN="$RUST_NIGHTLY"
export BUN_WEBKIT_PATH="$SRC_ROOT/WebKit"
export BUN_RUST_TARGET=riscv64gc-unknown-linux-musl
export BUN_CC=/opt/cross/bin/riscv64-linux-musl-clang
export BUN_CXX=/opt/cross/bin/riscv64-linux-musl-clang++
export BUN_AR=/usr/local/bin/llvm-ar
export BUN_RANLIB=/usr/local/bin/llvm-ranlib
export BUN_LD=/usr/local/bin/ld.lld
export BUN_STRIP=/usr/local/bin/llvm-strip
export BUN_SYSROOT=/sysroot
export LINUX_MUSL_SYSROOT=/sysroot
export BUN_DISABLE_TINYCC=1
# Match the source inventory to the WebKit C-loop feature configuration.
export BUN_RISCV64_FORCE_CLOOP=1

BUN_BUILD_DIR="$SRC_ROOT/bun/build/release"
remove_path_recursive "$BUN_BUILD_DIR"
mkdir -p "$BUN_BUILD_DIR/deps"
ln -s "$WEBKIT_BUILD_DIR" "$BUN_BUILD_DIR/deps/WebKit"

bun scripts/build.ts \
    --configure-only \
    --profile=release \
    --arch=riscv64 \
    --abi=musl \
    --webkit=local \
    || die "Bun configure failed. Inspect the build log."

configure_targets="$(ninja -C "$BUN_BUILD_DIR" -t targets all | awk -F: '/^configure-/ && $1 != "configure-WebKit" {print $1}')"
if [ -n "$configure_targets" ]; then
    # shellcheck disable=SC2086
    ninja -C "$BUN_BUILD_DIR" -j"$JOBS" $configure_targets \
        || die "Bun dependency configure failed."
fi

prepare_ninja_object_dirs "$BUN_BUILD_DIR/build.ninja"
find "$BUN_BUILD_DIR/deps" -name build.ninja -print \
    | while IFS= read -r ninja_file; do
        prepare_ninja_object_dirs "$ninja_file"
    done

ninja -C "$BUN_BUILD_DIR" -j"$JOBS" \
    || die "Bun build failed. Inspect the build log."

log "── stage 6: package + smoke test ────────────────────────────────────"

BUN_BIN="$SRC_ROOT/bun/build/release/bun"
[ -x "$BUN_BIN" ] || die "Built bun not found at $BUN_BIN"

file "$BUN_BIN"

log "Smoke test: qemu-riscv64 --version"
qemu-riscv64 --version | head -1

log "Smoke test: qemu-riscv64 bun --version"
QEMU_OUT="$(qemu-riscv64 -L /sysroot "$BUN_BIN" --version 2>&1)" || \
    die "qemu-riscv64 bun --version failed: $QEMU_OUT"
log "  → bun reports: $QEMU_OUT"

log "Smoke test: qemu-riscv64 bun -e"
QEMU_EVAL_OUT="$(qemu-riscv64 -L /sysroot "$BUN_BIN" -e 'console.log("bun-riscv64-eval-ok", process.arch)' 2>&1)" || \
    die "qemu-riscv64 bun -e failed: $QEMU_EVAL_OUT"
case "$QEMU_EVAL_OUT" in
    *"bun-riscv64-eval-ok riscv64"*) ;;
    *) die "qemu-riscv64 bun -e returned unexpected output: $QEMU_EVAL_OUT" ;;
esac
log "  → eval reports: $QEMU_EVAL_OUT"

log "Smoke test: qemu-riscv64 bun <script.js>"
SMOKE_DIR="$(mktemp -d /tmp/bun-riscv64-smoke.XXXXXX)"
trap 'remove_path_recursive "$SMOKE_DIR"' EXIT
SMOKE_JS="$SMOKE_DIR/entrypoint.js"
cat > "$SMOKE_JS" <<'JS'
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
assert.equal(runInNewContext("answer + 1", { answer: 41 }), 42);
assert.throws(() => runInNewContext('eval("1")', {}, {
  contextCodeGeneration: { strings: false, wasm: false },
}), /Code generation from strings disallowed/);
console.log("bun-riscv64-script-ok", process.arch);
JS
QEMU_SCRIPT_OUT="$(qemu-riscv64 -L /sysroot "$BUN_BIN" "$SMOKE_JS" 2>&1)" || \
    die "qemu-riscv64 bun script entrypoint failed: $QEMU_SCRIPT_OUT"
case "$QEMU_SCRIPT_OUT" in
    *"bun-riscv64-script-ok riscv64"*) ;;
    *) die "qemu-riscv64 bun script entrypoint returned unexpected output: $QEMU_SCRIPT_OUT" ;;
esac
log "  → script reports: $QEMU_SCRIPT_OUT"

STAGE_DIR="$SRC_ROOT/stage/bun-linux-riscv64-musl"
mkdir -p "$STAGE_DIR"
install -m 0755 "$BUN_BIN" "$STAGE_DIR/bun"

ZIP_NAME="bun-linux-riscv64-musl.zip"
ZIP_PATH="$ARTIFACT_DIR/$ZIP_NAME"
cd "$SRC_ROOT/stage"
rm -f "$ZIP_PATH"
zip -q -r "$ZIP_PATH" "bun-linux-riscv64-musl"

SHA="$(sha256sum "$ZIP_PATH" | awk '{print $1}')"
echo "$SHA  $ZIP_NAME" > "$ZIP_PATH.sha256"

log "── done ─────────────────────────────────────────────────────────────"
log "Artifact: $ZIP_PATH"
log "SHA256  : $SHA"
log "bun --version: $QEMU_OUT"
