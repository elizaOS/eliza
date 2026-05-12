# Upstream rebase plan — `elizaOS/llama.cpp`

> The single page of record for "when do we rebase the fork onto a recent
> upstream `ggml-org/llama.cpp`, and what does that cost." Pairs with
> [`unified-fork-strategy.md`](./unified-fork-strategy.md) (which fixes the
> repo / branching scheme) and [`on-device-quantization-porting-plan.md`](./on-device-quantization-porting-plan.md)
> (per-technique deliverables). Read this before opening a rebase PR.

## TL;DR

- **Structured output is NOT blocked.** The fork at
  `elizaOS/llama.cpp @ v1.0.0-eliza` (commit `08032d57`, upstream base
  `b8198`, ~March 2026) **already carries** `grammar_lazy`, `json_schema`,
  `response_format`, and `prefill_assistant` in the split `tools/server/`
  files (`server-task.cpp` / `server-common.cpp` / `server-context.cpp` /
  `server-http.cpp`). The Eliza-1 structured-output path runs on the
  current pin — no rebase is required for it. Anything in older docs/comments
  saying "the fork must be rebased to get the structured-output features" or
  "the fork is based on old b8198 lacking grammar_lazy" is stale; it
  predates the `b8198`-based fork.
- **A rebase onto current upstream IS still a real, deferred effort** — a
  multi-engineer job with mandatory GPU + Metal hardware verification.
  It is *not* on the critical path for any shipping Eliza-1 feature. It is
  worth doing only when (a) there is a concrete upstream feature we want
  (e.g. a newer quant kernel, a server fix), and (b) GPU/Metal runners are
  available to re-verify the TurboQuant Q1_0 path on upstream's new block
  layout. A 2026-05-11 attempt confirmed the target tag (`b9113`), the
  exact replay command, and the conflict surface — it dies on the first
  replayed commit (the `Q1_0` slot collision) and the resolution is the
  kernel re-port below. See "Rebase attempt — 2026-05-11" near the bottom.
- The `v1.0.0-eliza` tag = the kernel-complete `v0.4.0-eliza`/`v0.2.0-eliza`
  lineage tree, re-tagged for the org rename. A real newer rebase produces a
  new `v1.x` tag.

## Why the rebase is hard: the `Q1_0` block collision

The fork composes TurboQuant onto a base where:

- the fork's `block_q1_0` uses `QK1_0 = 32` — the TurboQuant CUDA and Metal
  kernels (mmq / mmvq / vecdotq / the fused-attn path, plus the eliza-kernels
  `.metal` shaders) are written against the 32-element block;
- the fork's `block_q1_0_g128` (the 128-grouped variant) is approximately
  what upstream later shipped as its *new* `Q1_0`.

Upstream `b9106`+ redefined `block_q1_0` with `QK1_0 = 128`. So a rebase is
not a clean replay — it is a re-port:

1. **Re-port TurboQuant's Q1_0 path onto upstream's 128-block design** and
   re-verify it on real GPU hardware (CUDA and Metal). The TurboQuant
   `mmq`/`mmvq`/`vecdotq` kernels and the Metal shaders all assume the
   32-element layout; moving to 128 changes tiling, packing, and the
   dequant inner loop. Bit-exact parity vs the reference + a model-backed
   graph smoke is the acceptance bar — and that requires `nvcc` + an NVIDIA
   card and an Apple-Silicon Metal box, neither of which CI has on free
   runners (see `unified-fork-strategy.md` §G).
2. **Adapt to upstream's `ggml-metal` / `ggml-cuda` restructure.** Upstream
   has since split `ggml-metal.m` → `ggml-metal*.cpp` and reorganized the
   `ggml-cuda/` tree; the eliza kernels live under
   `ggml/src/ggml-metal/eliza-kernels/` and `ggml/src/ggml-cuda/{qjl,polarquant,turboquant,turbo-tcq}.cu(h)` and the fused-attn `.cu`, all of which have to be re-slotted into the
   new layout and re-wired into the dispatcher.

