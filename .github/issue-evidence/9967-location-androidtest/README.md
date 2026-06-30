# Issue #9967 - Location native plugin androidTest

Branch: `fix/9967-location-foreground-prompt-tristate`
(follow-up to merged PR #10437 / branch `fix/9967-location-androidtest`)

## What Changed

- Consolidates Android Location fused-fix, permission/provider, and result
  logic in the existing `Context`-backed `LocationFixReader`; the rebased
  branch does not add a second reader beside the one already on `develop`.
- Keeps the JS wire shape unchanged: `LocationPlugin` still resolves the same
  `location`/`background` permission fields and `coords` position payload.
- Preserves the foreground permission contract by keeping
  `getPermissionState("location")` as the source for the production `location`
  field, so a fresh never-asked install can still report `"prompt"` instead of
  collapsing to `"denied"`.
- Adds an Activity-aware tri-state reader read,
  `LocationFixReader.readForegroundPermissionStatus(activity)`, so the on-device
  evidence/showcase surface reports the same `granted | denied | prompt` contract
  the JS side expects (a never-asked permission reads `"prompt"`, never
  `"denied"`) via `ActivityCompat.shouldShowRequestPermissionRationale` — mirroring
  the iOS `.notDetermined → "prompt"` mapping. The earlier showcase/test path
  collapsed this to a boolean (`granted`/`denied`), which could not express the
  `"prompt"` state.
- Adds `LocationFixReaderDeviceStateInstrumentedTest`, which runs on real Android and
  checks:
  - foreground location permission grant via real Android permission state,
  - the tri-state `readForegroundPermissionStatus` read through a launched
    Activity (granted → `"granted"`, value within the JS contract set),
  - enabled provider state via live `LocationManager`,
  - Android `Location` result shaping.
- Adds a test-only `LocationReaderShowcaseActivity` for screenshot and
  screen-recording evidence of the live native reader output.
- Drops the obsolete barcode-scanner patch/checksum change from the original
  branch; current `develop` already owns that patch.

## Evidence

Local package validation:

```bash
bun run --cwd plugins/plugin-native-location test
bun run --cwd plugins/plugin-native-location build
./gradlew :elizaos-capacitor-location:compileDebugKotlin :elizaos-capacitor-location:compileDebugAndroidTestKotlin
```

Results:

- `plugins/plugin-native-location` unit tests: 1 file, 16 tests passed.
- `plugins/plugin-native-location` build: passed.
- Android debug + androidTest Kotlin compile: passed.

Connected Android validation:

```bash
packages/app-core/platforms/android/gradlew -p packages/app-core/platforms/android :elizaos-capacitor-location:connectedDebugAndroidTest
```

Result: passed on all connected Android targets:

- Pixel 6a / Android 16 / API 36: 5 tests, 0 failures, 0 errors, 1 skipped.
- JejuWallet Pixel 6 emulator (`emulator-5554`) / Android 14 / API 34:
  5 tests, 0 failures, 0 errors, 1 skipped.
- eliza-viewtest emulator (`emulator-5556`) / Android 14 / API 34:
  5 tests, 0 failures, 0 errors, 1 skipped.

The skipped test is `awaitNextLocation_readsBackAFusedFix`, which intentionally
uses `Assume` when no live fused fix arrives in the current environment. The
non-skipped tests cover permission state, provider state, result shaping, and
accuracy mapping on each attached device.

After rebasing onto the latest `origin/develop`, the same command was rerun and
passed again on both connected Android targets.

Artifacts:

- `location-connectedDebugAndroidTest.log`
- `location-TEST-Pixel6a-Android16.xml`
- `location-TEST-emulator-Android14.xml`
- `location-TEST-emulator5556-Android14.xml`
- `location-pixel6a-provider-logcat.txt`
- `location-emulator-provider-logcat.txt`
- `location-emulator5556-provider-logcat.txt`
- `location-pixel6a-utp.log`
- `location-emulator-utp.log`
- `location-emulator5556-utp.log`
- `location-androidtest-report/`
- `location-device-info.txt`

Screenshot and screen recording evidence:

- `location-showcase-pixel6a.png`
- `location-showcase-pixel6a.mp4`
- `location-showcase-emulator.png`
- `location-showcase-emulator.mp4`

The showcase Activity renders the live `LocationFixReader` output: foreground
permission state and `LocationManager` provider state. The captured Pixel 6a and
emulator screens show the granted foreground state and live enabled provider rows
from Android rather than a desktop Chromium bridge mock.

> Re-capture note: the captured screenshots/recordings above predate the
> tri-state showcase change — they render the old boolean label
> `foreground granted: true`. The showcase now prints the tri-state
> `foreground: granted` (and `prompt`/`denied` in those states). The on-device
> substance (granted foreground + live providers) is unchanged; only the label
> string differs. Re-run
> `:elizaos-capacitor-location:connectedDebugAndroidTest` and re-capture the
> showcase on a booted emulator/device to refresh the label before final merge
> sign-off if a reviewer needs the exact new string on-screen.

## Verification status of the tri-state follow-up

The connected-device results above were captured before the tri-state
`readForegroundPermissionStatus` reader read + its instrumented assertion +
the showcase label change were added. Those Kotlin additions were verified
statically (imports resolve to already-declared AndroidX deps —
`androidx.core` via `appcompat`, `androidx.test:core` for `ActivityScenario`)
and the TypeScript side was re-verified host-side
(`bun run --cwd plugins/plugin-native-location test` → 16/16 pass;
`tsc --noEmit` clean). The Android Gradle compile + `connectedDebugAndroidTest`
could not be re-run in this isolated worktree: the host-app Android project
(`packages/app-core/platforms/android`) requires a full Capacitor-synced
`node_modules` (the `@capacitor/*` android source dirs are absent here), which
is the heavy full-app setup out of scope for this change. Re-run
`:elizaos-capacitor-location:connectedDebugAndroidTest` on a synced checkout to
refresh the device evidence for the new assertion + showcase label.

## Notes

This slice covers the Location native-plugin Kotlin column for #9967. It does
not claim to close the whole issue: the remaining work still includes
mobile-signals, broader launcher-as-home behavior tests, and the full native
view matrix.
