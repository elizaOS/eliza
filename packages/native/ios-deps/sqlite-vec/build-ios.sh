#!/usr/bin/env bash
# build-ios.sh - Cross-build sqlite-vec into an xcframework for iOS.
#
# Produces:
#   dist/ios-arm64/libsqlite_vec.a
#   dist/ios-arm64-simulator/libsqlite_vec.a
#   dist/SqliteVec.xcframework
#
# Usage:
#   ./build-ios.sh                       # build both slices + xcframework
#   ./build-ios.sh device                # device slice only
#   ./build-ios.sh simulator             # simulator slice only
#   ./build-ios.sh clean                 # nuke dist/ and build trees

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
SRC_DIR="$ROOT_DIR/src"
DIST_DIR="$ROOT_DIR/dist"
BUILD_ROOT="$ROOT_DIR/build"
BUILD_LOCK_DIR="$BUILD_ROOT/.build-ios.lock"
VERSION_FILE="$ROOT_DIR/../VERSIONS"
SQLITE_VEC_REPO="${SQLITE_VEC_REPO:-https://github.com/asg017/sqlite-vec}"
IOS_DEPLOYMENT_TARGET="${ELIZA_IOS_MIN_VERSION:-15.0}"

cmd="${1:-all}"

log() { printf '\033[34m[sqlite-vec-ios]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[sqlite-vec-ios:err]\033[0m %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

case "$cmd" in
  all|device|simulator|clean) ;;
  *) die "unknown command: $cmd (use: all | device | simulator | clean)" ;;
esac

clean_all() {
  log "Cleaning $DIST_DIR and $BUILD_ROOT"
  rm -rf "$DIST_DIR" "$BUILD_ROOT"
}

if [[ "$cmd" == "clean" ]]; then
  clean_all
  exit 0
fi

xcframework_is_present() {
  [[ -f "$DIST_DIR/SqliteVec.xcframework/Info.plist" ]]
}

if [[ "$cmd" == "all" && "${ELIZA_SQLITE_VEC_FORCE_REBUILD:-0}" != "1" ]] && xcframework_is_present; then
  log "Reusing existing $DIST_DIR/SqliteVec.xcframework (set ELIZA_SQLITE_VEC_FORCE_REBUILD=1 to rebuild)"
  exit 0
fi

if [[ "$cmd" == "all" && "${ELIZA_SQLITE_VEC_BUILD_IOS:-0}" != "1" ]]; then
  printf '\033[33m[sqlite-vec-ios]\033[0m iOS xcframework build not requested: set ELIZA_SQLITE_VEC_BUILD_IOS=1 to compile sqlite-vec locally.\n'
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '\033[33m[sqlite-vec-ios]\033[0m iOS xcframework build unavailable: requires macOS host (uname=%s).\n' "$(uname -s)"
  exit 0
fi

if ! xcodebuild -version >/dev/null 2>&1 || ! xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
  printf '\033[33m[sqlite-vec-ios]\033[0m iOS xcframework build unavailable: requires full Xcode with the iOS SDK.\n'
  exit 0
fi

PINNED_REF="$(awk -F= '$1 == "sqlite-vec" { print $2; exit }' "$VERSION_FILE" 2>/dev/null || true)"
[[ -n "$PINNED_REF" ]] || die "missing sqlite-vec pin in $VERSION_FILE"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

acquire_build_lock() {
  mkdir -p "$BUILD_ROOT"
  local waited=0
  until mkdir "$BUILD_LOCK_DIR" 2>/dev/null; do
    waited=$((waited + 1))
    if (( waited % 30 == 0 )); then
      log "Waiting for another sqlite-vec iOS build to finish..."
    fi
    sleep 1
  done
  trap 'rm -rf "$BUILD_LOCK_DIR"' EXIT
}

ensure_source_checkout() {
  if [[ -f "$SRC_DIR/CMakeLists.txt" ]]; then
    log "sqlite-vec source present at $SRC_DIR"
    return
  fi
  log "Cloning $SQLITE_VEC_REPO @ $PINNED_REF into $SRC_DIR"
  mkdir -p "$SRC_DIR"
  (
    cd "$SRC_DIR"
    git init -q
    if git remote get-url origin >/dev/null 2>&1; then
      git remote set-url origin "$SQLITE_VEC_REPO"
    else
      git remote add origin "$SQLITE_VEC_REPO"
    fi
    git fetch --depth 1 origin "$PINNED_REF"
    git checkout --quiet FETCH_HEAD
  ) || die "fetch/checkout failed; verify '$PINNED_REF' exists at $SQLITE_VEC_REPO"
}

