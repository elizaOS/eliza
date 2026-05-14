# Kokoro Android TPU/NNAPI Delegate Status

Issue: elizaOS/eliza#7667.

Status: blocked on elizaOS/eliza#7666 and real Tensor TPU/NPU hardware.

Snapshot checked on 2026-05-14 with
`gh issue view 7667 --repo elizaOS/eliza --comments` and
`gh issue view 7666 --repo elizaOS/eliza --comments`: #7667 is still queued
behind #7666, and #7666 still requires the AOSP/package-boundary decision for a
CPU Kokoro TTS baseline.

## Current Repo State

- `plugins/plugin-aosp-local-inference/src/aosp-local-inference-bootstrap.ts`
  registers `TEXT_SMALL`, `TEXT_LARGE`, and `TEXT_EMBEDDING` for the AOSP
  bun:ffi path. It does not register `ModelType.TEXT_TO_SPEECH`.
- Kokoro TTS discovery and runtime code still live in
  `plugins/plugin-local-inference/src/services/voice/kokoro/`.
- The desktop/server local-inference handler registers
  `ModelType.TEXT_TO_SPEECH` in
  `plugins/plugin-local-inference/src/runtime/ensure-local-inference-handler.ts`,
  but importing that path into the AOSP plugin would reintroduce the package
  boundary problem called out in #7666.

The delegate work must not proceed by adding a second TTS primitive or by
duplicating Kokoro behavior into a separate Android-only implementation. The
next real implementation step is the #7666 CPU Kokoro path: AOSP needs a local
`TEXT_TO_SPEECH` handler that can synthesize with CPU ORT or the fused Kokoro
path and produce a baseline before an accelerator delegate is selected.

## Delegate Paths

Path A: ORT NNAPI execution provider.

- Lower-risk because it keeps the ONNX artifact and can fall back per op.
- Requires an Android ORT package with NNAPI EP available to the AOSP runtime.
- Must log NNAPI assignment/fallback. Kokoro graph sections such as
  `ScatterND` and `ConvTranspose` are likely fallback risks.

Path B: TFLite + Android delegate.

- More likely to hit sub-100 ms TTFB if conversion preserves the DAC/vocoder
  head accurately.
- Higher quality-regression risk. It requires a Kokoro TFLite artifact and an
  audio-delta gate before runtime selection.

## Validation Plan

1. Land #7666 and prove CPU Kokoro TTS on AOSP:
   - `ModelType.TEXT_TO_SPEECH` registered by `@elizaos/plugin-aosp-local-inference`.
   - Kokoro model + at least one voice staged under the Android agent state dir.
   - Baseline metrics captured on the target device: TTFB, RTF, peak RSS, and
     average voice-session power.
2. Prototype ORT NNAPI first for ONNX:
   - Verify Android API >= 27.
   - Record per-op NNAPI assignment/fallback.
   - Compare TTFB/RTF/power against the CPU baseline.
3. Prototype TFLite only after a conversion artifact exists:
   - Compare at least 100 phrases against the CPU/ONNX reference.
   - Gate quality on RMS <= 0.5 dB and no obvious clipping/dropout.
4. Hardware validation:
   - Run on Pixel 9-class Tensor TPU/NPU hardware or equivalent.
   - Use `adb shell dumpsys batterystats` or platform power rails to measure
     average voice-session power.
   - Do not approve #7667 without both sub-100 ms TTFB and sub-1 W average
     voice-session power on real hardware.

## Local Guardrail

`src/kokoro-tts-delegate-readiness.ts` classifies whether the Android Kokoro
delegate path is blocked, ready for a prototype, or ready for hardware
validation. It is intentionally side-effect free and does not register a model
handler.
