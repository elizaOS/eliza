# @elizaos/bench-eliza-1

Quality and performance benchmark for eliza-1 models. Measures structured-output accuracy and
decoding throughput across three elizaOS agent tasks — response-handler decision (`should_respond`),
action planner (`planner`), and per-action parameter extraction (`action:<name>`) — comparing
eliza-1's unguided, GBNF-guided, and strict-guided decoding modes against a Cerebras reference
baseline (Llama-3.1-8B for tiers up to 9B; GPT-OSS-120B for the 27B tier).

## Quick Start

```bash
# Run all tasks and modes (requires eliza-1 GGUF on disk or CEREBRAS_API_KEY)
bun run --cwd packages/benchmarks/eliza-1 start

# Run harness tests only — no inference keys or GGUF needed
bun run --cwd packages/benchmarks/eliza-1 test

# Specific task + mode + tier
bun run --cwd packages/benchmarks/eliza-1 start \
  --task should_respond --mode guided --tier eliza-1-9b --n 5
```

## Vision CUA sub-harness

The `vision-cua-e2e/` subdirectory is an integration scaffold for the eliza-1 vision +
`plugin-computeruse` loop (capture → tile → describe → OCR → ground → click → verify). It runs
fully in stub mode (no inference, no OS mouse) out of the box.

```bash
bun run --cwd packages/benchmarks/eliza-1/vision-cua-e2e test
```

See [AGENTS.md](AGENTS.md) for full flag reference, fixture derivation, and real-mode wiring.
