#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ANDROID_API="${ANDROID_API:-28}"
REMOTE_DIR="${ELIZA_ANDROID_VULKAN_REMOTE_DIR:-/data/local/tmp/eliza-kernels}"
OUT_DIR="${ELIZA_ANDROID_VULKAN_OUT_DIR:-android-vulkan-smoke}"
ADB="${ADB:-adb}"
ALLOW_EMULATOR="${ELIZA_ALLOW_ANDROID_EMULATOR_VULKAN:-0}"
ALLOW_SOFTWARE="${ELIZA_ALLOW_SOFTWARE_VULKAN:-0}"
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
if ! command -v "$ADB" >/dev/null 2>&1; then
  fail 2 "adb not found. Set ADB=/path/to/adb"
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/spv" "$OUT_DIR/fixtures"

echo "[android-vulkan-smoke] compiling verifier for arm64-v8a API ${ANDROID_API}"
"$CC" -O2 -Wall -Wextra -std=c11 -I../reference -c ../reference/turbo_kernels.c -o "$OUT_DIR/turbo_kernels.o"
"$CC" -O2 -Wall -Wextra -std=c11 -I. -c qjl_polar_ref.c -o "$OUT_DIR/qjl_polar_ref.o"
"$CXX" -O2 -Wall -Wextra -std=c++17 -I../reference -I. \
  vulkan_verify.cpp "$OUT_DIR/turbo_kernels.o" "$OUT_DIR/qjl_polar_ref.o" \
  -static-libstdc++ -lvulkan -lm -o "$OUT_DIR/vulkan_verify"

echo "[android-vulkan-smoke] compiling SPIR-V with $GLSLC"
for shader in turbo3 turbo4 turbo3_tcq qjl polar; do
  "$GLSLC" --target-env=vulkan1.1 --target-spv=spv1.3 \
    -fshader-stage=compute "../vulkan/${shader}.comp" -o "$OUT_DIR/spv/${shader}.spv"
done

cp fixtures/turbo3.json fixtures/turbo4.json fixtures/turbo3_tcq.json \
  fixtures/qjl.json fixtures/polar.json fixtures/polar_qjl.json "$OUT_DIR/fixtures/"

ADB_SERIAL="${ANDROID_SERIAL:-}"
if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  ADB_SERIAL="$ANDROID_SERIAL"
else
  ADB_DEVICES=()
  while IFS= read -r serial; do
    [[ -n "$serial" ]] && ADB_DEVICES+=("$serial")
  done < <("$ADB" devices | awk '$2 == "device" { print $1 }')
  if [[ "${#ADB_DEVICES[@]}" -gt 1 ]]; then
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
      echo "[android-vulkan-smoke] multiple adb devices attached: ${ADB_DEVICES[*]}. Set ANDROID_SERIAL to the physical Adreno/Mali device." >&2
      exit 2
    fi
  fi
fi

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
  printf '%s\n' "$VKJSON" | head -120
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
  adb_cmd shell "cd '${REMOTE_DIR}' && ./vulkan_verify '${shader}.spv' 'fixtures/${fixture}.json'"
}

run_remote turbo3 turbo3
run_remote turbo4 turbo4
run_remote turbo3_tcq turbo3_tcq
run_remote qjl qjl
run_remote polar polar
run_remote polar polar_qjl

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
if (data.backend !== "vulkan") failures.push(`backend=${data.backend}`);
if (data.platform !== "android") failures.push(`platform=${data.platform}`);
if (data.graphOp !== "GGML_OP_ATTN_SCORE_QJL") failures.push(`graphOp=${data.graphOp}`);
if (data.runtimeReady !== true) failures.push(`runtimeReady=${data.runtimeReady}`);
if (typeof data.maxDiff !== "number" || !Number.isFinite(data.maxDiff)) failures.push("maxDiff missing/non-finite");
if (failures.length) {
  console.error(`[android-vulkan-smoke] invalid graph evidence ${p}: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`[android-vulkan-smoke] graph evidence accepted: ${p}`);
NODE

echo "[android-vulkan-smoke] PASS Android Vulkan standalone fixtures plus supplied built-fork/app graph evidence"
echo "[android-vulkan-smoke] evidence log: $REPORT_PATH"
