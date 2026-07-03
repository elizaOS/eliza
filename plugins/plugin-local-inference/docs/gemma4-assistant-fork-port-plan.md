# Porting `gemma4-assistant` (the Gemma-4 MTP drafter arch) into the elizaOS llama.cpp fork

> **UPDATE 2026-06-23 — DONE (the additive port worked).** The targeted port was
> completed and validated in the fork, *without* a full rebase. The `mem_other` /
> `share` / `ctx_other` infra is additive (every existing arch passes null), so the
> custom KV kernels are untouched. Fork PR **elizaOS/llama.cpp#32** (branch
> `feat/gemma4-assistant-arch`, 22 files +419/-26), eliza gitlink bump **eliza
> #9268**. Validated on M4 Max Metal: loads `gemma4-assistant` cleanly, correct
> output, ~41-49% draft acceptance, **~1.1x decode speedup** (evidence:
> `native/verify/evidence/platform/gemma4-assistant-fork-draft-mtp.log`). Three
> fork-side MTP correctness bugs were fixed in the process (hidden-state row
> sizing by n_embd vs n_embd_out; the target gemma4 graph never exposed its
> post-norm hidden — `res->t_h_pre_norm = cur` took acceptance 8%->41%; the
> `swa_full` override oversized the shared SWA draft cache). The rest of this doc
> is the original pre-port plan, kept for reference.


**Historical status (before the fork port):** the drafter was validated working
on upstream and the fork integration was scoped here. This document is retained
as the concrete porting plan and rationale; the update above records the current
post-port status.

## What's proven

