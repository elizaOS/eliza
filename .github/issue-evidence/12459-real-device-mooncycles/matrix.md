# Real-device lifecycle matrix — MoonCycles (#12459 / #12185)

iPhone 16 Pro Max · iOS 18.7.8 · UDID `00008140-0006491E2E90801C` · **USB-cabled**
(`transportType: wired`, CoreDevice tunnel connected).

## Outcome of record — EXECUTED

The prior run of record was blocked at first-install over a wireless tunnel. The
device is now USB-cabled, and the full lifecycle matrix was **executed against a
running Eliza app on the real device**.

- **Signing / device build: SUCCEEDED.** The staged app
  (`packages/app/ios/build/device-deploy-stage/App.app`, `Identifier=ai.elizaos.app`,
  `TeamIdentifier=25877RY2EH`, signed `Apple Development: Shaw Walters (UT5K5Q5EVF)`,
  `codesign --verify --deep --strict` OK) was reused via `ios:device:deploy --skip-build
  --skip-appexes`. See `deploy-build.log` / `signed-app-verification.txt`.

- **Install on MoonCycles: SUCCEEDED — via the usbmux `installation_proxy` path,
  NOT devicectl.** The USB cable fixed the transport (`transportType: wired`) but did
  **not** restore the CoreDevice install capability: over the wired tunnel the device's
  capability list still LACKS `com.apple.coredevice.feature.installapp` (it advertises
  `launchapplication`, `processcontrol`, `uninstallapp`, `sendmemorywarningtoprocess`,
  `remote.hid.button`, `remote.devicecontrol.orientation`, `getlockstate`, `installroot`,
  … but not `installapp`). `xcrun devicectl device install app` therefore fails
  deterministically with `CoreDeviceError 1001 (0x3E9)` / *"The capability 'Install
  Application' is not supported by this device."* — **even wired** (see
  `install-run-usb.log`). The matrix's earlier "wireless-only" diagnosis was incomplete:
  the missing capability is a CoreDevice/Xcode-side limitation, not a transport one.
  The classic **usbmux `com.apple.mobile.installation_proxy` path via `ideviceinstaller`
  1.2.0** — which bypasses CoreDevice entirely — installed the signed app cleanly:
  `Install: … InstallComplete (100%) / Install: Complete`, confirmed
  `ideviceinstaller list → ai.elizaos.app, "1.0", "Eliza"`.