## Conflict surface (files that will fight you on rebase)

- `ggml/src/ggml-common.h`, `ggml/include/ggml.h` — the eliza quant-slot
  enums (`TBQ3_0=43`, `TBQ4_0=44`, `QJL1_256=46`, `Q4_POLAR=47`) **and** the
  `block_q1_0` / `block_q1_0_g128` definitions vs upstream's redefined
  `Q1_0`. This is the central collision.
- `ggml/src/ggml-quants.c`, `ggml/src/ggml-quants.h` — quantize/dequantize
  rows for every eliza type + the Q1_0 reference path.
- `ggml/src/ggml-cuda/{mmq,convert,vecdotq,mmvq,fattn*}.cu(h)` plus the
  eliza CUDA kernels (`qjl.cu`, `polarquant.cu`, `turboquant.cu`,
  `turbo-tcq.cu`, the fused-attn `.cu`).
- `ggml/src/ggml-metal/ggml-metal*.cpp` + `ggml/src/ggml-metal/ggml-metal.metal`
  and the `ggml-metal/eliza-kernels/*.metal` shaders + dispatcher entries.
- `gguf-py/gguf/constants.py` — the GGUF Python type table (`TBQ3_0`,
  `TBQ4_0`, `QJL1_256`, `Q4_POLAR`) the converter and the `gguf_eliza1_apply.py`
  shim grep for.
- `include/llama.h` — re-exported types + `llama_context_params` (the
  `flash_attn` bool → `flash_attn_type` enum drift bites the AOSP shim).
- `tools/quantize/quantize.cpp`, `src/llama-quant.cpp`,
  `src/llama-model-loader.cpp` — recognizing the new ftype names + loading
  the eliza block layouts.
- `tools/server/server-{task,common,context,http}.cpp` — the structured-output
  surface already ported once; an upstream rebase replays it against
  whatever upstream's server refactor looks like at that point. (Not a
  blocker — just more diff to reconcile.)

## When to do it

Trigger a rebase only when **both** are true:

1. There is a concrete upstream change we want pulled in (a quant kernel, a
   server fix, an MXFP4/NVFP4-class addition — see `unified-fork-strategy.md`
   §E item 1, the only "free on rebase" win), AND
2. GPU + Metal verification capacity exists (a `cuda-l4` / `rocm-gfx1100` /
   `apple-m3-pro` runner, or a developer with the hardware) to re-verify the
   TurboQuant Q1_0 path on the new 128-block layout before merge.

Until then the `b8198`-based pin is the right answer: it carries every
eliza kernel, DFlash spec-decode, and the structured-output server surface,
and it is hardware-verified at the levels recorded in
`packages/inference/README.md`.

## Sequencing (when it happens)

1. New branch off `eliza/main`; rebase onto the target upstream tag. Take
   the conflicts in the order of the surface list above (`ggml-common.h` /
   `ggml.h` first — resolving the `Q1_0` collision unblocks the rest).
2. Re-port TurboQuant Q1_0 (CPU first, then CUDA, then Metal) onto upstream's
   128-block layout. CPU parity (scalar + AVX2 + NEON) is the gate before
   touching GPU.
3. Re-slot the eliza CUDA + Metal kernels into upstream's restructured
   `ggml-cuda/` and `ggml-metal/` trees; re-wire the dispatcher.
4. Re-reconcile the structured-output server patch (or confirm upstream now
   carries it natively and drop our copy).
5. Run the full CI matrix from `unified-fork-strategy.md` §G **plus** the
   `kernel-verify-gpu` job. No green-GPU run, no merge.
