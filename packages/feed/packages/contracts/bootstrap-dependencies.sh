#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$ROOT_DIR/../../../.." && pwd)"
DEPS_DIR="$ROOT_DIR/dependencies"
RM_PATH_RECURSIVE="$REPO_ROOT/packages/scripts/rm-path-recursive.mjs"

download_dependency() {
  local name="$1"
  local version="$2"
  local url="$3"
  local checksum="$4"
  local target_dir="$DEPS_DIR/${name}-${version}"

  if [[ -d "$target_dir" ]]; then
    return 0
  fi

  mkdir -p "$target_dir"

  local tmpdir
  tmpdir="$(mktemp -d)"
  local archive_path="$tmpdir/dependency.zip"

  echo "Downloading ${name}@${version}..."
  curl -fsSL "$url" -o "$archive_path"

  local actual_checksum
  actual_checksum="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
  if [[ "$actual_checksum" != "$checksum" ]]; then
    echo "Checksum mismatch for ${name}@${version}" >&2
    echo "Expected: $checksum" >&2
    echo "Actual:   $actual_checksum" >&2
    exit 1
  fi

  unzip -q "$archive_path" -d "$target_dir"
  node "$RM_PATH_RECURSIVE" "$tmpdir"
}

download_dependency \
  "@openzeppelin-contracts" \
  "5.4.0" \
  "https://soldeer-revisions.s3.amazonaws.com/@openzeppelin-contracts/5_4_0_19-07-2025_08:59:41_contracts.zip" \
  "3dd38f17610dba4602bd008ee2cb551e51e97d7b4ce04e1ffdf853da832942fa"

download_dependency \
  "forge-std" \
  "1.9.7" \
  "https://soldeer-revisions.s3.amazonaws.com/forge-std/1_9_7_28-04-2025_15:55:08_forge-std-1.9.zip" \
  "8d9e0a885fa8ee6429a4d344aeb6799119f6a94c7c4fe6f188df79b0dce294ba"
