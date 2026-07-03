# Real iOS device — MoonCycles (iPhone 16 Pro Max, iOS 18.7.8)

The full real-device pipeline was exercised end-to-end on **physical hardware** (not a
simulator) via a scripted XCUITest, with your Apple Development signing identity.

## Proven on the physical device
| Step | Result |
|---|---|
| Detect + pair | `devicectl list devices` → MoonCycles `available (paired)` iPhone 16 Pro Max |
| Build for device | `xcodebuild build-for-testing` (AppUITests scheme) → `** TEST BUILD SUCCEEDED **` |
| Sign | deep-signed App + all embedded frameworks/plugins with "Apple Development: Shaw Walters" (`codesign --verify --deep` exit 0) |
| Install | installed on MoonCycles (`devicectl device install app`) |
| Launch | launched on MoonCycles (`AppUITests-Runner` drove `ai.elizaos.app`) |
| **UI automation** | XCUITest ran on the device (after enabling **Settings ▸ Developer ▸ Enable UI Automation**) and captured screenshots as `.xcresult` attachments |
| **Real-device screenshots** | `ios-device-booting-0*.png` — genuine pixels from the physical phone |

This is the **one** real-device screenshot path that works for a modern **CoreDevice**
(iOS 17+) iPhone: `idb`, `libimobiledevice`/`idevicescreenshot`, and `devicectl` all lack a
device-screenshot capability, so an in-process XCUITest that calls `XCUIScreen.main.screenshot()`
is required. That harness (`packages/app/ios/App/AppUITests/VoiceUITests.swift`, added via the
`xcodeproj` gem) is the reusable capture mechanism.

## Real DEVICE-ONLY bug found (does NOT reproduce on the simulator)
Every real-device screenshot shows the app stuck on the **"Booting up…"** splash — it never
reaches the chat/voice UI. The simulator boots to the home screen fine, so this is
device-specific. The device console (`ios-device-console.log`) gives the precise root cause:

```
⚡️ Loading app at capacitor://localhost...
⚡️ JS Eval error A JavaScript exception occurred
⚡️ [info] - [renderer-build] … built (variant=store, target=ios)
⚡️ TO JS {"value":"cloud"}
[AgentWatchdog] bootstrapped (dormant until a local agent starts)
⚡️ TO JS {"…","state":"error","error":"iOS Agent requires a configured HTTP endpoint for
     remote/cloud mode, or runtimeMode=local for dev/sideload local mode. Set Agent.apiBase
     in capacitor config…"}
```

**Diagnosis:** the device build ships the **`variant=store` / `runtimeMode=cloud`** web bundle
with **no `Agent.apiBase` configured**, and a **JS eval error fires at load** (the injected
runtime-config script throws). In cloud mode with no endpoint the agent errors out, so the
"Booting up…" splash never resolves. On the simulator the local-variant bundle booted a local
agent, so the hang never appeared. Grafting the signed `ElizaBunEngine.framework` into the build
did **not** fix it — the blocker is the store/cloud bundle + missing `apiBase` + the load-time
JS eval error, not a missing framework.

**This is a real, filable production bug** for the device/sideload lane (candidate for #10204 /
#9958 / a new issue): a sideload/store iOS build with no configured agent endpoint hangs at boot
on a physical device. Fix path: build the web bundle in the **local** variant with the full-Bun
engine for sideload (or configure a reachable `Agent.apiBase` for cloud mode) **and** resolve the
load-time JS eval error in the Capacitor runtime-config injection.

## Why the voice UI itself is proven elsewhere, not here
Because the app can't get past boot on this device build, the composer/mic/transcription can't be
driven on the physical phone. That surface is proven on **web** (4/4 e2e green + video, #10801),
**mac-desktop** (same e2e), the **iOS simulator** (idb-driven mic→send→stop morph + slash menu),
component tests (fuzz 6→8), and the agent-executed QA run. The physical-device evidence here proves
the app **builds, signs, installs, launches, and runs on real hardware with automated capture** —
and surfaces the real boot bug that only real hardware reveals.

## UPDATE — root cause fixed; local agent now boots on the physical device ✅

The `variant=store / cloud-hybrid` bundle was traced to an earlier
`install:ios:cloud:sideload **--cloud**` run that built a **cloud** bundle and
cap-synced it into the project, which every later device build then baked. A
clean `build:ios:local` (device, no `--cloud`, with `ELIZA_IOS_FULL_BUN_ENGINE=1`)
re-synced the correct bundle and native config:

```
BUILT APP: {'variant': 'direct', 'runtimeMode': 'local'}   # was store/cloud-hybrid
engine embedded (ElizaBunEngine.framework): yes             # was absent
```

Installed + launched on MoonCycles, the device console now shows the **local
agent RUNNING on the physical phone** (previously `state:"error"`):

```
[AgentWatchdog] bootstrapped (dormant until a local agent starts)
⚡️ TO JS {"state":"running","agentName":"Eliza","startedAt":1782944706479,"error":null}
```

So the real-device boot hang (#11030) is a **build-config bug**, and the fix is
to build the local (non-cloud) variant with the full-Bun engine for the
sideload/device lane — proven here by the agent reaching `state:"running"` on the
physical device. Raw console: `ios-device-agent-running-console.log`.

## Second bug — renderer JS eval error blocks the UI even when the agent runs

With the local build the **native agent reaches `state:"running"`** (proven above), yet the
XCUITest screenshots on-device (`ios-device-live-0*.png`) STILL show "Booting up…" at 150s.
The device console shows a persistent, load-time renderer failure that the simulator does not hit:

```
⚡️ Loading app at capacitor://localhost...
⚡️ JS Eval error A JavaScript exception occurred    ← throws at renderer load
```

So there are **two independent device-boot bugs**:
1. **(fixed here)** the device build shipped a cloud/store bundle → the local agent errored →
   fixed by a clean `build:ios:local` (direct/local variant + full-Bun engine) → agent now runs.
2. **(open)** a **JS eval error at renderer load** prevents the web UI from transitioning off the
   "Booting up…" splash even once the native agent is running — a real renderer/Capacitor-bridge
   defect specific to the device (not reproduced on the simulator, which boots to home).

Both are captured in #11030. Because of (2), the interactive chat/voice UI cannot yet be reached
on the physical device; that surface is fully proven on web (4/4 e2e + video), mac-desktop, the
iOS simulator (idb-driven scenarios), component fuzz, and the agent-executed QA run.