6. Tag `v1.x` (the new kernel-complete rebased tree); bump
   `LLAMA_CPP_TAG`/`LLAMA_CPP_COMMIT`/`REF` in `build-llama-cpp-dflash.mjs`
   and `compile-libllama.mjs`, the `min_llama_cpp_tag` in the training
   manifest emitter, and `packages/inference/AGENTS.md` / this doc /
   `unified-fork-strategy.md`.

## Rebase attempt — 2026-05-11 (partial; aborted at conflict #1)

A rebase attempt was run to confirm the conflict surface and pick the target
tag. **Outcome: not completed — the work is exactly the multi-engineer,
GPU+Metal-gated re-port this doc describes.** The eliza repo's pin is unchanged
(`packages/inference/llama.cpp @ v1.0.0-eliza`, `.gitmodules` / `build-llama-cpp-dflash.mjs`
/ `compile-libllama.mjs` untouched).

What was established:

- **Target upstream tag: `b9113`** (`1ec7ba0c14f33f17e980daeeda5f35b225d41994`),
  the latest `bNNNN` upstream release tag at the time. It has the redefined
  `block_q1_0` with `QK1_0 = 128` and `GGML_TYPE_Q1_0 = 41` (slot 40 is now
  `GGML_TYPE_NVFP4`), plus `GGML_TYPE_COUNT = 42`.
- **Fork lineage to replay: `7f5ee549..elizaOS/llama.cpp@eliza/main` — 34
  commits, 8 of them merges** (`merge: TBQ`, `merge: QJL`, `merge: Q4_POLAR + QJL1_256`,
  `merge: Metal kernels`, `merge: DFlash`, `merge: W3-B fused CPU kernels`,
  `merge: W4-B CUDA kernels`, and one integration-branch fast-forward merge).
  `7f5ee549` ("ggml: fix ggml_is_contiguous_n for ne == 1 (#20092)") = the
  fork's upstream merge-base, also tagged `milady-v2026.05.09-base` on the fork
  (the doc's "b8198-area base"). So the rebase command is
  `git rebase --rebase-merges --onto b9113 7f5ee549 eliza/main`.
- **It conflicts immediately, on the very first replayed commit**
  `a1ae4dd13` ("ggml: add Q1_0 and Q1_0_g128 1-bit quantization support (CPU,
  Metal, CUDA)") — 28 conflicted files, 81 conflict regions, before any commit
  applies cleanly. The conflict is the `Q1_0` collision this doc names:
  - the fork's `a1ae4dd13` defines `block_q1_0` with `QK1_0 = 32` at slot 40
    *and* `block_q1_0_g128` with `QK1_0_g128 = 128` at slot 41;
  - upstream `b9113` already owns slot 40 (`NVFP4`) and slot 41 (`Q1_0`,
    `QK1_0 = 128` — which ≈ the fork's `block_q1_0_g128`).
  - Conflicted files: `ggml/include/ggml.h`, `ggml/src/ggml-common.h`,
    `ggml/src/ggml.c`, `ggml/src/ggml-quants.{c,h}`,
    `ggml/src/ggml-cpu/{quants.c,quants.h,ggml-cpu.c,ops.cpp}` +
    `ggml-cpu/arch/{arm,x86}/quants.c`,
    `ggml/src/ggml-cuda/{convert.cu,dequantize.cuh,ggml-cuda.cu,mmq.cu,mmq.cuh,mmvq.cu,vecdotq.cuh}`,
    `ggml/src/ggml-metal/{ggml-metal-device.cpp,ggml-metal-impl.h,ggml-metal-ops.cpp,ggml-metal.metal}`,
    `gguf-py/gguf/constants.py`, `include/llama.h`,
    `src/{llama-model-loader.cpp,llama-quant.cpp}`,
    `tests/test-quantize-fns.cpp`, `tools/quantize/quantize.cpp`. (This matches
    the "conflict surface" list above almost exactly.)

The resolution this implies (not yet done — it is the deferred work):

1. **Drop the fork's `block_q1_0_g128` / `GGML_TYPE_Q1_0_g128`.** Upstream's
   `GGML_TYPE_Q1_0` (slot 41, `QK1_0 = 128`) *is* that type — re-point every
   fork reference to `Q1_0_g128` / `block_q1_0_g128` at upstream's `Q1_0`.
2. **Rename the fork's 32-element block type to a non-colliding slot** (e.g.
   `GGML_TYPE_Q1_0_B32` / `block_q1_0_b32` at a free slot ≥ 48, after the
   eliza `TBQ3_0=43`/`TBQ4_0=44`/`QJL1_256=46`/`Q4_POLAR=47` slots — and bump
   `GGML_TYPE_COUNT` accordingly) and **re-point the TurboQuant CUDA + Metal +
   CPU kernels** (the mmq / mmvq / vecdotq / fused-attn paths + the
   `ggml-metal/eliza-kernels/*.metal` shaders) at the renamed type. Decision
   to make here: keep TBQ on the 32-element block under the renamed type (the
   smaller change, but keeps a 32-element 1-bit type forever) **or** migrate
   TBQ to upstream's 128-element `Q1_0` layout (the more-correct, bigger
   change — re-tiles/re-packs the CUDA mmq/mmvq and the Metal threadgroup
   shapes). Either way, **bit-exact parity vs the reference + a model-backed
   graph smoke on real CUDA *and* real Apple-Silicon Metal is the acceptance
   bar** — CI has neither on free runners (`unified-fork-strategy.md` §G).
