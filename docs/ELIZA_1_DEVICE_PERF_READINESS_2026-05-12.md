# Eliza-1 Device Performance Readiness - 2026-05-12

Host: Apple M4 Max, macOS 26.2 / Darwin 25.2.0, 16 CPU cores, 128 GiB RAM.
Connected iOS device: Shaw's iPhone, iPhone 15 Pro, iOS 26.3.1,
UDID `00008130-001955E91EF8001C`.

This file is the current production-readiness record for local Eliza-1
performance on this machine. It separates measured facts from blockers. Do not
promote any row below to release-ready without matching evidence artifacts.

## Verdict

| Target | Status | Evidence |
| --- | --- | --- |
| Mac Metal text | Measured and usable, not full-release ready | 0.6B reached 250.9 tok/s in the best prior clean run; round-2 grid measured 0.6B 80.3, 1.7B 98.6, 9B 14.0, 27B 5.4 generation tok/s. |
| Mac CPU text | Measured fallback only | 0.6B CPU generation 36.0 tok/s. CPU SIMD QJL/Polar kernels are fast, but full CPU voice is not production-ready. |
| Mac Metal kernels | Strong correctness confidence | TurboQuant, QJL, Polar, Polar preHT, multiblock, and fused fixtures pass. Multiblock is the largest safe kernel win. |
| Mac fused voice | Runs, not production-ready | End-to-end voice loop completes, but DFlash and streaming TTS are inactive; first audio from mic was 62.1s. |
| iOS CPU/Metal | Runtime smoke passes; real TPS blocked | Awake iPhone 15 Pro runs the physical XCTest smoke successfully. The 0.6B weight-backed CPU/Metal benchmark reaches XCTest but both modes fail at `llama_init_context` because the current XCFramework bridge is shim-backed. |
| Release bundles | Not release-ready | Local staged bundles exist, but final elizaos HF upload evidence, final evals, final release-reviewed licenses, and target hardware evidence are incomplete. |

## What Changed In This Round

- `packages/inference/verify/dflash_drafter_runtime_smoke.mjs` now probes
  `llama-speculative-simple --help`, records supported optional flags, and
  skips unsupported optional flags such as `--spec-type` and `--tree-budget`
  instead of failing on stale CLI assumptions.
- DFlash smoke and bench were rerun on Mac Metal against the local
  `eliza-1-0_6b.bundle`.
- The physical iOS path was audited with the connected iPhone and current local
  XCFramework.
- Final syntax and JSON sanity checks were run for the touched Node scripts and
  the new evidence files.

## 2026-05-12 Device Recheck

New evidence report:
`packages/inference/verify/hardware-results/eliza1-device-readiness-recheck-2026-05-12.md`.

Commands rerun:

```sh
(command -v adb && adb devices -l) || echo 'adb not found'
xcrun devicectl list devices
node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs \
  --report packages/inference/verify/hardware-results/ios-device-smoke-2026-05-12-recheck.json \
  --collect-test-diagnostics never
cd packages/inference/verify && make metal-verify-fused
cd packages/inference/verify && make metal-bench-fused
cd packages/inference/verify && VK_ICD_FILENAMES=/opt/homebrew/etc/vulkan/icd.d/MoltenVK_icd.json \
  DYLD_LIBRARY_PATH=/opt/homebrew/opt/vulkan-loader/lib:/opt/homebrew/opt/molten-vk/lib \
  make vulkan-verify-fused
cd packages/inference/verify && VK_ICD_FILENAMES=/opt/homebrew/etc/vulkan/icd.d/MoltenVK_icd.json \
  DYLD_LIBRARY_PATH=/opt/homebrew/opt/vulkan-loader/lib:/opt/homebrew/opt/molten-vk/lib \
  VULKAN_BENCH_JSON=bench_results/vulkan_moltenvk_fused_m4max_2026-05-12.json \
  make vulkan-bench
node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs \
  --report packages/inference/reports/porting/2026-05-12/ios-physical-device-smoke-awake-20260512.json \
  --collect-test-diagnostics never
node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs \
  --benchmark-model /Users/shawwalters/.eliza/local-inference/models/eliza-1-0_6b.bundle/text/eliza-1-0_6b-32k.gguf \
  --report packages/inference/reports/porting/2026-05-12/ios-physical-device-tps-awake-0_6b-20260512.json \
  --collect-test-diagnostics never
```

Results:

