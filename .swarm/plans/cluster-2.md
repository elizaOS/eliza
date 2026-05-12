# Cluster 2 — Every backend & platform real (research plan)

Scope: kernel parity (Metal→CPU/CUDA/Vulkan/ROCm/Android), the full
`build-llama-cpp-dflash.mjs` + `aosp/compile-libllama.mjs` +
`ios-xcframework/build-xcframework.mjs` build matrix, MLX-as-runtime, the
TPU/NPU verdict, the Android in-process voice path, Cuttlefish/android-x86_64,
and the `kernel-contract.json` / `PLATFORM_MATRIX.md` updates.

Available HW for this swarm: local RTX 5080 (Blackwell sm_120, CUDA 12.8 at
`/usr/local/cuda-12.8`), Intel ARL / Mesa ANV iGPU (Vulkan 1.4), x86-64 CPU
(AVX2 + AVX-VNNI, 24 cores / 31 GB — RAM-contended; serialize CUDA builds);
**rentable** Nebius H200 via `packages/training/scripts/cloud/run-on-cloud.sh
--provider nebius --task … --yes-i-will-pay` (and `--provider vast` for
kernel-verify/bench on H100/B200/RTX5090 etc.). No Apple, no AMD, no Windows,
no Android phone, no GH200 in-house.

---

## A. Kernel parity — current state (the gaps)

Five required score/softmax/V-mix kernels (`turbo3`, `turbo4`, `turbo3_tcq`,
`qjl`, `polarquant`) + `dflash` + the optional `fused_attn` (QJL-K score →
online softmax → quantized-V mix). Status from `kernel-contract.json` +
`remaining-work-ledger.md`:

| Kernel | Metal | Vulkan | CUDA | CPU | ROCm | Android |
| --- | --- | --- | --- | --- | --- | --- |
| turbo3 | runtime-ready (M4 Max) | runtime-ready (Intel ANV) | runtime-ready (RTX 5080 native SASS) | reference-only (no public CPU graph op; C ref *is* the kernel) | none (no HIP port) | shader-verified (Pixel 6a/Mali; no graph dispatch) |
| turbo4 | runtime-ready | runtime-ready | runtime-ready | reference-only | none | shader-verified |
| turbo3_tcq | runtime-ready (attn-score op only) | runtime-ready (attn-score op only) | runtime-ready (attn-score op only) | reference-only | none | shader-verified |
| qjl | runtime-ready | runtime-ready | runtime-ready | **runtime-ready** (AVX-VNNI int8 + fp32 LUT) | none | shader-verified |
| polarquant | runtime-ready | runtime-ready | runtime-ready | reference-only (pre-Hadamard SIMD landed; no public CPU graph op) | none | shader-verified |
| dflash | runtime-ready | runtime-ready | runtime-ready | runtime-ready | n/a (loop, not a kernel) | runtime-ready (via spawned server) |
| fused_attn | needs-runtime-smoke (`metal_verify` has no `cases`-array fused path / `metal/fused_attn*.metal` not authored) | runtime-ready (Intel ANV, 1920/1920) | runtime-ready (RTX 5080, warp-cooperative kernel) | runtime-ready | none | n/a |

### Parity gap list (the work items)

1. **Metal fused attention** — author `metal/fused_attn_qjl_tbq.metal` +
   `metal/fused_attn_qjl_polar.metal` + `metal/polar_preht.metal` (byte-faithful
   ports of the Vulkan `.comp` shaders; design already written:
   `reports/porting/2026-05-11/metal-fused-attn-and-polar-preht-design.md`), add
   the `cases`-array path to `verify/metal_verify` so `metal-verify-fused` runs.
   *Requires an Apple-Silicon Mac to verify* → `authored-pending-hardware` until
   a Mac picks it up. Can't run here.
2. **CUDA — full `ggml-cuda` integration build** (not just the standalone
   `cuda_verify.cu` fixture parity, which is already 8/8 + 1920/1920 on the
   RTX 5080). The `fused-attn-qjl-tbq.cu` compiles clean against fork headers;
   blocker is host RAM contention (~30 GB peak on the 31 GB box with concurrent
   compilers). **Do this on the H200/H100 cloud box** (or solo on the local box
   when quiet) — `run-on-cloud.sh --provider vast --task kernel-verify --gpu
   h100 --yes-i-will-pay` then pull the JSON. Also CUDA P2 (cp.async/TMA on
   sm_90a): the ledger correctly notes the 34 B QJL / 14 B TBQ on-cache blocks
   have no 4 B alignment at a token stride — cp.async needs an aligned cache
   repack first. **Verdict: P2 is not worth doing** without the repack; document
   it. P3 (DP4A-as-default standalone QJL, `__launch_bounds__`, `__ldg`,
   vectorized loads) already landed (nsys: DP4A ~2.27× faster than fp32). Done.
