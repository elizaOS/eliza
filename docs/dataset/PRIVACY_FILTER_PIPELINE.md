# Trajectory Privacy Filter Pipeline

Real user trajectory export is supported as an input to local dataset
preparation, but it is not automatically included in the first Hugging Face
dataset. A dataset manifest must opt into any redacted real-user export
explicitly. The first HF dataset should remain synthetic/public unless a later
review approves a redacted trajectory bundle and its ledger.

## Local CLI

Run the filter before any trajectory JSON/JSONL becomes training data:

```bash
python3 packages/training/scripts/privacy_filter_trajectories.py \
  --input ~/.milady/trajectories \
  --output-jsonl data/private/redacted-trajectories.jsonl \
  --ledger-jsonl data/private/redaction-ledger.jsonl \
  --stats-json data/private/privacy-stats.json \
  --strict
```

Inputs may be `.json`, `.jsonl`, or `.ndjson` files, or directories containing
those files. Directories are scanned recursively. JSON arrays and common
container keys (`rows`, `records`, `examples`, `data`) are expanded into output
JSONL rows.

## What Is Redacted

The local regex pass recursively scans every JSON string value and object key.
It writes a redacted JSONL row for each input row.

Covered categories:

- `secret`: OpenAI-style keys, Anthropic-style keys, bearer tokens, GitHub
  personal access token shapes, AWS access key IDs, and optional process
  environment secret values with `--redact-env-secrets`.
- `geo`: JSON latitude/longitude pairs, labeled coordinates, location labels,
  and bare decimal coordinate pairs.
- `contact`: email addresses, formatted phone numbers, `@handle` values, and
  the known PII-name lint list used by LifeOps default-pack checks.

Local regex redaction runs before any external backend. That ordering keeps
known secrets and coordinates out of model-backed privacy filters.

## Outputs

The CLI emits three artifacts:

- Redacted JSONL: safe candidate input for downstream training transforms.
- Redaction ledger JSONL: one row per redaction, containing category, label,
  structural JSON path, hashed source-file reference, record index, hashed
  record reference, replacement marker, value length, and a SHA-256 hash of the
  matched value. Object-key path segments are hash-addressed because keys can
  also contain PII. The ledger does not store raw PII.
- Aggregate stats JSON: record counts, redaction counts by category/label/source,
  backend call counts, and residual high-risk counts.

Strict mode (`--strict`) scans the redacted output for residual high-risk
patterns and exits non-zero if any remain. It still writes the stats file so CI
or a human can inspect the residual labels and paths.

## OpenAI Privacy Filter Boundary

The optional model/backend integration is a command hook, not an in-process
dependency:

```bash
python3 packages/training/scripts/privacy_filter_trajectories.py \
  --input exports/raw-trajectories.jsonl \
  --output-jsonl exports/redacted.jsonl \
  --ledger-jsonl exports/redaction-ledger.jsonl \
  --stats-json exports/privacy-stats.json \
  --strict \
  --openai-privacy-filter-command "python tools/openai_privacy_filter_wrapper.py" \
  --backend-name openai-privacy-filter \
  --backend-model <model-name>
```

For each string that passes local regex redaction and is under
`--backend-max-chars`, the hook receives JSON on stdin:

```json
{
  "text": "already regex-redacted text",
  "path": "$[key:599a4471abb0][key:7133cc77a47d][0][key:ed7002b439e9]",
  "record_index": 12,
  "record_id": "sha256:4d6fcd9cf31d3a2e",
  "backend_name": "openai-privacy-filter",
  "model": "<model-name>"
}
```

The hook may return either a rewritten text:

```json
{"text": "text with model-detected PII redacted"}
```

or span redactions:

```json
{
  "redactions": [
    {
      "start": 0,
      "end": 5,
      "label": "person-name",
      "replacement": "<REDACTED:person-name>"
    }
  ]
}
```

Tests do not require the OpenAI SDK or any OpenAI Privacy Filter package. The
wrapper is the bridge point for a future installed backend.

## Dataset Gate

Use the redacted JSONL as an input to later format/validation scripts only
after reviewing:

1. `privacy-stats.json` has `residual_high_risk.total == 0`.
2. The ledger contains no raw values and its counts match the stats file.
3. The dataset manifest records the source export path, filter command,
   stats hash, ledger hash, and review approval.

Do not wire real user trajectory exports into automatic HF publishing by
default.
