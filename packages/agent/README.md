# @elizaos/agent

Standalone agent host and HTTP/WebSocket backend around the elizaOS runtime.

Hosts explicitly compose core, assistant, storage, and model plugins. Start from the
repository root with `bun run start`; use `bun run dev` for the app and API together.
Configure providers and connectors through the host configuration; never expose host
secrets to ungranted agents.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/agent build  # build
bun run --cwd packages/agent test   # tests
```

Retain real end-to-end scenarios exercising host, transport, and persistence.
The package test, test:e2e, and test:integration commands share that suite;
do not reintroduce removed unit, mock, smoke, or source-inspection tests.

Run the native coding CLI end to end with configured provider credentials:

```bash
BENCHMARK_NATIVE_CODING_E2E=1 BENCHMARK_NATIVE_MODEL=<model> \
  bun --conditions=eliza-source node_modules/vitest/vitest.mjs run \
  --config packages/agent/vitest.config.ts packages/agent/test/benchmark-coding-live.test.ts
```

This uses a real provider and isolated Git fixture, verifies executed FILE/SHELL
actions and Python tests, and requires clean process shutdown. Receipts are saved
under `test-results/agent-native-coding/`. Configure provider-specific model
settings to match `BENCHMARK_NATIVE_MODEL` when overriding the shared defaults.

Benchmark JSON separates `turn_completed` from the optional planner assessment
`request_fulfilled`, and preserves `action_results` and `effect_receipts`, including
failed attempts that were later recovered. An explicit unfulfilled assessment
fails the CLI. These fields are execution evidence; benchmark graders must still
verify the requested outcome independently.