`amaranus/Gemma-4-E2B-it-qat-assistant-MTP-Q8_0` (Google's official `gemma-4-E2B-
it-assistant` MTP head, arch `gemma4-assistant`, gemma-4 vocab, `nextn_predict_
layers=4`) runs end-to-end via **upstream** `ggml-org/llama.cpp` (b1-ac4105d):

```
llama-cli -m <eliza-1 gemma-4-E2B> -md <amaranus> -fa on --spec-type draft-mtp
  baseline 105.5 t/s → draft-mtp 136.2 t/s  =  1.29× on Apple M4 Max Metal
```

So the runtime + the drafter existed before the fork port; the only gap at that
point was bringing the arch into the fork. **No H200, no distillation** was
needed for a working drafter (a bigger, uniform all-tier speedup is a separate
optimization — see the drafter runbook).

## Original risk assessment: why this looked rebase-class

The arch *model* (`src/models/gemma4-assistant.cpp`, 204 lines) ports cleanly —
the fork's `llm_graph` API (`build_attn_inp_kv_iswa`, `build_attn`, `build_ffn`,
`build_norm`, `build_lora_mm`, `llm_graph_input_embd`) is byte-identical, and
`src/models/gemma4.cpp` is the naming template (`swa_layers`, `hparams.n_layer`,
`nextn_predict_layers`).

**The blocker is the draft↔target linkage.** gemma4-assistant's graph reaches
into the *target* context for the target's `tok_embd` and shares the target's
KV cache:

```cpp
const auto * model_other = llama_get_model(cparams.ctx_other);   // line 112
ggml_tensor * x = ggml_get_rows(ctx0, model_other->tok_embd, inp_tokens);
```

This required the upstream **`ctx_other` + shared-KV (`mem_other`/`share`)**
infrastructure, which the fork (`v1.2.0-eliza`) did **not** have:

- `llama_kv_cache_iswa` ctor: fork lacks the `mem_other` + `layer_share_cb share`
  params (upstream `src/llama-kv-cache-iswa.h`).
- `llama_memory_params`: fork lacks `mem_other` (`src/llama-memory.h`).
- `llama_cparams` / `llama_context_params`: fork lacks `ctx_other`.
- The `share` callback is consumed in the **KV-cache core**
  (`src/llama-kv-cache.cpp:191` `const int32_t il_share = share(il);`) — the
  per-layer KV mapping. The fork's KV cache carries the **custom TurboQuant / QJL
  / PolarQuant kernels**; merging upstream's KV-sharing into it is the same
  conflict-prone work AGENTS.md flags for the rebase.

Surface: **13 upstream files** touch `mem_other` / `ctx_other` / `layer_share_cb`
(`llama-kv-cache.{h,cpp}`, `llama-kv-cache-iswa.{h,cpp}`, `llama-memory.h`,
`llama-cparams.h`, `llama-context.cpp`, `include/llama.h`, `llama-ext.h`,
`llama-model.cpp`, `common/speculative.cpp`, `models/eagle3.cpp`,
`models/gemma4-assistant.cpp`).

## Original recommended path: the upstream rebase

The clean integration is the AGENTS.md-deferred **rebase of the fork onto recent
upstream**, which reconciles the KV-cache divergence holistically and brings
`gemma4-assistant` + `eagle3` + other gemma-4 fixes wholesale. The conflict-prone
files remain the quant-slot enums (`ggml-common.h`/`ggml.h`) and the `Q1_0`
block layout, plus the KV-cache-sharing reconciliation above.

## Alternative: targeted port (only if the rebase is deferred further)

If a surgical port is taken instead, the **complete file-by-file spec** is below.
The additive parts are safe; the KV-core parts (★) are the risk.

### Additive (low risk)
1. `src/llama-arch.h`: add `LLM_ARCH_GEMMA4_ASSISTANT`; tensor enums
   `LLM_TENSOR_NEXTN_PROJ_PRE`, `LLM_TENSOR_NEXTN_PROJ_POST`,
   `LLM_TENSOR_MASKED_EMBD_CENTROIDS`, `LLM_TENSOR_MASKED_EMBD_ORDERING`.
   (All needed KV enums + `LLM_TENSOR_LAYER_OUT_SCALE`/`ROPE_FREQS` already exist.)
2. `src/llama-arch.cpp`: arch-name `"gemma4-assistant"`; the 4 tensor-name +
   4 `LLM_TENSOR_INFOS` entries (`nextn.pre_projection`→`{LAYER_REPEATING,
   MUL_MAT}`, `nextn.post_projection`→`{LAYER_OUTPUT, MUL_MAT}`, the two
   masked-embd → `{LAYER_INPUT, NONE}`).
3. `src/llama-hparams.h`: add `uint32_t n_embd_inp_impl = 0;`. `.cpp`: make
   `n_embd_inp()` honor it (`if (n_embd_inp_impl > 0) return n_embd_inp_impl;`).
   (`n_embd_out_impl`, `*_swa`, `swa_layers`, `nextn_predict_layers`,
   `f_attention_scale`, `n_swa`, `rope_freq_base_train_swa` already exist.)
4. `src/models/models.h`: add the `llama_model_gemma4_assistant` struct decl
   (verbatim from upstream `models.h`).
5. `src/llama-model.h`: add `nextn_proj_pre`/`nextn_proj_post` model fields.
   (Layer fields `out_scale`, `rope_freqs`, attn/ffn norms all exist.)
6. `src/llama-graph.h`: add `ggml_tensor * t_h_nextn = nullptr;` +
   `get_h_nextn()`; add `const int64_t n_layer_nextn;` member to
   `llm_graph_context` (init from `hparams.nextn_predict_layers`) — or inline.
7. `src/models/gemma4-assistant.cpp`: NEW; copy upstream with fork-naming subs
   (`is_swa_impl`→`swa_layers`, `n_layer()`→`n_layer`, `n_layer_nextn`→graph
   member or `(int)hparams.nextn_predict_layers`; drop the `== n_layer_all`
   assert). Mark `res->t_h_nextn` as a graph output (`ggml_set_output`).
8. `src/CMakeLists.txt`: add `models/gemma4-assistant.cpp`.
9. `src/llama-model.cpp`: add the factory `case` (`new
   llama_model_gemma4_assistant`) + the rope-type `case` (NEOX fall-through).

### KV-core + ctx_other (★ the risky reconciliation)
10. `src/llama-cparams.h` + `include/llama.h` + `src/llama-context.cpp`: add
    `ctx_other` (params → cparams), `llama_get_ctx_other`, and the ctor init
    (throw if null for `GEMMA4_ASSISTANT`), default-params init.
11. `src/llama-memory.h`: add `mem_other` to `llama_memory_params`.
12. `src/llama-kv-cache-iswa.{h,cpp}` + `src/llama-kv-cache.{h,cpp}`: add the
    `mem_other` + `layer_share_cb share` params and the `il_share = share(il)`
    per-layer mapping — **reconciled with the fork's custom KV kernels**. This
    is the rebase-class work.
13. `src/llama-model.cpp` `create_memory`: add the `GEMMA4_ASSISTANT` share
    lambda + `llama_kv_cache_iswa(... mem_other, filter, reuse, share)` block
    (verbatim from upstream, adapted to the fork ctor once #12 lands).
14. The fork's draft-context creation (the caller of `common_speculative` for
    `--spec-type draft-mtp`): set `cparams.ctx_other = ctx_tgt` (upstream does
    this in `tools/server/server-context.cpp:1217,1240`).

## References

- Upstream model: `/tmp/upstream-llama/src/models/gemma4-assistant.cpp`
- Upstream class decl: upstream `src/models/models.h` (`llama_model_gemma4_assistant`)
- Upstream KV-share core: upstream `src/llama-kv-cache.cpp:191`
- Upstream host linkage: upstream `tools/server/server-context.cpp:1217,1240`
- Fork naming template: `src/models/gemma4.cpp`; existing drafter arch: `src/models/dflash-draft.cpp`
- Drafter validation: `native/verify/evidence/platform/amaranus-draft-mtp-metal.log`
