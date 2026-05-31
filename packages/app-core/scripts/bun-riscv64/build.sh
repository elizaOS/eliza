#!/usr/bin/env bash
#
# Bun riscv64-linux-musl cross-build driver.
#
# Runs INSIDE the Docker image defined by ./Dockerfile. The host-side
# wrapper (see README.md → "Building") mounts:
#   /opt/build.sh           this file
#   /opt/bun-version.json   the pinned tags + commits
#   /opt/bun-patches/       patches against oven-sh/bun
#   /opt/webkit-patches/    patches against oven-sh/WebKit @ WEBKIT_VERSION
#   /artifact/              host dist/ for the output zip + build log
#
# Inputs (env vars, all optional):
#   BUN_TAG                 override bun.tag from bun-version.json
#   WEBKIT_COMMIT           override webkit.fork_commit from bun-version.json
#   BUN_RISCV64_FORCE_CLOOP=0
#                           opt into the experimental Baseline-JIT path.
#                           The production artifact defaults to C_LOOP until
#                           the WebKit recipe chain is checked in as real
#                           patch files.
#   JOBS                    parallel build jobs. Defaults to nproc.
#
# Output (under /artifact):
#   bun-linux-riscv64-musl.zip      the artifact
#   bun-linux-riscv64-musl.zip.sha256
#   build-log.txt                   transcript + sha256s + qemu smoke runs
#
# Failure model: every step is `set -euo pipefail`. The production artifact
# defaults to ENABLE_C_LOOP=ON. Baseline-JIT attempts require the operator to
# set BUN_RISCV64_FORCE_CLOOP=0 and must fail while recipe files remain
# unrealized.

set -euo pipefail

# ENTRYPOINT runs us under `bash -l`, which sources /etc/profile and
# resets PATH to Debian's default — wiping the Dockerfile's
# `ENV PATH=/opt/cross/bin:/usr/local/cargo/bin:…`. Re-prepend the
# toolchain dirs explicitly so rustup/cargo/clang stay reachable.
export PATH="/opt/cross/bin:/usr/local/cargo/bin:${PATH}"
export RUSTUP_HOME="${RUSTUP_HOME:-/usr/local/rustup}"
export CARGO_HOME="/home/builder/.cargo"

log() { printf '[bun-riscv64] %s\n' "$*"; }
die() { printf '[bun-riscv64][FATAL] %s\n' "$*" >&2; exit 1; }

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

# ──────────────────────────────────────────────────────────────────────────
# Resolve pins from bun-version.json
# ──────────────────────────────────────────────────────────────────────────
VERSION_FILE="${VERSION_FILE:-/opt/bun-version.json}"
[ -r "$VERSION_FILE" ] || die "bun-version.json not mounted at $VERSION_FILE"

# We have bun in the image, so use it as the JSON reader. jq is not
# installed to keep the image lean.
bun_jq() {
    bun -e "const v = JSON.parse(require('fs').readFileSync('${VERSION_FILE}','utf8')); console.log($1);"
}

BUN_TAG="${BUN_TAG:-$(bun_jq 'v.bun.tag')}"
WEBKIT_COMMIT="${WEBKIT_COMMIT:-$(bun_jq 'v.webkit.fork_commit')}"
WEBKIT_FORK="$(bun_jq 'v.webkit.fork')"
RUST_NIGHTLY="$(bun_jq 'v.toolchain.rust.channel')"
LLVM_VERSION="$(bun_jq 'v.toolchain.llvm.version')"
ZIG_VERSION="$(bun_jq 'v.toolchain.zig.version')"
ALPINE_BRANCH="$(bun_jq 'v.toolchain.musl.alpine_branch')"

log "Pins:"
log "  Bun tag         : $BUN_TAG"
log "  WebKit fork     : $WEBKIT_FORK"
log "  WebKit commit   : $WEBKIT_COMMIT"
log "  Rust nightly    : $RUST_NIGHTLY"
log "  LLVM            : $LLVM_VERSION"
log "  Zig             : $ZIG_VERSION"
log "  Alpine branch   : $ALPINE_BRANCH"

