#!/usr/bin/env bash
# Runs one emulator lane in a single shell so traps, loops, and process state survive.

set -euo pipefail
adb wait-for-device
ANDROID_DIR="$GITHUB_WORKSPACE/packages/app-core/platforms/android"
GRADLEW="$ANDROID_DIR/gradlew"
chmod +x "$GRADLEW"

# Device-state orchestration (survives the test-APK install):
#  - messages: inject a marker SMS so the SMS read-back asserts positively
#    (it Assume-skips without the marker, so this is what makes it green).
#  - location: high-accuracy mode (the fused fetch still Assume-skips on a
#    headless GNSS HAL; the priority-mapping assertion runs regardless).
adb emu sms send 15558675309 "probe Eliza-9967-SMS-roundtrip ci" || true
adb shell settings put secure location_mode 3 || true

# The gate: build + install + run every native-plugin androidTest on the
# emulator in one invocation. gradle fails the job on any test failure.
# `:app:connectedDebugAndroidTest` adds the app-level assistant/IME/
# assist-surface instrumented tests (#13581) — the RETAIL-path
# ElizaAssistantSurfaceInstrumentedTest runs on the plain debug APK
# (not assumeSystemEliza-gated), so this app run is not vacuously
# green off-AOSP.
"$GRADLEW" -p "$ANDROID_DIR" --no-daemon \
  :app:connectedDebugAndroidTest \
  :elizaos-capacitor-system:connectedDebugAndroidTest \
  :elizaos-capacitor-wifi:connectedDebugAndroidTest \
  :elizaos-capacitor-phone:connectedDebugAndroidTest \
  :elizaos-capacitor-camera:connectedDebugAndroidTest \
  :elizaos-capacitor-contacts:connectedDebugAndroidTest \
  :elizaos-capacitor-messages:connectedDebugAndroidTest \
  :elizaos-capacitor-mobile-signals:connectedDebugAndroidTest \
  :elizaos-capacitor-location:connectedDebugAndroidTest

# mobile-signals PACKAGE_USAGE_STATS is special-access (no runtime dialog)
# and the grant does NOT survive the gate's reinstall, so its usage reads
# Assume-skip above. For a positive on-device read: re-install the test APK
# the gate built (the gate uninstalls it after running), grant
# GET_USAGE_STATS, and re-run the usage tests via am instrument. Require a
# clean `OK (N tests)` completion and fail the job on any error/failure.
MS_APK="$GITHUB_WORKSPACE/plugins/plugin-native-mobile-signals/android/build/outputs/apk/androidTest/debug/elizaos-capacitor-mobile-signals-debug-androidTest.apk"
adb install -r -t "$MS_APK"
adb shell appops set ai.eliza.plugins.mobilesignals.test android:get_usage_stats allow
MS_OUT="$(adb shell am instrument -w -r \
  -e class ai.eliza.plugins.mobilesignals.UsageStatsReaderInstrumentedTest \
  ai.eliza.plugins.mobilesignals.test/androidx.test.runner.AndroidJUnitRunner 2>&1)"
printf '%s\n' "$MS_OUT"
if printf '%s\n' "$MS_OUT" | grep -qE 'FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_RESULT: shortMsg'; then
  echo "mobile-signals UsageStats assertions failed under granted PACKAGE_USAGE_STATS"
  exit 1
fi
printf '%s\n' "$MS_OUT" | grep -qE 'OK \([0-9]+ test' || {
  echo "mobile-signals UsageStats run did not complete cleanly"
  exit 1
}

# Assistant-role / voice-IME / assist-key adb verification lane
# (#13581). The gradle gate above uninstalled its test APKs, so
# install the app APK the Capacitor build produced, then drive the
# RUNTIME surface: re-apply the role + IME that `adb install -r`
# clears, assert the secure settings, fire `cmd voiceinteraction
# show` / `KEYCODE_ASSIST` / the IME deep-link, and assert they land
# in MainActivity. `--require-device` makes a missing device fatal
# (it is present here, so this only guards against a silent skip).
# `--require-engine` is intentionally NOT passed: the emulator carries
# no on-device ASR engine, so the IME ASR round-trip legitimately
# resolves to the designed ENGINE_OFF state — the lane asserts that
# state rather than requiring a transcript. All other assertions
# (registration, role, IME selection, deep-link landing) still gate
# the job.
APP_APK="$GITHUB_WORKSPACE/packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APP_APK" ]; then
  adb install -r -t "$APP_APK"
else
  echo "app-debug.apk not found at $APP_APK — build:android should have produced it"
  exit 1
fi
ASSISTANT_ARTIFACT_DIR="$GITHUB_WORKSPACE/packages/app/test-results/android-assistant-verify"
mkdir -p "$ASSISTANT_ARTIFACT_DIR"
VERIFY_STATUS=0
node "$GITHUB_WORKSPACE/packages/app/scripts/android-assistant-verify.mjs" \
  --require-device --json \
  | tee "$ASSISTANT_ARTIFACT_DIR/verdict.json" || VERIFY_STATUS=$?
adb shell settings get secure voice_interaction_service \
  > "$ASSISTANT_ARTIFACT_DIR/voice_interaction_service.txt" || true
adb shell settings get secure default_input_method \
  > "$ASSISTANT_ARTIFACT_DIR/default_input_method.txt" || true
adb shell ime list -s \
  > "$ASSISTANT_ARTIFACT_DIR/enabled_imes.txt" || true
adb shell cmd role holders android.app.role.ASSISTANT \
  > "$ASSISTANT_ARTIFACT_DIR/assistant_role_holders.txt" || true
adb shell dumpsys activity activities \
  > "$ASSISTANT_ARTIFACT_DIR/dumpsys-activity.txt" || true
adb logcat -d -v brief \
  > "$ASSISTANT_ARTIFACT_DIR/logcat.txt" || true
exit "$VERIFY_STATUS"
