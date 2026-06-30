# Evidence — fused on-device wake emits `eliza:fused-wake` end-to-end (#10351)

Closes the synthetic-event gap from #9953 Phase 2: the **real** `libwakeword`
runtime now drives the bottom bar, not just a synthetic CustomEvent.

## The bridge (what was missing)

The renderer side was already complete (`useWakeController` + `fused-wake-bridge.ts`
consume `eliza:fused-wake`), but **nothing produced that event** — the native
`OpenWakeWordDetector` fired only into `prewarmConversation`. This PR adds the
producer seam:

```
real libwakeword.dylib (bun:ffi)               packages/native/plugins/wakeword-cpp
  → OpenWakeWordGgmlModel.scoreFrame()         plugins/.../voice/wake-word-ggml.ts  (production binding)
  → OpenWakeWordDetector (sustain + refractory) plugins/.../voice/wake-word.ts       (onWake now carries confidence)
  → bridgeDetectorToFusedWake(sink)            plugins/.../voice/fused-wake-bridge.ts (NEW producer bridge)
  → engine startVoiceSession({ wakeWord.onFusedWake }) plugins/.../services/engine.ts (host seam)
  → window "eliza:fused-wake" (FusedWakeEventDetail)   @elizaos/shared/events       (one shared contract)
  → useWakeController → useWakeListenWindow    packages/ui/.../voice                 (bar opens + turn starts)
```

The event payload (`FusedWakeEventDetail`) is now a single contract in
`@elizaos/shared/events`, imported by **both** the producer
(`@elizaos/plugin-local-inference`) and the consumer (`@elizaos/ui`), so the two
halves can never drift.

## Real `libwakeword` ran locally — it is NOT a documented-only handoff

`libwakeword` is a pure-C `bun:ffi` library; it **builds and runs on this host**
(macOS, Apple Silicon). See `native-build-proof.txt`.

| Tier | Artifact | Result |
|---|---|---|
| **Real native E2E** (headline) | `fused-wake-e2e.log`, `validate-fused-wake-e2e.mjs` | **2/2.** Real `libwakeword.dylib` + the real sha-pinned `hey-eliza` GGUFs + a real PCM clip → `OpenWakeWordGgmlModel` (bun:ffi) → `OpenWakeWordDetector` → `bridgeDetectorToFusedWake` → `eliza:fused-wake` window event → shipped `wakeControllerReducer` → `head-fast-path` `WakeDetection` (= the bar opens + a turn starts). "hey eliza" peak `P(wake)=1.0000` fires; "what time is it" peak `0.0056` does not. |
| **Producer bridge (CI)** | `unit-tests.log` | `plugins/.../voice/fused-wake-bridge.test.ts` — 4/4. The real `OpenWakeWordDetector` (deterministic scripted model) → `bridgeDetectorToFusedWake` emits exactly one `head-fired` `FusedWakeEventDetail` per firing with the firing confidence; refractory debounce + re-arm + never-fire covered. Node CI, no native. |
| **Renderer activation (CI)** | `unit-tests.log` | `packages/ui/.../voice/useWakeController.fused.test.tsx` — a head-fired `eliza:fused-wake` opens the listening window (`useWakeListenWindow` → `onOpen`), proving the bar activates + a turn starts. |
| **Audio** | `hey-eliza-clip.wav` | The exact real audio fed to the native runtime (16 kHz mono, macOS `say` + ffmpeg, 2.5 s lead-in so the streaming mel/embedding rings warm up). |

## Reproduce

```bash
# 1. build the native lib (once):
cmake -B packages/native/plugins/wakeword-cpp/build -S packages/native/plugins/wakeword-cpp
cmake --build packages/native/plugins/wakeword-cpp/build -j

# 2. real end-to-end (GGUFs auto-download + sha-verify if WAKE_GGUF_DIR unset):
bun .github/issue-evidence/10351-fused-wake-bridge/validate-fused-wake-e2e.mjs

# 3. CI-deterministic unit coverage:
bunx vitest run --root plugins/plugin-local-inference src/services/voice/fused-wake-bridge.test.ts
bunx vitest run --root packages/ui src/voice/useWakeController.fused.test.tsx
```

## Device handoff (the remaining, hardware-bound piece)

A literal screen recording of the desktop bottom bar opening when a human speaks
"hey eliza" is **N/A here** — it needs hardware this host can't drive headlessly:

1. A **live always-on voice session.** `engine.startVoiceSession()` is currently
   not invoked by any production caller (it is the documented voice entry point,
   but no surface enables an always-on wake session yet). The `wakeWord.onFusedWake`
   seam is in place for when one is wired.
2. A **per-platform host transport.** The agent/native runtime and the renderer
   are separate processes; the host must forward the producer's `FusedWakeEventDetail`
   to the renderer (Capacitor plugin event on mobile — mirroring Swabble's
   `wakeWord` listener; Electrobun RPC on desktop; WebSocket push on web) and call
   the renderer's `emitFusedWake` / set `window.__ELIZA_FUSED_WAKE__`.
3. A **live microphone + on-device capture** (real mic → bar opens → turn starts),
   per `PR_EVIDENCE.md`'s native capture matrix.

Everything that does **not** need that hardware — the real native detection, the
producer→`eliza:fused-wake` bridge, and the renderer's bar-activation — is proven
real above. The window CustomEvent collapsed into one process by the E2E harness
is the **identical** seam used in production; only the cross-process transport is
the device-integration step.
