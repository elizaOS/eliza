# Eliza-1 synthetic smoke corpus

This is a tiny, deterministic fixture for exercising the corpus formatter and
the end-to-end SFT pipeline. It is not a model-quality training or evaluation
corpus.

The 20 hand-authored inputs live in
[`../../fixtures/eliza1-smoke-source.jsonl`](../../fixtures/eliza1-smoke-source.jsonl).
Every source envelope declares `synthetic: true`, carries an explicit split,
and contains no external dataset or runtime-trajectory input. The fixture
exercises direct messages, native request/response boundaries, native tool
calls, and the legacy flat-record compatibility path.

## Generated files

- `train.jsonl` — 16 formatted rows.
- `val.jsonl` — 2 formatted rows.
- `test.jsonl` — 2 formatted rows.
- `manifest.json` — SHA-256 provenance for the source, generator, formatter,
  privacy filter, and exact bytes of every split.

The split files contain only the object returned by
`scripts/format_for_training.py::format_record`. That return value has already
passed through the canonical privacy filter; raw source envelopes are never
serialized to the generated corpus.

## Regenerate and verify

From `packages/training`:

```bash
python3 scripts/build_eliza1_smoke_corpus.py
python3 scripts/build_eliza1_smoke_corpus.py --check
```

The manifest omits timestamps and machine paths, so regeneration is
byte-for-byte stable. `--check` exits nonzero when any tracked generated file
is missing or stale.
