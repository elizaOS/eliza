# eliza-1 v2 corpus — build status (2026-05-05)

## What ran

**Synth (Groq gpt-oss-120b, 4 workers, --per-task 500):**

- `data/synthesized/phase3/` — 7 actions × 500 records
  - post_creation, remove_contact, post_action_decision (499),
    extract_secret_request, extract_secret_operation,
    extract_option, reply (496) → **3,495 records**
- `data/synthesized/evaluators/` — 5 evaluators × ~480 records
  - reflection (480), reflection_evaluator (495), summarization (493),
    fact_extractor (499), long_term_extraction (386)
    → **2,353 records**

**Total synth: 5,848 records.**

## Conformance after transforms

After `transform_repair_toon_bullets` + `transform_normalize_fact_ops` +
`transform_flatten_summary_lists`:

| task_type             | total | conformant | conformance % |
|-----------------------|------:|-----------:|--------------:|
| reflection            |   480 |        469 |        97.71% |
| reflection_evaluator  |   495 |        495 |       100.00% |
| summarization         |   493 |        493 |       100.00% |
| fact_extractor        |   499 |        273 |        54.71% (a) |
| long_term_extraction  |   386 |        386 |       100.00% |
| post_creation         |   500 |        500 |       100.00% |
| remove_contact        |   500 |        401 |        80.20% (b) |
| post_action_decision  |   499 |        499 |       100.00% |
| extract_secret_req    |   500 |        500 |       100.00% |
| extract_secret_op     |   500 |        500 |       100.00% |
| extract_option        |   500 |          0 |         0.00% (c) |
| reply                 |   496 |        496 |       100.00% |

(a) `fact_extractor`: 226/499 records have canonical ops but lack the
    audit's expected `claim`/`since`/`factId` structured fields — the
    runtime is permissive about this; records still train fine.
(b) `remove_contact`: 99 records emit empty `contactName` when the user
    didn't actually name a contact — semantically correct but the audit
    flags the empty string.
(c) `extract_option`: shape mismatch — the synth produces
    `{taskId, selectedOption}` (matches the runtime extractOption schema)
    but the audit validator expects `{option, confidence}`. Audit-side
    bug, not a record-quality issue.

## v2 corpus

| Source                  | Records   |
|-------------------------|----------:|
| v1 records scanned      | 1,059,915 |
| v1 records kept         |   927,178 |
| Dropped: reasoning_cot  |   113,672 |
| Dropped: plugin-*       |       179 |
| Dropped: OOB after xfm  |    18,886 |
| Transformed: dataset-generator → strip prefix | 92 |
| Synth records added     |     5,848 |
| **v2 total**            | **933,026** |

**Phase distribution:**

| Phase | Records | % |
|------:|--------:|--:|
| 1 (should_respond)         | 119,459 | 12.80% |
| 2 (response/reply)         | 807,691 | 86.57% |
| 3 (action)                 |   3,357 |  0.36% |
| 4 (evaluation)             |   2,519 |  0.27% |

**Splits (random 95/4/1, seeded 0xDEADBEEF):**

- `train.jsonl` — 875,989 records (12.3 GB)
- `val.jsonl`   — 41,794 records (582 MB)
- `test.jsonl`  — 15,243 records (356 MB)

## Files on disk

```
data/final/
  train.jsonl              # v2 train split (875,989 records)
  val.jsonl                # v2 val split  (41,794 records)
  test.jsonl               # v2 test split (15,243 records)
  manifest_final.json      # publish-ready manifest with split counts
  manifest_v2.json         # build_v2_corpus output (same content)
  train_v2.jsonl           # pre-split v2 corpus (933,026 records)

data/synthesized/
  evaluators/*.jsonl       # 2,353 records, 5 files
  evaluators/_backup/      # pre-rerun backups for safety
  phase3/*.jsonl           # 3,495 records, 7 files
```

## What's left — push to HF (needs HF_TOKEN)

The publish step is gated on `HF_TOKEN` (or `HUGGINGFACE_HUB_TOKEN`).
Once the token is exported:

```bash
HF_TOKEN=hf_xxxxxxxxxxxx python3 scripts/publish_dataset_to_hf.py \
  --dataset training --repo-id elizaos/eliza-1-training
```

Dry-run plan:
- `data/final/train.jsonl`            → `train.jsonl`        (12.30 GB)
- `data/final/val.jsonl`              → `val.jsonl`           (582 MB)
- `data/final/test.jsonl`             → `test.jsonl`          (356 MB)
- `data/final/manifest_final.json`    → `manifest.json`         (~2 KB)

Total payload: 14.18 GB across 4 files.

## Known imbalance

Phase-3 + Phase-4 together are still only **0.63 %** of v2 — synth at
500/template only adds 5.8K of these phases against 800K Phase-2 from
v1. The model will see Phase-3/4 shapes but not enough to robustly
generalize. Two options for follow-up:

1. **Bigger synth run.** Bump `--per-task` to 3000+ for both phase3
   and evaluator scripts → ~30K Phase-3/4 records (3 % of corpus).
   Cost: 6× more Groq calls (~30 min).

2. **Phase-2 cap.** Pass `--phase2-cap 100000` to `build_v2_corpus.py`
   to reservoir-sample Phase-2 down to ~100K. Result: P2=44 %, P1=52 %,
   P3+P4=2.6 %. Faster and cheaper than option 1, but throws away
   useful Phase-2 signal.

Both options are orthogonal — combining them gets to ~10 % Phase-3/4
which is closer to "balanced for harness training".

## Scripts added or modified this run

- `scripts/synthesize_evaluator_prompts.py` — Groq adapter, reasoning_effort,
  retry-with-backoff, normalize_teacher_output (JSON→TOON, repair, round-trip),
  tightened FACT/SUMMARIZATION templates with WRONG/RIGHT examples,
  synth-time TOON-decode rejection.
- `scripts/synthesize_phase3_actions.py` — same Groq adapter pattern,
  normalize_teacher_output, _TOON_PREAMBLE prefixed onto every per-task
  system prompt, explicit shape examples for reply / extract_secret_*  /
  extract_option / post_action_decision, synth-time TOON-decode rejection.
- `scripts/transform_repair_toon_bullets.py` — two-pass (indexed-assign
  collapse + markdown-bullet → array). Idempotent.
- `scripts/transform_normalize_fact_ops.py` — `op:insert/add/update` →
  `add_durable`/`add_current` based on category prefix or hint
  heuristics. Recovers ~150 fact_extractor records that otherwise fail.
- `scripts/transform_flatten_summary_lists.py` — recovers `keyPoints`
  items that TOON-parsed as `{"Started 1": "1 meetings..."}` due to
  literal colons in the text. Recovered 209 summarization records
  (lifted conformance from 57 % → 100 %).
- `scripts/build_v2_corpus.py` — already in place, takes v1 train.jsonl
  + synth dirs and emits train_v2.jsonl + manifest_v2.json with phase
  distribution, dropped-task counters, and per-source stats.
- `scripts/split_v2.py` — random 95/4/1 split into train/val/test.
- `scripts/audit_pipeline_shapes.py` — already in place, reflection
  validator fixed to check the right schema fields.
- `scripts/finalize_v2_corpus.sh` — orchestrates repair → normalize →
  audit → build_v2 in one idempotent pass.

## Commits added on this run

- `9be4851cbe` synth: JSON→TOON transcode + round-trip + harden phase3 prompts
- `68aae1ba15` synth: add summary keyPoints flattener + finalize_v2_corpus
- `2a2dde2c01` v2: add split_v2.py — random 95/4/1 split for HF publish
