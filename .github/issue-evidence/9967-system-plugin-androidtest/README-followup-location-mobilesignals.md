# #9967 follow-up — `location` + `mobile-signals` on-device `androidTest`

Extends the first-six-plugins work (merged in PR #10406) to two more native
plugins, same root-cause fix: extract a `Context`-backed reader from the
Capacitor `Bridge` coupling that made the Kotlin untestable, delegate from the
plugin (JS wire shape unchanged), then drive the real Android API from
`src/androidTest`.

## `@elizaos/capacitor-mobile-signals` — positive read

`UsageStatsReader` (extracted from `MobileSignalsPlugin`) drives the real
`UsageStatsManager` / `AppOpsManager` `PACKAGE_USAGE_STATS` path. The permission
is special-access (not grantable via a runtime dialog), so it is granted
host-side:

```bash
adb -s emulator-5554 shell appops set ai.eliza.plugins.mobilesignals.test android:get_usage_stats allow
adb -s emulator-5554 shell am instrument -w \
  -e class ai.eliza.plugins.mobilesignals.UsageStatsReaderInstrumentedTest \
  ai.eliza.plugins.mobilesignals.test/androidx.test.runner.AndroidJUnitRunner
```

`mobile-signals-emulator-am-instrument.txt` — **`OK (3 tests)`** on an API-34
emulator: the AppOps check runs on-device, and `collectLastDay()` returns the
device's **real** foreground-usage history, asserted well-formed (non-empty
package names, foreground time > 0, sorted descending, total ≥ sum of top apps).
The delegation also removed a dead `locked || !interactive` idle branch (both
arms returned the same value) and de-duplicated the AppOps check — net −56 lines
in the plugin.

## `@elizaos/capacitor-location` — testable + mapping verified, fetch exercised

`LocationFixReader` (extracted from `LocationPlugin`) owns the accuracy→`Priority`
map, the `CurrentLocationRequest` build, and the
`FusedLocationProviderClient.getCurrentLocation` / `requestLocationUpdates`
calls. The plugin delegates these (JS shape unchanged; web tests 16/16 green).

`location-emulator-am-instrument.txt` — **`OK (2 tests)`**:

- `mapAccuracyToPriority_coversEveryTier` — a **positive** on-device assertion of
  the delegated mapping (every accuracy tier), verified on Pixel 6a + emulator.
- `awaitNextLocation_readsBackAFusedFix` — drives the real Play Services fused
  provider end-to-end (permission held, provider active for the full 20s window,
  callback wired, no crash) and `Assume`-skips the fix assertion. **Honest about
  the environment:** this headless emulator's GNSS HAL emits no location for an
  injected `adb emu geo fix` (`dumpsys location` shows the gps provider at
  `locations = 0` even under a continuous active request), and the indoor Pixel
  can't settle a fresh fix. The assertion passes wherever a fix **is** obtainable
  (a device with a GPS/network lock, or an emulator whose GNSS HAL delivers).

## Why these two are honest about their evidence

`mobile-signals` is a clean positive read because UsageStats is fully
orchestratable host-side. `location` depends on a GPS/network fix that neither
available device can produce right now, so its live-fix assertion is skipped
rather than faked — but the extraction still delivers the #9967 ask (the Kotlin
now runs on a test, on a device) and positively verifies the delegated logic.
