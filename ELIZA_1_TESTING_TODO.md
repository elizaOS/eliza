# Eliza-1 Testing TODO

Status as of 2026-05-13.

## Current Local Lineup

- Text bases are Qwen3.5 only:
  - `eliza-1-0_8b` -> `Qwen/Qwen3.5-0.8B`
  - `eliza-1-2b` -> `Qwen/Qwen3.5-2B`
  - `eliza-1-4b` -> `Qwen/Qwen3.5-4B`
- Do not reintroduce the retired pre-Qwen3.5 small-tier line as Eliza-1 text tiers.
- The only default-eligible / visible release tiers are `0_8b`, `2b`, and
  `4b`. Historical `9b` / `27b` / extended-context tiers are hidden
  placeholders until final Eliza-1 weights, evals, licenses, checksums, and
  platform evidence exist.
- Hugging Face org for release artifacts is `elizaos`.

## Hard Release Blockers

1. Final Eliza-1 text GGUFs do not exist yet for every tier.
   Current local staged bytes are stand-ins and are not publish eligible.

2. Final DFlash KD drafters do not exist yet.
   The staged `eliza-1-2b.bundle/dflash/drafter-2b.gguf` is a tokenizer-compatible generic Qwen3.5-0.8B draft smoke artifact. It is not matched to the target checkpoint. The local Metal runtime can now draft/accept tokens, but the short diagnostic bench is slower than baseline, so it remains non-publishable.

3. Production DFlash acceptance/speedup evidence is missing.
   Required before release: per-tier acceptance rate, speedup vs no drafter, and proof that drafted tokens are non-zero with the final KD drafter and production `--spec-type dflash`.

4. Final active-bundle compressed-KV evidence is still needed.
   Metal and Vulkan graph dispatch now have runtime-ready kernel evidence, but
   release still needs per-tier active Eliza-1 bundle runs proving that
   `qjl1_256` / `q4_polar` are selected in real generation/voice workloads
   rather than falling back to `q8_0`.

5. Vulkan graph dispatch is partially release-proven.
   Linux Intel ANV and Android Pixel 6a / Mali-G78 now pass built-fork graph
   dispatch with runtime evidence. Adreno, AMD RADV, NVIDIA Vulkan, and
   Windows Vulkan still need real-device logs.

6. CUDA, ROCm, GH200/H200, Windows CUDA, and Windows CPU release evidence is missing.
   Runners exist, but each needs real target hardware logs, perf numbers, and pass/fail JSON evidence.

7. iOS physical-device XCTest is not a PASS.
   Rechecked on 2026-05-13: `xctrace` still lists UDID `00008130-001955E91EF8001C` under Devices Offline and `devicectl` lists CoreDevice id `C9130C48-48F1-5DC3-98E9-8BACE231D047` as `unavailable`; USB system profiler still does not show an iPhone/iPad transport. Re-run once the phone is unlocked, trusted, and `xcrun devicectl list devices` reports it available.
   Latest fail-closed report: `packages/inference/reports/local-e2e/ios-physical-device-smoke-20260513.json`.

8. Release evidence is incomplete.
   Missing final checksums, release-reviewed licenses, final evals, `evidence/release.json`, and `elizaos` Hugging Face upload proof for every shipped tier.

## Local Diagnostics That Now Run On This Mac

- Kernel reference + Metal JIT verification refreshed on this Mac:
  - `packages/inference/verify` `make reference-test` + `./gen_fixture --self-test` passed.
  - `metal_verify` reports 8/8 PASS for `turbo3`, `turbo4`, `turbo3_tcq`, `qjl`, `polar`, `polar_qjl`, `polar_preht`, and `polar_preht_qjl`.
  - This proves standalone shader numerics on local Apple Silicon; it does not prove built-fork graph dispatch for compressed KV.
- Kernel contract is green locally:
  - `make -C packages/inference/verify kernel-contract` now passes after the
    checker learned the target-scoped Vulkan runtime evidence schema and the
    fused-attention op contract doc was added.
- Android Vulkan is green on a physical Pixel:
  - `ANDROID_SERIAL=27051JEGR10034 make -C packages/inference/verify android-vulkan-smoke` passed on Pixel 6a / Mali-G78.
  - Standalone fixtures and fused attention passed, then built-fork graph
    dispatch passed and updated `packages/inference/verify/vulkan-runtime-dispatch-evidence.json`.
