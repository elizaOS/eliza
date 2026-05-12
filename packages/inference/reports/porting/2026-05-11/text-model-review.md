# Eliza-1 text-model review — 0_6b / 1_7b (2026-05-11)

Reviews and optimizes the text path for the two small Eliza-1 tiers as
they ship in the staged bundles at
`~/.eliza/local-inference/models/eliza-1-{0_6b,1_7b}.bundle`. Companion:
`text-vision-path.md` (vision backbone) and the raw data in
`packages/inference/verify/bench_results/text_model_2026-05-11.json`.

## Predecessor state

A predecessor agent on this same task was killed mid-run by an API rate
limit. It committed nothing for this task: no `text-vision-path.md` /
`text-model-review.md`, no `text_model_*.json`, no stash, and `b14e3cc70c`
("eliza-1: base-v1 release state") is a pre-existing history commit, not
its work. So everything here is from scratch.

## What the bundles actually contain

- **Text GGUF.** `0_6b` = Qwen3-0.6B at **Q3_K_M** (`general.file_type=12`,
  389 MiB, 751.6M params); `1_7b` = Qwen3-1.7B at **Q4_K_M**
  (`general.file_type=15`, 1.19 GiB, 2.03B params). Both arch `qwen3`, ctx
  metadata 40960 (Qwen3 native rope window); catalog `contextSize` 32768.
  These are the documented substitutes for the unpublished Qwen3.5-0.6B/1.7B.
  The `1_7b` "32k" and "64k" files are hardlinks to the same GGUF, and the
  manifest's recorded text `sha256` actually equals the drafter's dflash
  stamp — a staging-side sha bug, noted but out of scope.
- **One backbone, text-only.** Both tiers have no `vision/` dir and
  `manifest.files.vision: []` — text-only by design (AGENTS.md §2 tier
  matrix). `libmtmd` is in every llama.cpp build but unused on these tiers.
  See `text-vision-path.md` for the vision-tier (`9b`/`27b`) gap (mmproj
  is never threaded into the llama-server spawn).
- **DFlash drafter.** `dflash/drafter-{0_6b,1_7b}.gguf` carry a
  `dflash-draft.target_checkpoint_sha256` GGUF key but their architecture
  is plain `qwen3`, not `dflash-draft`. So they are *stamp-only* — the
  `0_6b` drafter is the same Q3_K_M Qwen3-0.6B weights as the target; the
  `1_7b` drafter is Qwen3-1.7B at Q3_K_M against a Q4_K_M target. They run
  as ordinary speculative draft models, not the DFlash arch path. (A real
  distilled drafter lands in v2 per `packages/training/AGENTS.md` §2.)
- **Quant sidecars** in each bundle's `quantization/` record the *intended*
  KV recipe (`turboquant.json`: K=`turbo4_0`, nbits 4; `qjl_config.json`:
  K 1-bit / V 4-bit, group 32; `polarquant_config.json`: V Polar Q4) but
  the GGUF weights are unchanged plain k-quants — here TBQ/QJL/Polar are
  *runtime KV-cache* compressors, not weight quants. `gguf_milady_apply`'s
  `q4_polar→q8_0` fallback only affects the (unused-here) weight-quant Polar
  path; the V-cache Polar kernel path is the separate, working one.

## Critical findings

1. **The mandated KV-cache quantization was never applied at runtime.**
   `dflash-server.start()` read `--cache-type-k/v` *only* from the
   `ELIZA_DFLASH_CACHE_TYPE_K/_V` env vars, and `CatalogModel.runtime.kvCache.typeK/typeV` (the field exists in the type) was never consumed on the
   llama-server path nor populated by `runtimeFor()`. Result: every Eliza-1
   tier ran an f16 KV cache by default, in violation of `packages/inference/AGENTS.md` §3 items 1–3 (TBQ K/V; QJL-K + Polar-V at ctx>8k). **Fixed**
   (see below).
2. **Spec-decode acceptance is high but only because the drafter == target.**
   `llama-speculative-simple` on `0_6b` with `--draft-min 2 --draft-max 6`:
   ~0.74–0.85 per-token acceptance, vs. ~0.57 at draft-max 4 and ~0.75 at
   draft-max 8 (over-drafting). `1_7b` at draft-max 6: ~0.63. Lookahead/ngram
   drafting at this model size is not competitive (<0.30 acceptance in the
   published `cpu_avxvnni` baselines) — keep `specType: "dflash"` with the
   catalog drafter. The catalog's `draftMin 2 / draftMax 6` for the small
   tiers is correct; do not raise draftMax (the 1.7B target makes each
   rejected round costly). When the real distilled drafter ships, acceptance
   will drop somewhat but the drafter gets much smaller/faster — net spec
   speedup should improve. No catalog change needed for spec-decode.
