#!/usr/bin/env bash
# build-ios.sh — Cross-builds llama.cpp into an xcframework for iOS.
#
# Produces:
#   dist/ios-arm64/libllama.a               (device, arm64)
#   dist/ios-arm64-simulator/libllama.a     (simulator, arm64 — for Apple Silicon Macs)
#   dist/LlamaCpp.xcframework               (universal bundle: device + simulator)
#   dist/LlamaCpp.xcframework/.../Headers/  (public llama.h + LlamaShim.h)
#   dist/LlamaCpp.xcframework/.../default.metallib   (Metal shaders, baked once at build time)
#
# After running this, the bun-runtime Pod links against LlamaCpp.xcframework
# (configured via its podspec — see the note at the bottom of this script).
#
# Requirements:
#   - macOS host with full Xcode (Command Line Tools alone won't ship the
#     iOS SDK or `xcrun --sdk iphoneos`).
#   - cmake >= 3.21 (xcframework support requires modern cmake).
#   - The llama.cpp checkout pinned in `../VERSIONS` cloned into `./src/`.
#
# Usage:
#   ./build-ios.sh                       # build both slices + xcframework
#   ./build-ios.sh device                # device slice only (faster)
#   ./build-ios.sh simulator             # simulator slice only
#   ./build-ios.sh clean                 # nuke dist/ and build trees

set -euo pipefail

# iOS cross-builds require a macOS host with Xcode (xcodebuild + xcrun).
# When invoked on a non-Darwin host (Linux CI, Linux dev box) this build is
# physically impossible — there's no iOS SDK to link against. Skip cleanly
# so workspace-wide 'bun run build' / turbo build pipelines aren't blocked
# by an unbuildable target on the wrong host. The package.json declares
# `"os": ["darwin"]` but bun/turbo don't enforce that yet.
if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '\033[33m[build-ios]\033[0m skipping iOS xcframework build: requires macOS host (uname=%s); workspace targets that need LlamaCpp.xcframework will lack it.\n' "$(uname -s)"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
SRC_DIR="$ROOT_DIR/src"
SHIM_DIR="$ROOT_DIR/shim"
DIST_DIR="$ROOT_DIR/dist"
BUILD_ROOT="$ROOT_DIR/build"

LLAMA_CPP_VERSION_FILE="$ROOT_DIR/../VERSIONS"

# Read pinned ref (line starting with `llama.cpp=`). May be a tag,
# branch name, or commit SHA — anything `git fetch` accepts.
PINNED_REF=""
if [[ -f "$LLAMA_CPP_VERSION_FILE" ]]; then
  PINNED_REF="$(grep -E '^llama\.cpp=' "$LLAMA_CPP_VERSION_FILE" | head -1 | cut -d= -f2 || true)"
fi
if [[ -z "$PINNED_REF" || "$PINNED_REF" == PLACEHOLDER* ]]; then
  PINNED_REF="main"   # fallback: track elizaOS fork tip; override in VERSIONS
fi

# Source repo. Defaults to the milady-controlled fork (carries the
# elizaOS kernels + DFlash); override with LLAMA_CPP_REPO env var if you
# need to point at stock upstream (e.g. for an A/B parity check).
LLAMA_CPP_REPO="${LLAMA_CPP_REPO:-https://github.com/elizaOS/llama.cpp}"

iOS_DEPLOYMENT_TARGET="${MILADY_IOS_MIN_VERSION:-15.0}"

# ─── Helpers ──────────────────────────────────────────────────────────────────

