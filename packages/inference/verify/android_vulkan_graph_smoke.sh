#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$SCRIPT_DIR"

ANDROID_API="${ANDROID_API:-28}"
TARGET="${ELIZA_DFLASH_TARGET:-android-arm64-vulkan}"
STATE_DIR="${ELIZA_STATE_DIR:-$HOME/.eliza}"
OUT_DIR="${ELIZA_DFLASH_TARGET_OUT_DIR:-$STATE_DIR/local-inference/bin/dflash/$TARGET}"
LLAMA_DIR="${ELIZA_DFLASH_LLAMA_DIR:-$HOME/.cache/eliza-dflash/android-vulkan-graph-llama-cpp}"
BIN_DIR="${ELIZA_DFLASH_VULKAN_BIN_DIR:-$OUT_DIR}"
REMOTE_DIR="${ELIZA_ANDROID_VULKAN_GRAPH_REMOTE_DIR:-/data/local/tmp/eliza-vulkan-graph}"
BUILD_DIR="${ELIZA_ANDROID_VULKAN_GRAPH_BUILD_DIR:-android-vulkan-graph-smoke}"
DFLASH_BUILD_JOBS="${ELIZA_DFLASH_JOBS:-1}"
ADB_HINT="${ADB:-adb}"
ALLOW_EMULATOR="${ELIZA_ALLOW_ANDROID_EMULATOR_VULKAN:-0}"
ALLOW_SOFTWARE="${ELIZA_ALLOW_SOFTWARE_VULKAN:-0}"
REPORT_DIR="${ELIZA_DFLASH_HARDWARE_REPORT_DIR:-$SCRIPT_DIR/hardware-results}"
EVIDENCE_PATH="${ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE_OUT:-$SCRIPT_DIR/vulkan-runtime-dispatch-evidence.json}"
mkdir -p "$REPORT_DIR"
REPORT_PATH="$REPORT_DIR/android-vulkan-graph-smoke-$(date -u +%Y%m%dT%H%M%SZ).log"
JSON_REPORT_PATH="${REPORT_PATH%.log}.json"
exec > >(tee "$REPORT_PATH") 2>&1

fail() {
  local code="$1"
  shift
  echo "[android-vulkan-graph-smoke] FAIL: $*" >&2
  echo "[android-vulkan-graph-smoke] evidence log: $REPORT_PATH" >&2
  exit "$code"
}

