# eliza-1 smoke corpus

Ultra-light SFT corpus used to validate the end-to-end training pipeline
(`scripts/format_for_training.py` → `scripts/train_local.py`). **Not** a
real fine-tune mix — row counts are 1–2 orders of magnitude smaller than
the broad `data/final/` and `data/final-eliza1-fullcorpus/` corpora.

## Files

- `train.jsonl` / `val.jsonl` / `test.jsonl` — 80 / 10 / 10 split,
  deterministic shuffle (seed 42).
- `manifest.json` — full source-by-source counts, trajectory date
  window, privacy-filter attestation, and split ratios.

Every row is `format_record`-valid; the builder verifies this on the
output before exit.

## Recipe (see `scripts/build_eliza1_smoke_corpus.py` for the source of truth)

1. Sample 3 rows from each `data/normalized/<source>.jsonl` that has at
   least one `format_record`-valid candidate. Sources are seeded
   deterministically per name.
2. Sample 10 rows from `datasets/eliza1-sft-0_6b/train.jsonl` (exercises
   the chat-messages schema path).
3. Sample 10 rows from `data/final/train.jsonl` (exercises the broad
   mixed-final pipeline).
4. Convert recent Eliza scenario trajectories from
   `~/.milady/trajectories/` (or `ELIZA_TRAJECTORY_DIR`) to
   `eliza_native_v1` boundary rows via
   `sample_native_trajectory_alignment.native_rows_from_recorded_trajectory`.
   Window: trajectories with `mtime` in the last 7 days. Cap: 100 rows.
5. Concatenate, shuffle, split.

## Privacy filter

The canonical Python port of the app-training privacy filter
(`scripts/privacy_filter_trajectories.py`) is applied to every emitted
row through `format_record`. The filter masks OpenAI / Anthropic /
Bearer / GitHub / AWS credentials, latitude/longitude pairs and JSON
coords blocks, and the contact-like patterns from LifeOps lint. There
is no bypass path — `format_record` fails closed if the filter cannot
load.

## How to regenerate

```bash
cd packages/training
python3 scripts/build_eliza1_smoke_corpus.py
```

The builder is idempotent (writes overwrite). If you want a different
trajectory source path, set `ELIZA_TRAJECTORY_DIR=/path/to/trajectories`
before invoking. To rebuild without trajectories (e.g. on a fresh
machine), point `ELIZA_TRAJECTORY_DIR` at an empty directory — the
manifest will record `skipped_reason` accordingly.
