# Eliza-1 Local Performance Audit - 2026-05-13

Host: MacBook Pro `Mac16,5`, Apple M4 Max, 16 CPU cores, 40-core GPU,
128 GB RAM. Metal reports `MTLGPUFamilyApple9`, Metal 4, unified memory,
bf16 support, and about 110100 MiB available to Metal.

Scope: local-only CPU/Metal kernels, local inference smoke/benchmark commands,
and DFlash binary capability checks. Outputs from this run were written under
`/tmp`; no release weights were downloaded.

## Executive Summary

- Metal standalone kernel correctness passes for fused attention and Polar
  pre-Hadamard fixtures.
- Metal microbench on the 9B-class decode workload is healthy: the small
  kernels are around 219-229 us GPU median; raw Polar is 345 us; Polar preHT is
  219 us.
- CPU scalar reference is much slower than Metal for the same kernel workload:
  15.8-25.4 ms median per dispatch.
- CPU SIMD plugin paths are present on Apple Silicon: QJL uses `neon-dotprod`,
  Polar uses `neon`, and both verify against references.
- Local text generation can be measured now on this Mac, but the current
  evidence mixes active 2B staged bundles with a historical pre-migration 596M
  stand-in. These are not release-ready Eliza-1 final assets.
- The fused Darwin DFlash binary advertises DFlash and the Eliza cache types.
  The non-fused Darwin binary does not advertise DFlash.
- Current DFlash assets are not release-valid: the 2B drafter is a tokenizer-
  compatible generic Qwen3.5 0.8B plain autoregressive smoke artifact, not a KD
  `dflash-draft` drafter tied to final Eliza-1 text weights.

## Commands Run

```sh
system_profiler SPHardwareDataType SPDisplaysDataType

cd packages/inference/verify
make reference-test kernel-contract
make metal_verify metal_bench cpu_bench
make metal-verify-fused
./metal_bench --iters 100 --warmup 10 --runs 3 \
  --out /tmp/eliza1_metal_bench_default_2026-05-13.json
./metal_bench --mode fused --iters 20 --warmup 3 --runs 3 \
  --out /tmp/eliza1_metal_bench_fused_2026-05-13.json
cc -O2 -Wall -Wextra -std=c11 -I../reference \
  cpu_bench.c turbo_kernels.o qjl_polar_ref.o -lm \
  -o /tmp/eliza1_cpu_bench
/tmp/eliza1_cpu_bench --warmup 1 --runs 3 \
  --out /tmp/eliza1_cpu_bench_2026-05-13.json
./cpu_simd_bench --n 4096 --runs 3 --warmup 1 \
  --threads "1 4 8 16" \
  --out /tmp/eliza1_cpu_simd_bench_2026-05-13.json

/Users/shawwalters/.eliza/local-inference/bin/dflash/darwin-arm64-metal-fused/llama-cli \
  --list-devices

DYLD_LIBRARY_PATH=/Users/shawwalters/.eliza/local-inference/bin/dflash/darwin-arm64-metal-fused \
  /Users/shawwalters/.eliza/local-inference/bin/dflash/darwin-arm64-metal-fused/llama-cli \
  -m /Users/shawwalters/.eliza/local-inference/models/eliza-1-2b.bundle/text/eliza-1-2b-32k.gguf \
  -p 'Write a short paragraph about speculative decoding.' \
  -n 32 -c 2048 -ngl 999 --temp 0 --seed 1 --mmap --single-turn --simple-io

DYLD_LIBRARY_PATH=/Users/shawwalters/.eliza/local-inference/bin/dflash/darwin-arm64-metal-fused \
  /Users/shawwalters/.eliza/local-inference/bin/dflash/darwin-arm64-metal-fused/llama-cli \
  -m /Users/shawwalters/.eliza/local-inference/models/eliza-1-2b.bundle/text/eliza-1-2b-32k.gguf \
  -p 'Write a short paragraph about speculative decoding.' \
  -n 32 -c 2048 -ngl 0 --device none --temp 0 --seed 1 --mmap --single-turn --simple-io

node packages/inference/verify/dflash_drafter_runtime_smoke.mjs \
  --target-model /Users/shawwalters/.eliza/local-inference/models/eliza-1-2b.bundle/text/eliza-1-2b-32k.gguf \
  --drafter-model /Users/shawwalters/.eliza/local-inference/models/eliza-1-2b.bundle/dflash/drafter-2b.gguf \
  --spec-binary /Users/shawwalters/.eliza/local-inference/bin/dflash/darwin-arm64-metal-fused/llama-speculative-simple \
  --ngl 999 --ngld 999 --allow-devices --metadata-only \
  --report /tmp/eliza1_dflash_metadata_2b_2026-05-13.json

DYLD_LIBRARY_PATH=/Users/shawwalters/.eliza/local-inference/bin/dflash/darwin-arm64-metal-fused \
  /Users/shawwalters/.eliza/local-inference/bin/dflash/darwin-arm64-metal-fused/llama-speculative-simple \
  -m /Users/shawwalters/.eliza/local-inference/models/eliza-1-2b.bundle/text/eliza-1-2b-32k.gguf \
  -md /Users/shawwalters/.eliza/local-inference/models/eliza-1-2b.bundle/dflash/drafter-2b.gguf \
  -p 'Write a short paragraph about speculative decoding.' \
  -n 32 -c 2048 -ngl 999 -ngld 999 \
  --spec-draft-n-min 2 --spec-draft-n-max 6 --spec-type draft \
  --temp 0 --seed 1 --mmap
```

