# @elizaos/claude-subscription-gateway

Loopback-only benchmark model boundary that exposes JSON and SSE OpenAI Chat Completions
responses and performs each completion through a fresh official Claude Agent SDK query.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/claude-subscription-gateway test   # tests
```

No standalone build script is defined; this package is consumed or executed from source.

Run the harness with `bun run --cwd packages/benchmarks/suites/claude-subscription-gateway start`. Live runs require the suite’s configured models, credentials, or hardware; offline tests do not establish a benchmark score.
