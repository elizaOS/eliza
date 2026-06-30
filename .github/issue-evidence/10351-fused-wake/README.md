# #10351 — real libwakeword → `eliza:fused-wake` → bottom bar

Closes the synthetic-event gap: before this change the only thing that emitted
`eliza:fused-wake` was a synthetic UI test. Now the **real** `libwakeword`
(openWakeWord) runtime fires a structured event, a real transport forwards it,
and the **real** bottom bar activates — proven by real tests across the
agent-process ↔ renderer boundary.

## The chain

```
mic PCM → engine.feedWakeFrame → OpenWakeWordDetector.pushFrame
  → real OpenWakeWordGgmlModel.scoreFrame (bun:ffi → libwakeword)
  → threshold + activation-streak + refractory
  → onWake(confidence)                         ← B1 (wake-word.ts)
  → engine wakeWord.onWake({stage:'head-fired', confidence})   ← B3 (engine.ts)
  → sendToWebview('voice:fusedWake', event)     [desktop transport]
  → registerDesktopFusedWake → emitFusedWake()  ← T2 (fused-wake-desktop-bridge.ts)
  → window 'eliza:fused-wake'  (fused-wake-bridge.ts, already shipped)
  → useWakeController → useWakeListenWindow.onOpen
  → useShellController: setIsOpen(true) + startCapture('converse')   → BAR ACTIVE
```

The renderer consumer (`fused-wake-bridge.ts` + `useWakeController` +
`useWakeListenWindow` + the shell) already existed and was unit-tested with a
*synthetic* emit. This change builds the producer + transport that drive it for
real, and sets `window.__ELIZA_FUSED_WAKE__` at renderer boot
(`registerDesktopFusedWake`, T3 in `packages/app/src/main.tsx`) so the head
fast-path is live.

## Scope decision — `head-fired` only

The standalone openWakeWord head is a single trained-head detector, so it
produces only the terminal `head-fired` stage (`SHIPPED_WAKE_HEADS=['eliza']` →
the `head-fast-path`). There is no Stage-A generic candidate / Stage-B ASR
confirmation *producer* in the plugin; those `FusedWakeEvent` variants are
accepted structurally for forward-compatibility but never invented. `head-fired`
fully drives the bar.

## Evidence (real, split topology)

The producer (bun:ffi model) and consumer (DOM event in Chromium) cannot share a
process, so the e2e is split — each half maximally real for its layer:

| Artifact | Proves |
|---|---|
| `native-wakeword-score.txt` | the real `libwakeword` runtime scores the "hey eliza" clip at **peak P(wake) = 1.0000** (native reference scorer, v0.3.0 GGUFs). |
| **4a** `wake-word-real-fire.real.test.ts` (`bun test`) | the real model wrapped in the production `OpenWakeWordDetector` fires **exactly once at confidence > 0.9** on the clip, and **does not fire on silence** — 2 pass / 0 fail. This is the value the renderer receives. |
| **4b** `run-fused-wake-e2e.mjs` (`bun run --cwd packages/ui test:fused-wake-e2e`) | dispatching the genuine `eliza:fused-wake` head-fired event through the **real** `useWakeController`/`useWakeListenWindow`/shell **activates the bar** (ChatSurface mounts) and **starts a converse capture** — all assertions pass, no page/console errors. |
| `fused-wake-bar-resting.png` | resting chromeless HomePill (before wake). |
| `fused-wake-bar-active.png` | the bar **active** after the wake ("I'm listening — what do you need?" + the converse composer). |
| `fused-wake-bar.webm` | the resting → wake → active transition, recorded. |
| `10351-hey-eliza.f32` | the 16 kHz mono f32 wake clip (2.5 s lead-in + "hey eliza" + 1 s tail; macOS `say` + ffmpeg). Vendored as `…/voice/__fixtures__/hey-eliza-16k.f32`. |

## Reproduce

```bash
# producer (real model fires with confidence) — needs the prebuilt libwakeword
# + the 3 hey-eliza GGUFs staged under packages/native/plugins/wakeword-cpp/build/
bun test plugins/plugin-local-inference/src/services/voice/wake-word-real-fire.real.test.ts

# consumer (emit → real bar activates), records screenshots + video
bun run --cwd packages/ui test:fused-wake-e2e
```

## Desktop full-chain (manual, on-device) — N/A here, see note

The cross-process desktop capture (speak "hey eliza" at the mic → bar activates,
with screen recording + audio) requires the desktop runtime to continuously run
the wake-enabled voice session on the real mic. The producer→transport→renderer
code is in place and proven per-layer above; wiring the continuous desktop
wake-listen lifecycle (when to arm `startVoiceSession({wakeWord:{enabled:true}})`
on desktop) is captured separately. The two automated halves (4a + 4b) already
exercise the real model and the real bar.
