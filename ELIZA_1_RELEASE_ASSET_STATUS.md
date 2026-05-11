# Eliza-1 Release Asset Status

Generated on 2026-05-11 after local iOS smoke, source acquisition,
all-tier local bundle completion, native-Linux-Vulkan graph-dispatch PASS,
the new platform-target / `27b-1m`-tier expansion, and the fused-attention
fixture landing.

This is a release-prep ledger, not a release approval. The local bundles now
have the full release-shaped layout, but `evidence/release.json` in every tier
is intentionally `releaseState=local-standin`, `publishEligible=false`, and
`final.weights=false`. The publish orchestrator must still reject them.

Kernel/contract state moved forward since the last revision: native Linux
Vulkan graph dispatch is now runtime-ready on Intel Arc/Xe (Mesa ANV) —
`vulkan-dispatch-smoke` 6/6 PASS, `kernel-contract.json` `runtimeStatus.vulkan`
= `runtime-ready` for `turbo3`/`turbo4`/`turbo3_tcq`/`qjl`/`polar` — evidence
`packages/inference/verify/vulkan-runtime-dispatch-evidence.json` +
`packages/inference/verify/hardware-results/linux-vulkan-smoke-20260511T145056Z.log`.
The contract also tracks the added build targets `linux-aarch64-{cpu,cuda}`,
`windows-arm64-{cpu,vulkan}`, `windows-x64-vulkan` (all `needs-hardware`; Intel
Macs / `darwin-x64-metal` are no longer a supported target), a `27b-1m`
(1M-context, CUDA-only-backend) tier, and a
new `fusedAttn` section (capability key `fused_attn`, `needs-runtime-smoke` for
vulkan/metal, `needs-hardware` for cuda). The manifest schema gained optional
`kernels.verifiedBackends.*.{device,caveat}` provenance and a
`kernels.recipeManifest` block fed from the quantization recipes'
`kernel_manifest` sidecar fragments (`codebookHash` / `perBlockTolerance` /
`blockLayoutVersion`).

## Local Bundle Roots

All local bundles are under:

`/Users/shawwalters/.eliza/local-inference/models/`

Staged bundle directories:

- `eliza-1-0_6b.bundle`
- `eliza-1-1_7b.bundle`
- `eliza-1-9b.bundle`
- `eliza-1-27b.bundle`
- `eliza-1-27b-256k.bundle`

`stage_eliza1_bundle_assets.py --link-mode hardlink` now hardlinks Hub cache
blobs into tier bundles, so repeated ASR/TTS assets do not consume disk once
per tier.

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

The checksum manifests have been validated for all five bundles:

- `eliza-1-0_6b.bundle`: OK
- `eliza-1-1_7b.bundle`: OK
- `eliza-1-9b.bundle`: OK
- `eliza-1-27b.bundle`: OK
- `eliza-1-27b-256k.bundle`: OK

The release publisher rejects the local bundles as intended. A dry-run
publish preflight against `eliza-1-1_7b.bundle` exits `16`
(`EXIT_RELEASE_EVIDENCE_FAIL`) because `releaseState=local-standin` and the
final evidence flags are false.

The per-tier completion reports are next to the bundles:

- `/Users/shawwalters/.eliza/local-inference/models/eliza-1-0_6b.bundle.local-completion.json`
- `/Users/shawwalters/.eliza/local-inference/models/eliza-1-1_7b.bundle.local-completion.json`
- `/Users/shawwalters/.eliza/local-inference/models/eliza-1-9b.bundle.local-completion.json`
- `/Users/shawwalters/.eliza/local-inference/models/eliza-1-27b.bundle.local-completion.json`
- `/Users/shawwalters/.eliza/local-inference/models/eliza-1-27b-256k.bundle.local-completion.json`

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
- Fused-attention (`GGML_OP_FUSED_ATTN_QJL_TBQ` + Polar-V variant) has a
  bit-exact C reference + JSON fixtures + contract docs, but no Metal/Vulkan
  fused compute kernel and no `cases`-array harness yet, so the `fused_attn`
  capability is `needs-runtime-smoke` for vulkan/metal and is not a required
  manifest kernel. The fused HTTP route (one process serving text/DFlash +
  `/v1/audio/speech`) is also still open.
- `elizaos` Hugging Face upload evidence is still absent. Upload is blocked
  by non-final release evidence and, separately, requires a token with write
  permission to `elizaos`. Current Hub auth probe resolved user
  `shawmakesmagic` with orgs `BabylonMarket` and `elizaos`, so the target
  namespace is visible in this shell. A live Hub scan currently finds
  `elizaos/eliza-1-assets`, but no publishable per-tier
  `elizaos/eliza-1-*` release repos with final evidence.

## Publish Pipeline / Downloader State (2026-05-11, this checkout)

- `packages/training/scripts/publish_all_eliza1.sh` now prints the per-tier
  publish summary and propagates the orchestrator's structured exit code on
  the first failing tier (so callers can tell `EXIT_RELEASE_EVIDENCE_FAIL`
  = `16` from `EXIT_BUNDLE_LAYOUT_FAIL` = `10`, etc.). The
  abort-on-first-failure behavior from §6 is unchanged.
- Dry-run was executed against a hand-built `releaseState=upload-candidate`
  stand-in bundle for the `0_6b` tier (`final.weights=false`): the
  orchestrator rejects it at stage 2 (`exit 16`, `EXIT_RELEASE_EVIDENCE_FAIL`)
  — exactly as the contract requires. **No tier would publish; all are
  blocked by non-final release evidence.** This checkout's state dir contains
  no staged Eliza-1 bundle; producing one requires the asset/source staging
  scripts (`stage_eliza1_bundle_assets.py`, `stage_eliza1_source_weights.py`,
  `stage_local_eliza1_bundle.py`) which need HF network access and real
  text/DFlash weights.
- No `HF_TOKEN` / `HUGGINGFACE_TOKEN` / `HUGGINGFACE_HUB_TOKEN` is present
  in this environment and `huggingface-cli` is not installed. **No upload
  was performed.** `defaultEligible` and `publishEligible` stay `false` for
  every tier.
- §7 device-side downloader contract hardened (see
  `packages/app-core/src/services/local-inference/downloader.ts`): the
  manifest is read first, then RAM budget and verified-backend availability
  are checked against the device **before any weight byte is fetched**
  (abort → structured `BundleIncompatibleError` → `failed` download event);
  schema version is enforced by `parseManifestOrThrow`; per-file sha256 +
  resume already existed; a new injectable `verifyOnDevice` hook (load →
  1-token text → 1-phrase voice → barge-in cancel) gates readiness and
  default-slot fill, recorded via `InstalledModel.bundleVerifiedAt`. Tests
  added in `downloader.test.ts`. Wiring the hook from the engine in
  `service.ts` is the remaining gap.

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
