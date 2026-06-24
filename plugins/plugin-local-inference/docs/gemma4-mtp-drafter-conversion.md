# Gemma 4 MTP drafter — sourcing, conversion, and validation runbook

AGENTS.md §1/§3 require MTP (multi-token-prediction speculative decoding) on
**every** eliza-1 tier, and the cutover (#9033) made it **separate-drafter**:
each tier ships `mtp/drafter-<tier>.gguf`, loaded by the fused runner as
`-md mtp/drafter-<tier>.gguf --spec-type draft-mtp`. The manifest validator
(PR #9172) now *enforces* this — a strict/`defaultEligible` release with no
bundled drafter fails with `MTP drafter not bundled`.

This doc closes the gap behind the candidate bundle's `mtp/MISSING.txt`: where
the drafter actually comes from, how to convert it, and how to validate it.

## Why the drafter was "missing"

Google trained **all** Gemma 4 variants with MTP heads for built-in speculative
decoding, then deliberately **stripped them from the public HuggingFace
release** (see `google/gemma-4-E4B-it` discussion #5), retaining them only in the
on-device **LiteRT/TFLite** format. So there is no `safetensors` MTP head in the
upstream HF repos — it has to be extracted from the LiteRT bundle.

## The drafter source (found 2026-06-23)

| Item | Value |
|---|---|
| Extracted weights | **`SeatownSin/gemma-4-E4B-mtp-drafter`** → `mtp_drafter.safetensors` (the first public extraction of Gemma 4's MTP drafter from LiteRT) |
| Raw LiteRT source | `shadowlilac/gemma-4-e4b-mtp-extraction-effort` → `Section11_TFLiteModel_tf_lite_mtp_drafter.tflite` |
| Extraction toolkit | `SeatownSin/.../extract_mtp_from_litertlm.py` + `convert_with_prebuilt_mapping.py` + `gemma4_litert_mtp/inferred_mtp_drafter_{config,mapping}.json` |
| Shape | **42 tensors, 77M params, F32**, verified (matches the repo's "42/42 tensors") |
| Architecture | 4-layer one-step recurrent cell. Input = `concat(token_embedding, projected_activation)` `[5120]` → pre-projection `[5120→256]` → 4 blocks (256 hidden, 2048 intermediate, GeGLU). Blocks 0-2: sliding attention (window 512, head_dim 256, 4Q/2KV); block 3: full attention, head_dim 512. Vocab 262144 (shared gemma4 tokenizer). |
| Acceptance ceiling | **35% step-0 top-1 (greedy), ~80% top-5 overlap.** This is the irreversible quantization-noise ceiling of the mobile INT4/INT8 weights — not a conversion bug. Good enough for tree/parallel verification; a from-scratch EAGLE3 head trained on full BF16 activations would beat it. |

The extracted weights are **staged** in the local model cache for the 2b
candidate:

```
~/.local/state/eliza/models/candidates/gemma-2b-base-v1/mtp/
  mtp_drafter.safetensors        # 312 MB F32, 42 tensors
  mtp_drafter_config.json        # inferred drafter config (block dims/windows/banks)
```

## Conversion pipeline (the remaining eliza-internal step)

The drafter is **not** a standalone model — it is an MTP cell that consumes the
base model's projected hidden activation. So it cannot be driven by vanilla
`llama-speculative -md`; it needs the eliza fork's `mtp-draft` GGUF arch and the
fused runner's `--spec-type draft-mtp` path (which feeds the base activation into
the drafter). The public llama.cpp fork checkout (`main-b10024`) does **not**
carry the `mtp-draft` arch — it is in the eliza fused-engine patch set built by
`native/build-llama-cpp-mtp.mjs` (no `darwin-arm64-metal-fused` target exists in
this tree yet; today only the iOS fused targets build).

Steps to produce `mtp/drafter-2b.gguf`:

1. **Get the weights** (done): download `mtp_drafter.safetensors` from
   `SeatownSin/gemma-4-E4B-mtp-drafter` (or run `convert_with_prebuilt_mapping.py
   --tflite Section11_..._mtp_drafter.tflite --int4-order low_first` against the
   `shadowlilac` LiteRT source; needs `tflite`/`tensorflow` + `torch` +
   `safetensors`).
2. **Write the `mtp-draft` GGUF**: map the 42 drafter tensors onto the eliza
   `mtp-draft` arch GGUF tensor schema (pre-projection, per-block attn/MLP, the
   per-block head_dim 256/256/256/512 + memory-bank ids `[0,0,0,1]` + attention
   windows `[512,512,512,null]` from `mtp_drafter_config.json`). This converter
   lives with the fused-engine patch set, not the vanilla fork.
3. **Stage + manifest**: place at `bundles/<tier>/mtp/drafter-<tier>.gguf`; set
   the manifest's `files.mtp = [{ path: "mtp/drafter-<tier>.gguf", sha256 }]`,
   `lineage.drafter` (base `SeatownSin/gemma-4-E4B-mtp-drafter`, license
   `gemma`), and top-level `mtp: "separate-drafter"`. The validator (PR #9172)
   then accepts the bundle as release-shaped.
4. **Validate on Metal**: build the `darwin-arm64-metal-fused` engine (add the
   target to `build-llama-cpp-mtp.mjs`), then run the §8 text+MTP gate —
   `--spec-type draft-mtp -md mtp/drafter-2b.gguf` against
   `text/eliza-1-2b-128k.gguf` — and record acceptance-rate + speedup. The text
   base itself is already Metal-verified (gemma-4-E2B, head_dim 512, FA enabled,
   pp512 636 / tg128 23 t/s — see `native/verify/PLATFORM_MATRIX.md`).

## Status

- **Code (PR #9172): done.** The catalog, schema, validator, runtime
  (`active-model.ts` resolves `draftModelPath`; `ffi-streaming-backend.ts` runs
  `--spec-type draft-mtp`) all model + require separate-drafter MTP. A bundle
  without the drafter is rejected instead of silently shipping MTP-less.
- **Artifact: weights sourced + staged** (this doc). Remaining: the
  `safetensors → mtp-draft GGUF` conversion (eliza fused-engine tooling) and the
  `darwin-arm64-metal-fused` build for the on-Metal text+MTP gate. Both are
  publish/fused-engine tasks, not blocked by the manifest contract.
- **Metal speculative mechanism: verified (2026-06-23).** The fork's
  `llama-speculative -m <gemma-4-E2B> -md <gemma-4-E2B> -ngl 99 -fa on
  --spec-draft-n-max 4` runs the `gemma4` arch end-to-end on M4 Max Metal —
  correct output ("Red, Yellow, Blue"), draft+verify loop active
  (`n_drafted=12 n_accept=12`, 100% on a self-draft as expected), encode 280 t/s
  / decode 81 t/s with Flash Attention on. So the Metal speculative-decode
  *mechanism* (draft model + `-md` + verification) is proven for gemma4; the
  only missing pieces are the `mtp-draft` GGUF and the fused `--spec-type
  draft-mtp` activation that feeds the base activation into this 78M cell.

## Fused engine (`libelizainference`) — built + validated on Metal (2026-06-23)

The canonical fused FFI engine now builds and runs the Gemma-4 text path on a
real Apple M4 Max (records:
`native/verify/evidence/platform/darwin-arm64-metal-fused-llm.log`):

- **Build:** `cmake -DGGML_METAL=ON -DLLAMA_BUILD_OMNIVOICE=ON
  -DOMNIVOICE_SHARED=ON --target elizainference` →
  `libelizainference.dylib` (ABI v12). `build-llama-cpp-mtp.mjs` only has iOS
  targets today; this was a direct host cmake build. **Build blocker fixed:** the
  ABI guard `static_assert(sizeof(eliza_llm_stream_config_t) == 80)` in
  `tools/omnivoice/src/eliza-inference-ffi.cpp` was stale — ABI v9 appended
  `context_size` (int32 at offset 80) so the real size is **88**, and the TS
  marshaller (`ffi-bindings.ts`) was already at 88; only the C assert had not
  been bumped. One-line fix (`== 80` → `== 88`) — belongs upstream in
  `elizaOS/llama.cpp` (the fork submodule).
- **Capability probes:** `eliza_inference_abi_version` = `12`,
  `_llm_mtp_supported()` = **1**, `_llm_kv_quant_supported()` = **1** — this
  build wires MTP speculative decoding and KV-cache quant.
- **Text generation:** `eliza_inference_create(<2b candidate bundle>)` →
  `_llm_stream_open` → `_tokenize`/`_prefill` → `_llm_stream_next` produced
  **"The capital of France is Paris."** on the real `google/gemma-4-E2B`
  (loader: `gemma4` arch, 35 blocks, 128k ctx, PLE), **15 tokens in 180 ms ≈
  83 tok/s**, on M4 Max Metal. (MTP drafted/accepted = 0 — no drafter attached,
  see below.)

So the **whole on-Metal text + MTP-capable runtime is proven**; the single
remaining gap is the trained drafter artifact.

## The drafter is training-gated (definitive)

`packages/training/reports/dflash-drafter-produce-2026-05-14.md` is explicit: the
DFlash drafter is a **distilled student** (`distill_dflash_drafter.py`), and
distillation is *"fail-closed on a missing `--target-checkpoint`"* — there is no
SFT'd target text checkpoint in the repo, and production runs on an **H200**.
The milady `dflash-draft` GGUF arch (`src/models/dflash-draft.cpp`,
`xxxm1r0xxx/gemma-4-dflash-draft` is its config stub with no weights) computes
K/V from the token stream and cross-attends to the target hidden via
`dflash_fc`/`wk`/`wv` — a **different architecture** from the Google LiteRT
extraction (`SeatownSin/...`, which has only `q_proj`/`o_proj` per block and
fuses token+activation in one `pre_proj`), so the extraction's weights cannot be
loaded into the milady arch. Producing a loadable drafter therefore requires
either (a) running `distill_dflash_drafter.py` against an SFT'd Gemma-4 target on
an H200, or (b) the **EAGLE3 head** path (`LLM_ARCH_EAGLE3` in the fork;
develop's manifest schema already accepts an `eagle3` block referencing
`RedHatAI/gemma-4-E2B-EAGLE3-head`). EAGLE3 is forward-looking, not yet runnable:
the referenced head is **not published** (placeholder id, 404 on HF) and the fork
explicitly logs *"--spec-type=draft-eagle3 is not yet implemented in this build"*
(`common/speculative.cpp`). So today every drafter path — DFlash distillation,
the Google LiteRT extraction, and EAGLE3 — is either training- or publish-gated.
None is blocked by the runtime, which is fully built and Metal-validated above.

## A published Gemma-4-E2B MTP drafter DOES exist (2026-06-23 update)

Correcting the section above: a real, ready-to-use Gemma-4-E2B MTP drafter is on
HuggingFace — **no H200 training required**. It is the official MTP head Google
ships with `google/gemma-4-E2B-it-assistant`, converted to GGUF:

| Item | Value |
|---|---|
| GGUF | `amaranus/Gemma-4-E2B-it-qat-assistant-MTP-Q8_0-GGUF` (mirror `NicklausCairns/...`) — **93 MB**, 49 tensors, Q8_0 QAT |
| LiteRT mirrors | `metricspace/gemma4-E2B-it-litert-128k-mtp`, `MichaelWelsch/gemma-4-E2B-it-litert-community-128k-mtp` |
| Base | `google/gemma-4-E2B-it-assistant`, apache-2.0 |
| Arch | `gemma4-assistant`: 4-block drafter, `embedding_length 256`, head_count 4 / kv 1, `key_length 512`(global)/`256`(swa), SWA window 512, pattern `[T,T,T,F]`, `nextn_predict_layers 4`, `embedding_length_out 1536` (the E2B hidden). Tokenizer `gemma4`, vocab 262144 — **matches gemma-4-E2B**. |
| Tensors | per block `attn_norm / attn_q(+q_norm) / attn_output / ffn_{norm,gate,up,down} / post_attention_norm / post_ffw_norm / layer_output_scale`; top-level `token_embd`, `output_norm`, `nextn.pre_projection [3072,256]`, `nextn.post_projection [256,1536]`. (Q+O attention only; distinct from milady `dflash-draft`, which uses `wk`/`wv` + `dflash_fc`.) |

**The only gap is fork arch support.** The fork (`v1.2.0-eliza`) does not yet
recognize `gemma4-assistant` (`grep` empty in `src/`). Running this drafter needs
that arch ported in — either (1) **rebase/cherry-pick** the upstream llama.cpp
gemma-4-MTP / `gemma4-assistant` support onto the fork (the AGENTS.md "rebase onto
recent upstream" follow-up), then load + drive via `--spec-type draft-mtp`; or
(2) add `LLM_ARCH_GEMMA4_ASSISTANT` directly — the hparams + 49-tensor schema +
the `nextn.pre/post_projection` head are fully specified by the GGUF above; reuse
the `gemma4` block graph + a NextN projection.

This replaces the H200 path: the trained weights already exist (Google's, QAT'd),
so the remaining work is bounded **C++ arch support in the fork**, not training.
The `mtp: "separate-drafter"` manifest + `mtp/drafter-<tier>.gguf` contract (PR
#9172) stays as-is; this GGUF becomes `mtp/drafter-2b.gguf` once the arch loads.
Staged locally at `~/.local/state/eliza/models/drafts/gemma-4-E2B-mtp-amaranus.gguf`.