JOBS="${JOBS:-$(nproc)}"
log "  Build jobs      : $JOBS"

FORCE_CLOOP="${BUN_RISCV64_FORCE_CLOOP:-1}"
if [ "$FORCE_CLOOP" = "1" ]; then
    log "  JIT mode        : C_LOOP (BUN_RISCV64_FORCE_CLOOP=1)"
else
    log "  JIT mode        : Baseline JIT"
fi

ARTIFACT_DIR="${ARTIFACT_DIR:-/artifact}"
mkdir -p "$ARTIFACT_DIR"
LOG_FILE="$ARTIFACT_DIR/build-log.txt"
# Tee everything to the build log from here on.
exec > >(tee -a "$LOG_FILE") 2>&1

log "── stage 0: workspace setup ─────────────────────────────────────────"
SRC_ROOT="${SRC_ROOT:-/work/src}"
mkdir -p "$SRC_ROOT"
cd "$SRC_ROOT"

# ──────────────────────────────────────────────────────────────────────────
# Stage 1: clone WebKit fork at the pinned commit and apply riscv64 patches.
# ──────────────────────────────────────────────────────────────────────────
log "── stage 1: WebKit checkout + patches ───────────────────────────────"

if [ ! -d "$SRC_ROOT/WebKit" ]; then
    log "Cloning ${WEBKIT_FORK} @ ${WEBKIT_COMMIT}"
    # Partial clone — Bun's WebKit fork is several GB of history. We only
    # need the tree at this one commit. `--filter=blob:none` defers blob
    # fetches until checkout time; combined with --depth=1 from a named
    # commit (via `git fetch <sha>`), this stays under ~1.5 GB.
    git init --initial-branch=main "$SRC_ROOT/WebKit"
    git -C "$SRC_ROOT/WebKit" remote add origin "https://github.com/${WEBKIT_FORK}.git"
    git -C "$SRC_ROOT/WebKit" fetch --depth=1 --filter=blob:none origin "${WEBKIT_COMMIT}"
    git -C "$SRC_ROOT/WebKit" checkout "${WEBKIT_COMMIT}"
fi
git -C "$SRC_ROOT/WebKit" reset --hard "${WEBKIT_COMMIT}" >/dev/null

if compgen -G "/opt/webkit-patches/*.recipe" >/dev/null && [ "$FORCE_CLOOP" != "1" ]; then
    # Recipe files are placeholders for cherry-pick chains the operator
    # has not realized into actual *.patch files yet. Without those, the
    # Baseline JIT cannot be built (LLInt + Baseline support is the whole
    # point of webkit-patches/0001 + 0002). Force the operator to either
    # realize the recipes or switch to C_LOOP fallback explicitly.
    log "FATAL: webkit-patches/ contains unrealized *.recipe files:"
    for r in /opt/webkit-patches/*.recipe; do
        log "  - $r"
    done
    log "Baseline JIT bringup requires the cherry-pick chain documented in"
    log "those recipe files to be realized into *.patch files first. Either:"
    log "  a) realize the cherry-picks per the recipe instructions, OR"
    log "  b) re-run with BUN_RISCV64_FORCE_CLOOP=1 to build with C_LOOP."
    die "unrealized webkit-patches/*.recipe — refusing to build Baseline JIT"
fi

if compgen -G "/opt/webkit-patches/*.patch" >/dev/null; then
    log "Applying webkit-patches/*.patch (in lexical order):"
    cd "$SRC_ROOT/WebKit"
    git config user.email "bun-riscv64@eliza.local"
    git config user.name "bun-riscv64 build"
    for p in $(ls /opt/webkit-patches/*.patch | sort); do
        # In C_LOOP mode, the 0003-disable-dfg-ftl-on-riscv64 patch is
        # unnecessary — ENABLE_C_LOOP=ON in CMake forcibly disables every
        # JIT tier, so the upstream PlatformEnable.h ifdefs never reach
        # the DFG/FTL paths regardless of what the patch toggles. Skip
        # it to dodge context-drift conflicts against the upstream
        # PlatformEnable.h header.
        case "${p##*/}" in
            0003-disable-dfg-ftl-on-riscv64.patch)
                if [ "$FORCE_CLOOP" = "1" ]; then
                    log "  -> $p (SKIPPED — C_LOOP build does not need DFG/FTL ifdefs)"
                    continue
                fi
                ;;
        esac
        log "  -> $p"
        if git apply --reverse --check "$p" >/dev/null 2>&1; then
            log "     already applied; skipping"
            continue
        fi
        # 3-way merge is tolerant of context drift; on hard conflict, fail
        # rather than silently skipping.
        git apply --3way "$p" || die "WebKit patch failed: $p — see webkit-patches/README.md for rebase guidance"
    done
    cd "$SRC_ROOT"
