# #10351 — desktop producer: real libwakeword → `voice:fusedWake` → bottom bar

The renderer consumer + the shared `FUSED_WAKE_EVENT` / `emitFusedWake` /
`bridgeDetectorToFusedWake` contract landed on develop via **#10373**. What was
still missing — and what the #10386 review explicitly called the
"genuinely-new, salvageable piece" — is the **desktop producer**: nothing ran
the native head on desktop and forwarded `onFusedWake` over
`sendToWebview('voice:fusedWake')`. This change adds it, on top of develop's
contract.

## The producer chain (all real)
```
desktop mic → DesktopMicSource → FusedWakeManager (electrobun main, bun:ffi)
  → real OpenWakeWordGgmlModel.scoreFrame (libwakeword) → threshold+streak+refractory
  → onWake(WakeFireInfo)  ──bridgeDetectorToFusedWake──▶  {stage:'head-fired', confidence}
  → sendToWebview('voice:fusedWake', detail)
  → registerDesktopFusedWake → emitFusedWake() → window 'eliza:fused-wake'   (#10373 consumer)
  → useWakeController → useWakeListenWindow.onOpen → bar active + startCapture('converse')
```

- **`FusedWakeManager`** (`packages/app-core/platforms/electrobun/src/native/fused-wake.ts`, mirrors `SwabbleManager`) runs the standalone libwakeword head in the desktop Bun main process and forwards each fire via the **shared** `bridgeDetectorToFusedWake`, so producer + consumer use the same `FusedWakeEventDetail` contract and never drift. Inert (`started:false`) when the model isn't staged — never forces mic access without the on-device assets.
- **`@elizaos/plugin-local-inference/voice-wake`** — a narrow barrel (no heavy-engine/llama import edge) so the lean electrobun main bundle isn't bloated.
- **`registerDesktopFusedWake`** (renderer) subscribes to `voice:fusedWake` → `emitFusedWake`, sets `__ELIZA_FUSED_WAKE__`, and arms `fusedWake:start` at boot (`main.tsx`). No-op off-desktop.

## Evidence (real desktop)

`test:fused-wake-integration-e2e` (`run-fused-wake-integration-e2e.mjs`) runs the
**real `FusedWakeManager`** (real libwakeword + `DesktopMicSource` fed the real
"hey eliza" clip at real time via `ffmpeg -re` + the real `OpenWakeWordDetector`)
and bridges its `sendToWebview('voice:fusedWake', …)` into a headless-Chromium
page running the **real** `registerDesktopFusedWake` + the **real** shell. Only
the electrobun IPC pipe is mocked (the standard `sendToWebview` transport, not
the thing under test).

| Artifact | Proves |
|---|---|
| `native-wakeword-score.txt` | real libwakeword peak P(wake) = 1.0000 on the clip. |
| `desktop-producer-bar-resting.png` / `desktop-producer-bar-active.png` | resting HomePill → bar **active** ("I'm listening — what do you need?"), driven by the real fire. |
| `desktop-producer-fused-wake.webm` | the resting → real-wake → active transition. |

Run output: `FusedWakeManager` listens (native-cpu), the real head **fires at
0.993 → voice:fusedWake**, the bar activates, a converse capture starts — all
assertions pass, no page errors.

```bash
ELIZA_WAKEWORD_LIB=<built libwakeword> \
  bun run --cwd packages/ui test:fused-wake-integration-e2e
```

The remaining decision to "ship on by default" is product gating (when to keep
the always-on desktop mic detector armed — battery / mic-permission / wake
setting); the producer arms via `fusedWake:start` and stays inert when the wake
model is not staged.