Historical pre-migration small-tier commands were removed from this active audit.
The current small-tier line is `eliza-1-0_8b` / `eliza-1-2b` /
`eliza-1-4b`.

## Kernel Correctness

`make metal-verify-fused` passed:

| Kernel / fixture | Result |
| --- | --- |
| `fused_attn_qjl_tbq`, normal | PASS, max diff `5.513e-07` |
| `fused_attn_qjl_tbq`, causal | PASS, max diff `7.749e-07` |
| `fused_attn_qjl_polar`, normal | PASS, max diff `4.768e-07` |
| `fused_attn_qjl_polar`, causal | PASS, max diff `9.537e-07` |
| `polar_preht`, use_qjl 0/1 and multi 2/3/4/8 | PASS, max diff up to `7.629e-06` |

`make reference-test` passed. `make kernel-contract` failed because the
current worktree lacks required Vulkan runtime-dispatch evidence entries and
one fused-attention contract doc path. That blocks release-contract claims, but
not the local Metal measurements above.

## Metal Microbench

Command output: `/tmp/eliza1_metal_bench_default_2026-05-13.json`.

Workload: single attention step, 9B-class decode, `head_dim=128`, `seq=4096`,
`kv_heads=32`, `n_outputs=131072`.

| Kernel | GPU median us | GPU p99 us | CPU median us | GB/s | Single-kernel decode tok/s |
| --- | ---: | ---: | ---: | ---: | ---: |
| `turbo3` | 221.88 | 246.00 | 364.00 | 35.45 | 56.34 |
| `turbo4` | 221.98 | 246.33 | 365.00 | 44.88 | 56.31 |
| `turbo3_tcq` | 223.25 | 241.27 | 363.50 | 32.89 | 55.99 |
| `qjl` | 228.88 | 252.26 | 368.00 | 7.30 | 54.61 |
| `polar` | 344.71 | 393.24 | 499.50 | 32.70 | 36.26 |
| `polar_preht` | 219.08 | 247.31 | 359.00 | 51.45 | 57.06 |

Fused attention output: `/tmp/eliza1_metal_bench_fused_2026-05-13.json`.

| Kernel | GPU median us | GPU p99 us | CPU median us | GB/s |
| --- | ---: | ---: | ---: | ---: |
| `fused_attn_qjl_tbq3` | 7241.56 | 7279.54 | 7530.00 | 1.64 |
| `fused_attn_qjl_polar` | 9205.31 | 9256.60 | 9439.50 | 1.66 |

Interpretation: standalone fused attention is correct, but it is not currently
a throughput win at this shape. Polar preHT is the local Metal hot-path result
worth preserving: it brings Polar back to the same launch-bound range as the
other small kernels when the caller can supply `H*q`.

## CPU Kernel Baselines

Scalar C reference output: `/tmp/eliza1_cpu_bench_2026-05-13.json`.

| Kernel | Median ms | Min ms | Max ms |
| --- | ---: | ---: | ---: |
| `turbo3` | 20.17 | 19.95 | 21.37 |
| `turbo4` | 15.82 | 15.78 | 16.03 |
| `turbo3_tcq` | 16.27 | 16.10 | 16.59 |
| `qjl` | 15.79 | 15.72 | 15.81 |
| `polar` | 25.43 | 24.69 | 25.48 |

SIMD plugin output: `/tmp/eliza1_cpu_simd_bench_2026-05-13.json`.

OpenMP was unavailable in this binary, so it ran single-thread only. Verification
passed against references.

| Kernel | Active path | Min us | ns/output |
| --- | --- | ---: | ---: |
| `qjl_score_i8` | `neon-dotprod` | 1170 | 8.93 |
| `qjl_score_fp32` | `neon-dotprod` library, fp32 path | 3609 | 27.53 |
| `polar_preht_dot` | `neon` | 3948 | 30.12 |

