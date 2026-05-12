# Eliza-1 end-to-end audit — what is real, what is left, per tier — 2026-05-12

> **Scope.** One report that audits the full eliza-1 line across every
> phase (training, inference, download, serving, evaluation, benchmarking)
> and every tier. Every cell cites the source file or HF URL the verdict
> comes from. No fabricated passes; honest `needs-hardware` / `needs-data`
> entries where reality is unmeasured. Companion to (not replacement for)
> the live punch lists in
> [`../2026-05-11/remaining-work-ledger.md`](../2026-05-11/remaining-work-ledger.md),
> [`../2026-05-11/needs-hardware-ledger.md`](../2026-05-11/needs-hardware-ledger.md),
> and the swarm `/.swarm/STATUS.md`.

## 0. Status as of 2026-05-12

### 0.1 Hard greens (verified on real hardware this wave)

- **Verify matrix on this box (Intel Core Ultra 9 275HX + Intel ARL Mesa
  ANV + RTX 5080 sm_120, CUDA 12.8 at `/usr/local/cuda-12.8`):**
  `make -C packages/inference/verify kernel-contract reference-test cpu-bench
  cpu-dispatch-smoke vulkan-dispatch-smoke vulkan-verify vulkan-verify-multiblock
  vulkan-verify-fused cuda-verify cuda-verify-fused` — every target PASS,
  nothing regressed. `OK kernels=6 targets=26 manifestNames=6`. Evidence:
  [`packages/inference/verify/PLATFORM_MATRIX.md`](../../../verify/PLATFORM_MATRIX.md)
  "Verify status as of 2026-05-12".
- **Build matrix on this box:** `linux-x64-cpu` + `linux-x64-cpu-fused` ldd-clean
  (rpath `$ORIGIN`); `darwin-arm64-metal-fused` symbol-verified on M4 Max
  from prior passes; `android-x86_64-cpu` cross-build PASS (real x86_64 Android
  ELF, `interpreter /system/bin/linker64`, fork commit `536ff214`,
  `CAPABILITIES.json` `qjl_full`/`polarquant` true) — see
  [`cuttlefish-x86_64-smoke.md`](./cuttlefish-x86_64-smoke.md).
  `linux-x64-cuda-fused` and Vulkan/Metal `-fused` Linux + iOS builds NOT
  built here (RAM-contended; needs a quiet box or cloud).
- **Test green on this box:** `bun run verify` 310/310; `bun run build`
  190/190; `bun run test` (`@elizaos/app-core` 973/13 skipped/0 failed);
  `pytest packages/training/scripts/` 552 passed. (.swarm/STATUS.md §
  "FINALIZE-2".)
- **Fork bump:** `elizaOS/llama.cpp` `v1.1.0-eliza` (`9bb08843`) — fixes the
  `GGML_OP_COUNT` static_assert that broke every `dflash` build after the
  W4-B kernel merge. Bumped in `packages/inference/llama.cpp` gitlink +
  `build-llama-cpp-dflash.mjs` REF default + `aosp/compile-libllama.mjs`
  `LLAMA_CPP_TAG`. (`d17e43eaca`.)
- **Cuttlefish (cvd) `android-x86_64-cpu` smoke 5/6 infra steps PASS** —
  cvd reachable, APK installed abi=x86_64, ElizaAgentService start,
  `/api/health` agentState=running runtime=ok, bearer token. Step 6 (chat
  completion) failed because no model is staged in the release APK on the
  cvd — needs a `build-aosp.mjs --launch --boot-validate` rebuild that
  carries `android-x86_64-cpu` libllama + a bundled `eliza-1-smoke` GGUF.
- **iOS device smoke 3/3 XCTest PASS on iPhone 15 Pro / iOS 26.3.1** —
  Metal availability + runtime symbol resolution + `libelizainference` ABI
  v1 shape, `--skip-voice-abi=false`. Evidence
  `verify/hardware-results/ios-device-smoke-2026-05-11.json`. Weight-backed
  Capacitor-shell smoke remains.

### 0.2 In flight right now

- **H200-QWEN35-SFT 0_8b** (the new Qwen3.5-0.8B-Base small tier): live
  Nebius training, watched by `/tmp/nebius-finish-q35-0_8b.sh`
  (pids 3236359 / 3241719 / 3241720 visible) — `train_nebius.sh full` was
  re-launched on `--tier 0_8b` against the combined corpus
  (`datasets/eliza1-sft-0_6b/` + `data/final/`, `ELIZA1_FULLCORPUS_UPSAMPLE=8`).
  See [`packages/training/reports/eliza1-training-qwen3.5-migration-2026-05-12.md`](../../../../training/reports/eliza1-training-qwen3.5-migration-2026-05-12.md).
- **Local 0.6b APOLLO full-corpus SFT** (legacy Qwen3-0.6B,
  `eliza-1-0_6b-apollo-fullcorpus-1778563093`): resumed from
  checkpoint-1000 on the RTX 5080; `run_pipeline.py` auto-chains
  bench/quant/eliza1-bundle on completion (`--skip-publish`; publish hook
  gates on `format_ok ≥ 0.70`). This is the legacy line — the Qwen3.5-0.8B
  H200 run above is the directive-aligned replacement.
- **Working-tree edits not yet committed (`git status -s`):**
  `model_registry.py`, `train_nebius.sh`, `cloud/run-on-cloud.sh`,
  `packages/inference/llama.cpp` (gitlink), `.gitignore` — part of the
  Qwen3.5 migration; not lost (operator instruction: commit current state
  before going dark).

### 0.3 The big known-reds (root-caused, blocked on hardware/operator)

