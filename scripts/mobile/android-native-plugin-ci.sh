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
CAPTURE_STATUS=0
ASSISTANT_RECORDING_REMOTE=/sdcard/eliza-assistant-verification.mp4
ASSISTANT_RECORDING_LOCAL="$ASSISTANT_ARTIFACT_DIR/assistant-verification.mp4"
ASSISTANT_RECORDING_LOG="$ASSISTANT_ARTIFACT_DIR/screenrecord.log"
ASSISTANT_FRAME_DIR="$ASSISTANT_ARTIFACT_DIR/screenrecord-frames"
ASSISTANT_FRAME_STOP="$ASSISTANT_ARTIFACT_DIR/.stop-screenrecord-frames"

rm -f "$ASSISTANT_RECORDING_LOCAL" "$ASSISTANT_RECORDING_LOG" "$ASSISTANT_FRAME_STOP"
rm -rf "$ASSISTANT_FRAME_DIR"
mkdir -p "$ASSISTANT_FRAME_DIR"

capture_assistant_frames() {
  local frame_index=0
  local frame_path
  while [[ ! -e "$ASSISTANT_FRAME_STOP" ]]; do
    frame_path="$(printf '%s/frame-%06d.png' "$ASSISTANT_FRAME_DIR" "$frame_index")"
    if adb exec-out screencap -p >"$frame_path" && [[ -s "$frame_path" ]]; then
      frame_index=$((frame_index + 1))
    else
      rm -f "$frame_path"
    fi
    sleep 0.5
  done
}

# Instrumentation can leave the headless display asleep. Android screenrecord
# exits after writing only an MP4 header when it starts against that display,
# so wake and foreground the real activity before asking the encoder for proof.
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
adb shell am start -W -n ai.elizaos.app/.MainActivity
sleep 2

# `screenrecord` is the preferred native encoder, while this concurrent stream
# of real device pixels is its evidence-preserving fallback. API-34 headless
# images can lose their ColorBuffer after instrumentation and leave a 3 KiB
# unfinalized MP4 even though `screencap` continues to return the rendered UI.
capture_assistant_frames >>"$ASSISTANT_RECORDING_LOG" 2>&1 &
ASSISTANT_FRAME_CAPTURE_PID=$!
adb shell rm -f "$ASSISTANT_RECORDING_REMOTE"
adb shell screenrecord --bit-rate 4000000 --time-limit 90 \
  "$ASSISTANT_RECORDING_REMOTE" >>"$ASSISTANT_RECORDING_LOG" 2>&1 &
ASSISTANT_RECORDING_PID=$!
sleep 1
ASSISTANT_SCREENRECORD_PIDS="$(adb shell pidof screenrecord 2>/dev/null | tr -d '\r' || true)"
if [[ ! "$ASSISTANT_SCREENRECORD_PIDS" =~ ^[0-9]+([[:space:]]+[0-9]+)*$ ]]; then
  echo "assistant verification screenrecord did not start" >&2
fi
# Hosted emulator images have no on-device ASR engine. The verifier must still
# hard-gate role, IME, and deep-link behavior while asserting designed
# ENGINE_OFF state instead of requiring a fabricated transcript.
node "$REPO_ROOT/packages/app/scripts/android-assistant-verify.mjs" \
  --require-device --json \
  | tee "$ASSISTANT_ARTIFACT_DIR/verdict.json" || VERIFY_STATUS=$?
if ! node -e '
  const fs = require("node:fs");
  const verdict = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (verdict.status !== "pass") process.exit(1);
' "$ASSISTANT_ARTIFACT_DIR/verdict.json"; then
  echo "assistant verifier did not write a valid passing JSON receipt" >&2
  VERIFY_STATUS=1
fi

touch "$ASSISTANT_FRAME_STOP"
if ! wait "$ASSISTANT_FRAME_CAPTURE_PID"; then
  echo "assistant verification frame capture exited unsuccessfully" >&2
fi

# A second SIGINT can interrupt screenrecord while it writes the MP4 index.
# Signal each captured encoder PID once, then only observe it until exit.
for SCREENRECORD_PID in $ASSISTANT_SCREENRECORD_PIDS; do
  if ! adb shell kill -2 "$SCREENRECORD_PID" >/dev/null 2>&1; then
    echo "assistant verification screenrecord PID $SCREENRECORD_PID rejected SIGINT" >&2
  fi
done
RECORDER_EXITED=0
for _ in {1..30}; do
  if ! adb shell pidof screenrecord >/dev/null; then
    RECORDER_EXITED=1
    break
  fi
  sleep 0.5
done
if [[ "$RECORDER_EXITED" -ne 1 ]]; then
  echo "assistant verification screenrecord did not exit cleanly" >&2
  kill "$ASSISTANT_RECORDING_PID" >/dev/null 2>&1 || true
fi
wait "$ASSISTANT_RECORDING_PID" || true

DEVICE_RECORDING_VALID=0
STABLE_SIZE=-1
RECORDING_STABLE=0
for _ in {1..20}; do
  CURRENT_SIZE="$(adb shell stat -c %s "$ASSISTANT_RECORDING_REMOTE" 2>/dev/null | tr -d '\r' || true)"
  if [[ "$CURRENT_SIZE" =~ ^[1-9][0-9]*$ ]]; then
    if [[ "$CURRENT_SIZE" -eq "$STABLE_SIZE" ]]; then
      RECORDING_STABLE=1
      break
    fi
    STABLE_SIZE="$CURRENT_SIZE"
  else
    STABLE_SIZE=-1
  fi
  sleep 0.5
done
if [[ "$RECORDING_STABLE" -ne 1 ]]; then
  echo "assistant verification screenrecord never reached a stable size" >&2
