#!/usr/bin/env bash

set -euo pipefail

artifact_root="${ELIZA_DEVICE_BUNDLE_ROOT:?}/android"
release_apk="${GITHUB_WORKSPACE:?}/packages/app/platforms/android/app/build/outputs/apk/release/app-release.apk"
package_id="ai.elizaos.app"

mkdir -p "$artifact_root/inline" "$artifact_root/logs"
# The production Vite graph resolves @elizaos/core through its dist export.
# A clean workflow checkout has no dist until this package boundary is built.
bun run --cwd packages/core build
# The android-system target is the minified release build. The workflow sets
# the ELIZAOS_KEYSTORE_* signing inputs to a disposable identity.
test -s "${ELIZAOS_KEYSTORE_PATH:?}"
bun run --cwd packages/app build:android:system
test -s "$release_apk"

unzip -p "$release_apk" 'classes*.dex' \
  | strings \
  | grep -F 'io/ionic/android_js_engine/NativeWebAPI' \
    > "$artifact_root/logs/release-minify-dex.txt"

adb install -r "$release_apk"
local_sha="$(sha256sum "$release_apk" | cut -d ' ' -f 1)"
device_apk="$(adb shell pm path "$package_id" | sed -n 's/^package://p' | head -n 1)"
device_sha="$(adb shell sha256sum "$device_apk" | cut -d ' ' -f 1)"
test "$local_sha" = "$device_sha"
printf 'local_sha256=%s\ndevice_sha256=%s\ndevice_apk=%s\n' \
  "$local_sha" "$device_sha" "$device_apk" \
  > "$artifact_root/logs/release-minify-install.txt"

adb shell am force-stop "$package_id"
adb logcat -c
adb shell am start -W -n "$package_id/.MainActivity" \
  | tee "$artifact_root/logs/release-minify-launch.txt"
sleep 8
adb shell pidof "$package_id" \
  | tee "$artifact_root/logs/release-minify-pid.txt"
adb logcat -d > "$artifact_root/logs/release-minify-logcat.txt"
if grep -E 'ClassNotFoundException: io\.ionic\.android_js_engine\.NativeWebAPI|FATAL EXCEPTION|SIGABRT' "$artifact_root/logs/release-minify-logcat.txt"; then
  echo 'minified release launch emitted a fatal startup signature' >&2
  exit 1
fi

adb exec-out screencap -p > "$artifact_root/inline/release-minify-launch.png"
adb shell screenrecord --time-limit 8 /sdcard/eliza-release-minify-launch.mp4
adb pull /sdcard/eliza-release-minify-launch.mp4 "$artifact_root/inline/release-minify-launch.mp4"
