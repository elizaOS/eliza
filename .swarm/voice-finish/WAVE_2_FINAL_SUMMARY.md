# Voice Wave 2 — FINAL summary (K-verify, 2026-05-14)

**Branch:** `develop`
**Coordinator:** K-verify (verify watcher)
**Wall clock:** 2026-05-14 21:42 → 2026-05-14 22:58 (≈ 76 min)
**Hard cutoff was:** 23:12 (90 min)

This is the canonical close for the 5 parallel agents running on
develop tonight (R-rename-2, J-audit, G-emotion, H-turn, F-kokoro,
I-omnivoice). It supersedes nothing — it complements the earlier
`.swarm/voice-finish/WAVE_2_CLOSING_SUMMARY.md` (the umbrella close
written by R-rename-2) and the per-agent impl reports.

---

## Verify + test final state

### `bun run verify` — **GREEN**

```
Tasks:    317 successful, 317 total
Cached:    0 cached, 317 total
Time:    5m40.809s
```

(Final non-cached run on 2026-05-14 22:53. Subsequent FULL TURBO replay:
317/317 cached in 8.4s.)

### `bun run test` — **GREEN within pre-existing-flake budget**

```
Test Files  1 failed | 81 passed (82)
Tests       1 failed | 661 passed | 3 skipped (665)
```

**The single failing test is a pre-existing, NOT-voice-related flake:**

- `packages/ui/src/api/android-native-agent-transport.test.ts > routes
  Android local-agent requests through the native Agent plugin`
  times out at 5 000 ms under parallel-load. Passes in isolation
  (2/2 green at `bunx vitest run …android-native-agent-transport.test.ts`).
- Root cause: the test dynamically `import()`s the module under test
  on the hot path; vitest cold-starts the transform queue and slow
  imports under parallel-load push it past the 5 s default timeout.
- Within the brief's ≤ 5 pre-existing non-voice failures budget.
- Suggested follow-up (outside K-verify scope): bump `testTimeout` to
  15 s for `*android-native-agent-transport*.test.ts`, or hoist the
  import to top-of-file.

No voice-pipeline tests fail.

---

## K-verify's commits this session (chronological)

The verify watcher made the following format/typing-only repairs to
keep the tree green while the five payload agents were committing:

| Commit | Scope | What broke |
|---|---|---|
| `c57bcf029d` | `@elizaos/ui#lint` | biome required the linux-gpu TEXT_LARGE ladder array on one line after G1/3866b7712e removed `eliza-1-27b-1m`. |
| `e0cc6a9f4b` | `@elizaos/shared#lint` | (a) `catalog.test.ts` LARGE_TIERS array collapse mirror of the previous fix; (b) line-wrap of the omnivoice 0.2.0 sha256 + changelogEntry that `ff1e3aba13` (I-omnivoice) introduced just over biome's print-width. |
| `2f5bce56c8` | `@elizaos/shared#lint` | wrap five more sha256 strings in `voice-models.ts` introduced by R-rename-2's `b4206017a6`. |
| `7f32880bca` | `trajectory-viewer#typecheck` | drop dangling `references: [{ path: "./tsconfig.node.json" }]` from the trajectory-viewer tsconfig — the referenced file was deleted by `80b8539ef4` but the reference wasn't. |
| `b45352cd8f` | `@elizaos/app#lint` | biome's organizeImports rule wanted two `type` re-exports sorted ahead of the value imports in `packages/app/src/main.tsx`'s `@elizaos/app-core` barrel. |

Also a peer fix observed mid-loop:
- `b0e59da28f fix(verify): add q3_k_m + q5_k_m to QUANT_SUFFIX (catalog.ts)`
  — added by another agent after Phase 3B refactor expanded
  `CatalogQuantizationId` from 4 to 6 variants without updating the
  `QUANT_SUFFIX` literal in `packages/shared/src/local-inference/catalog.ts`.

All K-verify commits are typing/lint only. No semantic content was
authored, modified, or merged across agent boundaries.

---

## The 5 parallel agents

### R-rename-2 — `sam` → `same` final rename — **DONE**
- Impl report: `.swarm/voice-finish/WAVE_2_CLOSING_SUMMARY.md` (§ R-rename-2 footer).
- Final commits: `94ef58172d` (path renames), `c5ccb7f983` (in-file),
  `b4206017a6` (docs/manifest/presets), `aaceabc626` (training scripts),
  `5d52fd25fb` (ffi.h doc + kokoro staging), `467dc2317f`
  (voice profile defaults + freeze CLI), `162e24efc8` (closing summary).
