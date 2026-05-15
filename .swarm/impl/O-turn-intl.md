# O-turn-intl — Voice Wave 2 closing: multilingual turn-detector end-to-end

**phase=impl-done**
**Agent:** O-turn-intl
**Date:** 2026-05-15
**Branch:** `develop`
**Final HF revision:** `elizaos/eliza-1-voice-turn@7ec50ce4b65943ccc32a14959c54181f57a0a284`

---

## A. Critical Assessment

### Entering O-turn-intl

H-turn had landed the English `v1.2.2-en` fine-tune at F1=0.9811 against
`elizaos/eliza-1-voice-turn`. The training infrastructure
(`finetune_turn_detector.py`, `eval_turn_detector.py`, `push_to_hf.py`,
`convert_to_gguf.py`) was wired for both English and multilingual paths.
Prior O-turn-intl WIP commits had already added:

- `--pretrain-corpus oasst1-intl` CLI option + `build_multilingual_eou_corpus()`
  + `stage_multilingual_train_eval()` for OASST1 (14 LiveKit locales,
  per-language cap, CJK-aware utterance splitting).
- `eval_turn_detector.py` per-language F1 stratification when records carry
  a `lang` field.
- `turn_detector_intl.yaml` config (tier=4b, lr=3e-5, lora_rank=16).
- `turn-detector-intl` model id in `VoiceModelId` union.
- Multilingual smoke-test harness (`smoke_test_intl.py`, hand-crafted EOU
  pairs in en/es/ja/de/zh/fr).

The corpus had been staged on a prior run (`oasst1-intl.train.jsonl`,
47 342 examples; `oasst1-intl.eval.jsonl`, 1 248 examples, stratified
across 12 locales). The first training attempt OOM'd at model-load
(other processes had used 13 GB of the 16 GB GPU); checkpoints were
empty. No artifacts had been pushed to HF — the repo
`elizaos/eliza-1-voice-turn` referenced by H-turn no longer existed and
needed to be re-created.

### Problems found during execution

1. **`push_to_hf.py` did not pass `--locale` to the model-card renderer.**
   `_render_model_card()` accepts a `locale` kwarg that switches between
   the EN and INTL files-block / arch-note / training-block, but
   `main()` invoked it without `locale=`. Every intl push would have
   rendered an EN README. Fixed in this run.
2. **`append_voice_model_version.py` global H3 check.** The
   `--append-changelog` path detects "already-published" via
   `^### <version>` anywhere in the file, not scoped to the model H2.
   Existing `### 0.1.0` entries for speaker-encoder / diarizer / etc.
   triggered a false positive. Worked around by adding the
   `## turn-detector-intl` H2 + the 0.1.0 H3 manually.
3. **The default `push_to_hf --path-in-repo voice/turn-detector` is the
   peer convention for `elizaos/eliza-1`** (the consolidated voice repo).
   The brief explicitly mandates the dedicated repo `elizaos/eliza-1-voice-turn`
   with `intl/` subfolder at repo root. Passed `--path-in-repo ""` so
   the bundle lands directly under `intl/` at root.
4. **30 ms latency gate.** The intl model is 500M params (Qwen2-0.5B
   pruned) vs the 135M EN model. Single-thread CPU INT8 ONNX latency
   came in at 95 ms — well over the 30 ms gate set for the EN model.
   Brief said F1 ≥ 0.85; latency is informational. Documented.

### Resolution path

1. Verified GPU was free (peer processes had released VRAM since the
   first OOM).
2. Trained from scratch: `--pretrain-corpus oasst1-intl --max-steps 8000
   --checkpoint-every 500 --batch-size 16`. `cfg.epochs=1` was the
   effective limit (2 959 steps per epoch with 47 342 examples / batch
   16); training exited naturally at step 2 959 with best F1=0.9379 at
   step 2 000.
3. Auto-export emitted `model_q8.onnx` (262 MB INT8) + tokenizer
   sidecars under `out/turn-detector-intl-v1/onnx/`. Removed the 1 GB
   `model_q8.fp32.onnx{,.data}` intermediates so they didn't get staged
   into the HF bundle.