| Target | Result | Evidence |
| --- | --- | --- |
| Android adb visibility | Blocked | `adb not found`; no physical Android smoke was possible. |
| iOS physical smoke | Pass after unlock | Awake iPhone 15 Pro built, signed, installed, and ran the physical XCTest smoke; Metal, bridge symbols, runtime symbols, and libelizainference ABI checks passed. |
| iOS 0.6B weight-backed TPS | Blocked by bridge slice | CPU and Metal benchmark attempts reached XCTest but failed at `llama_init_context` with `iOS static bridge is link-ready but real llama context wiring is not enabled in this slice`; both TPS values remain 0. |
| Metal fused correctness | Pass | Fused QJL+TBQ3, fused QJL+Polar, causal variants, and Polar preHT passed; max diff at or below `9.537e-07` for fused and `7.629e-06` for Polar preHT. |
| Metal fused benchmark | Pass, not a default win | `fused_attn_qjl_tbq3` median `8823.77 us`; `fused_attn_qjl_polar` median `11272.19 us`. |
| Vulkan-on-MoltenVK fused correctness | Pass, non-substitute | Apple M4 Max via MoltenVK, Vulkan API `1.2.334`; fused variants passed with max diff at or below `9.537e-07`. |
| Vulkan-on-MoltenVK benchmark | Pass, non-substitute | Fused QJL+TBQ3: `1323.04 us` at 512 KV, `10729.29 us` at 4096 KV, `85729.04 us` at 32768 KV. Fused QJL+Polar: `1369.42 us`, `11246.21 us`, `89308.58 us`. |

MoltenVK remains translation-layer evidence only. It does not satisfy Android
Adreno/Mali, native Linux Vulkan, or native Windows Vulkan readiness.

## Text TPS

Mac Metal and CPU text generation evidence:

| Tier / mode | Prompt tok/s | Generation tok/s | Evidence |
| --- | ---: | ---: | --- |
| 0.6B Metal, best clean run | 1145.3 | 250.9 | `packages/inference/verify/bench_results/tps_m4max_eliza1_0_6b_metal_2026-05-12.summary.txt` |
| 0.6B CPU fallback | 823.4 | 36.0 | `packages/inference/verify/bench_results/tps_m4max_eliza1_0_6b_cpu_2026-05-12.summary.txt` |
| 0.6B Metal grid | 840.6 | 80.3 | `packages/inference/verify/bench_results/tps_m4max_eliza1_text_grid_round2_2026-05-12.txt` |
| 1.7B Metal grid | 791.9 | 98.6 | same |
| 9B Metal grid | 79.3 | 14.0 | same |
| 27B Metal grid | 13.1 | 5.4 | same |

Flash Attention sweep on 0.6B:

| Flash Attention | Prompt tok/s | Generation tok/s | Action |
| --- | ---: | ---: | --- |
| auto | 976.7 | 126.0 | Keep as default for now. |
| on | 681.8 | 49.3 | Do not force on for short 0.6B decode on M4 Max. |
| off | 819.2 | 122.3 | Competitive with auto; include in autotune. |

Conclusion: do not hardcode `--flash-attn on` for all Eliza-1 tiers. Use
per-device/per-shape autotune; for this short 0.6B workload, `auto` and `off`
beat forced `on`.

## Kernel Status

| Component | Current best result | Production decision |
| --- | --- | --- |
| Turbo3 / Turbo4 / TCQ Metal | Standalone and multiblock correctness pass. Multiblock is 3.6x to 5.6x faster in local M4 Max benches depending run. | Use multiblock for throughput paths; keep smaller in-flight work for voice. |
| QJL Metal | Correctness pass. Runtime default remains env-tunable via `ELIZA_METAL_QJL_TOKENS_PER_TG`; local sweeps are noisy across N=4/8/16/32. | Do not hardcode one noisy winner. Add persisted per-device autotune. |
| PolarQuant Metal | Raw and preHT correctness pass. preHT is about 1.8x to 2.4x faster when caller supplies `H*q`. | Use preHT only behind an explicit graph/manifest precondition; raw q to preHT is wrong. |
| Fused attention | Fixture correctness passes, but current M4 Max fused runs are milliseconds, not a free win. | Keep experimental until KV tiling and partial combine are implemented. |
| CPU QJL / Polar SIMD | QJL i8 NEON-dotprod around 14-20 ns/out; Polar preHT around 50-73 ns/out. | Keep SIMD dispatch; gate QJL i8 by model-level tolerance before default. |
| Command-buffer batching | Helps bulk launch amortization only in some cases. | Rejected for realtime voice because it hurts cancellation/barge-in latency. |

## DFlash

Evidence:

- Smoke report:
  `packages/inference/verify/bench_results/dflash_smoke_m4max_metal_failclosed_2026-05-12.json`
