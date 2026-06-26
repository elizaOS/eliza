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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
ROOT_DIR="$SCRIPT_DIR"
SRC_DIR="$ROOT_DIR/src"
SHIM_DIR="$ROOT_DIR/shim"
DIST_DIR="$ROOT_DIR/dist"
BUILD_ROOT="$ROOT_DIR/build"
BUILD_LOCK_DIR="$BUILD_ROOT/.build-ios.lock"
RM_PATH_RECURSIVE=(node "$REPO_ROOT/packages/scripts/rm-path-recursive.mjs")

cmd="${1:-all}"

log() { printf '\033[34m[build-ios]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[build-ios:err]\033[0m %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }
rm_path_recursive() { "${RM_PATH_RECURSIVE[@]}" "$@"; }

case "$cmd" in
  all|device|simulator|clean) ;;
  *) die "unknown command: $cmd (use: all | device | simulator | clean)" ;;
esac

clean_all() {
  log "Cleaning $DIST_DIR and $BUILD_ROOT"
  rm_path_recursive "$DIST_DIR" "$BUILD_ROOT"
}

acquire_build_lock() {
  mkdir -p "$BUILD_ROOT"
  local waited=0
  until mkdir "$BUILD_LOCK_DIR" 2>/dev/null; do
    waited=$((waited + 1))
    if (( waited % 30 == 0 )); then
      log "Waiting for another iOS llama.cpp build to finish..."
    fi
    sleep 1
  done
  trap 'rm_path_recursive "$BUILD_LOCK_DIR"' EXIT
}

xcframework_is_present() {
  [[ -f "$DIST_DIR/LlamaCpp.xcframework/Info.plist" ]]
}

if [[ "$cmd" == "clean" ]]; then
  clean_all
  exit 0
fi

if [[ "$cmd" == "all" && "${ELIZA_LLAMA_FORCE_REBUILD:-0}" != "1" ]] && xcframework_is_present; then
  log "Reusing existing $DIST_DIR/LlamaCpp.xcframework (set ELIZA_LLAMA_FORCE_REBUILD=1 to rebuild)"
  exit 0
fi

if [[ "$cmd" == "all" && "${ELIZA_LLAMA_BUILD_IOS:-0}" != "1" ]]; then
  printf '\033[33m[build-ios]\033[0m iOS xcframework build not requested: set ELIZA_LLAMA_BUILD_IOS=1 to compile llama.cpp locally.\n'
  exit 0
fi

acquire_build_lock

if [[ "$cmd" == "all" && "${ELIZA_LLAMA_FORCE_REBUILD:-0}" != "1" ]] && xcframework_is_present; then
  log "Reusing existing $DIST_DIR/LlamaCpp.xcframework after lock wait (set ELIZA_LLAMA_FORCE_REBUILD=1 to rebuild)"
  exit 0
fi

# iOS cross-builds require a macOS host with Xcode (xcodebuild + xcrun).
# When invoked on a non-Darwin host (Linux CI, Linux dev box) this build is
# physically impossible — there's no iOS SDK to link against. Return cleanly
# so workspace-wide 'bun run build' / turbo build pipelines aren't blocked
# by an unbuildable target on the wrong host. The package.json declares
# `"os": ["darwin"]` but bun/turbo don't enforce that yet.
if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '\033[33m[build-ios]\033[0m iOS xcframework build unavailable: requires macOS host (uname=%s); workspace targets that need LlamaCpp.xcframework will lack it.\n' "$(uname -s)"
  exit 0
fi

if ! xcodebuild -version >/dev/null 2>&1 || ! xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
  printf '\033[33m[build-ios]\033[0m iOS xcframework build unavailable: requires full Xcode with the iOS SDK; active developer tools are insufficient.\n'
  exit 0
fi

LLAMA_CPP_VERSION_FILE="$ROOT_DIR/../VERSIONS"

# Read pinned ref (tag, branch name, or commit SHA).
if [[ -f "$LLAMA_CPP_VERSION_FILE" ]]; then
  PINNED_REF="$(awk -F= '$1 == "llama.cpp" { print $2; exit }' "$LLAMA_CPP_VERSION_FILE")"
fi
[[ -n "${PINNED_REF:-}" && "$PINNED_REF" != excluded-* ]] \
  || die "missing llama.cpp pin in $LLAMA_CPP_VERSION_FILE"

# Source repo. Defaults to the elizaOS-controlled fork (carries the
# elizaOS kernels + MTP); override with LLAMA_CPP_REPO env var if you
# need to point at stock upstream (e.g. for an A/B parity check).
LLAMA_CPP_REPO="${LLAMA_CPP_REPO:-https://github.com/elizaOS/llama.cpp}"

