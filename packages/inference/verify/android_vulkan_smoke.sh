#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ANDROID_API="${ANDROID_API:-28}"
REMOTE_DIR="${ELIZA_ANDROID_VULKAN_REMOTE_DIR:-/data/local/tmp/eliza-kernels}"
OUT_DIR="${ELIZA_ANDROID_VULKAN_OUT_DIR:-android-vulkan-smoke}"
ADB_HINT="${ADB:-adb}"
ALLOW_EMULATOR="${ELIZA_ALLOW_ANDROID_EMULATOR_VULKAN:-0}"
ALLOW_SOFTWARE="${ELIZA_ALLOW_SOFTWARE_VULKAN:-0}"
PREFLIGHT_ONLY="${ELIZA_ANDROID_VULKAN_PREFLIGHT_ONLY:-0}"
REPORT_DIR="${ELIZA_DFLASH_HARDWARE_REPORT_DIR:-$SCRIPT_DIR/hardware-results}"
mkdir -p "$REPORT_DIR"
REPORT_PATH="$REPORT_DIR/android-vulkan-smoke-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee "$REPORT_PATH") 2>&1

fail() {
  local code="$1"
  shift
  echo "[android-vulkan-smoke] FAIL: $*" >&2
  echo "[android-vulkan-smoke] evidence log: $REPORT_PATH" >&2
  exit "$code"
}

echo "[android-vulkan-smoke] started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[android-vulkan-smoke] evidence log: $REPORT_PATH"
echo "[android-vulkan-smoke] host=$(uname -a)"

resolve_ndk() {
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
  if [[ -d "$HOME/Android/Sdk/ndk" ]]; then
    find "$HOME/Android/Sdk/ndk" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1
    return 0
  fi
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

print_android_usb_hint() {
  if [[ "$(uname -s)" != "Darwin" ]] || ! command -v system_profiler >/dev/null 2>&1; then
    echo "[android-vulkan-smoke] PREFLIGHT usb_android_hint=unavailable"
    return 1
  fi

  local matches
  matches="$(system_profiler SPUSBDataType 2>/dev/null | grep -Ei -B3 -A8 'android|pixel|google|samsung|oneplus|motorola|moto|qualcomm|xiaomi|huawei|adb|mtp' || true)"
  if [[ -n "$matches" ]]; then
    echo "[android-vulkan-smoke] PREFLIGHT usb_android_hint=present"
    printf '%s\n' "$matches" | awk 'NR <= 120 { print }'
    return 0
  fi

  echo "[android-vulkan-smoke] PREFLIGHT usb_android_hint=absent"
  return 1
}

NDK="$(resolve_ndk || true)"
if [[ -z "$NDK" || ! -d "$NDK/toolchains/llvm/prebuilt" ]]; then
  fail 2 "Android NDK not found. Set ANDROID_NDK_HOME"
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
GLSLC="${GLSLC:-$NDK/shader-tools/$HOST_TAG/glslc}"

if [[ ! -x "$CC" || ! -x "$CXX" ]]; then
  fail 2 "missing NDK clang tools for host tag $HOST_TAG"
fi
if [[ ! -x "$GLSLC" ]]; then
  fail 2 "glslc not found at $GLSLC"
fi
ADB="$(resolve_adb || true)"
if [[ -z "$ADB" ]]; then
  fail 2 "missing-adb: adb not found. Set ADB=/path/to/adb, ANDROID_HOME, or ANDROID_SDK_ROOT"
fi
echo "[android-vulkan-smoke] adb=${ADB}"
echo "[android-vulkan-smoke] ndk=${NDK} host_tag=${HOST_TAG} glslc=${GLSLC}"

ADB_SERIAL="${ANDROID_SERIAL:-}"
ADB_DEVICES=()
ADB_UNAUTHORIZED=()
ADB_OFFLINE=()
ADB_OTHER=()
ADB_LIST="$("$ADB" devices -l || true)"
printf '%s\n' "$ADB_LIST"
while read -r serial status rest; do
  [[ -z "$serial" ]] && continue
  case "$status" in
    device) ADB_DEVICES+=("$serial") ;;
    unauthorized) ADB_UNAUTHORIZED+=("$serial") ;;
    offline) ADB_OFFLINE+=("$serial") ;;
    *) ADB_OTHER+=("$serial:$status") ;;
  esac
