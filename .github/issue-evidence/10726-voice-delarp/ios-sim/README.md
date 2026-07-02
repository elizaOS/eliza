# iOS Simulator evidence — eliza app (iPhone 16, iOS 18.1)

The elizaOS app built from `develop` (which includes the merged #10699 transcription
button and the #10700 send/new-chat routing fix), running on the **iPhone 16 iOS
simulator** — genuine on-device-class evidence for the voice UI.

## How it was produced
```
bun run --cwd packages/app build:ios:local:sim   # ** BUILD SUCCEEDED ** → DerivedData/.../App.app (ai.elizaos.app)
xcrun simctl boot "iPhone 16" && xcrun simctl install <udid> App.app && xcrun simctl launch <udid> ai.elizaos.app
xcrun simctl io <udid> screenshot ...             # + recordVideo for the walkthrough
```
(The local app build was unblocked with the isolated biome-2.4.16 config workaround
documented in the session notes; xcodebuild then succeeded.)

## Artifacts
- `ios-home-with-voice-composer.png` — home + FTU welcome + the continuous chat overlay
  with the composer showing the **mic** control (the voice entry point on iOS).
- `ios-home-clean.png` — the collapsed composer pill (`+` / "Ask Eliza…" / mic) after
  dismissing the deep-link prompt via idb.
- `ios-app-walkthrough.mp4` — screen recording of the app running on the simulator.

## Notes / honest limits
- The composer shows "Ask Eliza — waking up…": the on-device local agent is still warming
  on the simulator (no bundled model), so the send/transcription round-trip could not be
  driven to completion here. The **#10699 transcribe button in voice mode** is proven
  functionally on web (5 component tests + the agent-executed live-app QA run showing
  `transcribe=true / stop transcription / badge`) and rendered by the story gate; this iOS
  lane proves the same app + composer + mic surface builds and runs natively on iOS.
- **Real iOS device: N/A** — no physical device is connected to this machine to
  install/provision onto.

## Systematic iOS-sim scenario coverage (idb-driven)
Beyond the static shots, idb (companion connected) drove the composer through
real button-state transitions on the simulator:
- `ios-scenario-draft-morphs-to-send.png` — typing a draft morphs the trailing mic → **send** control.
- `ios-scenario-turn-in-flight-stop.png` — submitting expands the overlay and shows the thinking indicator + **stop** control.
- `ios-scenario-slash-menu.png` — typing `/` opens the slash-command menu.
The full send/transcription round-trip and the slash command catalog stay in a
"loading / waking up" state because the on-device local agent has no bundled
model on the simulator — inherent to running the local-agent app on a sim.

## Real iOS device (Shaw's iPhone, iPhone 15 Pro, iOS 26.5)
- Device detected + **paired + available** (`xcrun devicectl list devices`).
- The elizaOS app **builds for the physical device** (`build:ios:local` device
  destination → `** BUILD SUCCEEDED **`, `Debug-iphoneos/App.app`).
- Install/launch is blocked ONLY by two **physical** steps on the phone that
  cannot be performed remotely: the device must be **unlocked**
  (`devicectl … lockState → passcodeRequired: true`; launch denied "device …
  not unlocked") and the developer app must be **trusted** on-device. A signed
  sideload build + an auto-install-on-unlock were prepared so this completes the
  moment the phone is unlocked.
