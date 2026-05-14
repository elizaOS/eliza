# Voice quantization coverage matrix

**Last updated:** 2026-05-14
**Owner:** I8-quant (workstream)
**Source-of-truth refs:**
- `.swarm/research/R8-quant.md` §2 (the full per-model audit)
- `.swarm/research/R6-omnivoice.md` §5.6 (OmniVoice-specific quant rules)
- `packages/shared/src/local-inference/catalog.ts` (runtime selection)
- `packages/training/scripts/manifest/eliza1_manifest.py` (publish ladder)
- `plugins/plugin-local-inference/native/AGENTS.md` §1–4, §8 (kernel + gate)

This document is the **live**, code-tracked mirror of R8's coverage table.
When you add a new voice sub-model or a new quant recipe, update both this
table and `VOICE_QUANT_LADDER_BY_TIER` / `voiceQuantLadderForTier` so the
publish path and the runtime stay in sync.

---

## How to read this table

- `app` — applicable, real recipe + kernel + verification fixture already
  exist or trivially extend.
- `app-NW` — applicable, needs work (recipe gap or fixture gap, but the
  arch fits and the kernel exists).
- `N/A` — not applicable to this model class given the current pipeline
  definition (e.g. QJL on a model with no KV cache).
- Q3/Q4/Q5/Q6 columns refer to GGUF K-quant ladders
  (`Q3_K_M` / `Q4_K_M` / `Q5_K_M` / `Q6_K`).
- "GGUF?" — is the model already shipped or shippable as GGUF in the
  eliza-1 bundle? "yes" if either the in-repo llama.cpp fork has the
  arch native or `omnivoice.cpp/tools/quantize.cpp` already covers it.
- "llama.cpp?" — is the model architecture supported by the fork at
  `plugins/plugin-local-inference/native/llama.cpp`?

## Coverage matrix

