#!/usr/bin/env bash
# build-riscv64-artifacts.sh — build-driver for every riscv64 cross-build
# the QEMU smoke harness consumes.
#
# Walks the same artifact list as scripts/check-riscv64-artifacts.sh and
# runs the relevant cross-build for each artifact that's missing. Each
# step is idempotent: if the output already exists and is rv64 ELF, the
# step is skipped (so callers can re-run cheaply).
#
# Gated on ELIZA_RISCV64_SMOKE=1 by default (same posture as the smoke
# harness). Unset = no-op.
#
# Tooling requirements (caller's job to install):
#   - zig 0.14+        (Zig toolchain; provides riscv64-linux-musl — every
#                       cross-build here is zig/musl, so no Android NDK is needed)
#   - cmake 3.21+      (drives every package's cross-build)
#   - node 20+         (drives compile-libllama.mjs / build-omnivoice.mjs / build-whisper.mjs)
#
# Usage:
#   ELIZA_RISCV64_SMOKE=1 bash scripts/build-riscv64-artifacts.sh
#   ELIZA_RISCV64_SMOKE=1 bash scripts/build-riscv64-artifacts.sh --force         # rebuild even if present
#
# Exit code:
#   0 — every reachable build succeeded (or already present)
#   1 — at least one build failed
#   2 — missing required toolchain (zig / cmake) — caller must install

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
FORCE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --jobs) JOBS="$2"; shift 2;;
        --force) FORCE=1; shift;;
        -h|--help)
            awk '/^# /{print substr($0,3)} /^#$/{print ""} !/^#/{exit}' "$0"
            exit 0;;
        *) echo "unknown argument: $1" >&2; exit 2;;
    esac
done

if [ "${ELIZA_RISCV64_SMOKE:-0}" != "1" ]; then
    echo "[build-riscv64-artifacts] ELIZA_RISCV64_SMOKE not set; nothing to do."
    echo "[build-riscv64-artifacts] To run: ELIZA_RISCV64_SMOKE=1 bun run build:riscv64-artifacts"
    exit 0
fi

# ── Toolchain pre-flight ─────────────────────────────────────────────
ZIG_BIN="${ZIG_BIN:-$(command -v zig || true)}"
if [ -z "$ZIG_BIN" ]; then
    cat >&2 <<'EOF'
[build-riscv64-artifacts] zig not on PATH.

Install Zig 0.14+ from https://ziglang.org/download/ — every cross-build in
this harness drives `zig cc --target=riscv64-linux-musl` directly.

EOF
    exit 2
fi
ZIG_VERSION="$($ZIG_BIN version)"
ZIG_MAJOR_MINOR="$(printf '%s' "$ZIG_VERSION" | awk -F. '{ print $1"."$2 }')"
export ZIG_BIN

if ! command -v cmake >/dev/null 2>&1; then
    echo "[build-riscv64-artifacts] cmake not on PATH. Install cmake 3.21+." >&2
    exit 2
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
    echo "[build-riscv64-artifacts] node not on PATH. Install node 20+." >&2
    exit 2
fi

echo "[build-riscv64-artifacts] zig=$ZIG_VERSION  cmake=$(cmake --version | head -1)  node=$($NODE_BIN --version)"
echo "[build-riscv64-artifacts] jobs=$JOBS  force=$FORCE"

# ── Helpers ──────────────────────────────────────────────────────────
FAIL_N=0

is_riscv64_elf() {
    local f="$1"
    [ -f "$f" ] || return 1
    file -b "$f" 2>/dev/null | grep -q "UCB RISC-V"
}

should_build() {
    # $1 = sentinel path. Returns 0 if we should build, 1 if we should skip.
    local sentinel="$1"
    if [ "$FORCE" = "1" ]; then return 0; fi
    if [ -e "$sentinel" ]; then
        echo "  → up-to-date: $sentinel"
        return 1
    fi
    return 0
}