iOS_DEPLOYMENT_TARGET="${ELIZA_IOS_MIN_VERSION:-15.0}"

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
    && if git remote get-url origin >/dev/null 2>&1; then \
      git remote set-url origin "$LLAMA_CPP_REPO"; \
    else \
      git remote add origin "$LLAMA_CPP_REPO"; \
    fi \
    && (git fetch --depth 1 origin "$PINNED_REF" \
      || { matched_ref="$(git ls-remote origin | awk -v ref="$PINNED_REF" 'index($1, ref) == 1 { print $2; exit }')" \
        && [[ -n "$matched_ref" ]] \
        && git fetch --depth 1 origin "$matched_ref"; }) \
    && git checkout --quiet FETCH_HEAD ) \
    || die "fetch/checkout failed; verify '$PINNED_REF' exists at $LLAMA_CPP_REPO"
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
  rm_path_recursive "$build_dir" "$install_dir"
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
    # Metal in the iOS simulator on Apple Silicon Macs is supported but flaky
    # across SDK versions. Default to CPU-only in the simulator slice; users
    # who specifically want Metal-on-simulator can flip this back on.
    metal_flag="${ELIZA_LLAMA_SIM_METAL:-OFF}"
  fi
  local sdk_name
  sdk_name="$(sysroot_to_sdk "$sysroot")"
  local cmake_c_compiler
  local cmake_cxx_compiler
  cmake_c_compiler="$(xcrun --sdk "$sdk_name" --find clang)" \
    || die "unable to locate clang for $sdk_name"
  cmake_cxx_compiler="$(xcrun --sdk "$sdk_name" --find clang++)" \
    || die "unable to locate clang++ for $sdk_name"

  pushd "$build_dir" >/dev/null

  cmake "$SRC_DIR" \
    -G Xcode \
    -DCMAKE_C_COMPILER="$cmake_c_compiler" \
    -DCMAKE_CXX_COMPILER="$cmake_cxx_compiler" \
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

  mkdir -p "$build_dir/ggml/src/ggml-metal/autogenerated"

  local xcode_jobs="${ELIZA_LLAMA_XCODE_JOBS:-1}"
  local xcode_timeout="${ELIZA_LLAMA_XCODE_TIMEOUT_SECONDS:-300}"
  # `cmake --build` adds `-parallelizeTargets` for Xcode projects. llama.cpp's
  # generated iOS project can race inside Xcode's shared build database even
  # with `-jobs 1`, so invoke xcodebuild directly and serialize target builds.
  local xcode_log="$build_dir/xcodebuild-$slice.log"
  local xcode_output=("$xcode_log")
  if [[ "${ELIZA_LLAMA_XCODE_VERBOSE:-0}" == "1" ]]; then
    xcode_output=("/dev/stdout")
  fi
  log "Running xcodebuild for $slice (log: $xcode_log)"
  xcodebuild \
    -project "$build_dir/llama.cpp.xcodeproj" \
    build \
    -target llama-common \
    -configuration Release \
    -jobs "$xcode_jobs" \
    -hideShellScriptEnvironment \
    >"${xcode_output[0]}" 2>&1 &
  local xcode_pid=$!
  local elapsed=0
  while kill -0 "$xcode_pid" 2>/dev/null; do
    if (( elapsed >= xcode_timeout )); then
      err "xcodebuild timed out after ${xcode_timeout}s for slice $slice"
      kill "$xcode_pid" 2>/dev/null || true
      wait "$xcode_pid" 2>/dev/null || true
      popd >/dev/null
      return 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
    if (( elapsed % 60 == 0 )); then
      log "Still building $slice with xcodebuild (${elapsed}s elapsed)"
    fi
  done
  if ! wait "$xcode_pid"; then
    err "xcodebuild failed for slice $slice; last log lines:"
    tail -n 200 "$xcode_log" >&2 || true
    popd >/dev/null
    return 1
  fi
  log "xcodebuild completed for $slice"
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
    err "no .a files produced in $build_dir — build likely failed"
    return 1
  fi

  # Compile the LlamaShim.c as well, into its own .a, and add to the bundle.
  log "Compiling LlamaShim.c for slice $slice …"
  local shim_obj="$build_dir/llama_shim.o"
  local shim_archive="$build_dir/libllama_shim.a"
  local sdk_path
  sdk_path="$(xcrun --sdk "$sdk_name" --show-sdk-path)"
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
  rm_path_recursive "$out"

  local args=()
  if [[ -f "$DIST_DIR/ios-arm64/libllama.a" ]]; then
    args+=(-library "$DIST_DIR/ios-arm64/libllama.a" -headers "$DIST_DIR/ios-arm64/Headers")
  fi
  if [[ -f "$DIST_DIR/ios-arm64-simulator/libllama.a" ]]; then
    args+=(-library "$DIST_DIR/ios-arm64-simulator/libllama.a" -headers "$DIST_DIR/ios-arm64-simulator/Headers")
  fi
  if [[ ${#args[@]} -eq 0 ]]; then
    err "no slices to assemble into xcframework"
    return 1
  fi

  log "Assembling $out"
  xcodebuild -create-xcframework "${args[@]}" -output "$out"
  log "Done: $out"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  require_cmd cmake
  require_cmd xcodebuild
  require_cmd xcrun
  require_cmd git

  case "$cmd" in
    device)
      ensure_source_checkout
      build_slice "ios-arm64" "iOS" "iphoneos" "arm64" || return 1
      ;;
    simulator)
      ensure_source_checkout
      build_slice "ios-arm64-simulator" "iOS" "iphonesimulator" "arm64" || return 1
      ;;
    all)
      ensure_source_checkout
      build_slice "ios-arm64" "iOS" "iphoneos" "arm64" || return 1
      build_slice "ios-arm64-simulator" "iOS" "iphonesimulator" "arm64" || return 1
      build_xcframework || return 1
      log "All done. Point a podspec at $DIST_DIR/LlamaCpp.xcframework via :vendored_frameworks."
      ;;
  esac
}

if ! main "$@"; then
  if [[ "${ELIZA_LLAMA_IOS_REQUIRED:-0}" == "1" ]]; then
    die "iOS llama.cpp build failed"
  fi
  printf '\033[33m[build-ios]\033[0m iOS xcframework build unavailable: local Xcode toolchain failed; set ELIZA_LLAMA_IOS_REQUIRED=1 to make this fatal.\n'
  exit 0
fi