else
    log "No webkit-patches/*.patch present; building WebKit @ ${WEBKIT_COMMIT} as-is."
    log "If Baseline JIT bringup fails, operator must populate webkit-patches/ — see its README.md."
fi

# ──────────────────────────────────────────────────────────────────────────
# Stage 2: clone Bun at the pinned tag and apply patches.
# ──────────────────────────────────────────────────────────────────────────
log "── stage 2: Bun checkout + patches ──────────────────────────────────"

# BUN_TAG may be a tag (Zig fallback, e.g. bun-v1.3.14) OR a bare commit SHA
# (Rust-core port, e.g. rust_core_port.target_commit). `git clone --branch`
# rejects a SHA, so fetch the ref directly — GitHub allows fetch-by-SHA
# (allowAnySHA1InWant) — mirroring the WebKit checkout above. Works for both.
if [ ! -d "$SRC_ROOT/bun" ]; then
    log "Fetching oven-sh/bun @ ${BUN_TAG}"
    git init -q "$SRC_ROOT/bun"
    git -C "$SRC_ROOT/bun" remote add origin https://github.com/oven-sh/bun.git
    git -C "$SRC_ROOT/bun" fetch --depth=1 --recurse-submodules origin "${BUN_TAG}"
    git -C "$SRC_ROOT/bun" checkout -q FETCH_HEAD
fi
git -C "$SRC_ROOT/bun" fetch --depth=1 origin "${BUN_TAG}" >/dev/null 2>&1
git -C "$SRC_ROOT/bun" reset --hard FETCH_HEAD >/dev/null
git -C "$SRC_ROOT/bun" submodule update --init --recursive --depth=1

