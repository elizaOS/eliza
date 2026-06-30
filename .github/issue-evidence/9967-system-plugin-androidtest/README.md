# #9967 — first on-device `androidTest` for an elizaOS native plugin

Issue #9967 root cause: the native-plugin Kotlin "runs on no test, on no device"
— the only coverage was desktop-Chromium Playwright specs against a **mocked**
`Capacitor.Plugins` bridge. This slice closes that for `@elizaos/capacitor-system`:
it adds the **first instrumented (`androidTest`) test for any elizaOS native
plugin**, exercising the real Android system reads (`RoleManager`, `AudioManager`,
`Settings`) on a **physical device**, not a mock.

## What it proves

`SystemDeviceReader` (extracted from `SystemPlugin` so the device reads are
testable without a Capacitor `Bridge`/WebView) is driven on-device and asserts
**real native side-effects (state reads)**:

- `readStatus()` — real `packageName`, and the home/dialer/sms/assistant role
  array from the live `RoleManager` (not the 0-length array the web stub returns),
  with `held` consistent with the live holders list.
- `readDeviceSettings()` — real brightness ∈ [0,1], a known brightness mode, and
  **every** audio stream with `AudioManager` bounds (`max > 0`, `current ∈ [0,max]`),
  cross-checked against an independent `AudioManager` read.
- `canWriteSettings()` — the live `Settings.System.canWrite` probe runs on-device.

`SystemPlugin` now delegates to this reader; its JS wire shape is unchanged
(`web.test.ts` still green), so this is behavior-preserving for the launcher's
System/Settings view.

## How to run

```bash
# from packages/app-core/platforms/android, with a device/emulator attached
./gradlew :elizaos-capacitor-system:connectedDebugAndroidTest
```

## Device

Pixel 6a (`bluejay`), **Android 16 / API 36**, serial `27051JEGR10034` — see
`device-info.txt`.

## Artifacts

| file | what |
|---|---|
| `device-info.txt` | device model / Android release / API / build fingerprint |
| `gradle-connectedAndroidTest.log` | `Starting 3 tests on Pixel 6a - 16` → `BUILD SUCCESSFUL` |
| `logcat-androidtest.txt` | on-device `TestRunner` trace: `run started: 3 tests` … `run finished: 3 tests, 0 failed, 0 ignored` |
| `TEST-results-Pixel6a-Android16.xml` | JUnit XML — `tests="3" failures="0" errors="0" skipped="0"` |
| `ai.eliza.plugins.system.SystemDeviceReaderInstrumentedTest.html` | Gradle HTML report |

## Scope

This is one column of the #9967 work-order (the System plugin). It establishes
the reusable pattern — extract a `Context`-backed reader, add `src/androidTest` +
the instrumentation runner, run `connectedDebugAndroidTest` — that the other
native plugins (phone/messages/contacts/location/camera/wifi/mobile-signals) can
follow to reach the "every native plugin has ≥1 androidTest" acceptance criterion.
App-surface screenshots/recordings of the rendered System view require the device
to be unlocked (this device is secure-locked; instrumented system-state tests run
regardless of keyguard, which is why they are the verifiable layer here).