- Fused Metal text + OmniVoice TTS can run through `voice-interactive.mjs`.
- The harness uses q8_0 KV on Metal when compressed QJL/Polar KV would hit the unsupported built-graph path.
- The local generic DFlash drafter smoke now reaches generation without stale `-cd` CLI aliases:
  - latest runtime smoke: `packages/inference/verify/hardware-results/dflash-drafter-runtime-20260513T012834Z.json`
  - latest short bench: `packages/inference/reports/dflash-bench/dflash-bench-20260513T012834Z.json`
  - result: drafted=1 accepted=1 for loadability; 128-token bench speedup is ~0.85x (with drafter ~84.2 tok/s vs baseline ~98.8 tok/s), so this is not release evidence.
- Fused TTS -> fused ASR loopback on this Mac:
  - generated user audio: `/tmp/eliza-voice-loopback/user-hello.wav`
  - TTS report: `/tmp/eliza-voice-loopback/tts-user-hello.json`
  - ASR report: `/tmp/eliza-voice-loopback/asr-user-hello.json`
  - voice WAV loopback log: `/tmp/eliza-voice-loopback/voice-wav-loopback.log`
  - saved diagnostic evidence: `packages/inference/reports/voice-loopback/eliza-1-2b-darwin-arm64-metal-20260513T0120Z.json`
  - result: ASR transcript contains `Hello, say hello back.` and the agent reply contains `Hello`.
- Two-agent voice duet on this Mac:
  - report: `packages/inference/reports/local-e2e/voice-duet-eliza-1-2b-metal-q8-paced-gatefix-20260513.json`
  - result: one full A->B->A spoken loop passed with real fused TTS and ASR;
    DFlash accepted/drafted = 12/12; token throughput p50 ≈ 7.9 tok/s; the
    speculative-on-pause path started B's first token about 10.3s before A's
    utterance end and B's first audio about 9.4s before utterance end.
- `voice-interactive.mjs --wav` now defaults to deterministic batch-ASR file mode. Set `ELIZA_VOICE_WAV_USE_VAD=1` only when intentionally testing VAD over a WAV fixture.
- The harness can still run with `ELIZA_DFLASH_ALLOW_ZERO_DRAFT=1` for local diagnostics only. Do not use that flag for release evidence.
- Active Qwen3.5 catalog/training cleanup now has local verification:
  - `scripts/manifest`, `scripts/publish`, `scripts/training`, and
    `scripts/quantization` focused pytest suite passed under `uv`.
  - App/shared local-inference catalog and recommendation tests passed.
  - `packages/app-core` typecheck passed.
  - Voice duet focused tests passed after the duet bridge declarations/runtime
    exposed `settle()`, `pace`, and `frameMs`.
  - `build-llama-cpp-dflash.mjs --target darwin-arm64-metal --dry-run`
    completes and reports the Metal dispatch patch path as runtime-wired.

## Required Next Evidence Files

- `packages/inference/reports/dflash-bench/<tier>-metal.json`
- `packages/inference/reports/dflash-bench/<tier>-cpu.json`
- `packages/inference/reports/voice-loopback/<tier>-<platform>.json`
- `packages/inference/reports/vulkan/<device>-graph-dispatch.json`
- `packages/inference/reports/ios/<device>-xctest.json`
- `packages/inference/reports/windows/<device>-cpu.json`
- `packages/inference/reports/windows/<device>-cuda.json`
- `packages/inference/reports/cuda/<gpu>-dflash.json`
- `packages/inference/reports/rocm/<gpu>-dflash.json`
- `packages/inference/reports/gh200/<host>-dflash.json`
- `packages/training/reports/eliza-1-<tier>-text-final.json`
- `packages/training/reports/eliza-1-<tier>-drafter-final.json`
- `packages/training/reports/eliza-1-<tier>-licenses-final.json`
- `packages/training/reports/eliza-1-<tier>-hf-upload-elizaos.json`

## Release Rule

Do not mark any tier production-ready until final text weights, final matched DFlash drafter weights, non-zero DFlash drafting evidence, voice ASR/TTS loop evidence, platform dispatch evidence, licenses, checksums, and `elizaos` Hugging Face upload evidence are all present.
