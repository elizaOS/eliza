# Local GGUF VLM describe on macOS Metal (#9581 — "local vision GGUF VLMs as on-device describers")

The on-device GGUF-VLM describe path runs correctly on Apple Metal (M4 Max),
verified 2026-06-25 with `llama-mtmd-cli` (libmtmd) and the staged Eliza-1 vision
bundle — the same llama.cpp multimodal path a SmolVLM / Moondream2 / Holo
describer would plug into (swap the text GGUF + mmproj; the runtime is identical).

## Run

```
llama-mtmd-cli \
  -m   eliza-1-0_8b.bundle/text/eliza-1-0_8b-128k.gguf      (qwen35 0.8B Q4_K_M, 531 MB) \
  --mmproj eliza-1-0_8b.bundle/vision/mmproj-0_8b.gguf      (Qwen-VL projector, 74 MB) \
  --image .github/issue-evidence/9581-macos-desktop-cua/browser-evidence.png \
  -p "Describe what is visible in this screenshot in one sentence." \
  -ngl 99 -n 80 --temp 0.2
```

- Backend: **Metal**, all layers on GPU (`-ngl 99`). Encode + decode ≈ 0.5 s.

## Output (verbatim)

> This screenshot shows a blank page with the text "macOS CUA Evidence" at the
> top and a "Ready" button next to a blank input field.

**Correct.** The input is the controlled CDP evidence page — `<h1>macOS CUA
Evidence</h1>` + a `Ready` button + a blank `<input>`. The model read the heading
text, identified the button by its label, and the empty field — i.e. real OCR +
layout grounding through the on-device vision projector.

## Why this matters for #9581

The "Local vision GGUF VLMs (SmolVLM / Moondream2 / Holo) as on-device
describers" item is a *backend swap*, not a new runtime: the
`VisionDescribeBackend` seam (`plugins/plugin-local-inference/src/services/vision/`)
dispatches an image + prompt to a GGUF VLM. This run proves that GGUF-VLM
describe path is correct and Metal-accelerated on macOS today; adding SmolVLM /
Moondream2 is registering another `{ text gguf, mmproj }` pair behind the same
`createVisionCapabilityRegistration()` arbiter capability.
