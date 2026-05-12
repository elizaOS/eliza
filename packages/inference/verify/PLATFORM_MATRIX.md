# Eliza-1 platform matrix — build · verify · bench, one command each

> Single reference for every entry in `SUPPORTED_TARGETS`
> (`packages/app-core/scripts/build-llama-cpp-dflash.mjs`). For each target:
> the one-command build, the one-command kernel verify, the one-command
> bench, the current status, and the exact prerequisite if it is not done
> here. The narrower "what hardware does someone need to plug in" view is
> [`../reports/porting/2026-05-11/needs-hardware-ledger.md`](../reports/porting/2026-05-11/needs-hardware-ledger.md);
> the enforceable contract is [`kernel-contract.json`](kernel-contract.json)
> (checked by `make -C packages/inference/verify kernel-contract`); the
> publish-blocker ledger is
> [`../reports/porting/2026-05-11/remaining-work-ledger.md`](../reports/porting/2026-05-11/remaining-work-ledger.md).

## Verify status as of 2026-05-12 (post multi-agent wave)

Re-ran the full integration verify matrix on this box (Intel Arrow Lake CPU +
Intel ARL/ANV Vulkan + RTX 5080 / sm_120 CUDA, with a full-corpus SFT job
holding ~12 GB VRAM concurrently — no OOM contention on the short verify runs):

| Target | Result |
| --- | --- |
| `make kernel-contract` | PASS — `OK kernels=6 targets=21 manifestNames=6` |
| `make reference-test` | PASS — C reference clean; `gen_fixture --self-test` finite (fused-attn + TBQ V-cache parity OK) |
| `make cpu-bench` | PASS (nothing to rebuild; harness in place) |
| `make cpu-dispatch-smoke` | PASS — `ATTN_SCORE_QJL` + `FUSED_ATTN_QJL_TBQ` MT-vs-ST bit-identical, no NaN |
| `make vulkan-dispatch-smoke` | PASS — Intel ARL: `GGML_OP_ATTN_SCORE_QJL` 32 outs max 2.7e-7, `GGML_OP_FUSED_ATTN_QJL_TBQ` 512 outs max 4.5e-8 |
| `make vulkan-verify` | PASS — 8/8 (turbo3/turbo4/turbo3_tcq/qjl/polar incl. polar pre-Hadamard, both residual modes) |
| `make vulkan-verify-multiblock` | PASS — 8/8 across 1/2/4/8 blocks-per-workgroup |
| `make vulkan-verify-fused` | PASS — 1920/1920 outputs (4 cases) on Intel ARL ANV, max diff ≤ 7.2e-7 |
| `make cuda-verify` | PASS — 8/8 each kernel + 1920/1920 fused on RTX 5080 (sm_120), max diff ≤ 9.5e-6 |
| `make cuda-verify-fused` | PASS — 1920/1920 fused QJL-K/TBQ-V on RTX 5080, max diff 4.47e-7 |

Nothing regressed in this wave. `bun run typecheck` for `packages/app-core` is
clean; `bun test packages/app-core/src/services/local-inference/` is 603 pass /
17 fail where all 17 failures are the known test-isolation flakes (downloader ×6
— passes 7/7 alone — plus `cache-restart-corruption` / `cache-multi-model` /
`cache-thrash` / `cache-stress` shared-mock-state, and the 2 `fused llama-server`
tests that need the fused binary built); `…/voice/` is 217/218 + 28/28 green;
`python3 -m pytest packages/training/scripts/{eval,publish,manifest,wakeword}
packages/training/benchmarks` is 140 passed / 1 skipped.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **verified-here** | A real hardware run happened on the machine that wrote this doc (Intel Arrow Lake / Mesa ANV Linux for CPU + Vulkan; **NVIDIA RTX 5080 Mobile / sm_120 for CUDA**; Apple M4 Max for Metal/MoltenVK from prior passes; iPhone 15 Pro for the iOS device smoke). |
| **authored-pending-hardware** | Source + build plumbing + a fail-closed runner exist; no real run on the matching device class yet. |
| **needs-operator** | The build/run needs `sudo` or a toolkit install the agent cannot do. (CUDA 12.8 for native sm_120 SASS is now installed at `/usr/local/cuda-12.8`; the build hook auto-pins it.) |
| **needs-bigger-box** | The build itself OOMs / is too slow on the 31 GB / 24-core dev box (the CUDA-fused build is ~30 GB peak RAM, ~2 h); use the cloud runner (`packages/app-core/scripts/cloud/run-on-cloud.sh`, or `packages/training/scripts/cloud/`). |