3. **Throughput (CPU, x86_64 AVX-VNNI, contention-degraded).** Measured
   under host load 25–116 (4–6 sibling builds + a fused-server smoke + a
   training bench running concurrently), so these are **lower bounds**:
   `0_6b` Q3_K_M — ~227 t/s pp512 / ~24 t/s tg128 at `-t 16` (and a
   thrash-degraded ~55/~6 at `-t 24`, which over-subscribes a 0.6B model);
   `1_7b` Q4_K_M — ~31 t/s pp512 / ~2.8 t/s tg128 at `-t 24` (badly
   load-hit; expect tens of t/s tg on an idle host at `-t 8..16`).
   **Vulkan (RTX 5080) and CUDA were not benched**: no `vulkan-headers` on
   this host (can't build `llama-bench -DGGML_VULKAN=ON`; the prebuilt
   `linux-x64-vulkan` `llama-cli` is offload-bound and timed out under
   load), and a fresh `-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=90` build
   was still grinding through the slow `ggml-cuda` `fattn-vec-instance-tbq*`
   template TUs when the session window closed. The fork *does* ship CUDA
   TBQ/QJL/Polar kernels, so a `-DGGML_CUDA_FUSED_ATTN_QJL=ON` build is the
   datapoint to capture on an idle NVIDIA host — that is the genuinely-new
   "CUDA now live" number this review owes and could not land.

## Changes implemented (catalog + runtime KV-cache wiring)

`packages/shared/src/local-inference/catalog.ts` — `runtimeFor()` now
emits `runtime.kvCache = { typeK: "qjl1_256", typeV: "q4_polar", requiresFork: "buun-llama-cpp" }` for every tier with ctx > 8k (all current
tiers), and `{ typeK: "turbo3_0", typeV: "turbo4_0", ... }` for the ≤8k
fallback. New `kvCacheForContext()` helper next to `requiredKernelsForContext()`.

`packages/app-core/src/services/local-inference/dflash-server.ts` —
`DflashServerPlan` gains `cacheTypeK?` / `cacheTypeV?`; `load(plan: BackendPlan)`
resolves them as `overrides.cacheTypeK ?? catalog.runtime.kvCache.typeK`
(per-load override wins) and passes them into `start()`; `start()` resolves
`ELIZA_DFLASH_CACHE_TYPE_K/_V` env override ?? `plan.cacheTypeK`, applies
`--cache-type-k/v`, and runs `assertCacheTypeSupportedOnBackend` on whichever
value wins with a source label (`ELIZA_DFLASH_CACHE_TYPE_K` vs
`runtime.kvCache.typeK`). So a build whose `CAPABILITIES.json` lacks the
QJL/Polar kernels now fails loudly instead of silently running f16 — matching
the AGENTS.md §3 "no silent fallback" rule.

`packages/app-core/src/services/local-inference/engine.ts` —
`resolveDflashPlanForPath()` threads `catalog.runtime.kvCache.typeK/typeV`
into the `DflashServerPlan` it builds. (The node-llama-cpp path already
honoured `overrides.cacheTypeK/V` via `experimentalKvCacheKeyType/ValueType`;
this closes the gap on the llama-server path.)

Precedence end-to-end: `ELIZA_DFLASH_CACHE_TYPE_K/_V` env > per-load
`overrides.cacheTypeK/V` (from `active-model.ts`) > catalog `runtime.kvCache.typeK/typeV`. The kernel-capability assertion fires on the winner.

## Verification

- `make -C packages/inference/verify kernel-contract reference-test` — green
  (`kernel-contract OK kernels=6 targets=21`; `gen_fixture --self-test` all
  finite, fused-attn + TBQ V-cache parity OK).
- `bunx tsc --noEmit -p packages/shared/tsconfig.json` — clean.
- `bunx tsc --noEmit -p packages/app-core/tsconfig.json` — the two
  pre-existing `vadSupported`/`vadOpen` errors in `engine.voice.test.ts` /
  `pipeline-impls.test.ts` (a sibling agent's WIP on the VAD FFI) remain;
  the changed files (`catalog.ts`, `dflash-server.ts`, `engine.ts`) are clean.
- `bun test` on `dflash-server.test.ts` (27 pass), `backend.test.ts` (22),
  `catalog.test.ts` (17), `active-model.test.ts` (22),
  `active-model.runtime.test.ts` (3), `packages/shared/src/local-inference/`
  — all green.

## What's left (follow-ups, not blocking)

- **Benchmark Vulkan + CUDA on an idle host.** Install `vulkan-headers` and
  build `llama-bench` with `-DGGML_VULKAN=ON` (Intel Arc/Xe) and
  `-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=90 -DGGML_CUDA_FUSED_ATTN_QJL=ON`
  (RTX 5080), then `llama-bench -m <text gguf> -ngl 99 -p 512 -n 128` on
  each. Record into `text_model_2026-05-11.json` (rows pre-stubbed).
- **Perplexity sweep.** `llama-perplexity -f wiki.test.raw` across
  {Q3_K_M, Q4_K_M, Q5_K_M, Q6_K} × {f16 KV, qjl1_256/q4_polar KV} on an
  idle host to confirm the size/quality knee. Expectation from the existing
  reference fixtures (TBQ/QJL/Polar per-block tolerances 0.05/0.05/0.001):
  the QJL-K + Polar-V cache is a near-free RAM win vs f16.
- **Vision-tier mmproj wiring** — see `text-vision-path.md`.
- **v2:** a real distilled DFlash drafter (and the `dflash-draft` arch path)
  for both small tiers, plus the text fine-tune.