| model                                            | polarquant            | turboquant       | qjl              | Q3_K_M | Q4_K_M | Q5_K_M | Q6_K  | Q8_0  | GGUF? | llama.cpp?                  | notes |
|--------------------------------------------------|-----------------------|------------------|------------------|--------|--------|--------|-------|-------|-------|-----------------------------|-------|
| eliza-1 LM (Qwen3.5 0.8B/2B/4B/9B + Qwen3.6 27B) | app                   | app              | app              | app    | app    | app    | app   | app   | yes   | yes (LLM_ARCH_QWEN3/QWEN35) | Baseline. PolarQuant + QJL + TurboQuant Q3/Q4 ship today. K-quant ladder Q3..Q8 via sibling `gguf-q{3,4,5,6}_k_m_apply.py` (Q4 default; Q3/Q5/Q6 written by I8). |
| DFlash drafter (companion)                       | app                   | app              | app              | app    | app    | app    | app   | app   | yes   | yes (LLM_ARCH_DFLASH_DRAFT) | Same recipe + arch as the target LM, gated by `target_text_checkpoint_hash`. Inherits the K-quant ladder from the LM siblings. |
| Qwen3-ASR (0.6B / 1.7B)                          | app-NW                | N/A              | N/A              | app    | app    | app    | app   | app   | yes   | yes (Qwen3 + audio mmproj)  | Text body rides Qwen3 K-quants; audio mmproj projector held at Q8_0 by default (R8 §3.6 — sub-Q8 regresses WER). Wrapper: `gguf_asr_apply.py` (I8). PolarQuant on the text Linear bank is plausible (same arch as eliza-1 LM) but no recipe is wired yet. QJL/TBQ N/A — ASR utterances are short and the KV-compression win is negligible. |
| Kokoro-82M (TTS)                                 | app-NW (encoder only) | N/A              | N/A              | gated  | gated  | gated  | gated | gated | partial | WIP arch                   | Kokoro is autoregressive AdaIN + iSTFT vocoder. ONNX is canonical today (`tts/kokoro/model_q4.onnx`). K-quant ladder gated on `LLM_ARCH_KOKORO` landing in the fork (R8 §3.1; effort L). PolarQuant on the encoder Linear bank is plausible but not validated against MOS. QJL/TBQ N/A — no LM-style KV decode at long context. |
| OmniVoice (Qwen3-TTS LM + HuBERT + DAC + RVQ)    | app-NW (LM head only) | **N/A (R6 §5.6)** | **N/A (R6 §5.6)** | app    | app    | app    | app   | app   | yes   | no (lives in omnivoice.cpp) | Full Q2_K..Q8_0 ladder available via `omnivoice.cpp/tools/quantize.cpp`. Publish ladder = `VOICE_QUANT_LADDER_BY_TIER` (`Q3_K_M`, `Q4_K_M`, `Q5_K_M`, `Q6_K`, `Q8_0` for 9b+ tiers). PolarQuant **applies** to OmniVoice's Qwen3-shaped LM head (R6 §5.6) but a recipe is not yet wired. **V-cache PolarQuant N/A** — OmniVoice has no KV cache between MaskGIT steps. QJL conditional, deferred. |
| Turn detector (LiveKit / turnsense)              | app-NW                | N/A              | N/A              | app    | app    | app    | app   | app   | app-NW | yes (LLM_ARCH_LLAMA / LLM_ARCH_QWEN2) | SmolLM2-135M (EN) / pruned Qwen2.5-0.5B (intl) / latishab/turnsense — all Llama- or qwen2-shaped. Wrapper: `turn_detector/convert_to_gguf.py` (I8). Bundle stager wiring tracked by I1. |
| Speaker encoder                                  | N/A                   | N/A              | N/A              | N/A    | N/A    | N/A    | N/A   | N/A   | no    | no                          | No runtime model in the bundle today — speaker preset is a precomputed 256-dim Float32 vector. If a dedicated encoder lands (ECAPA / WavLM), polarquant applies; QJL/TBQ never. |
| Text emotion classifier                          | app-NW                | N/A              | N/A              | app-NW | app-NW | app-NW | app-NW | app-NW | not-yet | partial (BERT/ModernBERT)  | Today's path is the eliza-1 LM via the Stage-1 envelope `emotion` enum field-evaluator (I3) — inherits the LM's quant coverage unchanged. A dedicated distil-BERT head would ride the fork's existing BERT arch. |
| Voice emotion classifier (Wav2Small)             | N/A                   | N/A              | N/A              | N/A    | N/A    | N/A    | N/A   | int8  | no (ONNX) | no                       | 72K-param Wav2Small distilled from `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`. Ships as ~120 KB ONNX int8. K-quant ladder N/A — the model is already smaller than a single K-quant block. |
| Silero VAD (v5.1.2)                              | N/A                   | N/A              | N/A              | N/A    | N/A    | N/A    | N/A   | int8  | no (ONNX) | no                       | Small LSTM/CNN, ~2 MB int8 ONNX. AGENTS.md §1 explicitly calls Silero out as the canonical VAD; porting to llama.cpp is a net negative (R8 §3.3). |
| openWakeWord                                     | N/A                   | N/A              | N/A              | N/A    | N/A    | N/A    | N/A   | int8  | no (ONNX) | no                       | Three small ONNX graphs (mel + embedding + per-phrase head). Opt-in, local-mode only. K-quant ladder N/A; porting is a net negative (R8 §3.4). |
| Text embedding (when dedicated)                  | app-NW                | app              | app              | app    | app    | app    | app   | app   | yes (when dedicated) | yes (BERT family)     | Small tiers reuse the LM backbone via `--pooling last`. When a dedicated 1024-dim Matryoshka model lands for the larger tiers, it rides the BERT-family K-quant ladder. |

## Operational rules

### PolarQuant / TurboQuant / QJL applicability cheat-sheet

Quoting R6 §5.6 + R8 §1 for the most-asked questions:

- **PolarQuant (weight quantizer)** — applies to any transformer whose
  weight matrices are `nn.Linear` blocks of input-dim ≥ 4096. Verified on
  Qwen2/3/3.5, Llama, Mistral, Phi3 today. **Skips** `lm_head` and
  `embed_*` layers by design. For non-allowlisted arches, the wrapper
  warns and proceeds; we require a per-block-MSE measurement before
  publishing a polarquanted release for any new model class.
- **QJL (K-cache compressor)** — applies only to models that materialize
  an autoregressive KV cache. Encoders (BERT family, Silero VAD),
  classifiers (single forward pass), and OmniVoice (MaskGIT chunks, no
  cache) are **N/A**.
- **TurboQuant (V-cache compressor)** — same applicability as QJL.
- **K-quant ladder (Q3..Q8)** — applies anywhere `llama-quantize` can
  load the f16 GGUF. The fork covers Qwen3, Llama, Mistral, Phi3, BERT,
  ModernBERT; omnivoice.cpp covers the OmniVoice LM head.

### Publish ladder per tier (OmniVoice)

Mirrors `VOICE_QUANT_LADDER_BY_TIER` in
`packages/training/scripts/manifest/eliza1_manifest.py` and
`voiceQuantLadderForTier()` in
`packages/shared/src/local-inference/catalog.ts`:

| tier        | published OmniVoice ladder                          | runtime default | rationale |
|-------------|-----------------------------------------------------|-----------------|-----------|
| 0_8b        | `Q3_K_M`, `Q4_K_M`, `Q5_K_M`                       | `Q4_K_M`        | OmniVoice first; Kokoro remains the low-latency fallback. |
| 2b          | `Q3_K_M`, `Q4_K_M`, `Q5_K_M`                       | `Q4_K_M`        | Same. |
| 4b          | `Q3_K_M`, `Q4_K_M`, `Q5_K_M`                       | `Q4_K_M`        | Same. |
| 9b          | `Q3_K_M`, `Q4_K_M`, `Q5_K_M`, `Q6_K`, `Q8_0`        | `Q8_0`          | Boundary tier; OmniVoice first with Kokoro fallback. |
| 27b         | `Q3_K_M`, `Q4_K_M`, `Q5_K_M`, `Q6_K`, `Q8_0`        | `Q8_0`          | RAM permits Q8_0 by default; smaller levels for memory-constrained desktops. |
| 27b-256k    | `Q3_K_M`, `Q4_K_M`, `Q5_K_M`, `Q6_K`, `Q8_0`        | `Q8_0`          | Same as 27b. |
| 27b-1m      | `Q3_K_M`, `Q4_K_M`, `Q5_K_M`, `Q6_K`, `Q8_0`        | `Q8_0`          | Workstation tier. |

The downloader resolves which level to fetch at install time based on
the host's memory class (MAX / GOOD / OKAY / POOR per
`memory-budget.ts`). **No silent fallback** — AGENTS.md §3 forbids
"try the next smaller one" at runtime; if the resolved level isn't in
the bundle, the install fails loudly.

### LM publish ladder

The eliza-1 text LM publishes every K-quant level via the sibling
apply scripts:

- `packages/training/scripts/quantization/gguf-q3_k_m_apply.py`
- `packages/training/scripts/quantization/gguf-q4_k_m_apply.py`
- `packages/training/scripts/quantization/gguf-q5_k_m_apply.py`
- `packages/training/scripts/quantization/gguf-q6_k_apply.py`

All four have an identical CLI surface (`--model`, `--output`,
`--calibration`, `--calibration-samples`, `--llama-cpp-dir`,
`--keep-f16`, `--no-smoke-load`, `--dry-run`). Q8_0 emission goes
through `gguf_eliza1_apply.py` for the eliza-typed slots
(`Q4_POLAR=47`, `QJL1_256=46`, `TBQ4_0=45`, `TBQ3_0=44`,
`TBQ3_TCQ=48`).

## Verification gate

Per `plugins/plugin-local-inference/native/AGENTS.md` §8, every K-quant
level shipped in a bundle must:

1. Pass `make load-smoke-<arch>` for its arch family in
   `plugins/plugin-local-inference/native/verify/Makefile`.
2. Have a parity fixture under
   `plugins/plugin-local-inference/native/verify/fixtures/` (extended
   per R8 §5.2; see I8 verify-harness work).
3. Report 8/8 PASS on every supported backend (CPU / Metal / Vulkan /
   CUDA) when applicable to the kernel surface.

For new arches (Kokoro, eventually a dedicated speaker encoder), add a
`make load-smoke-<arch>` target before the publish gate accepts a
release that depends on that arch.

## Open questions tracked

1. **OmniVoice PolarQuant.** R6 §5.6 says polarquant *applies* to the
   Qwen3 LM head inside OmniVoice but no recipe is wired. Adding it
   requires either (a) extending `omnivoice-fuse/cmake-graft.mjs` to
   register `Q4_POLAR` recognition in OmniVoice's loader, or (b) running
   PolarQuant before omnivoice's `convert.py` step. Deferred until a
   measured TTS-MOS comparison justifies the recipe.
2. **OmniVoice QJL.** Conditional, deferred. Only matters for long-form
   (multi-chunk) synth where the cumulative MaskGIT cache becomes large.
   Not on Wave-2 critical path.
3. **ASR PolarQuant.** Same arch as eliza-1 LM (Qwen3) so the recipe is
   structurally compatible — needs a per-block-MSE measurement on the
   ASR text body Linear bank and an arch-allowlist entry in
   `polarquant_apply.py:_KNOWN_GOOD_ARCH_SUBSTRINGS`.
4. **Turn-detector PolarQuant.** Same as ASR — applies to the
   classifier's text body Linear bank but needs an EOT-F1 parity gate
   before shipping.
