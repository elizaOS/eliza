# @elizaos/lifeops-bench

LifeOpsBench server-side harness: HTTP bench server, LifeOps fake backend, Cerebras
autowirer, and bench plugin driven by the Python runners in suites/. Runs against an
elizaOS checkout (ELIZA_REPO_DIR); never published.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/lifeops-bench/runner typecheck  # typecheck
bun run --cwd packages/benchmarks/suites/lifeops-bench/runner test   # tests
```

Run the harness with `bun run --cwd packages/benchmarks/suites/lifeops-bench/runner benchmark:server`. Live runs require the suite’s configured models, credentials, or hardware; offline tests do not establish a benchmark score.

The server probes text embedding generation at startup. Health and turn receipts include its availability or failure; a dimension-only initialization vector does not establish availability. Cerebras requires a separate real embedding endpoint or local provider. Explicit chat-only and diagnostic stand-in modes skip the probe. An available vector generator does not establish retrieval quality; memory benchmarks must verify recall separately.
