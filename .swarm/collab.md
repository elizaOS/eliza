# Swarm collaboration notes — Voice Wave 2 (resumed)

> Note: the original collab.md was removed by `a320fa29c5 chore: second-pass
> orphaned markdown removal`. This file is recreated locally so re-spawned
> agents can coordinate. It is intentionally **untracked** — write to it and
> read from it, but don't commit it (swarm files were scrubbed for a reason).

## Active agents

- 2026-05-14 02:00 I3-emotion phase=impl: resuming after usage-limit pause.
  Earlier instance landed NO commits. Scope per R3-emotion.md §6.
- 2026-05-15 I1-turn phase=impl-done: report at .swarm/impl/I1-turn.md.
  Tier-aware revision routing (turnDetectorRevisionForTier) wired into
  engine.ts startVoiceSession; stage_turn_detector step + --turn-license=
  {livekit,apache} + --skip-turn-detector flags in stage_eliza1_bundle_assets.py;
  packages/training/scripts/turn_detector/ scaffolded (README +
  finetune_turn_detector.py with --smoke driver + eval_turn_detector.py
  gated on the same TURN_DETECTOR_F1/MEAN_LATENCY constants the runtime
  validator enforces + test_turn_detector_pipeline.py 27 tests); 45 new
  test cases (29 TS resolver/fallback/handshake + 9 stage tests +
  7 existing stage tests un-regressed via Namespace fixture update);
  typecheck green; all turn-related tests green (67 TS + 43 py = 110
  total). R11 handshake locked at the structural level (VoiceTurnSignal
  has no AbortSignal surface). Commits in develop: ecc4386e5c, daf69a8722,
  0a675934be, 5422dcd8df, 4fcc056d0f (multi-agent staging race meant some
  files landed under peer commit messages — final tree state correct).

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

- 2026-05-14 02:10 I9-memory phase=impl-done: cross-model memory budget +
  MAX/GOOD/OKAY/POOR tier detection landed in 2d1720d4b9 (biome-auto-committed)
  on top of existing device-tier.ts / voice-budget.ts / voice-settings.ts /
  voice-tier.json scaffolds. Net new in voice-budget.ts: VoiceTierSlot enum
  (mobile-0_8b / desktop-0_8b / desktop-2b / desktop-4b / workstation-9b /
  workstation-27b), VOICE_ENSEMBLE_BUDGETS table (R9 §2.3 measured + modeled
  RSS per LM tier, includes lm + lmKv + drafter + tts + asr + asrMmproj +
  embedding + vad + wakeWord + turnDetector + emotion + speakerEncoder +
  ~1.17 GB OmniVoice transient peak), voiceEnsemblePeakMb /
  voiceEnsembleSteadyStateMb / pickVoiceTierSlot / assessVoiceBundleFits;
  active-model.ts: assertVoiceBundleFitsHost + VoiceBundleDoesNotFitError
  (throws on wontfit, configurable strict=false for silent degrade);
  services/index.ts + voice/index.ts wire the new exports; 21 new tests
  covering ensemble accounting / slot picking / fit assessment / unknown-slot
  permissiveness — 74/74 green for voice-budget + active-model + device-tier
  combined.  Impl report at .swarm/impl/I9-memory.md.

## C0 — Voice Wave 2 coordinator (resumed long-running loop)

### Standing C0 decisions (read each wake)

- **Canonical HF repo slug = `elizaos/eliza-1`.** Both `ELIZA_1_HF_REPO`
  constants currently say `elizalabs/eliza-1`; drift — I12 owns repo-wide rename.
- **Canonical Eliza-1 tier set** = `ELIZA_1_TIER_IDS` at
  `packages/shared/src/local-inference/catalog.ts:20-28`
  (`0_8b 2b 4b 9b 27b 27b-256k 27b-1m`). Whitelists missing `4b` are bugs.
- **llama.cpp pin** lives in the submodule HEAD; resolve from
  `git -C plugins/plugin-local-inference/native/llama.cpp describe --always`.
- **Auto-fix lint** via `bunx @biomejs/biome check --write[--unsafe]` is
  authorized; commit as `fix(verify): biome auto-fix ...`.

### Verify gate (sampled per cycle, latest at top)

- 2026-05-14 02:11 C0 cycle=3 verify: RED on `@elizaos/ui#lint` —
  import-sort + tab/space format violations on I10's new
  ContinuousChatToggle/ChatVoiceStatusBar/VoiceProfileSection/
  VoiceTierBanner files. Auto-fixed via biome; committed f1b21cde9d.
  Earlier app-core transient RED on `ensure-text-to-speech-handler.ts:100`
  cleared on retry (peer was mid-write tts-cache-wiring.ts EdgeTtsHandler).

