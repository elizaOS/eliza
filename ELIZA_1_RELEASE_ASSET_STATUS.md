# Eliza-1 Release Asset Status

Generated on 2026-05-11 after local iOS smoke + asset acquisition.

This is a release-prep ledger, not a release approval. All upstream source
weights acquired here are staged under `source/` and are not final Eliza-1
weights. The publishable files must still land at the paths listed in
`ELIZA_1_GGUF_READINESS.md`.

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

## Acquired Source Weights

Each tier has `evidence/source-weights.json` and source files under `source/`:

| Tier | Text source | DFlash source | Vision source |
| --- | --- | --- | --- |
| `0_6b` | `Qwen/Qwen3-0.6B-GGUF` / `Qwen3-0.6B-Q8_0.gguf` | Missing upstream drafter | n/a |
| `1_7b` | `Qwen/Qwen3-1.7B-GGUF` / `Qwen3-1.7B-Q8_0.gguf` | Missing upstream drafter | n/a |
| `9b` | `unsloth/Qwen3.5-9B-GGUF` / `Qwen3.5-9B-Q4_K_M.gguf` | `lym00/Qwen3.5-9B-DFlash-GGUF-Test` / `Qwen3.5-9B-DFlash-q8_0.gguf` | `unsloth/Qwen3.5-9B-GGUF` / `mmproj-F16.gguf` |
| `27b` | `batiai/Qwen3.6-27B-GGUF` / `Qwen-Qwen3.6-27B-Q4_K_M.gguf` | `spiritbuun/Qwen3.6-27B-DFlash-GGUF` / `dflash-draft-3.6-q8_0.gguf` | `batiai/Qwen3.6-27B-GGUF` / `mmproj-Qwen-Qwen3.6-27B-Q6_K.gguf` |
| `27b-256k` | same as `27b` | same as `27b` | same as `27b` |

These are conversion/training inputs only. Do not rename them into `text/` or
`dflash/` release paths without running the final Eliza-1 train, quantize,
kernel, eval, checksum, license, and upload gates.

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

- Final Eliza-1 text GGUFs are not produced for any tier.
- Final 0.6B and 1.7B DFlash drafter GGUFs are missing.
- The 9B DFlash source comes from a test repo and is not release-grade.
- Final long-context variants (`32k`, `64k`, `128k`, `256k`) are not generated
  and evaluated from trained Eliza-1 checkpoints.
- Final `dflash/target-meta.json` files are missing for all tiers except any
  local stand-in artifacts already marked non-publishable.
- Final evals are missing: text, ASR WER, VAD latency, TTS RTF, expressive voice,
  DFlash acceptance, first token, first audio, barge-in, 30-turn endurance,
  mobile RSS, thermal, and backend dispatch.
- Final release checksums and release-reviewed license attestations are missing
  for the staged final paths.
- Final platform evidence is incomplete across native Linux Vulkan, Android
  graph dispatch, CUDA, ROCm, GH200/H200, native Windows, and weight-backed iOS.
- `elizalabs` Hugging Face upload evidence is still absent. Existing accessible
  staging evidence is not a release namespace proof.

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
8. Upload to `elizalabs/eliza-1-*` and preserve upload logs/Hub URLs in
   `evidence/release.json`.
