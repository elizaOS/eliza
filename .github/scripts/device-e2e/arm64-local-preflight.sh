#!/usr/bin/env bash
# Validates the dedicated Android local-runtime runner before build or device
# mutation. This lane fails closed unless the host and attached target are both
# ARM64 and the repository-pinned toolchains are already installed.

set -euo pipefail

fail_preflight() {
  printf 'phase=preflight status=failed code=%s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null || fail_preflight NODE_UNAVAILABLE
command -v bun >/dev/null || fail_preflight BUN_UNAVAILABLE
[[ "$(node --version 2>/dev/null)" == "v24.15.0" ]] \
  || fail_preflight NODE_VERSION_INVALID
[[ "$(bun --version 2>/dev/null)" == "1.3.14" ]] \
  || fail_preflight BUN_VERSION_INVALID
[[ "$(node -p 'process.arch' 2>/dev/null)" == "arm64" ]] \
  || fail_preflight NODE_ARCH_INVALID

host_arch=$(uname -m 2>/dev/null) || fail_preflight HOST_ARCH_UNAVAILABLE
[[ "$host_arch" == "aarch64" || "$host_arch" == "arm64" ]] \
  || fail_preflight HOST_ARCH_INVALID

command -v java >/dev/null || fail_preflight JAVA_UNAVAILABLE
command -v adb >/dev/null || fail_preflight ADB_UNAVAILABLE
command -v ffmpeg >/dev/null || fail_preflight FFMPEG_UNAVAILABLE

java_major=$(java -XshowSettings:properties -version 2>&1 \
  | awk -F= '$1 ~ /java.specification.version/ { gsub(/[[:space:]]/, "", $2); print $2; exit }') \
  || fail_preflight JAVA_VERSION_UNAVAILABLE
[[ "$java_major" == "21" ]] || fail_preflight JAVA_VERSION_INVALID

attached_devices=()
while IFS= read -r attached_device; do
  [[ -n "$attached_device" ]] && attached_devices+=("$attached_device")
done < <(adb devices 2>/dev/null \
  | awk 'NR > 1 && $2 == "device" { print $1 }')
if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  printf '%s\n' "${attached_devices[@]}" | grep -Fx -- "$ANDROID_SERIAL" >/dev/null \
    || fail_preflight DEVICE_SELECTION_INVALID
elif [[ ${#attached_devices[@]} -eq 1 ]]; then
  ANDROID_SERIAL=${attached_devices[0]}
else
  fail_preflight DEVICE_SELECTION_INVALID
fi

device_abi=$(adb -s "$ANDROID_SERIAL" shell getprop ro.product.cpu.abi 2>/dev/null \
  | tr -d '\r') || fail_preflight DEVICE_ABI_UNAVAILABLE
[[ "$device_abi" == "arm64-v8a" ]] || fail_preflight DEVICE_ABI_INVALID
boot_completed=$(adb -s "$ANDROID_SERIAL" shell getprop sys.boot_completed 2>/dev/null \
  | tr -d '\r') || fail_preflight DEVICE_BOOT_STATUS_UNAVAILABLE
[[ "$boot_completed" == "1" ]] || fail_preflight DEVICE_NOT_BOOTED

[[ -n "${GITHUB_ENV:-}" ]] || fail_preflight GITHUB_ENV_MISSING
printf 'ANDROID_SERIAL=%s\n' "$ANDROID_SERIAL" >> "$GITHUB_ENV" \
  || fail_preflight GITHUB_ENV_WRITE_FAILED
printf 'phase=preflight status=passed code=ARM64_DEVICE_READY checks=8\n'