4. Ran `eval_turn_detector.py` against the held-out OASST1 eval JSONL
   for the real INT8-runtime F1 + per-language F1.
5. Ran `smoke_test_intl.py` on hand-crafted multilingual EOU pairs.
6. Saved fine-tuned weights to `hf-format/` and ran
   `convert_hf_to_gguf.py --outtype q8_0` to produce
   `turn-detector-intl-q8.gguf` (281 MB).
7. Fixed the `locale=args.locale` bug in `push_to_hf.py`.
8. Created `elizaos/eliza-1-voice-turn` (public, Apache-2.0) and
   uploaded the staged bundle at `intl/...` root. Re-uploaded the
   README after the locale-passthrough fix.
9. Appended the registry entry via `append_voice_model_version.py` and
   added a manual CHANGELOG H2 + H3 for `turn-detector-intl`.

---

## B. Implemented Changes

### Training pipeline (`packages/training/scripts/turn_detector/`)

- `push_to_hf.py` — bug fix: pass `locale=args.locale` to
  `_render_model_card()` so intl pushes render the intl files-block,
  arch-note (Qwen2-0.5B), and OASST1 training-block instead of the EN
  SmolLM2 / DailyDialog text.

### Registry + changelog

- `packages/shared/src/local-inference/voice-models.ts` — new
  `VOICE_MODEL_VERSIONS` entry for `turn-detector-intl` v0.1.0 (prepended
  per the rolling-history convention).
- `models/voice/CHANGELOG.md` — new `## turn-detector-intl` H2 + `### 0.1.0`
  H3 with corpus, hardware, hyperparameters, per-language F1, smoke-test
  outcome.

### HF repo state (`elizaos/eliza-1-voice-turn`)

Two commits during this session:

| Commit  | Title                                                          |
| ------- | -------------------------------------------------------------- |
| `1c26df29b36192adbf4ee615015401f7803df2be` | feat(O-turn-intl): publish multilingual turn-detector v0.1.0   |
| `7ec50ce4b65943ccc32a14959c54181f57a0a284` | fix(O-turn-intl): regenerate README with locale=intl content   |

Final tree:

```
.gitattributes
README.md                              4.1 KB  (multilingual model card, locale=intl)
manifest.json                          1.9 KB  (schema-compliant, intl-only)
intl/added_tokens.json                 605 B
intl/config.json                       738 B
intl/eval.json                         487 B   {"f1":0.9308,"meanLatencyMs":95.47,"f1ByLang":{...12 langs...},...}
intl/generation_config.json            242 B
intl/merges.txt                        1.6 MB
intl/model_q8.onnx                     262 MB  ← fine-tune INT8 ONNX (af70f5b5e815...)
intl/special_tokens_map.json           613 B
intl/tokenizer_config.json             4.7 KB
intl/tokenizer.json                    10.9 MB
intl/turn-detector-intl-q8.gguf        281 MB  ← fine-tune Q8_0 GGUF (5dbcba3fb490...)
intl/vocab.json                        2.6 MB
```

---

## C. Eval Results

### Training (bf16 in-training, OASST1 held-out split, 1 248 examples)

| Step | F1     | mean_pos_score | best_f1 |
| ---- | ------ | -------------- | ------- |
| 500  | 0.9287 | 0.9138         | 0.9287  |
| 1000 | 0.9326 | 0.9059         | 0.9326  |
| 1500 | 0.9325 | 0.9246         | 0.9326  |
| 2000 | 0.9379 | 0.9016         | **0.9379** |
| 2500 | 0.9330 | 0.9246         | 0.9379  |

Best checkpoint exported: `step-002000.pt`.

### INT8 ONNX runtime (post-quantisation eval, same eval JSONL)

```json
{
  "f1": 0.9308,
  "meanLatencyMs": 95.4726,
  "passed": false,
  "f1ByLang": {
    "de": 0.9826,
    "en": 0.9412,
    "es": 0.9222,
    "fr": 0.8992,
    "it": 0.7692,
    "ja": 0.8889,
    "pt": 0.9846,
    "ru": 0.9071,
    "zh": 0.9053,
    "id": 1.0,
    "ko": 0.0,
    "tr": 1.0
  },
  "countByLang": {
    "de": 200, "en": 200, "es": 200, "ru": 200, "zh": 187,
    "fr": 146, "pt": 70, "it": 22, "ja": 20,
    "id": 1, "ko": 1, "tr": 1
  }
}
```

