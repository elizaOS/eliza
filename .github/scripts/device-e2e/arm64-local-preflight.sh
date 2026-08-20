#!/usr/bin/env bash
# Validates the dedicated Android local-runtime runner before build or device
# mutation. This lane fails closed unless the host and attached target are both
# ARM64 and the repository-pinned toolchains are already installed.

set -euo pipefail

[[ "$(node --version)" == "v24.15.0" ]] || {
  echo "Android ARM64 lane requires Node v24.15.0" >&2
  exit 1
}
[[ "$(bun --version)" == "1.3.14" ]] || {
  echo "Android ARM64 lane requires Bun 1.3.14" >&2
  exit 1
}
[[ "$(node -p 'process.arch')" == "arm64" ]] || {
  echo "Android ARM64 lane requires an arm64 Node runtime" >&2
  exit 1
}

host_arch=$(uname -m)
[[ "$host_arch" == "aarch64" || "$host_arch" == "arm64" ]] || {
  echo "Android ARM64 lane requires an ARM64 kernel host; found ${host_arch:-missing}" >&2
  exit 1
}

command -v java >/dev/null
command -v adb >/dev/null

java_major=$(java -XshowSettings:properties -version 2>&1 \
  | awk -F= '$1 ~ /java.specification.version/ { gsub(/[[:space:]]/, "", $2); print $2; exit }')
[[ "$java_major" == "21" ]] || {
  echo "Android ARM64 lane requires Java 21; found ${java_major:-missing}" >&2
  exit 1
}

mapfile -t attached_devices < <(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')
if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  printf '%s\n' "${attached_devices[@]}" | grep -Fx -- "$ANDROID_SERIAL" >/dev/null || {
    echo "ANDROID_SERIAL=$ANDROID_SERIAL is not an attached authorized device" >&2
    exit 1
  }
elif [[ ${#attached_devices[@]} -eq 1 ]]; then
  ANDROID_SERIAL=${attached_devices[0]}
else
  echo "Set ANDROID_SERIAL when the runner does not have exactly one attached device" >&2
  exit 1
fi

device_abi=$(adb -s "$ANDROID_SERIAL" shell getprop ro.product.cpu.abi | tr -d '\r')
[[ "$device_abi" == "arm64-v8a" ]] || {
  echo "Android local-runtime lane requires arm64-v8a; found ${device_abi:-missing}" >&2
  exit 1
}
[[ "$(adb -s "$ANDROID_SERIAL" shell getprop sys.boot_completed | tr -d '\r')" == "1" ]] || {
  echo "Android device $ANDROID_SERIAL has not completed boot" >&2
  exit 1
}

printf 'ANDROID_SERIAL=%s\n' "$ANDROID_SERIAL" >> "${GITHUB_ENV:?GITHUB_ENV is required}"
printf 'Validated ARM64 host and Android target %s (%s)\n' "$ANDROID_SERIAL" "$device_abi"
