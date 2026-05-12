# Eliza on-device inference — CURRENT STATE

> **Single-page consolidated status** of the Eliza on-device inference
> porting effort. Authoritative as of **2026-05-09 (Wave-4 D)**.
> Replaces the cross-document hunt across baseline / unified / w2 / w3
> reports — those still exist as detailed evidence under
> [`reports/porting/`](../../reports/porting/) but this page is where
> "where are we" lives.
>
> Companion docs (read these for depth, not for status):
> - [`docs/porting/unified-fork-strategy.md`](./unified-fork-strategy.md) — fork branching scheme, per-technique table.
> - [`docs/porting/build-matrix.md`](./build-matrix.md) — per-cell measured table.
> - [`docs/porting/on-device-quantization-porting-plan.md`](./on-device-quantization-porting-plan.md) — per-technique deliverable order.
> - [`docs/porting/dflash-drafter-strategy.md`](./dflash-drafter-strategy.md) — DFlash drafter pairing.
> - [`docs/porting/benchmark-harness.md`](./benchmark-harness.md) — `profile-inference.mjs` contract.

## Top-line

| Bucket | What's in it |
|---|---|
| **Production-ready** | Linux x64 CPU baseline; arm64-v8a NEON musl cross (kernel parity proven under QEMU); Windows x64 CPU mingw cross (PE32+ exports verified); embedding plugin E2E; cache + cache-stress; bench harness against stub. |
| **Research / not on hardware** | Linux x64 CUDA (compiles clean, no GPU runtime); Linux x64 Vulkan turbo* (compiles clean, runtime parity 0/8 — driver-portability subgroup-size fix needed); Vulkan QJL/Polar (shaders compile clean, no harness/fixtures); CUDA QJL/Polar (kernels not yet ported into fork). |
| **Hardware-blocked on this host** | Apple Silicon (Metal CPU + GPU); iOS device + simulator; real Adreno/Mali Vulkan; real cuttlefish AVD round-trip; real NVIDIA / AMD / Intel ARC GPU runtime tests; Windows-native runtime smoke. |
| **Out of scope per current plan** | Hexagon HVX/QDSP6; NNAPI/EdgeTPU/Pixel Tensor; WebGPU; training-time-only paths. See `unified-fork-strategy.md` §"Out of scope". |

## Per-platform × per-technique summary

Status legend matches `build-matrix.md`: `✓` verified, `⚠` partial,
`□` source-only / not started, `✗` blocked, `n/a` not applicable.

### Per-platform (artifact freshness)

| Platform / ABI | Build | Symbols | Parity | Runtime | Last measured |
|---|---|---|---|---|---|
| Linux x64 CPU | ✓ 1m04s | ✓ 33 | ✓ ref-test | ✓ stub bench, ✓ embedding E2E | 2026-05-09 (W4-D) |
| Linux x64 CUDA | ⚠ ~40m compile-only | ⚠ 275 TBQ-named, no QJL/Polar | n/a | ✗ no GPU driver | 2026-05-09 (W4-D, in flight); 2026-05-09 (W3-D full) |
| Linux x64 Vulkan | ⚠ 8/8 SPV compile | n/a (SPVs only) | ⚠ 0/8 turbo* on lavapipe + Intel ARL | ⚠ shaders only, no real GPU | 2026-05-09 (W4-D) |
| Linux arm64 musl | ✓ 1m41s zig cross | ✓ 33 (NEON variants) | ✓ 100/100 QJL self+fork dlopen QEMU | ✗ no real arm64 box | 2026-05-09 (W4-D) |
| Android arm64-v8a | ✓ same as Linux arm64 musl | ✓ 33 | ✓ same | ✗ no Pixel / cuttlefish run | 2026-05-09 (W4-D) |
| Android x86_64 | ⚠ tracked via x64-cpu compile | ⚠ same as x64 | n/a | ✗ no AVD run | 2026-05-09 (W4-D) |
| Darwin arm64 Metal | □ source-only | □ — | □ — | ✗ no Apple Silicon | 2026-05-09 W3-G ready-to-run kit |
| iOS arm64 Metal | □ source-only | □ — | □ — | ✗ no Apple Silicon | — |
| Windows x64 CPU | ✓ 2m37s mingw cross | ✓ 27 base + 31 cpu PE | ⚠ no native Windows runtime | ✗ no Windows box | 2026-05-09 (W4-D) |
| Windows x64 CUDA | □ source-only | □ — | n/a | ✗ no Windows + RTX | — |
| Windows x64 Vulkan | □ source-only | □ — | n/a | ✗ no Windows + Vulkan ICD | — |

### Per-technique × per-platform (mirrors `unified-fork-strategy.md` §D, restated with measured-today data)

