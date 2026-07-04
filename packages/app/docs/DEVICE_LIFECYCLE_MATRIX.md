# Device-lifecycle robustness matrix (#12185, #12188 mobile lanes)

Repeatable, scripted coverage that the Eliza mobile app — the WebView shell
**and** the local agent behind `127.0.0.1:31337` — survives and recovers from
OS lifecycle events: app switching, screen off/sleep, doze/suspend, low
battery, power loss + power on (reboot / process death), muting, and camera
interruptions.

Everything here drives the **real installed app** (no mocked mounts): Android
via the Playwright Android driver over the WebView CDP socket
(`test/android/android-harness.ts`) + adb; iOS via `xcrun simctl` (WKWebView is
not CDP-drivable, so iOS assertions are process-level + screenshots). Rows a
simulator/emulator genuinely cannot drive are listed as such — they are
real-device or manual rows, not silently skipped.

## Run it

```bash
# Android — non-destructive events + process death (emulator or device attached).
bun run --cwd packages/app test:e2e:android:lifecycle

# Android — reboot + ElizaBootReceiver autostart leg. Run LAST: it reboots the device.
bun run --cwd packages/app test:e2e:android:lifecycle:reboot

# iOS simulator — drivable subset with recording + report.
bun run --cwd packages/app capture:ios-sim:lifecycle
```

Prereqs match the rest of the Android lane (`test/android/README.md`): a
WebView-debuggable APK installed, and for `ELIZA_ANDROID_BACKEND=local`
(default) a working on-device agent (emulators additionally need
root + SELinux-permissive, `ensureEmulatorPermissive`). Artifacts land in
`.github/issue-evidence/12185-device-lifecycle/{android,ios}/`.

## Standard assertions (Android, after every event)

1. **Shell interactive** — React shell rendered past the splash, no first-run
   interception, chat composer visible, `page.evaluate` round-trips.
2. **Agent loopback healthy** — `GET http://127.0.0.1:31337/api/health` → 200,
   fetched **from inside the WebView** (the same path the app uses).
3. **Agent FGS** — `dumpsys activity services` shows the
   `ElizaAgentService` record where the event implies a (re)start.
4. **JS lifecycle signals** — `eliza:app-pause` / `eliza:app-resume` (from
   `src/mobile-lifecycle.ts`) recorded by an in-page probe for events that
   occlude the app.
5. **No `FATAL EXCEPTION` / `ANR in ai.elizaos.app`** in logcat across the
   whole sweep (final test).
6. **State persistence** — `localStorage` marker + Capacitor Preferences
   (`eliza:first-run-complete`, runtime mode) survive process death and reboot.

## Event × platform matrix

