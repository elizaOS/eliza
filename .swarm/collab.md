# Swarm collaboration notes — Voice Wave 2 (resumed)

> Note: the original collab.md was removed by `a320fa29c5 chore: second-pass
> orphaned markdown removal`. This file is recreated locally so re-spawned
> agents can coordinate. It is intentionally **untracked** — write to it and
> read from it, but don't commit it (swarm files were scrubbed for a reason).

## Active agents

- 2026-05-14 02:00 I3-emotion phase=impl: resuming after usage-limit pause.
  Earlier instance landed NO commits. Scope per R3-emotion.md §6.
- 2026-05-15 I1-turn phase=impl: 3rd dispatch. Eot-classifier code
  (LiveKitTurnDetector revisions, TurnsenseEotClassifier, onnx/model_q8.onnx
  default, TURN_DETECTOR_* schema + validator gates) ALREADY LANDED in commit
  f80546a9e6. Remaining: tier-aware revision routing in engine.ts; bundle
  resolver for the `turn` lineage; stage_turn_detector step + --turn-license
  flag in stage_eliza1_bundle_assets.py; scaffold packages/training/scripts/
  turn_detector/ (finetune + eval + README + smoke test); tests for resolver
  + heuristic fallback + cancellation handshake. Owning edits to
  plugins/plugin-local-inference/src/services/engine.ts (light additions in
  startVoiceSession), packages/training/scripts/manifest/stage_eliza1_bundle_assets.py
  (new), packages/training/scripts/turn_detector/ (new dir), and tests under
  plugins/plugin-local-inference/src/services/voice/__tests__/.

## Standing notes

- HEAD = origin/develop = 23b2f1f531. `.swarm/` was scrubbed; treat as
  untracked scratch only.
- Wav2Small classifier file + test already exist
  (`plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts`).
- `TranscriptUpdate.voiceEmotion` is already declared at types.ts:302.
- Remaining work per R3 §6: distillation stub, text field-evaluator,
  Memory.metadata.voice, fusion-extended attributeVoiceEmotion, planner
  provider entry, bench dir, manifest entry, privacy filter check.
- 2026-05-14 18:00 I5-versioning phase=impl-resuming-3 (3rd dispatch after rebase reset + upstream merge restructure): foundational files already landed (voice-models.ts + network-policy.ts + manifest-signature.ts in shared/local-inference, barrel re-exports, models/voice/CHANGELOG.md exists untracked but ready). Remaining per spec: (1) commit models/voice/CHANGELOG.md, (2) build voice-model-updater service in plugin-local-inference (cascade Cloud→GitHub→HF, atomic swap, decision rule), (3) NetworkPolicy bridge in plugin-local-inference/services/ (platform shim adapter), (4) Cloud catalog endpoint cloud/apps/api/v1/voice-models/catalog/route.ts with Ed25519 sig, (5) UI ModelUpdatesPanel + hook, (6) CLI --voice-models flag, (7) tests, (8) fix manifest/schema.ts header comment. NOTE: origin/develop did massive restructure (.swarm/ deletion, plus 42 commits incl. plugin-elizacloud browser stub, milady-tails, R2 CDN); not pulling — would conflict with swarm coordination; commits remain on local develop tip.

- 2026-05-14 01:55 I7-kokoro phase=impl-resuming (re-dispatch): prior session landed 6bed228abc (plumbing + tests, all green per prior verify). Re-dispatch picks up: (1) run actual voice-clone path via extract_voice_embedding.py against packages/training/data/voice/samantha/audio/ → produce af_samantha.bin; (2) experimental LoRA short run for comparison (max_steps=2000 on local 5080); (3) eval both paths with eval_kokoro.py --baseline-eval vs af_bella; (4) dry-run HF push to elizaos/eliza-1-voice-kokoro-samantha-v01 private=true; (5) coordinate manifest slot-in with I5/I6; (6) document Kokoro emotion-knob gap; (7) confirm pytest + bun --filter @elizaos/plugin-local-inference verify green. Will commit + push every 15-30 min as wip(I7-kokoro): … Output: .swarm/impl/I7-kokoro.md.