| Technique | Linux CPU | Linux CUDA | Linux Vulkan | Apple Metal | iOS Metal | Android arm64 NEON | Android Vulkan | Notes |
|---|---|---|---|---|---|---|---|---|
| **TBQ3_0 / TBQ4_0** (V-cache) | ✓ | ⚠ compile-only, 4 fattn-vec instances | ⚠ 3 SPVs compile, 0/8 runtime | □ | □ | ✓ NEON+QEMU parity | □ | source pin: `elizaOS/llama.cpp @ v0.3.0-eliza` |
| **TBQ3_TCQ** (trellis-coded) | □ ref C only | ▲ Viterbi encoder needs warp-shuffle | ⚠ SPV compiles, 0/8 runtime | □ | □ | □ | □ | encoder still missing |
| **QJL1_256** (K-cache) | ✓ AVX2 + ref | ✗ not in fork | ⚠ 3 SPVs compile, no harness | □ Metal source exists | □ | ✓ NEON+QEMU 100/100 | □ | W4-B kernel CUDA port pending |
| **Q4_POLAR** (weight-side) | ✓ scalar + AVX2 | ✗ not in fork | ⚠ 2 SPVs compile, no harness | □ Metal source exists | □ | ✓ NEON parity (in budget) | □ | W4-B kernel CUDA port pending |
| **DFlash spec-decode** | ✓ via `llama-server --spec-type dflash` | ✓ same | ✓ same | ✓ same | n/a | ✓ cross-compiled `llama-server` per ABI; adapter wired | n/a | acceptance rate not yet measured on phone hardware |
| **Fused QJL+TBQ attention** (W3-B CPU) | ✓ scalar + AVX2 + NEON | ☐ W3-D CUDA fused pending | □ | □ | □ | ✓ NEON path compiled (no on-device parity yet) | □ | landed in v0.3.0 |
| **Fused Q4_POLAR x Q8_0 dot** (W3-B CPU) | ✓ scalar + AVX2 + NEON | ☐ port to CUDA | □ | □ | □ | ✓ NEON | □ | landed in v0.3.0 |
| **Head quantization** | □ | □ | □ | □ | □ | □ | □ | proposed addition (`unified-fork-strategy.md` §E item 2) |
| **KV disk paging** | □ | n/a | n/a | n/a | n/a | □ (the >128k context unlock on phones) | n/a | proposed addition (item 4) |
| **BitNet b1.58 ternary** | □ | □ | □ | □ | □ | □ | □ | proposed addition (item 3) |
| **MXFP4 / NVFP4** | ✓ already upstream | ✓ Blackwell tensor-core path upstream | □ | □ FP4 not real on Apple | □ | ✓ memory savings | □ | rebase-free win (item 1) |
| Hexagon HVX / NNAPI / EdgeTPU / WebGPU | ✗ out of scope | | | | | | | per current porting plan |

## Outstanding hardware-runner work (prioritized)

These items are blocked **only** on physical hardware. Software is ready.

1. **Apple Silicon Metal bring-up** (highest leverage — biggest user
   surface). Run W3-G's ready-to-run kit on an M-series Mac. Verify
   TBQ Metal kernels via `metal_verify`, then wire QJL/Polar Metal
   dispatchers (sources already staged under
   `ggml/src/ggml-metal/eliza-kernels/` on `elizaOS/llama.cpp`).
   Owner: any agent with an M-series Mac. Effort: 2–3 sessions.

2. **NVIDIA GPU runtime gate for CUDA** (compile is green; runtime
   needs a driver-bound GPU). Targets sm_80 (A100/A30), sm_86
   (RTX 30xx), sm_89 (RTX 40xx), sm_90 (H100). For Blackwell sm_100
   coverage, also upgrade to CUDA 12.8+. The W3-D
   `cuda-compile-only.md` "Hardware-runner checklist" is the
   step-by-step. Effort: 1 session per arch.

3. **Real arm64 device round-trip** (cuttlefish arm64 AVD or a Pixel).
   The QEMU-user kernel parity is a strong signal but not a substitute
   for native silicon. End-to-end agent chat round-trip against the
   v0.3.0 musl cross-built libs is the missing seal. Owner: any agent
   with adb access or KVM-host for cuttlefish. Effort: 1 session.

4. **Windows-native runtime smoke** (mingw cross is green; native
   loader path not exercised). Wine or a Windows VM is enough for the
   smoke; a real Windows box is enough for the runtime gate. Effort:
   1 session.

5. **Real-GPU Vulkan parity** (NVIDIA + AMD + Intel ARC). lavapipe +
   Intel iGPU both report 0/8 PASS on turbo*; the source-level fix
   (subgroup-size enforcement or shared-memory tree reduction) is
   identified by W3-E and is the gate for any Vulkan validation —
   needs hardware to verify the fix doesn't regress the AVX2/NEON
   parity. Effort: 1 session per vendor.

6. **Adreno / Mali Vulkan** on a real Android device — the only path
   for `android-arm64-v8a-vulkan`. Cuttlefish's SwiftShader Vulkan is
   not representative. Effort: 1 session per device class.

## Outstanding software work (no hardware needed)

In rough priority order. Cross-reference to `W4-Review/CLEANUP-LEDGER`
when that lands; for now this is the single ledger.

