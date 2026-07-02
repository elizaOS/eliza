# Watchable on-device XCUITest suite — first real-device run (MoonCycles)

Leg A of the iOS epic "automated device actions, human-visible runs" (PR #11431,
branch `feat/ios-agent-boot-automation`). First-ever execution of the DEVICE lane
of `packages/app/scripts/ios-device-capture.mjs` on physical hardware:
iPhone 16 Pro Max "MoonCycles", devicectl id `59EBB356-BC44-5AA2-91F1-E6AAE756BB86`,
iOS 18.7.8, Developer Mode on, no passcode.

STATUS: device lane PROVEN through runner install + launch (one real script
bug found and fixed); final on-device green run BLOCKED on a physical
first-unlock of the passcode-protected phone (see Findings 2-3). The extended
suite (boot + composer interaction) is GREEN with full watchable evidence on
the simulator lane, same tree, same day (`sim-interaction-run/`).

## Command under test

```bash
cd packages/app
node scripts/ios-device-capture.mjs \
  --platform device \
  --device 59EBB356-BC44-5AA2-91F1-E6AAE756BB86 \
  --app-path ios/build/device-deploy-stage/App.app \
  --derived-data ios/build/device-deploy-dd \
  --output ios/build/boot-capture/device-run-N
```

`--app-path` points at the signed graft produced by `ios-device-deploy.mjs`
(the same App.app already installed and verified booting on the device:
engine bootstrap ~900 ms, auth-status-ok ~2 s).

## Run log (chronological)

### Run 1 — first-user bug: unsigned runner (FIXED in script)

- Command: as above, `--output device-run-1`.
- `build-for-testing` used the committed device lane, which passed
  `CODE_SIGNING_ALLOWED=NO` (correct for the SIM lane, fatal for device).
- Result: `AppUITests-Runner.app` unsigned → installd rejects it:
  `0xe8008018 "The identity used to sign the executable is no longer valid"` →
  `** TEST EXECUTE FAILED **` before any launch.
- Artifacts: `run-1-failure-attachment.txt` (the exported xcresult attachment).
- FIX (uncommitted, this leg): `ios-device-capture.mjs` device lane now builds
  signed — drops `CODE_SIGNING_ALLOWED=NO` (sim keeps it) and passes
  `-allowProvisioningUpdates`. The project already carries
  `CODE_SIGN_STYLE=Automatic` + `DEVELOPMENT_TEAM`, so xcodebuild signs the
  runner with the Apple Development identity and mints/uses the wildcard
  "iOS Team Provisioning Profile: *" for `ai.elizaos.app.xctrunner`.
  Verified: `** TEST BUILD SUCCEEDED **` with
  `Provisioning Profile: "iOS Team Provisioning Profile: *"` in the signing log.

### Run 2 — signed runner installs + launches; automation-mode timeout

- Runner installed and launched on the phone (pid 1477) — the signing fix works.
- Failure: `The test runner failed to initialize for UI testing.
  (Underlying Error: Timed out while enabling automation mode.)`
- testmanagerd on the device refused/failed the automation-mode grant.

### Run 3 — same automation-mode timeout (not a flake)

- Identical failure (pid 1479). Deterministic device-state issue, not luck.
- Remediation attempted: full device reboot via
  `xcrun devicectl device reboot` (resets testmanagerd state).

### Run 4 — post-reboot: device absent from xcodebuild destinations (exit 70)

- The phone is connected over Wi-Fi only (no USB entry in `system_profiler
  SPUSBDataType`; hostname `MoonCycles.coredevice.local`). After the reboot the
  CoreDevice tunnel did not re-establish promptly: `devicectl list devices`
  stayed `unavailable`, `devicectl device process launch` failed with
  CoreDeviceError 1011 ("unable to locate a device"), and xcodebuild exit 70
  listed only simulator destinations.
- Remediation: bounced the user-owned `remotepairingd` daemon on the Mac to
  force wireless rediscovery, then re-polled for `available (paired)`.

### Run 5+ — blocked on physical first-unlock (see Findings)

## Artifacts in this directory