3. **`turbo3_tcq` type-traits gap** — `block_tbq3_tcq` has a layout in
   `ggml-common.h` but **no `[GGML_TYPE_TBQ3_TCQ] = {...}` entry in `ggml.c`**
   (no `to_float` / `from_float_ref` / `vec_dot`), so `--cache-type-k
   turbo3_tcq` can't be wired the way `qjl1_256` / `q4_polar` are
   (`patchServerKvCacheTypeNames` adds those to the whitelist because they have
   full type traits). Today TCQ is an attention-score-only op. **Fix:** add the
   type-traits entry + a `quantize_row_tbq3_tcq_ref` / `dequantize_row_tbq3_tcq`
   pair using the Viterbi encoder + sliding-window decoder from
   `reference/turbo_kernels.c`, then extend `patchServerKvCacheTypeNames` to add
   `turbo3_tcq` to `kv_cache_types`. This is fork-side work
   (`packages/inference/llama.cpp` submodule + a new kernel-patch). Needed for
   the `27b`/`27b-256k`/`27b-1m` tiers (`requiredKernelsForContext` adds it at
   `contextLength >= 65536`). After it lands: re-run `make -C
   packages/inference/verify {vulkan,cuda}-verify` and the dispatch smokes,
   confirm a `llama-server --cache-type-k turbo3_tcq` graph build picks the new
   type. **High value, can be done here** (no special HW — Vulkan + CUDA verify
   on the local box).
4. **CPU TBQ / Polar standalone score graph op** — currently `reference-only`
   (the C ops in `reference/` ARE the references; `make reference-test` is the
   parity gate). The §3 CPU kernel-completeness build gate fails by design.
   **Verdict: leave as-is** — there is no public CPU ggml graph builder for
   these in the fork pin, and the reduced-optimization local mode
   (`MILADY_LOCAL_ALLOW_STOCK_KV=1`) is the documented hatch. Promoting them
   would require fork work that duplicates the GPU paths on CPU for no real win
   (CPU users get QJL — the bandwidth-bound win — already). Document the
   decision in the contract.
5. **ROCm / HIP port of the custom kernels** — `turbo*.cu` / `qjl*.cu` /
   `polar*.cu` aren't `#ifdef __HIPCC__`-clean; a ROCm build today is the
   canonical reduced-optimization-local-mode case. **Two-step:** (a) write
   `verify/hip_verify.cu` (compiled with `hipcc`, mirrors `cuda_verify.cu` —
   same fixture bytes, same reference, HIP `__device__` kernels, links the same
   `qjl_polar_ref.o`) so ROCm gets a backend-local numeric gate — *can be run on
   a vast.ai MI300 box*; (b) make the production `.cu` kernels HIP-compilable
   (mostly mechanical: `__hip_*` builtins, `hipLaunchKernelGGL`, no `cp.async`).
   (b) is medium effort; (a) is small. Do (a) on the cloud; (b) is a stretch
   goal — if not done, the reduced mode + the loud warning stays the ROCm story
   and the contract says so honestly.
6. **Vulkan native graph dispatch beyond Intel ANV** — runtime-ready on Mesa
   ANV (Arrow Lake) only. Need native AMD (RADV), native NVIDIA (proprietary or
   NVK), Android Adreno, Android Mali (graph dispatch — standalone fixtures
   already pass on Mali-G78). **AMD/NVIDIA: rent on vast.ai** (`--task
   kernel-verify` builds `linux-x64-vulkan` then `vulkan-dispatch-smoke`); pick
   a vast box with a desktop NVIDIA card to also cover NVIDIA-native Vulkan
   alongside the CUDA-native run. Adreno/Mali: needs a physical phone — stays
   `needs-hardware`.
7. **`fused_attn` promotion** — once a Metal fused smoke lands, add a manifest
   kernel name + add `fused_attn` to `requiredRuntimeCapabilityKeys`. Until
   then it stays an optimization-on-top (already correct in the contract).

### Verify commands to run per backend (the §8 gates)

- Local box (CPU + Intel-ANV Vulkan + RTX 5080 CUDA):
  `make -C packages/inference/verify kernel-contract reference-test cuda-verify
  cuda-verify-fused vulkan-verify vulkan-verify-multiblock vulkan-verify-fused
  vulkan-dispatch-smoke cpu-bench cpu-dispatch-smoke`