if compgen -G "/opt/bun-patches/*.patch" >/dev/null; then
    log "Applying bun-patches/*.patch (in lexical order):"
    cd "$SRC_ROOT/bun"
    git config user.email "bun-riscv64@eliza.local"
    git config user.name "bun-riscv64 build"
    for p in $(ls /opt/bun-patches/*.patch | sort); do
        log "  -> $p"
        if git apply --reverse --check "$p" >/dev/null 2>&1; then
            log "     already applied; skipping"
            continue
        fi
        git apply --3way "$p" || die "Bun patch failed: $p"
    done
    cd "$SRC_ROOT"
else
    die "No bun-patches/*.patch present — Bun's build system needs riscv64 awareness (Arch type, cpu flags, WebKit pin, etc.). Populate bun-patches/ before running build.sh."
fi

# ──────────────────────────────────────────────────────────────────────────
# Stage 3: cargo dependencies and rust target.
# ──────────────────────────────────────────────────────────────────────────
log "── stage 3: cargo prefetch ──────────────────────────────────────────"
cd "$SRC_ROOT/bun"
rustup target add --toolchain "${RUST_NIGHTLY}" riscv64gc-unknown-linux-musl
# Pre-fetch cargo deps so a later `cargo build --offline` works even if
# the registry hiccups mid-build.
if [ -f Cargo.toml ]; then
    cargo +"${RUST_NIGHTLY}" fetch --target riscv64gc-unknown-linux-musl
fi

# ──────────────────────────────────────────────────────────────────────────
# Stage 4: configure + build WebKit for riscv64.
# ──────────────────────────────────────────────────────────────────────────
log "── stage 4: WebKit build ────────────────────────────────────────────"

WEBKIT_BUILD_DIR="$SRC_ROOT/WebKit/WebKitBuild/riscv64-Release"
mkdir -p "$WEBKIT_BUILD_DIR"
cd "$WEBKIT_BUILD_DIR"

# JIT switches. WebKit's CMake exposes ENABLE_JIT (umbrella, implies
# LLInt + Baseline tiers), ENABLE_DFG_JIT, ENABLE_FTL_JIT, and
# ENABLE_C_LOOP. There is no `ENABLE_BASELINE_JIT` option — Baseline is
# always built when ENABLE_JIT=ON and the target arch has a Baseline
# backend (riscv64 does, via WebKit bug #239708 r293316).
#
# - Default: ENABLE_JIT=ON (LLInt + Baseline), DFG/FTL OFF.
# - BUN_RISCV64_FORCE_CLOOP=1: ENABLE_C_LOOP=ON, ENABLE_JIT=OFF (mutually
#   exclusive per WebKit's WEBKIT_OPTION_CONFLICT).
if [ "$FORCE_CLOOP" = "1" ]; then
    WK_JIT_FLAGS=(
        -DENABLE_C_LOOP=ON
        -DENABLE_JIT=OFF
        -DENABLE_DFG_JIT=OFF
        -DENABLE_FTL_JIT=OFF
        # WebKit enforces ENABLE_WEBASSEMBLY conflicts with ENABLE_C_LOOP, so a
        # JIT-less build cannot include WebAssembly. This is why wasm is off here.
        -DENABLE_WEBASSEMBLY=OFF
        -DENABLE_WEBASSEMBLY_BBQJIT=OFF
        -DENABLE_WEBASSEMBLY_OMGJIT=OFF
    )
else
    WK_JIT_FLAGS=(
        -DENABLE_C_LOOP=OFF
        -DENABLE_JIT=ON
        -DENABLE_DFG_JIT=OFF
        -DENABLE_FTL_JIT=OFF
    )
fi

# Linker selection: the riscv64-linux-musl-clang wrapper sets --target and
# --sysroot but does not force a linker. Debian's default linker for
# clang's driver is `/usr/bin/ld` (GNU binutils, x86_64-only), which
# rejects the riscv64 `elf64lriscv` emulation and aborts the very first
# CMake C-compiler probe. Force lld via -fuse-ld=lld on every link line.
# We do this through CMAKE_*_LINKER_FLAGS (not C/CXX flags) so the flag
# never reaches a compile-only invocation where clang would warn it is
# unused.
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
    || die "WebKit cmake configure failed. If Baseline JIT, retry with BUN_RISCV64_FORCE_CLOOP=1."

ninja -j"$JOBS" jsc \
    || die "WebKit ninja build failed. See webkit-patches/README.md if the failure is in offlineasm or LLInt."
prepare_ninja_object_dirs "$WEBKIT_BUILD_DIR/build.ninja"

# ──────────────────────────────────────────────────────────────────────────
# Stage 5: configure + build Bun.
# ──────────────────────────────────────────────────────────────────────────
log "── stage 5: Bun build ───────────────────────────────────────────────"

cd "$SRC_ROOT/bun"

# Bun's build entrypoint is `bun bd` (build driver). Force flags through
# env so the bun-patches/ series can stay smaller — anything we can pass
# at invocation time, we do.
export BUN_WEBKIT_PATH="$SRC_ROOT/WebKit"
export BUN_RUST_TARGET=riscv64gc-unknown-linux-musl
export BUN_CC=/opt/cross/bin/riscv64-linux-musl-clang
export BUN_CXX=/opt/cross/bin/riscv64-linux-musl-clang++
export BUN_AR=/usr/local/bin/llvm-ar
export BUN_RANLIB=/usr/local/bin/llvm-ranlib
export BUN_LD=/usr/local/bin/ld.lld
export BUN_STRIP=/usr/local/bin/llvm-strip
export BUN_SYSROOT=/sysroot
export BUN_DISABLE_TINYCC=1

BUN_BUILD_DIR="$SRC_ROOT/bun/build/release"
rm -rf "$BUN_BUILD_DIR"
mkdir -p "$BUN_BUILD_DIR/deps"
ln -s "$WEBKIT_BUILD_DIR" "$BUN_BUILD_DIR/deps/WebKit"

# Configure Bun without letting its dependency graph reconfigure WebKit. The
# riscv64 patch series marks WebKit as an external, prebuilt dependency, so the
# completed C_LOOP build above is consumed from build/release/deps/WebKit.
bun scripts/build.ts \
    --configure-only \
    --profile=release \
    --arch=riscv64 \
    --abi=musl \
    --webkit=local \
    || die "Bun configure failed. See bun-patches/README.md."

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
    || die "Bun build failed. See bun-patches/README.md."

# ──────────────────────────────────────────────────────────────────────────
# Stage 6: package + smoke-test under QEMU.
# ──────────────────────────────────────────────────────────────────────────
log "── stage 6: package + smoke test ────────────────────────────────────"

BUN_BIN="$SRC_ROOT/bun/build/release/bun"
[ -x "$BUN_BIN" ] || die "Built bun not found at $BUN_BIN"

file "$BUN_BIN"
# musl-static link: should report "statically linked" or "interpreter
# /lib/ld-musl-riscv64.so.1". We do not enforce one or the other — Bun's
# upstream zips are dynamically linked against musl on Alpine, so we
# match that.
"$BUN_BIN" --help >/dev/null 2>&1 || true  # parse-only sanity (host can't exec it directly)

log "Smoke test: qemu-riscv64-static --version"
qemu-riscv64-static --version | head -1

log "Smoke test: qemu-riscv64-static bun --version"
# QEMU needs to find ld-musl-riscv64.so.1; -L /sysroot provides that.
QEMU_OUT="$(qemu-riscv64-static -L /sysroot "$BUN_BIN" --version 2>&1)" || \
    die "qemu-riscv64-static bun --version failed: $QEMU_OUT"
log "  → bun reports: $QEMU_OUT"

log "Smoke test: qemu-riscv64-static bun -e"
QEMU_EVAL_OUT="$(qemu-riscv64-static -L /sysroot "$BUN_BIN" -e 'console.log("bun-riscv64-eval-ok", process.arch)' 2>&1)" || \
    die "qemu-riscv64-static bun -e failed: $QEMU_EVAL_OUT"
case "$QEMU_EVAL_OUT" in
    *"bun-riscv64-eval-ok riscv64"*) ;;
    *) die "qemu-riscv64-static bun -e returned unexpected output: $QEMU_EVAL_OUT" ;;
esac
log "  → eval reports: $QEMU_EVAL_OUT"

log "Smoke test: qemu-riscv64-static bun <script.js>"
SMOKE_DIR="$(mktemp -d /tmp/bun-riscv64-smoke.XXXXXX)"
trap 'rm -rf "$SMOKE_DIR"' EXIT
SMOKE_JS="$SMOKE_DIR/entrypoint.js"
printf '%s\n' 'console.log("bun-riscv64-script-ok", process.arch);' > "$SMOKE_JS"
QEMU_SCRIPT_OUT="$(qemu-riscv64-static -L /sysroot "$BUN_BIN" "$SMOKE_JS" 2>&1)" || \
    die "qemu-riscv64-static bun script entrypoint failed: $QEMU_SCRIPT_OUT"
case "$QEMU_SCRIPT_OUT" in
    *"bun-riscv64-script-ok riscv64"*) ;;
    *) die "qemu-riscv64-static bun script entrypoint returned unexpected output: $QEMU_SCRIPT_OUT" ;;
esac
log "  → script reports: $QEMU_SCRIPT_OUT"

# Layout matches upstream's bun-linux-x64-musl.zip:
#   bun-linux-riscv64-musl/
#     bun
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