find_static_lib() {
  local build_dir="$1"
  find "$build_dir" -type f \( -name 'libsqlite_vec.a' -o -name 'libsqlite-vec.a' -o -name 'sqlite_vec.a' \) | head -1
}

find_header_dir() {
  local header
  header="$(find "$SRC_DIR" -type f \( -name 'sqlite-vec.h' -o -name 'sqlite_vec.h' \) | head -1)"
  [[ -n "$header" ]] || die "sqlite-vec public header not found in $SRC_DIR"
  dirname "$header"
}

sysroot_to_sdk() {
  case "$1" in
    iphoneos) echo "iphoneos" ;;
    iphonesimulator) echo "iphonesimulator" ;;
    *) die "unknown sysroot: $1" ;;
  esac
}

build_slice() {
  local slice="$1"
  local sysroot="$2"
  local archs="$3"
  local build_dir="$BUILD_ROOT/$slice"
  local install_dir="$DIST_DIR/$slice"
  local sdk_name c_compiler cxx_compiler lib_path header_dir

  sdk_name="$(sysroot_to_sdk "$sysroot")"
  c_compiler="$(xcrun --sdk "$sdk_name" --find clang)" || die "unable to locate clang for $sdk_name"
  cxx_compiler="$(xcrun --sdk "$sdk_name" --find clang++)" || die "unable to locate clang++ for $sdk_name"

  log "Building slice: $slice (sysroot=$sysroot archs=$archs)"
  rm -rf "$build_dir" "$install_dir"
  mkdir -p "$build_dir" "$install_dir"

  cmake -S "$SRC_DIR" -B "$build_dir" -G Xcode \
    -DCMAKE_C_COMPILER="$c_compiler" \
    -DCMAKE_CXX_COMPILER="$cxx_compiler" \
    -DCMAKE_SYSTEM_NAME=iOS \
    -DCMAKE_OSX_SYSROOT="$sysroot" \
    -DCMAKE_OSX_ARCHITECTURES="$archs" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$IOS_DEPLOYMENT_TARGET" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DSQLITE_VEC_ENABLE_AVX=OFF \
    -DSQLITE_VEC_ENABLE_NEON=ON \
    -DCMAKE_XCODE_ATTRIBUTE_ONLY_ACTIVE_ARCH=NO

  cmake --build "$build_dir" --config Release

  lib_path="$(find_static_lib "$build_dir")"
  [[ -n "$lib_path" ]] || die "sqlite-vec static library not found under $build_dir"
  header_dir="$(find_header_dir)"

  cp "$lib_path" "$install_dir/libsqlite_vec.a"
  mkdir -p "$install_dir/Headers"
  cp "$header_dir"/*.h "$install_dir/Headers/"
}

create_xcframework() {
  [[ -f "$DIST_DIR/ios-arm64/libsqlite_vec.a" ]] || die "missing device slice"
  [[ -f "$DIST_DIR/ios-arm64-simulator/libsqlite_vec.a" ]] || die "missing simulator slice"
  rm -rf "$DIST_DIR/SqliteVec.xcframework"
  xcodebuild -create-xcframework \
    -library "$DIST_DIR/ios-arm64/libsqlite_vec.a" \
    -headers "$DIST_DIR/ios-arm64/Headers" \
    -library "$DIST_DIR/ios-arm64-simulator/libsqlite_vec.a" \
    -headers "$DIST_DIR/ios-arm64-simulator/Headers" \
    -output "$DIST_DIR/SqliteVec.xcframework"
}

require_cmd git
require_cmd cmake
acquire_build_lock
ensure_source_checkout

case "$cmd" in
  all)
    build_slice ios-arm64 iphoneos arm64
    build_slice ios-arm64-simulator iphonesimulator arm64
    create_xcframework
    ;;
  device)
    build_slice ios-arm64 iphoneos arm64
    ;;
  simulator)
    build_slice ios-arm64-simulator iphonesimulator arm64
    ;;
esac

log "Done."
