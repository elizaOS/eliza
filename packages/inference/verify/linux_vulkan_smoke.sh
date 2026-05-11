#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

REPORT_DIR="${ELIZA_DFLASH_HARDWARE_REPORT_DIR:-$SCRIPT_DIR/hardware-results}"
mkdir -p "$REPORT_DIR"
REPORT_PATH="$REPORT_DIR/linux-vulkan-smoke-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee "$REPORT_PATH") 2>&1

fail() {
  local code="$1"
  shift
  echo "[linux-vulkan-smoke] FAIL: $*" >&2
  echo "[linux-vulkan-smoke] evidence log: $REPORT_PATH" >&2
  exit "$code"
}

dump_capabilities() {
  local cap="$1"
  if [[ ! -f "$cap" ]]; then
    echo "[linux-vulkan-smoke] CAPABILITIES.json not found at $cap"
    return 0
  fi
  echo "[linux-vulkan-smoke] CAPABILITIES.json: $cap"
  node - "$cap" <<'NODE' || true
const fs = require("node:fs");
const p = process.argv[2];
const c = JSON.parse(fs.readFileSync(p, "utf8"));
const kernels = c.kernels || {};
const runtime = c.runtimeDispatch || {};
console.log(`[linux-vulkan-smoke] target=${c.target} backend=${c.backend} commit=${c.forkCommit || "unknown"}`);
console.log(`[linux-vulkan-smoke] kernels=${JSON.stringify(kernels)}`);
for (const [name, info] of Object.entries(runtime.kernels || {})) {
  console.log(`[linux-vulkan-smoke] runtimeDispatch.${name}=status:${info.status} runtimeReady:${info.runtimeReady}`);
  if (info.requiredSmoke) console.log(`[linux-vulkan-smoke] runtimeDispatch.${name}.requiredSmoke=${info.requiredSmoke}`);
}
NODE
}

echo "[linux-vulkan-smoke] started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[linux-vulkan-smoke] evidence log: $REPORT_PATH"
echo "[linux-vulkan-smoke] uname=$(uname -a)"

if [[ "$(uname -s)" != "Linux" ]]; then
  fail 2 "native Linux required; this is not a MoltenVK/macOS smoke"
fi

TARGET="${ELIZA_DFLASH_TARGET:-linux-x64-vulkan}"
ALLOW_SOFTWARE="${ELIZA_ALLOW_SOFTWARE_VULKAN:-0}"
STATE_DIR="${ELIZA_STATE_DIR:-$HOME/.eliza}"
OUT_DIR="${ELIZA_DFLASH_TARGET_OUT_DIR:-$STATE_DIR/local-inference/bin/dflash/$TARGET}"
CAPABILITIES="$OUT_DIR/CAPABILITIES.json"
CANONICAL_FIXTURES=(
  turbo3.json
  turbo4.json
  turbo3_tcq.json
  qjl.json
  polar.json
  polar_qjl.json
)

if command -v vulkaninfo >/dev/null 2>&1; then
  summary="$(vulkaninfo --summary 2>/dev/null || true)"
  echo "$summary"
  if [[ "$ALLOW_SOFTWARE" != "1" ]] && echo "$summary" | grep -Eiq 'llvmpipe|lavapipe|software rasterizer'; then
    fail 3 "refusing software Vulkan driver. Set ELIZA_ALLOW_SOFTWARE_VULKAN=1 only for CI/lavapipe diagnostics"
  fi
else
  echo "[linux-vulkan-smoke] warning: vulkaninfo not found; vulkan_verify will still enumerate the runtime device." >&2
fi

echo "[linux-vulkan-smoke] standalone Vulkan fixture gate: ${CANONICAL_FIXTURES[*]}"
make reference-test kernel-contract vulkan-verify

if [[ "${ELIZA_DFLASH_SKIP_BUILD:-0}" != "1" ]]; then
  echo "[linux-vulkan-smoke] building patched fork target=${TARGET}"
  set +e
  node ../../app-core/scripts/build-llama-cpp-dflash.mjs --target "${TARGET}"
  build_status=$?
  set -e
  if [[ "$build_status" -ne 0 ]]; then
    echo "[linux-vulkan-smoke] build exited ${build_status}; refusing to continue with stale or symbol-only artifacts." >&2
    dump_capabilities "$CAPABILITIES"
    fail "$build_status" "patched fork build did not produce a publishable Vulkan runtime; graph-dispatch smoke was not run"
  fi
  dump_capabilities "$CAPABILITIES"
else
  if [[ "${ELIZA_DFLASH_ALLOW_PREBUILT_VULKAN_SMOKE:-0}" != "1" ]]; then
    fail 5 "ELIZA_DFLASH_SKIP_BUILD=1 requires ELIZA_DFLASH_ALLOW_PREBUILT_VULKAN_SMOKE=1 so stale binaries are an explicit choice"
  fi
  if [[ ! -f "$CAPABILITIES" ]]; then
    fail 5 "prebuilt smoke requested but CAPABILITIES.json is missing at $CAPABILITIES"
  fi
  echo "[linux-vulkan-smoke] using explicit prebuilt Vulkan artifact"
  dump_capabilities "$CAPABILITIES"
fi

echo "[linux-vulkan-smoke] built-fork Vulkan graph dispatch gate"
set +e
make vulkan-dispatch-smoke
smoke_status=$?
set -e
if [[ "$smoke_status" -ne 0 ]]; then
  fail "$smoke_status" "vulkan-dispatch-smoke failed; symbol staging is not runtime-ready"
fi

echo "[linux-vulkan-smoke] PASS native Linux Vulkan standalone fixtures and built-fork graph dispatch"
echo "[linux-vulkan-smoke] evidence log: $REPORT_PATH"