resolve_ndk() {
  local candidate sdk_root
  for candidate in "${ANDROID_NDK_HOME:-}" "${ANDROID_NDK_ROOT:-}" "${ANDROID_NDK:-}"; do
    if [[ -n "$candidate" && -f "$candidate/build/cmake/android.toolchain.cmake" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  for sdk_root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    if [[ -n "$sdk_root" && -d "$sdk_root/ndk" ]]; then
      find "$sdk_root/ndk" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1
      return 0
    fi
  done
  return 1
}

resolve_adb() {
  local candidate
  for candidate in \
    "$ADB_HINT" \
    "${ANDROID_HOME:-}/platform-tools/adb" \
    "${ANDROID_SDK_ROOT:-}/platform-tools/adb" \
    "$HOME/Library/Android/sdk/platform-tools/adb" \
    "$HOME/Android/Sdk/platform-tools/adb"; do
    [[ -z "$candidate" ]] && continue
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

adb_cmd() {
  if [[ -n "${ADB_SERIAL:-}" ]]; then
    "$ADB" -s "$ADB_SERIAL" "$@"
  else
    "$ADB" "$@"
  fi
}

echo "[android-vulkan-graph-smoke] started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[android-vulkan-graph-smoke] evidence log: $REPORT_PATH"
echo "[android-vulkan-graph-smoke] host=$(uname -a)"

if [[ "$TARGET" != "android-arm64-vulkan" ]]; then
  fail 2 "expected ELIZA_DFLASH_TARGET=android-arm64-vulkan, got $TARGET"
fi

NDK="$(resolve_ndk || true)"
if [[ -z "$NDK" || ! -d "$NDK/toolchains/llvm/prebuilt" ]]; then
  fail 2 "Android NDK not found. Set ANDROID_NDK_HOME, ANDROID_HOME, or ANDROID_SDK_ROOT"
fi

HOST_TAG=""
for candidate in darwin-arm64 darwin-x86_64 linux-x86_64 windows-x86_64; do
  if [[ -d "$NDK/toolchains/llvm/prebuilt/$candidate" ]]; then
    HOST_TAG="$candidate"
    break
  fi
done
if [[ -z "$HOST_TAG" ]]; then
  fail 2 "could not find NDK LLVM prebuilt under $NDK/toolchains/llvm/prebuilt"
fi

TOOLBIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG/bin"
CC="$TOOLBIN/aarch64-linux-android${ANDROID_API}-clang"
CXX="$TOOLBIN/aarch64-linux-android${ANDROID_API}-clang++"
if [[ ! -x "$CC" || ! -x "$CXX" ]]; then
  fail 2 "missing NDK clang tools for host tag $HOST_TAG"
fi

ADB="$(resolve_adb || true)"
if [[ -z "$ADB" ]]; then
  fail 2 "adb not found. Set ADB=/path/to/adb, ANDROID_HOME, or ANDROID_SDK_ROOT"
fi
echo "[android-vulkan-graph-smoke] adb=${ADB}"
echo "[android-vulkan-graph-smoke] ndk=${NDK} host_tag=${HOST_TAG}"
echo "[android-vulkan-graph-smoke] target=${TARGET}"
echo "[android-vulkan-graph-smoke] llama_dir=${LLAMA_DIR}"
echo "[android-vulkan-graph-smoke] out_dir=${OUT_DIR}"
echo "[android-vulkan-graph-smoke] dflash_build_jobs=${DFLASH_BUILD_JOBS}"

ADB_DEVICES=()
ADB_LIST="$("$ADB" devices -l || true)"
printf '%s\n' "$ADB_LIST"
while read -r serial status rest; do
  [[ -z "$serial" ]] && continue
  if [[ "$status" == "device" ]]; then
    ADB_DEVICES+=("$serial")
  fi
done < <(printf '%s\n' "$ADB_LIST" | awk 'NR > 1 && NF >= 2 { print $1, $2 }')

if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  ADB_SERIAL="$ANDROID_SERIAL"
else
  if [[ "${#ADB_DEVICES[@]}" -eq 1 ]]; then
    ADB_SERIAL="${ADB_DEVICES[0]}"
    echo "[android-vulkan-graph-smoke] auto-selected only attached device ${ADB_SERIAL}"
  elif [[ "${#ADB_DEVICES[@]}" -eq 0 ]]; then
    fail 2 "no adb devices in 'device' state"
  else
    fail 2 "multiple adb devices attached: ${ADB_DEVICES[*]}. Set ANDROID_SERIAL"
  fi
fi

adb_cmd wait-for-device
SERIAL="$(adb_cmd get-serialno 2>/dev/null | tr -d '\r' || true)"
MANUFACTURER="$(adb_cmd shell getprop ro.product.manufacturer 2>/dev/null | tr -d '\r' || true)"
MODEL="$(adb_cmd shell getprop ro.product.model 2>/dev/null | tr -d '\r' || true)"
HARDWARE="$(adb_cmd shell getprop ro.hardware 2>/dev/null | tr -d '\r' || true)"
BOARD_PLATFORM="$(adb_cmd shell getprop ro.board.platform 2>/dev/null | tr -d '\r' || true)"
QEMU="$(adb_cmd shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r' || true)"
BOOT_QEMU="$(adb_cmd shell getprop ro.boot.qemu 2>/dev/null | tr -d '\r' || true)"
echo "[android-vulkan-graph-smoke] device serial=${SERIAL:-unknown} manufacturer=${MANUFACTURER:-unknown} model=${MODEL:-unknown} hardware=${HARDWARE:-unknown} board=${BOARD_PLATFORM:-unknown} qemu=${QEMU:-unknown}/${BOOT_QEMU:-unknown}"
if [[ "$QEMU" == "1" && "$ALLOW_EMULATOR" != "1" ]]; then
  fail 3 "refusing emulator device. Connect a physical handset/tablet, or set ELIZA_ALLOW_ANDROID_EMULATOR_VULKAN=1 for diagnostics only"
fi
if [[ "$BOOT_QEMU" == "1" && "$ALLOW_EMULATOR" != "1" ]]; then
  fail 3 "refusing emulator boot profile. Connect a physical handset/tablet, or set ELIZA_ALLOW_ANDROID_EMULATOR_VULKAN=1 for diagnostics only"
fi

VKJSON="$(adb_cmd shell cmd gpu vkjson 2>/dev/null || true)"
if [[ -n "$VKJSON" ]]; then
  echo "[android-vulkan-graph-smoke] cmd gpu vkjson:"
  printf '%s\n' "$VKJSON" | awk 'NR <= 120 { print }'
fi
if [[ -n "$VKJSON" ]] && [[ "$ALLOW_SOFTWARE" != "1" ]] && echo "$VKJSON" | grep -Eiq 'llvmpipe|lavapipe|swiftshader|software rasterizer'; then
  fail 3 "refusing software Vulkan device. Set ELIZA_ALLOW_SOFTWARE_VULKAN=1 for diagnostics only"
fi

if [[ "${ELIZA_DFLASH_SKIP_BUILD:-0}" != "1" ]]; then
  echo "[android-vulkan-graph-smoke] building patched fork target=${TARGET}"
  rm -rf "$LLAMA_DIR/build/$TARGET"
  ELIZA_DFLASH_ALLOW_UNVERIFIED_VULKAN_BUILD=1 \
  ELIZA_DFLASH_SKIP_DRAFTER_ARCH_PATCH=1 \
    node "$REPO_ROOT/packages/app-core/scripts/build-llama-cpp-dflash.mjs" \
      --target "$TARGET" \
      --cache-dir "$LLAMA_DIR" \
      --jobs "$DFLASH_BUILD_JOBS"
else
  [[ "${ELIZA_DFLASH_ALLOW_PREBUILT_VULKAN_SMOKE:-0}" == "1" ]] || \
    fail 5 "ELIZA_DFLASH_SKIP_BUILD=1 requires ELIZA_DFLASH_ALLOW_PREBUILT_VULKAN_SMOKE=1"
fi

CAPABILITIES="$OUT_DIR/CAPABILITIES.json"
if [[ ! -f "$CAPABILITIES" ]]; then
  fail 5 "CAPABILITIES.json not found at $CAPABILITIES"
fi
if [[ ! -f "$BIN_DIR/libggml-vulkan.so" ]]; then
  fail 5 "libggml-vulkan.so not found under $BIN_DIR"
fi
if [[ ! -f "$LLAMA_DIR/ggml/include/ggml.h" ]]; then
  fail 5 "ggml headers not found under $LLAMA_DIR"
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
echo "[android-vulkan-graph-smoke] compiling graph-dispatch harness for arm64-v8a API ${ANDROID_API}"
"$CC" -O2 -Wall -Wextra -std=c11 -I../reference -c ../reference/turbo_kernels.c -o "$BUILD_DIR/turbo_kernels.o"
"$CC" -O2 -Wall -Wextra -std=c11 -I. -c qjl_polar_ref.c -o "$BUILD_DIR/qjl_polar_ref.o"
"$CXX" -O2 -Wall -Wextra -std=c++17 \
  -I"$LLAMA_DIR/ggml/include" \
  -I"$LLAMA_DIR/ggml/src" \
  -I../reference -I. \
  vulkan_dispatch_smoke.cpp "$BUILD_DIR/turbo_kernels.o" "$BUILD_DIR/qjl_polar_ref.o" \
  -L"$BIN_DIR" -lggml-base -lggml-vulkan -lggml-cpu -lggml \
  -Wl,-rpath,'$ORIGIN/lib' \
  -static-libstdc++ -lvulkan -llog -landroid -ldl -latomic -lm \
  -o "$BUILD_DIR/vulkan_dispatch_smoke"

LIBCXX_SHARED="$(find "$NDK" -path '*/libc++_shared.so' -type f | grep '/arm64-v8a/\|/aarch64-linux-android/' | head -n 1 || true)"
LIBOMP_SHARED="$(find "$NDK" -path '*/libomp.so' -type f | grep '/aarch64/' | head -n 1 || true)"

echo "[android-vulkan-graph-smoke] pushing harness and built fork libraries to ${REMOTE_DIR}"
adb_cmd shell "rm -rf '${REMOTE_DIR}' && mkdir -p '${REMOTE_DIR}/lib'"
adb_cmd push "$BUILD_DIR/vulkan_dispatch_smoke" "${REMOTE_DIR}/vulkan_dispatch_smoke" >/dev/null
adb_cmd push "$BIN_DIR"/lib*.so "${REMOTE_DIR}/lib/" >/dev/null
if [[ -n "$LIBCXX_SHARED" ]]; then
  adb_cmd push "$LIBCXX_SHARED" "${REMOTE_DIR}/lib/libc++_shared.so" >/dev/null
fi
if [[ -n "$LIBOMP_SHARED" ]]; then
  adb_cmd push "$LIBOMP_SHARED" "${REMOTE_DIR}/lib/libomp.so" >/dev/null
fi
adb_cmd shell "chmod 755 '${REMOTE_DIR}/vulkan_dispatch_smoke'"

echo "[android-vulkan-graph-smoke] running built-fork Vulkan graph dispatch on Android"
adb_cmd shell "cd '${REMOTE_DIR}' && LD_LIBRARY_PATH='${REMOTE_DIR}/lib' ELIZA_ALLOW_SOFTWARE_VULKAN='${ALLOW_SOFTWARE}' ./vulkan_dispatch_smoke"

node - "$REPORT_PATH" "$JSON_REPORT_PATH" "$EVIDENCE_PATH" "$CAPABILITIES" "$TARGET" "$SERIAL" "$MANUFACTURER" "$MODEL" "$HARDWARE" "$BOARD_PLATFORM" <<'NODE'
const fs = require("node:fs");
const [
  reportPath,
  jsonReportPath,
  evidencePath,
  capPath,
  target,
  serial,
  manufacturer,
  model,
  hardware,
  boardPlatform,
] = process.argv.slice(2);
const text = fs.readFileSync(reportPath, "utf8");
const cap = fs.existsSync(capPath) ? JSON.parse(fs.readFileSync(capPath, "utf8")) : {};
const routeMap = {
  "GGML_OP_ATTN_SCORE_QJL": { key: "qjl", capability: "qjl_full", op: "GGML_OP_ATTN_SCORE_QJL" },
  "GGML_OP_ATTN_SCORE_TBQ/turbo3": { key: "turbo3", capability: "turbo3", op: "GGML_OP_ATTN_SCORE_TBQ" },
  "GGML_OP_ATTN_SCORE_TBQ/turbo4": { key: "turbo4", capability: "turbo4", op: "GGML_OP_ATTN_SCORE_TBQ" },
  "GGML_OP_ATTN_SCORE_TBQ/turbo3_tcq": { key: "turbo3_tcq", capability: "turbo3_tcq", op: "GGML_OP_ATTN_SCORE_TBQ" },
  "GGML_OP_ATTN_SCORE_POLAR/use_qjl=0": { key: "polar", capability: "polarquant", op: "GGML_OP_ATTN_SCORE_POLAR" },
  "GGML_OP_ATTN_SCORE_POLAR/use_qjl=1": { key: "polar", capability: "polarquant", op: "GGML_OP_ATTN_SCORE_POLAR" },
  "GGML_OP_FUSED_ATTN_QJL_TBQ": { key: "fused_attn_qjl_tbq", capability: "fused_attn_qjl_tbq", op: "GGML_OP_FUSED_ATTN_QJL_TBQ" },
};
const seen = new Map();
for (const match of text.matchAll(/\[vulkan_dispatch_smoke\] PASS ([^:]+): (\d+) (?:scores|outputs), max diff ([0-9.eE+-]+)/g)) {
  const [, route, outputs, maxDiff] = match;
  const meta = routeMap[route];
  if (!meta) continue;
  const current = seen.get(meta.key) ?? {
    runtimeCapabilityKey: meta.capability,
    status: "runtime-ready",
    runtimeReady: true,
    graphOp: meta.op,
    smokeTarget: "android-vulkan-graph-smoke",
    smokeCommand: "make -C packages/inference/verify android-vulkan-graph-smoke",
    smokeOutputs: 0,
    maxDiff: 0,
    graphRoutes: [],
    evidenceDate: new Date().toISOString().slice(0, 10),
  };
  current.smokeOutputs += Number(outputs);
  current.maxDiff = Math.max(current.maxDiff, Number(maxDiff));
  current.graphRoutes.push(route);
  seen.set(meta.key, current);
}
const required = ["turbo3", "turbo4", "turbo3_tcq", "qjl", "polar", "fused_attn_qjl_tbq"];
const missing = required.filter((key) => !seen.has(key));
if (missing.length) {
  console.error(`[android-vulkan-graph-smoke] cannot write runtime evidence; missing graph route(s): ${missing.join(", ")}`);
  process.exit(1);
}
const payload = {
  schemaVersion: 1,
  backend: "vulkan",
  platform: "android",
  sourceOfTruth: "Runtime-ready means a built llama.cpp fork graph route selects the shipped Vulkan kernel and a numeric smoke test passes on Android. SPIR-V compilation and pipeline symbols are not enough.",
  status: "runtime-ready",
  runtimeReady: true,
  generatedFrom: reportPath,
  target,
  device: {
    serial,
    manufacturer,
    model,
    hardware,
    boardPlatform,
    vulkanDescription: (text.match(/\[vulkan_dispatch_smoke\] device=(.+)/) ?? [null, "unknown"])[1],
  },
  atCommit: cap.forkCommit ?? "unknown",
  smokeTarget: "android-vulkan-graph-smoke",
  smokeCommand: "make -C packages/inference/verify android-vulkan-graph-smoke",
  evidenceDate: new Date().toISOString().slice(0, 10),
  kernels: Object.fromEntries([...seen.entries()].sort(([a], [b]) => a.localeCompare(b))),
};
fs.writeFileSync(jsonReportPath, JSON.stringify(payload, null, 2) + "\n");

let aggregate = {};
if (fs.existsSync(evidencePath)) {
  try {
    aggregate = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  } catch {
    aggregate = {};
  }
}
const targets = {};
if (aggregate.targets && typeof aggregate.targets === "object") {
  Object.assign(targets, aggregate.targets);
} else if (aggregate.target && aggregate.kernels) {
  targets[aggregate.target] = aggregate;
}
targets[target] = payload;
const merged = {
  schemaVersion: 2,
  backend: "vulkan",
  sourceOfTruth: "Runtime-ready is target-specific: each target needs a built llama.cpp fork graph route selecting the shipped Vulkan kernel and passing numeric smoke.",
  status: "runtime-ready",
  runtimeReady: Object.values(targets).every((entry) => entry && entry.runtimeReady === true),
  updatedAt: new Date().toISOString(),
  generatedFrom: reportPath,
  targets: Object.fromEntries(Object.entries(targets).sort(([a], [b]) => a.localeCompare(b))),
};
fs.writeFileSync(evidencePath, JSON.stringify(merged, null, 2) + "\n");
console.log(`[android-vulkan-graph-smoke] wrote per-run evidence: ${jsonReportPath}`);
console.log(`[android-vulkan-graph-smoke] updated runtime dispatch evidence: ${evidencePath}`);
NODE

if [[ "${ELIZA_DFLASH_SKIP_REBUILD_WITH_EVIDENCE:-0}" != "1" && "${ELIZA_DFLASH_SKIP_BUILD:-0}" != "1" ]]; then
  echo "[android-vulkan-graph-smoke] rebuilding target=${TARGET} with Android Vulkan runtime evidence recorded"
  rm -rf "$LLAMA_DIR/build/$TARGET"
  ELIZA_DFLASH_ALLOW_UNVERIFIED_VULKAN_BUILD=1 \
  ELIZA_DFLASH_SKIP_DRAFTER_ARCH_PATCH=1 \
    node "$REPO_ROOT/packages/app-core/scripts/build-llama-cpp-dflash.mjs" \
    --target "$TARGET" \
    --cache-dir "$LLAMA_DIR" \
    --jobs "$DFLASH_BUILD_JOBS"
fi

echo "[android-vulkan-graph-smoke] PASS Android Vulkan built-fork graph dispatch"
echo "[android-vulkan-graph-smoke] evidence log: $REPORT_PATH"
