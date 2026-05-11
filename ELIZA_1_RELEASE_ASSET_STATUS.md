# Eliza-1 Release Asset Status

Last refreshed 2026-05-11 after the full 14-agent on-device-inference push and
the close-out integration pass: native Vulkan graph dispatch verified on Intel
ANV (7 graph routes incl. fused-attn), CPU AVX-VNNI + Polar-preHT in the shipped
build, the fused omnivoice ABI v2 (`eliza_inference_asr_stream_*` /
`tts_synthesize_stream` / verifier callback) landed and ABI-verified on the
`linux-x64-cpu-fused` build, the overlapped ASR→{draft∥verify}→TTS voice
pipeline + Silero VAD + openWakeWord wired, `verifyOnDevice` wired from the
engine into the downloader, real `eliza-1-0_6b`/`1_7b` bundles staged from
documented Qwen3 substitutes, and the eval suite re-run against those real
bundles.

This is a release-prep ledger, not a release approval. The staged bundles have
the full release-shaped layout and **real (substitute-lineage) text weights**,
but `evidence/release.json` in every tier is `releaseState=weights-staged`,
`publishEligible=false`, `final.weights=true`, and
`final.{evals,licenses,kernelDispatchReports,platformEvidence,sizeFirstRepoIds}=false`.
The publish orchestrator still rejects them at stage 2 (exit `16`) — verified.

Kernel/contract state: native Linux Vulkan graph dispatch is runtime-ready on
Intel Arc/Xe (Mesa ANV) — `vulkan-dispatch-smoke` **7/7 PASS** (5 score kernels
+ `GGML_OP_FUSED_ATTN_QJL_TBQ`), `kernel-contract.json` `runtimeStatus.vulkan` =
`runtime-ready` for `turbo3`/`turbo4`/`turbo3_tcq`/`qjl`/`polar` — evidence
`packages/inference/verify/vulkan-runtime-dispatch-evidence.json` +
`packages/inference/verify/hardware-results/linux-vulkan-smoke-*.log`. The
Vulkan **fused** compute kernels (`vulkan/fused_attn_qjl_{tbq,polar}.comp`)
pass `vulkan-verify-fused` 1920/1920 on Intel ARL Mesa ANV. The Metal
(`metal/fused_attn_*.metal`, `metal/polar_preht.metal`) and CUDA
(`cuda/fused-attn-qjl-tbq.cu`) fused kernels are authored, hardware-verify
pending (no Apple/NVIDIA host). The contract tracks 23 build targets and a
`27b-1m` (1M-context, CUDA-only) tier; the `fusedAttn` section is registered
(capability key `fused_attn`, `runtime-ready` vulkan, `needs-runtime-smoke`
metal, `needs-hardware` cuda).

## Bundle Roots

Real (substitute-lineage) release-shaped bundles staged on this Linux host:

- `~/.eliza/local-inference/models/eliza-1-0_6b.bundle` — text from
  `Qwen/Qwen3-0.6B`, `releaseState=weights-staged`, `final.weights=true`
- `~/.eliza/local-inference/models/eliza-1-1_7b.bundle` — text from
  `Qwen/Qwen3-1.7B`, `releaseState=weights-staged`, `final.weights=true`

`9b` was **not** built: `Qwen/Qwen3.5-9B` has no published checkpoint (Qwen3
dense line is 4B → 8B → 14B → 32B), and on this box only ~8 GB RAM is free
(30 GB total, 18 GB in use, 39 GB swap mostly consumed) — downloading +
quantizing an 8B substitute would OOM/thrash. The `27b` / `27b-256k` / `27b-1m`
tiers were never local-built (size + no GH200). Earlier prior macOS-host runs
staged the full five-tier `*.bundle` layout under
`/Users/shawwalters/.eliza/local-inference/models/` as non-publishable
stand-ins; that machine is not this one.