## How the three "one commands" map

- **Build:** `node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target <triple>` (prepend `ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT=1` while the structured-output server patch is still being fixed; the iOS targets emit a `.a` for the xcframework patch, the `-fused` targets emit `libelizainference` + the fused server, everything else emits `llama-server` + `llama-cli` + `llama-speculative-simple` + `llama-bench` + `llama-completion`). The fork build (`packages/inference/llama.cpp` submodule, or the `~/.cache/eliza-dflash` clone) `git reset --hard`s on each run — do source edits first, build last, retry on clobber. **Serialize fork builds; never two CUDA builds at once on the 31 GB box.**
- **Kernel verify** (synthetic fixtures, fast — minutes): `make -C packages/inference/verify <backend>-verify` (`metal-verify` / `vulkan-verify` / `cuda-verify`; add `-multiblock` / `-fused` for the extra coverage). These are the AGENTS.md §8 8/8-PASS gates. They do **not** need the bundle bytes.
- **Built-fork graph dispatch** (proves a real llama.cpp graph route selects the kernel): `make -C packages/inference/verify vulkan-dispatch-smoke` (Vulkan), `metal dispatch-smoke` (Metal), the C++ `vulkan_dispatch_smoke` / `dispatch_smoke.mm` harnesses. CUDA's equivalent is `cuda-verify` (fixture-parity `__device__` kernels) + the `cuda_runner.sh` graph smoke (now via `llama-bench` / `llama-completion`, not `llama-cli` — the fork's `llama-cli` is conversation-only and busy-loops on stdin EOF).
- **Bench:** `make -C packages/inference/verify <backend>-bench` (`metal-bench` / `vulkan-bench` / `cpu-bench`) for the standalone-kernel perf harness; `llama-bench -m <gguf> -ngl 99 -p … -n … -fa 1 --cache-type-k …` for the model-graph throughput (the verify runners do this); `verify/e2e_loop_bench.mjs` / `verify/thirty_turn_endurance_harness.mjs` for the end-to-end voice loop. The fork ships `llama-bench` + `llama-completion` next to `llama-server` (as of this commit), so the bench path exists on every built target.

## CPU baseline — runnable anywhere

