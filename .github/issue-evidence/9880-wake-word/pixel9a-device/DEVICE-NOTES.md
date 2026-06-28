# Pixel 9a — on-device voice-activation (elizaOS #9880)

Device: Pixel 9a (arm64-v8a, Android 16 / SDK 36), `ai.elizaos.app` (versionName
1.0.0, build 2026-06-25), driven over adb + CDP-over-adb (`@webview_devtools_remote`).

## What the artifacts show

- **`voice-activation.mp4`** — screen recording of the on-device voice surface:
  from the home view, activating "talk" opens the microphone (the in-app mic
  control goes active and the **green Android OS microphone indicator** appears
  top-right, confirming the app is recording at the OS level), then closes. This
  is the exact "open a listening window" effect the wake word triggers.
- **`listening-state.jpg`** — still of the active listening state with the green
  OS mic indicator.

## Scope / honesty

The installed APK (2026-06-25) predates the unified `WakeController`
consolidation: its JS bundle contains the **older** wake-word surface (50
`wakeWord` refs + Swabble integration) but not `useWakeController` /
`selectWakePath` (verified by grepping the loaded bundle over CDP). So this
device tier demonstrates the **on-device voice-activation UI** (the wake word's
effect), not the latest `WakeController` path selection.

The **acoustic** "speak hey eliza → it fires" loop cannot be driven over adb (no
way to inject audio into the Android mic HAL remotely — it needs a person
speaking to the phone, the human-in-the-loop tier the issue already documents).
The real-audio **detection** is instead proven natively in
[`../linux-native/`](../linux-native/), where audio files can be fed directly to
the fused openWakeWord head.