3. **Then** replay the remaining 33 commits (TBQ → QJL → Q4_POLAR/QJL1_256 →
   Metal → DFlash → W3-B fused CPU → W4-B CUDA) on top of the resolved base.
   Several of these touch `block_q1_0` directly and will need follow-on
   resolution once step 2's rename lands.
4. Re-reconcile the structured-output server patch (or confirm `b9113`'s
   `tools/server/` now carries it natively and drop the fork copy — `b9113` is
   post-server-refactor, so it very likely does).
5. Adapt to upstream's `ggml-metal` restructure: `b9113` has
   `ggml-metal-{device,impl,ops}.cpp` + `ggml-metal.metal` (the `.m` → `.cpp`
   split is already done in the fork's base too, but the file shapes drifted).
   Re-slot the `ggml-metal/eliza-kernels/*.metal` shaders + dispatcher
   entries.
6. Run the full CI matrix (`unified-fork-strategy.md` §G) **plus**
   `kernel-verify-gpu`. No green-GPU + green-Metal run, no merge. Then tag
   `v1.1.0-eliza` and bump `LLAMA_CPP_TAG`/`REF`/`MIN_COMMIT` in
   `build-llama-cpp-dflash.mjs` + `compile-libllama.mjs`, the
   `min_llama_cpp_tag` in the training manifest emitter, and the docs.

**Bottom line:** the rebase is mechanically straightforward to *start*
(`git rebase --rebase-merges --onto b9113 7f5ee549 eliza/main`) and the target
tag is settled, but step 2 — the Q1_0 slot rename + the TurboQuant kernel
re-port — is the real cost, and it cannot be merged without GPU + Apple-Silicon
Metal hardware verification. Until that capacity exists, `v1.0.0-eliza` stays
the pinned working tree (it carries every eliza kernel, DFlash, and the
structured-output server surface, and is hardware-verified at the levels in
`packages/inference/README.md`).

## See also

- [`unified-fork-strategy.md`](./unified-fork-strategy.md) §A (current
  state), §G (CI strategy), §H (migration order).
- [`on-device-quantization-porting-plan.md`](./on-device-quantization-porting-plan.md)
  — per-technique × per-platform status.
- [`packages/inference/AGENTS.md`](../../packages/inference/AGENTS.md) — the
  inference contract; the fork-source paragraph points here.
- [`packages/inference/README.md`](../../packages/inference/README.md) —
  the hardware-verification matrix that gates any kernel claim.