| Item | Why blocked | Owner / lane |
| --- | --- | --- |
| CPU `qjl1_256` + `q4_polar` fused-attn segfault on warmup forward | WS-2 SIMD attention-kernel bug. Repro: `llama-server -m text.gguf --cache-type-k qjl1_256 --cache-type-v q4_polar` → Segfault. `eliza-1-0_6b.bundle` `evals/cpu_reference.json` records `status:"fail"`. **Blocks `voice:duet` CPU baseline**. | CPU-KERNEL-DEBUG (#56) |
| Fork guided-decode fast-forward (server-task/server-context/llama-grammar splice path) + W7 streaming decoders (`omnivoice-stream.cpp` / `omnivoice-asr-stream.cpp` + the special-token-map probe) + `spec-loop → EliVerifierEvent` wiring | ~500 lines of careful C++ on `elizaOS/llama.cpp` off `v1.1.0-eliza` — not yet authored. | FORK-GUIDED-DECODE (#58) |
| `linux-x64-cuda-fused` full ggml-cuda + omnivoice graft build | ~30 GB peak RAM; the 31 GB authoring box OOM-kills it under any concurrent load. Unblocks the GPU TTS/ASR RTF numbers in the harness bench. | CUDA-FULL-BUILD (#57) (needs a quiet host or cloud) |
| NDK omnivoice-fuse graft for `android-{arm64,x86_64}-*-fused` targets | `aosp/compile-libllama.mjs` doesn't run the graft yet — `FUSED_TARGETS` in `build-llama-cpp-dflash.mjs` lists the Android-fused triples but the AOSP cross-build wiring is unwritten. | NDK-FUSED-ANDROID (#59) (NDK present) |
| Headless `nebius iam whoami` browser-SSO + no live vast.ai key → no in-agent dispatch | Operator-gated; once auth lands: `bash packages/training/scripts/cloud/run-on-cloud.sh --provider <vast|nebius> --task <build|kernel-verify> --gpu h200 --yes-i-will-pay`. | operator |

### 0.4 HF state (this is the source of truth — checked via `HfApi.list_models / list_datasets`, 2026-05-12)

**Bundle repos (`elizaos/eliza-1-<tier>`):** `0_6b`, `1_7b`, `4b` (gitattributes
only), `9b`, `27b`, `27b-256k`, `27b-1m`. All public; `releaseState` per the
README cards = `local-standin` / `base-v1-candidate` / not `defaultEligible`.

- `eliza-1-0_6b` and `eliza-1-1_7b`: README cards declare `base-v1-candidate`
  with the **frozen `elizaos/eliza-1-assets` bytes** for voice/ASR/VAD/cache
  + the upstream Qwen3-0.{6,1.7}B base text + a **real SFT** Q4_K_M GGUF
  (PolarQuant / QJL / TurboQuant **not yet applied** to that GGUF — sidecars
  carry the configs; runtime kernels exist; the fork's
  `convert_hf_to_gguf.py` doesn't emit `q4_polar` yet).
- `eliza-1-9b` / `eliza-1-27b` / `27b-256k` / `27b-1m`: README + `manifest.json`
  skeletons only; no GGUF blobs uploaded. Hard-blocked on the fork-built
  GGUFs + per-backend hardware evidence + base-v1 evals.
- `eliza-1-4b`: gitattributes only — placeholder repo, no card, no manifest.
  Legacy Qwen3 tier; the Qwen3.5 directive plans `Qwen/Qwen3.5-4B` here.
- **`eliza-1-0_8b` repo does not exist yet** — the new smallest Qwen3.5
  tier landed in the catalog/manifest/registry on `develop` but has no HF
  presence. (The H200 SFT now in flight is the first artifact that goes
  here.)

**Companion repos:** `eliza-1-<tier>-{optimized,drafter,sft}` for
`0_6b`/`1_7b`/`9b`/`27b` — all created, README-only.
`eliza-1-0_6b-sft-weights` — the published Qwen3-0.6B test-SFT
**candidate** (8k slice, 1 epoch; HF-transformers Q4_K_M GGUF; not
`defaultEligible`, not the `recommended` channel). `eliza-1-drafter-0_6b-qwen3_5`
— scaffold for the new Qwen3.5-0.8B-Base-distilled drafter (9 files,
distill-manifest.json + config.json; no GGUF yet). `eliza-1-assets`
(2026-05-11) — frozen voice/ASR/VAD/cache bytes shared by every tier.

**Dataset repos:** `eliza-1-{training,0_6b-sft,sft-0_6b,evals}` — all
public, all refreshed 2026-05-12 (`evals` carries the master harness
benchmark + the kernel-verify evidence + the per-backend bench tables).

---

## 1. The tier lineup — canonical sources

The matrix-of-record lives in three files that must stay in sync (the
`covers every manifest tier` test enforces it):

1. `packages/shared/src/local-inference/catalog.ts` →
   `ELIZA_1_TIER_IDS = ["eliza-1-0_8b","eliza-1-0_6b","eliza-1-1_7b","eliza-1-9b","eliza-1-27b","eliza-1-27b-256k","eliza-1-27b-1m"]`.
   `FIRST_RUN_DEFAULT_MODEL_ID = "eliza-1-1_7b"` (the
   `TODO(owner)` to flip to `0_8b` is open).
2. `packages/training/scripts/manifest/eliza1_manifest.py` →
   `ELIZA_1_TIERS = ("0_8b","0_6b","1_7b","9b","27b","27b-256k","27b-1m")`.
3. `packages/training/scripts/training/model_registry.py` — REAL entries:
   `qwen3.5-0.8b → eliza-1-0_8b` (Qwen/Qwen3.5-0.8B-Base);
   `qwen3-0.6b → eliza-1-0_6b` (Qwen/Qwen3-0.6B — legacy);
   `qwen3-1.7b → eliza-1-1_7b` (legacy);
   `qwen3-4b → eliza-1-4b` (legacy, no published bundle yet);
   `qwen3.5-2b → eliza-1-2b` (new, NOT in `ELIZA_1_TIER_IDS` yet —
   gap with the manifest);
   `qwen3.5-9b → eliza-1-9b`;
   `qwen3.6-27b → eliza-1-27b` + `27b-256k` / `27b-1m` context variants.

**Directive (2026-05-12, operator):** drop the Qwen3 tiers (`0_6b`/`1_7b`/`4b`)
and use Qwen3.5 everywhere. **The migration is partway:** the new
`0_8b` is wired through catalog/manifest/registry/platform-plan/cloud
scripts — the legacy `0_6b`/`1_7b` tiers are still wired through them
**additively**, and `FIRST_RUN_DEFAULT_MODEL_ID` is still on `eliza-1-1_7b`.
See `.swarm/STATUS.md` "FINALIZE-2" + `packages/training/reports/eliza1-training-qwen3.5-migration-2026-05-12.md`
for the migration audit. `eliza-1-2b` is in the model registry but not yet
in `ELIZA_1_TIER_IDS` / the platform plan — needs to be added for the
final lineup.

DFlash drafter base (per `model_registry.py::DFLASH_DRAFTER_BASE`): Qwen3.5/3.6
targets (2b/9b/27b/27b-256k/27b-1m) distill DOWN from
`Qwen/Qwen3.5-0.8B-Base`; legacy Qwen3 targets (1_7b/4b) draft from
`Qwen/Qwen3-0.6B`. `0_6b` and `0_8b` ship no drafter (smallest tiers).

### Companion bundle components per `catalog.ts::sourceModelForTier`

| Component | Default source |
| --- | --- |
| Voice / TTS | `Serveurperso/OmniVoice-GGUF` (`omnivoice-base-<quant>.gguf` + `omnivoice-tokenizer-<quant>.gguf`) |
| ASR (≤9b) | `ggml-org/Qwen3-ASR-0.6B-GGUF` |
| ASR (27b tiers) | `ggml-org/Qwen3-ASR-1.7B-GGUF` |
| VAD | Silero VAD v5.1.2 (`vad/silero-vad-v5.1.2.ggml.bin`, MIT) |
| Embedding (1.7b+) | `Qwen/Qwen3-Embedding-0.6B-GGUF` (`0_6b`/`0_8b` pool from text backbone) |
| Vision (9b/27b tiers) | `mmproj-*.gguf` co-located with the text backbone |
| Drafter | per `DFLASH_DRAFTER_BASE` above |
| Wake-word | OpenWakeWord — "hey eliza" is currently a renamed `hey_jarvis` placeholder (`packages/inference/reports/porting/2026-05-11/wakeword-head-plan.md`) |

---

## 2. Per-tier × phase matrix

Legend: **PASS** (verified, on-hardware evidence cited);
**PARTIAL** (some-of, with caveat); **BLOCKED** (specific blocker and
owner); **N/A** (does not apply to this tier).

### 2.1 Training × tier

| Tier | Status | Evidence / blocker |
| --- | --- | --- |
| `0_8b` | **PARTIAL — full-corpus SFT in flight on Nebius H200** | `train_nebius.sh full` with `--tier 0_8b` (Qwen3.5-0.8B-Base + combined corpus). Local pids 3236359/3241719/3241720 observed (`/tmp/nebius-finish-q35-0_8b.sh` watcher). `model_registry.py::qwen3.5-0.8b` (registry-key) wired through `run_pipeline.py`. Output channel: `elizaos/eliza-1-0_8b-sft-weights` (repo does NOT exist yet — to be created on the post-run publish). |
| `0_6b` (legacy) | **PARTIAL — local resume in flight (RTX 5080)** | `eliza-1-0_6b-apollo-fullcorpus-1778563093` resumed from checkpoint-1000 (`373ad2433f`); prior test-SFT at `checkpoints/eliza-1-0_6b-apollo-1778551769/final/` is the published `eliza-1-0_6b-sft-weights` candidate. Will be **superseded** by the 0_8b H200 run when it lands. |
| `1_7b` (legacy) | **PASS — full SFT done** | `checkpoints/eliza-1-1_7b-apollo-1778558722/final/`, eval_loss 1.268, seq 2048 (4096 OOM'd on the CE step on 16 GB without Liger). Eliza1-bundle staged. Per `benchmarks/MODELS_STATUS.md`. |
| `2b` | **BLOCKED — not in `ELIZA_1_TIER_IDS` yet** | Registry entry exists (`qwen3.5-2b`); needs to land in `catalog.ts`/`eliza1_manifest.py`/`eliza1_platform_plan.py`/`eliza1_gates.yaml` + a bundle staging + an HF repo create + an SFT plan. |
| `4b` (legacy) | **BLOCKED — pending** | Registry entry exists; placeholder HF repo (`.gitattributes` only); no SFT run. Directive says drop legacy Qwen3 — replacement `qwen3.5-4b → eliza-1-4b` planned in migration report but not yet committed. |
| `9b` | **BLOCKED — cloud-only, no SFT run** | `qwen3.5-9b` registry entry + `train_vast.sh provision-and-train --registry-key qwen3.5-9b` ready; needs a `blackwell6000-1x` or H200 dispatch. Operator gate (vast key / nebius login). |
| `27b` / `27b-256k` / `27b-1m` | **BLOCKED — cloud-only, no SFT run** | `qwen3.6-27b` registry entry + `train_vast.sh provision-and-train --registry-key qwen3.6-27b` ready (b200-2x FSDP); operator gate. Plus: directive says rebase on `Qwen/Qwen3.5-27B` per the migration report. |

### 2.2 Inference × backend × tier — kernel verify status

Source: `packages/inference/verify/kernel-contract.json`,
`packages/inference/verify/PLATFORM_MATRIX.md` "Verify status as of
2026-05-12", `cpu-runtime-dispatch-evidence.json`,
`vulkan-runtime-dispatch-evidence.json`,
`metal-runtime-dispatch-evidence.json`.

Cells = (kernel-verify status; runtime-ready status). A tier inherits the
backend's kernel-verify status — the per-tier hardware run is the
`eliza1_eval_suite.py` step downstream of kernel-verify.

| Backend | Verify status | Devices verified | Tiers it covers in principle |
| --- | --- | --- | --- |
| `cpu` (Linux x64) | **PASS (kernel-verify + dispatch-smoke runtime-ready for `qjl` + `fusedAttn`)** | Intel Arrow Lake AVX2+AVX-VNNI | all tiers (but §3 build gate `publishable:false` — `turbo3_tcq`/`polarquant`/`turbo3`/`turbo4` not CPU-graph-dispatchable) |
| `cuda` (Linux x64) | **PASS — verified-here on RTX 5080 (sm_120, CUDA 12.8 native SASS)** — `cuda-verify` 8/8 + `cuda-verify-fused` 1920/1920 max diff ≤ 4.47e-7 | RTX 5080 mobile | all tiers; `27b-1m` needs GH200 still |
| `cuda` (Linux aarch64 / GH200) | **BLOCKED — authored-pending-hardware** (`verify/gh200_runner.sh` fail-closed) | none | `27b-256k`, `27b-1m` |
| `vulkan` (Linux x64) | **PASS (runtime-ready)** — Intel ARL/ANV `vulkan-dispatch-smoke` `GGML_OP_ATTN_SCORE_QJL` + `GGML_OP_FUSED_ATTN_QJL_TBQ` | Intel ARL Mesa ANV ONLY | all tiers (AMD/NVIDIA still open) |
| `vulkan` (Linux AMD / NVIDIA native) | **BLOCKED — authored-pending-hardware** | none on these device classes | all tiers |
| `vulkan` (Android arm64 — Adreno/Mali) | **PARTIAL — standalone fixtures 6/6 PASS on Pixel 6a / Mali-G78**; built-fork graph dispatch evidence OPEN | Mali-G78 only; Adreno none | `0_6b`/`0_8b`/`1_7b` (small mobile) |
| `vulkan` (Android x86_64 — cvd) | **N/A for graph dispatch** — cvd virtio-gpu Vulkan is gfxstream/SwiftShader (software, not recordable) | — | — |
| `metal` (darwin-arm64) | **PASS — verified-here on M4 Max from prior passes** — full `dispatch-smoke` for `GGML_OP_ATTN_SCORE_{QJL,TBQ,POLAR}` runtime-ready | Apple M4 Max | all tiers |
| `metal` (ios-arm64) | **PASS for the structure/runtime-symbol audits + ABI v1 XCTest** — 3/3 on iPhone 15 Pro / iOS 26.3.1; **weight-backed bundle smoke OPEN** | iPhone 15 Pro | `0_6b`/`0_8b`/`1_7b`/`9b` |
| `metal` (ios-fused / `darwin-arm64-metal-fused` HTTP route) | **PARTIAL** — macOS Metal FFI smoke PASS (real GGUF-backed TTS + ASR in one fused process); the macOS evidence is FFI not the merged HTTP route, the fused `linux-x64-cpu-fused` HTTP route is verified-here. | M4 Max (FFI); Linux x86_64 (HTTP route) | all tiers downstream of a fused build |
| `rocm` (Linux AMD HIP) | **BLOCKED** — `hip_verify.cu` shim exists (compiles via hipcc) but no `hipcc` on this box; production custom kernels (turbo/qjl/polar/turbo-tcq `.cu`) not `__HIP_PLATFORM_AMD__`-clean yet. Reduced-mode hatch (`ELIZA_LOCAL_ALLOW_STOCK_KV=1`) is the only path, `publishable:false`. | none | all tiers (non-publishable) |
| `cpu` (Android arm64) | **PARTIAL** — cross-build only; standalone fixtures + dispatch need a real handset | none | — |
| `cpu` (Android x86_64 / cvd) | **PASS — build verified-here**; cvd smoke 5/6 infra steps PASS; step 6 chat completion needs a model in the APK | cvd virtual device | — |
| Windows (x64 / arm64 — cpu/cuda/vulkan) | **BLOCKED — authored-pending-hardware** (`verify/windows_runner.ps1` fail-closed) | none | all tiers (Windows + Snapdragon X) |
| `linux-aarch64-cpu` | **BLOCKED — authored-pending-hardware** (no arm64 Linux host here, no cross-toolchain) | none | Ampere/Graviton/Snapdragon-Linux |

### 2.3 Download × tier (HF presence + manifest state)

Checked via `HfApi.model_info(elizaos/eliza-1-<tier>)` on 2026-05-12.

| Tier | HF repo | Manifest / card | GGUF bytes |
| --- | --- | --- | --- |
| `0_8b` | **MISSING — repo `elizaos/eliza-1-0_8b` not yet created** | — | — |
| `0_6b` | `elizaos/eliza-1-0_6b` — public, README + manifest, `base-v1-candidate`, **not defaultEligible** | sidecars + frozen assets per `assets-lineage.json` | `text/eliza-1-0_6b-32k.gguf` = the SFT-candidate Q4_K_M; PolarQuant/QJL/TurboQuant **not applied** (sidecars only) |
| `1_7b` | `elizaos/eliza-1-1_7b` — public, README + manifest, `base-v1-candidate`, **not defaultEligible** | sidecars + frozen assets | `text/eliza-1-1_7b-{32k,64k}.gguf` = SFT Q4_K_M; PolarQuant deferred (Q8_0 body) |
| `9b` | `elizaos/eliza-1-9b` — public; README + `manifest.json` skeleton ONLY | `local-standin` (the README explicitly says the GGUF blob upload is pending; sha + source recorded) | none uploaded; pulls from `unsloth/Qwen3.5-9B-GGUF` |
| `27b` | `elizaos/eliza-1-27b` — README + `manifest.json` SKELETON | "pending — blocked on fork-built GGUFs + hardware evidence" | none |
| `27b-256k` | same | same | none |
| `27b-1m` | same | same | none |
| `4b` (legacy) | `.gitattributes` only — placeholder | none | none |

Companion repos created (`-optimized`, `-drafter`, `-sft`) are
README-only / skeleton; they auto-fill when the orchestrator gates clear
(`packages/training/scripts/publish/orchestrator.py::--base-v1`, channel
auto-selected by `run_pipeline.py` stage 7).

Runtime download path: `packages/app-core/src/services/local-inference/downloader.ts`
+ `verify-on-device.ts` — reads the manifest, checks RAM budget +
backend kernel-verify status BEFORE fetching any weight byte; aborts with
a structured `BundleIncompatibleError` otherwise. Tests:
`downloader.test.ts` + `verify-on-device.test.ts`.

### 2.4 Serving × tier

| Surface | Status | Evidence / gap |
| --- | --- | --- |
| `llama-server` (stock) per tier | PASS in principle on every backend with a built fork | Built at `~/.eliza/local-inference/bin/dflash/<target>/llama-server` |
| `llama-server` (`-fused`) + merged `POST /v1/audio/speech` route | **PASS on Linux x64 (`linux-x64-cpu-fused`)** + macOS FFI; iOS/macOS Metal-fused HTTP route OPEN | Route lives in `tools/server/server.cpp` via the `omnivoice-fuse/cmake-graft.mjs` + `server-omnivoice-route.mjs` graft. `dflash-server.ts::resolveFusedDflashBinary()` prefers the fused binary at spawn time. `dflash-server-fused.integration.test.ts` + `dflash-server.test.ts` cover the spawn-selection + same-PID-route smoke. |
| DFlash speculative-decode (catalog `requiresKernel: dflash`) | **PASS for 1.7b+ tiers** (drafter wired in `catalog.ts`, KV-share handled by `dflash-server.ts::resolveDflashDrafter` injecting `tokenizer.ggml.merges` from the target into the drafter GGUF at load) | `0_6b` / `0_8b` ship no drafter; drafters for 9b/27b need real distillation from `Qwen3.5-0.8B-Base` (the Qwen3.5-arch ~0.6B student via `scripts/distill_dflash_drafter.py` on a cloud GPU) — currently substitutes |
| Conv slots + KV save/restore | PASS — `LocalInferenceEngine.generateInConversation()` + the OpenAI-compatible SSE streaming path | Covered by `local-inference/voice` test suites (217/218 green) |
| Audio sinks (`PushMicSource` + `PcmRingBuffer` + Silero VAD) | PASS at the JS layer; mobile bridges OPEN — `plugin-capacitor-bridge::mobile-device-bridge-bootstrap.ts` wires `Capacitor Microphone → PushMicSource` / `AudioTrack → PcmRingBuffer` / `onnxruntime-mobile` Silero VAD but no on-device run yet | |
| FFI streaming ABI v2 (`eliza_inference_{tts_stream,asr_stream,verifier_callback}_*`) | **PARTIAL** — symbols are present in `prepare.mjs` adapter; batch TTS/ASR + streaming TTS + `cancel_tts` IMPLEMENTED (2026-05-12); streaming ASR + native DFlash verifier callback are **honest stubs** (`*_supported() == 0` / `ELIZA_ERR_NOT_IMPLEMENTED`) | The W7 streaming-decoder + verifier-event-source work belongs to FORK-GUIDED-DECODE / W7 |
| `voice:interactive` + `voice:duet` harnesses | PASS at the wiring layer; CPU duet **BLOCKED** on the qjl1_256/q4_polar segfault | `voice-duet.test.ts` 3/3; `voice-duet.e2e.test.ts` correctly skipped (realBackendPresent-gated) |

### 2.5 Evaluation × tier — `eliza1_eval_suite.py` + `eliza1_gates.yaml`

The eval suite runs `text-eval` (perplexity → 0..1), `voice-rtf`, `asr-wer`,
`vad`, `e2e-loop` (1-turn LatencyTracer-complete), `dflash-accept`,
`endurance` (30-turn), `dispatch` (== `make kernel-contract reference-test`).
`aggregate.json` + per-eval JSONs are written under `<bundle>/evals/`;
`packages/training/benchmarks/eliza1_gates.py::apply_gates` flips
`defaultEligible` to `false` if any `required: true` gate fails.

Per-tier gate status (`/eliza1_gates.yaml::tiers.<tier>`):

| Tier | `required` gates green today | `required` gates red today | `required` gates `needs-hardware` |
| --- | --- | --- | --- |
| `0_8b` | none (no eval run yet — SFT in flight) | n/a | all |
| `0_6b` | `e2e_loop_ok`, `thirty_turn_ok`, `dispatch` (CPU+Vulkan+CUDA pass), `dflash_acceptance` 0.87 (upper bound, stamp-only drafter) | `text_eval` 0.2779 ≥ 0.55 (stand-in weights); `voice_rtf` 8.62 ≤ 0.5 (CPU stand-in TTS); `asr_wer` 1.0 ≤ 0.10 (stand-in chain); `format_ok` 0.20 ≥ 0.70 (smoke-corpus; full-corpus pending) | `vad_*` (needs-mic), `peak_rss_mb` / `thermal_*` (needs-device) |
| `1_7b` | `e2e_loop_ok`, `thirty_turn_ok`, `dispatch` | `text_eval` 0.328 ≥ 0.60; `voice_rtf` 5.91 ≤ 0.45; `asr_wer` 1.0 ≤ 0.08; `dflash_acceptance` 0.55 < 0.65 | mobile gates |
| `9b` | none | every required gate (no bundle built; no eval run) | all |
| `27b` / `27b-256k` / `27b-1m` | none | every required gate (skeleton bundle only) | all |

Eval input details: the gate-running harness binaries used are
`llama-cli` / `llama-omnivoice-server` / `llama-speculative-simple`,
spawned with the bundle's quant types. The host-side eval needs a working
`linux-x64-cpu` or `linux-x64-cpu-fused` build — which exists for the
small tiers; it does NOT yet run on the published 9b/27b bundles
(GGUF blobs not uploaded).

### 2.6 Benchmarking × tier — master harness benchmark cells

Per `packages/training/reports/eliza1-harness-benchmark-2026-05-12.md`
(also published to `elizaos/eliza-1-evals`).

| Tier | text_format_ok | text_eval ppl→[0..1] | CPU pp512/tg128 | Vulkan pp512/tg128 (RTX 5080) | CUDA llama-bench | voice RTF | ASR WER | dflash accept | guided-decode forced-token% | mobile RSS / thermal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `0_8b` | n/r (SFT in flight) | n/r | n/r | n/r | n/r | n/r | n/r | n/r | n/r | n/r |
| `0_6b` (bundle, Q3_K_M body + sidecars) | n/r at bundle level | 0.2779 (ppl 71.4) | 331 / 77.7 (Q3_K_M); 432 / 61.1 (Q8 body) | **3421 / 194** | OOM during build — n/r | 8.62 (CPU stand-in TTS, way over 0.5 gate) | 1.0 (stand-in chain) | 0.87 (stamp-only — upper bound) | 28% (static, structured-decode forced-token over the synthetic action set) | needs-device |
| `0_6b` test-SFT (Q4_K_M, no sidecars) | **0.20** (vs base 0.0857) | — | **500 / 75.6** | — | — | — | — | — | — | — |
| `1_7b` (bundle) | n/r | 0.328 | 219 / 39.6 | **1317 / 112** | n/r | 5.91 | 1.0 | 0.55 (below 0.65) | 28% | n/r |
| `9b` / `27b` / `27b-256k` / `27b-1m` | — | — | — | — | — | — | — | — | — | — |

Missing cells, by root cause:
- **d16k CPU/CUDA `llama-bench` sweep** — CPU 16k-prompt too slow under
  concurrent SFT contention; CUDA build OOM'd (needs CUDA-FULL-BUILD #57
  or an idle host).
- **action-selection accuracy / personality PASS%** — needs a live LLM
  provider + a judge model; not wired in this headless context.
- **real ASR WER** — needs real recorded WAV+.txt pairs **and** the
  tokenizer-fused Qwen3-ASR weights (the published bundles use the
  upstream Qwen3-ASR GGUF unchanged).
- **GPU voice RTF (the ≤ 0.5 gate)** — needs `linux-x64-{cuda,vulkan}-fused`
  builds (the gate is GPU-target; CPU stand-in is 8.62 / 5.91).
- **mobile RSS / thermal / peak-RSS / battery** — needs iOS-bundle smoke
  (item 11 of `needs-hardware-ledger.md`) and an Android Pixel
  fused-vulkan run (item 15).

---

## 3. Per-component status across the line

### 3.1 Text (Qwen3.5 / Qwen3)

| Tier | Backbone (registry) | HF | Quant state |
| --- | --- | --- | --- |
| `0_8b` | `Qwen/Qwen3.5-0.8B-Base` | Real (2.88M / 152k downloads, confirmed via `HfApi.model_info`) | SFT in flight on H200; GGUF conversion + Eliza-quant chain not yet run |
| `0_6b` | `Qwen/Qwen3-0.6B` (legacy) | Real; bundle re-hosts upstream Q8_0 + a real test-SFT Q4_K_M | Bundle GGUF body = test-SFT Q4_K_M; PolarQuant `q4_polar` deferred (fork converter gap), sidecar configs present, runtime kernels exist |
| `1_7b` | `Qwen/Qwen3-1.7B` (legacy) | Real; bundle re-hosts upstream + SFT Q4_K_M | Same as 0_6b |
| `2b` | `Qwen/Qwen3.5-2B` (registry only) | Real upstream; no bundle | Not in tier-id list yet |
| `4b` | `Qwen/Qwen3-4B` (legacy) | Real upstream; no Eliza bundle | Placeholder repo |
| `9b` | `Qwen/Qwen3.5-9B` (`unsloth/Qwen3.5-9B-GGUF` Q4_K_M mirror) | Real; bundle is README + manifest skeleton; **GGUF blob NOT uploaded** | Needs fork-built `linux-x64-cuda-fused` to produce the quant chain |
| `27b` / `27b-256k` / `27b-1m` | `Qwen/Qwen3.6-27B` (`batiai/Qwen3.6-27B-GGUF` Q4_K_M mirror); directive says rebase on `Qwen/Qwen3.5-27B` | Skeleton only | Needs cloud GPU + fork build |

What's left to ship REAL text per tier: (a) the fork's
`convert_hf_to_gguf.py` emitting native `q4_polar` (not Q8_0 body) — this
is a fork-side patch (W4-B) that has not landed yet; (b) for `9b`/`27b*`,
a fork-built GGUF + the per-backend dispatch evidence; (c) for `0_8b`,
the H200 SFT finishing + the full Eliza quant chain.

### 3.2 Vision (Qwen3-VL via `mmproj`)

| Tier | Vision component | State |
| --- | --- | --- |
| `0_8b` / `0_6b` / `1_7b` | none (text-only) | n/a |
| `9b` / `27b` / `27b-256k` | `mmproj-*.gguf` co-located with text | Wired into `catalog.ts::sourceModelForTier`; no on-device smoke yet |
| `27b-1m` | none in current catalog | Decision: long-context window only |

### 3.3 TTS (OmniVoice)

- Source: `Serveurperso/OmniVoice-GGUF`. Frozen bytes in
  `elizaos/eliza-1-assets` (2026-05-11) shared by every tier.
- Real on macOS Metal FFI (verified 2026-05-11: 31,680 samples for
  "hello" on the local 1.7B bundle).
- The **merged HTTP route** `POST /v1/audio/speech` is verified on
  `linux-x64-cpu-fused` against the local stand-in (route is live,
  503 "not configured" — the dev bundle has no `tts/`).
- Streaming TTS (the W7 `eliza_inference_tts_stream_*` ABI) IMPLEMENTED
  in `prepare.mjs` adapter as of 2026-05-12.
- Production quant: `Q4_K_M` on `0_8b`/`0_6b`/`1_7b`/`9b`, `Q8_0` on
  `27b+` (per `VOICE_QUANT_BY_TIER`).
- **GPU TTS RTF (the ≤ 0.5 gate)** measurement is blocked on the
  `linux-x64-{cuda,vulkan}-fused` builds — CUDA-FULL-BUILD (#57).
- Weight-backed `/v1/audio/speech` smoke against a real
  `tts/omnivoice-*.gguf` (rather than the stand-in 503): blocked on
  any tier shipping the real `tts/` GGUFs in a published bundle (the
  `eliza-1-assets` bytes are real; just need the bundle to be staged).

### 3.4 ASR (Qwen3-ASR)

- Source: `ggml-org/Qwen3-ASR-0.6B-GGUF` (≤9b tiers) /
  `ggml-org/Qwen3-ASR-1.7B-GGUF` (27b tiers). Frozen in `eliza-1-assets`.
- ABI v2 batch ASR: real on macOS Metal FFI (verified 2026-05-11:
  `/tmp/eliza-asr-hello.wav` → "Hello world."). Streaming ASR is an
  **honest stub** (`asr_stream_supported() == 0`) — the W7 streaming
  decoder is the gap.
- Tokenizer fusion with text backbone: the published Qwen3-ASR GGUF
  uses the Qwen3 vocab (151 936). For Qwen3.5 targets (`0_8b`/`2b`/`9b`+)
  the vocab is 248 320 — the runtime currently injects the target's
  `tokenizer.ggml.merges` into the drafter (similar pattern); the
  ASR-to-text vocab-mismatch is logged as a gap. Real fused-ASR
  tokenizer needs a re-converted Qwen3-ASR GGUF on the Qwen3.5 vocab
  — not yet done.

### 3.5 Embedding (Qwen3-Embedding-0.6B)

- Source: `Qwen/Qwen3-Embedding-0.6B-GGUF`. Frozen in `eliza-1-assets`.
- Required on 1.7b+ tiers (per `catalog.ts::sourceModelForTier`).
- 0_6b / 0_8b pool from text backbone with `--pooling last` (no
  separate embedding GGUF).
- Matryoshka behavior: dim 1024 single-text 14.4 ms on Metal/M4Max;
  dim-128 keeps Pearson 0.96 vs full (per harness-benchmark).
- Linux/CPU embedding bench has NOT been run.

### 3.6 Drafter (DFlash, per `DFLASH_DRAFTER_BASE`)

- Qwen3.5/3.6 targets (2b/9b/27b/27b-256k/27b-1m): distill DOWN from
  `Qwen/Qwen3.5-0.8B-Base` to ~0.6B Qwen3.5-arch student via
  `packages/training/scripts/distill_dflash_drafter.py`. **No artifact
  exists yet** — needs a cloud-GPU run. Scaffold repo
  `elizaos/eliza-1-drafter-0_6b-qwen3_5` exists (9 files, no GGUF).
- Legacy Qwen3 targets (1_7b/4b): distill from `Qwen/Qwen3-0.6B`. Same
  status — no real distilled drafter, the bundles use a stamp-only
  same-size substitute that gives an upper bound on acceptance (0.87
  for 0_6b; 0.55 for 1_7b, which misses the 0.65 floor — the larger
  target makes each rejected round costlier).
- 0_6b / 0_8b: no drafter (smallest tiers).
- ABI: `dflash-server.ts::resolveDflashDrafter` injects
  `tokenizer.ggml.merges` from the target into the drafter at load. The
  drafter GGUF stamps `dflash-draft.target_checkpoint_sha256` so a
  mismatch is detected.

### 3.7 VAD (Silero)

- `vad/silero-vad-v5.1.2.ggml.bin` (native GGML) — MIT, frozen.
- ONNX fallback `vad/silero-vad-int8.onnx` is optional (`optional_files`
  in `eliza1_platform_plan.py`).
- Status: PASS at the kernel/serving layer; VAD latency / boundary /
  endpoint / false-bargein gates are `needs-mic` per tier — needs a
  real mic input and a labeled-onset corpus to produce a gate-passing
  measurement. The `voice:interactive` harness drives Silero today;
  the `vad/*` gate JSONs in `eliza1_eval_suite.py` are skeleton.

### 3.8 Wake-word (OpenWakeWord)

- "Hey Eliza" wake-word IS WIRED INTO THE VOICE LOOP (opt-in,
  local-mode only). Silently inert when the bundle ships no
  openWakeWord ONNX graphs.
- **The shipped graph is a renamed `hey_jarvis` placeholder** — see
  `packages/inference/reports/porting/2026-05-11/wakeword-head-plan.md`.
- What's left: train a real "hey eliza" wake-word head against a real
  positive/negative corpus and replace the placeholder ONNX (separate
  small training task; `packages/training/scripts/wakeword/`).

---

## 4. Remaining punch list — ordered by blocking-power

Each item: what + why blocking + the prerequisite + the exact unblock
command (an operator can paste it). Cross-referenced to the active
sub-agent lanes (#55..#59 in the parent agent's queue).

### Tier 0 — blocks the next publishable artifact

1. **Finish the H200 0_8b SFT (Qwen3.5-0.8B-Base, the new small default)
   and chain bench/quant/eliza1-bundle.** (Sub-agent #55 — H200-QWEN35-SFT.)
   The orchestrator's stage 7 auto-selects the publish channel
   (`recommended` if the held-out text-quality gate clears; else
   `base-v1`) and refuses on red. *Prereq:* the watcher
   `/tmp/nebius-finish-q35-0_8b.sh` finishes + `nebius compute v1 instance
   list` clears + `train_nebius.sh fetch` succeeds (the local pids
   3236359 / 3241719 / 3241720 are alive). *Unblock command (after
   completion):*
   ```bash
   bash packages/training/scripts/train_nebius.sh fetch
   # then
   bun run publish:eliza1:dry-run   # see which tiers gate-clear
   bun run publish:eliza1            # push the green ones
   ```

2. **Fix the CPU `qjl1_256` / `q4_polar` fused-attn segfault** (sub-agent
   #56 — CPU-KERNEL-DEBUG). Blocks: the CPU `voice:duet` baseline, the
   `cpu_reference.json` `status:"pass"` for every Eliza-1 bundle, and the
   structural CPU honest-bench number across the line. *Repro:*
   ```bash
   ~/.eliza/local-inference/bin/dflash/linux-x64-cpu-fused/llama-server \
     -m ~/.eliza/local-inference/models/eliza-1-0_6b.bundle/text/eliza-1-0_6b-32k.gguf \
     --cache-type-k qjl1_256 --cache-type-v q4_polar
   # → Segmentation fault
   ```
   Once fixed: `bun run voice:duet --turns 20 --report packages/inference/reports/porting/2026-05-12/voice-duet-bench-eliza-1-0_6b.json`.

3. **`linux-x64-cuda-fused` full build** (sub-agent #57 — CUDA-FULL-BUILD).
   ~30 GB peak RAM; OOM-kills the 31 GB authoring box under load.
   Unblocks the GPU TTS RTF / ASR RTF / dflash_speedup numbers across
   every tier (and the bundle's `evals/cuda_dispatch.json`). *Prereq:* a
   quiet box (no other CUDA build, `free -m` ≥ 32 GB) **or** the cloud
   runner. *Unblock command:*
   ```bash
   bash packages/training/scripts/cloud/run-on-cloud.sh --provider vast \
     --task build --gpu h100 --yes-i-will-pay
   # or locally on an idle host:
   ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT=1 \
     node packages/app-core/scripts/build-llama-cpp-dflash.mjs \
     --target linux-x64-cuda-fused
   ```

4. **Fork guided-decode fast-forward + W7 streaming decoders +
   `spec-loop → EliVerifierEvent`** (sub-agent #58 — FORK-GUIDED-DECODE).
   ~500 lines of C++ on `elizaOS/llama.cpp` off `v1.1.0-eliza`. Unblocks:
   the structured-decode `28%` static-savings becoming a runtime
   ≈ 28% fewer `decode()` calls; the native DFlash verifier-event
   callback (currently a stub); the fused streaming ASR decoder
   (currently a stub). Babysit-able PR — the build works without it; the
   experience does not.

5. **NDK omnivoice-fuse graft for `android-{arm64,x86_64}-*-fused`**
   (sub-agent #59 — NDK-FUSED-ANDROID). `aosp/compile-libllama.mjs`
   doesn't run the graft; `FUSED_TARGETS` already lists the triples in
   `build-llama-cpp-dflash.mjs`. *Prereq:* Android NDK installed
   (`ANDROID_NDK_HOME` set; `r29.0.13113456` confirmed by the
   cuttlefish smoke). *Unblock command:*
   ```bash
   ANDROID_NDK_HOME=~/Android/Sdk/ndk/29.0.13113456 \
     node packages/app-core/scripts/aosp/compile-libllama.mjs \
     --target android-x86_64-cpu-fused
   ```

### Tier 1 — blocks `defaultEligible` for the small tiers

6. **Distill the real DFlash drafter from `Qwen/Qwen3.5-0.8B-Base`** for
   the Qwen3.5/3.6 targets (2b/9b/27b). The scaffold repo
   `elizaos/eliza-1-drafter-0_6b-qwen3_5` exists; needs a cloud-GPU run.
   *Unblock command:*
   ```bash
   bash packages/training/scripts/cloud/run-on-cloud.sh --provider vast \
     --task distill-drafter --gpu h100 --yes-i-will-pay \
     -- --base Qwen/Qwen3.5-0.8B-Base --student-size 0.6b
   ```

7. **Add the `2b` tier through the full pipeline** — registry already
   has `qwen3.5-2b`; needs to land in `ELIZA_1_TIER_IDS` /
   `ELIZA_1_TIERS` / `eliza1_platform_plan.py` / `eliza1_gates.yaml`
   plus the HF repo create + a bundle staging.

8. **Make the legacy-tier decision and execute it** (per the operator
   directive on the Qwen3.5 move): either drop `0_6b`/`1_7b`/`4b` or
   keep additively; flip `FIRST_RUN_DEFAULT_MODEL_ID` to `eliza-1-0_8b`
   once the 0_8b bundle gates clear. (See migration report §"Remaining
   work".)

### Tier 2 — blocks the cross-platform `defaultEligible` matrix

9. **GPU cloud kernel-verify dispatches**: full `ggml-cuda`
   kernel-verify, native-NVIDIA-Vulkan, native-AMD-Vulkan
   (RADV), Android Adreno graph-dispatch, Android Mali graph-dispatch.
   Each unblocks a different per-tier `evidence/platform/<target>.json`.
   *Unblock command (per device class):* see the table in
   `packages/inference/verify/PLATFORM_MATRIX.md`.

10. **iOS weight-backed Capacitor bundle smoke** — load
    `eliza-1-{0_8b,0_6b,1_7b}.bundle` on a connected iPhone via
    `apps/app/electrobun`'s Capacitor shell; record first-token /
    first-audio / peak-RSS / thermal. *Unblock command:*
    ```bash
    node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs \
      --bundle ~/.eliza/local-inference/models/eliza-1-0_6b.bundle \
      --weight-backed
    ```

### Tier 3 — blocks long-context 27B + GH200

11. **GH200 / Hopper-aarch64 dispatch** (item 7 in
    `needs-hardware-ledger.md`) — blocks `27b-256k` /
    `27b-1m` `defaultEligible`. *Unblock command:* live `nebius`
    aarch64 login + `verify/gh200_runner.sh --report <path>`.

12. **ROCm hip-port of the production custom kernels**
    (turboquant.cuh / qjl.cu / polarquant.cu / turbo-tcq.cu) — needs to
    be `__HIP_PLATFORM_AMD__`-clean. Today, ROCm is only the
    reduced-mode hatch (`publishable: false`). Until this lands, AMD
    bundles will never be `defaultEligible`.

13. **Wake-word real "hey eliza" head** — train against a real
    positive/negative corpus; replace the renamed `hey_jarvis`
    placeholder.

---

## 5. Publishing a real `defaultEligible` `elizaos/eliza-1-0_8b` bundle

This is the most-actionable lane because the H200 SFT is in flight.
Source of truth: `packages/training/benchmarks/eliza1_gates.yaml` →
`tiers.0_8b` + `packages/training/scripts/publish/orchestrator.py::--base-v1`
+ `packages/inference/AGENTS.md` §8.

### 5.1 Required gates for `0_8b` (per `eliza1_gates.yaml`)

`required: true` gates (publish-blocking):

| Gate | Threshold | Currently |
| --- | --- | --- |
| `format_ok` | ≥ 0.70 | needs-data (SFT in flight) |
| `text_eval` | ≥ 0.55 (provisional) | needs-data |
| `voice_rtf` | ≤ 0.5 (provisional) | needs the fused GPU build + a TTS run on a real GGUF; currently CPU stand-in is 8.62 on 0_6b |
| `asr_wer` | ≤ 0.10 (provisional) | needs real WAV+.txt pairs + the tokenizer-fused Qwen3-ASR weights |
| `vad_latency_ms` | ≤ 20 | needs-mic |
| `vad_boundary_mae_ms` | ≤ 40 | needs-mic + labeled-onset corpus |
| `vad_endpoint_p95_ms` | ≤ 650 | needs-mic |
| `vad_false_bargein_per_hour` | ≤ 0.2 | needs silence/noise fixtures |
| `barge_in_cancel_ms` | ≤ 80 | covered by `bargein_latency_harness.mjs` — needs HW |
| `thirty_turn_ok` | true | runs CPU; should clear once segfault #56 is fixed |
| `e2e_loop_ok` | true | runs CPU; same |

Non-required (informational) gates: `first_token_latency_ms`,
`first_audio_latency_ms`, `duet_round_trip_ms`,
`structured_decode_token_savings_pct`, `dflash_acceptance`,
`dflash_speedup`, `expressive_*`, `peak_rss_mb`, `thermal_throttle_pct`.

### 5.2 Required bundle files for `0_8b` (per `eliza1_platform_plan.py`)

```
text/eliza-1-0_8b-32k.gguf
tts/omnivoice-base-Q4_K_M.gguf
tts/omnivoice-tokenizer-Q4_K_M.gguf
asr/eliza-1-asr.gguf
asr/eliza-1-asr-mmproj.gguf
vad/silero-vad-v5.1.2.ggml.bin
dflash/...   — (NONE — 0_8b ships no drafter, same as 0_6b)
cache/voice-preset-default.bin
evals/aggregate.json
evals/{metal,vulkan,cpu}_verify.json
evals/{metal,vulkan,cpu}_dispatch.json
licenses/{LICENSE.text,voice,asr,vad,dflash,eliza-1}
checksums/SHA256SUMS
evidence/release.json
quantization/{turboquant,fused_turboquant,qjl_config,polarquant_config}.json
```

Plus per-target `evidence/platform/<target>.json` for
`darwin-arm64-metal`, `ios-arm64-metal`, `linux-x64-vulkan`,
`android-{adreno,mali}-vulkan`, `linux-x64-cpu`,
`windows-x64-{cpu,vulkan}`, `windows-arm64-{cpu,vulkan}`.

### 5.3 Order in which the red gates flip green (the actual unblock sequence)

1. **H200 SFT finishes** → `0_8b` text GGUF (Q4_K_M, fork-built, the
   Eliza quant chain applied) → `text_eval`, `format_ok` measurable.
2. **CPU segfault #56 fixed** → `e2e_loop_ok`, `thirty_turn_ok`,
   `dispatch.cpu` PASS for `0_8b` bundle on the authoring box.
3. **`linux-x64-cuda-fused` builds (#57)** → GPU `voice_rtf` measurement
   (currently CPU stand-in is 8.62) — clears the ≤ 0.5 gate on the
   Qwen3.5-arch model with the fused TTS route.
4. **Fork guided-decode + W7 streaming (#58) merge** →
   `structured_decode_token_savings_pct` ≈ 28% becomes a runtime gate
   (currently informational); ASR streaming becomes real (currently a
   stub); `asr_wer` measurable on real WAV+.txt pairs.
5. **iOS weight-backed bundle smoke** → `evidence/platform/ios-arm64-metal.json`
   + `peak_rss_mb` + `thermal_throttle_pct` measurable.
6. **Android Adreno + Android Mali graph-dispatch evidence** →
   `evidence/platform/android-{adreno,mali}-vulkan.json` filled.
7. **Windows runs** → Windows platform-evidence JSONs.
8. **`bun run publish:eliza1`** → orchestrator stage 7 picks
   `recommended` (text-quality gate green) over `base-v1`, refuses on
   any remaining red gate, publishes the bundle if everything passes.

The shortest path to publishable `eliza-1-0_8b`: (1) → (2) → (3) → a
single iOS bundle smoke → the publish call. Steps 4 / 6 / 7 are
not required to ship a `defaultEligible` artifact on Linux + macOS +
iOS; they are required to ship one on Android + Windows.

---

## 6. Cross-references

- Master harness benchmark:
  [`packages/training/reports/eliza1-harness-benchmark-2026-05-12.md`](../../../../training/reports/eliza1-harness-benchmark-2026-05-12.md)
- Qwen3.5 migration audit:
  [`packages/training/reports/eliza1-training-qwen3.5-migration-2026-05-12.md`](../../../../training/reports/eliza1-training-qwen3.5-migration-2026-05-12.md)
- Live punch list / runtime truth:
  [`../2026-05-11/remaining-work-ledger.md`](../2026-05-11/remaining-work-ledger.md)
- Hardware-bound work catalog:
  [`../2026-05-11/needs-hardware-ledger.md`](../2026-05-11/needs-hardware-ledger.md)
- Platform matrix (one-command build / verify / bench per target):
  [`packages/inference/verify/PLATFORM_MATRIX.md`](../../../verify/PLATFORM_MATRIX.md)
- Kernel contract (the enforceable gate):
  [`packages/inference/verify/kernel-contract.json`](../../../verify/kernel-contract.json)
- Runtime catalog (the per-tier kvCache / preferredBackend /
  requiresKernel / drafter wiring):
  [`packages/shared/src/local-inference/catalog.ts`](../../../../shared/src/local-inference/catalog.ts)
- Manifest schema + tier set (Python):
  [`packages/training/scripts/manifest/eliza1_manifest.py`](../../../../training/scripts/manifest/eliza1_manifest.py)
- Eval gate engine + thresholds:
  `packages/training/benchmarks/eliza1_gates.{yaml,py}`
- Publish orchestrator + the auto-publish hook:
  `packages/training/scripts/publish/orchestrator.py` + `publish_eliza1_all.py`
- Swarm director's running notes:
  [`/.swarm/STATUS.md`](../../../../../.swarm/STATUS.md)
- HF org (live, 2026-05-12): https://huggingface.co/elizaos
- Voice-duet harness state:
  [`./voice-duet-bench-eliza-1-0_6b.md`](./voice-duet-bench-eliza-1-0_6b.md)
- Cuttlefish (cvd) x86_64 Android smoke:
  [`./cuttlefish-x86_64-smoke.md`](./cuttlefish-x86_64-smoke.md)
