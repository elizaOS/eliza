# Android computer-use — constraints, capabilities, and validation checklist

## What works in a consumer APK

| Capability | Permission | Notes |
|---|---|---|
| AccessibilityService — view tree + gesture dispatch | `BIND_ACCESSIBILITY_SERVICE` (user must enable in Settings) | Survives Advanced Protection Mode in most OEM ROMs |
| MediaProjection — screen frame capture | `FOREGROUND_SERVICE_MEDIA_PROJECTION` + user consent dialog | 1 Hz default; foreground service required |
| UsageStatsManager — app history + foreground app | `PACKAGE_USAGE_STATS` (user must enable in Settings > Usage Access, no runtime prompt) | 24-hour window; 5-min scan for foreground app |
| Camera2 — JPEG/RGBA frames | `CAMERA` (runtime permission) | Service-friendly; no Activity or SurfaceView needed |
| onTrimMemory → MemoryArbiter pressure | None (ComponentCallbacks2) | Fires at TRIM_MEMORY_RUNNING_LOW and TRIM_MEMORY_RUNNING_CRITICAL |

## What requires a system-app build (AOSP flavor)

| Capability | Mechanism | Permission |
|---|---|---|
| High-fidelity screen capture | `SurfaceControl.captureDisplay()` | `READ_FRAME_BUFFER` (`signature|privileged`) |
| High-fidelity input injection | `InputManager.injectInputEvent()` | `INJECT_EVENTS` (`signature|privileged`) |
| Full process enumeration | `IActivityManager.getRunningAppProcesses()` via AIDL | `REAL_GET_TASKS` (`signature`) |

See `AOSP_SYSTEM_APP.md` for the privileged build path.

## Advanced Protection Mode caveat

When Advanced Protection Mode (APM) is active on Pixel 9+ and some OEM variants:

- AccessibilityService registered with `featureAccessibility` (not `featureGeneric`) survives.
  `MiladyAccessibilityService` is registered correctly.
- Third-party AccessibilityServices with broad event masks may be killed on APM devices
  even when re-enabled in Settings. If the service is repeatedly stopped, check `adb logcat`
  for `AccessibilityManagerService` or `android.safetycenter` entries.

## lmkd survival strategy

The Linux low-memory killer daemon (lmkd) uses oom_score_adj to prioritize kills.
Two mitigations are active:

1. `ScreenCaptureService` is a foreground service — lmkd ranks foreground services
   below cached apps; they survive until memory is critically exhausted.
2. `onTrimMemory` → `capacitorPressureSource.dispatch()` — WS1 MemoryArbiter receives
   the pressure signal and proactively unloads lower-priority model handles
   (transcribe, vision-describe) before the OOM killer fires.

## Assistant/App Actions → LifeOps routing

Android shortcuts, App Actions, `ACTION_ASSIST`, and AOSP
`ROLE_ASSISTANT` are entry surfaces. They wake or open Eliza and hand the
request to the app/runtime; they do not create a parallel reminder engine.

For LifeOps requests, reminders/check-ins/follow-ups/watchers/recaps and
approvals must become `ScheduledTask` records. Native Android code may post a
notification for an existing task or wake the runtime, but it must not schedule
native-only reminders that bypass the LifeOps runner. See
[`MOBILE_ASSISTANT_ROUTING.md`](MOBILE_ASSISTANT_ROUTING.md) for the shared
Mac/iOS/Android checklist.

## Manual on-device validation checklist

Run this against a physical Android device (API 24+ for gesture dispatch; API 29+ for
`FOREGROUND_SERVICE_MEDIA_PROJECTION`). Cuttlefish x86_64 emulator is acceptable for
smoke-testing, but the x86_64 JNI patch must be present (see WS4 llama-cpp-capacitor patch).

### 1. Permissions setup

- [ ] Install the APK and open the app.
- [ ] Grant `CAMERA` runtime permission when prompted.
- [ ] Navigate to Settings > Accessibility > Milady > enable the service.
  Verify `MiladyAccessibilityService.instance` is non-null via:
  `adb shell dumpsys accessibility | grep -i milady`
