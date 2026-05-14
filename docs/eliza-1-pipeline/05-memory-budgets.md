# Eliza-1 Per-Device-Class Memory Budgets

WS10 prep deliverable (2026-05-13). Companion to
[`ELIZA_1_GGUF_PLATFORM_PLAN.json`](../ELIZA_1_GGUF_PLATFORM_PLAN.json) and
[`ELIZA_1_BUNDLE_EXTRAS.json`](../ELIZA_1_BUNDLE_EXTRAS.json).

This table answers one question per row: **on this device, what can the
arbiter keep co-resident without thrashing?** It is the source of truth for
the runtime arbiter's eligibility checks. Numbers are working-set RAM (the
weights + KV cache + image-gen latents the arbiter expects to keep loaded
during a normal turn). They include neither the OS reservation nor the UI
process — both are accounted for in the "OS + UI baseline" column.

All numbers are **estimates based on quant footprints in
`ELIZA_1_BUNDLE_EXTRAS.json` and known KV-cache scaling** for Qwen3.5/3.6
class architectures; they will be re-baselined against live measurements in
WS10 finalization (M1).

## Conventions

- Sizes in GB, base-2 (1 GB = 1024 MB).
- "Text resident" = decoder weights at the per-tier default text quant +
  context-scaled KV cache for the arbiter's default ctx (32k for mobile,
  64k for laptop, 128k+ for workstation).
- "Vision mmproj resident" = mmproj GGUF only; the encoder forward is
  short-lived and accounted for as transient peak (≈ +200 MB on top).
- "OCR resident" = RapidOCR detector + recognizer ONNX kept warm.
- "Image-gen resident" = the default diffusion GGUF for that tier from
  `ELIZA_1_BUNDLE_EXTRAS.json`, kept in RAM while the user is in an
  image-gen flow. Set to `unloaded` if the device cannot keep it
  co-resident with text — the arbiter then swaps text↔image-gen on
  demand and prints a UX warning about the swap latency.
- "Headroom" = OS + UI baseline subtracted from total physical RAM, then
  minus everything to its left. **A row whose headroom is < 1 GB is the
  arbiter's "do not auto-enable" line.**
- "Recommended capabilities" lists the auto-enabled set on first run.
  Anything not in the list is opt-in via Settings → Capabilities.

## Table

