# eliza-1 vision (IMAGE_DESCRIPTION) — PROVEN working end-to-end through the fused product path

**Date:** 2026-07-02 · **Tier:** eliza-1-2b (Gemma-4 E2B) · **Backend:** fused `libelizainference` (`activeBackendId=llama-cpp`), NOT `llama-mtmd-cli`.

## What was wrong (and wasn't)
The long-standing "vision dimension mismatch (`text n_embd 2048 ≠ mmproj 1536`)" was a **phantom caused by a stale local model file**, not a code/model bug. The copy under `~/.local/state/eliza/models/bundles/2b/text/eliza-1-2b-128k.gguf` was a pre-cutover **qwen35** artifact (1211 MB, `embedding_length=2048`). The current HF `elizaos/eliza-1` file is **gemma4** (4737 MB, `embedding_length=1536`) and matches `mmproj-2b` (`projector_type=gemma4v`, `projection_dim=1536`). 4b pairs identically: gemma4 `embedding_length=2560` = `mmproj-4b` `projection_dim=2560`. Both shipping tiers are correctly paired on HF.

## Proof — the real product path
Harness drove `createImageDescriptionRuntime(tier=eliza-1-2b, root=/tmp/vision/gemma4/bundles/2b)` → `engine.canDescribeImages()=true` → invoked `ModelType.IMAGE_DESCRIPTION` via the **MemoryArbiter path** (the same path the running agent uses), against the real gemma4-2b bundle + `mmproj-2b.gguf` + `input-test.jpg`.

- `image slice encoded in 518 ms`, `image decoded (batch 1/1) in 37 ms`, **handler returned in 9586 ms**
- Marker: `ELIZA1_VISION_HANDLER_PRESENT=1`
- The gemma4 chat template (`<|image>` sentinels, 256 image tokens) is applied **inside** the fused describe path — no external `--jinja` needed at the product layer.

### Model output (full description, verbatim excerpt)
> The image is a diagram or logo featuring two distinct elements: a red circle and a blue square.
> 1. **Red Circle:** There is a large, solid red circle in the center-left of the image.
> 2. **Blue Square:** There is a solid blue square in the center-right of the image.
> The word "HELLO" appears twice in the image: once below the red circle, once below the blue square.

The test image (`input-test.jpg`) is exactly a red circle + blue rectangle + the word "HELLO" — the description is **fully correct**, including spatial layout and the doubled text. This is real on-device vision, not a mock.

## Files
- `fused-describe-run.log` — full run log (bundle load → arbiter IMAGE_DESCRIPTION → description → unload).
- `input-test.jpg` — the input image.

## Related issues
Evidence for the vision leg of **#9033** (Gemma-4 cutover + multi-backend `libelizainference`) and **#10727** (local-model full-lifecycle verification). Not a standalone close — both are broader umbrellas.