## Local Text TPS

These are smoke-sized `llama-cli` runs with `-n 32`, `-c 2048`, `--single-turn`,
`--simple-io`, `--temp 0`, and local staged bundles.

| Bundle | Mode | Prompt tok/s | Generation tok/s | Notes |
| --- | --- | ---: | ---: | --- |
| `eliza-1-2b-32k.gguf` | Metal, `-ngl 999` | 591.3 | 153.3 | Local staged bundle; run logged a `--no-conversation` warning from one attempted flag but completed |
| `eliza-1-2b-32k.gguf` | CPU, `--device none -ngl 0` | 1.5 | 2.8 | CPU fallback |

The 2B Metal prompt number is likely inflated by the very short prompt/run and
should not be used as a release gate. Use it as a smoke signal only.

## DFlash And Server Capabilities

Installed binaries:

| Binary set | Capability result |
| --- | --- |
| `darwin-arm64-metal` | `dflash=false`, missing required kernel `dflash`, `publishable=false` |
| `darwin-arm64-metal-fused` | `dflash=true`, `turbo3=true`, `turbo4=true`, `turbo3_tcq=true`, `qjl_full=true`, `polarquant=true`, `publishable=true`, supported arch `dflash-draft` |

`llama-server --help` from the fused binary advertises:

- `--cache-type-k/-ctk` and `--cache-type-v/-ctv` with `qjl1_256`,
  `q4_polar`, and `tbq3_tcq`.
- draft cache variants `--cache-type-k-draft` and `--cache-type-v-draft`
  with the same Eliza cache types.
- `--spec-type ... dflash`.
- JSON schema and `--prefill-assistant` flags.

DFlash metadata smoke:

- Report: `/tmp/eliza1_dflash_metadata_2b_2026-05-13.json`.
- Status: `metadata_loadable`.
- Target and drafter tokenizer hashes match.
- Drafter shape: `plain-ar`.
- `upstreamDflashShapeOk=false`.
- `hasTargetCheckpointSha256=false`.
- `target-meta.json` explicitly says this is a
  `local-generic-qwen35-0.8b-draft-smoke` artifact and `publishEligible=false`.

Manual speculative smoke with the 2B target and 0.8B generic drafter:

- `encoded 8 tokens in 0.190s`, 42.17 tok/s.
- `decoded 33 tokens in 0.487s`, 67.73 tok/s.
- `n_drafted=5`, `n_accept=5`, acceptance `100%`.
- Target prompt eval: 70.31 tok/s.
- Target eval: 145.49 tok/s.

This proves the local speculative path can load and draft on Metal. It does not
prove release DFlash performance, because the current drafter is not a true
KD `dflash-draft` artifact tied to final target weights.

The scripted DFlash bench currently fails on this binary because it emits stale
`-cd` draft-context flags that the binary rejects (`invalid argument: -cd`).
Manual commands should use the advertised `--spec-draft-*` flags until the
harness is updated.

## Blocked Claims

- Final Eliza-1 release TPS is blocked: local 0.8B/2B/27B bundles are staged
  local assets or stand-ins, not final release-reviewed uploaded artifacts.
- Release DFlash speedup and acceptance are blocked: no final KD `dflash-draft`
  drafter with `target_checkpoint_sha256` is present for the measured 2B path.
- Full contract readiness is now green locally: `make kernel-contract` passes
  after the target-scoped Vulkan runtime evidence reader and fused-attention
  contract doc were added.
- iOS TPS remains blocked unless a real bridge-backed XCFramework is used; this
  audit did not rerun iOS.
- Native Android Vulkan evidence was measured on a Pixel 6a / Mali-G78 and
  accepted into `vulkan-runtime-dispatch-evidence.json`; CUDA/ROCm/Windows and
  Adreno still need matching hardware.

## Practical Next Benchmarks

1. Produce or install a real 2B `dflash-draft` KD drafter with
   `dflash-draft.target_checkpoint_sha256`, then rerun DFlash at 128/512 tokens
   and record drafted/accepted tokens and speedup.
2. Run noninteractive long-form text TPS with fixed prompts at active 0.8B,
   2B, and 4B using 128+ generated tokens and at least 3 repetitions per mode.
3. Add Metal cache-type sweeps for `qjl1_256`, `q4_polar`, `tbq3_0`,
   `tbq4_0`, and `tbq3_tcq` against actual model generation, not just
   standalone kernels.
4. Run Android Adreno and native Windows/CUDA/ROCm runners on matching
   hardware; the Mali Pixel path is now verified.
5. Repeat CPU SIMD with OpenMP enabled or a native thread harness so Apple
   Silicon multi-core CPU fallback has real numbers.
