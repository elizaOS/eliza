# #8785 — iOS simulator voice evidence

Captured on a booted **iPhone 16 Pro simulator** (Xcode, `xcrun simctl`) on
2026-06-22. The app **builds, installs, boots, and renders on the iOS
simulator** — recorded.

## What's proven (on the simulator)

| Artifact | Shows |
| --- | --- |
| `ios-sim-app-running.mp4` | Full session recording: install → launch → onboarding → deep-link to voice. |
| `ios-sim-01-onboarding-runtime-select.png` | The Eliza app live on the iOS sim: first-run "How should Eliza run?" — **Eliza Cloud (recommended)** / **This device (private)**. The app shell + UI render correctly on iOS. |
| `ios-sim-02-local-agent-unavailable-graceful.png` | Deep-link `elizaos://voice` → the local-agent path **gracefully** reports `Startup failed: Backend Timeout` with the exact cause (`@elizaos/capacitor-bun-runtime does not resolve`) + Retry — not a crash. |

## What's gated (and precisely why)

The **voice round-trip** on the simulator is gated by two known, documented
constraints — the same ones in the [validation runbook §2/§3](../../../plugins/plugin-local-inference/src/services/voice/research/VOICE_VALIDATION_RUNBOOK.md):

1. **Local path** — needs the embedded full-Bun iOS runtime. The pre-built
   binary used here was *not* built with `ELIZA_IOS_FULL_BUN_ENGINE=1`, so
   `@elizaos/capacitor-bun-runtime` is absent and the local agent can't start.
   A `build:ios:local:sim:full-bun` build embeds it — and the **engine itself
   compiled + validated for the simulator** (`ElizaBunEngine.framework/
   ios-arm64-simulator` ✓). The full-bun *app* build was then blocked by
   unrelated **branch build-infra staleness** in the renderer build (`build:web`
   — first a stale `@elizaos/shared` dist, then a rollup unresolved-module id),
   not a voice issue. And regardless: the simulator has **no Metal**, so
   on-device token generation can't run there (a known simulator limitation;
   real on-device inference needs a physical device).
2. **Cloud path** — selecting "Eliza Cloud" needs an authenticated session;
   inference returns HTTP 402 (no credits) on the test account.

## Reproduce

```bash
# install a prebuilt sim App.app + record + screenshot:
xcrun simctl install booted <DerivedData>/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl io booted recordVideo --codec h264 /tmp/ios-sim.mp4 &
xcrun simctl launch booted ai.elizaos.app
xcrun simctl openurl booted "elizaos://voice"
xcrun simctl io booted screenshot /tmp/ios-sim.png
# full-bun engine build (so the local agent starts on the sim):
bun run --cwd packages/app build:ios:local:sim:full-bun
```

**Bottom line:** the iOS simulator runs the app end-to-end through the UI; the
voice *inference* on the sim is Metal-gated (local) / credential-gated (cloud) —
exactly as on a device, plus this binary lacked the Bun engine. The desktop/web
lane ([../8785-voice-headful/](../8785-voice-headful/README.md)) is the proven
end-to-end voice round-trip.