`stage_eliza1_bundle_assets.py --link-mode hardlink` hardlinks Hub cache blobs
into tier bundles, so repeated ASR/TTS assets do not consume disk once per
tier; `stage_real_eliza1_bundle.py` produced the `0_6b`/`1_7b` bundles above.

## Acquired Non-Text Assets

Every tier has these runtime side assets staged with SHA-256 evidence in
`evidence/bundle-assets.json`:

- TTS: `Serveurperso/OmniVoice-GGUF`
- ASR: `ggml-org/Qwen3-ASR-0.6B-GGUF` for 0.6B/1.7B/9B tiers
- ASR: `ggml-org/Qwen3-ASR-1.7B-GGUF` for 27B tiers
- VAD: `onnx-community/silero-vad`
- Cache: deterministic `cache/voice-preset-default.bin`

## Local Release-Shaped Bundles

Every tier now has:

- `text/` artifacts for every required context variant, hardlinked from
  current source/candidate weights.
- `dflash/drafter-*.gguf` and `dflash/target-meta.json` where a local or
  source drafter candidate exists. The 0.6B and 1.7B tiers use the local 4B
  DFlash stand-in only for runtime layout testing.
- `vision/mmproj-*.gguf` for vision tiers, hardlinked from source mmproj
  candidates.
- `quantization/turboquant.json`
- `quantization/fused_turboquant.json`
- `quantization/qjl_config.json`
- `quantization/polarquant_config.json`
- `eliza-1.manifest.json`
- `checksums/SHA256SUMS`
- `evidence/release.json`
- `evidence/local-bundle-completion.json`

Checksum manifests validate for the two staged real bundles
(`eliza-1-0_6b.bundle`, `eliza-1-1_7b.bundle`).

The release publisher rejects the staged bundles as intended. A dry-run
publish preflight (via the orchestrator's `--dry-run`) against both
`eliza-1-0_6b.bundle` and `eliza-1-1_7b.bundle` exits `16`
(`EXIT_RELEASE_EVIDENCE_FAIL`) at stage 2: `releaseState` is
`weights-staged` (not `upload-candidate`/`final`) and
`final.{evals,licenses,kernelDispatchReports,platformEvidence,sizeFirstRepoIds}`
are all false. `publish_all_eliza1.sh --bundles-root … --dry-run` expects
`<root>/<tier>/` directories (not `<root>/eliza-1-<tier>.bundle`), so for
the staged layout invoke the orchestrator directly per tier with
`--bundle-dir`.

### Eval re-run against the real bundles (2026-05-11)

`eliza1_eval_suite.py` re-run with the bundles' own text GGUFs (no
`--text-eval-model` override):

| Tier | text_eval | threshold | verdict | voice/ASR/e2e/DFlash gates |
| --- | --- | --- | --- | --- |
| `0_6b` | 0.2779 | ≥ 0.55 | FAIL | not-run (harness/binary not staged; not the ABI — `OMNIVOICE_FUSE_VERIFY.json` ok) |
| `1_7b` | 0.328 | ≥ 0.60 | FAIL | not-run (same) |

text_eval failing is expected: these are off-the-shelf Qwen3 substitutes, not
fine-tuned Eliza-1 weights. The dispatch eval (`make -C packages/inference/verify
kernel-contract reference-test`) passes (`status: pass`, `runtimeReady: true`).
The voice RTF / ASR WER / VAD / e2e-loop / 30-turn / DFlash-accept gates are
honestly `not-run` — the fused ABI is verified, but the in-script HTTP-RTF /
labelled-WER / mic-file-loop harnesses (and `llama-speculative-simple`) are not
staged here. `evals/*.json` were regenerated with accurate `reason` text.

## Acquired Source Weights

Each tier has `evidence/source-weights.json` and source files under `source/`:

| Tier | Text source | DFlash source | Vision source |
| --- | --- | --- | --- |
| `0_6b` | `Qwen/Qwen3-0.6B-GGUF` / `Qwen3-0.6B-Q8_0.gguf` | Missing upstream drafter | n/a |
| `1_7b` | `Qwen/Qwen3-1.7B-GGUF` / `Qwen3-1.7B-Q8_0.gguf` | Missing upstream drafter | n/a |
| `9b` | `unsloth/Qwen3.5-9B-GGUF` / `Qwen3.5-9B-Q4_K_M.gguf` | `lym00/Qwen3.5-9B-DFlash-GGUF-Test` / `Qwen3.5-9B-DFlash-q8_0.gguf` | `unsloth/Qwen3.5-9B-GGUF` / `mmproj-F16.gguf` |
| `27b` | `batiai/Qwen3.6-27B-GGUF` / `Qwen-Qwen3.6-27B-Q4_K_M.gguf` | `spiritbuun/Qwen3.6-27B-DFlash-GGUF` / `dflash-draft-3.6-q8_0.gguf` | `batiai/Qwen3.6-27B-GGUF` / `mmproj-Qwen-Qwen3.6-27B-Q6_K.gguf` |
| `27b-256k` | same as `27b` | same as `27b` | same as `27b` |

These are conversion/training inputs only. They have been hardlinked into local
release-shaped `text/`, `dflash/`, and `vision/` paths solely so runtime smoke
tests can exercise the bundle layout. The release evidence marks them as
non-final and non-publishable.

## iOS Evidence

XCFramework physical-device smoke now passes:

- Report: `packages/inference/verify/hardware-results/ios-device-smoke-2026-05-11.json`
- Device: iPhone 15 Pro, iOS 26.3.1, UDID `00008130-001955E91EF8001C`
- Result: 3/3 XCTest cases passed
- Voice ABI: required and not skipped

This proves XCFramework structure, Metal availability, runtime symbols, and
fail-closed ABI calls. It does not prove a final weight-backed Capacitor app
route yet.

## Publish Blockers

- Final Eliza-1 text GGUFs are not produced for any tier; local `text/` files
  are source/candidate stand-ins.
- Final 0.6B and 1.7B DFlash drafter GGUFs are missing.
- The 9B DFlash source comes from a test repo and is not release-grade.
- Final long-context variants (`32k`, `64k`, `128k`, `256k`) are not generated
  and evaluated from trained Eliza-1 checkpoints.
- Final `dflash/target-meta.json` files are still non-publishable because they
  point at stand-in/source-candidate text and drafter bytes.
- Final evals are missing: text, ASR WER, VAD latency, TTS RTF, expressive voice,
  DFlash acceptance, first token, first audio, barge-in, 30-turn endurance,
  mobile RSS, thermal, and backend dispatch.
- Local checksum manifests exist and validate, but final release checksums and
  release-reviewed license attestations must be regenerated from the final
  trained bytes.
- Final platform evidence is still incomplete: native Linux Vulkan graph
  dispatch now PASSES on Intel-ANV, but AMD-native and NVIDIA-native Vulkan,
  Android Adreno/Mali graph dispatch, CUDA (no NVIDIA host run yet — dGPU on
  this box is in D3cold), ROCm, GH200/H200 (incl. the `27b-1m` tier), native
  Windows (x64 + arm64), Intel/AMD Mac, and weight-backed iOS all remain open.
- Fused-attention (`GGML_OP_FUSED_ATTN_QJL_TBQ` + Polar-V variant): the Vulkan
  fused compute kernels (`vulkan/fused_attn_qjl_{tbq,polar}.comp`) are
  hardware-verified on Intel ARL (`vulkan-verify-fused` 1920/1920; built-fork
  `GGML_OP_FUSED_ATTN_QJL_TBQ` dispatch verified via `vulkan-dispatch-smoke`).
  Metal (`metal/fused_attn_*.metal`, `metal/polar_preht.metal`) and CUDA
  (`cuda/fused-attn-qjl-tbq.cu` + the build-script `-DGGML_CUDA_FUSED_ATTN_QJL`
  wiring) are authored, hardware-verify pending (no Apple/NVIDIA host). The
  fused omnivoice TTS HTTP route (`/v1/audio/speech` mounted on the same
  `llama-server` that serves text/DFlash) landed (`b52b64ef5f`), gated by
  `MILADY_FUSE_OMNIVOICE`.