- Verify: green. Targeted voice tests: 29/29 + 15/15 + 7/7 +
  `pytest scripts/{kokoro,voice,omnivoice,asr}/__tests__/` 81/81.
- Ambiguous matches intentionally left alone: upstream
  `lalalune/ai_voices/samantha/` subset name, avatar
  `VoiceOutputProvider="sam"` enum, persona/fixture names.

### J-audit — closing remaining TODOs / W3 follow-ups — **DONE**
- Impl report: `.swarm/impl/J-audit.md`.
- Closed: 3 `console.warn` → `logger` AGENTS.md §9 violations
  (`prefill-client.ts:262,272`, `engine-bridge.ts:1542`), stale FFI
  doc comment in `lifecycle.ts`, and W3 follow-up audit.
- Left as documented contracts: `phoneme-tokenizer.ts:66`
  `console.warn` per the task contract (Wave-7 dep).

### G-emotion — Wav2Small distill + HF push — **DONE (eval gate missed)**
- Impl report: `.swarm/impl/G-emotion.md`.
- Distillation pipeline runs cleanly on RTX 5080 Laptop in < 10 min.
- Student trains to 71,666 params (within 5 % of the 72,256 target),
  exports cleanly to INT8 ONNX, ~ 5 ms/inference on CPU.
- Test macro-F1 on the V-A-D projection (shipped runtime metric):
  **0.319**, vs gate **0.35** — short by 0.031.
- Auxiliary classifier head (training-only): 0.355 — would pass, but
  dropped at export.
- **No HF upload performed** per the brief: "If you can't hit the
  gate, document the highest achieved and propose next-step changes;
  do not silently push a sub-gate artifact."
- Local artifact:
  `packages/training/out/emotion-wav2small-v1/wav2small-msp-dim-int8.onnx`
  (516,877 B, sha256 `2fcde4aa2a6881b0e7407a3a706fab1889b69233139ee10b8669795b02b06efc`).

### H-turn — turn detector LoRA + HF push — **DONE**
- Impl report: `.swarm/impl/H-turn.md`.
- **HF revision:** `elizaos/eliza-1-voice-turn@9eaff4947ebd87b1d811e27dec939e29362a9e42`
  (DailyDialog fine-tune, **F1 = 0.9811**).
- Registered as turn-detector v0.2.0 in voice-models registry
  (commit `0d8be5b362`).
- Fixed the scaffold training-signal bug from C-train-phases'
  hand-off (logits indexing on `[:, -1, :2]` was projecting the wrong
  vocab positions).

### F-kokoro — kokoro anchor sweep + HF push — **DONE (no winner)**
- Impl report: `.swarm/impl/F-kokoro.md`.
- Ran the brief's 4-anchor sweep (`anchor ∈ {0.0, 0.05, 0.1, 0.2}`,
  `lr=0.01`, `steps=1200`, init=`af_bella`) with Q1-quality-corrected
  metrics against the renamed `packages/training/data/voice/same/`
  corpus (58 paired clips, 3.51 min, 44.1 kHz).
- **No candidate beats baseline.** Clones move SpkSim in the right
  direction (+0.17 to +0.23 Δ) but at the cost of unintelligible
  audio (WER = 1.00) and UTMOS ~ 2.3 (vs 3.8 gate, ~ 1.85 below).
- **No artifact pushed to HF.** The `OmniVoice ELZ2 v2 'same' preset`
  (committed in `a38a37fa81` by I-omnivoice, pushed to
  `elizaos/eliza-1-voice-omnivoice-same-v01@fd0d04439d`) remains the
  shipped path for `same` voice.
- Final commit: `86265fa8dd wip(F-kokoro): anchor-weight sweep on
  same corpus — no winner`.

### I-omnivoice — OmniVoice freeze + HF push — **DONE**
- Impl report: `.swarm/impl/I-omnivoice.md`.
- **HF repo:** `elizaos/eliza-1-voice-omnivoice-same-v01` (public, new).
- **HF commit:** `fd0d04439d48826abc89dcfc03d9d1f31d29bf20`.
- Files: `voice-preset.elz2` (716 B, sha256 `efb3ab57…`),
  `voice-preset.json`, `manifest-fragment.json`, `eval.json`,
  `README.md`.
