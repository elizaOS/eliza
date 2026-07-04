# Real-device lifecycle matrix — MoonCycles (#12459 / #12185)

iPhone 16 Pro Max · iOS 18.7.8 · UDID `00008140-0006491E2E90801C` · wireless
(localNetwork) CoreDevice tunnel, no USB cable present.

## Outcome of record

- **Signing / device build: SUCCEEDED.** `run-mobile-build ios-local` (full-Bun
  engine) built, `xcodebuild` reported `** BUILD SUCCEEDED **`, the app was
  grafted with `iOS Team Provisioning Profile: ai.elizaos.app` + signed with
  `Apple Development: Shaw Walters (UT5K5Q5EVF)`, and
  `codesign --verify --deep --strict` passed. Signed app:
  `packages/app/ios/build/device-deploy-stage/App.app`
  (`Identifier=ai.elizaos.app`, `TeamIdentifier=25877RY2EH`). See
  `deploy-build.log`.
- **Install on MoonCycles: BLOCKED — wireless-only transport.** `devicectl
  device install app` fails deterministically with
  `CoreDeviceError 1001 (0x3E9)` / `CapabilityFeatureIdentifier =
  com.apple.coredevice.feature.installapp` / *"The capability 'Install
  Application' is not supported by this device."* MoonCycles is paired over a
  **localNetwork (WiFi) tunnel only** — `system_profiler SPUSBDataType` shows no
  cabled iPhone and `idevice_id -l` (usbmux) is empty. CoreDevice does not offer
  the first-install capability over a wireless tunnel; a USB cable is required
  for the initial install, which this headless environment cannot provide. The
  device's wireless capability list (`device-capabilities-wireless.txt`) confirms
  `Launch/Uninstall Application`, `Process Control`, `Send Memory Warning`,
  `Device Orientation`, `HID Button/Keyboard`, `Get Lock State`, `Reboot` are all
  PRESENT — only `Install Application` is ABSENT.

Because first-install is the prerequisite for every lifecycle event and it is
blocked by the wireless transport, **no lifecycle event was executed against a
running app this session.** No PASS is claimed for any event that was not
actually run. The committed `AppUITests/DeviceLifecycleUITests` harness is ready
to execute the moment the app is installed over a cable.

## Per-event matrix

"Drivable on real hardware?" = would this event run on attached hardware once the
app is installed, and is the backing CoreDevice/XCUITest primitive present on
this device? "This session" = actually executed against a running Eliza app in
this run.

| Event | Drivable on real hardware? | Backing primitive (confirmed present) | This session | Sim lane verdict |
|---|---|---|---|---|
| Device build + code-sign | yes | xcodebuild + codesign (grafted profile) | **PASS** | n/a |
| Install (first, device-signed) | **NO over wireless** | `installapp` capability **ABSENT** over WiFi tunnel; needs USB cable | **BLOCKED** | n/a (simctl install always works) |
| Launch → live renderer | yes | `launchapplication` present; XCUIApplication.launch | blocked (needs install) | PASS |
| Home-button background → foreground | **yes (device-only)** | `remote.hid.button` present; XCUIDevice.press(.home) | blocked (needs install) | **N-A (simctl has no Home verb)** |
| App-switch to another app → return | yes | `launchapplication` + `processcontrol` | blocked (needs install) | PASS (Settings) |
| Switch to REAL Camera app → return | **yes (device-only)** | `launchapplication` (com.apple.camera) | blocked (needs install) | **N-A → Photos analog (no sim camera)** |
| Orientation landscape ↔ portrait | **yes (device-only)** | `remote.devicecontrol.orientation` present; XCUIDevice.orientation | blocked (needs install) | N-A (not in sim lane) |
| Process death: terminate → relaunch | yes | `processcontrol` + `launchapplication`; XCUIApplication.terminate/launch | blocked (needs install) | PASS |
| Memory-pressure warning | **yes (device-only)** | `sendmemorywarningtoprocess` present; devicectl device process sendMemoryWarning | blocked (needs install) | N-A (not in sim lane) |
| Agent in-process recovery | yes | boot-trace JSONL pulled via `transferFiles`/copy from container | blocked (needs install) | skipped (sim shares host :31337) |
| Device lock / sleep | **N-A** | `getlockstate` present but no PUBLIC lock/sleep control: XCUIDevice.Button has no lock; the wireless tunnel exposes only lock-state *read*. Same resign-active/enter-background callbacks are covered by Home-button + app-switch + camera rows. | N-A | N-A (Simulator.app Device>Lock is manual) |
| Hardware mute (ringer switch) | **N-A** | No API drives the physical ringer/mute switch. | N-A | N-A |
| Low battery / Low Power Mode | **N-A** | A physical battery level cannot be scripted; simctl status_bar override is sim-cosmetic and has no device analog. | N-A | N-A (cosmetic status bar) |
| Battery drain to 0 / power loss | **N-A** | Cannot discharge/power off a real battery from software; also forbidden (no force actions on owner hardware). | N-A | N-A |
| Reboot autostart | **N-A** | iOS has no BOOT_COMPLETED third-party autostart; device reboot forbidden on owner hardware. terminate→relaunch is the recovery proof. | N-A | N-A |

## Honest delta vs the sim/emulator run

- **Signing/deploy is proven on real A18 Pro hardware** — the sim lane never
  signs (CODE_SIGNING_ALLOWED=NO). The grafted-profile + nested-signing recipe
  and `--skip-appexes` path work end-to-end for MoonCycles.
- **The events the sim lane cannot drive ARE backed by present device
  capabilities** (Home button, real Camera, orientation, memory-pressure),
  which is the intended real-hardware upgrade — the `DeviceLifecycleUITests`
  harness is written against exactly these primitives.
- **The one thing the wireless tunnel cannot do is the first install**, which
  the simulator does trivially. That inverts the usual expectation: on the sim,
  install is free and the lifecycle events are limited; on this wirelessly-paired
  device, the lifecycle-control primitives are all present but the install
  prerequisite requires a cable. Executing the matrix needs one USB-cabled
  install; everything after that runs over the existing WiFi tunnel.