- Bench report:
  `packages/inference/verify/bench_results/dflash_bench_m4max_metal_failclosed_2026-05-12.json`

Result:

| Metric | Value |
| --- | ---: |
| Metadata status | `metadata_loadable` |
| Drafter architecture | `dflash-draft` |
| Target tokenizer | `gpt2` / `qwen2`, 151936 tokens |
| Drafter tokenizer | `gpt2` / `qwen35`, 248320 tokens |
| Runtime status | exit 0, classified `dflash_vocab_incompatible_no_drafts` |
| Drafted tokens | 0 |
| Accepted tokens | 0 |
| Acceptance rate | null |
| With-drafter generation tok/s | 9.207 |
| Target eval tok/s | 225.38 |
| Draft eval tok/s | 9.69 |

The harness now fails closed instead of claiming a speedup. The shipped drafter
targets a different tokenizer/model family, so it is not safely fixable with
runtime flags. Production requires a drafter distilled for the exact Eliza-1
target/tokenizer, or a target bundle matching the current drafter.

## Voice Path

Evidence:

- `packages/inference/verify/bench_results/e2e_loop_m4max_metal_round2_2026-05-12.json`
- `packages/inference/verify/bench_results/asr_m4max_metal_round2_2026-05-12.json`
- `packages/inference/verify/bench_results/tts_asr_self_labelled_2026-05-12.json`
- `packages/inference/verify/bench_results/vad_m4max_round2_2026-05-12.json`

Measured:

| Component | Result | Decision |
| --- | --- | --- |
| ASR speed | RTF 3.79 over 15.5s synthesized audio | Speed is usable. |
| Self-labelled TTS->ASR loopback | WER 0.171 over 8 synthesized utterances, ASR RTF 3.98, mean round trip 4.75s | Useful regression signal, not a real ASR WER gate. |
| ASR WER release gate | Self-labelled gate fails threshold 0.1 and external recorded gate is still absent | Needs real recorded WAV set. |
| VAD | p95 latency 0.795 ms, onset MAE 40 ms, false barge-in/hr 0 on fixtures | Good standalone result. |
| TTS | Batch TTS works; RTF median 2.42 in e2e loop | Not production voice latency. |
| Streaming TTS | `streamingTtsActive=false` | Hard blocker for voice mode. |
| Codec backend | requested Metal, selected CPU due to `merged-ggml-dac-decode-stall` | Metal codec path still blocked. |
| Full loop | first token 19.7s, decode 0.4 tok/s, first audio from mic 62.1s | Not production-ready. |
| Barge-in | standalone abort path is fast, but assembled controller harness unavailable | Need real controller integration. |

## Embeddings

Evidence:

- `packages/inference/verify/bench_results/embedding_m4max_metal_round2_2026-05-12.json`

Measured:

| Metric | Value |
| --- | ---: |
| Cold load | 3638 ms |
| Single-text median | 31.72 ms |
| Batch 1 throughput | 84.1 texts/s |
| Batch 16 throughput | 417.7 texts/s |
| Matryoshka 512 vs 1024 correlation | 0.9927 |

Decision: embeddings are locally healthy for the 0.6B pooled-text path. For
release, 1.7B+ should use the dedicated embedding GGUF and run a real retrieval
eval, not only the pairwise-cosine proxy.

## Vision

Evidence:

- `packages/inference/verify/bench_results/vision_9b_m4max_metal_installed_mtmd_2026-05-12.json`
- `packages/inference/verify/bench_results/vision_27b_m4max_metal_round3_2026-05-12.json`

Result: 9B and 27B image smoke both pass on Mac Metal. The installer now builds
and copies `llama-mtmd-cli`, and the installed runtime path was verified.

| Tier | Prompt tok/s | Decode tok/s | Image encode | Image decode | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| 9B | 110.63 | 10.36 | 235 ms | 12 ms | Installed runtime binary; correctly described the Moon landing newspaper. |
| 27B | 38.33 | 6.28 | 1590 ms | 28 ms | Build-tree binary; correctly loaded projector and image path. |

The CLIP graph still logs an unsupported Metal `UPSCALE` op, so vision is
functionally working but not fully optimized.

## iOS Physical Device

Evidence:

- `packages/inference/reports/porting/2026-05-12/ios-physical-device-benchmark-audit-current.json`
- `packages/inference/reports/porting/2026-05-12/ios-physical-device-smoke-rerun-2026-05-12.json`
- `packages/inference/reports/porting/2026-05-12/ios-physical-device-smoke-awake-20260512.json`
- `packages/inference/reports/porting/2026-05-12/ios-physical-device-tps-awake-0_6b-20260512.json`
- `packages/inference/verify/hardware-results/ios-device-smoke-awake-2026-05-12.json`
- `packages/inference/verify/hardware-results/ios-device-tps-awake-0_6b-2026-05-12.json`