- [ ] Navigate to Settings > Digital Wellbeing (or Settings > Security > Usage Access)
  > Milady > enable Usage Access.
- [ ] Long-press the launcher icon and verify the Ask Eliza static shortcut is
  present.
- [ ] If validating App Actions, confirm the assistant routes the action into
  `eliza://chat?source=android-app-action`.

### 2. AccessibilityService — view tree

```
adb shell am start com.example.app   # open any app
curl -X POST http://localhost:1337/api/computer-use/getAccessibilityTree
```
Expected: JSON array with `[{id, role, label, bbox, actions}]` entries.
Verify `role` values are Android class names (e.g. `android.widget.Button`).

### 3. Gesture dispatch

```
curl -X POST http://localhost:1337/api/computer-use/dispatchGesture \
  -d '{"type":"tap","x":540,"y":960}'
```
Expected: `{"ok":true}` and the tap is visible on screen.

```
curl -X POST http://localhost:1337/api/computer-use/dispatchGesture \
  -d '{"type":"swipe","x":540,"y":1600,"x2":540,"y2":400,"durationMs":400}'
```
Expected: `{"ok":true}` and the list scrolls up.

### 4. Global actions

```
curl -X POST http://localhost:1337/api/computer-use/performGlobalAction -d '{"action":"home"}'
curl -X POST http://localhost:1337/api/computer-use/performGlobalAction -d '{"action":"recents"}'
curl -X POST http://localhost:1337/api/computer-use/performGlobalAction -d '{"action":"back"}'
curl -X POST http://localhost:1337/api/computer-use/performGlobalAction -d '{"action":"notifications"}'
```
Expected: each action is visually confirmed on device.

### 5. MediaProjection — screen capture

```
curl -X POST http://localhost:1337/api/computer-use/startMediaProjection -d '{"fps":1}'
```
Expected: system consent dialog appears. Accept it.

```
curl -X GET http://localhost:1337/api/computer-use/captureFrame
```
Expected: `{ok:true, data:{jpegBase64:"...", width:..., height:..., timestampMs:...}}`.
Verify `jpegBase64` decodes to a valid JPEG of the current screen.

```
curl -X POST http://localhost:1337/api/computer-use/stopMediaProjection
```
Expected: `{ok:true, data:{stopped:true}}`.

### 6. UsageStats — app enumeration

```
curl -X GET http://localhost:1337/api/computer-use/enumerateApps
```
Expected: JSON array of `{packageName, label, lastUsedMs, totalForegroundMs, isForeground}`.
Verify `isForeground:true` for the frontmost app.
If you receive `{ok:false, code:"permission_denied"}`, confirm Usage Access is enabled.

### 7. Camera capture

```
curl -X POST http://localhost:1337/api/computer-use/startCamera -d '{"fps":1}'
```
Expected: `{ok:true, data:{cameras:"[...]"}}` with at least one camera entry.

```
curl -X GET http://localhost:1337/api/computer-use/captureFrameCamera
```
Expected: `{ok:true, data:{jpegBase64:"..."}}`.

```
curl -X POST http://localhost:1337/api/computer-use/stopCamera
```

### 8. Memory pressure dispatch

Open a memory-intensive app or use `adb shell am send-trim-memory $(pidof ai.milady.milady) 80`
to simulate TRIM_MEMORY_RUNNING_CRITICAL.

Expected: the JS console (or logcat for bridge events) shows:
`[capacitorPressureSource] dispatching pressure: critical`
followed by MemoryArbiter eviction log entries.

Verify via `GET /api/training/auto/config` that arbiter pressure state transitions to `critical`.

### 9. Assistant/App Actions → LifeOps routing

```
adb shell am start -a android.intent.action.VIEW \
  -d 'eliza://chat?source=android-shortcut'
adb shell am start -a android.intent.action.ASSIST \
  -n com.elizaai.eliza/ai.elizaos.app.ElizaAssistActivity
```

Expected: Eliza opens the app/runtime chat surface. Ask for a one-off reminder,
a recurring check-in, and a follow-up. Verify each creates or updates a LifeOps
`ScheduledTask` record; there must be no Java/Kotlin-only reminder table or
notification-only schedule.
