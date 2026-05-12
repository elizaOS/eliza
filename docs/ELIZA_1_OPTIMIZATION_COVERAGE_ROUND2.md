# Eliza-1 Optimization Coverage - Round 2

Date: 2026-05-12

Scope: audit/report only. This is not hardware benchmarking. Evidence comes from
the Eliza-1 contracts, readiness checklists, local-inference catalog/runtime,
manifest schema/validator, inference verify ledgers, and training
quantization/publish scripts.

Requested source note: `ELIZA_1_METAL_CPU_CONFIDENCE.md` is not present in this
checkout. The closest current evidence is `ELIZA_1_TESTING_TODO.md`,
`packages/inference/README.md`,
`packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md`, and
`packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md`.

## Legend

- `wired`: code/catalog/publish gate actively routes or rejects on this path.
- `harness-verified`: reference, fixture, smoke, or one-device evidence exists,
  but the release path still needs final bundle bytes or broader hardware.
- `missing`: not implemented, not enforced, or still blocked.
- `not applicable`: component/tier does not require the capability.

## Executive gap list

1. Real base-v1 release artifacts are still the largest blocker. Local
   release-shaped bundles exist, but the current ledgers say the shipped
   fork-built GGUF bytes, final quant sidecars, release hashes, evals, platform
   evidence, license review, and HF upload evidence are not complete.
2. Metal is the strongest backend today: required kernels and graph dispatch
   are runtime-ready on Apple M4 Max. iOS has symbol/XCTest evidence but still
   lacks a weight-backed Capacitor bundle smoke.
3. Vulkan is runtime-ready on one native Linux Intel ANV class. AMD/NVIDIA
   desktop Vulkan and Android Adreno/Mali graph-dispatch evidence are still
   missing.
4. CUDA and ROCm are not release-ready. CUDA has authored kernels/runners and
   API/preprocessor checks; ROCm has a fail-closed runner but lacks a standalone
   HIP fixture parity harness.
5. CPU has reference and SIMD library evidence, but CPU is not runtime-ready
   for the full mandatory kernel contract across platform targets. ARM
   NEON/dotprod self-test/throughput evidence is still missing.
6. DFlash is catalog/runtime-wired, but the native accept/reject verifier event
   stream remains open. JS currently synthesizes accept events from streamed
   deltas.
7. Voice/TTS/ASR are substantially wired for the fused runtime, speaker preset,
   phrase cache, lifecycle, ASR, and barge-in flow. Remaining gaps are
   weight-backed fused `/v1/audio/speech` smoke, native streaming verifier
   events, complete mobile bundle smoke, and release voice/ASR/VAD evals.
8. Mode constraints are only partially proven. Local paths and provider
   metadata exist, but the strict local/cloud/remote hide-not-disable contract
   is not audited end-to-end here.

## Coverage Matrix

