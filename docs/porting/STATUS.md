# On-device inference: status index

Last updated: 2026-05-10

Single-page index for the on-device inference porting docs. Open the linked
docs for detail; this page exists so you can find the right one without
re-reading all five.

## Doc set

| Doc | What it covers |
|---|---|
| [unified-fork-strategy.md](unified-fork-strategy.md) | Canonical `elizaOS/llama.cpp` fork strategy + branch layout (TBQ + QJL + PolarQuant + DFlash composed onto one tree). |
| [build-matrix.md](build-matrix.md) | Per-(platform, ABI, GPU) build commands + status. The compile/link/PASS truth table for the unified fork. |
| [on-device-quantization-porting-plan.md](on-device-quantization-porting-plan.md) | Original deliverable plan (A-J sections) + symbol-verified status. The "what we promised to ship" doc. |
| [dflash-drafter-strategy.md](dflash-drafter-strategy.md) | DFlash drafter pairing rationale + tokenizer-family rules. Subsection in the plan; kept separate for the table. |
| [benchmark-harness.md](benchmark-harness.md) | `profile-inference.mjs` reference: how to invoke it, how to read the output. |
| [CLEANUP-LEDGER.md](CLEANUP-LEDGER.md) | Post-Wave-3 audit ledger. What's resolved, what's still open, what's the production-quality gate. |

## Production-quality gate

Pulled verbatim from [CLEANUP-LEDGER.md §10](CLEANUP-LEDGER.md). These are the
HIGH must-haves still missing for the user's "production quality on local
inference" target. Every item is hardware-blocked and out of scope for a
cleanup-execute pass.

1. **Real-hardware GPU kernel validation.** `packages/inference/README.md`
   itself says "DRAFT — COMPILED ONLY ON LINUX, NOT VALIDATED ON GPU
   HARDWARE." Required: Apple Silicon `metal_verify` 8/8 PASS, real Intel/AMD
   Vulkan `vulkan_verify` PASS against CUDA-generated fixtures, NVIDIA
   real-GPU smoke (W3-D was compile-only).

2. **CUDA-generated fixtures.** `packages/inference/verify/gen_fixture` exists
   but the C-reference variant is what's checked in. F3 acceptance: regenerate
   from real CUDA build, commit, then any kernel "PASS" actually means CUDA
   parity.

3. **128k KV-cache offload measured end-to-end.** `contextLength: 131072` is
   set in catalog and threaded through `createContext`, but no bench output
   proves a 128k turn round-trips cleanly with KV offload (TBQ on V +
   QJL1_256 on K) on a single phone or desktop.

4. **Prompt-cache hit rate under load.**
   `__stress__/cache-100conv-stress` reports 89.91% / 99.90% warm-only at
   N=100, parallel=16 in vitest. A measurement under real concurrent agent
   load (multiple conversations, real prefill cost, real token throughput
   numbers) is missing — current data is synthetic.

5. **Embedding parity numbers across backends.** W2-H confirms
   `plugin-local-embedding` 3/3 e2e PASS on
   `nomic-embed-text-v1.5.Q5_K_M.gguf`, but cross-platform parity (AOSP
   arm64 NEON vs x86 AVX2 vs Apple Metal) has no committed numbers.
   Required: golden-vector cosine ≥ 0.9999 across all four backends.

6. **Speed/throughput on real hardware.** No tok/s numbers on real arm64
   device, no DFlash acceptance-rate measurements outside cache-stress
   synthetic. `qjl_bench.c:315` even comments "TODO: NEON throughput TBD".

7. **Benchmark CI green nightly.** `local-inference-bench.yml` workflow exists
   and is `actionlint`-clean per W2-H, but its status against develop nightly
   is unverified — no committed badge, no recent green run logged.

## Hardware-runner work outstanding

Each item in the gate above maps to a class of hardware runner not currently
wired to CI:

- **Apple Silicon (M-series):** Metal kernel verification (item 1, 2, 5),
  Apple-side speed numbers (item 6).
- **NVIDIA discrete GPU (>= sm80):** CUDA fixture generation (item 2), CUDA
  runtime smoke (item 1; W3-D was compile-only).
- **Real Intel/AMD GPU with native Vulkan driver:** `vulkan_verify` 8/8 PASS
  against the CUDA-generated fixtures (item 1) — the W3 lavapipe baseline is a
  software rasteriser, not a real driver.
- **Pixel arm64 (or equivalent Snapdragon/MediaTek):** NEON throughput
  measurements for QJL/TBQ (`qjl_bench.c:315`), end-to-end 128k KV offload
  test (item 3), DFlash acceptance-rate on-device (item 6).
- **Adreno or Mali GPU device:** mobile Vulkan kernel runtime PASS — paired
  with Pixel arm64 above to cover the "phone GPU" leg.

Until those runners exist (or one-off dev runs land in `reports/porting/`),
the on-device inference story stays at "compile-only validated on Linux x86 +
W3-D CUDA compile-only" — which is what `packages/inference/README.md`
already says, and what the production-quality gate is gating against.