done < <(printf '%s\n' "$ADB_LIST" | awk 'NR > 1 && NF >= 2 { print $1, $2 }')

if [[ "$PREFLIGHT_ONLY" == "1" ]]; then
  echo "[android-vulkan-smoke] PREFLIGHT adb_device=${#ADB_DEVICES[@]} unauthorized=${#ADB_UNAUTHORIZED[@]} offline=${#ADB_OFFLINE[@]} other=${#ADB_OTHER[@]}"
  echo "[android-vulkan-smoke] PREFLIGHT standalone_only=${ELIZA_ANDROID_VULKAN_STANDALONE_ONLY:-0} graph_evidence=${ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE:-<unset>}"
  if [[ "${#ADB_UNAUTHORIZED[@]}" -gt 0 ]]; then
    fail 2 "unauthorized-device: unlock the Android device and accept the RSA debugging prompt (${ADB_UNAUTHORIZED[*]})"
  fi
  if [[ "${#ADB_OFFLINE[@]}" -gt 0 ]]; then
    fail 2 "offline-device: reconnect USB, toggle USB debugging, or run 'adb kill-server; adb start-server' (${ADB_OFFLINE[*]})"
  fi
  if [[ "${#ADB_DEVICES[@]}" -eq 0 ]]; then
    if print_android_usb_hint; then
      fail 2 "usb-visible-no-adb-device: Android-like USB hardware is visible, but adb has no 'device' entry. Unlock the phone, select File Transfer/PTP if prompted, enable USB debugging, and accept the RSA prompt"
    fi
    fail 2 "no-device: no physical Android device is in adb 'device' state, and no Android-like USB hardware is visible to macOS"
  fi
  echo "[android-vulkan-smoke] PREFLIGHT PASS"
  exit 0
fi

if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  ADB_SERIAL="$ANDROID_SERIAL"
  found_serial=0
  for serial in "${ADB_DEVICES[@]}"; do
    if [[ "$serial" == "$ADB_SERIAL" ]]; then
      found_serial=1
      break
    fi
  done
  if [[ "$found_serial" != "1" ]]; then
    fail 2 "ANDROID_SERIAL=$ADB_SERIAL is not listed by adb devices in 'device' state"
  fi
else
  if [[ "${#ADB_DEVICES[@]}" -eq 0 ]]; then
    if [[ "${#ADB_UNAUTHORIZED[@]}" -gt 0 ]]; then
      fail 2 "unauthorized-device: unlock the Android device and accept the RSA debugging prompt (${ADB_UNAUTHORIZED[*]})"
    fi
    if [[ "${#ADB_OFFLINE[@]}" -gt 0 ]]; then
      fail 2 "offline-device: reconnect USB, toggle USB debugging, or run 'adb kill-server; adb start-server' (${ADB_OFFLINE[*]})"
    fi
    if print_android_usb_hint; then
      fail 2 "usb-visible-no-adb-device: Android-like USB hardware is visible, but adb has no 'device' entry. Unlock the phone, select File Transfer/PTP if prompted, enable USB debugging, and accept the RSA prompt"
    fi
    fail 2 "no-device: no adb devices in 'device' state. Connect a physical Adreno/Mali device or set ANDROID_SERIAL"
  elif [[ "${#ADB_DEVICES[@]}" -eq 1 ]]; then
    ADB_SERIAL="${ADB_DEVICES[0]}"
    echo "[android-vulkan-smoke] auto-selected only attached device ${ADB_SERIAL}"
  else
    PHYSICAL_DEVICES=()
    for serial in "${ADB_DEVICES[@]}"; do
      qemu="$("$ADB" -s "$serial" shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r' || true)"
      if [[ "$qemu" != "1" ]]; then
        PHYSICAL_DEVICES+=("$serial")
      fi
    done
    if [[ "${#PHYSICAL_DEVICES[@]}" -eq 1 ]]; then
      ADB_SERIAL="${PHYSICAL_DEVICES[0]}"
      echo "[android-vulkan-smoke] auto-selected physical device ${PHYSICAL_DEVICES[0]} (set ANDROID_SERIAL to override)"
    else
      fail 2 "multiple adb devices attached: ${ADB_DEVICES[*]}. Set ANDROID_SERIAL to the physical Adreno/Mali device"
    fi
  fi