| Model part | Platform/backend | Quantization | TurboQuant | QJL / PolarQuant / preHT | DFlash | Cache/offload | Voice preset/cache | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Text target | Metal / macOS | Catalog requires Eliza-1 optimized GGUF and manifest sidecars. | `turbo3`, `turbo4`, `turbo3_tcq` runtime-ready on Apple M4 Max. | QJL, raw Polar, and explicit Polar preHT graph dispatch runtime-ready. | `llama-server` launches `-md --spec-type dflash`; zero-draft guard exists. | QJL K + q4_polar V defaults; slot save/restore and prefix prewarm wired; spill policy wired for >64k. | not applicable | wired plus harness-verified; needs final bundle/eval evidence. |
| Text target | iOS Metal | Manifest requires same optimized artifacts. | Symbols packaged; iOS XCTest checks Metal/runtime ABI shape. | Symbols packaged; full weight-backed graph path not proven. | ABI/symbol path present. | Voice-off mmap invariant documented; bundle smoke pending. | not applicable | harness-verified only; missing weight-backed Capacitor smoke. |
| Text target | Vulkan / Linux | Same manifest/sidecar path. | Standalone and graph dispatch runtime-ready on Intel ANV. | QJL/Polar/preHT standalone and Intel ANV graph evidence exists. | Vulkan graph dispatch evidence exists on Intel ANV. | Cache flags routed through same server. | not applicable | wired for Intel ANV; missing AMD/NVIDIA and Android graph-dispatch evidence. |
| Text target | CUDA | Training/publish require CUDA verify for server tiers. | CUDA kernels authored; no NVIDIA hardware pass in checkout. | CUDA QJL/Polar/TBQ fixture path exists; no recordable run. | DFlash runtime is marked ready in contract, but CUDA graph smoke still needs hardware. | Runner requires real GGUF graph smoke. | not applicable | harness-authored, hardware-missing. |
| Text target | ROCm | Required for 9B+ tiers in readiness docs. | No standalone HIP parity harness found. | ROCm runner is graph-smoke only. | Model-backed graph smoke pending. | fail-closed runner exists. | not applicable | missing fixture parity and hardware evidence. |
| Text target | CPU x64 | CPU reference clean; SIMD tests on x86 listed done. | Reference-only for required Turbo kernels. | AVX2/AVX-VNNI QJL and Polar preHT self-tests/bench notes exist. | CPU DFlash lifecycle runners exist. | CPU spill policy wired; CPU backend smoke still marked needs-hardware in kernel contract. | not applicable | partial; not full release-ready required-kernel backend. |
| Text target | CPU ARM / Windows | Tier/platform targets listed. | no recordable ARM/Windows evidence. | NEON/dotprod code exists; ARM execution pending. | Windows and ARM runners are fail-closed pending hardware. | CPU spill policy is platform-generic. | not applicable | missing hardware evidence. |
| DFlash drafter | all local backends | Drafter companion is required in catalog and manifest files. | Drafter inherits target-side optimized runtime requirements. | Tokenizer repair copies merges from text GGUF when missing. | Always configured for Eliza-1 catalog entries; dev disable flag is loud. | Co-resident in llama-server; restart-without-drafter exists only as last-resort memory pressure path. | not applicable | wired; missing final trained/distilled drafter acceptance evidence and native accept/reject event stream. |
| TTS / OmniVoice | macOS fused | Voice weights are frozen; manifest requires voice files/cache/evals. | Shares fused llama.cpp build and kernel set indirectly. | Separate KV cache; scheduler shared. | Text deltas feed phrase scheduler during generation. | Voice lifecycle mmaps TTS lazily; voice-off keeps regions unmapped by design. | `cache/voice-preset-default.bin` required; phrase cache seed loaded. | wired plus local FFI evidence; missing weight-backed fused HTTP route smoke on real release bundle and final RTF/MOS/e2e evals. |
| TTS / OmniVoice | iOS / Android / Windows | Required bundle files listed. | Backend packaging is not enough for publish. | Mobile graph evidence incomplete. | Barge-in and rollback are JS-runtime covered, native event stream pending. | Mobile RSS/thermal gates pending. | preset/cache paths required. | mostly missing weight-backed device evidence. |
| ASR | local fused | Qwen3-ASR GGUF listed; manifest/evals require ASR WER when ASR files present. | not applicable | Shared vocabulary avoids re-tokenization; not shared tensor. | ASR feeds text scheduler path. | FFI batch/streaming surfaces exist; whisper is legacy interim. | not applicable | wired in runtime; missing release ASR WER and mobile/full fused evidence. |
| Vision / image | 9B+ and 27B tiers | mmproj files required in readiness docs and manifest lineage. | Text runtime carries same backend/kernel requirements. | No vision-specific optimization gate beyond text/mmproj bundle validation found. | not applicable | mmproj path can be passed via optimization/env; catalog source lineage exists. | not applicable | bundle-gated, but final vision eval/evidence is not shown. |
| Embedding | non-0_6b tiers | Qwen3-Embedding source tracked; 0_6b pools from text. | not applicable | Shares tokenizer assumptions only. | not applicable | local embedding route exists. | not applicable | schema/eval gate exists (`embedMteb`) when files present; release evidence pending. |
| VAD / wake word | voice bundles | Silero VAD native GGML required; ONNX fallback optional. | not applicable | not applicable | VAD drives barge-in. | local-mode-only wake word is wired and inert when absent. | not applicable | VAD path wired; release VAD latency/boundary/false-barge-in evidence pending. |
| Tool-call / prefix cache | llama-server and node binding | not applicable | not applicable | not applicable | DFlash path supports slot pinning. | `cacheKey`, deterministic slot id, slot save/restore, prewarm, keepalive, and `--cache-reuse` are wired. | Phrase cache separately wired for voice. | wired; stress tests exist, but no release latency gate. |
| Cloud mode | cloud providers | local optimizations hidden by contract. | not applicable | not applicable | not applicable | should not expose local-model settings. | not applicable | partial: provider/routing metadata exists; strict UI/API hide-not-disable audit not shown. |
| Remote mode | device bridge | target local instance owns models. | target-dependent | target-dependent | target-dependent | device bridge provider exists. | target-dependent | partial: provider is present, but refusal to target cloud and mutation semantics are not proven in this audit. |

