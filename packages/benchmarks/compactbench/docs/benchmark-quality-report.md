# CompactBench benchmark quality report

Date: 2026-05-12

## What changed

- The primary CompactBench score is the repaired benchmark score. The raw lexical score is retained only as audit telemetry.
- Generated cases that require and forbid the same normalized phrase are repaired before scoring. Locked decisions win; impossible forbidden probes are removed, and mixed `set_match` items drop only the conflicting value.
- Rescoring existing JSONL analysis now applies the same generated-case repair logic as live analysis.
- Manual review records are emitted per case with model input, model output, expected answer, scoring reason, artifact context, compression ratio, and latency.
- The response scorer now removes credit when an otherwise exact required phrase is explicitly negated before the phrase.

## Remaining limitations

- The repaired scorer is intentionally conservative and response-local. It does not inspect strategy names, case ids, transcripts, or artifacts when deciding whether an answer is valid.
- The raw lexical scorer can still be useful for drift debugging, but it is not the benchmark score used by elizaOS.
- Hermes and OpenClaw CompactBench rows remain unsupported until they expose real transcript-in/artifact-out compaction adapters. A labeled row without that adapter would be a false cross-agent claim.

## Recommended next runs

```bash
cd packages/benchmarks/compactbench
export CEREBRAS_API_KEY=...
python run_cerebras.py \
  --method "$(pwd)/eliza_compactbench/compactors/__init__.py:HybridLedgerCompactor" \
  --suite elite_practice \
  --case-count 3 \
  --drift-cycles 5 \
  --score \
  --analyze-valid-hits
```

Use `manual_review_items` in the generated `.valid-hits.jsonl` to inspect every remaining miss before changing scorer rules.
