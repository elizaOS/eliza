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
  ELIZA_DFLASH_ALLOW_UNVERIFIED_VULKAN_BUILD=1 \
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

EVIDENCE_PATH="$SCRIPT_DIR/vulkan-runtime-dispatch-evidence.json"
node - "$REPORT_PATH" "$EVIDENCE_PATH" "$CAPABILITIES" <<'NODE'
const fs = require("node:fs");
const [reportPath, outPath, capPath] = process.argv.slice(2);
const text = fs.readFileSync(reportPath, "utf8");
const cap = fs.existsSync(capPath) ? JSON.parse(fs.readFileSync(capPath, "utf8")) : {};
const routeMap = {
  "GGML_OP_ATTN_SCORE_QJL": { key: "qjl", capability: "qjl_full", op: "GGML_OP_ATTN_SCORE_QJL" },
  "GGML_OP_ATTN_SCORE_TBQ/turbo3": { key: "turbo3", capability: "turbo3", op: "GGML_OP_ATTN_SCORE_TBQ" },
  "GGML_OP_ATTN_SCORE_TBQ/turbo4": { key: "turbo4", capability: "turbo4", op: "GGML_OP_ATTN_SCORE_TBQ" },
  "GGML_OP_ATTN_SCORE_TBQ/turbo3_tcq": { key: "turbo3_tcq", capability: "turbo3_tcq", op: "GGML_OP_ATTN_SCORE_TBQ" },
  "GGML_OP_ATTN_SCORE_POLAR/use_qjl=0": { key: "polar", capability: "polarquant", op: "GGML_OP_ATTN_SCORE_POLAR" },
  "GGML_OP_ATTN_SCORE_POLAR/use_qjl=1": { key: "polar", capability: "polarquant", op: "GGML_OP_ATTN_SCORE_POLAR" },
};
const seen = new Map();
for (const match of text.matchAll(/\[vulkan_dispatch_smoke\] PASS ([^:]+): (\d+) scores, max diff ([0-9.eE+-]+)/g)) {
  const [, route, scores, maxDiff] = match;
  const meta = routeMap[route];
  if (!meta) continue;
  const current = seen.get(meta.key) ?? {
    runtimeCapabilityKey: meta.capability,
    status: "runtime-ready",
    runtimeReady: true,
    graphOp: meta.op,
    smokeTarget: "vulkan-dispatch-smoke",
    smokeCommand: "make -C packages/inference/verify vulkan-dispatch-smoke",
    smokeScores: 0,
    maxDiff: 0,
    graphRoutes: [],
    evidenceDate: new Date().toISOString().slice(0, 10),
  };
  current.smokeScores += Number(scores);
  current.maxDiff = Math.max(current.maxDiff, Number(maxDiff));
  current.graphRoutes.push(route);
  seen.set(meta.key, current);
}
const required = ["turbo3", "turbo4", "turbo3_tcq", "qjl", "polar"];
const missing = required.filter((key) => !seen.has(key));
if (missing.length) {
  console.error(`[linux-vulkan-smoke] cannot write runtime evidence; missing graph route(s): ${missing.join(", ")}`);
  process.exit(1);
}
const payload = {
  schemaVersion: 1,
  backend: "vulkan",
  platform: "linux",
  sourceOfTruth: "Runtime-ready means a built llama.cpp fork graph route selects the shipped Vulkan kernel and a numeric smoke test passes. SPIR-V compilation and pipeline symbols are not enough.",
  status: "runtime-ready",
  runtimeReady: true,
  generatedFrom: reportPath,
  target: cap.target ?? "linux-x64-vulkan",
  device: (text.match(/\[vulkan_dispatch_smoke\] device=(.+)/) ?? [null, "unknown"])[1],
  atCommit: cap.forkCommit ?? "unknown",
  smokeTarget: "vulkan-dispatch-smoke",
  smokeCommand: "make -C packages/inference/verify vulkan-dispatch-smoke",
  evidenceDate: new Date().toISOString().slice(0, 10),
  kernels: Object.fromEntries([...seen.entries()].sort(([a], [b]) => a.localeCompare(b))),
};
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
console.log(`[linux-vulkan-smoke] wrote runtime dispatch evidence: ${outPath}`);
NODE

if [[ "${ELIZA_DFLASH_SKIP_BUILD:-0}" != "1" ]]; then
  echo "[linux-vulkan-smoke] rebuilding target=${TARGET} with Vulkan runtime evidence enforced"
  node ../../app-core/scripts/build-llama-cpp-dflash.mjs --target "${TARGET}"
  dump_capabilities "$CAPABILITIES"
fi

echo "[linux-vulkan-smoke] PASS native Linux Vulkan standalone fixtures and built-fork graph dispatch"
echo "[linux-vulkan-smoke] evidence log: $REPORT_PATH"