| Target | Build | Kernel verify | Bench | Status | Prereq if not done |
| --- | --- | --- | --- | --- | --- |
| `linux-x64-cpu` | `node …/build-llama-cpp-dflash.mjs --target linux-x64-cpu` | `make -C …/verify reference-test` (C-reference round-trip); the CPU score/decode ops are the C references themselves; `make cpu-dispatch-smoke` (graph picks `GGML_OP_ATTN_SCORE_QJL` + `GGML_OP_FUSED_ATTN_QJL_TBQ` on the CPU backend and asserts MT-vs-ST bit-identical, no NaN — `verify/qjl_mt_check.c`; `CPU_BIN_DIR`/`GGML_INC_DIR` default to the in-repo fork build/checkout, no env vars) | `make -C …/verify cpu-bench cpu-simd-bench`; `llama-bench` on the staged text GGUF | **verified-here** (`reference-test` clean; `cpu-dispatch-smoke` PASS — MT-vs-ST bit-identical; AVX-VNNI int8-QJL 5.25× / fp32-QJL LUT-gather ~2.5–8× — `bench_results/cpu_avxvnni_2026-05-11.json`, `bench_results/cpu_kopt_2026-05-11.json`). `kernel-contract.json` `runtimeStatus.cpu` = `runtime-ready` for `qjl` + `fusedAttn` (`verify/cpu-runtime-dispatch-evidence.json`); `reference-only` for TBQ/Polar standalone score (no public CPU graph op — validated by `reference-test`). The §3 CPU kernel-completeness build gate still fails by design (turbo3_tcq/polarquant not CPU-buildable). | verify-on-device against the staged bundle bytes (`verifyBundleOnDevice`); wire `probeKernels()` to read `cpu-runtime-dispatch-evidence.json` so a fresh `linux-x64-cpu` build's `CAPABILITIES.json` reports `qjl_full` runtime-ready. |
| `linux-aarch64-cpu` | `--target linux-aarch64-cpu` (needs an arm64 Linux host or a sysroot+cross-toolchain — no aarch64-cross wiring on x64 here) | `make reference-test` + `cpu-dispatch-smoke` on the arm64 host | `cpu-bench cpu-simd-bench` (NEON dotprod paths) | **authored-pending-hardware** | An arm64 Linux box (Ampere Altra / Graviton / Snapdragon-Linux). |
| `windows-x64-cpu` | `--target windows-x64-cpu` (mingw cross-build) | `pwsh -File verify/windows_runner.ps1 -Backend cpu -Model C:\models\eliza-1-smoke.gguf` on a real Windows box (now drives `llama-bench` + `llama-completion`, not `llama-cli`) | `windows_runner.ps1` (above) | **authored-pending-hardware** (cross-built exe is not counted) | A native Windows x64 host. |
| `windows-arm64-cpu` | `--target windows-arm64-cpu` (needs an MSVC arm64 cross-toolchain or a native Windows-arm64 host — no mingw arm64 wiring here) | `windows_runner.ps1 -Backend cpu` on a Snapdragon X box | `windows_runner.ps1` | **authored-pending-hardware** | A Snapdragon X Elite / Copilot+ PC. |
| `android-arm64-cpu` | `node packages/app-core/scripts/aosp/compile-libllama.mjs` (NDK cross-build) | CPU/NEON parity via `adb` on a physical Android device | `adb`-pushed `cpu_bench` / `llama-bench` | **authored-pending-hardware** | A physical Android device + NDK. |
| `linux-x64-cpu-fused` | `ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT=1 …/build-llama-cpp-dflash.mjs --target linux-x64-cpu-fused` | `OMNIVOICE_FUSE_VERIFY.json` `ok=true` + `verifyFusedSymbols` (abi/omnivoice/llama-reexport counts) | `dflash-server-fused.integration.test.ts` (spawns the fused `llama-server`, hits `/completion` + `/v1/audio/speech` same-PID); `llama-bench`/`llama-completion` for text | **verified-here** for the merged HTTP route + symbol-verify; exit-1 is the §3 CPU-backend kernel-completeness gate (turbo3_tcq/qjl_full/polarquant aren't CPU-graph-dispatch caps), `CAPABILITIES.json` `publishable: false`. | A weight-backed `/v1/audio/speech` smoke against a real `tts/omnivoice-*.gguf` (the dev stand-in bundle has no `tts/`). |

## CUDA — verified-here on the RTX 5080 (sm_120, **native SASS** via CUDA 12.8)

| Target | Build | Kernel verify | Bench | Status | Prereq if not done |
| --- | --- | --- | --- | --- | --- |
| `linux-x64-cuda` | `ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT=1 …/build-llama-cpp-dflash.mjs --target linux-x64-cuda` (~1.5–2 h, ~30 GB peak — serialize; check `free -m`/`uptime` first). CUDA 12.8 is installed at `/usr/local/cuda-12.8`; the build hook's `resolveNvcc()`+`cudaCompilerFlags()` auto-pin it (`-DCMAKE_CUDA_COMPILER=…/cuda-12.8/bin/nvcc`, arch list `90a;90;89;86;80;100;120;90-virtual` with **real `100`/`120` SASS**) even though `PATH` `nvcc` is the distro 12.0. | `make -C …/verify cuda-verify cuda-verify-fused` (self-contained nvcc compile of `cuda_verify.cu`; **8/8 + 1920/1920 PASS on the RTX 5080**, max diff ≤ 7.6e-6 / 4.47e-7; `cuda-verify-fused` now exercises the warp-cooperative kernel mirroring the production `cuda/fused-attn-qjl-tbq.cu`; the harness builds a native `sm_120.cubin` under 12.8). | `verify/cuda_runner.sh --report …` (builds the fork, `cuda-verify`, then `runtime_graph_smoke.sh --gen-check` → `llama-bench --cache-type-k tbq3_0 -ngl 99` + `llama-completion`); `bench_results/cuda_e2e_2026-05-11.json` (text pp ~2.3–6.7k t/s, tg ~40–55 t/s; ASR `eliza-1-asr.gguf` → arch `qwen3vl 1.7B`, pp16 ~1023, pp128 ~4561, tg32 ~62 t/s); nsys (back-to-back): DP4A `qjl_score_dp4a_kernel` ~2.27× faster than fp32 `qjl_score_kernel`. | **verified-here** for `cuda-verify` / `cuda-verify-fused` / text + ASR `llama-bench` / native-`sm_120`-SASS-compile. `kernel-contract.json` `runtimeStatus.cuda` + `fusedAttn.runtimeStatus.cuda` = `runtime-ready`. | (a) full `ggml-cuda` integration build with the 12.8 toolkit — **needs a quiet host** (RAM-contended this wave: ~3 GB free of 30 GB, 80+ compilers running); the staged `fused-attn-qjl-tbq.cu` already compiles clean against the fork headers with the full fat-binary list (`cuobjdump --list-elf` → `sm_80/86/89/90/90a/100/120` cubins) and the kernel-patch dry-run is green. (b) verify-on-device against the staged bundle bytes. |
| `linux-x64-cuda-fused` | `ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT=1 …/build-llama-cpp-dflash.mjs --target linux-x64-cuda-fused` — the **big** build: full ggml-cuda + the omnivoice-core graft, ~30 GB peak RAM (the 31 GB dev box OOM-kills concurrent CUDA builds). Confirm `OMNIVOICE_FUSE_VERIFY.json` `ok=true` + `verifyFusedSymbols`. | `cuda-verify cuda-verify-fused` (same as above) + `OMNIVOICE_FUSE_VERIFY.json` | The fused `llama-server`'s `POST /v1/audio/speech` against `tts/omnivoice-base-Q4_K_M.gguf` (arch `omnivoice-lm` — only the fused build loads it; stock `llama-bench`/`llama-cli` reject it) → GPU TTS RTF; `verify/e2e_loop_bench.mjs` end-to-end | **needs-bigger-box** — the kernel + flag plumbing exists (`patchCudaKernels` + `-DGGML_CUDA_FUSED_ATTN_QJL=ON` + the omnivoice cmake graft), but not built here under the concurrent load. Run it solo (no other CUDA build), or on the cloud runner. | A box with ≥ ~32 GB free RAM (or `cloud/run-on-cloud.sh` on an H100/A100). Unblocks the e2e bench's GPU TTS/ASR RTF numbers (the e2e bench is a sibling's). |
| `linux-aarch64-cuda` | `--target linux-aarch64-cuda` on an arm64 Linux + Hopper/Blackwell host (GH200 = aarch64 host + H100/H200/GB200 GPU) | `make cuda-verify cuda-verify-fused` on that host; `verify/gh200_runner.sh --report …` (refuses non-aarch64 / non-Hopper-9.x) | `gh200_runner.sh`; `llama-bench` on the `27b-256k` / `27b-1m` tier GGUFs | **authored-pending-hardware** | A GH200 / H100-aarch64 / GB200 host. Use the cloud runner. |
| `windows-x64-cuda` | `--target windows-x64-cuda` (MSVC + CUDA Toolkit on Windows) | `pwsh -File verify/windows_runner.ps1 -Backend cuda -Model C:\models\eliza-1-smoke.gguf` on NVIDIA hardware (drives `llama-bench` + `llama-completion`) | `windows_runner.ps1` (above) | **authored-pending-hardware** (cross-built exe not counted) | A native Windows + NVIDIA box. |
| `windows-x64-cuda-fused` | `--target windows-x64-cuda-fused` | `windows_runner.ps1 -Backend cuda` + `OMNIVOICE_FUSE_VERIFY.json` | the fused Windows `llama-server`'s `/v1/audio/speech` | **authored-pending-hardware** | The Windows-CUDA hardware runner first, then the fused build on that host. |

## Vulkan — verified-here on Intel Arc/Xe Mesa ANV (single device class)

| Target | Build | Kernel verify | Bench | Status | Prereq if not done |
| --- | --- | --- | --- | --- | --- |
| `linux-x64-vulkan` | `…/build-llama-cpp-dflash.mjs --target linux-x64-vulkan` | `make -C …/verify vulkan-verify vulkan-verify-multiblock vulkan-verify-fused` (**8/8 + 8/8 + 1920/1920 PASS on Intel ANV**, max diff ≤ 7.6e-6 / 6.3e-7); `make vulkan-native-smoke` / `vulkan-dispatch-smoke` (**built-fork graph routes PASS on Intel ARL/ANV** — the harness drives the two fused attention ops the fork pin declares in `ggml.h`: `GGML_OP_ATTN_SCORE_QJL` 32 outs max 2.7e-7 + `GGML_OP_FUSED_ATTN_QJL_TBQ` 512 outs max 4.5e-8 — `vulkan-runtime-dispatch-evidence.json` + `hardware-results/linux-vulkan-smoke-*.log`. The standalone TBQ/Polar score kernels are covered by `vulkan-verify`; their built-fork graph entries in the evidence file are from a prior full-patched-build run.) | `make vulkan-bench`; `llama-bench -ngl 99` (the dispatch smoke does this) | **verified-here on Intel ARL/ANV** — `kernel-contract.json` `runtimeStatus.vulkan` = `runtime-ready` for the 5 score kernels + fused_attn. Single Intel-ANV device class. | Native AMD (RADV) and NVIDIA-desktop Vulkan graph dispatch; verify-on-device against the staged bundle bytes. |
| `linux-x64-vulkan-fused` | `ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT=1 …/build-llama-cpp-dflash.mjs --target linux-x64-vulkan-fused` — Vulkan ggml + the omnivoice-core graft (much lighter than the CUDA-fused build). Confirm `OMNIVOICE_FUSE_VERIFY.json` `ok=true` + `verifyFusedSymbols`. | `vulkan-verify vulkan-verify-fused` (same as above) + `OMNIVOICE_FUSE_VERIFY.json` | The fused `llama-server`'s `/v1/audio/speech` against `tts/omnivoice-base-Q4_K_M.gguf` → Vulkan TTS RTF; `e2e_loop_bench.mjs` | **authored-pending-hardware** for the fused-build artifact — the non-fused Vulkan path is verified-here; the fused build had not been run on this box at the time of writing (lighter than CUDA-fused — should fit; run it solo). | Run `…/build-llama-cpp-dflash.mjs --target linux-x64-vulkan-fused`; then the weight-backed `/v1/audio/speech` smoke. |
| `windows-x64-vulkan` | `--target windows-x64-vulkan` (mingw + Khronos Vulkan-Headers cross-build) | `pwsh -File verify/windows_runner.ps1 -Backend vulkan -Model C:\models\eliza-1-smoke.gguf` on native Windows Vulkan | `windows_runner.ps1` | **authored-pending-hardware** | A native Windows + GPU box. |
| `windows-arm64-vulkan` | `--target windows-arm64-vulkan` (MSVC arm64 cross-toolchain) | `windows_runner.ps1 -Backend vulkan` on a Snapdragon X box (Adreno X1 = Vulkan 1.3) | `windows_runner.ps1` | **authored-pending-hardware** | A Snapdragon X Elite / Copilot+ PC. |
| `android-arm64-vulkan` | `node packages/app-core/scripts/aosp/compile-libllama.mjs` (NDK cross-build) | `make -C …/verify android-vulkan-smoke` — standalone fixtures **6/6 PASS on Pixel 6a / Mali-G78** (`hardware-results/android-vulkan-smoke-*.log`); built-fork graph dispatch evidence (`ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE`) still open; Adreno not yet run | `adb`-pushed `vulkan_bench` / `llama-bench` | **authored-pending-hardware** for graph dispatch (standalone fixtures verified-here on Mali) | A built-fork/app graph-dispatch report on one Adreno + one Mali device. |

## Metal / Apple — verified-here on Apple M4 Max (prior passes)

| Target | Build | Kernel verify | Bench | Status | Prereq if not done |
| --- | --- | --- | --- | --- | --- |
| `darwin-arm64-metal` | `…/build-llama-cpp-dflash.mjs --target darwin-arm64-metal` (macOS host, builds + embeds `default.metallib`) | `make -C …/verify metal-verify metal-verify-multiblock` (**8/8 + 8/8 on M4 Max**); `make dispatch-smoke` (built-fork graph dispatch for `GGML_OP_ATTN_SCORE_{QJL,TBQ×3,POLAR}` + pre-Hadamard Polar — all PASS); `metal-verify-fused` **fails by design** (no `metal/fused_attn*.metal` `cases`-array path in `metal_verify` yet — see `../reports/porting/2026-05-11/metal-fused-attn-and-polar-preht-design.md`) | `make metal-bench metal-bench-batched metal-bench-multiblock`; `llama-bench -ngl 99` | **verified-here on M4 Max** — `kernel-contract.json` `runtimeStatus.metal` = `runtime-ready` for the 5 score kernels; `darwin-arm64-metal` passes the build-script capability gate. | Full text+DFlash+voice latency/RSS/thermal gates against a staged Eliza-1 bundle; `metal_verify` `cases`-array path for `metal-verify-fused`. |
| `darwin-arm64-metal-fused` | `…/build-llama-cpp-dflash.mjs --target darwin-arm64-metal-fused --jobs 10` — links `omnivoice-core` + `libelizainference.dylib` + `llama-omnivoice-server` + `libmtmd` + `default.metallib`; `verify-symbols.mjs` (`omnivoice=10 abi=8`) | `metal-verify metal-verify-multiblock dispatch-smoke` (same as above) + `verify-symbols.mjs` | Bun FFI smoke against `~/.eliza/local-inference/models/eliza-1-1_7b.bundle` (loads real OmniVoice Q4_K_M + Qwen3-ASR for TTS + ASR — `reports/local-e2e/2026-05-11/fused-voice-ffi-smoke.json`); `e2e_loop_bench.mjs` | **verified-here on macOS Metal** for the fused dylib FFI smoke (real GGUF-backed TTS + ASR in one fused process) | Built-fork graph-dispatch smoke + full latency/RSS/thermal gates; the fused `llama-server` route on macOS (currently the macOS evidence is the FFI path, not the HTTP route). |
| `ios-arm64-metal` | `…/build-llama-cpp-dflash.mjs --target ios-arm64-metal` (macOS+Xcode, emits `.a` + headers + `default.metallib` → `build-xcframework.mjs --verify` glues the `LlamaCpp.xcframework`) | `build-xcframework.mjs --verify` (kernel-symbol + runtime-symbol + structure audits — PASS); `run-physical-device-smoke.mjs` (**3/3 XCTest cases PASS on iPhone 15 Pro / iOS 26.3.1**, `--skip-voice-abi=false` — `hardware-results/ios-device-smoke-2026-05-11.json`) | the iOS XCTest harness; (no `llama-bench` on iOS — the runtime is the static lib + `eliza_inference_*` ABI) | **verified-here on iPhone 15 Pro** for the symbol/structure audits + the runtime-symbol XCTest; the §3 P0 blocker is a weight-backed Eliza-1 bundle smoke from the Capacitor app shell (first token / first audio / peak RSS / thermal). | A real Eliza-1 bundle smoke from the Capacitor app shell. |
| `ios-arm64-simulator-metal` | `…/build-llama-cpp-dflash.mjs --target ios-arm64-simulator-metal` | `build-xcframework.mjs --verify` (simulator slice — PASS); simulator smoke against the embedded metallib + `GGML_OP_ATTN_SCORE_TBQ` Turbo4 route | the iOS simulator XCTest | **authored-pending-hardware** (symbol/structure audits pass; no simulator weight-backed run) | Simulator smoke against the embedded metallib. |

(`darwin-x64-metal` is **not** a supported target — Apple Silicon `darwin-arm64-metal` only.)

## ROCm — runner exists, no AMD host here

| Target | Build | Kernel verify | Bench | Status | Prereq if not done |
| --- | --- | --- | --- | --- | --- |
| `linux-x64-rocm` | `…/build-llama-cpp-dflash.mjs --target linux-x64-rocm` (needs `hipcc` + ROCm) | `verify/rocm_runner.sh --report …` (refuses without `hipcc` + `rocminfo` `gfx*` agent + a smoke GGUF; builds the fork, then `runtime_graph_smoke.sh --gen-check` → `llama-bench` + `llama-completion` on the HIP backend). There is no standalone HIP fixture harness equivalent to `cuda_verify` yet. | `rocm_runner.sh`; `llama-bench -ngl 99` on the HIP backend | **authored-pending-hardware** | An AMD ROCm host (RDNA2/RDNA3, `gfx*` agent). Use the cloud runner. |

## Quick "one command for everything I can run here" line

```bash
# From the repo root, on this box (CPU + Intel-ANV Vulkan + RTX 5080 CUDA):
make -C packages/inference/verify kernel-contract reference-test cuda-verify cuda-verify-fused
make -C packages/inference/verify vulkan-verify vulkan-verify-multiblock vulkan-verify-fused
make -C packages/inference/verify vulkan-dispatch-smoke   # built-fork Vulkan graph routes (needs the linux-x64-vulkan build)
# Bench (CUDA text + ASR, RTX 5080):
~/.cache/eliza-dflash/milady-llama-cpp/build-cuda/bin/llama-bench \
  -m ~/.eliza/local-inference/models/eliza-1-1_7b.bundle/text/eliza-1-1_7b-32k.gguf -ngl 99 -p 16,512 -n 32 -fa 1
```
