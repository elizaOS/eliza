#!/usr/bin/env bash
# Cuttlefish (cvd) x86_64 application-native kernel parity smoke.
#
# Cross-compiles `gen_fixture` (and `vulkan_verify` for the diagnostic-only
# SwiftShader path) with the Android NDK for `x86_64-linux-android`, pushes
# them to a live `cvd` instance via `adb`, runs `gen_fixture --self-test`
# (the canonical C-reference parity check for all six required kernels +
# fused-attn + tbq V-cache), and writes the recordable evidence JSON to
# an OS-owned evidence report.
#
# This is the same gate documented in `kernel-contract.json`'s
# `platformTargets.android-x86_64-cpu` and in `PLATFORM_MATRIX.md`.
#
# Prereqs:
#   - `cvd` running an `aosp_cf_x86_64_phone-trunk_staging-userdebug` instance
#     (cvd-1 reachable via `adb devices`; run user in `kvm` + `cvdnetwork`
#     groups). `cvd start` it first if not.
#   - Android NDK installed (set ANDROID_NDK_HOME, ANDROID_NDK_ROOT, or
#     ANDROID_NDK; or place the NDK under $HOME/Android/Sdk/ndk).
#   - `adb` on PATH (or set ADB).
#
# Vulkan-on-cvd can use gfxstream hardware forwarding or a software ICD.
# The verifier reports the selected device; a software fixture pass is
# diagnostic-only and must not be recorded as hardware runtime readiness.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ELIZA_ROOT="$(node "$OS_ROOT/scripts/eliza-source.ts")"
SOURCE_VERIFY_DIR="$ELIZA_ROOT/plugins/plugin-local-inference/native/verify"
if [[ -z "$ELIZA_ROOT" || ! -d "$SOURCE_VERIFY_DIR" ]]; then
  echo "[cuttlefish-x86_64-smoke] FAIL: set ELIZAOS_ELIZA_ROOT to an elizaOS/eliza checkout" >&2
  exit 2
fi
cd "$SOURCE_VERIFY_DIR"

ADB="${ADB:-adb}"
ANDROID_SERIAL="${ANDROID_SERIAL:-}"
ANDROID_API="${ANDROID_API:-24}"
REMOTE_DIR="${ELIZA_CUTTLEFISH_REMOTE_DIR:-/data/local/tmp/eliza-x86_64-verify}"
OUT_DIR="${ELIZA_CUTTLEFISH_OUT_DIR:-$OS_ROOT/reports/cuttlefish/kernel-parity}"
EVIDENCE_OUT="${ELIZA_CUTTLEFISH_EVIDENCE_OUT:-$OS_ROOT/reports/cuttlefish/android-x86_64-cpu.json}"
SKIP_VULKAN_DIAG="${ELIZA_CUTTLEFISH_SKIP_VULKAN:-0}"

fail() { echo "[cuttlefish-x86_64-smoke] FAIL: $*" >&2; exit "${2:-1}"; }
log()  { echo "[cuttlefish-x86_64-smoke] $*"; }

# 1. Resolve NDK + clang + glslc (x86_64 linux host).
resolve_ndk() {
  for cand in "${ANDROID_NDK_HOME:-}" "${ANDROID_NDK_ROOT:-}" "${ANDROID_NDK:-}"; do
    [[ -n "$cand" && -f "$cand/build/cmake/android.toolchain.cmake" ]] && { printf '%s\n' "$cand"; return 0; }
  done
  for sdk in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk"; do
    [[ -n "$sdk" && -d "$sdk/ndk" ]] && { find "$sdk/ndk" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1; return 0; }
  done
  return 1
}
NDK="$(resolve_ndk || true)"
[[ -z "$NDK" || ! -d "$NDK/toolchains/llvm/prebuilt/linux-x86_64" ]] && fail "Android NDK not found. Set ANDROID_NDK_HOME"
TOOLBIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
CC="$TOOLBIN/x86_64-linux-android${ANDROID_API}-clang"
CXX="$TOOLBIN/x86_64-linux-android${ANDROID_API}-clang++"
GLSLC="${GLSLC:-$NDK/shader-tools/linux-x86_64/glslc}"
[[ ! -x "$CC" ]] && fail "missing NDK clang: $CC"
command -v "$ADB" >/dev/null 2>&1 || fail "adb not found"

