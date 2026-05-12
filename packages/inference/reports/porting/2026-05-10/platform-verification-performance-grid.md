# Eliza-1 platform verification/performance grid - Apple Silicon - 2026-05-10

## Host

- Machine: MacBook Pro `Mac16,5`, Apple M4 Max, 16 CPU cores (12P+4E), 40-core GPU, 128 GB unified memory.
- OS: macOS 26.2 build `25C56`; Darwin `25.2.0` (`xnu-12377.61.12`, `RELEASE_ARM64_T6041`).
- Toolchain: `xcrun 72`, Apple clang `21.0.0`, Node `v24.5.0`, CMake `4.0.3`.
- Metal: Metal 4, GPU family Apple9/Common3/Metal4; `dispatch_smoke` reports recommended max working set `115448.73 MB`.

## Commands and exact result

| Command | Result |
| --- | --- |
| `system_profiler SPHardwareDataType SPSoftwareDataType SPDisplaysDataType` | PASS: hardware/OS captured above. |
| `sw_vers && uname -a && sysctl -n machdep.cpu.brand_string hw.memsize hw.ncpu hw.optional.arm64` | PASS: macOS 26.2/25C56, Darwin 25.2.0, Apple M4 Max, 137438953472 bytes RAM, 16 CPUs, arm64 present. |
| `xcrun --version && clang++ --version && node --version && cmake --version \| head -3` | PASS: toolchain captured above. |
| `make -C packages/inference/verify reference-test metal` | PASS: fixture sanity finite; `metal` already built. |
| Manual `./metal_verify ...` for `turbo3`, `turbo4`, `turbo3_tcq`, `qjl`, `polar` | PASS: each kernel `8/8 passed (tol=1e-03)`. Max diffs: turbo3 `2.861e-06`, turbo4 `5.722e-06`, turbo3_tcq `6.676e-06`, qjl `7.629e-06`, polar `5.722e-06`. |
| Manual `./metal_verify ... --multi N` for `N=2,3,4,8` on `turbo3`, `turbo4`, `turbo3_tcq`, `qjl` | PASS: all 16 multi-block runs `8/8 passed (tol=1e-03)`. |
| `make -C packages/inference/verify cpu-bench metal-bench` | PASS: build products already current. |
| `./cpu_bench --runs 3 --warmup 1 --out ../reports/porting/2026-05-10/cpu_m4max_2026-05-10.json` | PASS: JSON written. |
| `./metal_bench --out ../reports/porting/2026-05-10/metal_m4max_2026-05-10.json` | PASS: default Metal bench JSON written. |
| `./metal_bench --mode tgsweep --out ../reports/porting/2026-05-10/metal_tgsweep_m4max_2026-05-10.json` | PASS: threadgroup sweep JSON written. |
| `./metal_bench --mode fp16ref --out ../reports/porting/2026-05-10/metal_fp16ref_m4max_2026-05-10.json` | PASS: fp16 baseline JSON written. |
| `./metal_bench --mode multiblock --out ../reports/porting/2026-05-10/metal_multiblock_m4max_2026-05-10.json` | PASS: multi-block sweep JSON written. |
| `./metal_bench --mode batched --out ../reports/porting/2026-05-10/metal_batched_m4max_2026-05-10.json` | PASS: command-buffer batching sweep JSON written. |
| `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target darwin-arm64-metal --target ios-arm64-metal --target ios-arm64-simulator-metal --dry-run` | PASS: all three Apple targets queued; no credential gate. |
| `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target darwin-arm64-metal` | FAIL by required capability gate after a successful compile/install diagnostic: `shippedKernels.symbols.*` reports all five Metal standalone symbols present in `default.metallib`; `kernels.qjl_full=true` because `GGML_OP_ATTN_SCORE_QJL` has dedicated graph dispatch and smoke coverage; `kernels.{turbo3,turbo4,turbo3_tcq,polarquant}=false` until their dedicated graph dispatch lands. |
| `make -C packages/inference/verify dispatch-smoke` | PASS: exercises the built fork, not JIT, through `GGML_OP_ATTN_SCORE_QJL` -> `kernel_attn_score_qjl1_256_multi`; 32 scores matched the local packed-QJL reference, max diff `2.384e-07`. This replaces the earlier unsafe generic `ELIZA-DISPATCH-V1` smoke route and uses the benchmarked multi-token launch-tax fix. |
| `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target ios-arm64-simulator-metal` | FAIL by required capability gate after static archives build: diagnostic `CAPABILITIES.json` records `qjl_full=true` and shipped standalone symbols all true, but artifact is refused because `turbo3`, `turbo4`, `turbo3_tcq`, and `polarquant` are false. |
| `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target ios-arm64-metal` | FAIL by required capability gate after static archives build: expected same capability shape as simulator (`qjl_full=true`, Turbo/Polar false); still needs a physical-device runtime run after graph dispatch is complete. |
| `make -C packages/inference/verify metal-verify metal-verify-multiblock verify-fork` | PASS on current verify surface: reference self-test includes `polar_qjl`; standalone Metal includes Polar+QJL residual and all cases `8/8`; multi-block `N=2,3,4,8` all `8/8`; patched shipped fork Metal verifies `5/5`. Vulkan fork check skipped because the cached fork was not staged with Vulkan shaders. |