build_native_plugin() {
    local pkg="$1"; local extra_flag="${2:-}"
    local pkgdir="$repo_root/packages/native/plugins/$pkg"
    local builddir="$pkgdir/build/riscv64"
    if [ ! -f "$pkgdir/CMakeLists.txt" ]; then
        echo "  ✗ $pkg: $pkgdir/CMakeLists.txt missing"
        FAIL_N=$((FAIL_N+1))
        return
    fi
    local sentinel_a="$builddir/lib${pkg%-cpu}.a"
    case "$pkg" in
        silero-vad-cpp) sentinel_a="$builddir/libsilero_vad.a";;
        voice-classifier-cpp) sentinel_a="$builddir/libvoice_classifier.a";;
        wakeword-cpp) sentinel_a="$builddir/libwakeword.a";;
        yolo-cpp) sentinel_a="$builddir/libyolo.a";;
        face-cpp) sentinel_a="$builddir/libface.a";;
        doctr-cpp) sentinel_a="$builddir/libdoctr.a";;
        polarquant-cpu) sentinel_a="$builddir/libpolarquant.a";;
        turboquant-cpu) sentinel_a="$builddir/libturboquant.a";;
        qjl-cpu) sentinel_a="$builddir/libqjl.a";;
    esac
    if ! should_build "$sentinel_a"; then return; fi
    echo "→ Building $pkg (riscv64) …"
    rm -rf "$builddir"
    mkdir -p "$builddir"
    local config_log="$builddir.config.log"
    local build_log="$builddir.build.log"
    if [ -n "$extra_flag" ]; then
        if ! cmake -S "$pkgdir" -B "$builddir" \
            -DCMAKE_TOOLCHAIN_FILE="$repo_root/packages/native/cmake/toolchain-riscv64-linux-musl.cmake" \
            "$extra_flag" >"$config_log" 2>&1; then
            echo "  ✗ $pkg: cmake configure failed (see $config_log)"
            FAIL_N=$((FAIL_N+1)); return
        fi
    else
        if ! cmake -S "$pkgdir" -B "$builddir" \
            -DCMAKE_TOOLCHAIN_FILE="$repo_root/packages/native/cmake/toolchain-riscv64-linux-musl.cmake" \
            >"$config_log" 2>&1; then
            echo "  ✗ $pkg: cmake configure failed (see $config_log)"
            FAIL_N=$((FAIL_N+1)); return
        fi
    fi
    if ! cmake --build "$builddir" -j"$JOBS" >"$build_log" 2>&1; then
        echo "  ✗ $pkg: cmake build failed (see $build_log)"
        FAIL_N=$((FAIL_N+1)); return
    fi
    echo "  ✓ $pkg: $builddir"
}

# RVV flag escapes for Zig 0.13 (same logic as
# scripts/verify-riscv64-buildpaths.sh). TurboQuant uses the generic
# CPU (no zvl* attribute) so LLVM's loop vectoriser emits portable
# vsetvli loops; a named core like sifive_x280 advertises VLEN=512
# via zvl512b and produces code that silently truncates at smaller
# VLEN (qemu-user reports VLEN=128, the RVV-spec minimum).
QJL_RVV=""; POLAR_RVV=""; TBQ_RVV=""
if [ "$ZIG_MAJOR_MINOR" = "0.13" ]; then
    QJL_RVV="-DQJL_RVV_COMPILE_OPTIONS=-mcpu=sifive_x280;-mabi=lp64d"
    POLAR_RVV="-DPOLARQUANT_RVV_COMPILE_OPTIONS=-mcpu=sifive_x280;-mabi=lp64d"
    TBQ_RVV="-DTURBOQUANT_RVV_FLAGS=-mcpu=generic_rv64+v+m+a+f+d+c"
fi

# ── Native plugins ───────────────────────────────────────────────────
echo
echo "── Phase 1: native plugins (CPU-side kernels + speech/vision libs) ──"
build_native_plugin qjl-cpu              "$QJL_RVV"
build_native_plugin polarquant-cpu       "$POLAR_RVV"
build_native_plugin turboquant-cpu       "$TBQ_RVV"
build_native_plugin silero-vad-cpp       ""
build_native_plugin voice-classifier-cpp ""
build_native_plugin wakeword-cpp         ""
build_native_plugin yolo-cpp             ""
build_native_plugin face-cpp             ""
build_native_plugin doctr-cpp            ""

# ── libllama family (DFlash) ─────────────────────────────────────────
echo
echo "── Phase 2: libllama / libggml family (DFlash) ──"
COMPILE_LIBLLAMA="$repo_root/packages/app-core/scripts/aosp/compile-libllama.mjs"
if [ ! -f "$COMPILE_LIBLLAMA" ]; then
    echo "  ✗ compile-libllama.mjs missing at $COMPILE_LIBLLAMA"
    FAIL_N=$((FAIL_N+1))
else
    # compile-libllama.mjs exposes exactly one riscv64 target: android-riscv64-cpu.
    # Despite the name it produces a Linux/musl shared object — zig
    # `riscv64-linux-musl` driver, -DCMAKE_SYSTEM_NAME=Linux, no Android NDK in
    # the compile, strip via `zig objcopy` (NDK llvm-strip is only a non-fatal
    # last-resort fallback). So it is the canonical riscv64 libllama for both the
    # APK and bare Linux riscv64, and it does NOT require the NDK. (There is no
    # separate `linux-riscv64-cpu` libllama target; the earlier invocation of one
    # always threw "unsupported --target".)
    #
    # repoRoot inside compile-libllama resolves to the milady consumer root, so
    # its default --assets-dir/--src-dir would land in the wrong tree. Pin both
    # to this eliza checkout so the .so installs where check-riscv64-artifacts.sh
    # scans for it and the build uses the in-repo llama.cpp submodule.
    libllama_assets_dir="$repo_root/packages/app-core/platforms/android/app/src/main/assets/agent"
    libllama_sentinel="$libllama_assets_dir/riscv64/libllama.so"
    libllama_src_args=()
    if [ -f "$repo_root/plugins/plugin-local-inference/native/llama.cpp/CMakeLists.txt" ]; then
        libllama_src_args=(--src-dir "$repo_root/plugins/plugin-local-inference/native/llama.cpp")
    fi
    if should_build "$libllama_sentinel"; then
        echo "→ Building libllama (riscv64, zig/musl) …"
        mkdir -p "$repo_root/build"
        if "$NODE_BIN" "$COMPILE_LIBLLAMA" --target android-riscv64-cpu \
            --assets-dir "$libllama_assets_dir" \
            "${libllama_src_args[@]}" \
            >"$repo_root/build/libllama-riscv64.log" 2>&1; then
            echo "  ✓ libllama riscv64"
        else
            echo "  ✗ libllama riscv64 (see build/libllama-riscv64.log)"
            FAIL_N=$((FAIL_N+1))
        fi
    fi