# 2. Pick adb device (prefer cvd / qemu device).
mapfile -t DEVICES < <("$ADB" devices | awk '$2 == "device" { print $1 }')
[[ "${#DEVICES[@]}" -eq 0 ]] && fail "no adb devices — start a cvd first (e.g. cvd start)"
if [[ -z "$ANDROID_SERIAL" ]]; then
  for s in "${DEVICES[@]}"; do
    if "$ADB" -s "$s" shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r' | grep -qx 1; then
      ANDROID_SERIAL="$s"; break
    fi
  done
  if [[ -z "$ANDROID_SERIAL" && "${#DEVICES[@]}" -eq 1 ]]; then
    ANDROID_SERIAL="${DEVICES[0]}"
  fi
  [[ -z "$ANDROID_SERIAL" ]] && fail "multiple adb devices; set ANDROID_SERIAL to the cvd serial"
fi
ABI="$("$ADB" -s "$ANDROID_SERIAL" shell getprop ro.product.cpu.abi | tr -d '\r')"
[[ "$ABI" != "x86_64" ]] && fail "selected device $ANDROID_SERIAL has abi=$ABI, expected x86_64. Set ANDROID_SERIAL to a cvd_x86_64 instance."

[[ "$REMOTE_DIR" =~ ^/data/local/tmp/[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*$ ]] || fail "remote fixture path must be beneath /data/local/tmp with safe characters"
[[ ! -e "$EVIDENCE_OUT" && ! -L "$EVIDENCE_OUT" ]] || fail "evidence output already exists; choose a fresh run path"
node "$SCRIPT_DIR/kernel-parity-evidence.ts" begin "$ELIZA_ROOT" "$OUT_DIR"
"$CC" --version > "$OUT_DIR/compiler-version.txt"
cp "$NDK/source.properties" "$OUT_DIR/ndk.properties"

log "cvd device=$ANDROID_SERIAL abi=$ABI"
log "host=$(uname -a)"

# 3. Generate canonical fixtures + build NDK x86_64 ELFs.
log "generating canonical fixtures..."
make -B reference-test >/dev/null
cp gen_fixture "$OUT_DIR/gen_fixture_host"
mkdir -p "$OUT_DIR/spv" "$OUT_DIR/fixtures"

log "compiling gen_fixture (x86_64-linux-android${ANDROID_API})..."
"$CC" -O2 -Wall -Wextra -std=c11 -I../reference -c ../reference/turbo_kernels.c -o "$OUT_DIR/turbo_kernels.o"
"$CC" -O2 -Wall -Wextra -std=c11 -I. -c qjl_polar_ref.c -o "$OUT_DIR/qjl_polar_ref.o"
"$CC" -O2 -Wall -Wextra -std=c11 -I../reference -I. \
  gen_fixture.c "$OUT_DIR/turbo_kernels.o" "$OUT_DIR/qjl_polar_ref.o" \
  -lm -static -o "$OUT_DIR/gen_fixture_android_x86_64"

if [[ "$SKIP_VULKAN_DIAG" != "1" ]]; then
  log "compiling vulkan_verify (fixture diagnostics)..."
  "$CXX" -O2 -Wall -Wextra -std=c++17 -I../reference -I. \
    vulkan_verify.cpp "$OUT_DIR/turbo_kernels.o" "$OUT_DIR/qjl_polar_ref.o" \
    -static-libstdc++ -lvulkan -lm -o "$OUT_DIR/vulkan_verify"
  for shader in turbo3 turbo4 turbo3_tcq qjl polar polar_preht; do
    [[ -x "$GLSLC" ]] || fail "glslc not found at $GLSLC"
    "$GLSLC" --target-env=vulkan1.1 --target-spv=spv1.3 \
      -fshader-stage=compute "../vulkan/${shader}.comp" -o "$OUT_DIR/spv/${shader}.spv"
  done
fi
cp fixtures/turbo3.json fixtures/turbo4.json fixtures/turbo3_tcq.json \
  fixtures/qjl.json fixtures/polar.json fixtures/polar_qjl.json "$OUT_DIR/fixtures/"

# 4. Push to cvd.
log "pushing to ${REMOTE_DIR}..."
ADB_S=("$ADB" -s "$ANDROID_SERIAL")
"${ADB_S[@]}" shell "rm -rf '${REMOTE_DIR}' && mkdir -p '${REMOTE_DIR}/fixtures'"
"${ADB_S[@]}" push "$OUT_DIR/gen_fixture_android_x86_64" "${REMOTE_DIR}/" >/dev/null
if [[ "$SKIP_VULKAN_DIAG" != "1" ]]; then
  "${ADB_S[@]}" push "$OUT_DIR/vulkan_verify" "${REMOTE_DIR}/" >/dev/null
  "${ADB_S[@]}" push "$OUT_DIR/spv/." "${REMOTE_DIR}/" >/dev/null
fi
"${ADB_S[@]}" push "$OUT_DIR/fixtures/." "${REMOTE_DIR}/fixtures/" >/dev/null
"${ADB_S[@]}" shell "chmod 755 '${REMOTE_DIR}/gen_fixture_android_x86_64'"
[[ "$SKIP_VULKAN_DIAG" != "1" ]] && "${ADB_S[@]}" shell "chmod 755 '${REMOTE_DIR}/vulkan_verify'"

# Bind the actual guest executable before and after the run.
"${ADB_S[@]}" shell "sha256sum '${REMOTE_DIR}/gen_fixture_android_x86_64'" | tr -d '\r' > "$OUT_DIR/device-binary-before.txt"
"${ADB_S[@]}" shell getprop ro.product.cpu.abi | tr -d '\r' > "$OUT_DIR/device-abi.txt"
"${ADB_S[@]}" shell getprop ro.product.device | tr -d '\r' > "$OUT_DIR/device-product.txt"
"${ADB_S[@]}" shell getprop ro.build.fingerprint | tr -d '\r' > "$OUT_DIR/device-fingerprint.txt"
"${ADB_S[@]}" shell uname -a | tr -d '\r' > "$OUT_DIR/device-kernel.txt"

# 5. Run gen_fixture --self-test (THE recordable gate).
log "running gen_fixture --self-test on cvd..."
SELFTEST_OUT="$("${ADB_S[@]}" shell "cd '${REMOTE_DIR}' && ./gen_fixture_android_x86_64 --self-test" | tr -d '\r')"
echo "$SELFTEST_OUT"
echo "$SELFTEST_OUT" | grep -Eq "all finite; fused-attn \+ tbq V-cache( \+ split-K online-softmax merge)? parity OK" || \
  fail "gen_fixture --self-test on cvd did not produce the expected success line"

# Host baseline for parity check.
HOST_OUT="$("$OUT_DIR/gen_fixture_host" --self-test | tr -d '\r')"
[[ "$SELFTEST_OUT" == "$HOST_OUT" ]] || \
  fail "cvd self-test output does not match host bit-for-bit (host: $HOST_OUT vs cvd: $SELFTEST_OUT)"
printf '%s\n' "$SELFTEST_OUT" > "$OUT_DIR/device-selftest.txt"
printf '%s\n' "$HOST_OUT" > "$OUT_DIR/host-selftest.txt"
"${ADB_S[@]}" shell "sha256sum '${REMOTE_DIR}/gen_fixture_android_x86_64'" | tr -d '\r' > "$OUT_DIR/device-binary-after.txt"
log "PASS — cvd self-test bit-identical to host."

# 6. Vulkan fixture diagnostics. The verifier reports the actual guest GPU.
# Software rendering remains diagnostic-only, but a requested check must pass.
if [[ "$SKIP_VULKAN_DIAG" != "1" ]]; then
  log "running vulkan_verify on cvd (fixture diagnostics)..."
  vulkan_failures=0
  for c in "turbo3 turbo3" "turbo4 turbo4" "turbo3_tcq turbo3_tcq" "qjl qjl" "polar polar" "polar polar_qjl" "polar_preht polar" "polar_preht polar_qjl"; do
    set -- $c
    shader=$1; fixture=$2
    if "${ADB_S[@]}" shell "cd '${REMOTE_DIR}' && ELIZA_ALLOW_SOFTWARE_VULKAN=1 ./vulkan_verify '${shader}.spv' 'fixtures/${fixture}.json'"; then
      log "  DIAGNOSTIC PASS ${shader} ${fixture}.json"
    else
      log "  DIAGNOSTIC FAIL ${shader} ${fixture}.json"
      vulkan_failures=$((vulkan_failures + 1))
    fi
  done
  [[ "$vulkan_failures" -eq 0 ]] || fail "CPU parity passed, but $vulkan_failures Vulkan fixture checks failed."
fi

# 7. Emit a fresh report only after every requested check has succeeded.
ANDROID_SERIAL="$ANDROID_SERIAL" node "$SCRIPT_DIR/kernel-parity-evidence.ts" \
  finish "$ELIZA_ROOT" "$OUT_DIR" "$EVIDENCE_OUT"
log "OK — Android x86_64 CPU kernel-reference parity verified; evidence: $EVIDENCE_OUT"