- After the `turbo3_tcq` type-traits fix: re-run `vulkan-verify cuda-verify`
  (they already have the TCQ fixture), plus a fresh `linux-x64-vulkan` /
  `linux-x64-cuda` build and a `llama-server --cache-type-k turbo3_tcq` graph
  smoke (extend `vulkan_dispatch_smoke.cpp` / `cuda_runner.sh` to assert the
  type is selectable).
- H200/H100 (cloud): `run-on-cloud.sh --provider vast --task kernel-verify
  --gpu h100 --yes-i-will-pay` → builds `linux-x64-cuda`, `cuda-verify
  cuda-verify-fused`, `cuda_runner.sh --report` → pulls JSON to
  `verify/hardware-results/`; also do the **full ggml-cuda integration build**
  there (the `linux-x64-cuda-fused` ~30 GB build that OOMs locally) and the
  e2e CUDA bench (`run-on-cloud.sh --task bench --tier 0_6b`).
- Metal: `metal-verify metal-verify-multiblock dispatch-smoke metal-verify-fused`
  — needs a Mac; document the host.
- ROCm: `verify/rocm_runner.sh --report <path>` + (new) `hip_verify` — needs an
  AMD box; rent on vast.ai if a `gfx*` box is available, else document.

---

## B. Build matrix — per-target completion plan

`SUPPORTED_TARGETS` (21 host targets + 5 `-fused`):

| Target | Build host | Plan |
| --- | --- | --- |
| `linux-x64-cpu` | local | **DONE** — verified-here; `reference-test` + `cpu-dispatch-smoke` PASS. Action: wire `probeKernels()` to read `cpu-runtime-dispatch-evidence.json` so a fresh build's `CAPABILITIES.json` reports `qjl_full` runtime-ready (build-script owner; tiny). §3 CPU kernel-completeness gate stays failing by design. |
| `linux-x64-cuda` | local (quiet) or **H200/H100 cloud** | **Run the full ggml-cuda integration build on the cloud** (`run-on-cloud.sh --provider vast --task kernel-verify --gpu h100 --yes-i-will-pay`) — RAM-safe there; the local box OOMs under concurrent load. Native sm_120 SASS wiring is done; `cuda-verify` 8/8 is done. Then `cuda_runner.sh` → real `evidence/platform/linux-x64-cuda.json`. |
| `linux-x64-rocm` | rent vast.ai MI300 if available, else **document** | `rocm_runner.sh --report` (needs `hipcc`+`rocminfo gfx*`+GGUF). Add `hip_verify.cu`. If no AMD box: keep `authored-pending-hardware`, reduced-mode story documented. |
| `linux-x64-vulkan` | local | **DONE on Intel-ANV** (`vulkan-dispatch-smoke` PASS). Action: cover native AMD + native NVIDIA Vulkan on a vast.ai box (build `linux-x64-vulkan`, `vulkan-dispatch-smoke`). |
| `linux-aarch64-cpu` | **needs arm64 Linux host** — rent vast.ai Graviton/Ampere if offered, else QEMU-user parity (already partial) | `make reference-test` + `cpu-bench` (NEON dotprod) on the arm64 host. Otherwise stays `authored-pending-hardware` (QEMU parity exists). |
| `linux-aarch64-cuda` | **needs GH200/H100-aarch64** — Nebius doesn't offer aarch64 H200; vast.ai sometimes has GH200 — rent if available | `gh200_runner.sh --report` for the `27b-256k` / `27b-1m` tiers. `27b-1m` `defaultEligible` is blocked on this. If no box: `authored-pending-hardware`, document. |
| `android-arm64-cpu` | local cross-build (`aosp/compile-libllama.mjs`, zig `aarch64-linux-musl` / NDK) — *runs but no device verify* | Cross-build here; CPU/NEON parity needs a physical Android device (`adb`). Stays `authored-pending-hardware` for device run. |
| `android-arm64-vulkan` | local cross-build | Cross-build here; standalone fixtures pass on Pixel 6a/Mali; built-fork graph dispatch evidence (`ELIZA_ANDROID_VULKAN_GRAPH_EVIDENCE`) + Adreno needs a phone. `authored-pending-hardware`. |
| `darwin-arm64-metal` (+`-fused`) | **needs macOS+Xcode** | `metal-verify metal-verify-multiblock dispatch-smoke metal-verify-fused` (after the Metal fused kernel lands) + full latency/RSS/thermal gates against a staged bundle. Document the host. |
| `ios-arm64-metal` (+`-simulator`) | **needs macOS+Xcode** | `build-xcframework.mjs --verify` PASS; `run-physical-device-smoke.mjs` 3/3 PASS on iPhone 15 Pro. Remaining P0: weight-backed Eliza-1 bundle smoke from the Capacitor shell. Document. |
| `windows-x64-{cpu,cuda,vulkan}` (+`cuda-fused`) | **needs native Windows** (cross-built `.exe` not counted) | `windows_runner.ps1 -Backend … -Model …`. Cross-build configs exist; document the Windows host need. |
| `windows-arm64-{cpu,vulkan}` | **needs Snapdragon X / Copilot+ PC + MSVC arm64** | `windows_runner.ps1`. Cmake plumbing exists; needs MSVC arm64 cross-toolchain or native host. Document. |
| `linux-x64-cpu-fused` | local | **DONE** — `OMNIVOICE_FUSE_VERIFY.json ok=true`; merged HTTP route (`/completion` + `/v1/audio/speech` same PID) verified. Remaining: weight-backed `/v1/audio/speech` smoke against a real `tts/omnivoice-*.gguf` (Cluster 3 provides the bytes). |
| `linux-x64-cuda-fused` | **H200/H100 cloud** (~30 GB peak, OOMs locally) | Build solo on the cloud box; `OMNIVOICE_FUSE_VERIFY.json`; the fused `llama-server` GPU TTS RTF + `e2e_loop_bench.mjs`. |
| `linux-x64-vulkan-fused` | local (lighter than CUDA-fused — should fit; run solo) | Build it here; weight-backed `/v1/audio/speech` smoke. |
| `darwin-arm64-metal-fused` | **needs macOS** | Built-fork graph-dispatch smoke + full latency/RSS/thermal. Document. |
| `windows-x64-cuda-fused` | **needs native Windows + NVIDIA** | After the Windows-CUDA runner passes. Document. |