## Optimization-by-Backend Truth

| Optimization | Metal | iOS Metal | Vulkan | CUDA | ROCm | CPU | Windows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Standard GGUF quantization (`Q3_K_M`, `Q4_K_M`, `Q8_0`) | planned in bundle readiness | planned | planned | planned | planned | planned | planned |
| TurboQuant Q3/Q4 | runtime-ready on Apple M4 Max | symbol/ABI only | runtime-ready on Intel ANV; broader devices pending | authored, needs NVIDIA run | missing HIP parity | reference-only/SIMD-adjacent | native smoke pending |
| Turbo3 TCQ | runtime-ready on Apple M4 Max | symbol/ABI only | runtime-ready on Intel ANV | authored, needs NVIDIA run | missing HIP parity | reference-only | native smoke pending |
| QJL K-cache | runtime-ready on Apple M4 Max | symbol/ABI only | runtime-ready on Intel ANV | authored, needs NVIDIA run | graph-only runner | x86 SIMD self-tests; ARM pending | native smoke pending |
| PolarQuant V-cache | runtime-ready on Apple M4 Max | symbol/ABI only | runtime-ready on Intel ANV | authored, needs NVIDIA run | graph-only runner | x86 SIMD self-tests; ARM pending | native smoke pending |
| Polar preHT | runtime-ready on Metal; Vulkan verified on Intel ANV | not weight-backed | verified on Intel ANV | not proven | not proven | SIMD path exists | not proven |
| Fused attention | standalone Metal verified; graph smoke pending for fused op | missing | runtime-ready on Intel ANV | authored, needs hardware | missing | reference-only | missing |
| DFlash | wired; graph path evidence | ABI/smoke only | wired on Intel ANV | runtime requires hardware graph smoke | runtime requires hardware graph smoke | lifecycle/path present | runner pending |
| KV/prefix reuse | wired through slot save/restore/prewarm | bridge pending weight-backed smoke | wired | runner pending | runner pending | wired in server path | runner pending |
| CPU offloaded KV spill | policy wired; unified memory class | policy only | policy plus `--no-kv-offload` when spill selected | policy plus graph evidence pending | policy plus graph evidence pending | policy/reference only | policy only |
| Voice preset and phrase cache | wired | preset required, device smoke pending | fused route pending on Vulkan | pending | pending | fused CPU route smoke uses substitute bundle; real TTS pending | pending |

## What Is Actually Wired

- Catalog: `packages/shared/src/local-inference/catalog.ts` has Eliza-1 as the
  only default-eligible line, size-first `elizaos/eliza-1-*` repos, hidden
  DFlash companions, QJL K-cache and q4_polar V-cache defaults for >8k tiers,
  and mandatory `requiresKernel` entries.
- Manifest validation: `packages/app-core/src/services/local-inference/manifest`
  enforces required kernels by tier, `turbo3_tcq` for >64k text variants,
  supported-backend `pass` status, voice preset presence, component lineage,
  ASR/VAD/embedding/expressive eval consistency, and `defaultEligible`.
