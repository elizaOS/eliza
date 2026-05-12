# Eliza-1 voice swarm — wave plan (historical record)

> **STATUS: COMPLETE** — this swarm (Waves 1+2, W1–W13, plus the WF1–WF4
> follow-ups and the consolidation pass) landed on `develop` 2026-05. Retained
> as a historical record of the wave plan; the durable "current state" facts
> have moved to [`packages/inference/AGENTS.md`](packages/inference/AGENTS.md)
> and [`ELIZA_1_RELEASE_ASSET_STATUS.md`](ELIZA_1_RELEASE_ASSET_STATUS.md). This
> file is not an active plan — it does not list current blockers; for those see
> [`packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md`](packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md)
> and [`packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md`](packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md).

## What shipped

- **The fork is in-tree.** `elizaOS/llama.cpp @ v1.0.0-eliza` (upstream base
  `b8198`) ships as a git submodule at `packages/inference/llama.cpp`; `bun
  install` initializes it. It carries TurboQuant (`turbo3`/`turbo4`/`turbo3_tcq`),
  QJL (`block_qjl1_256`, `GGML_OP_ATTN_SCORE_QJL`, `GGML_OP_FUSED_ATTN_QJL_TBQ`),
  PolarQuant (`block_q4_polar`), the Metal/Vulkan/CUDA kernels, DFlash
  spec-decode (`--spec-type dflash`, the `dflash-draft` GGUF arch), and the
  post-refactor `llama-server` (`server-{task,common,context,http}.cpp` with
  `grammar_lazy` / `json_schema` / `response_format` / `prefill_assistant` —
  structured output is present; a rebase onto current upstream is a separate
  deferred effort, see [`docs/porting/upstream-rebase-plan.md`](docs/porting/upstream-rebase-plan.md)).
- **Kernels are real, not decorative.** The Metal and Vulkan kernel patch hooks
  do real work (stage the verified standalone shaders into the fork, patch the
  metallib `add_custom_command` / the Vulkan shader-gen + pipeline-creation, add
  op-level dispatch); they run unconditionally on every matching target. The old
  `ELIZA_DFLASH_PATCH_*` env knobs were decorative log toggles and were removed.
  Metal graph dispatch is runtime-ready for all five kernel families on Apple
  Silicon; Vulkan graph dispatch is runtime-ready on Intel-ANV; the C references
  + fixtures are clean (`make -C packages/inference/verify reference-test kernel-contract`).
- **Fused voice runtime.** macOS `libelizainference.dylib` builds, symbol-verifies,
  and does real GGUF-backed TTS + ASR in one fused process; the `*-fused`
  `llama-server` serves `POST /v1/audio/speech` in the same process as
  `/completion` + `/v1/chat/completions` + the DFlash spec loop, and
  `dflash-server.ts` prefers spawning that fused binary over the stock +
  `llama-omnivoice-server` two-process path.
- **Text-side precache.** Stable-prefix KV pre-warm on `conv:<roomId>` and
  `conv:__system_prefix__`, keep-alive re-warm, structural invalidation — see
  [`packages/inference/PRECACHE.md`](packages/inference/PRECACHE.md).
- **Voice loop.** Phrase chunker, phrase cache (LRU-bounded), VAD-gated mic fan
  to ASR / openWakeWord, DFlash↔TTS rollback coupling, barge-in cancellation,
  voice on/off lazy regional loading from one bundle.
- **Release pipeline.** Quant recipes, the converter wrapper
  (`gguf_milady_apply.py`, `--release-state base-v1`), the DFlash distiller, the
  bundle stagers, the manifest builder, the platform-plan generator, the publish
  orchestrator (gates on `releaseState ∈ {base-v1, upload-candidate, final}` +
  the `final.*` flags + `finetuned=false` + the `sourceModels` map), the §7
  device-side downloader contract, and the platform/kernel/iOS evidence
  scaffolding. Local release-shaped bundles exist for all five tiers for
  runtime-layout smoke (placeholder/substitute bytes — the real fork-built
  `base-v1` bytes + on-hardware evidence are the remaining release work).
- **Naming.** The fork repo is `elizaOS/llama.cpp` and the build cache dir is
  `~/.cache/eliza-dflash/eliza-llama-cpp` (the primary source is the in-tree
  `packages/inference/llama.cpp` submodule); HF bundles publish under
  `elizaos/eliza-1-*`; `elizaOS` (lowercase-O) in prose; user-facing strings
  say `Eliza-1`.

## Wave plan (as executed)

The swarm ran in two waves of parallel workers (W1–W13) plus a follow-up batch
(WF1–WF4) and a consolidation pass:

- **Wave 1 — fork + kernels (W1-A…W1-E, etc.):** QJL / Polar / TurboQuant block
  layouts and CUDA kernels into the fork; the Metal/Vulkan shader ports + verify
  harness; the DFlash CLI surface; the `llama-server` structured-output +
  verifier-reject-span patches.
- **Wave 2 — runtime + voice (W3, W4, W7, W9, W11, W13, etc.):** the fused
  `libelizainference` ABI; `dflash-server.ts` spawn selection + the fused
  `/v1/audio/speech` route; the precache mechanism (I1–I5 / C1); the voice
  scheduler / phrase chunker / phrase cache / barge-in; the DFlash manifest slot
  + acceptance bench; the speaker preset cache.
- **Follow-ups (WF1–WF4):** WF1 submoduled the fork in-tree; WF2 tightened the
  build's kernel-completeness gate; WF3 dropped the Intel-Mac (`darwin-x64-metal`)
  build/release target; WF4 wired the `base-v1` release pipeline (upstream base
  models, GGUF, not fine-tuned) — including `eliza1_platform_plan.py`'s
  `release_status_blockers()`.
- **Consolidation pass:** deduplicated and re-coheres the `ELIZA_1_*` /
  `RELEASE_V1.md` / porting-report doc set; this file is part of that pass.