## Benchmark highlights

CPU scalar reference, 131072 blocks, median of 3 runs:

| Kernel | Median ms |
| --- | ---: |
| `turbo3` | 17.417 |
| `turbo4` | 9.411 |
| `turbo3_tcq` | 14.318 |
| `qjl` | 13.251 |
| `polar` | 21.098 |

Default Metal bench, 1000 interleaved iterations:

| Kernel | GPU median us | GPU p99 us | CPU median us | Bandwidth GB/s | Single-kernel tok/s estimate |
| --- | ---: | ---: | ---: | ---: | ---: |
| `turbo3` | 242.6875 | 1507.2863 | 363.5 | 32.4072 | 51.51 |
| `turbo4` | 243.7083 | 1375.3337 | 362.5 | 37.6497 | 51.29 |
| `turbo3_tcq` | 243.8125 | 1390.7658 | 366.0 | 30.1157 | 51.27 |
| `qjl` | 242.0208 | 1522.7725 | 361.5 | 6.9051 | 51.65 |
| `polar` | 458.6250 | 1806.1838 | 589.0 | 24.5793 | 27.26 |

fp16 K-cache baseline: GPU median `236.0625 us`, p99 `1178.5487 us`, CPU median `343 us`, `144.3653 GB/s` (`26.4405%` of 546 GB/s peak). Quantized kernels mainly reduce memory traffic; at this 4k-context dispatch shape, launch and per-kernel work still dominate latency.

Multi-block best results:

| Kernel | Best N | Best GPU median us | Speedup vs single |
| --- | ---: | ---: | ---: |
| `turbo3` | 8 | 49.3750 | 4.2886x |
| `turbo4` | 8 | 48.2083 | 4.4296x |
| `turbo3_tcq` | 4 | 81.9167 | 2.6816x |
| `qjl` | 16 | 54.0000 | 4.2496x |

Batched command buffers do not buy enough per-dispatch latency to justify voice use. N=4 is already around `867-1005 us` worst-case for turbo/QJL and `1902 us` for polar; N=256 reaches `62-75 ms` for turbo/QJL and `165.7 ms` for polar. Voice paths should keep N=1.

Threadgroup sweep: QJL dispatched at tg 32/64/128/256 with medians `332.4792`, `279.3750`, `294.3750`, `435.5417 us`; Polar medians were `344.0417`, `710.8750`, `1572.9583`, `4255.1667 us`. The sweep only records dispatch/timing; correctness still assumes the 32-lane SIMD-group reduction shape.

## Build probes

`darwin-arm64-metal` compiles and ships all five standalone Metal symbols in
`default.metallib`, but it is not yet an Eliza-1 publishable runtime. The
installed diagnostics show `shippedKernels.symbols.*=true`,
`kernels.qjl_full=true`, and Turbo/Polar runtime capabilities false. This is
intentional: symbol presence is not graph dispatch readiness; only the
dedicated `GGML_OP_ATTN_SCORE_QJL` bridge has passed the built-fork smoke
test so far, now through the multi-token Metal kernel used by the benchmark
sweep.

Both iOS targets now compile static archives with an embedded compiled
`default.metallib` that contains all five standalone Metal kernel symbols.
They are still correctly non-publishable today: the build script writes
diagnostics, then exits non-zero because Turbo/Polar shipped symbols are not
yet runtime-ready graph capabilities for the full Eliza-1 contract.

- `ios-arm64-simulator-metal`: `kernels.qjl_full=true`; `kernels.{turbo3,turbo4,turbo3_tcq,polarquant}=false`; `shippedKernels.symbols.{turbo3,turbo4,turbo3_tcq,qjl_full,polarquant}=true`.
- `ios-arm64-metal`: expected same capability shape; compile probe still needs a physical-device runtime run after the graph-dispatch work is complete.

## Unsupported or still needing physical devices

- iOS device runtime validation still needs a physical iPhone/iPad after graph-dispatch routing is complete.
- iOS simulator remains blocked by the runtime capability gate; it does not need external credentials, but the artifact is intentionally refused until shipped symbols are graph-reachable and numerically verified.
- Vulkan fork verification was not proven on this Mac. The tightened native
  Linux runner now writes an evidence log, refuses stale/symbol-only artifacts,
  dumps `CAPABILITIES.json`, and must run `vulkan-dispatch-smoke` on native
  Linux hardware before any Vulkan runtime-ready claim.
- CUDA, ROCm, Windows, Android, Linux aarch64, and server-H200/GH200 targets were not run on this Apple Silicon host; they still need matching physical hardware/toolchains.

## Artifacts written

Raw benchmark JSON from this run lives beside this report:

- `cpu_m4max_2026-05-10.json`
- `metal_m4max_2026-05-10.json`
- `metal_tgsweep_m4max_2026-05-10.json`
- `metal_fp16ref_m4max_2026-05-10.json`
- `metal_multiblock_m4max_2026-05-10.json`
- `metal_batched_m4max_2026-05-10.json`
