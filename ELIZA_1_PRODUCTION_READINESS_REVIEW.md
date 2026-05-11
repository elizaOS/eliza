# Eliza-1 Production Readiness Review

Date: 2026-05-11

Target Hugging Face org: `elizaos`

## Decision

Eliza-1 local inference is **not production-releaseable yet**.

The repository is much closer to release-ready than it was: the app catalog,
manifest schema, local bundle staging, publisher preflight, kernel dispatch
evidence, iOS smoke, and platform runner gates are now wired to fail closed.
That is not the same as having a production release. The remaining blockers are
real asset and real hardware evidence blockers, not paper checklist items.

Do not upload or mark any current local bundle as default-eligible. The staged
bundles under `/Users/shawwalters/.eliza/local-inference/models/eliza-1-*.bundle`
are `releaseState=local-standin`, `publishEligible=false`, and
`final.weights=false` by design.

## Current Green Checks

- HF namespace corrected to `elizaos` across active app catalogs, training
  publishing scripts, cloud config, docs, local-inference defaults, and local
  bundle release evidence.
- HF auth probe sees user `shawmakesmagic` and orgs `BabylonMarket,elizaos`.
- Live Hub scan currently finds `elizaos/eliza-1-assets`; no final per-tier
  release repos were detected.
- All five local release-shaped bundles have validated `checksums/SHA256SUMS`.
- App catalog defaults resolve to `elizaos/eliza-1-*` and keep non-Eliza HF
  search results custom-only.
- Manifest validator rejects default eligibility when evals, backends, ASR/VAD,
  or required long-context kernels are missing.
- Publish orchestrator rejects wrong namespaces and rejects local-standin
  release evidence before upload.
- Metal standalone shaders and built-fork dispatch evidence are green on Apple
  Silicon for TurboQuant, QJL, and PolarQuant.
- iOS XCFramework physical-device smoke passed on iPhone 15 Pro with the voice
  ABI check enabled.
- Vulkan built-fork source dispatch wiring exists and fail-closed smoke runners
  exist for Linux, Android, Windows, CUDA, ROCm, and GH200-class hosts.
- Voice streaming now has a bounded LRU phrase-audio cache for repeated
  generated utterances, direct TTS reuse, and verifier-event plumbing through
  the DFlash SSE path without duplicate text delivery.
- The iOS in-process local-agent fetch bridge preserves `fetch.preconnect`
  when present, so the bridge typechecks under both DOM and Bun fetch typings.

## Hard Blockers

1. **Final text weights do not exist.**
   Current `text/` GGUFs are source/candidate stand-ins. They are useful for
   layout and runtime smoke only.

2. **Final DFlash drafters do not exist for every tier.**
   The 0.6B and 1.7B tiers use a 4B local drafter stand-in. The 9B drafter is
   from a test source. None of these can be release evidence.

3. **Final evals are missing.**
   Required gates include text quality, DFlash acceptance, ASR WER, VAD
   latency, TTS real-time factor, expressive voice, first token, first audio,
   barge-in, 30-turn endurance, mobile RSS, and thermal behavior.

4. **Final platform evidence is missing for most target classes.**
   Required remaining evidence includes native Linux Vulkan graph dispatch,
   Android Adreno graph dispatch, Android Mali graph dispatch, CUDA x64, ROCm,
   GH200/aarch64 CUDA, native Windows CPU/CUDA/Vulkan, Windows arm64, and a
   weight-backed iOS Capacitor app smoke.

5. **Release-reviewed licenses and provenance are missing.**
   Local license files are provenance notes. Final text, drafter, TTS, ASR,
   VAD, vision, and kernel sidecar licenses need release review against the
   exact published bytes.

6. **No per-tier HF upload evidence exists.**
   Upload must target `elizaos/eliza-1-<tier>` and write immutable commit URLs,
   file checksums, LFS metadata, and upload logs into `evidence/release.json`.

## Required Release Path

1. Train or produce final Eliza-1 text checkpoints for each tier.
2. Train or produce matching DFlash drafters for each tier and context plan.
3. Convert final text, drafter, voice, ASR, VAD, and vision payloads into the
   exact bundle paths listed in `ELIZA_1_GGUF_READINESS.md`.
4. Generate TurboQuant, fused TurboQuant, QJL, and PolarQuant sidecars from the
   final bytes.
5. Run eval gates and platform dispatch gates against the final bundles.
6. Regenerate checksums, release evidence, model cards, and license manifests.
7. Run the publisher preflight; it must pass without overrides.
8. Upload to `elizaos/eliza-1-*` and preserve upload evidence.
9. Only then flip `defaultEligible=true` for the matching tier manifests.

## Verification Run In This Pass

- Local bundle checksum validation: all five bundles pass.
- Python release/manifest/publish/model-registry/quantization tests: pass after
  installing the declared training-test dependencies into the active Python.
- App catalog test: 17/17 pass.
- App manifest validator test: 27/27 pass.
- Focused local-inference optimization tests: 86/86 pass across backend,
  DFlash streaming, voice scheduler, and engine voice integration.
- iOS local-agent transport test: 4/4 pass.
- `packages/app-core` and `packages/ui` typechecks: pass.
- HF auth/scan: authenticated user has `elizaos`; only `elizaos/eliza-1-assets`
  was found for the Eliza-1 namespace scan.

## Production Posture

Current state is **release-prep ready and fail-closed**, not production-ready.
The safe deployment posture is to ship code paths and hidden/offline staging
tools, but keep Eliza-1 tier bundles non-default and unpublished until final
weights plus platform evidence exist.