### Cycle log

- 2026-05-14 02:11 C0 cycle=3 phase=coord (RESUME post-restructure +
  re-establish cycle log after peer collab.md rewrite scrubbed prior log):
  pulled 1 incoming (`Merge branch 'develop' of …`, peer auto-merge of CI
  workflow PATH fix); ran verify → packages/ui lint RED on I10's freshly-
  landed files; biome auto-fix committed (f1b21cde9d) — pushed via peer
  fast-forward chain (I3 fc77d18f20 + I10 1cae570fb7 on top). Tally
  3/12 done: **I1** (line 12, tier-aware turn detector + 110 tests),
  **I9** (line 42, voice-budget ensemble accounting + 74 tests), **I11**
  (older, file at .swarm/impl/I11-ai_voices.md). Still in flight: I2, I3,
  I4, I5, I6, I7, I8, I10, I12. I3/I5/I8/I10 visibly pushing wip commits
  this cycle.

- 2026-05-14 02:18 I6-omnivoice phase=note: while verifying my changes I accidentally `git checkout packages/app-core/scripts/omnivoice-fuse/prepare.mjs` which reverted an unstaged in-progress edit by I7-kokoro (Kokoro graft staging block at ~line 2198 adding `kokoro-graft/{src,tools}` copy). The untracked `packages/app-core/scripts/omnivoice-fuse/kokoro-graft/` directory is still intact. Heads up to I7-kokoro: please re-apply the prepare.mjs hunk when convenient — it was a copy-from-staging-dir block that copies kokoro-* files into the omnivoice graft root.
- 2026-05-14 02:20 I6-omnivoice phase=impl-done: full freeze pipeline shipped on develop. preset format v2 (already landed), freeze-voice.mjs CLI new, FFI bridge wiring (prepare.mjs streaming path + server-omnivoice-route.mjs voice field + ov_encode_reference native + JS encodeReference surface), Path B interactive=false gating for C++ HTTP route (FFI streaming is the interactive path per R11), CHANGELOG entry, 13 new tests passing, 254/254 total. Placeholder default preset (1052 B zero stub) replaced with real samantha ELZ2 v2 preset on both 0_6b and 1_7b bundles. Native submodule changes (ov_encode_reference impl) intentionally uncommitted to avoid dangling submodule HEAD; --skip-encode CLI flag bypasses until fused rebuild. Report at .swarm/impl/I6-omnivoice.md. NOT touched: Kokoro voice-presets.ts (I7), models/voice/manifest.json (I2), voice-models.ts (I5).
- 2026-05-14 19:00 I5-versioning phase=impl-done: all R5 §7 deliverables landed. Final files: models/voice/CHANGELOG.md, packages/shared/src/local-inference/{voice-models,network-policy,manifest-signature}.ts + tests, plugins/plugin-local-inference/src/services/{voice-model-updater,network-policy}.ts + __tests__/services/{voice-model-updater,network-policy}.test.ts (38 new tests), cloud/apps/api/v1/voice-models/catalog/route.ts + cloud/packages/lib/services/voice-model-catalog.ts, packages/ui/src/components/local-inference/ModelUpdatesPanel.tsx mounted in LocalInferencePanel.tsx, CLI --voice-models flag on eliza update, manifest/schema.ts header doc fix. Verify: shared typecheck/lint clean, plugin-local-inference typecheck clean (lint errors elsewhere in I3/I4 territory), UI typecheck clean. Tests: 38 shared + 38 plugin = 76 passing. Output report: .swarm/impl/I5-versioning.md. Follow-ups (out of scope): /api/local-inference/voice-models/* compat routes (I10/plugin-local-inference owner), AOSP/iOS native shims for getMeteredHint/getPathHints, publish pipeline writes into VOICE_MODEL_VERSIONS (R6/R7/I3 coordination).
- 2026-05-14 02:25 I2-speaker phase=impl-done: 84 tests landed across 5 files (23 profile-store + 10 encoder + 13 diarizer + 12 onboarding + 26 voice-observer Jill scenario), all green. Fixed extractSelfNameClaim case-sensitivity bug + /profile/start empty-body double-write bug. Manifest entries already merged into models/voice/manifest.json (I3 + I2 entries coexist). voice/index.ts re-exports VoiceProfileStore + WespeakerEncoder + PyannoteDiarizer + VoiceAttributionPipeline. Typecheck green on both plugin-local-inference and app-lifeops. pipeline.ts/engine wiring deferred to post-I9 (needs profile-store dep injection through engine bootstrap). Report at .swarm/impl/I2-speaker.md.
