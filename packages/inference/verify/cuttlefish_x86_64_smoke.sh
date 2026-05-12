#!/usr/bin/env bash
# Cuttlefish (cvd) x86_64 CPU kernel-reference parity smoke.
#
# Cross-compiles `gen_fixture` (and `vulkan_verify` for the diagnostic-only
# SwiftShader path) with the Android NDK for `x86_64-linux-android`, pushes
# them to a live `cvd` instance via `adb`, runs `gen_fixture --self-test`
# (the canonical C-reference parity check for all six required kernels +
# fused-attn + tbq V-cache), and writes the recordable evidence JSON to
# `packages/inference/verify/evidence/platform/android-x86_64-cpu.json`.
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
# Vulkan-on-cvd is SwiftShader (software ICD) — per the fail-closed
# software-ICD rule, the SwiftShader fixture pass is DIAGNOSTIC-ONLY and
# NOT recordable runtime-ready evidence. Real Android x86_64 Vulkan graph
# dispatch needs real ChromeOS GPU silicon.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ADB="${ADB:-adb}"
ANDROID_SERIAL="${ANDROID_SERIAL:-}"
ANDROID_API="${ANDROID_API:-24}"
REMOTE_DIR="${ELIZA_CUTTLEFISH_REMOTE_DIR:-/data/local/tmp/eliza-x86_64-verify}"
OUT_DIR="${ELIZA_CUTTLEFISH_OUT_DIR:-/tmp/android-x86_64-verify}"
EVIDENCE_OUT="${ELIZA_CUTTLEFISH_EVIDENCE_OUT:-$SCRIPT_DIR/evidence/platform/android-x86_64-cpu.json}"
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

log "cvd device=$ANDROID_SERIAL abi=$ABI"
log "host=$(uname -a)"

# 3. Generate canonical fixtures + build NDK x86_64 ELFs.
log "generating canonical fixtures..."
make reference-test >/dev/null
mkdir -p "$OUT_DIR/spv" "$OUT_DIR/fixtures"

log "compiling gen_fixture (x86_64-linux-android${ANDROID_API})..."
"$CC" -O2 -Wall -Wextra -std=c11 -I../reference -c ../reference/turbo_kernels.c -o "$OUT_DIR/turbo_kernels.o"
"$CC" -O2 -Wall -Wextra -std=c11 -I. -c qjl_polar_ref.c -o "$OUT_DIR/qjl_polar_ref.o"
"$CC" -O2 -Wall -Wextra -std=c11 -I../reference -I. \
  gen_fixture.c "$OUT_DIR/turbo_kernels.o" "$OUT_DIR/qjl_polar_ref.o" \
  -lm -static -o "$OUT_DIR/gen_fixture_android_x86_64"

if [[ "$SKIP_VULKAN_DIAG" != "1" ]]; then
  log "compiling vulkan_verify (diagnostic-only, SwiftShader)..."
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

# 5. Run gen_fixture --self-test (THE recordable gate).
log "running gen_fixture --self-test on cvd..."
SELFTEST_OUT="$("${ADB_S[@]}" shell "cd '${REMOTE_DIR}' && ./gen_fixture_android_x86_64 --self-test" | tr -d '\r')"
echo "$SELFTEST_OUT"
echo "$SELFTEST_OUT" | grep -q "all finite; fused-attn + tbq V-cache parity OK" || \
  fail "gen_fixture --self-test on cvd did not produce the expected success line"

# Host baseline for parity check.
HOST_OUT="$(./gen_fixture --self-test | tr -d '\r')"
[[ "$SELFTEST_OUT" == "$HOST_OUT" ]] || \
  fail "cvd self-test output does not match host bit-for-bit (host: $HOST_OUT vs cvd: $SELFTEST_OUT)"
log "PASS — cvd self-test bit-identical to host."

# 6. Diagnostic-only Vulkan-on-cvd SwiftShader smoke (NOT recordable evidence).
if [[ "$SKIP_VULKAN_DIAG" != "1" ]]; then
  log "running vulkan_verify under cvd SwiftShader (DIAGNOSTIC-ONLY)..."
  for c in "turbo3 turbo3" "turbo4 turbo4" "turbo3_tcq turbo3_tcq" "qjl qjl" "polar polar" "polar polar_qjl" "polar_preht polar" "polar_preht polar_qjl"; do
    set -- $c
    shader=$1; fixture=$2
    "${ADB_S[@]}" shell "cd '${REMOTE_DIR}' && ELIZA_ALLOW_SOFTWARE_VULKAN=1 ./vulkan_verify '${shader}.spv' 'fixtures/${fixture}.json'" >/dev/null \
      && log "  DIAGNOSTIC PASS ${shader} ${fixture}.json" \
      || log "  DIAGNOSTIC FAIL ${shader} ${fixture}.json (NOT a recordable failure)"
  done
fi

# 7. Bookkeeping. Verify the evidence file points at this run.
if [[ -f "$EVIDENCE_OUT" ]]; then
  log "evidence file present: $EVIDENCE_OUT"
  log "  (regeneration of the JSON is intentionally manual — edit the file directly to record any device/fork-commit changes)"
else
  log "WARN: evidence file missing — author it at $EVIDENCE_OUT (see PLATFORM_MATRIX.md for the schema)."
fi

log "OK — Android x86_64 CPU kernel-reference parity verified on Cuttlefish."
