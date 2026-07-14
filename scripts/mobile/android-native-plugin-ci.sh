#!/usr/bin/env bash
# Runs Android native-plugin instrumentation after the emulator is ready. It is
# a standalone Bash boundary because the emulator action otherwise fragments
# Gradle continuations, command substitutions, and captured exit status across
# independent `/bin/sh` processes.

set -euo pipefail

REPO_ROOT=${GITHUB_WORKSPACE:?GITHUB_WORKSPACE must identify the checked-out repository}
cd "$REPO_ROOT"
adb wait-for-device

ANDROID_DIR="$REPO_ROOT/packages/app-core/platforms/android"
GRADLEW="$ANDROID_DIR/gradlew"
chmod +x "$GRADLEW"

# The marker SMS turns the messages assertion into a positive read. Location
# remains explicit because headless emulator GNSS availability varies by image.
adb emu sms send 15558675309 "probe Eliza-9967-SMS-roundtrip ci" || true
adb shell settings put secure location_mode 3 || true

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

# PACKAGE_USAGE_STATS is special access and does not survive the preceding
# reinstall, so this second run proves a positive usage read under an explicit
# grant rather than accepting the instrumentation suite's assume-skip.
MS_APK="$REPO_ROOT/plugins/plugin-native-mobile-signals/android/build/outputs/apk/androidTest/debug/elizaos-capacitor-mobile-signals-debug-androidTest.apk"
adb install -r -t "$MS_APK"
adb shell appops set ai.eliza.plugins.mobilesignals.test android:get_usage_stats allow
MS_OUT="$(adb shell am instrument -w -r \
  -e class ai.eliza.plugins.mobilesignals.UsageStatsReaderInstrumentedTest \
  ai.eliza.plugins.mobilesignals.test/androidx.test.runner.AndroidJUnitRunner 2>&1)"
printf '%s\n' "$MS_OUT"
if printf '%s\n' "$MS_OUT" | grep -qE 'FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_RESULT: shortMsg'; then
  echo "mobile-signals UsageStats assertions failed under granted PACKAGE_USAGE_STATS" >&2
  exit 1
fi
if ! printf '%s\n' "$MS_OUT" | grep -qE 'OK \([0-9]+ test'; then
  echo "mobile-signals UsageStats run did not complete cleanly" >&2
  exit 1
fi

# The Gradle gate removes its test APKs. Reinstalling the app lets the adb lane
# reapply the assistant role and IME, then prove the runtime surfaces rather
# than relying only on registration-time instrumentation.
APP_APK="$REPO_ROOT/packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk"
if [[ ! -f "$APP_APK" ]]; then
  echo "app-debug.apk not found at $APP_APK — build:android should have produced it" >&2
  exit 1
fi
adb install -r -t "$APP_APK"

ASSISTANT_ARTIFACT_DIR="$REPO_ROOT/packages/app/test-results/android-assistant-verify"
mkdir -p "$ASSISTANT_ARTIFACT_DIR"
VERIFY_STATUS=0
# Hosted emulator images have no on-device ASR engine. The verifier must still
# hard-gate role, IME, and deep-link behavior while asserting designed
# ENGINE_OFF state instead of requiring a fabricated transcript.
node "$REPO_ROOT/packages/app/scripts/android-assistant-verify.mjs" \
  --require-device --json \
  | tee "$ASSISTANT_ARTIFACT_DIR/verdict.json" || VERIFY_STATUS=$?

# These snapshots are diagnostic companions to the authoritative verifier
# status; device services can omit individual dumps without hiding its verdict.
adb shell settings get secure voice_interaction_service \
  >"$ASSISTANT_ARTIFACT_DIR/voice_interaction_service.txt" || true
adb shell settings get secure default_input_method \
  >"$ASSISTANT_ARTIFACT_DIR/default_input_method.txt" || true
adb shell ime list -s \
  >"$ASSISTANT_ARTIFACT_DIR/enabled_imes.txt" || true
adb shell cmd role holders android.app.role.ASSISTANT \
  >"$ASSISTANT_ARTIFACT_DIR/assistant_role_holders.txt" || true
adb shell dumpsys activity activities \
  >"$ASSISTANT_ARTIFACT_DIR/dumpsys-activity.txt" || true
adb logcat -d -v brief \
  >"$ASSISTANT_ARTIFACT_DIR/logcat.txt" || true
exit "$VERIFY_STATUS"
