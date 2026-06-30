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

## Visual evidence + emulator coverage

The same instrumented tests also pass on an **Android 14 / API 34 emulator**
(`emulator-am-instrument.txt` — `OK (3 tests)`), giving the "emulator + device"
coverage the issue's AC asks for.

A test-only `ReaderShowcaseActivity` (in `src/androidTest`, `setShowWhenLocked`)
renders the **live** `SystemDeviceReader` output on-screen so the device reads can
be captured visually:

- `system-reader-showcase-emulator.png` — screenshot of the rendered live reads:
  all four roles `available=true` from the live `RoleManager`, `brightness=0.40
  mode=manual`, and the real `AudioManager` volumes (`music 5/15`, `ring 5/7`, …).
- `system-reader-showcase-emulator.mp4` — screen recording (relaunch = a fresh
  on-device read, then scroll through the data).

(The attached physical Pixel 6a is secure-locked, so the rendered-view capture
was done on the emulator; the instrumented tests were verified on **both** the
Pixel and the emulator.)

## Second plugin: `@elizaos/capacitor-wifi`

The same pattern applied to the launcher Wi-Fi view: `WiFiStateReader` (extracted
from `WiFiPlugin.getWifiState`) is driven on-device and asserts the **live radio
state** — `enabled` cross-checked against an independent `WifiManager.isWifiEnabled`
read, and RSSI present-iff-connected with a plausible dBm value.

```bash
./gradlew :elizaos-capacitor-wifi:connectedDebugAndroidTest
```

| file | what |
|---|---|
| `wifi-TEST-results-Pixel6a-Android16.xml` | JUnit XML — `tests="1" failures="0" errors="0"` |
| `wifi-logcat-androidtest.txt` | on-device `TestRunner`: `run finished: 1 tests, 0 failed, 0 ignored` |

## Scope

These are **six** columns of the #9967 work-order (System + Wi-Fi + Phone +
Camera + Contacts + Messages). Contacts is a full **write→read round-trip** —
insert a contact through the real ContactsProvider, read it back via the reader,
assert the written name + phone, then clean up — the issue's "contact
written/read" side-effect. Messages is an **emulator-orchestrated** SMS read:
a marker SMS is injected (`adb emu sms send`) then read back via the reader
(`Assume`-skips when absent, so it never reads a real device's private inbox). They establish the reusable pattern — extract a `Context`-backed
reader, add `src/androidTest` + the instrumentation runner, run
`connectedDebugAndroidTest` — that the remaining native plugins
(messages/location/mobile-signals) can follow to reach the "every native plugin
has ≥1 androidTest" acceptance criterion.
App-surface screenshots/recordings of the rendered views require the device to be
unlocked (this device is secure-locked; instrumented system-state tests run
regardless of keyguard, which is why they are the verifiable layer here).