- **Committed XCUITest harness (`AppUITests/DeviceLifecycleUITests`): NOT runnable in
  this headless environment.** `ios:device:capture` runs `xcodebuild build-for-testing
  -scheme AppUITests -allowProvisioningUpdates`, which must **sign the test runner** and
  all app targets. It failed at signing (`harness-capture.log`): `error: No Accounts: Add
  a new account in Accounts settings` (no Xcode Apple ID session to mint the
  `ai.elizaos.app.xctrunner` profile) plus App-Group entitlement errors on the
  `ElizaKeyboard` / `ElizaWidgets` appexes (a `build-for-testing` cannot strip appexes the
  way the deploy lane's `--skip-appexes` does). The deploy lane sidesteps this by building
  UNSIGNED then grafting a pre-existing profile + stripping appexes; the test-runner build
  has no equivalent path headless. So `XCUIDevice.press(.home)` / `XCUIScreen.screenshot()`
  were unavailable, and the matrix was driven directly instead (below).

- **Lifecycle events: EXECUTED via devicectl process/orientation control + usbmux
  screenshots.** Every event that a confirmed-present device capability can deliver was
  run against the installed, running app: `devicectl device process
  launch/terminate/suspend/resume/sendMemoryWarning` and `devicectl device orientation set`,
  with real-device screenshots via `pymobiledevice3 developer dvt screenshot --userspace`
  (iOS 18 moved the screenshotr service behind the RSD tunnel, so libimobiledevice's
  `idevicescreenshot` is unavailable; the pymobiledevice3 userspace tunnel reaches it with
  no root) and a passive `idevicesyslog` capture (curated to
  `lifecycle-capture/device-console-timeline.log`). Process identity was tracked across
  every event to distinguish **survive** (same PID) from **recover** (fresh PID).

## Per-event matrix — executed results

Baseline process PID = **1151**. Renderer state was read from the real-device screenshot;
"live renderer" = past boot splash, interactive UI present (composer + buttons). RunningBoard
jetsam band in the syslog: **100 = foreground, 40 = background, 0 = suspended**.

| Event | How driven | Executed result | Evidence |
|---|---|---|---|
| Device build + code-sign | xcodebuild + codesign graft (`--skip-appexes`) | **PASS** | `deploy-build.log`, `signed-app-verification.txt` |
| Install (first, device-signed) | **usbmux `installation_proxy` (`ideviceinstaller`)** — devicectl `installapp` ABSENT even wired | **PASS** | `install-run-usb.log` |
| Launch → live renderer | `devicectl process launch` + pmd3 screenshot | **PASS** — PID 1151, interactive renderer (onboarding composer + "Connect Eliza Cloud") | `lifecycle-capture/00-launch-live-renderer.png` |
| App-switch to Settings → return | `devicectl process launch com.apple.Preferences` → relaunch app | **PASS** — Settings foreground; Eliza returned foreground, renderer live; **PID 1151 survived**; syslog jetsam 0→100 @15:00:50 | `01-appswitch-settings-foreground.png`, `01-appswitch-eliza-refocused.png` |
| Switch to REAL Camera → return | `devicectl process launch com.apple.camera` → relaunch app | **PASS** — live camera capture UI foreground; Eliza returned, renderer live; **PID 1151 survived** | `02-camera-foreground.png`, `02-camera-eliza-refocused.png` |
| Orientation landscape ↔ portrait | `devicectl device orientation set landscapeLeft \| portrait` | **PASS** — device rotated (screenshot is 2868×1320 landscape); **renderer reflowed to landscape** then back to portrait; **PID 1151 survived** | `03-orientation-landscape.png`, `03-orientation-portrait.png` |
| Background → foreground (suspend/resume) | `devicectl process suspend` → `resume` → foreground | **PASS** — renderer live after resume; **PID 1151 survived**. Same enter-background/foreground callbacks as the app-switch + camera rows above | `04-suspend-resume-refocused.png` |
| Memory-pressure warning | `devicectl process sendMemoryWarning --pid 1151` | **PASS** — app **not jettisoned**; **PID 1151 survived**; renderer live | `05-memory-warning.png` |
| Process death: terminate → relaunch → recover | `devicectl process terminate --pid 1151` → `process launch` | **PASS** — PID 1151 `terminate_with_reason() success` @15:06:44; **fresh PID 1173** launched `ForegroundFocal`, WebKit render extensions respawned, renderer **recovered** to live interactive UI; onboarding state **persisted** across the kill (in-process full-Bun engine recovery) | `06-process-death-terminated.png`, `06-process-death-relaunched.png`, `device-console-timeline.log` |
| Home-button HID press (literal) | — | **N-A (input method only)** — `devicectl` CLI exposes no HID-button verb (the `remote.hid.button` capability is present but has no CLI surface); the literal press needs XCUITest, which is build-blocked here. The **transition it tests (resign-active → enter-background → re-activate) IS executed** by the app-switch, camera, and suspend/resume rows | — |
| Device lock / sleep | — | **N-A (hardware truth)** — no public lock/sleep control (`getlockstate` is read-only). Same resign-active path covered by app-switch/camera | — |
| Hardware mute (ringer switch) | — | **N-A (hardware truth)** — no API drives the physical ringer switch | — |
| Low battery / Low Power Mode | — | **N-A (hardware truth)** — a physical battery level / LPM toggle cannot be scripted | — |
| Battery drain to 0 / power loss | — | **N-A (hardware truth + forbidden)** — cannot discharge a real battery from software; no force actions on owner hardware | — |
| Reboot autostart | — | **N-A (hardware truth + forbidden)** — iOS has no third-party BOOT_COMPLETED autostart; device reboot forbidden on owner hardware. terminate→relaunch is the recovery proof | — |

## Honest delta vs the sim/emulator run

- **First-install is proven on real A18 Pro hardware** — but via the usbmux
  `installation_proxy`, not CoreDevice/devicectl (whose `installapp` capability is absent
  on this device even USB-cabled). The simulator installs trivially with `simctl`; this
  device needed the legacy usbmux installer.
- **The events the sim lane must mark N/A are executed here for real** — real app-switch,
  real Camera app, real device orientation (with a genuine landscape reflow of the
  renderer), real memory-pressure warning, and true process death → fresh-process recovery —
  driven by the device's confirmed-present CoreDevice capabilities.
- **The one thing missing vs the committed XCUITest harness** is the in-process
  `XCUIScreen`/`XCUIDevice` driver, which cannot build headless (no Xcode account to sign
  the test runner). The direct `devicectl` drive reaches the same OS lifecycle transitions
  and, for the process-level events (terminate, memory warning, suspend/resume), is the more
  authoritative driver because it manipulates the process directly.