fi

PRE_QEMU="$("$ADB" -s "$ADB_SERIAL" shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r' || true)"
PRE_BOOT_QEMU="$("$ADB" -s "$ADB_SERIAL" shell getprop ro.boot.qemu 2>/dev/null | tr -d '\r' || true)"
if [[ "$PRE_QEMU" == "1" && "$ALLOW_EMULATOR" != "1" ]]; then
  fail 3 "refusing emulator device before build. Connect a physical Adreno/Mali handset/tablet, or set ELIZA_ALLOW_ANDROID_EMULATOR_VULKAN=1 for diagnostics only"
fi
if [[ "$PRE_BOOT_QEMU" == "1" && "$ALLOW_EMULATOR" != "1" ]]; then
  fail 3 "refusing emulator boot profile before build. Connect a physical Adreno/Mali handset/tablet, or set ELIZA_ALLOW_ANDROID_EMULATOR_VULKAN=1 for diagnostics only"
fi

echo "[android-vulkan-smoke] generating canonical fixtures"
if ! make reference-test >/dev/null; then
  fail 2 "failed to generate canonical fixtures with make reference-test"
fi

for fixture in turbo3.json turbo4.json turbo3_tcq.json qjl.json polar.json polar_qjl.json; do
  if [[ ! -f "fixtures/$fixture" ]]; then
    fail 2 "missing canonical fixture fixtures/$fixture"
  fi
done

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/spv" "$OUT_DIR/fixtures"

echo "[android-vulkan-smoke] compiling verifier for arm64-v8a API ${ANDROID_API}"
"$CC" -O2 -Wall -Wextra -std=c11 -I../reference -c ../reference/turbo_kernels.c -o "$OUT_DIR/turbo_kernels.o"
"$CC" -O2 -Wall -Wextra -std=c11 -I. -c qjl_polar_ref.c -o "$OUT_DIR/qjl_polar_ref.o"
"$CXX" -O2 -Wall -Wextra -std=c++17 -I../reference -I. \
  vulkan_verify.cpp "$OUT_DIR/turbo_kernels.o" "$OUT_DIR/qjl_polar_ref.o" \
  -static-libstdc++ -lvulkan -lm -o "$OUT_DIR/vulkan_verify"

echo "[android-vulkan-smoke] compiling SPIR-V with $GLSLC"
for shader in turbo3 turbo4 turbo3_tcq qjl polar polar_preht fused_attn_qjl_tbq fused_attn_qjl_polar; do
  "$GLSLC" --target-env=vulkan1.1 --target-spv=spv1.3 \
    -fshader-stage=compute "../vulkan/${shader}.comp" -o "$OUT_DIR/spv/${shader}.spv"
done

cp fixtures/turbo3.json fixtures/turbo4.json fixtures/turbo3_tcq.json \
  fixtures/qjl.json fixtures/polar.json fixtures/polar_qjl.json \
  fixtures/fused_attn_qjl_tbq.json fixtures/fused_attn_qjl_tbq_causal.json \
  fixtures/fused_attn_qjl_polar.json fixtures/fused_attn_qjl_polar_causal.json \
  "$OUT_DIR/fixtures/"

adb_cmd() {
  if [[ -n "$ADB_SERIAL" ]]; then
    "$ADB" -s "$ADB_SERIAL" "$@"
  else
    "$ADB" "$@"
  fi
}

