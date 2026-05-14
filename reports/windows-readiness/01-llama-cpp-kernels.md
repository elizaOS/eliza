# Eliza-1 custom llama.cpp setup — research report

## 1. Where the custom llama.cpp lives

The custom fork is **`elizaOS/llama.cpp`** (https://github.com/elizaOS/llama.cpp.git), wired as a git submodule at `plugins/plugin-local-inference/native/llama.cpp` (`.gitmodules` lines 1–18). Submodule HEAD currently `ce85787c…` on the `v1.2.0-eliza` line, tracking upstream b9213. `bun install` runs `scripts/ensure-llama-cpp-submodule.mjs` to initialise it. On this checkout the submodule is **not initialised** (`git submodule status` reports `-ce85787c…` — leading minus = uninitialised). A second submodule `plugins/plugin-local-inference/native/omnivoice.cpp` carries the TTS engine that is source-fused into the same library for `*-fused` build targets.

Build entry points:
- `packages/app-core/scripts/build-llama-cpp-dflash.mjs` (3673 lines) — the main multi-target build script. `SUPPORTED_TARGETS` declares `windows-x64-cpu`, `windows-x64-cuda`, `windows-x64-vulkan`, `windows-arm64-cpu`, `windows-arm64-vulkan`, plus `windows-x64-cuda-fused` (build-llama-cpp-dflash.mjs lines 211–247).
- `packages/app-core/scripts/aosp/compile-libllama.mjs` — AOSP/Android cross-compile, same fork pin.
- `packages/app-core/scripts/kernel-patches/*.mjs` — the kernel staging hooks (mirror standalone kernels into the fork tree at build time; the fork is `git reset --hard`'d each run, so source-of-truth lives outside).
- `plugins/plugin-local-inference/native/build-omnivoice.mjs` and the `omnivoice-fuse/` graft helpers under `packages/app-core/scripts/omnivoice-fuse/`.
- `plugins/plugin-local-inference/native/verify/windows_runner.ps1` — the canonical Windows hardware verifier.

Windows-specific code paths in `build-llama-cpp-dflash.mjs` (lines 1438–1500): mingw cross from Linux *or* native MSVC on Windows; `-DBUILD_SHARED_LIBS=ON` (multi-DLL layout — `llama.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`); `-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON` on `windows-x64-cpu`; `-DGGML_OPENMP=OFF` (no mingw libomp); `-DGGML_BACKEND_DL=OFF` to embed backend init; `-DLLAMA_CURL=OFF` (cpp-httplib vendored under `llama.cpp/vendor/`); `-A ARM64` on native Windows-arm64. There is a `patchGgmlBaseForWindowsQjl` pre-build hook to resolve QJL symbols against `ggml-base` so the multi-DLL link succeeds under PE/COFF.

## 2. Custom kernels vs upstream

Custom Eliza-1 kernel families (all live in `plugins/plugin-local-inference/native/`, staged into the fork via `packages/app-core/scripts/kernel-patches/`):

- **TurboQuant** — three KV-cache quant families:
  - `turbo3` (3-bit, `GGML_TYPE_TBQ3_0`)
  - `turbo4` (4-bit, `GGML_TYPE_TBQ4_0`)
  - `turbo3_tcq` (trellis-coded 3-bit, `GGML_TYPE_TBQ3_TCQ`, required for ctx > 65536; codebook at `verify/tbq3_tcq_codebook.inc`)
- **QJL** — 1-bit Johnson–Lindenstrauss K-cache compressor; `GGML_TYPE_QJL1_256 = 46`, op `GGML_OP_ATTN_SCORE_QJL`; standalone C reference at `packages/native-plugins/qjl-cpu` (AVX2 + NEON + AVX-VNNI int8-sketch + ARM dotprod variants).
- **PolarQuant** — V-cache compressor; `GGML_TYPE_Q4_POLAR = 47`; reference at `packages/native-plugins/polarquant-cpu`.
- **Fused attention** (optional optimization, NOT in `requiredRuntimeCapabilityKeys`): `GGML_OP_FUSED_ATTN_QJL_TBQ`, `GGML_OP_FUSED_ATTN_QJL_POLAR` — fuses QJL-K score → online softmax → quantized-V mix in one kernel.
- **DFlash speculative decoding** — `--spec-type dflash` CLI surface, `dflash-draft` GGUF arch, Prometheus counters `n_drafted_total` / `n_drafted_accepted_total`.

Per-backend artifacts (each is custom Eliza source, not upstream):
- CUDA: `native/cuda/fused-attn-qjl-tbq.cu` (single .cu, gated on `-DGGML_CUDA_FUSED_ATTN_QJL=ON`).
- Metal: `native/metal/{turbo3,turbo4,turbo3_tcq,qjl,qjl_set_rows,polar,polar_preht,fused_attn_qjl_tbq,fused_attn_qjl_polar}.metal` (9 files).
- Vulkan: `native/vulkan/{turbo3,turbo3_multi,turbo3_tcq,turbo3_tcq_multi,turbo4,turbo4_multi,qjl,qjl_get_rows,qjl_mul_mv,qjl_multi,polar,polar_get_rows,polar_preht,fused_attn_qjl_tbq,fused_attn_qjl_polar}.comp` (15 shaders).
- CPU SIMD (mirrored into `ggml-cpu/qjl/` at build time): `qjl_quantize_{ref,avx2,neon}.c`, `qjl_score_{ref,i8_ref,avx2,avxvnni,neon,dotprod}.c`, plus dispatcher.
- Reference: `native/reference/turbo_kernels.{c,h}` and `native/verify/qjl_polar_ref.{c,h}` — bit-exact C references the parity gates compare against.

Legacy (deprecated) patch series at `packages/app-core/scripts/aosp/llama-cpp-patches/{qjl,polarquant}/` (9 .patch files) — the README there marks them superseded by the canonical fork on 2026-05-09.

The canonical contract list (`verify/kernel-contract.json` lines 11–18) is exactly: `dflash, turbo3, turbo4, turbo3_tcq, qjl_full, polarquant`.

## 3. Compiled backends and Windows targets

Target matrix from `build-llama-cpp-dflash.mjs` `SUPPORTED_TARGETS` (lines 150–247): linux-x64-{cpu,cuda,rocm,vulkan,sycl,openvino}, linux-aarch64-{cpu,cuda}, android-arm64-{cpu,vulkan}, android-x86_64-{cpu,vulkan}, darwin-arm64-{metal,metal-fused}, ios-arm64-{metal,simulator-metal}, **windows-x64-{cpu,cuda,vulkan}, windows-arm64-{cpu,vulkan}**, plus `*-fused` variants.

Windows-x64-cpu compile defaults (lines 1465–1486): AVX + AVX2 + FMA + F16C. AVX-512 and AVX-VNNI are explicitly NOT enabled on Windows targets (`hostHasAvxVnni()` gating at line 1407 only fires for native `linux-x64`). The fork supports it (the CPU SIMD staging in `cpu-simd-kernels.mjs` lists `qjl_score_avxvnni.c`), it is just not turned on by the Windows build flags.

The existing built artifact on this machine is at `C:\Users\Administrator\.eliza\local-inference\bin\dflash\windows-x64-cpu\` and its `CAPABILITIES.json` shows it was built from the legacy `spiritbuun/buun-llama-cpp` fork @ `6575873e` on 2026-05-10 with `qjl_full: false`, `turbo3: true, turbo4: true, turbo3_tcq: true, dflash: true`. That is the OLD pre-migration fork; it predates the `elizaOS/llama.cpp` migration. The binaries shipped are `llama-cli.exe, llama-server.exe, llama-speculative-simple.exe` plus DLLs `llama.dll, llama-common.dll, ggml.dll, ggml-base.dll, ggml-cpu.dll, mtmd.dll`. `llama-bench.exe` and `llama-completion.exe` (which `windows_runner.ps1` requires at lines 215–218 and 308–311) are **missing**.

## 4. Shipped local models and the smallest sizes

Canonical catalog: `packages/shared/src/local-inference/catalog.ts` (`ELIZA_1_TIER_IDS`, lines 20–28). Seven tiers: `0_8b, 2b, 4b, 9b, 27b, 27b-256k, 27b-1m`. First-run default = `eliza-1-2b` (line 35). For each tier the manifest lists text GGUF, ASR (Qwen3-ASR 0.6B for small tiers / 1.7B for 9B+), Silero VAD GGML, DFlash drafter, Kokoro ONNX TTS for 0_8b/2b/4b/9b, OmniVoice GGUF for 9b/27b*, mmproj vision GGUF for 4b+ (`ELIZA_1_GGUF_READINESS.md` lines 24–48 for 0_8b; same structure repeats per tier).

Smallest per-component (these are the test minimums on this box):
- Text: `eliza-1-0_8b-32k.gguf` (Qwen3.5 0.8B Q4_K_M) — the smallest. ELIZA_1_GGUF_READINESS lines 19, 25.
- Drafter: `dflash/drafter-0_8b.gguf`.
- ASR: `asr/eliza-1-asr.gguf` + `asr/eliza-1-asr-mmproj.gguf` (Qwen3-ASR-0.6B GGUF).
- TTS: Kokoro-82M ONNX `tts/kokoro/model_q4.onnx` (~80 MB int8).
- VAD: `vad/silero-vad-v5.1.2.ggml.bin` (~2 MB).

The Windows-required platform-evidence keys for `0_8b` (`ELIZA_1_GGUF_PLATFORM_PLAN.json` lines 66–90) are `windows-x64-cpu`, `windows-x64-vulkan`, `windows-arm64-cpu`, `windows-arm64-vulkan` — i.e. four Windows targets must produce evidence even for the smallest tier. No CUDA evidence is required for `0_8b` (CUDA appears at `4b`+).

On this box, only `C:\Users\Administrator\.eliza\models\qwen2.5-0.5b-instruct-q4_k_m.gguf` and `bge-small-en-v1.5.Q4_K_M.gguf` are present — both are placeholders, neither is an Eliza-1 bundle. No Eliza-1 bundle has been pulled from HuggingFace on this VM.

Downloader/cache code: `plugins/plugin-local-inference/src/services/bundled-models.ts` (APK extraction → `$ELIZA_STATE_DIR/local-inference/models/`). Manifest at `plugins/plugin-local-inference/src/services/manifest/`. HF mono-repo: `elizaos/eliza-1`, layout in AGENTS.md §2.

## 5. Runtime loading

Active plugin is **`plugins/plugin-local-inference/`** with its source under `src/`. Notable runtime modules:
- `src/services/dflash-server.ts` — spawns the patched `llama-server.exe` and proxies HTTP completions.
- `src/services/dflash-server-fused.integration.test.ts` — fused `libelizainference` integration spawn.
- `src/services/mlx-server.ts` — opt-in Apple-Silicon-only path, NOT a kernel-aware route (PLATFORM_MATRIX lines 124–141).
- `src/services/active-model.ts`, `assignments.ts`, `recommendation.ts`, `verify-on-device.ts` — bundle activation + the load-time verify pass.
- `src/services/manifest/` — manifest reader; gates activation on `kernels.required`.
- `src/runtime/`, `src/backends/` — adapter glue.

Sibling plugins:
- `plugins/plugin-aosp-local-inference/` (`src/aosp-llama-adapter.ts`, `aosp-dflash-adapter.ts`) — Android-only, JNI bridge to `libllama.so` built via `compile-libllama.mjs`.
- `plugins/plugin-local-ai/` — older / minimal local-AI shim (no `src/`, only `dist/` and `node_modules/`).
- `plugins/plugin-local-embedding/`, `plugins/plugin-omnivoice/` — voice/embedding sibling plugins (omnivoice is the legacy standalone path; new code goes through fused `libelizainference`).
- `packages/native-plugins/llama/` — Capacitor bridge for the mobile capacitor-llama adapter.

## 6. Existing kernel test coverage

`plugins/plugin-local-inference/native/verify/` is the kernel test surface. Make targets (Makefile line 16): `reference-test, kernel-contract, vulkan, vulkan-verify, vulkan-verify-multiblock, vulkan-verify-fused, vulkan-bench, vulkan-dispatch-smoke, vulkan-native-smoke, android-vulkan-smoke, metal, metal-verify, metal-verify-multiblock, metal-verify-fused, metal-bench, metal-bench-batched, cpu-dispatch-smoke, cpu-bench, cuda, cuda-verify, cuda-verify-fused, cuda-hardware, rocm-hardware, gh200-hardware, windows-hardware`.

Existing PASS evidence (PLATFORM_MATRIX lines 14–42, kernel-contract.json `platformTargets`): linux-x64-cuda, linux-x64-cuda-fused, linux-x64-vulkan, linux-x64-vulkan-fused, darwin-arm64-metal, ios-arm64-metal (audits). The four Windows targets are `compile-only` / `needs-hardware` (kernel-contract.json lines 528–557). No `windows-x64-cpu` evidence file under `verify/evidence/platform/` exists.

What's missing: no fixture-parity gate at all for native Windows; `windows_runner.ps1` is a graph-dispatch driver that requires `llama-bench.exe` and `llama-completion.exe`, which the installed binary set doesn't have. There is no `windows-verify` equivalent of `cuda-verify` / `vulkan-verify` (numerical fixture compare); the only Windows path is "build → run llama-bench against a real GGUF". CPU AVX-VNNI / AVX-512 dispatchers are written but neither tested nor enabled in the Windows build flags.

## 7. This machine and which kernel paths it exercises

- CPU: **AMD EPYC 9684X 96-Core**, 12 vCPUs exposed (`AMD64 Family 25 Model 17 Stepping 2` = Zen 4 / Genoa-X). The 9684X has full **AVX2, AVX-512 (F/CD/BW/DQ/VL/VBMI2/VNNI/BITALG/VPOPCNTDQ), VAES, BF16**, and 1152 MB L3 (3D V-Cache).
- GPU: **none**. The VM exposes only `Microsoft Basic Display Adapter` + `Microsoft Remote Display Adapter`. No NVIDIA GPU (no `nvidia-smi`/`nvcc`), no Vulkan ICD (no `vulkaninfo`/`glslc`), `$env:VULKAN_SDK` and `$env:CUDA_PATH` both unset.
- RAM: 34.35 GB. Host: QEMU `Standard PC (Q35 + ICH9, 2009)` — this is a virtualized guest.
- OS: Windows 11 build 26200, x86_64.
- Toolchains: `cl.exe`, `nvcc`, `glslc`, `vulkaninfo` all absent from PATH.

So the only kernel paths exercised on this machine are **CPU-only**: `turbo3/turbo4/turbo3_tcq/qjl/polar` reference C kernels and the AVX2 + (eligible) AVX-512 + AVX-VNNI SIMD paths under `packages/native-plugins/qjl-cpu/src/qjl_score_*.c` plus the polarquant-cpu equivalents. `dflash` runs at the CPU graph level. CUDA/Vulkan/Metal kernels are entirely untestable here without adding a Vulkan SDK + a software Vulkan ICD (which the contract treats as DIAGNOSTIC-ONLY anyway, per kernel-contract `failClosedHosts`).

## 8. Optimization opportunities specific to this box

Prioritized list of what to test/verify/optimize:

1. **Wire AVX-VNNI and AVX-512 on Windows-x64-cpu** (highest-leverage). `build-llama-cpp-dflash.mjs` line 1407–1415 only enables `GGML_AVX_VNNI=ON` for native Linux-x64. Zen 4 has AVX-512-VNNI; the `qjl_score_avxvnni.c` int8-sketch path documented at ~5.25× over fp32 (PLATFORM_MATRIX line 64) will not engage. Add a `hostHasAvxVnni()`-equivalent path in the Windows-x64 branch and enable `GGML_AVX512=ON, GGML_AVX512_VNNI=ON, GGML_AVX512_BF16=ON` for Zen 4 / Sapphire Rapids hosts.
2. **Bring the Windows binary up to current fork.** The installed `windows-x64-cpu` build is `spiritbuun/buun-llama-cpp@6575873e` from 2026-05-10 with `qjl_full: false`. Initialize the submodule, rebuild against `elizaOS/llama.cpp @ ce85787c` (`v1.2.0-eliza`), and confirm `qjl_full: true` in the new CAPABILITIES.json.
3. **Produce the missing `llama-bench.exe` and `llama-completion.exe`.** `windows_runner.ps1` lines 215–218 hard-require these; without them no hardware-recordable Windows evidence is possible.
4. **Add a `windows-cpu-verify` Make target.** Today there is no fixture-parity gate for Windows; on Linux-x64-cpu `make reference-test` + `make cpu-dispatch-smoke` cover this. Port `gen_fixture --self-test`, `cpu_qjl_polar_attn_smoke`, and `qjl_mt_check` to the Windows build set so AVX2/AVX-512/AVX-VNNI parity vs the C reference is enforced before publishing windows-x64-cpu evidence.
5. **Threadpool tuning for 12 vCPU / Zen 4 V-Cache.** `GGML_OPENMP=OFF` on Windows (line 1479) forces std::thread. With the 1152 MB L3 and 12 SMT threads on this box, the std::thread fallback should still scale, but cache-line and `--threads`/`--threads-batch` sweeps via `llama-bench` will pin the sweet spot. Avoid oversubscription — `NumberOfCores=12 == NumberOfLogicalProcessors=12` here (SMT not exposed to the guest).
6. **Quantization choice for `0_8b` on this box.** The catalog ships `Q4_K_M, Q6_K, Q8_0` for text on every tier (`ELIZA_1_GGUF_READINESS.md` lines 18, 63). With 34 GB RAM and Zen-4 AVX-512, `Q8_0` is the right "verification floor" (max numeric fidelity for fixture comparison) and `Q4_K_M` is the default product quant. Test both end-to-end with `llama-bench`.
7. **No GPU offload here** — skip `-ngl 99`, set `-ngl 0` and use `-fa 1` flash-attention CPU path. The kernel-contract `runtimeStatus.cpu` is `runtime-ready` for `qjl` and `fusedAttn` (line 175, 370) and `reference-only` for `turbo3/turbo4/turbo3_tcq/polar` standalone score (no public CPU graph op). The `--cache-type-k qjl1_256 --cache-type-v q4_polar` path is the CPU dispatch story to validate.
8. **Add this AMD EPYC 9684X host as a recorded fixture host.** The published evidence today is Intel Arrow Lake (qjl_avxvnni) and RTX 5080 sm_120 (CUDA). A Zen-4-AVX-512 fixture pass on this box would be a new device class for `windows-x64-cpu` / `linux-x64-cpu` evidence.

What you cannot test on this VM: any CUDA kernel (no GPU), any Vulkan dispatch (no driver/ICD), Metal anything (not macOS), Android NDK targets, the `*-fused` voice path under hardware load. Get any of those by either: installing a Vulkan SDK + a real GPU passthrough, attaching an NVIDIA GPU and CUDA 12.8 toolkit, or running the verify Make targets on a different host with the artifacts mounted.

### Key file:line references

- Submodule pin: `.gitmodules` lines 1–18; canonical commit `ce85787c` (current) / docs `08032d57` (stale).
- Supported targets list: `packages/app-core/scripts/build-llama-cpp-dflash.mjs` lines 150–247.
- Windows build flags: `build-llama-cpp-dflash.mjs` lines 1438–1500.
- AVX-VNNI gating: `build-llama-cpp-dflash.mjs` line 1407.
- Kernel contract: `plugins/plugin-local-inference/native/verify/kernel-contract.json` lines 3–18 (required kernels), lines 528–557 (Windows platformTargets).
- Inference AGENTS contract: `plugins/plugin-local-inference/native/AGENTS.md` §3 (mandatory optimizations), §8 (verification gates).
- Windows runner: `plugins/plugin-local-inference/native/verify/windows_runner.ps1`.
- Existing Windows artifact: `C:\Users\Administrator\.eliza\local-inference\bin\dflash\windows-x64-cpu\CAPABILITIES.json` (stale, `qjl_full: false`).
- Catalog / first-run default: `packages/shared/src/local-inference/catalog.ts` lines 18–43.
- Smallest tier definition: `ELIZA_1_GGUF_READINESS.md` lines 15–58 (0_8b).
