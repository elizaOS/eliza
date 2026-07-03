# Fresh-`develop` build on Pixel 6a — onboarding no longer shows the old chooser

On-device follow-up to the onboarding review. The device was running a **stale**
`ai.elizaos.app` (installed 12:56, before PR #11509 merged at 15:02) that showed
the old 3-option runtime chooser with **"Bring your own keys"**. This rebuilds
from current `develop` and captures what a fresh install actually does.

## Build & install (reproducible)

- Rebuilt `ai.elizaos.app` from `origin/develop` in a worktree, installed to the
  Pixel 6a (`adb install -r`). Freshness proof: `dumpsys package … lastUpdateTime`
  = **2026-07-02 17:18:33** (not the stale 12:56).
- Local agent runtime bundled (`agent-bundle.js`, 69 MB) + bun runtime jniLibs
  staged from the main checkout. **Local model inference (`libelizainference.so`)
  intentionally omitted** for this capture — the fused inference lib / voice-JNI
  need the llama.cpp `omnivoice` FFI header, not checked out in the worktree. The
  agent boots and runs; only local *model* inference is unavailable. Irrelevant
  to the onboarding UI, which is a pure web render.
- Toolchain notes (env only, not repo changes): `kotlin.jvm.target.validation.mode=warning`
  in user-global `~/.gradle/gradle.properties` (Java 21 vs a Capacitor plugin's
  Kotlin jvmTarget 17); `ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1` to skip the fused
  inference copy step.

## What a fresh install actually does — `01-fresh-develop-boots-to-home-local-agent.png`

After `pm clear ai.elizaos.app` + launch (its **own** bundled agent, **no** host
`adb reverse`), the app boots **straight to the home screen** with a **working
local agent** (composer active: "Ask Eliza"; home greeting + suggestion chips
"What's left today? / What can you do? / Summarize my day / Connect calendar…").

- **No runtime chooser** ("First, where should your agent run?") appears — and so
  **no "Bring your own keys" third option**. Mobile resolves its runtime through
  platform config to the bundled local agent (`mobile-runtime-mode.ts` /
  `reconcile-mobile-runtime-mode.ts`) rather than prompting the location chooser.
- **No forced cloud sign-in** on a fresh launch.

So the specific onboarding the user reported (a chooser with "Bring your own
keys" + a repeated sign-in) is **not reproduced on current `develop`** — it was
tied to the stale build. #11509 removed the offending chip in source (and the
four e2e specs that asserted it were fixed in #11656).

### Before / after (definitive)

- **BEFORE** — `../screenshots/02-onboarding-options-labels-symptom2.png`
  (captured live on the STALE 12:56 build, 3:41 PM): the in-chat onboarding sheet
  "Hi — I'm Eliza. Let's get you set up. First, where should your agent run?"
  with **three** chips: **Eliza Cloud (managed) / On this device / Bring your own
  keys** — exactly the reported symptom.
- **AFTER** — `01-fresh-develop-boots-to-home-local-agent.png` (fresh `develop`
  build, 5:21 PM): no chooser at all; boots straight to home with a working local
  agent. The "Bring your own keys" chip is gone.
- Other stale-build "before" captures in `../screenshots/`:
  `00-current-state.png` (the Custom-Tab `elizacloud.ai/auth/cli-login` cloud
  sign-in behind review symptom 1) and
  `07-onboarding-reset-after-restart-symptom11506.png` (onboarding re-appearing
  after the #11506 process restart).

## #11506 process churn — NOT reproduced on this build

The stale build's `ai.elizaos.app` pid churned every ~1–2 min (onboarding never
persisted). On this fresh build the pid was **stable > 2 minutes** across two
launch sessions (24255 held from ~17:22 through 17:24+, and an earlier session
held 60s). Not a proof of a fix — a longer soak is needed — but the aggressive
1–2 min churn did not recur in these windows.

## Honest caveats

- This build omits local model inference (see above); it does not exercise the
  "run a local model on device" path. The onboarding/home UI and agent boot are
  faithful to `develop`.
- The cloud sign-in **persistence** bug (review symptom 1 / device-code Custom
  Tab) only manifests when the user *chooses* Cloud, which on current `develop`
  is reached via Settings rather than a forced onboarding prompt — not exercised
  here.
- An intermediate build made with `-PelizaCloudBuild=true` crashed on a missing
  `agent/agent-bundle.js` — that was a **build-flag artifact** (cloud builds omit
  the local agent), NOT the #11506 bug; superseded by the faithful local build
  above and not included as evidence.
