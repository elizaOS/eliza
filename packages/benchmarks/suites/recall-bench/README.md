# @elizaos/recall-bench

Precision/Recall/nDCG/latency benchmark + CI gate for the **real** memory-recall +
knowledge-retrieval pipeline (#9956).

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/recall-bench test   # tests
```

No standalone build script is defined; this package is consumed or executed from source.

Run the harness with `bun run --cwd packages/benchmarks/suites/recall-bench bench`. Live runs require the suite’s configured models, credentials, or hardware; offline tests do not establish a benchmark score.
