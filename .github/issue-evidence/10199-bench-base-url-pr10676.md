# 10199 bench-server base URL folding (#10676)

## Scope

Verification evidence for PR #10676, which folds OpenAI-compatible provider
base-url environment variables into the benchmark runtime settings map:

- `OPENAI_BASE_URL`
- `CEREBRAS_BASE_URL`
- `OPENROUTER_BASE_URL`
- `GROQ_BASE_URL`

The bug fixed by the PR was that the benchmark server already folded provider
API keys into `runtime.getSetting()`, but not the base URLs used by
`@elizaos/plugin-openai`. Agent-driven benchmarks could therefore authenticate
direct model calls while the agent response path fell back to the wrong
endpoint.

## Commands

```bash
bun install --ignore-scripts
node packages/shared/scripts/generate-keywords.mjs --target ts
bun run build:core
bun test --coverage-reporter=lcov packages/app-core/src/benchmark/__tests__/cerebras-endpoint.test.ts
CEREBRAS_MODEL=gpt-oss-120b \
BENCHMARK_MODEL_PROVIDER=cerebras \
BENCHMARK_MODEL_NAME=gpt-oss-120b \
ELIZA_PROVIDER=cerebras \
OPENAI_API_KEY="$CEREBRAS_API_KEY" \
OPENAI_BASE_URL="$CEREBRAS_BASE_URL" \
OPENAI_LARGE_MODEL=gpt-oss-120b \
OPENAI_MEDIUM_MODEL=gpt-oss-120b \
OPENAI_SMALL_MODEL=gpt-oss-120b \
ELIZAOS_CLOUD_ENABLED=false \
PYTHONPATH=packages \
python3 -m benchmarks.orchestrator run \
  --benchmarks context_bench \
  --provider cerebras \
  --model gpt-oss-120b \
  --force \
  --extra '{"context_lengths":[512],"positions":["start"],"tasks_per_position":1,"harness":"eliza"}'
```

## Results

- `build:core`: passed, 64 successful tasks.
- Focused Cerebras endpoint tests: 11 pass, 0 fail, 34 assertions.
- Live `context_bench` run:
  - run group: `rg_20260701T062348Z_e920e81a`
  - run id: `run_context_bench_20260701T062348Z_1_26d66083`
  - provider/model: `cerebras` / `gpt-oss-120b`
  - status: `succeeded`
  - score: `1.0`

## Manual Artifact Review

Raw benchmark outputs were generated under the gitignored
`packages/benchmarks/benchmark_results/` tree and were inspected locally, not
committed.

Reviewed files:

- `packages/benchmarks/benchmark_results/latest/context_bench__eliza.json`
- `packages/benchmarks/benchmark_results/rg_20260701T062348Z_e920e81a/context-bench__context_bench/run_context_bench_20260701T062348Z_1_26d66083/output/context_bench_eliza_20260701_022351_detailed.json`
- `packages/benchmarks/benchmark_results/rg_20260701T062348Z_e920e81a/context-bench__context_bench/run_context_bench_20260701T062348Z_1_26d66083/output/telemetry.jsonl`
- `packages/benchmarks/benchmark_results/rg_20260701T062348Z_e920e81a/context-bench__context_bench/run_context_bench_20260701T062348Z_1_26d66083/stdout.log`
- `packages/benchmarks/benchmark_results/rg_20260701T062348Z_e920e81a/context-bench__context_bench/run_context_bench_20260701T062348Z_1_26d66083/stderr.log`

Observed:

- `latest/context_bench__eliza.json` reported `status=succeeded`,
  `score=1.0`, `overall_accuracy=1.0`, `provider=cerebras`, and
  `model=gpt-oss-120b`.
- `telemetry.jsonl` captured the real `RESPONSE_HANDLER` trajectory: the model
  answered the generated password-retrieval task correctly (`ZZPQK51F`), with
  `provider=cerebras`, `model=gpt-oss-120b`, and token usage recorded.
- Server stdout showed Cerebras autowiring and registered model handlers for
  `RESPONSE_HANDLER` and `ACTION_PLANNER` through `@elizaos/plugin-openai`.
- Server stderr did not contain the previous auth-fallback text and did not
  contain the earlier setup-only `OpenAI plugin not available` warning.

## N/A Evidence

- Screenshots/screen recording: N/A. This PR changes benchmark server
  configuration plumbing and is verified through live benchmark artifacts and
  server logs, not a browser/UI flow.
- Audio: N/A. No voice/TTS/STT surface changed.
