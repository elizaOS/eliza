# eliza-format

Strict-format eliza-1 benchmark. Replays held-out test records from
`training/data/final/test.jsonl` through a model under test and scores two
dimensions per bucket (`should_respond`, `message_handler`, `reply`,
`claude_distill`):

- **format_ok** — TOON parses and required fields for the bucket are present.
- **content_ok** — semantic match on action names / RESPOND-vs-IGNORE / etc.

The benchmark wraps `training/scripts/benchmark/eliza_bench.py` in place; no
copy or move. Higher is better. The score extractor returns
`0.5 * format_ok + 0.5 * content_ok` averaged across buckets, in [0, 1].

## Run

```
python -m benchmarks.orchestrator run \
    --benchmarks eliza-format \
    --provider vllm \
    --model eliza-1-9b
```

Defaults to 200 examples per bucket. Override via `--extra '{"max_per_bucket": N}'`.

## No-credential smoke

```
python -m benchmarks.orchestrator run \
    --benchmarks eliza-format \
    --provider mock \
    --model smoke \
    --extra '{"test_file":"packages/benchmarks/eliza-format/fixtures/smoke.jsonl","max_per_bucket":1}' \
    --force
```

The mock provider replays expected answers from the fixture and writes the same
`summary.json` shape as real HF/API runs.
