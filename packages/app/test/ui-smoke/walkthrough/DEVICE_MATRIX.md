# Full Walkthrough — Platform Matrix

The full-journey walkthrough (#10198 / #10204) runs the same intent — cold
launch → onboarding → tutorial → help → settings → wallet → real chat →
view-switch → settings-edit → dashboard — across the platform matrix. The web
lane is the canonical, fully DOM-driven run; native lanes adapt to what each
WebView host supports. Every lane has a command, prerequisites, and a concrete
skip reason; unavailable lanes are recorded N/A, never silently dropped.

## Why the lanes differ (the inherent asymmetry)

| Host | DOM driver | How the journey is driven |
| --- | --- | --- |
| Web / desktop Chromium | Playwright (full CDP) | `full-walkthrough.spec.ts` drives all 25 steps directly. |
| Android emulator / device | **Chromium WebView over CDP** | `android-e2e.mjs` attaches Playwright to the on-device WebView (`adb forward` → `webview_devtools_remote_<pid>` → `chromium.connectOverCDP`). Real DOM driving. |
| iOS simulator / device | **none** — WKWebView has no CDP/remote DOM driver | The journey is driven **in-app** through the Capacitor `UserDefaults` request/result handshake (`ios-onboarding-smoke.mjs`, `mobile-local-chat-smoke.mjs`); the host captures with `xcrun simctl io`. |

This is a platform limitation, not a gap in this work: there is no remote DOM
inspector for WKWebView, so iOS cannot be Playwright-driven the way Android can.
The iOS lane therefore drives the same flow from inside the app and captures the
result; closing the parity fully would require a new WKWebView remote-inspector
bridge (out of scope here; related: #9958, #9967).

## Lanes

### Web / desktop (canonical, always available)

```bash
bun run --cwd packages/app test:e2e:walkthrough          # keyless mock lane
bun run --cwd packages/app test:e2e:walkthrough:live     # real backend + model
```

- **Prereqs:** none for the mock lane. The live lane needs a provider key
  (`ANTHROPIC_API_KEY`, read from `.env.local`) and boots the real agent via
  `playwright-ui-live-stack.ts` (`ELIZA_UI_SMOKE_LIVE_STACK=1`).
- **Produces:** `reports/walkthrough/<runId>/{desktop,mobile}/NN-*.png` +
  `steps.json` + `logs/` (+ `trajectory/chat-step.json` in the live lane), the
  committed `WALKTHROUGH_VERDICTS.md`, and one stitched human-speed recording per
  viewport under `e2e-recordings/app/walkthrough/<runId>/`.
- **Skip reason:** never — this lane is the floor.

### iOS simulator

```bash
bun run --cwd packages/app build:ios:local:sim           # rebuild from this tree FIRST
bun run --cwd packages/app test:e2e:walkthrough:ios
```

- **Prereqs (macOS only):** a booted simulator
  (`xcrun simctl boot 'iPhone 16 Pro'`) and a **fresh** simulator app build in
  DerivedData. The runner refuses to capture a stale install (per the
  rebuild-before-capture rule).
- **Produces:** `.github/issue-evidence/10198-walkthrough-ios-sim-*.png/.mov`
  (single-shot `simctl io` capture of the running app) plus
  `reports/walkthrough/<runId>/device-matrix.json` with per-phase status for
  `ios-onboarding-smoke.mjs` (onboarding), `mobile-local-chat-smoke.mjs` (chat
  round-trip with `--ios-select-local --ios-full-bun-smoke`), and
  `capture-ios-sim.mjs`.
- **Skip reason (recorded automatically):** "not macOS", "no booted iOS
  simulator", or "no iOS simulator app build found in DerivedData".

### iOS physical device

```bash
bun run --cwd packages/app ios:device:deploy                 # build + sign + stage App.app FIRST
bun run --cwd packages/app test:e2e:walkthrough:device       # detects the tethered iPhone + captures
```

- **Prereqs (macOS only):** a tethered, provisioned iPhone in devicectl state
  `connected`, and the signed staged app at
  `ios/build/device-deploy-stage/App.app` produced by `ios:device:deploy`
  (rebuild-before-capture rule — the lane refuses to capture without it). Target
  a specific device with `--ios-device <id>` or `ELIZA_IOS_DEVICE_ID` (matched on
  the devicectl identifier, hardware UDID, or device name).
- **Detection (real, not hardcoded):** the lane runs
  `xcrun devicectl list devices`, picks a `connected`/`available` device
  (honoring the requested id), then invokes the proven on-device capture
  pipeline `ios-device-capture.mjs --platform device --device <id> --skip-build
  --app-path <staged>` (boot + walkthrough XCUITest suites; WKWebView has no CDP,
  so the in-app narrative parity runs through the committed
  AppUITests/BootCaptureUITests harness).
- **Produces:** an XCUITest attachment dir under
  `ios/build/boot-capture/walkthrough-ios-device-<stamp>/` (screenshots + AX
  snapshots), recorded as the lane's `outputDir` in `device-matrix.json`.
- **Skip reason (recorded automatically, derived from the actual devicectl
  probe):** "host is not darwin"; "devicectl unavailable: <error>"; "no paired
  devices"; "no connected iOS device on this host (devicectl listing: …)"; the
  requested device "not present"/"is not connected (state: …)"; or "connected,
  but no signed staged app at … — run `ios:device:deploy` first". Unavailable is
  a non-fatal `n/a`; a device that is present but whose capture breaks records a
  fatal `error`.

### Android emulator

```bash
bun run --cwd packages/app test:e2e:android              # boots an AVD + drives the WebView journey
bun run --cwd packages/app test:e2e:walkthrough:android  # screen capture of the running app
```

- **Prereqs:** Android SDK platform-tools (`adb`) + an AVD or attached device.
  `android-e2e.mjs` auto-boots an AVD headless and the APK must be built with
  `ELIZA_WEBVIEW_DEBUG=1` for the CDP target to exist.
- **Produces (capture leg):**
  `.github/issue-evidence/10198-walkthrough-android-*.png/.mp4`
  (`adb screenrecord`). The **driven** journey + route coverage is
  `test:e2e:android`.
- **Skip reason (recorded automatically):** "adb not found on PATH" or "no
  Android device or emulator attached (`adb devices` is empty)".

### Android physical device

```bash
ANDROID_SERIAL=<serial> bun run --cwd packages/app test:e2e:walkthrough:device
```

- **Prereqs:** a USB-attached, developer-mode Android device (not an emulator).
- **Skip reason (recorded automatically):** "no Android device/emulator
  attached" or "--platform device requires a physical Android device; only
  emulator is attached".

## Host coverage (Mac/iOS vs Linux/Android)

- **Mac/iOS host:** runs web + iOS simulator (+ iOS device when tethered). The
  Android emulator can also run on macOS but is heavier; Android device coverage
  needs a tethered device.
- **Linux/Android host:** runs web + Android emulator/device. iOS cannot run on
  Linux (`xcrun`/`simctl` are macOS-only) — recorded N/A there.

The runner writes a machine-readable per-platform status to
`reports/walkthrough/<runId>/device-matrix.json` (status = `captured` | `n/a` |
`error`, each with a concrete reason), which feeds the closing PR's evidence
table.