- `elizaos` Hugging Face upload evidence is still absent. Upload is blocked by
  non-final release evidence and, separately, requires `HF_TOKEN` with write
  permission to `elizaos`. **No `HF_TOKEN` is present on this machine — that is
  the operator's.** Once evidence is finalized and a token is available, upload
  is one command: `bash packages/training/scripts/publish_all_eliza1.sh
  --bundles-root <root> --filter-tier 0_6b` (per tier).

## Publish Pipeline / Downloader State (2026-05-11)

- `packages/training/scripts/publish_all_eliza1.sh` prints the per-tier publish
  summary and propagates the orchestrator's structured exit code on the first
  failing tier (`16` = `EXIT_RELEASE_EVIDENCE_FAIL`, `10` = layout fail, …).
  Abort-on-first-failure (§6) unchanged.
- Dry-run executed against the real `eliza-1-0_6b.bundle` and
  `eliza-1-1_7b.bundle` (via the orchestrator `--dry-run`): both reject at
  stage 2 (`exit 16`) — `releaseState=weights-staged`,
  `final.{evals,licenses,kernelDispatchReports,platformEvidence,sizeFirstRepoIds}=false`.
  **No tier would publish.** No `HF_TOKEN` is present; **no upload was
  performed.** `defaultEligible` / `publishEligible` stay `false`.
- §7 device-side downloader contract: the manifest is read first, then RAM
  budget and verified-backend availability are checked against the device
  **before any weight byte is fetched** (abort → `BundleIncompatibleError` →
  `failed` event); schema version enforced by `parseManifestOrThrow`; per-file
  sha256 + resume; the injectable `verifyOnDevice` hook (load → 1-token text →
  1-phrase voice → barge-in cancel) gates readiness and default-slot fill,
  recorded via `InstalledModel.bundleVerifiedAt`.
  **The hook is now wired**: `LocalInferenceService` constructs
  `new Downloader({ verifyOnDevice: verifyBundleOnDevice })`
  (`services/local-inference/verify-on-device.ts` — engine-backed: text load +
  1-token gen always, 1-phrase TTS + barge-in cancel when the bundle ships
  voice). A bundle whose verify fails (e.g. fused voice ABI not loadable on the
  device) stays registered but does not auto-fill the default slot.
- The omnivoice-fuse adapter (`packages/app-core/scripts/omnivoice-fuse/`)
  exports the ABI v2 surface (`eliza_inference_asr_stream_*`,
  `tts_synthesize_stream`, `cancel_tts`, `set_verifier_callback`); the
  `linux-x64-cpu-fused` build's `OMNIVOICE_FUSE_VERIFY.json` is `ok=true`
  (`abi=18`, `omnivoice=10`, llama re-exported).

## Next Release Actions

1. Train/fine-tune the Eliza-1 text checkpoints for each tier.
2. Produce or train matching DFlash drafters for 0.6B/1.7B/9B/27B tiers.
3. Quantize final text and drafters into the exact `text/` and `dflash/` paths
   required by `ELIZA_1_GGUF_READINESS.md`.
4. Generate final quantization sidecars for TurboQuant, fused TurboQuant, QJL,
   and PolarQuant from the exact final bytes.
5. Run all local eval gates and write final `evals/*.json`.
6. Run platform hardware dispatch gates and write final `evidence/platform/*.json`.
7. Generate `checksums/SHA256SUMS` and `evidence/release.json` only after every
   gate is green.
8. Upload to `elizaos/eliza-1-*` and preserve upload logs/Hub URLs in
   `evidence/release.json`.