Facts:

- CoreDevice sees the physical iPhone 15 Pro as connected, paired, wired, and
  Developer Mode enabled.
- After unlocking/keeping the phone awake, the physical-device XCTest smoke
  passed: Metal availability, Llama bridge symbols, QJL/Polar/DFlash runtime
  symbols, and libelizainference ABI calls all passed on-device.
- The current XCFramework contains real llama.cpp/ggml/Metal objects, but the
  exported Capacitor/runtime bridge is shim-backed. In the 0.6B benchmark run,
  CPU and Metal both failed at `llama_init_context` with `iOS static bridge is
  link-ready but real llama context wiring is not enabled in this slice`.

Therefore no iOS CPU or iOS Metal tokens/sec result is valid yet. The device
side of the smoke gate is clear; a valid iOS TPS run now requires a real
bridge-backed `LlamaCpp.xcframework`.

Command to rerun once a real bridge-backed XCFramework is available:

```sh
node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs \
  --xcframework /path/to/real-bridge/LlamaCpp.xcframework \
  --benchmark-model /Users/shawwalters/.eliza/local-inference/models/eliza-1-0_6b.bundle/text/eliza-1-0_6b-32k.gguf \
  --report packages/inference/reports/porting/2026-05-12/ios-physical-device-tps-real-bridge.json \
  --collect-test-diagnostics never
```

## Release Blockers

These are still hard blockers for claiming Eliza-1 is production-ready across
local devices:

1. Real DFlash drafting and acceptance must activate in the runtime path.
2. Streaming TTS must be implemented and measured; batch-only TTS is too slow
   for voice mode.
3. Metal codec fallback to CPU must be resolved or explicitly budgeted.
4. ASR must pass on a real recorded WAV set, not self-synthesized audio.
5. Vision release evals must run beyond the single-image smoke; Metal `UPSCALE`
   fallback must be optimized or budgeted.
6. iOS must use a real bridge-backed XCFramework and produce CPU/Metal TPS on
   the physical device; the awake-device runtime smoke itself now passes.
7. Per-device kernel autotune must persist recommendations for voice mode and
   throughput mode separately.
8. Final elizaos HF release bundles need final weights, checksums, licenses,
   evals, and upload evidence.
9. Native Vulkan Linux/Android, CUDA, ROCm, Windows, and GH200 still need target
   hardware evidence.
10. Full 30-turn voice endurance must pass with DFlash, streaming TTS, VAD,
    ASR, text, and cache policies active.

## Safe Next Optimizations

Apply only changes that satisfy the corresponding correctness precondition:

| Optimization | Apply now? | Reason |
| --- | --- | --- |
| Metal/Vulkan multiblock for TurboQuant/QJL throughput | Yes, with autotune | Correctness verified; fold factor must vary by device and voice/non-voice mode. |
| Polar preHT | Yes, only with explicit `H*q` route | Fast and exact only with the precondition. |
| Force Flash Attention on | No | Local 0.6B sweep shows forced `on` is slower than `auto`/`off`. |
| Fused attention default | No | Correct but not performance-ready; needs tiling. |
| Command-buffer batching in voice | No | Hurts cancellation latency. |
| QJL i8 CPU default | Not yet | Fast but needs model-level score tolerance/eval gate. |
| DFlash benchmark speedup claim | No | Current run produced zero drafted/accepted tokens. |

## Verification Commands Run Last

```sh
node --check packages/inference/verify/dflash_drafter_runtime_smoke.mjs
node --check packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs
node -e 'for (const f of process.argv.slice(1)) { JSON.parse(require("fs").readFileSync(f,"utf8")); console.log("ok", f); }' \
  packages/inference/verify/bench_results/dflash_smoke_m4max_metal_round3_2026-05-12.json \
  packages/inference/verify/bench_results/dflash_bench_m4max_metal_round3_2026-05-12.json \
  packages/inference/reports/porting/2026-05-12/ios-physical-device-benchmark-audit-current.json \
  packages/inference/verify/bench_results/asr_m4max_metal_round2_2026-05-12.json \
  packages/inference/verify/bench_results/e2e_loop_m4max_metal_round2_2026-05-12.json \
  packages/inference/verify/bench_results/embedding_m4max_metal_round2_2026-05-12.json \
  packages/inference/verify/bench_results/vad_m4max_round2_2026-05-12.json \
  packages/inference/verify/bench_results/vision_9b_m4max_metal_round2_2026-05-12.json
```
