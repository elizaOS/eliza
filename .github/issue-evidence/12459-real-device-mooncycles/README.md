# Real-device lifecycle matrix — physical iPhone "MoonCycles" (#12459 / #12185)

Real-hardware counterpart to the simulator/emulator lifecycle lane
(`packages/app/scripts/ios-sim-lifecycle.mjs`,
`.github/issue-evidence/12185-device-lifecycle/`). Everything here was run
against ONE owner-authorized physical device and nothing else.

## TL;DR outcome — EXECUTED (USB-cabled)

- **Device build + code-sign: SUCCEEDED** on real A18 Pro hardware (full-Bun
  engine, `** BUILD SUCCEEDED **`, `codesign --verify --deep --strict` OK).
- **Install on MoonCycles: SUCCEEDED — via the usbmux `installation_proxy`
  (`ideviceinstaller`), not devicectl.** The USB cable made the transport `wired`
  but did **not** restore CoreDevice's `installapp` capability (absent from the
  device's capability list even USB-cabled), so `devicectl device install app`
  still fails with `CoreDeviceError 1001`. The classic usbmux installer — which
  bypasses CoreDevice — installed the signed app cleanly (`InstallComplete
  (100%)`; `ideviceinstaller list → ai.elizaos.app, "1.0", "Eliza"`). See
  `install-run-usb.log`. The prior "wireless-only" diagnosis was incomplete: the
  block is a CoreDevice/Xcode-side capability gap, not a transport one.
- **Lifecycle events: EXECUTED — all PASS.** Launch, app-switch (Settings), real
  Camera switch, orientation (real landscape reflow), suspend/resume, memory-pressure
  warning, and true process death (terminate → fresh-PID recovery) were driven
  against the running app via `devicectl device process …` + `devicectl device
  orientation set`, with real-device screenshots via `pymobiledevice3 developer dvt
  screenshot --userspace` and a RunningBoard syslog timeline. Process identity was
  tracked to prove **survive** (PID 1151 held) vs **recover** (fresh PID 1173 after
  the kill). See `matrix.md` (authoritative) + `lifecycle-capture/`.
- **Committed `AppUITests/DeviceLifecycleUITests` harness: NOT runnable headless.**
  `xcodebuild build-for-testing -allowProvisioningUpdates` cannot sign the test
  runner without an Xcode Apple ID account (`No Accounts`), and the appexes trip
  App-Group entitlement errors a test build cannot strip. See `harness-capture.log`.
  The direct `devicectl` drive reaches the same OS lifecycle transitions.

## Device under test (the only device touched)

| Property | Value |
|---|---|
| Name | **MoonCycles** |
| Model | iPhone 16 Pro Max (iPhone17,2, `D94AP`) |
| iOS | 18.7.8 (build 22H352) |
| Hardware UDID | `00008140-0006491E2E90801C` |
| CoreDevice identifier | `59EBB356-BC44-5AA2-91F1-E6AAE756BB86` |
| Developer Mode | enabled |
| Pairing / transport | paired, CoreDevice localNetwork tunnel |

Every `devicectl` call targeted `--device 00008140-0006491E2E90801C`; every
`xcodebuild` run targeted `-destination 'platform=iOS,id=00008140-0006491E2E90801C'`.
"Shaw's iPhone" (`00008130-001955E91EF8001C`, iPhone 15 Pro) and all other
devices were never addressed. The `00008140` SoC prefix = A18 Pro = iPhone 16
Pro Max; `00008130` = A17 Pro = iPhone 15 Pro — the prefixes disambiguate the
two phones and confirm targeting.

## Signing / deploy

The device build uses the repo's canonical unsigned-build → profile-graft →
explicit-nested-signing → `devicectl install` lane
(`packages/app/scripts/ios-device-deploy.mjs`), with `--skip-appexes` because
only the app's own development profile exists on this machine (per-appex
profiles would each need an Xcode-account/ASC session to mint).

