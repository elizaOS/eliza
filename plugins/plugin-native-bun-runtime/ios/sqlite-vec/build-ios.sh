#!/usr/bin/env bash
# build-ios.sh - Cross-build sqlite-vec into an xcframework for iOS.
#
# Produces:
#   dist/ios-arm64/libsqlite_vec.a
#   dist/ios-arm64-simulator/libsqlite_vec.a
#   dist/SqliteVec.xcframework
#
# Usage:
#   ELIZA_SQLITE_VEC_BUILD_IOS=1 ./build-ios.sh  # both slices + xcframework
#   ./build-ios.sh device                # device slice only
#   ./build-ios.sh simulator             # simulator slice only
#   ./build-ios.sh clean                 # nuke dist/ and build trees

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
ROOT_DIR="$SCRIPT_DIR"
SRC_DIR="$ROOT_DIR/src"
DIST_DIR="$ROOT_DIR/dist"
BUILD_ROOT="$ROOT_DIR/build"
BUILD_LOCK_DIR="$BUILD_ROOT/.build-ios.lock"
VERSION_FILE="$ROOT_DIR/VERSION"
SQLITE_VEC_REPO="${SQLITE_VEC_REPO:-https://github.com/asg017/sqlite-vec}"
IOS_DEPLOYMENT_TARGET="${ELIZA_IOS_MIN_VERSION:-16.0}"
RM_PATH_RECURSIVE=(node "$REPO_ROOT/packages/scripts/rm-path-recursive.mjs")

cmd="${1:-all}"

log() { printf '\033[34m[sqlite-vec-ios]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[sqlite-vec-ios:err]\033[0m %s\n' "$*" >&2; }
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

if [[ "$cmd" == "clean" ]]; then
  clean_all
  exit 0
fi

if [[ "$cmd" == "all" && "${ELIZA_SQLITE_VEC_BUILD_IOS:-0}" != "1" && "${ELIZA_SQLITE_VEC_FORCE_REBUILD:-0}" != "1" ]]; then
  log "Build not requested: set ELIZA_SQLITE_VEC_BUILD_IOS=1 to compile sqlite-vec locally."
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "iOS xcframework build requires macOS; host is $(uname -s)"
fi

if ! xcodebuild -version >/dev/null 2>&1 || ! xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
  die "iOS xcframework build requires full Xcode with the iOS SDK"
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
  trap 'rm_path_recursive "$BUILD_LOCK_DIR"' EXIT
}

ensure_source_checkout() {
  mkdir -p "$SRC_DIR"
  (
    cd "$SRC_DIR"
    git init -q || die "cannot initialize sqlite-vec checkout"
    [[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "sqlite-vec checkout has local changes: $SRC_DIR"
    if git remote get-url origin >/dev/null 2>&1; then
      git remote set-url origin "$SQLITE_VEC_REPO" || die "cannot set sqlite-vec remote"
    else
      git remote add origin "$SQLITE_VEC_REPO" || die "cannot add sqlite-vec remote"
    fi
    git fetch --depth 1 origin "$PINNED_REF" || die "cannot fetch sqlite-vec pin $PINNED_REF"
    git checkout --quiet --detach FETCH_HEAD || die "cannot check out sqlite-vec pin $PINNED_REF"
  ) || die "fetch/checkout failed; verify '$PINNED_REF' exists at $SQLITE_VEC_REPO"
  [[ -f "$SRC_DIR/sqlite-vec.c" ]] || die "sqlite-vec.c missing at the pinned revision"
}

# Generate the upstream public header from immutable source-version metadata.
generate_header() {
  python3 - "$SRC_DIR" "$BUILD_ROOT/sqlite-vec.h" <<'HEADER'
from pathlib import Path
import re
import subprocess
import sys
source = Path(sys.argv[1])
version = (source / "VERSION").read_text().strip()
match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", version)
if not match:
    raise SystemExit(f"Invalid sqlite-vec source version: {version}")
def git(*args):
    return subprocess.check_output(["git", "-C", str(source), *args], text=True).strip()
values = dict(zip(["VERSION_MAJOR", "VERSION_MINOR", "VERSION_PATCH"], match.groups()))
values.update(VERSION=version, DATE=git("log", "-1", "--format=%cI", "--", "VERSION"),
              SOURCE=git("log", "-1", "--format=%H", "--", "VERSION"))
header = (source / "sqlite-vec.h.tmpl").read_text()
header = re.sub(r"\$\{(\w+)\}", lambda m: values[m[1]], header)
Path(sys.argv[2]).write_text(header)
HEADER
}

build_slice() {
  local slice="$1"
  local sdk="$2"
  local target="$3"
  local build_dir="$BUILD_ROOT/$slice"
  local install_dir="$DIST_DIR/$slice"
  local sdk_path
  sdk_path="$(xcrun --sdk "$sdk" --show-sdk-path)"

  log "Building slice: $slice (target=$target)"
  rm_path_recursive "$build_dir" "$install_dir"
  mkdir -p "$build_dir" "$install_dir/Headers"
  xcrun --sdk "$sdk" clang -target "$target" -isysroot "$sdk_path" \
    -O3 -fPIC -Werror=unguarded-availability-new -DSQLITE_CORE -DSQLITE_VEC_STATIC -DSQLITE_VEC_ENABLE_NEON \
    -I"$BUILD_ROOT" -c "$SRC_DIR/sqlite-vec.c" -o "$build_dir/sqlite-vec.o"
  xcrun --sdk "$sdk" libtool -static -o "$install_dir/libsqlite_vec.a" "$build_dir/sqlite-vec.o"
  cp "$BUILD_ROOT/sqlite-vec.h" "$install_dir/Headers/"
}

create_xcframework() {
  [[ -f "$DIST_DIR/ios-arm64/libsqlite_vec.a" ]] || die "missing device slice"
  [[ -f "$DIST_DIR/ios-arm64-simulator/libsqlite_vec.a" ]] || die "missing simulator slice"
  rm_path_recursive "$DIST_DIR/SqliteVec.xcframework"
  xcodebuild -create-xcframework \
    -library "$DIST_DIR/ios-arm64/libsqlite_vec.a" \
    -headers "$DIST_DIR/ios-arm64/Headers" \
    -library "$DIST_DIR/ios-arm64-simulator/libsqlite_vec.a" \
    -headers "$DIST_DIR/ios-arm64-simulator/Headers" \
    -output "$DIST_DIR/SqliteVec.xcframework"
}

require_cmd git
require_cmd python3
acquire_build_lock
ensure_source_checkout
generate_header

case "$cmd" in
  all)
    build_slice ios-arm64 iphoneos "arm64-apple-ios${IOS_DEPLOYMENT_TARGET}"
    build_slice ios-arm64-simulator iphonesimulator "arm64-apple-ios${IOS_DEPLOYMENT_TARGET}-simulator"
    create_xcframework
    ;;
  device)
    build_slice ios-arm64 iphoneos "arm64-apple-ios${IOS_DEPLOYMENT_TARGET}"
    ;;
  simulator)
    build_slice ios-arm64-simulator iphonesimulator "arm64-apple-ios${IOS_DEPLOYMENT_TARGET}-simulator"
    ;;
esac

log "Done."