| Device class | Total RAM | OS + UI baseline | Text tier (default) | Text resident | Vision mmproj resident | OCR resident | Image-gen resident | Headroom | Recommended capabilities |
|---|---|---|---|---|---|---|---|---|---|
| iPhone 14 (6 GB) | 6 GB | 2.0 GB | `eliza-1-0_8b` (Q3_K_M, 32k) | 0.7 GB | 0.22 GB | 0.08 GB | unloaded (swap to text) | 2.99 GB | text, asr, tts, vision-describe, ocr |
| iPhone 17 Pro (12 GB) | 12 GB | 2.5 GB | `eliza-1-2b` (Q4_K_M, 32k) | 1.5 GB | 0.32 GB | 0.08 GB | 1.05 GB (sd-1.5 Q5_0, image-gen co-resident) | 6.55 GB | text, asr, tts, vision-describe, ocr, image-gen, person-detect |
| Pixel 9 (8 GB) | 8 GB | 2.5 GB | `eliza-1-0_8b` (Q3_K_M, 32k) | 0.7 GB | 0.22 GB | 0.08 GB | unloaded (swap to text) | 4.50 GB | text, asr, tts, vision-describe, ocr |
| Snapdragon 8 Elite (16 GB) | 16 GB | 3.0 GB | `eliza-1-2b` (Q4_K_M, 32k) | 1.5 GB | 0.32 GB | 0.08 GB | 1.05 GB (sd-1.5 Q5_0) | 10.05 GB | text, asr, tts, vision-describe, ocr, image-gen, person-detect, screen-capture |
| Mac M2 (16 GB unified) | 16 GB | 3.5 GB | `eliza-1-4b` (Q4_K_M, 64k) | 2.8 GB | 0.38 GB | 0.08 GB | 3.40 GB (z-image-turbo Q4_K_M, swap from text on heavy contexts) | 5.84 GB | text, asr, tts, vision-describe, ocr, image-gen, person-detect, screen-capture |
| Mac M4 Max (64 GB unified) | 64 GB | 4.5 GB | `eliza-1-27b` (Q4_K_M, 128k) | 18.0 GB | 0.72 GB | 0.08 GB | 3.40 GB (z-image-turbo) | 37.30 GB | text, asr, tts, vision-describe, ocr, image-gen, person-detect, screen-capture, ax-fusion, click-grounding, app-enum, multi-monitor |
| Linux desktop 16 GB no GPU (CPU-only) | 16 GB | 3.0 GB | `eliza-1-2b` (Q4_K_M, 32k) | 1.5 GB | 0.32 GB | 0.08 GB | unloaded (swap to text; CPU diffusion too slow) | 11.10 GB | text, asr, tts, vision-describe, ocr, screen-capture |
| Linux desktop 32 GB no GPU (CPU-only) | 32 GB | 3.0 GB | `eliza-1-9b` (Q4_K_M, 64k) | 6.0 GB | 0.60 GB | 0.08 GB | unloaded (CPU diffusion latency unacceptable) | 22.32 GB | text, asr, tts, vision-describe, ocr, screen-capture |
| Linux desktop CUDA 12 GB VRAM (32 GB RAM) | 12 GB VRAM / 32 GB RAM | 3.0 GB / 1.5 GB VRAM | `eliza-1-9b` (Q4_K_M, 128k) | 6.5 GB VRAM | 0.60 GB VRAM | 0.08 GB RAM | 3.40 GB VRAM (z-image-turbo, swap from text) | VRAM 1.40 GB; RAM 28.92 GB | text, asr, tts, vision-describe, ocr, image-gen, person-detect, screen-capture, ax-fusion, click-grounding, app-enum |
| Linux desktop CUDA 24 GB VRAM (64 GB RAM) | 24 GB VRAM / 64 GB RAM | 3.0 GB / 1.5 GB VRAM | `eliza-1-27b` (Q4_K_M, 128k) | 18.0 GB VRAM | 0.72 GB VRAM | 0.08 GB RAM | 3.40 GB VRAM (z-image-turbo) | VRAM 0.38 GB; RAM 60.92 GB | text, asr, tts, vision-describe, ocr, image-gen, person-detect, screen-capture, ax-fusion, click-grounding, app-enum, multi-monitor |
| Windows 11 16 GB DX12 GPU 8 GB | 16 GB / 8 GB VRAM | 4.0 GB / 1.5 GB VRAM | `eliza-1-2b` (Q4_K_M, 64k) | 1.7 GB VRAM | 0.32 GB VRAM | 0.08 GB RAM | 1.10 GB VRAM (sd-1.5 Q5_0) | VRAM 3.38 GB; RAM 11.92 GB | text, asr, tts, vision-describe, ocr, image-gen, person-detect, screen-capture |
| Windows 11 32 GB DX12 GPU 16 GB | 32 GB / 16 GB VRAM | 4.0 GB / 1.5 GB VRAM | `eliza-1-9b` (Q4_K_M, 64k) | 6.0 GB VRAM | 0.60 GB VRAM | 0.08 GB RAM | 3.40 GB VRAM (z-image-turbo) | VRAM 4.50 GB; RAM 27.92 GB | text, asr, tts, vision-describe, ocr, image-gen, person-detect, screen-capture, ax-fusion, click-grounding, app-enum |

## Sanity rules (enforced by the WS10 validator)

1. **No phone runs an 8B-class text model resident.** Mobile rows (iPhone /
   Pixel / Snapdragon) must select `eliza-1-0_8b` or `eliza-1-2b`. The
   validator rejects a phone row paired with `eliza-1-4b`+.
2. **CPU-only Linux never auto-enables image-gen.** Diffusion latency on
   CPU is multi-minute per image; the arbiter never marks it co-resident
   on a CPU-only row.
3. **A row with negative headroom is invalid.** The arbiter must downgrade
   the text tier or unload image-gen until headroom is >= 1 GB.
4. **`recommended capabilities` is a strict subset of the device's
   eligible-capabilities set.** The full eligible set is computed by
   `arbiter/eligibility.ts` against the per-tier requirements in
   `ELIZA_1_GGUF_PLATFORM_PLAN.json`; this table only captures the
   first-run defaults.

## Open items for WS10 finalization

- Numbers will be re-baselined against live `mlx_lm` / `llama.cpp`
  resident-set readouts on each device class (M1: device-test matrix).
- iOS 26+ Foundation Models will get a separate row that lets the
  arbiter offload text to the OS-managed model and free `Text resident`
  for image-gen / vision.
- Linux Wayland and X11 currently share a row. WS10 will split them when
  the screen-capture column proves divergent (PipeWire vs `X11`).

## Cross-references

- Bundle base-v1: [`ELIZA_1_GGUF_PLATFORM_PLAN.json`](../ELIZA_1_GGUF_PLATFORM_PLAN.json)
- Runtime-downloaded extras: [`ELIZA_1_BUNDLE_EXTRAS.json`](../ELIZA_1_BUNDLE_EXTRAS.json)
- Test matrix: [`06-test-matrix.md`](06-test-matrix.md)
- Arbiter eligibility: `eliza/plugins/plugin-local-inference/src/arbiter/eligibility.ts` (WS3)
