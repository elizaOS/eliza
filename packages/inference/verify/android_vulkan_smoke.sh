#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

ANDROID_API="${ANDROID_API:-28}"
REMOTE_DIR="${ELIZA_ANDROID_VULKAN_REMOTE_DIR:-/data/local/tmp/eliza-kernels}"
OUT_DIR="${ELIZA_ANDROID_VULKAN_OUT_DIR:-android-vulkan-smoke}"
ADB="${ADB:-adb}"

resolve_ndk() {
  for candidate in "${ANDROID_NDK_HOME:-}" "${ANDROID_NDK_ROOT:-}" "${ANDROID_NDK:-}"; do
    if [[ -n "$candidate" && -f "$candidate/build/cmake/android.toolchain.cmake" ]]; then
      printf '%s\n' "$candidate"
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
  echo "[android-vulkan-smoke] Android NDK not found. Set ANDROID_NDK_HOME." >&2
  exit 2
fi

HOST_TAG=""
for candidate in darwin-arm64 darwin-x86_64 linux-x86_64 windows-x86_64; do
  if [[ -d "$NDK/toolchains/llvm/prebuilt/$candidate" ]]; then
    HOST_TAG="$candidate"
    break
  fi
done
if [[ -z "$HOST_TAG" ]]; then
  echo "[android-vulkan-smoke] could not find NDK LLVM prebuilt under $NDK/toolchains/llvm/prebuilt" >&2
  exit 2
fi

TOOLBIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG/bin"
CC="$TOOLBIN/aarch64-linux-android${ANDROID_API}-clang"
CXX="$TOOLBIN/aarch64-linux-android${ANDROID_API}-clang++"
GLSLC="${GLSLC:-$NDK/shader-tools/$HOST_TAG/glslc}"

if [[ ! -x "$CC" || ! -x "$CXX" ]]; then
  echo "[android-vulkan-smoke] missing NDK clang tools for host tag $HOST_TAG" >&2
  exit 2
fi
if [[ ! -x "$GLSLC" ]]; then
  echo "[android-vulkan-smoke] glslc not found at $GLSLC" >&2
  exit 2
fi
if ! command -v "$ADB" >/dev/null 2>&1; then
  echo "[android-vulkan-smoke] adb not found. Set ADB=/path/to/adb." >&2
  exit 2
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/spv" "$OUT_DIR/fixtures"

echo "[android-vulkan-smoke] compiling verifier for arm64-v8a API ${ANDROID_API}"
"$CC" -O2 -Wall -Wextra -std=c11 -I../reference -c ../reference/turbo_kernels.c -o "$OUT_DIR/turbo_kernels.o"
"$CC" -O2 -Wall -Wextra -std=c11 -I. -c qjl_polar_ref.c -o "$OUT_DIR/qjl_polar_ref.o"
"$CXX" -O2 -Wall -Wextra -std=c++17 -I../reference -I. \
  vulkan_verify.cpp "$OUT_DIR/turbo_kernels.o" "$OUT_DIR/qjl_polar_ref.o" \
  -lvulkan -lm -o "$OUT_DIR/vulkan_verify"

echo "[android-vulkan-smoke] compiling SPIR-V with $GLSLC"
for shader in turbo3 turbo4 turbo3_tcq qjl polar; do
  "$GLSLC" --target-env=vulkan1.1 --target-spv=spv1.3 \
    -fshader-stage=compute "../vulkan/${shader}.comp" -o "$OUT_DIR/spv/${shader}.spv"
done

cp fixtures/turbo3.json fixtures/turbo4.json fixtures/turbo3_tcq.json \
  fixtures/qjl.json fixtures/polar.json fixtures/polar_qjl.json "$OUT_DIR/fixtures/"

ADB_ARGS=()
if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  ADB_ARGS=(-s "$ANDROID_SERIAL")
fi

echo "[android-vulkan-smoke] pushing to ${REMOTE_DIR}"
"$ADB" "${ADB_ARGS[@]}" wait-for-device
"$ADB" "${ADB_ARGS[@]}" shell "rm -rf '${REMOTE_DIR}' && mkdir -p '${REMOTE_DIR}/fixtures'"
"$ADB" "${ADB_ARGS[@]}" push "$OUT_DIR/vulkan_verify" "${REMOTE_DIR}/vulkan_verify" >/dev/null
"$ADB" "${ADB_ARGS[@]}" push "$OUT_DIR/spv/." "${REMOTE_DIR}/" >/dev/null
"$ADB" "${ADB_ARGS[@]}" push "$OUT_DIR/fixtures/." "${REMOTE_DIR}/fixtures/" >/dev/null
"$ADB" "${ADB_ARGS[@]}" shell "chmod 755 '${REMOTE_DIR}/vulkan_verify'"

run_remote() {
  local shader="$1"
  local fixture="$2"
  echo "[android-vulkan-smoke] ${shader} ${fixture}"
  "$ADB" "${ADB_ARGS[@]}" shell "cd '${REMOTE_DIR}' && ./vulkan_verify '${shader}.spv' 'fixtures/${fixture}.json'"
}

run_remote turbo3 turbo3
run_remote turbo4 turbo4
run_remote turbo3_tcq turbo3_tcq
run_remote qjl qjl
run_remote polar polar
run_remote polar polar_qjl

echo "[android-vulkan-smoke] PASS standalone Vulkan fixtures on Android device. Runtime graph dispatch still requires a built app/fork smoke before CAPABILITIES can flip runtime-ready."
