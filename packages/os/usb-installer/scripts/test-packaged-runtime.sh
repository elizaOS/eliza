#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Packaged runtime smoke currently supports macOS only." >&2
  exit 1
fi

artifact="${1:-}"
if [[ -z "$artifact" || ! -f "$artifact" ]]; then
  echo "Usage: $0 <path-to-electrobun-app.tar.zst>" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
usb_package="$repo_root/usb-installer"
stage_dir="$(mktemp -d /tmp/elizaos-electrobun-runtime.XXXXXX)"
cleanup() {
  rm -R "$stage_dir"
}
trap cleanup EXIT INT TERM

zstd_bin="${ELIZAOS_ZSTD_BIN:-}"
if [[ -z "$zstd_bin" ]]; then
  zstd_bin="$(command -v zstd || true)"
fi
if [[ -z "$zstd_bin" || ! -x "$zstd_bin" ]]; then
  echo "zstd is required to inspect the Electrobun artifact." >&2
  exit 1
fi

"$zstd_bin" -dc "$artifact" | /usr/bin/tar -xf - -C "$stage_dir"
runtime_bun="$(find "$stage_dir" -type f -path '*.app/Contents/MacOS/bun' -print -quit)"
if [[ -z "$runtime_bun" || ! -x "$runtime_bun" ]]; then
  echo "Packaged Electrobun Bun runtime was not found." >&2
  exit 1
fi

runtime_version="$("$runtime_bun" --version)"
if [[ "$runtime_version" != "1.3.14" ]]; then
  echo "Packaged Bun runtime drift: expected 1.3.14, found $runtime_version." >&2
  exit 1
fi

"$runtime_bun" -e '
  import { createZstdCompress, createZstdDecompress } from "node:zlib";
  if (typeof createZstdCompress !== "function" || typeof createZstdDecompress !== "function") {
    throw new Error("Packaged Bun does not expose streaming zstd APIs.");
  }
'

cd "$repo_root"
"$runtime_bun" test \
  "$usb_package/src/__tests__/packaged-app-handler.test.ts" \
  "$usb_package/src/__tests__/packaged-runtime-config.test.ts" \
  "$usb_package/src/backend/__tests__/raw-image-pipeline.test.ts" \
  "$usb_package/src/backend/__tests__/release-manifest.test.ts" \
  "$usb_package/src/backend/__tests__/release-sequence-store.test.ts"
