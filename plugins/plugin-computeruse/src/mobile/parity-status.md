# Cross-platform parity status

Living matrix of computer-use capabilities across the five supported targets.
Linux is the reference implementation. macOS and Windows ports are
code-complete but only some have been runtime-verified in CI. iOS and AOSP
ship a typed Capacitor bridge but neither has been validated end-to-end on
hardware in this repo's CI.

Cell legend:

- `verified` — exercised on real hardware in CI or by a maintainer
- `code-parity` — feature-equivalent code path exists, runtime untested
- `stub` — surface present but no real implementation
- `blocked: <reason>` — OS does not allow the operation in our delivery model

## Capability matrix

| Capability | Linux | macOS | Windows | iOS | Android (AOSP / consumer) |
|---|---|---|---|---|---|
| screenshot / capture / displays | OWNED BY TASK 3 | OWNED BY TASK 3 | OWNED BY TASK 3 | code-parity (ReplayKit foreground; broadcast extension flaky on iOS 26 beta) | code-parity (MediaProjection, requires user consent) |
| computerUse — mouse / keyboard | verified (`xdotool`) | code-parity (`cliclick` + AppleScript / Swift CGEvent fallbacks) | code-parity (PowerShell `user32.dll` P/Invoke) | blocked: stock iOS forbids cross-app input | code-parity (AccessibilityService gesture dispatch) |
| windowList | verified (`wmctrl` / `xdotool`) | code-parity (AppleScript System Events) | code-parity (PowerShell `Get-Process` + ProcessName) | blocked: no cross-app process enumeration | code-parity (UsageStatsManager via `enumerateApps`) |
| windowFocus / move / minimize / maximize / close | verified (`wmctrl` / `xdotool`) | code-parity (AppleScript via `runDarwinWindowScript`) | code-parity (PowerShell `SetForegroundWindow` / `SetWindowPos` / `ShowWindow`) | blocked: own-app only | blocked: own-app only |
| browser (Puppeteer-core driving Chromium) | verified (Chrome / Edge / Brave / Chromium) | code-parity (Chrome / Edge / Brave / Brave Beta / Brave Nightly / Arc / Chromium / Vivaldi / Opera) | code-parity (Chrome / Edge / Brave / Brave Beta / Arc / Vivaldi) | blocked: no Chromium on iOS | code-parity (Chrome via Termux) |
| terminal | verified (`/bin/bash` via `execFile`) | code-parity (`/bin/bash` via `execFile`) | code-parity (`powershell.exe -NoProfile -Command` + Win-specific blocklist) | blocked: no shell on iOS | code-parity (Termux shell) |
| fileSystem (read / write / delete) | verified (`node:fs` + cross-platform `validateFilePath`) | verified (same) | verified (same; UNC + reserved-name guard) | blocked: app-sandbox only | blocked: scoped storage only |
| clipboard | OWNED BY TASK 7 | OWNED BY TASK 7 | OWNED BY TASK 7 | OWNED BY TASK 7 | OWNED BY TASK 7 |
| accessibility tree (a11y) | OWNED BY TASK 7 | OWNED BY TASK 7 | OWNED BY TASK 7 | code-parity (`accessibilitySnapshot` returns own-app tree only) | code-parity (AccessibilityService `getRootInActiveWindow`) |
| permissions probe — accessibility | n/a | code-parity (TCC database read) | n/a (no per-app gate) | n/a | code-parity (AccessibilityService running flag) |
| permissions probe — screen recording | n/a | code-parity (TCC database read) | code-parity (`CapabilityAccessManager\\graphicsCaptureProgrammatic`) | code-parity (ReplayKit prompt outcome) | code-parity (MediaProjection consent outcome) |
| permissions probe — camera / microphone | n/a | code-parity (TCC database read) | code-parity (`CapabilityAccessManager\\webcam` / `\\microphone`) | code-parity (AVAuthorizationStatus) | code-parity (CAMERA / RECORD_AUDIO runtime grant) |
| OCR | code-parity (Tesseract subprocess) | code-parity (Tesseract; Apple Vision via iOS bridge when running on iPad-as-host) | code-parity (Tesseract subprocess) | code-parity (Apple Vision OCR via `visionOcr`) | stub (no Android-native OCR provider yet — falls back to Tesseract on host) |
| AppIntents (driving other apps via system shortcuts) | blocked: not an iOS-only concept | blocked: not an iOS-only concept | blocked: not an iOS-only concept | code-parity (`appIntentInvoke`, registry covers Mail / Messages / Notes / Reminders / Music / Maps / Safari) | blocked: Android equivalent is Intent dispatch, not exposed here |
| memory pressure signal | verified (host RSS sampling) | code-parity (host RSS sampling) | code-parity (host RSS sampling) | code-parity (`UIApplicationDidReceiveMemoryWarningNotification` + `os_proc_available_memory`) | code-parity (`onTrimMemory` ComponentCallbacks2) |
| process listing | verified (`/proc`) | code-parity (`ps -axco`) | code-parity (`Get-Process | ConvertTo-Json`) | blocked: no cross-app enumeration | code-parity (UsageStatsManager) |

## Notes

- Linux paths are the reference implementation and have CI coverage in
  `plugins/plugin-computeruse/src/__tests__/*.real.test.ts`.
- macOS and Windows code paths are unit-tested with mocks
  (`platform-capabilities.test.ts`, `windows-list.real.test.ts`); the actual
  shell-out has not been driven against a real macOS/Windows host in CI.
- iOS bridge: pair every call site with `featureCheck()` (synchronous) and
  `bridge.probe()` (async, returns the per-capability matrix).
- Android bridge: same pattern. AOSP system-app capabilities
  (`SurfaceControl.captureDisplay`, `injectInputEvent`, `IActivityManager`)
  are documented in `docs/ANDROID_CONSTRAINTS.md` but never compiled into the
  consumer build — the matrix above reflects the consumer surface.

## Stubs that remain

- **OCR — Android**: no Android-native OCR provider; falls back to a
  host-side Tesseract subprocess when one is available. Adding ML Kit Text
  Recognition is tracked separately.
- **Permissions probe — accessibility on Linux/Windows**: no equivalent of
  the macOS TCC database; `probePermission` returns
  `{granted:true, probed:false}` so callers must rely on runtime error
  classification instead.