- Registered as omnivoice 0.2.0 in `voice-models.ts` (commit
  `ff1e3aba13`), surfaced in `models/voice/manifest.json` as
  `omnivoice-same-preset` (`cache/voice-preset-same.bin`), recorded
  in `models/voice/CHANGELOG.md`.
- Per-voice repo (not subfolder under `eliza-1-voice-omnivoice`)
  chosen to allow a different license envelope (Her-derivative,
  research-only) than the Apache-2.0 base LM.

---

## HF push tally

| Sub-model | HF repo | Pushed? | Notes |
|---|---|---|---|
| OmniVoice "same" frozen preset (0.2.0) | `elizaos/eliza-1-voice-omnivoice-same-v01` | YES | by I-omnivoice |
| Turn detector v0.2.0 (DailyDialog F1=0.9811) | `elizaos/eliza-1-voice-turn@9eaff4947…` | YES | by H-turn |
| Wav2Small emotion (V-A-D) | — | NO | by G-emotion — eval gate missed (0.319 vs 0.35); not pushed |
| Kokoro `same` fine-tune | — | NO | by F-kokoro — no candidate beats baseline; shipped path is OmniVoice preset (above) |
| eliza-1 voice umbrella repos (`elizaos/eliza-1-voice-*`, 10 repos) | various | YES (prior — G4 gauntlet) | base weights already published, see `.swarm/impl/G4-hf-finished.md` |

---

## TODOs closed (J-audit)

- 3 × `console.warn` → `logger` AGENTS.md §9 violations:
  - `prefill-client.ts:262` non-200 prefill response.
  - `prefill-client.ts:272` prefill timeout / network failure.
  - `engine-bridge.ts:1542` attribution failure.
- Stale FFI doc comment in `lifecycle.ts`.
- Audit of `.swarm/impl/I*.md` and `.swarm/impl/W3-*.md` for un-closed
  follow-ups; actionable ones closed.

Documented contract retained:
- `phoneme-tokenizer.ts:66` keeps `console.warn` per the task contract
  (Wave-7 dependency by design).

---

## Remaining open items (and reason)

These are NOT regressions from this session — they are pre-existing
release-gate blockers carried forward into Wave 3 / GPU-operator hand-off:

1. **Kokoro `same` voice clone publish** — F-kokoro's sweep shows the
   clone direction is correct but quality is sub-gate
   (UTMOS/WER regress). Shipped voice is the OmniVoice frozen preset
   above. Next step: longer training / better teacher; tracked in
   `.swarm/impl/F-kokoro.md`.
2. **Wav2Small emotion publish** — G-emotion missed F1 gate by 0.031.
   Local artifact is fine; needs another training pass with
   distillation tweaks before HF push.
3. **Hardware-gated kernel verify** — Metal / iOS / Android
   kernel-verify harnesses ship but require physical hardware to
   flip from "compiles" to "runtime-verified".
4. **Test flake (non-voice):**
   `android-native-agent-transport.test.ts > routes Android local-agent
   requests …` times out at 5 000 ms under parallel load. Passes in
   isolation. Fix is one-liner `it("…", { timeout: 15_000 }, …)` or
   import hoist.

---

## To-be-pushed commits at session close

```
$ git log --oneline origin/develop..HEAD
(empty — develop is up to date with origin)
```

Everything K-verify and the five peer agents committed this session
is on `origin/develop`.

---

## Files of record

- `.swarm/voice-finish/CLOSING_PLAN.md` — closing-batch plan.
- `.swarm/voice-finish/WAVE_2_CLOSING_SUMMARY.md` — umbrella close
  written by R-rename-2.
- `.swarm/voice-finish/WAVE_2_FINAL_SUMMARY.md` — this file
  (K-verify final close).
- `.swarm/voice-finish/eval-q1-rerun/` — Q1 corrected-metric eval JSON.
- `.swarm/impl/{F-kokoro,G-emotion,H-turn,I-omnivoice,J-audit}.md` —
  per-agent impl reports.
- `models/voice/CHANGELOG.md` — per-sub-model history.
- `packages/shared/src/local-inference/voice-models.ts` — machine
  registry.
- `docs/inference/voice-quality-metrics.md` — canonical metrics doc.
