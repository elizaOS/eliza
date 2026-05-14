# RFC #7667 — Tensor TPU / NNAPI delegate for Kokoro TTS on Android

Upstream: [elizaOS/eliza#7667](https://github.com/elizaOS/eliza/issues/7667).
Blocked on: [elizaOS/eliza#7666](https://github.com/elizaOS/eliza/issues/7666)
("CPU Kokoro on Android"). RFC scope: **polish, not critical path.**

This document records the readiness scaffold landed in `develop` and the
exact wiring a future NPU PR will need. Nothing here ships an NNAPI /
TFLite delegate runtime — that is the future PR.

## Why a scaffold first

The current Kokoro ORT loader is a single literal `executionProviders: ["cpu"]`.
The Kokoro source is mid-migration to `packages/shared/src/local-inference/kokoro/`
under #7666, so directly editing the loader now would conflict with that
move. Instead, this RFC's scaffold ships:

1. A typed, allowlisted execution-provider knob in `@elizaos/shared/local-inference`,
   defaulting to `"cpu"` so behaviour is unchanged.
2. A standalone NNAPI availability probe in `@elizaos/plugin-aosp-local-inference`
   that future Kokoro callers can gate on.
3. A pre-existing pure classifier (`assessKokoroDelegateReadiness`) that
   captures every gate #7667 must pass before we light the path up.

The future "wire it in" PR is a small, isolated change once #7666 lands.

## Codebase touchpoints

### Already landed by this scaffold

| File                                                                          | What                                                            |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/shared/src/local-inference/kokoro-execution-provider.ts`            | `KokoroExecutionProvider` type, `KOKORO_EXECUTION_PROVIDER_IDS`, `DEFAULT_KOKORO_EXECUTION_PROVIDER = "cpu"`, `parseKokoroExecutionProvider`, `buildKokoroOrtSessionOptions`. |
| `packages/shared/src/local-inference/kokoro-execution-provider.test.ts`       | Unit tests for the knob, parser, and builder. 100% coverage.    |
| `packages/shared/src/local-inference/index.ts`                                | Re-exports the new module from the shared barrel.               |
| `plugins/plugin-aosp-local-inference/src/nnapi-availability.ts`               | `probeNnapiAvailability(): Promise<NnapiAvailability>`; returns `{ available: false, reason: "not implemented", androidApiLevel: null }`. |
| `plugins/plugin-aosp-local-inference/__tests__/nnapi-availability.test.ts`    | Stub-shape and never-throws tests.                              |
| `plugins/plugin-aosp-local-inference/README.md`                               | Public-surface doc plus the ORT `--use_nnapi` / `--use_xnnpack` / `--use_coreml` build-flag matrix. |
| `plugins/plugin-aosp-local-inference/src/kokoro-tts-delegate-readiness.ts`    | Pre-existing pure classifier (`assessKokoroDelegateReadiness`).  |
| `plugins/plugin-aosp-local-inference/docs/kokoro-tpu-nnapi-delegate.md`       | Pre-existing #7666/#7667 snapshot.                              |

### Deferred — touched by the future NPU PR, NOT by this scaffold

The wiring change cannot land here without conflicting with #7666's
in-flight Kokoro move. Each row below documents the exact edit the future
PR must make.

| File (current path)                                                                 | Edit                                                                                                                                    |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/local-inference/kokoro/kokoro-runtime.ts`                      | Line 240–247: replace `executionProviders: ["cpu"]` with `...buildKokoroOrtSessionOptions(this.opts.executionProvider)` (spread). The other options keep their current values. |
| `packages/shared/src/local-inference/kokoro/kokoro-runtime.ts`                      | `KokoroOnnxRuntimeOptions` (around line 184) gains `executionProvider?: KokoroExecutionProvider`. Default still resolves to `"cpu"` via `DEFAULT_KOKORO_EXECUTION_PROVIDER`. |
| `packages/shared/src/local-inference/kokoro/kokoro-backend.ts`                      | Plumb the optional `executionProvider` through `KokoroBackendOptions` (currently in `kokoro/types.ts`) into `KokoroOnnxRuntimeOptions`. |
| `packages/shared/src/local-inference/kokoro/index.ts`                               | Re-export `KokoroExecutionProvider` from the kokoro barrel for convenience.                                                            |
| `plugins/plugin-aosp-local-inference/src/aosp-local-inference-bootstrap.ts`         | After #7666 registers `TEXT_TO_SPEECH`, call `probeNnapiAvailability()` and only pass `"nnapi"` when `available === true`. Otherwise fall through to `DEFAULT_KOKORO_EXECUTION_PROVIDER`. |
| `plugins/plugin-aosp-local-inference/src/nnapi-availability.ts`                     | Replace the stub body: detect API >= 27 (Bun's bridge to `Build.VERSION.SDK_INT`) and reflect the loaded ORT package's advertised EPs. |

### Why we keep the deferred Kokoro edits out of this PR

- The Kokoro runtime is moving in #7666; touching lines 240–247 now
  produces a guaranteed merge conflict and forces the #7666 author to
  rebase against a polish RFC.
- The bootstrap (`aosp-local-inference-bootstrap.ts`) currently does NOT
  register `TEXT_TO_SPEECH` — that registration is the whole point of
  #7666. There is no caller path to wire NNAPI into until that lands.
- Keeping the probe and the knob as separate, pure modules means the
  future PR is a localized diff with clear ownership: one Kokoro edit,
  one bootstrap edit, one probe replacement.

## Validation gates the future PR must pass

These were not invented here — they are taken from
`plugins/plugin-aosp-local-inference/src/kokoro-tts-delegate-readiness.ts`
and `plugins/plugin-aosp-local-inference/docs/kokoro-tpu-nnapi-delegate.md`,
and they hold this RFC.

1. **#7666 must be merged first.** AOSP must own a real CPU Kokoro
   `TEXT_TO_SPEECH` handler with baseline TTFB / RTF / peak RSS /
   average voice-session power captured on the target device.
2. **ORT NNAPI is the lower-risk path.** Prototype ONNX + NNAPI before
   exploring a TFLite delegate. Record per-op NNAPI assignment / fallback
   for `ScatterND`, `ConvTranspose`, and the BERT encoder so the regression
   surface is observable.
3. **API level gate.** NNAPI EP requires Android API 27+. The probe must
   refuse to advertise `available: true` below that.
4. **Custom ORT build.** Default `onnxruntime-react-native` lacks the NNAPI
   EP. The future PR must either ship a custom-built ORT via the AOSP
   build pipeline (`--use_nnapi`) or keep the probe at `available: false`
   on stock builds. See `plugins/plugin-aosp-local-inference/README.md`
   for the build-flag matrix. This scaffold deliberately does **not** add
   `onnxruntime-react-native` as a dependency.
5. **Real hardware required.** Pixel 9-class Tensor TPU / NPU hardware or
   equivalent. Cuttlefish and generic ADB targets cannot validate
   accelerator dispatch or power.
6. **Acceptance thresholds.** Sub-100 ms TTFB and sub-1 W
   average voice-session power on real hardware. The
   `assessKokoroDelegateReadiness` classifier already encodes this gate.

## Behaviour today

- `DEFAULT_KOKORO_EXECUTION_PROVIDER === "cpu"`.
- `buildKokoroOrtSessionOptions()` with no argument returns
  `{ executionProviders: ["cpu"] }`. Production behaviour is unchanged.
- `probeNnapiAvailability()` returns `{ available: false, reason: "not implemented", androidApiLevel: null }`.
- `assessKokoroDelegateReadiness` continues to report `blocked` until
  `cpuKokoroTtsPresent: true` (i.e. #7666 ships).

## Out of scope for #7667

- TFLite-based delegate. Tracked in the secondary path in
  `plugins/plugin-aosp-local-inference/docs/kokoro-tpu-nnapi-delegate.md`;
  only considered after the ORT NNAPI path is benchmarked.
- iOS CoreML wiring. `KOKORO_EXECUTION_PROVIDER_IDS` includes `"coreml"`
  for symmetry of the cross-platform knob, but iOS execution-provider
  wiring belongs to its own RFC.
- Auto-selection heuristics ("if API >= 27 and probe is available, switch
  to NNAPI"). The default stays `"cpu"`; the future PR is responsible for
  any auto-selection policy, gated on the same probe.