| File | What it shows |
|---|---|
| `run-1-failure-attachment.txt` | xcresult attachment from run 1: installd rejects the unsigned runner (0xe8008018) — the first-user bug in the committed device lane, now fixed in `ios-device-capture.mjs` |
| `run-2-test-summary.json` | xcresulttool summary, run 2: runner installed + launched on MoonCycles (real device metadata: 18.7.8 / 22H352 / arm64e), 1 failed — "Timed out while enabling automation mode" |
| `run-3-test-summary.json` | Same failure on the immediate retry — deterministic, not flake |
| `run-4-destination-error.txt` | Post-reboot xcodebuild exit 70: MoonCycles absent from the eligible-destination dump (Shaw's iPhone IS present) — CoreDevice tunnel down in BFU |
| `sim-interaction-run/` | Full green run of the EXTENDED suite (boot + new composer interaction) on sim 39F890C2 (iPhone 16, iOS 18.1), same day, same tree: `Executed 2 tests, with 0 failures in 47.6s`. `boot-000s.png` (splash) → `boot-final-home.png` (home, "Ask Eliza" composer) → `interaction-000-home.png` → `interaction-010-composer-tapped.png` (keyboard up) → `interaction-020-typed-hello.png` (**"hello" typed in the composer, cursor visible**) + `ax-hierarchy-interaction.txt` (`TextField … placeholderValue: 'Ask Eliza', value: hello, Keyboard Focused`) + `test-summary.json`. Every PNG opened and reviewed by hand. Same-run boot trace included (`eliza-boot-trace.jsonl`, 53 events: `process-launch` → renderer `native-request`s → watchdog `probe` `ready:true engine:bun mode:local`, timestamps matching the test window 19:29-19:30Z). |

Full `BootCapture.xcresult` bundles for every run:
`packages/app/ios/build/boot-capture/device-run-{1,2,3,4}/` (gitignored build dir).

## Findings

1. **Device-lane script bug (FIXED, uncommitted in this tree):** the committed
   `ios-device-capture.mjs` passed `CODE_SIGNING_ALLOWED=NO` to
   `build-for-testing` for BOTH lanes. Correct on the simulator; on device it
   produces an unsigned `AppUITests-Runner.app` that installd rejects with
   `0xe8008018`. Fix: sim keeps `CODE_SIGNING_ALLOWED=NO`; device now builds
   signed with `-allowProvisioningUpdates` (project already carries
   `CODE_SIGN_STYLE=Automatic` + team). Verified twice: xcodebuild signs the
   runner with the Apple Development identity + the auto-minted wildcard
   "iOS Team Provisioning Profile: *" and the runner **installs and launches
   on the phone** (run 2/3 pids 1477/1479).

2. **"Timed out while enabling automation mode" (REAL residual, device-state):**
   with the signed runner running, testmanagerd on the phone refused the
   automation-mode grant, twice, deterministically. Root cause consistent with
   a LOCKED device: despite the leg brief's "no passcode gate", lockdown
   reports **`PasswordProtected: true`** for MoonCycles (via
   `ideviceinfo -u 00008140-0006491E2E90801C`). XCUITest's automation-mode
   enablement requires an unlocked, attended screen.
   The SIGTRAP-under-attached-console residual was therefore NOT reachable this
   leg — the suite never got as far as launching the target app; no data
   either way on XCUITest-context SIGTRAP.

3. **Reboot remediation surfaced a harder blocker (BFU):** after
   `xcrun devicectl device reboot`, the passcode-protected phone sits
   before-first-unlock; developer services stay down. Observed:
   `devicectl list devices` → `unavailable` (>30 min), CoreDeviceError 1011 on
   any device operation, xcodebuild exit 70 (device not an eligible
   destination) — while plain lockdown-over-USB still answers
   (`pymobiledevice3 usbmux list` shows ConnectionType USB; `ideviceinfo`
   works). Bouncing the user-owned `remotepairingd` did not help; `usbmuxd`/
   `remoted` are root-owned (no sudo in this environment). **A human must
   unlock the phone once**; then the tunnel returns and the suite can run.

## What is proven vs pending

Proven on real hardware this leg:
- The device capture lane end-to-end up to test execution: template-synced
  AppUITests target → signed build-for-testing → xctestrun normalization +
  UITargetAppPath rewrite onto the signed graft → destination resolution →
  runner install → runner launch on MoonCycles.
- The signing fix (the one code change the lane needed to become real).

Pending first unlock of the phone (exact resume command):

```bash
cd packages/app
node scripts/ios-device-capture.mjs \
  --platform device --device 59EBB356-BC44-5AA2-91F1-E6AAE756BB86 \
  --app-path ios/build/device-deploy-stage/App.app \
  --derived-data ios/build/device-deploy-dd --skip-build \
  --output ios/build/boot-capture/device-run-5
# then pull the same-run boot trace:
node scripts/ios-device-logs.mjs --device 59EBB356-BC44-5AA2-91F1-E6AAE756BB86 \
  --no-console --pull-boot-trace
```

The suite now also contains `testComposerAcceptsTypedText` (uncommitted, in
both the canonical template `packages/app-core/platforms/ios/App/AppUITests/`
and the generated project): boots to home, taps the chat composer through the
WKWebView AX tree, waits for the keyboard, types "hello", screenshots each
step (`interaction-000/010/020`), asserts the composer AX value contains
"hello"; every environmental precondition failure is an XCTSkip, not a
false red. Compiles clean for the device (`** TEST BUILD SUCCEEDED **`) and
**passes green end-to-end on the simulator** (see `sim-interaction-run/`):
the harness found the "Ask Eliza" TextField through the WKWebView AX tree,
tapped it, got the keyboard, typed "hello", and the AX value assertion held.