elif ! adb pull "$ASSISTANT_RECORDING_REMOTE" "$ASSISTANT_RECORDING_LOCAL" >/dev/null \
  || [[ ! -s "$ASSISTANT_RECORDING_LOCAL" ]]; then
  echo "assistant verification screenrecord is missing or empty" >&2
elif ! node --input-type=module -e '
  import { assertPlayableMp4 } from "./packages/app/scripts/lib/android-capture.mjs";
  assertPlayableMp4(process.argv[1]);
' "$ASSISTANT_RECORDING_LOCAL"; then
  echo "assistant verification screenrecord is not a complete MP4" >&2
else
  DEVICE_RECORDING_VALID=1
fi
adb shell rm -f "$ASSISTANT_RECORDING_REMOTE" || true

if [[ "$DEVICE_RECORDING_VALID" -ne 1 ]]; then
  FRAME_COUNT="$(find "$ASSISTANT_FRAME_DIR" -maxdepth 1 -type f -name 'frame-*.png' | wc -l | tr -d ' ')"
  if [[ ! "$FRAME_COUNT" =~ ^[0-9]+$ ]] || [[ "$FRAME_COUNT" -lt 4 ]]; then
    echo "assistant verification frame fallback captured fewer than four frames" >&2
    CAPTURE_STATUS=1
  elif ! FFMPEG_BIN="$(
    node --input-type=module -e '
      import { resolveRequiredFfmpeg } from "./packages/app/scripts/lib/ffmpeg.mjs";
      const bin = resolveRequiredFfmpeg({ log: (message) => console.error(message) });
      process.stdout.write("ELIZA_FFMPEG_BIN=" + bin + "\n");
    ' | sed -n 's/^ELIZA_FFMPEG_BIN=//p'
  )" || [[ -z "$FFMPEG_BIN" ]]; then
    echo "assistant verification frame fallback could not resolve ffmpeg" >&2
    CAPTURE_STATUS=1
  elif ! "$FFMPEG_BIN" -y -loglevel warning -framerate 2 \
    -i "$ASSISTANT_FRAME_DIR/frame-%06d.png" \
    -vf 'pad=ceil(iw/2)*2:ceil(ih/2)*2' \
    -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
    "$ASSISTANT_RECORDING_LOCAL" >>"$ASSISTANT_RECORDING_LOG" 2>&1; then
    echo "assistant verification frame fallback could not encode MP4" >&2
    CAPTURE_STATUS=1
  elif ! node --input-type=module -e '
    import { assertPlayableMp4 } from "./packages/app/scripts/lib/android-capture.mjs";
    assertPlayableMp4(process.argv[1]);
  ' "$ASSISTANT_RECORDING_LOCAL"; then
    echo "assistant verification frame fallback is not a complete MP4" >&2
    CAPTURE_STATUS=1
  else
    echo "assistant verification used $FRAME_COUNT real-pixel fallback frames" \
      | tee -a "$ASSISTANT_RECORDING_LOG"
    rm -rf "$ASSISTANT_FRAME_DIR"
  fi
else
  rm -rf "$ASSISTANT_FRAME_DIR"
fi
rm -f "$ASSISTANT_FRAME_STOP"

if ! adb exec-out screencap -p >"$ASSISTANT_ARTIFACT_DIR/assistant-final.png" \
  || [[ ! -s "$ASSISTANT_ARTIFACT_DIR/assistant-final.png" ]]; then
  echo "assistant verification screenshot is missing or empty" >&2
  rm -f "$ASSISTANT_ARTIFACT_DIR/assistant-final.png"
  CAPTURE_STATUS=1
fi

# These snapshots are diagnostic companions to the authoritative verifier
# status; device services can omit individual dumps without hiding its verdict.
adb shell settings get secure voice_interaction_service \
  >"$ASSISTANT_ARTIFACT_DIR/voice_interaction_service.txt" || true
adb shell settings get secure default_input_method \
  >"$ASSISTANT_ARTIFACT_DIR/default_input_method.txt" || true
adb shell ime list -s \
  >"$ASSISTANT_ARTIFACT_DIR/enabled_imes.txt" || true
adb shell cmd role get-role-holders --user 0 android.app.role.ASSISTANT \
  >"$ASSISTANT_ARTIFACT_DIR/assistant_role_holders.txt" || true
adb shell dumpsys package ai.elizaos.app \
  >"$ASSISTANT_ARTIFACT_DIR/dumpsys-package.txt" || true
{
  for component in \
    ai.elizaos.app/.ElizaVoiceInteractionService \
    ai.elizaos.app/.ElizaVoiceInteractionSessionService \
    ai.elizaos.app/.ElizaRecognitionService \
    ai.elizaos.app/.ElizaVoiceInputMethodService; do
    printf '%s\n' "## $component"
    adb shell cmd package query-services --brief --components --user 0 \
      -n "$component"
  done
  printf '%s\n' "## ai.elizaos.app/.ElizaAssistActivity"
  adb shell cmd package resolve-activity --brief --user 0 \
    -n ai.elizaos.app/.ElizaAssistActivity
} >"$ASSISTANT_ARTIFACT_DIR/package-manager-components.txt" || true
adb shell dumpsys activity activities \
  >"$ASSISTANT_ARTIFACT_DIR/dumpsys-activity.txt" || true
adb shell dumpsys voiceinteraction \
  >"$ASSISTANT_ARTIFACT_DIR/dumpsys-voiceinteraction.txt" || true
adb logcat -d -v brief \
  >"$ASSISTANT_ARTIFACT_DIR/logcat.txt" || true
if [[ "$VERIFY_STATUS" -ne 0 ]]; then
  exit "$VERIFY_STATUS"
fi
exit "$CAPTURE_STATUS"