### New target: `android-x86_64-{cpu,vulkan}` (+`-fused`)

**Verdict: yes, it's a real target — add it.** Evidence: `aosp/compile-libllama.mjs`
already builds an `x86_64` ABI (`androidAbi: "x86_64"`, `zigTarget:
"x86_64-linux-musl"`) for Cuttlefish + emulators, `smoke-cuttlefish.mjs` is a
real end-to-end harness ("Works for both x86_64 cuttlefish and a real arm64-v8a
device"), and `apps/app/android/.../assets/agent/<abi>/` carries per-ABI
libllama. Use cases: Chromebooks (ChromeOS Android subsystem), CI smoke
(no-device validation), Android emulator dev. **Plan:**

1. Add `android-x86_64-cpu`, `android-x86_64-vulkan`, `android-x86_64-cpu-fused`
   to `SUPPORTED_TARGETS` in `build-llama-cpp-dflash.mjs` (and the `-fused` set)
   — or, since AOSP libllama is built by `compile-libllama.mjs` not the dflash
   hook, register the x86_64 ABI as a first-class target there with the same
   kernel patches the arm64 path gets. Reconcile: `compile-libllama.mjs` already
   has the `x86_64` ABI entry — make sure the metal/vulkan/cpu kernel patches
   (`kernel-patches/*.mjs`) and the dflash-drafter-arch patch apply on it.
2. Run the **Cuttlefish smoke** here: bring up `cvd` (the
   `aosp/smoke-cuttlefish.mjs` + `avd-test.mjs` + `boot-validate.mjs`
   harnesses), push the `x86_64` libllama + a small GGUF, run the 8-step smoke
   (cvd up → APK installed → service starts → `/api/health` → bearer token →
   chat round-trip → `/api/local-inference/active` shows `ready` with a real
   modelId → not cloud-routed). This is **runnable on the local box** (cvd runs
   on x86_64 Linux under KVM). Make `reports/porting/.../cuttlefish-x86_64-smoke.md`
   a real artifact (the report files referenced in the task brief).
3. Vulkan-on-Cuttlefish: cvd exposes a virtio-gpu Vulkan ICD (gfxstream /
   SwiftShader depending on build) — try `vulkan-dispatch-smoke` against it;
   document whether it's a real Vulkan path or falls back to SwiftShader (the
   latter doesn't produce recordable evidence per the fail-closed rule). The CPU
   path is the dependable Cuttlefish path.
4. Add `android-x86_64-{cpu,vulkan}` to `kernel-contract.json`'s
   `platformTargets` and `PLATFORM_MATRIX.md` with the cvd smoke command and the
   honest status (`verified-here` for the cpu cvd smoke if it passes,
   `needs-hardware` for the Vulkan graph dispatch on real ChromeOS Adreno/Mali).

---

## C. MLX backend — as a runtime path

Current state: `plugin-mlx` (`@elizaos/plugin-mlx`) is an **HTTP client over
`mlx-lm.server`** (OpenAI-compatible, `@ai-sdk/openai-compatible`) — exactly
like `plugin-ollama` / `plugin-lmstudio`. It registers `text-large`,
`text-small`, `embedding` capabilities and resolves models from `GET
/v1/models`. It is **not** a kernel-aware in-process runtime and it does **not**
route the voice pipeline.

**Plan — make it a real, registered, kernel-aware path for the eliza-1 text
model on macOS (alongside Metal-llama.cpp):**

1. **Registration / routing:** the local-inference engine should be able to pick
   `mlx-lm.server` as the text backend on Apple Silicon when the user has
   `mlx-lm` installed and a quantized eliza-1 text model in MLX format. Add an
   MLX adapter under `packages/app-core/src/services/local-inference/` (mirror
   the `dflash-server` spawn-and-route shape but for `mlx_lm.server`) so the
   engine spawns + health-checks it, not just `plugin-mlx` doing AI-SDK calls.
2. **Kernel-awareness reality check:** MLX has its own quantization (4-bit /
   8-bit affine, GPTQ-ish, no TurboQuant/QJL/PolarQuant). It **cannot** satisfy
   the §3 mandatory-kernel contract — there is no TurboQuant K/V cache, no QJL,
   no Polar in MLX. So MLX is **not** a `defaultEligible` path; it's the same
   class as the reduced-optimization local mode (or a user-installed custom).
   `manifest.kernels.verifiedBackends` would never have `mlx: pass`. Document
   this clearly: MLX is "works-on-Apple-Silicon-without-the-fork-build" — a
   convenience path, not a publish path. Bundle an `mlx` quant of the eliza-1
   text weights as an *optional* artifact in the macOS bundle if (and only if)
   Cluster 3 produces one; otherwise MLX runs against user-supplied MLX models.
3. **Voice routing:** MLX doesn't carry OmniVoice/Qwen3-ASR — there's an
   `mlx-audio` project but it's not wired here. **Verdict: do NOT route the voice
   pipeline through MLX** in this wave; the fused `llama-server` (Metal) /
   in-process FFI is the voice path on Apple. Document why.
4. **Build/test:** no Apple HW here — wire the adapter + the engine routing +
   unit tests (mock the `/v1/models` + `/v1/chat/completions` shape), document
   that a Mac with `mlx-lm` installed is needed for the live smoke. The plugin
   itself already builds + has `__tests__/`.

---

## D. TPU / NPU verdict

Researched: Coral Edge TPU (USB/M.2, ~4 TOPS int8, **8 MB on-chip SRAM**, TF
Lite int8 only, no float, no transformers-friendly ops at scale), Pixel Tensor
G-series TPU/EdgeTPU (the on-SoC NPU, exposed via Android NNAPI / Google's
private "Edge TPU" delegate — not generally programmable; NNAPI is being
deprecated by Google in favor of per-vendor delegates), Qualcomm QNN / Hexagon
NPU (the real Android NPU story going forward — `onnxruntime` has a QNN EP).

**Verdict for the text model:** **No.** The eliza-1 text backbone (0.6B
smallest, fp16/Q4) does not fit an Edge TPU's 8 MB SRAM; it's not int8-only
quantizable to the Coral's constraints; transformer KV-cache attention is not an
Edge TPU workload. Not worth it. The Pixel Tensor TPU could in principle run a
small int8 transformer but there's no public delegate API to target it from a
third-party app, and the GPU (Mali/Adreno via Vulkan) is the right Android
accelerator for the text model — which we already target. NNAPI is deprecated.

**Verdict for the sidecars:** **Marginal — not worth wiring in this wave, but
keep the door open for Silero VAD.**
- **Silero VAD** (~2 MB ONNX, runs in <1 ms on a phone CPU already): a QNN/NNAPI
  EP would shave maybe 0.3 ms — *not worth it*; the VAD is not the bottleneck.
  The one real angle: a QNN EP would let the VAD run on the NPU island while the
  CPU sleeps, saving battery in always-listening wake-word mode. That's a
  battery optimization, not a latency one — defer.
- **Qwen3-ASR-0.6B** (the ASR sidecar): too big / too dynamic-shape for an Edge
  TPU; QNN could run it on the Hexagon NPU in principle but it's a Whisper-class
  encoder-decoder — the ONNX→QNN conversion is non-trivial and the win over the
  Vulkan path (which we already build) is uncertain. **Defer.**
- **Qwen3-Embedding-0.6B**: same story — runs fine on the GPU/CPU; no Edge TPU
  fit; QNN possible but unproven. **Defer.**
- **OmniVoice TTS**: it's fused into the llama.cpp build (one GGML pin) — pulling
  it onto a separate NPU breaks the fusion contract (§4: one process, one build).
  **No.**

**Recommendation:** document the verdict in `PLATFORM_MATRIX.md` /
`needs-hardware-ledger.md` as "TPU/NPU: not a target this wave — the text model
doesn't fit, the sidecars don't win enough; the Android GPU (Vulkan) is the
on-device accelerator; a QNN EP for Silero VAD in always-listening mode is a
future battery optimization, not a latency one." Do **not** add a TPU backend or
a `plugin-coral` / `plugin-qnn`. If the swarm wants a token gesture: a feature
flag `ELIZA_VAD_QNN_DELEGATE=1` that, when `onnxruntime` is built with the QNN
EP, runs Silero VAD on the NPU — but that's stretch, not core.

---

## E. Android in-process voice path

Current state (`AGENTS.md` §4, `aosp-dflash-adapter.ts`,
`aosp-llama-adapter.ts`): the Android path runs **in-process** (AOSP adapter +
Capacitor framework), not by spawning `llama-server` on a phone — *except* the
DFlash spec-decode currently uses **path a** (cross-compile `llama-server`
itself, have bun spawn it as a localhost child process — "cheaper to validate")
rather than **path b** (bind `common_speculative_*` through `aosp/llama-shim`
into the in-process libllama). `voiceTextRunner()` adapts either onto the
`DflashVoiceTextRunner` contract; the voice bridge takes the in-process text
runner via `LocalInferenceEngine.runVoiceTurn({ textRunner })`.

**Plan — make mic→VAD→ASR→dflash text→TTS actually work on a Pixel:**

1. **`android-arm64-{cpu,vulkan}-fused` build targets** in
   `build-llama-cpp-dflash.mjs` (or in `compile-libllama.mjs` with the
   omnivoice-fuse graft) so `libelizainference` (OmniVoice TTS + Qwen3-ASR) is
   carried inside the AAR alongside `libllama.so`. Today `omnivoice-fuse/prepare.mjs`
   builds the fused lib on a macOS/Linux host but not the Android cross-targets.
   Add the NDK cross-build of `omnivoice-core` + the fused server. **Cross-build
   can be done on the local box** (NDK + zig); device verify needs a phone.
2. **Capacitor bridges:** the `Microphone` plugin → `PushMicSource`, a native
   `AudioTrack` sink → `PcmRingBuffer`, and `onnxruntime-mobile` (or the
   Capacitor ONNX bridge) for Silero VAD instead of `onnxruntime-node`.
   `plugin-capacitor-bridge` already has `mobile-device-bridge-bootstrap.ts` —
   extend it with the mic/audio/ONNX wiring. Wire it so `LocalInferenceEngine`'s
   voice bridge gets the mobile mic source + sink.
3. **Path b — the `common_speculative_*` shim:** implement
   `aosp/llama-shim/eliza_llama_shim.c` exporting `common_speculative_init`,
   `_gen_draft`, `_add_draft`, `_free` (or the exact `common_speculative_*` ABI
   the fork's `llama-server` uses) backed by the in-process libllama, so the
   DFlash spec loop runs in-process with no localhost server. Then
   `AospDflashAdapter` prefers the shim path over the spawn path when the shim is
   present (`compile-shim.mjs` already exists for the seccomp shim — add the
   llama-shim build). Path a stays as the fallback. Capture the tok/s delta
   (the adapter comment says the path-a number "informs whether path b is worth
   it" — it is, because spawning a server on a phone wastes RAM + a port + cold
   start).
4. **One-documented-step Pixel deploy:** an `aosp/deploy-pixel.mjs` (or extend
   `build-aosp.mjs --launch`) that: builds `android-arm64-vulkan-fused`
   libllama+libelizainference, builds the AAR, runs the Android Studio / Gradle
   build, `adb install`, launches, runs the voice smoke. Document it in
   `docs/apps/` or the AOSP README.
5. Verify what we can here (cross-builds, unit tests, the Cuttlefish CPU smoke
   for the in-process text path); the phone-on-the-bench bits stay
   `authored-pending-hardware` with the exact `adb` command.

---

## F. Cuttlefish / android-x86_64

Covered in §B's "new target" block. Summary: **make `android-x86_64-cpu` a real,
runnable target** — the `cvd` smoke (`aosp/smoke-cuttlefish.mjs` +
`avd-test.mjs` + `boot-validate.mjs` + `e2e-validate.mjs`) runs on the local
x86_64 Linux box under KVM; produce `reports/porting/.../cuttlefish-x86_64-smoke.md`
as a real artifact with the 8-step pass; add it to the build matrix +
`kernel-contract.json`. The Vulkan-on-Cuttlefish path is best-effort
(gfxstream/SwiftShader — document whether it's a real Vulkan ICD or a software
fallback; software doesn't produce recordable evidence). `android-x86_64-vulkan`
on real ChromeOS hardware (Adreno/Mali under ARCVM) stays `needs-hardware`.

---

## G. `kernel-contract.json` / `PLATFORM_MATRIX.md` / `AGENTS.md` updates

After the work above lands, update — honestly, no fabrication:

- `kernel-contract.json`: add `android-x86_64-{cpu,vulkan}` (and the `-fused`
  variants if added) to `platformTargets` with their `nextGate`; bump
  `targets` count; if `turbo3_tcq` gets type traits, add a `cpuKvCacheType` /
  whitelist note; if a Metal fused smoke lands, promote `fused_attn` to
  `requiredRuntimeCapabilityKeys` + add a manifest kernel name; update
  `runtimeStatus.*` for any backend that newly verifies (CUDA full ggml-cuda
  build, native AMD/NVIDIA Vulkan, ROCm `hip_verify`).
- `PLATFORM_MATRIX.md`: add the `android-x86_64` rows; flip `linux-x64-cuda`
  full-integration-build status when the cloud build lands; add the ROCm
  `hip_verify` line; add the MLX note (convenience path, not publishable);
  add the TPU/NPU verdict line.
- `needs-hardware-ledger.md`: add `android-x86_64-vulkan` (ChromeOS GPU);
  remove `linux-x64-cuda` full build if the cloud run clears it; update the
  ROCm row (`hip_verify` added or not); the TPU verdict note.
- `AGENTS.md` §3 / §4: note `turbo3_tcq` as a real cache type once the traits
  land (the §3 "reduced mode" caveat about TCQ would shrink); note the
  `android-x86_64` / Cuttlefish path; note MLX is a non-publishable convenience
  runtime; note path-b shim for Android voice.
- `RELEASE_V1.md` / `RELEASE_V1` doc: update the per-platform×per-backend status
  table.

---

## H. Cross-cluster dependencies

- **Cluster 3 (models):** the build matrix's `-fused` weight-backed
  `/v1/audio/speech` smokes, the CUDA `llama-bench` text/ASR throughput numbers,
  the verify-on-device passes, and any MLX-quant artifact all need **real
  fork-built GGUF bytes** (text + OmniVoice TTS + Qwen3-ASR + Silero VAD +
  embedding + the DFlash drafter per tier). Cluster 2 can't produce
  `evidence/platform/*.json status: pass` without Cluster 3's bytes. The
  `turbo3_tcq` type-traits fix is a prereq for the `27b`/`27b-256k`/`27b-1m`
  tiers Cluster 3 builds. Coordinate: Cluster 2 produces the kernel-complete
  `llama-server` per backend; Cluster 3 produces the bundle bytes; the
  verify-on-device + publish gates run on the join.
- **Cluster 4 (structured decode + fused streaming):** the fused build
  (`*-fused` `libelizainference`, the `omnivoice-fuse` ABI) is where Cluster 4's
  **W7 streaming decoders** (`eliza_inference_{asr,tts}_stream_*`,
  `set_verifier_callback`) live — currently honest stubs. Cluster 2 owns the
  build/cross-compile of the fused lib for every target (incl. Android/iOS);
  Cluster 4 owns the streaming decoder implementation inside it. The
  `madvise(MADV_DONTNEED)` RSS trim rides on Cluster 4's work. The guided
  structured decode is HTTP-surface (server-side, `server-structured-output.mjs`)
  — Cluster 2's build hooks already wire `server-omnivoice-route.mjs` and
  `server-structured-output.mjs`; coordinate so the Cluster 4 GBNF/token-inject
  changes don't break the fused-server build.
- **Cluster 5 (e2e duet + emotion):** the e2e duet harness needs the
  kernel-complete `llama-server` (Cluster 2) + the real bundle (Cluster 3) + the
  structured decode + fused streaming (Cluster 4). Cluster 2's verify-on-device
  + 30-turn endurance + the latency instrumentation feed Cluster 5's report. The
  reduced-optimization fallback (Cluster 2's `MILADY_LOCAL_ALLOW_STOCK_KV=1`) is
  the "if a backend can't dispatch" path Cluster 5's harness must exercise.
- **Cluster 1 (hygiene):** the `vulkan-dispatch-smoke` not-compiling-against-the-
  fork-pin issue is on Cluster 1's list — already reconciled (the harness now
  `#include`s only the two builders the fork pin exports). Cluster 2's
  build-matrix work must keep `bunx tsc --noEmit` / `biome` green on the build
  scripts + the new adapters.

---

## I. What can actually be done in this wave (the honest line)

**Runnable here (local RTX 5080 + Intel ANV + CPU + KVM-for-Cuttlefish):**
- `turbo3_tcq` type-traits fix + re-verify (Vulkan + CUDA verify, dispatch
  smoke, `--cache-type-k turbo3_tcq` graph build).
- `android-x86_64-cpu` target + the Cuttlefish `cvd` smoke → real artifact.
- `android-arm64-{cpu,vulkan}-fused` cross-builds (NDK) — build only, no device.
- Path-b `common_speculative_*` shim implementation + the AOSP adapter wiring.
- Capacitor mic/audio/ONNX bridge wiring + unit tests.
- MLX adapter + engine routing + unit tests (no Mac smoke).
- `hip_verify.cu` source (no AMD box to run it — author + document).
- All the doc/contract updates.

**On the rented cloud box (vast.ai / Nebius H200 — `--yes-i-will-pay`):**
- Full `ggml-cuda` integration build (`linux-x64-cuda` + `linux-x64-cuda-fused`)
  — the ~30 GB build that OOMs locally → `evidence/platform/linux-x64-cuda.json`.
- e2e CUDA bench (`--task bench --tier 0_6b`).
- Native NVIDIA-desktop Vulkan graph dispatch (pick a vast box with a desktop
  NVIDIA GPU).
- ROCm `rocm_runner.sh` + `hip_verify` if a `gfx*` vast box is available.
- `linux-aarch64-cuda` / GH200 if vast.ai has a GH200 (rare).

**Stays `authored-pending-hardware` / `needs-host` (documented, not faked):**
- Metal (`darwin-arm64-metal*`, `ios-arm64-metal*`) — needs macOS+Xcode.
- Windows (`windows-x64-*`, `windows-arm64-*`) — needs native Windows / Snapdragon X.
- Android phone graph-dispatch + voice smoke (Adreno + Mali) — needs a Pixel.
- `linux-aarch64-cpu` — needs an arm64 Linux box (QEMU parity exists).
- TPU/NPU — not a target (verdict documented).

---

## Revision notes (after cross-reading sibling plans)

As of this writing no sibling cluster plan had landed in `.swarm/plans/` yet
(Cluster 2 is first). The cross-cluster dependencies in §H are written from the
master `.swarm/TODO.md` and the binding contracts (`packages/inference/AGENTS.md`,
`packages/training/AGENTS.md`) rather than from a sibling plan. Key handshakes to
re-confirm once siblings publish:

- **Cluster 3** owns producing the real fork-built GGUF bytes (text/vision +
  OmniVoice TTS + Qwen3-ASR + Silero VAD + embedding + per-tier DFlash drafter).
  Cluster 2 cannot flip any `evidence/platform/*.json` to `status: pass` or run
  the weight-backed `/v1/audio/speech` smokes / verify-on-device passes without
  those bytes. The `turbo3_tcq` type-traits fix (§A.3) is a hard prereq for the
  `27b`/`27b-256k`/`27b-1m` tiers Cluster 3 builds — sequence it first.
- **Cluster 4** owns the W7 streaming decoders + `set_verifier_callback` + the
  guided-structured-decode GBNF/token-inject changes; Cluster 2 owns the
  build/cross-compile of the fused `libelizainference` for every target (incl.
  Android/iOS) that those land inside. The fused-server build must stay green
  through Cluster 4's `server-structured-output.mjs` / `server-omnivoice-route.mjs`
  changes — coordinate the patch order.
- **Cluster 5**'s e2e duet harness consumes the kernel-complete `llama-server`
  (C2) + the real bundle (C3) + structured decode + fused streaming (C4); C2's
  verify-on-device + 30-turn endurance + latency instrumentation feed C5's
  report. C5 must exercise the reduced-optimization fallback
  (`MILADY_LOCAL_ALLOW_STOCK_KV=1`) path C2 owns.
- **Cluster 1** keeps the build scripts + new adapters `tsc`/`biome` clean and
  has the `vulkan-dispatch-smoke`-vs-fork-pin reconciliation (already done).

This section should be re-revised when the synthesis agent merges all plans into
`.swarm/IMPLEMENTATION_PLAN.md`.