echo "[android-vulkan-smoke] pushing to ${REMOTE_DIR}"
adb_cmd wait-for-device
SERIAL="$(adb_cmd get-serialno 2>/dev/null || true)"
MANUFACTURER="$(adb_cmd shell getprop ro.product.manufacturer 2>/dev/null | tr -d '\r' || true)"
MODEL="$(adb_cmd shell getprop ro.product.model 2>/dev/null | tr -d '\r' || true)"
HARDWARE="$(adb_cmd shell getprop ro.hardware 2>/dev/null | tr -d '\r' || true)"
BOARD_PLATFORM="$(adb_cmd shell getprop ro.board.platform 2>/dev/null | tr -d '\r' || true)"
QEMU="$(adb_cmd shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r' || true)"
BOOT_QEMU="$(adb_cmd shell getprop ro.boot.qemu 2>/dev/null | tr -d '\r' || true)"
echo "[android-vulkan-smoke] device serial=${SERIAL:-unknown} manufacturer=${MANUFACTURER:-unknown} model=${MODEL:-unknown} hardware=${HARDWARE:-unknown} board=${BOARD_PLATFORM:-unknown} qemu=${QEMU:-unknown}/${BOOT_QEMU:-unknown}"
if [[ "$QEMU" == "1" && "$ALLOW_EMULATOR" != "1" ]]; then
  fail 3 "refusing emulator device. Connect a physical Adreno/Mali handset/tablet, or set ELIZA_ALLOW_ANDROID_EMULATOR_VULKAN=1 for diagnostics only"
fi
if [[ "$BOOT_QEMU" == "1" && "$ALLOW_EMULATOR" != "1" ]]; then
  fail 3 "refusing emulator boot profile. Connect a physical Adreno/Mali handset/tablet, or set ELIZA_ALLOW_ANDROID_EMULATOR_VULKAN=1 for diagnostics only"
fi
VKJSON="$(adb_cmd shell cmd gpu vkjson 2>/dev/null || true)"
if [[ -n "$VKJSON" ]]; then
  echo "[android-vulkan-smoke] cmd gpu vkjson:"
  printf '%s\n' "$VKJSON" | awk 'NR <= 120 { print }'
else
  echo "[android-vulkan-smoke] cmd gpu vkjson unavailable; fixture harness will enumerate Vulkan directly"
fi
if [[ -n "$VKJSON" ]] && [[ "$ALLOW_SOFTWARE" != "1" ]] && echo "$VKJSON" | grep -Eiq 'llvmpipe|swiftshader|software rasterizer'; then
  fail 3 "refusing software Vulkan device. Connect real Adreno/Mali hardware, or set ELIZA_ALLOW_SOFTWARE_VULKAN=1 for diagnostics only"
fi
adb_cmd shell "rm -rf '${REMOTE_DIR}' && mkdir -p '${REMOTE_DIR}/fixtures'"
adb_cmd push "$OUT_DIR/vulkan_verify" "${REMOTE_DIR}/vulkan_verify" >/dev/null
adb_cmd push "$OUT_DIR/spv/." "${REMOTE_DIR}/" >/dev/null
adb_cmd push "$OUT_DIR/fixtures/." "${REMOTE_DIR}/fixtures/" >/dev/null
adb_cmd shell "chmod 755 '${REMOTE_DIR}/vulkan_verify'"

run_remote() {
  local shader="$1"
  local fixture="$2"
  echo "[android-vulkan-smoke] ${shader} ${fixture}"
  adb_cmd shell "cd '${REMOTE_DIR}' && ELIZA_ALLOW_SOFTWARE_VULKAN='${ALLOW_SOFTWARE}' ./vulkan_verify '${shader}.spv' 'fixtures/${fixture}.json'"
}

run_remote turbo3 turbo3
run_remote turbo4 turbo4
run_remote turbo3_tcq turbo3_tcq
run_remote qjl qjl
run_remote polar polar
run_remote polar polar_qjl
run_remote polar_preht polar
run_remote polar_preht polar_qjl
run_remote fused_attn_qjl_tbq fused_attn_qjl_tbq
run_remote fused_attn_qjl_tbq fused_attn_qjl_tbq_causal
run_remote fused_attn_qjl_polar fused_attn_qjl_polar
run_remote fused_attn_qjl_polar fused_attn_qjl_polar_causal