log() { printf '\033[34m[build-ios]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[build-ios:err]\033[0m %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

ensure_source_checkout() {
  if [[ -f "$SRC_DIR/CMakeLists.txt" ]]; then
    log "llama.cpp source present at $SRC_DIR"
    return
  fi
  log "Cloning $LLAMA_CPP_REPO @ $PINNED_REF into $SRC_DIR …"
  mkdir -p "$SRC_DIR"
  # Init-then-fetch lets us resolve $PINNED_REF whether it's a tag, a
  # branch name, or a raw commit SHA. `git clone --branch` would refuse
  # a SHA, and the elizaOS fork pins by SHA, not by upstream-style tag.
  ( cd "$SRC_DIR" \
    && git init -q \
    && git remote add origin "$LLAMA_CPP_REPO" \
    && git fetch --depth 1 origin "$PINNED_REF" \
    && git checkout --quiet FETCH_HEAD ) \
    || die "fetch/checkout failed; verify '$PINNED_REF' exists at $LLAMA_CPP_REPO"
}

clean_all() {
  log "Cleaning $DIST_DIR and $BUILD_ROOT"
  rm -rf "$DIST_DIR" "$BUILD_ROOT"
}

# ─── Per-slice build ──────────────────────────────────────────────────────────

# Args: <slice-name> <cmake-system-name> <cmake-osx-sysroot> <cmake-osx-architectures>
build_slice() {
  local slice="$1"
  local system_name="$2"
  local sysroot="$3"
  local archs="$4"

  local build_dir="$BUILD_ROOT/$slice"
  local install_dir="$DIST_DIR/$slice"

  log "── Building slice: $slice (sysroot=$sysroot archs=$archs)"
  rm -rf "$build_dir" "$install_dir"
  mkdir -p "$build_dir" "$install_dir"

  # Notes on CMake flags:
  #   GGML_METAL=ON           — Metal backend; only meaningful for device.
  #   GGML_METAL_EMBED_LIBRARY=ON — bake Metal shaders into the static lib so
  #                              consumers don't need to ship `default.metallib`.
  #   GGML_NATIVE=OFF         — don't probe for host CPU; we're cross-compiling.
  #   GGML_ACCELERATE=ON      — use Apple's Accelerate framework on the CPU path.
  #   BUILD_SHARED_LIBS=OFF   — static, so we can roll multiple .a files into
  #                              one fat archive + xcframework.
  #   LLAMA_BUILD_TESTS=OFF / LLAMA_BUILD_EXAMPLES=OFF — keep build small.
  #   CMAKE_OSX_DEPLOYMENT_TARGET=15.0 — matches the Capacitor app target.

  local metal_flag="ON"
  if [[ "$slice" == "ios-arm64-simulator" ]]; then
    # Metal in the iOS simulator on Apple Silicon Macs is supported but flakey
    # across SDK versions. Default to CPU-only in the simulator slice; users
    # who specifically want Metal-on-simulator can flip this back on.
    metal_flag="${MILADY_LLAMA_SIM_METAL:-OFF}"
  fi

  pushd "$build_dir" >/dev/null

  cmake "$SRC_DIR" \
    -G Xcode \
    -DCMAKE_SYSTEM_NAME="$system_name" \
    -DCMAKE_OSX_SYSROOT="$sysroot" \
    -DCMAKE_OSX_ARCHITECTURES="$archs" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$iOS_DEPLOYMENT_TARGET" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_NATIVE=OFF \
    -DGGML_METAL="$metal_flag" \
    -DGGML_METAL_EMBED_LIBRARY=ON \
    -DGGML_ACCELERATE=ON \
    -DGGML_BLAS=OFF \
    -DGGML_OPENMP=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_BUILD_SERVER=OFF \
    -DLLAMA_CURL=OFF \
    -DCMAKE_XCODE_ATTRIBUTE_ONLY_ACTIVE_ARCH=NO

  cmake --build . --config Release --target llama --target ggml --target common
  popd >/dev/null

  # Locate produced .a files and fold them into a single libllama.a so
  # consumers only have to link one library.
  local out_archive="$install_dir/libllama.a"
  local search_root="$build_dir"
  local archives=()
  while IFS= read -r -d '' a; do
    archives+=("$a")
  done < <(find "$search_root" \( -name "libllama.a" -o -name "libggml*.a" -o -name "libcommon.a" \) -print0)

  if [[ ${#archives[@]} -eq 0 ]]; then
    die "no .a files produced in $build_dir — build likely failed"
  fi

  # Compile the LlamaShim.c as well, into its own .a, and add to the bundle.
  log "Compiling LlamaShim.c for slice $slice …"
  local shim_obj="$build_dir/llama_shim.o"
  local shim_archive="$build_dir/libllama_shim.a"
  local sdk_path
  sdk_path="$(xcrun --sdk "$(sysroot_to_sdk "$sysroot")" --show-sdk-path)"
  local arch_flags=""
  IFS=';' read -ra arch_list <<< "$archs"
  for a in "${arch_list[@]}"; do arch_flags+="-arch $a "; done
  local platform_flag
  platform_flag="$(platform_min_flag "$slice")"

  xcrun clang \
    -isysroot "$sdk_path" \
    $arch_flags \
    $platform_flag \
    -O2 \
    -fPIC \
    -I"$SRC_DIR/include" \
    -I"$SRC_DIR/ggml/include" \
    -I"$SHIM_DIR" \
    -c "$SHIM_DIR/LlamaShim.c" \
    -o "$shim_obj"
  xcrun libtool -static -o "$shim_archive" "$shim_obj"
  archives+=("$shim_archive")

  log "Combining ${#archives[@]} archives into $out_archive"
  xcrun libtool -static -o "$out_archive" "${archives[@]}"

  # Stage headers.
  local headers_dir="$install_dir/Headers"
  mkdir -p "$headers_dir"
  cp "$SRC_DIR/include/llama.h" "$headers_dir/"
  cp "$SRC_DIR/ggml/include/ggml.h" "$headers_dir/" 2>/dev/null || true
  cp "$SHIM_DIR/LlamaShim.h" "$headers_dir/"
  log "Slice $slice → $out_archive ($(du -h "$out_archive" | cut -f1))"
}

sysroot_to_sdk() {
  case "$1" in
    iphoneos)            echo iphoneos ;;
    iphonesimulator)     echo iphonesimulator ;;
    *)                   echo "$1" ;;
  esac
}

platform_min_flag() {
  case "$1" in
    ios-arm64)            echo "-mios-version-min=$iOS_DEPLOYMENT_TARGET" ;;
    ios-arm64-simulator)  echo "-mios-simulator-version-min=$iOS_DEPLOYMENT_TARGET" ;;
  esac
}

