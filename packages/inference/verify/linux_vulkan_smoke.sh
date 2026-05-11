#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[linux-vulkan-smoke] native Linux required; this is not a MoltenVK/macOS smoke." >&2
  exit 2
fi

TARGET="${ELIZA_DFLASH_TARGET:-linux-x64-vulkan}"
ALLOW_SOFTWARE="${ELIZA_ALLOW_SOFTWARE_VULKAN:-0}"

if command -v vulkaninfo >/dev/null 2>&1; then
  summary="$(vulkaninfo --summary 2>/dev/null || true)"
  echo "$summary"
  if [[ "$ALLOW_SOFTWARE" != "1" ]] && echo "$summary" | grep -Eiq 'llvmpipe|lavapipe|software rasterizer'; then
    echo "[linux-vulkan-smoke] refusing software Vulkan driver. Set ELIZA_ALLOW_SOFTWARE_VULKAN=1 only for CI/lavapipe diagnostics." >&2
    exit 3
  fi
else
  echo "[linux-vulkan-smoke] warning: vulkaninfo not found; vulkan_verify will still enumerate the runtime device." >&2
fi

echo "[linux-vulkan-smoke] standalone Vulkan fixture gate"
make reference-test kernel-contract vulkan-verify

if [[ "${ELIZA_DFLASH_SKIP_BUILD:-0}" != "1" ]]; then
  echo "[linux-vulkan-smoke] building patched fork target=${TARGET}"
  set +e
  node ../../app-core/scripts/build-llama-cpp-dflash.mjs --target "${TARGET}"
  build_status=$?
  set -e
  if [[ "$build_status" -ne 0 ]]; then
    echo "[linux-vulkan-smoke] build exited ${build_status}. This is expected while Vulkan graph dispatch is blocked; CAPABILITIES.json is diagnostic-only." >&2
  fi
else
  echo "[linux-vulkan-smoke] skipping build because ELIZA_DFLASH_SKIP_BUILD=1"
fi

echo "[linux-vulkan-smoke] built-fork Vulkan graph dispatch gate"
make vulkan-dispatch-smoke
