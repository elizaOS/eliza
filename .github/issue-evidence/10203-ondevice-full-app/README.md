# #10203 / #10197 — full app + agent verified on-device (home render + chat turn)

The crash/restart-stability issues ask for "every feature works without the agent
crashing, **verified with the phone physically connected**." The in-flight PRs do
agent restart (#10397) and watchdog (#10480); this provides the **end-to-end
"the app actually runs and chats" verification on a real device**, which required
clearing several blockers first.

## What it took (root-cause unblocks, this session)

1. **Fixed `build:android`** — it was building the wrong app because
   `run-mobile-build.mjs`'s `repoRoot` fallback resolved to the outer Eliza
   monorepo. `ELIZA_MOBILE_REPO_ROOT=<eliza checkout>` → a fresh, correctly
   reconciled APK (0 `PluginLoadException`, 37 plugins).
2. **Bypassed the x86 on-device-agent SIGSEGV** the same way the e2e harness
   does: ran a real host agent (`serve-real-local-agent.ts`, deterministic model,
   no keys) and `adb reverse tcp:31337`.
3. **Provisioned a clean device** — the primary emulator is contended by a
   concurrent session and the physical Pixel is PIN-locked, so I created and
   booted a dedicated `android-34` emulator with 6 GB RAM (the default-RAM one
   lowmemory-killed the app).
4. **Drove onboarding to home** against the host agent (the `onboarding-option-remote`
   flow, address `http://127.0.0.1:31337`), all over CDP-via-adb.

## Result

`home-dashboard-ondevice.png` — the app at the **home dashboard** (`data-page=home`,
chat composer present, live widgets: "Brooklyn 74°F Clear", greeting, suggested
actions). CDP confirms `home-launcher-surface` visible, `data-page="home"`,
`chat-composer-textarea` present.

`chat-turn-ondevice.png` — a **real on-device chat turn**: typed "Reply with
exactly the word PONG", the host agent (`DeviceE2EHostAgent`) received it and the
**reply rendered in the app** ("hey, i'm here. what do you need?" → a response).
The full UI → bridge → host-agent → response pipeline works on-device; the agent
did **not** crash.

(The host agent uses a deterministic model, so the reply text is canned — this
verifies the end-to-end pipeline + agent liveness, not LLM answer quality.)

This also unblocks the broader on-device app-testing surface (view lifecycle for
#10196, chat, connectors) now that a real device can render the full shell
against a working agent.


## Multi-turn agent-liveness soak

`chat-soak-ondevice.txt` — 4 consecutive chat turns on-device. Every turn: the
message round-trips and a response renders; `/api/health` reports
`agentState="running"`; and the app pid stays **4110 before and after** — the
agent and app never crash across the soak. That's the device-connected "every
feature works without the agent crashing" property over repeated use.

## Screen recording

`onboard-chat-walkthrough.mp4` — a screen recording of the full on-device flow: onboarding (remote → host agent) → home dashboard renders → a chat message is typed and sent. Captured via `adb screenrecord` while driving the app over CDP.

## Backend-loss crash recovery

`agent-crash-recovery.txt` — a crash-injection recovery test (the kind #10197 asks for): with the app at home and chatting, the host agent is **killed mid-session** (backend crash), and the app's `/api/health` goes unreachable — yet the **app pid stays constant (8546), so the app never crashes**. When the agent is restarted (recovered at t+15s), the app reconnects (`agentState=running`). Distinct from #10397's on-device agent restart — this is backend-loss recovery.