- Downloader: `downloader.ts` reads the manifest first, rejects incompatible RAM
  or missing verified backend before weight bytes, downloads all manifest files,
  verifies sha256, and only auto-assigns defaults after verify-on-device.
- Backend selection: `backend.ts` refuses to honor `node-llama-cpp` when catalog
  required kernels are present and throws if `CAPABILITIES.json` lacks required
  kernels.
- DFlash server: `dflash-server.ts` launches `llama-server` with the target,
  drafter, `--spec-type dflash`, draft window, QJL/Polar cache types, cache
  slot persistence, metrics, optional fused OmniVoice route args, and a
  zero-draft guard when metrics can prove DFlash activity.
- KV/cache: cache key to deterministic slot id, slot save/restore,
  prewarm/keepalive, `--cache-reuse`, `--cache-ram`, `--no-kv-offload`, and
  spill planning are wired.
- Voice: `EngineVoiceBridge` requires the speaker preset, seeds phrase cache,
  supports FFI or test backend, lazy voice lifecycle, barge-in cancellation,
  rollback queue, streaming TTS seam, ASR transcriber surfaces, VAD, and
  optional wake word.
- Training/publish: quantization recipes emit `kernel_manifest` fragments;
  orchestrator requires sidecars, release evidence, checksums, eval gates,
  manifest build/validation, README render, and HF upload to `elizaos`.

## Harness-Verified Only

- Metal required kernels and graph dispatch have strong Apple M4 Max evidence,
  but final release bundles still need exact shipped-byte evals and platform
  evidence.
- Vulkan required kernels are runtime-ready on Intel ANV only; Android Mali has
  standalone fixture evidence, not built-fork/app graph-dispatch evidence.
- Fused attention is runtime-ready only on Vulkan Intel ANV. Metal fused
  standalone exists but graph dispatch is still pending. CUDA is authored but
  unrun.
- CPU SIMD paths have x86 evidence; ARM NEON/dotprod execution and throughput
  are still pending.
- Fused voice has macOS FFI and route evidence, but the latest ledger still
  calls out real weight-backed `/v1/audio/speech` smoke on Eliza-1 bundles as
  remaining work.

## Missing or Blocked

- `27b-1m` is in the catalog/schema/readiness plan, but
  `packages/training/scripts/publish_all_eliza1.sh` and the publish
  orchestrator tier constants still cover only through `27b-256k`.
- CUDA: no recordable NVIDIA `cuda_runner.sh` evidence in this checkout.
- ROCm: no HIP fixture parity harness; only a fail-closed graph runner.
- Windows: no native x64 or arm64 smoke evidence.
- Android: Adreno standalone plus Adreno/Mali graph-dispatch evidence is open.
- iOS: exact release bundle load/generate/TTS/RSS/thermal smoke is open.
- Release evals: text parity, voice RTF, ASR WER, VAD latency, DFlash
  acceptance, e2e voice loop, 30-turn endurance, memory/thermal are still
  marked hardware/pending for base-v1.
- Native DFlash verifier accept/reject events are not complete; JS synthesized
  accept events do not fully satisfy rollback-safe voice streaming.
- Strict local/cloud/remote mode constraints need a separate UI/API audit.

## Stale Naming / Docs Blockers

- The manifest schema URL still uses `https://elizalabs.ai/...` in both the
  TypeScript and Python manifest contracts. This may be intentionally stable
  schema identity, but if the org rename requires `elizaos`, it is not a
  docs-only change: runtime parsers, JSON Schema files, tests, generated
  manifests, and published bundle compatibility must migrate together.
- Several docs/code comments still say `Eliza-optimized` or reference
  `ELIZA_*` environment variables. Some are historical/internal env names and
  not necessarily stale. User-facing strings should continue to say `Eliza-1`.
- `publish_eliza1_model.py` describes older single-GGUF optimized repos
  (`elizaos/<base>-optimized`) and is not the canonical multi-file Eliza-1
  bundle publisher. Treat it as legacy/auxiliary unless renamed or documented
  as deprecated.

Files changed in this audit: `ELIZA_1_OPTIMIZATION_COVERAGE_ROUND2.md`.