| Event | Android driver | Android asserts | Android spec | iOS (simulator) driver | iOS asserts / limits |
|---|---|---|---|---|---|
| App switch: HOME | `input keyevent KEYCODE_HOME`, then `am start` back | pause+resume events, interactive, health | `lifecycle.android.spec.ts` | — (no Home verb; other-app launch below is the backgrounding path) | — |
| App switch: recent apps | `input keyevent KEYCODE_APP_SWITCH`, then `am start` back | interactive recovery, health (pause recorded when overlay occludes) | `lifecycle.android.spec.ts` | not drivable (`simctl` has no app-switcher verb) | documented skip |
| App switch: another app | `am start -n com.android.settings/.Settings`, verify it owns the resumed activity, return | pause+resume, interactive, health | `lifecycle.android.spec.ts` | `simctl launch <udid> com.apple.Preferences`, then relaunch app | same launchd pid across background → reactivate; screenshots |
| Screen off / sleep / wake | `KEYCODE_SLEEP` → `KEYCODE_WAKEUP` → `wm dismiss-keyguard` | pause/resume events, visible after wake, interactive | `sleep-wake.android.spec.ts` (pre-existing #9943 lane) | not drivable headlessly (no `simctl` lock/sleep; Simulator.app **Device > Lock** is manual) | documented skip; real-device row |
| Lock screen | covered by sleep/wake leg (`wm dismiss-keyguard` on wake) | as above | `sleep-wake.android.spec.ts` | same as above | documented skip |
| Doze / suspend | `dumpsys battery unplug` + `KEYCODE_SLEEP` + `dumpsys deviceidle force-idle` (state `IDLE`), 10 s hold, `unforce` + wake | doze entered+exited, interactive, health after exit | `lifecycle.android.spec.ts` | iOS has no doze; closest analog (background suspension) is exercised by the app-switch rows | n/a by platform design |
| Low battery + battery saver | `dumpsys battery unplug` + `set level 5` + `settings put global low_power 1`, then reset | override visible in `dumpsys battery`, interactive, health | `lifecycle.android.spec.ts` | `simctl status_bar override --batteryState discharging --batteryLevel 5` | **cosmetic** (status bar only) — UIDevice battery/Low Power Mode not drivable on sim; real-device row |
| Power loss → power on: process death | `am force-stop` + relaunch (`am start -W`); fresh WebView attach | app pid gone then back, `ElizaAgentService` record restored, health (cold-boot budget), `localStorage` marker + Preferences persisted, interactive | `lifecycle.android.spec.ts` (opt-in `ELIZA_ANDROID_LIFECYCLE_DESTRUCTIVE=1`, set by the npm script) | `simctl terminate` + `simctl launch` | old pid gone, fresh pid, renders (screenshot) |
| Power loss → power on: reboot | `adb reboot` → wait `sys.boot_completed` → re-apply emulator SELinux-permissive → assert FGS **without launching the app** → launch → health | `ElizaBootReceiver` auto-started `ElizaAgentService` from `BOOT_COMPLETED`, agent diagnostics JSONL, health 200, Preferences survived | `lifecycle-reboot.android.spec.ts` (opt-in `ELIZA_ANDROID_LIFECYCLE_REBOOT=1`) | `simctl shutdown`+`boot` restarts the sim, but iOS has no third-party boot-autostart to assert | documented skip; relaunch-after-terminate is the recovery proof |
| Actual battery drain to 0 | not drivable on emulator (`dumpsys battery` cannot power the device off) | — | real-device row: drain, power on, then run the reboot assertions manually | not drivable | real-device row |
| Mute | `cmd media_session volume --stream 3 --set 0` + `KEYCODE_VOLUME_MUTE`, verify `volume is 0`, restore | stream muted at OS level, app interactive, health | `lifecycle.android.spec.ts` | hardware ringer/mute switch has no simulator control | documented skip; real-device row |
| Switch to camera | `am start` the resolved `STILL_IMAGE_CAMERA` handler (`com.android.camera2`), verify foreground, return | pause+resume, interactive, health | `lifecycle.android.spec.ts` | no camera feed on sim (`com.apple.camera` unusable) — Photos (`com.apple.mobileslideshow`) is the interruption analog | pid survives, screenshots; camera-specific behavior is a real-device row |

## Where the pieces live

- **Android specs:** `packages/app/test/android/lifecycle.android.spec.ts`,
  `packages/app/test/android/lifecycle-reboot.android.spec.ts` — same
  harness/config as the rest of the lane (`playwright.android.config.ts`,
  `android-harness.ts`, capture via `scripts/lib/android-capture.mjs`).
- **iOS driver:** `packages/app/scripts/ios-sim-lifecycle.mjs`
  (`simctl` + `scripts/lib/ios-simulator-capture.mjs` recording), writes
  `ios-lifecycle-report.json` with explicit `pass`/`fail`/`skipped` rows.
- **Native surfaces under test:**
  `packages/app-core/platforms/android/.../ElizaAgentService.java` (agent FGS,
  watchdog, detached-process adoption),
  `.../ElizaBootReceiver.java` (BOOT_COMPLETED autostart, gated by
  `shouldAutoStart` — branded device or persisted runtime mode ≠ cloud),
  `packages/app/src/mobile-lifecycle.ts` (pause/resume + network events the
  in-page probe listens for).

## Opt-in gates (why the destructive legs don't run in the full sweep)

`am force-stop` kills the CDP target every later spec in the same Playwright
worker would reuse, and `adb reboot` severs adb for the whole invocation. Both
legs therefore skip loudly unless their env gate is set; the
`test:e2e:android:lifecycle*` npm scripts set the gates and pin the file order
(lifecycle first, reboot last).