- **Provisioning profile:** `iOS Team Provisioning Profile: ai.elizaos.app`
  (`0b619c06-…`) — `application-identifier 25877RY2EH.ai.elizaos.app`, includes
  MoonCycles UDID in `ProvisionedDevices`, `get-task-allow=true`, unexpired
  (2027-06-22).
- **Signing identity:** `Apple Development: Shaw Walters (UT5K5Q5EVF)` — matched
  to the profile's embedded `developerCertificateSha1s` by the deploy lane's own
  selector (`selectSigningIdentity`). The `--skip-appexes` flag strips
  `PlugIns/*.appex` (widgets / keyboard / website-blocker) before signing, so
  those extension surfaces are absent from this install — main-app lifecycle
  testing only, which is the scope here.

### Fresh-worktree build gaps resolved (build environment, not device)

This branch was built from a fresh git worktree that shares the parent
`eliza/node_modules`. Three environment gaps had to be closed to produce a
device build; none are code changes to the app:

1. `packages/agent/scripts/build-mobile-bundle.mjs` resolves
   `@electric-sql/pglite/dist` via a literal `repoRoot/node_modules` join that
   does not walk up to the shared parent — satisfied by symlinking the
   worktree's `node_modules` to the parent it already resolves against
   (node_modules is gitignored).
2. The mobile web build only runs the heavy `dev:prepare` turbo declaration
   build when `packages/shared/dist/index.js` is absent; once present, Vite
   `build:web` aliases `@elizaos/*` to source and does not need it.
3. `@capacitor/share@^8.0.0` (declared in `packages/app/package.json`, pinned in
   `bun.lock` at 8.0.1, statically imported by `src/main.tsx` →
   `ios-attachment-smoke.ts`) was missing from the shared parent node_modules
   (installed before the dependency was added) — installed targeted.

## What was driven on real hardware vs simulator-only

The honest delta is captured in `matrix.md`. The committed XCUITest driver
(`AppUITests/DeviceLifecycleUITests`) is the intended vehicle, but it cannot
build headless (no Xcode account to sign the `.xctrunner` test runner). The same
events the simulator lane must mark N/A — real-app backgrounding, the real Camera
app, real orientation change, and true process death — were instead driven
directly against the installed app via `devicectl device process …` +
`devicectl device orientation set`, with real-device screenshots
(`pymobiledevice3 developer dvt screenshot --userspace`) and a RunningBoard
syslog timeline. Every event PASSED: the app returned foreground with a live
renderer, and process identity proved survive (PID 1151) vs recover (fresh PID
1173). The events a physical battery / ringer switch / lock button do not expose
to any driver stay honest N/A rows with the precise hardware-truth reason.

## Files

- `matrix.md` — the per-event real-hardware matrix (how driven → executed result).
- `install-run-usb.log` — the devicectl `CoreDeviceError 1001` (installapp absent
  even wired) + the successful usbmux `ideviceinstaller` install.
- `harness-capture.log` — the `xcodebuild build-for-testing` runner-signing block
  (`No Accounts` + appex App-Group entitlements) that makes the XCUITest harness
  unrunnable headless.
- `deploy-build.log`, `signed-app-verification.txt` — build/sign of the staged app.
- `device-info-mooncycles.json` — device identity + transport metadata for the one
  owner-authorized iPhone; `device-capabilities-wireless.txt` — a CoreDevice
  capability list documenting the missing `installapp` capability.
- `lifecycle-capture/` — the 12 real-device screenshots (one per event, foreground +
  refocus) and `device-console-timeline.log` (curated RunningBoard jetsam/launch/
  terminate timeline for `ai.elizaos.app`: 100=foreground, 40=background, 0=suspended;
  PID 1151 survive vs PID 1173 recover). The in-process full-Bun agent has no TCP
  port, so this RunningBoard timeline + the fresh-PID relaunch is the agent-recovery
  evidence (replacing the sim lane's `:31337` loopback probe).