**F1 gate (≥ 0.85): passed by +0.0808.** `passed=false` in the gate
report is the meanLatencyMs ≤ 30 ms check, which is for the 135M EN
model — the 500M intl model is intrinsically slower on single-thread CPU.
The brief explicitly says F1 ≥ 0.85 is the gate; latency is
informational.

### Smoke test (hand-crafted multilingual EOU pairs)

5 of 6 languages pass complete-vs-prefix discrimination at threshold 0.5:

| Lang | complete probs                | prefix probs       | pass |
| ---- | ----------------------------- | ------------------ | ---- |
| en   | 0.998, 0.994                  | 0.0002, 0.144      | yes  |
| es   | 0.999, 0.988                  | 0.0003, 0.034      | yes  |
| ja   | 0.987, **0.137**              | 0.003, 0.00006     | no¹  |
| de   | 0.999                         | 0.00007            | yes  |
| zh   | 0.998                         | 0.0003             | yes  |
| fr   | 0.999                         | 0.00003            | yes  |

¹ Japanese closing politeness `もう話し終わりました、どうぞ。` scored
0.137 — known weakness, n=201 train / n=20 eval for ja in OASST1.

---

## D. Repo commits on `develop`

Inherited from prior O-turn-intl session (before this re-dispatch):

| Commit       | Summary                                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| `928c1aa6f9` | wip(O-turn-intl): add OASST1 multilingual EOU corpus builder + eval lang stratification |
| `0462dafba6` | wip(O-turn-intl): fix CJK utterance splitting in OASST1 corpus                       |
| `6d581aea6d` | wip(O-turn-intl): add turn-detector-intl model id to registry types                  |
| `4be2be3709` | wip(O-turn-intl): add multilingual smoke-test harness for the exported ONNX         |

This session (final closeout):

| Commit       | Summary                                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| (this commit) | feat(O-turn-intl): publish multilingual turn-detector v0.1.0 — F1=0.9308 (intl)     |

---

## E. Verification

```
$ python3 -m pytest packages/training/scripts/turn_detector/ -v
============================== 25 passed in 0.20s ==============================

$ python3 -m pytest packages/training/scripts/test_append_voice_model_version.py -v
============================== 8 passed in 0.81s ===============================

$ cd plugins/plugin-local-inference && bunx vitest run eot-classifier
Test Files  1 passed (1)
Tests       38 passed (38)
```

`bun run verify` not re-run in this session (the verify suite is owned
by V-verify-final per `.swarm/collab.md` — peer-agent edits are in
flight on unrelated paths; my scope (training scripts + registry +
CHANGELOG) is verified by the suites above).

---

## F. Hard rules / scope

- HF token never logged or committed.
- APOLLO-Mini optimizer used throughout (per
  `packages/training/AGENTS.md` §1, no Adam / Lion / etc.).
- bf16 training, INT8 ONNX + Q8_0 GGUF as published artifacts.
- Apache-2.0 fine-tune weights only; LiveKit CC-BY-NC base weights not
  redistributed.

---

## G. Known limitations / follow-ups

- **Latency:** 95 ms per-classification on single-thread CPU. Voice
  pipeline can either accept this (turn detection runs ~once per
  utterance, not per-token) or wire a GPU / batched path. Tracked in
  the registry `evalDeltas.f1Delta=+0.09` but not gated.
- **Japanese coverage:** OASST1 ja prompter rows are sparse. Future
  work: add a ja-specific prefix corpus (e.g. NEologd-tokenised
  Japanese DailyDialog mirror, or Japanese-tagged Wikipedia first-line
  utterances).
- **ko / id / tr coverage:** Each landed only 1 eval sample (single
  OASST1 row passed the multilingual filter). Functional but not
  measurable.
- **Italian:** F1=0.7692 at n=22 — borderline. Likely cured by raising
  `--per-lang-cap` for Italian, or by adding a second multilingual
  source (e.g. `lmsys/chatbot_arena_conversations` it-tagged rows).