echo "[android-vulkan-smoke] standalone Vulkan fixtures passed on Android device."

if [[ "${ELIZA_ANDROID_VULKAN_STANDALONE_ONLY:-0}" == "1" ]]; then
  echo "[android-vulkan-smoke] PASS standalone-only diagnostic. Runtime graph dispatch still requires ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE before CAPABILITIES can flip runtime-ready."
  echo "[android-vulkan-smoke] evidence log: $REPORT_PATH"
  exit 0
fi

GRAPH_EVIDENCE="${ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE:-}"
if [[ -z "$GRAPH_EVIDENCE" ]]; then
  fail 4 "missing ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE. Standalone SPIR-V fixture success does not prove built-fork/app graph dispatch and cannot flip runtime-ready capability bits"
fi
if [[ ! -f "$GRAPH_EVIDENCE" ]]; then
  fail 4 "ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE does not exist: $GRAPH_EVIDENCE"
fi

node - "$GRAPH_EVIDENCE" <<'NODE'
const fs = require("node:fs");
const p = process.argv[2];
const data = JSON.parse(fs.readFileSync(p, "utf8"));
const failures = [];
const requiredRoutes = [
  "GGML_OP_ATTN_SCORE_QJL",
  "GGML_OP_ATTN_SCORE_TBQ/turbo3",
  "GGML_OP_ATTN_SCORE_TBQ/turbo4",
  "GGML_OP_ATTN_SCORE_TBQ/turbo3_tcq",
  "GGML_OP_ATTN_SCORE_POLAR/use_qjl=0",
  "GGML_OP_ATTN_SCORE_POLAR/use_qjl=1",
  "GGML_OP_FUSED_ATTN_QJL_TBQ",
];
const requiredCapabilities = [
  "turbo3",
  "turbo4",
  "turbo3_tcq",
  "qjl_full",
  "polarquant",
  "fused_attn_qjl_tbq",
];
const finite = (value) => typeof value === "number" && Number.isFinite(value);
if (data.backend !== "vulkan") failures.push(`backend=${data.backend}`);
if (data.platform !== "android") failures.push(`platform=${data.platform}`);
if (data.runtimeReady !== true) failures.push(`runtimeReady=${data.runtimeReady}`);

const routes = new Map();
for (const route of Array.isArray(data.graphRoutes) ? data.graphRoutes : []) {
  if (typeof route === "string") {
    routes.set(route, {
      runtimeReady: data.runtimeReady,
      status: data.status,
      maxDiff: data.maxDiff,
    });
  } else if (route && typeof route === "object") {
    const label = route.label || route.name || route.graphRoute || route.graphOp;
    if (label) routes.set(label, route);
  }
}
const routeEvidenceOk =
  requiredRoutes.every((label) => {
    const entry = routes.get(label);
    return Boolean(
      entry &&
        entry.runtimeReady !== false &&
        entry.status !== "fail" &&
        finite(entry.maxDiff ?? data.maxDiff),
    );
  });

const kernels = data.kernels && typeof data.kernels === "object" ? data.kernels : {};
const kernelEntries = Object.values(kernels).filter(
  (entry) => entry && typeof entry === "object",
);
const kernelEvidenceOk =
  requiredCapabilities.every((capability) => {
    const entry = kernelEntries.find(
      (candidate) => candidate.runtimeCapabilityKey === capability,
    );
    return Boolean(
      entry &&
        entry.runtimeReady === true &&
        entry.status === "runtime-ready" &&
        finite(entry.maxDiff),
    );
  });

if (!routeEvidenceOk && !kernelEvidenceOk) {
  failures.push(
    "missing full seven-route graphRoutes evidence or six-capability kernels evidence with finite maxDiff",
  );
}
if (failures.length) {
  console.error(`[android-vulkan-smoke] invalid graph evidence ${p}: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`[android-vulkan-smoke] graph evidence accepted: ${p}`);
NODE

echo "[android-vulkan-smoke] PASS Android Vulkan standalone fixtures plus supplied built-fork/app graph evidence"
echo "[android-vulkan-smoke] evidence log: $REPORT_PATH"