# ─── xcframework assembly ─────────────────────────────────────────────────────

build_xcframework() {
  local out="$DIST_DIR/LlamaCpp.xcframework"
  rm -rf "$out"

  local args=()
  if [[ -f "$DIST_DIR/ios-arm64/libllama.a" ]]; then
    args+=(-library "$DIST_DIR/ios-arm64/libllama.a" -headers "$DIST_DIR/ios-arm64/Headers")
  fi
  if [[ -f "$DIST_DIR/ios-arm64-simulator/libllama.a" ]]; then
    args+=(-library "$DIST_DIR/ios-arm64-simulator/libllama.a" -headers "$DIST_DIR/ios-arm64-simulator/Headers")
  fi
  if [[ ${#args[@]} -eq 0 ]]; then
    die "no slices to assemble into xcframework"
  fi

  log "Assembling $out"
  xcodebuild -create-xcframework "${args[@]}" -output "$out"
  log "Done: $out"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  local cmd="${1:-all}"

  require_cmd cmake
  require_cmd xcodebuild
  require_cmd xcrun
  require_cmd git

  case "$cmd" in
    clean)
      clean_all
      ;;
    device)
      ensure_source_checkout
      build_slice "ios-arm64" "iOS" "iphoneos" "arm64"
      ;;
    simulator)
      ensure_source_checkout
      build_slice "ios-arm64-simulator" "iOS" "iphonesimulator" "arm64"
      ;;
    all|"")
      ensure_source_checkout
      build_slice "ios-arm64" "iOS" "iphoneos" "arm64"
      build_slice "ios-arm64-simulator" "iOS" "iphonesimulator" "arm64"
      build_xcframework
      log "All done. Point a podspec at $DIST_DIR/LlamaCpp.xcframework via :vendored_frameworks."
      ;;
    *)
      die "unknown command: $cmd (use: all | device | simulator | clean)"
      ;;
  esac
}

main "$@"