fi

# ── libomnivoice ─────────────────────────────────────────────────────
echo
echo "── Phase 3: libomnivoice ──"
BUILD_OMNI="$repo_root/plugins/plugin-local-inference/native/build-omnivoice.mjs"
if [ ! -f "$BUILD_OMNI" ]; then
    echo "  ✗ build-omnivoice.mjs missing at $BUILD_OMNI"
    FAIL_N=$((FAIL_N+1))
else
    omni_sentinel="$repo_root/plugins/plugin-local-inference/native/build-omnivoice-linux-riscv64-cpu/libomnivoice.so"
    if should_build "$omni_sentinel"; then
        echo "→ Building libomnivoice (linux-riscv64-cpu) …"
        if OMNIVOICE_TARGET=linux-riscv64-cpu "$NODE_BIN" "$BUILD_OMNI" >"$repo_root/build/libomnivoice-linux-riscv64.log" 2>&1; then
            echo "  ✓ libomnivoice linux-riscv64-cpu"
        else
            echo "  ✗ libomnivoice linux-riscv64-cpu (see build/libomnivoice-linux-riscv64.log)"
            FAIL_N=$((FAIL_N+1))
        fi
    fi
fi

# ── libwhisper (Task 25) ─────────────────────────────────────────────
echo
echo "── Phase 4: libwhisper + libwhisper_eliza_adapter ──"
BUILD_WHISPER="$repo_root/plugins/plugin-local-inference/native/build-whisper.mjs"
if [ ! -f "$BUILD_WHISPER" ]; then
    echo "  ✗ build-whisper.mjs missing at $BUILD_WHISPER"
    FAIL_N=$((FAIL_N+1))
else
    wh_sentinel="$repo_root/plugins/plugin-local-inference/native/build-whisper-linux-riscv64-cpu/libwhisper_eliza_adapter.so"
    if should_build "$wh_sentinel"; then
        echo "→ Building libwhisper (linux-riscv64-cpu) …"
        if WHISPER_TARGET=linux-riscv64-cpu "$NODE_BIN" "$BUILD_WHISPER" >"$repo_root/build/libwhisper-linux-riscv64.log" 2>&1; then
            echo "  ✓ libwhisper linux-riscv64-cpu"
        else
            echo "  ✗ libwhisper linux-riscv64-cpu (see build/libwhisper-linux-riscv64.log)"
            FAIL_N=$((FAIL_N+1))
        fi
    fi
fi

# ── sigsys-handler-riscv64 ───────────────────────────────────────────
echo
echo "── Phase 5: libsigsys-handler-riscv64 (Bun seccomp shim) ──"
COMPILE_SHIM="$repo_root/packages/app-core/scripts/aosp/compile-shim.mjs"
if [ ! -f "$COMPILE_SHIM" ]; then
    echo "  ✗ compile-shim.mjs missing at $COMPILE_SHIM"
    FAIL_N=$((FAIL_N+1))
else
    shim_sentinel="${HOME}/.cache/eliza-android-agent/seccomp-shim/riscv64/libsigsys-handler.so"
    if should_build "$shim_sentinel"; then
        echo "→ Building libsigsys-handler (riscv64) …"
        mkdir -p "$repo_root/build"
        if "$NODE_BIN" "$COMPILE_SHIM" --abi riscv64 >"$repo_root/build/libsigsys-handler-riscv64.log" 2>&1; then
            echo "  ✓ libsigsys-handler riscv64"
        else
            echo "  ✗ libsigsys-handler riscv64 (see build/libsigsys-handler-riscv64.log)"
            FAIL_N=$((FAIL_N+1))
        fi
    fi
fi

echo
if [ "$FAIL_N" -gt 0 ]; then
    echo "[build-riscv64-artifacts] $FAIL_N build(s) failed."
    exit 1
fi
echo "[build-riscv64-artifacts] All riscv64 artifacts built (or already present)."
exit 0