1. **W4-A — Vulkan turbo* shader subgroup-size fix.** Diagnosis already
   shipped in `reports/porting/2026-05-09-w3/vulkan-compile-only.md` §
   "Source-level findings". Two options: shared-memory tree reduction
   (driver-portable, +5 barriers) or `VkPipelineShaderStageRequiredSubgroupSizeCreateInfo`
   pipeline-side fix (faster on 32-lane native subgroup hardware).
   Recommend tree reduction as the safe-default for v0.4.0-eliza.
   Verifies on lavapipe immediately (no GPU needed).

2. **W4-B — QJL/Polar CUDA kernel port.** Reference research kernels
   live at `packages/training/scripts/quantization/qjl/csrc/`
   (qjl_quant_kernel.cu, qjl_score_kernel.cu, …). Port into
   `ggml/src/ggml-cuda/` on `eliza/qjl-cuda` and `eliza/polar-cuda`
   branches. Compile-validate on this host, then queue for the
   real-GPU runner. ~3–5 sessions including ggml-cuda dispatcher
   wiring.

3. **`compile-libllama.mjs` pin bump** from `v0.2.0-eliza` to
   `v0.3.0-eliza`. One-line change in
   `packages/app-core/scripts/aosp/compile-libllama.mjs:187` plus
   the matching `LLAMA_CPP_COMMIT` update. Required before W3-B
   fused kernels reach the AOSP path by default.

4. **Vulkan QJL/Polar harness extension.** `vulkan_verify.cpp`
   currently only handles the turbo* bind set. Extend for the new
   QJL / Polar shaders (different buffer layouts, different push-
   constant struct), generate fixtures via the existing
   `qjl_polar_ref.c`. ~1 session.

5. **Eliza-1 DFlash acceptance-rate measurement.** The fork carries the
   DFlash CLI surface (v0.2.0). Acceptance rate (`n_drafted /
   n_accepted` from the Prometheus counters) still needs measurement on
   the published Eliza-1 target/drafter bundles. The benchmark harness
   already captures the metric. ~1 session per Eliza-1 tier.

6. **TBQ3_TCQ encoder.** Decoder already exists across CPU/Metal/Vulkan;
   encoder needs a 512-state Viterbi over 128 timesteps. Pure
   quality win, ~5–7 days. See `unified-fork-strategy.md` §E item 5.

7. **node-llama-cpp prebuild publication.** `elizaOS/node-llama-cpp`
   ships `dist/` and accepts the new `GgmlType` strings, but the
   underlying `@node-llama-cpp/<platform>` C++ binary still resolves
   to the upstream prebuild — so the desktop path silently falls
   back to the default cache type when a Eliza enum int isn't in
   ggml's type table. Publishing per-platform prebuilds from the
   elizaOS/llama.cpp tree is the seal. See
   `unified-fork-strategy.md` §F "Remaining gap". ~1 week.

8. **MXFP4 / NVFP4 rebase pickup.** `eliza/main` should rebase to
   the upstream master that landed both. Free win on rebase. Add
   MXFP4/NVFP4 to `kvCacheConfigs[]` in
   `scripts/benchmark/configs/`. ~1 session.

## Pointer to detailed reports

Detailed evidence (build logs, symbol dumps, per-kernel tables) lives
under [`reports/porting/`](../../reports/porting/). Per-wave summaries:

| Date / wave | Index | What's in it |
|---|---|---|
| 2026-05-09 baseline | [`2026-05-09-baseline/INDEX.md`](../../reports/porting/2026-05-09-baseline/INDEX.md) | knip / madge / catalog coverage / pre-fork symbol baseline / 34-item larp inventory |
| 2026-05-09 unified | [`2026-05-09-unified/INDEX.md`](../../reports/porting/2026-05-09-unified/INDEX.md) | post-fork-unifier symbol counts; AOSP arm64+x86_64 symbols + sizes + md5 |
| 2026-05-09 W2 | [`2026-05-09-w2/`](../../reports/porting/2026-05-09-w2/) | NEON cross-validation (QJL + Polar), cache stress, embedding E2E |
| 2026-05-09 W3 | [`2026-05-09-w3/`](../../reports/porting/2026-05-09-w3/) | CUDA compile-only, Vulkan compile-only + lavapipe/Intel runtime, Windows mingw cross |
| 2026-05-09 W4 | [`2026-05-09-w4/`](../../reports/porting/2026-05-09-w4/) | this re-run; build-matrix-rerun.md; symbols/, sizes/, vulkan/, bench-stub/ |

## Verdict

The unified fork strategy is **proven for the host CPU paths and the
arm64 NEON cross-build**. Real-hardware verification is the single
remaining gate for everything else. No software-side blocker exists
that can't be advanced without hardware (W4-A Vulkan fix, W4-B QJL/
Polar CUDA port, the `compile-libllama.mjs` pin bump are all software-
only).

The next wave (Wave-5 / W5) should focus on:
1. landing W4-A (Vulkan shader fix — verifiable on lavapipe),
2. landing W4-B (QJL/Polar CUDA — verifiable as compile-only on this host),
3. shipping a v0.4.0-eliza tag containing both,
4. pushing the build-matrix re-run on that tag (this report's process).

Hardware-runner items in §"Outstanding hardware-runner work" are
gated on the matching silicon being made available; those are
infrastructure decisions, not software work.
