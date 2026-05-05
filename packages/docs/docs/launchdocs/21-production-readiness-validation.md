# Production Readiness Automation Validation

Date: 2026-05-05

## Automated Work Completed

- Revalidated the launchdocs gate against the moved docs-site tree at `packages/docs/docs/launchdocs`.
- Updated the docs gate so `--scope=launchdocs` includes the docs-site `docs/launchdocs` directory and fails if the scope resolves to zero markdown files.
- Revalidated the real built app through the deterministic stub-stack Playwright UI smoke runner.
- Revalidated the macOS titlebar navigation/drag-area smoke after the traffic-light inset change.
- Revalidated benchmark adapter discovery and score extraction for the new benchmark adapter coverage.
- Revalidated the benchmark smoke paths for ADHDBench, BFCL, and HyperliquidBench.

## Validation Commands

```sh
bunx @biomejs/biome check --write scripts/launch-qa/check-docs.mjs scripts/launch-qa/check-docs.test.ts
bunx vitest run scripts/launch-qa/check-docs.test.ts
node scripts/launch-qa/check-docs.mjs --scope=launchdocs --json
node scripts/launch-qa/run.mjs --only docs --json
node scripts/launch-qa/run.mjs --only docs,ui-smoke --continue-on-failure --json
node scripts/launch-qa/run-ui-smoke-stub.mjs test/ui-smoke/titlebar-navigation.spec.ts
PYTHONPATH=packages python -m pytest packages/benchmarks/orchestrator/tests/test_adapter_discovery.py -q
python -m py_compile packages/benchmarks/HyperliquidBench/eliza_agent.py packages/benchmarks/HyperliquidBench/types.py packages/benchmarks/adhdbench/elizaos_adhdbench/distractor_plugin.py packages/benchmarks/adhdbench/elizaos_adhdbench/runner.py packages/benchmarks/adhdbench/scripts/run_benchmark.py packages/benchmarks/bfcl/agent.py packages/benchmarks/bfcl/plugin.py
PYTHONPATH=packages/benchmarks/adhdbench python -m pytest packages/benchmarks/adhdbench/tests -q
PYTHONPATH=packages python -m pytest packages/benchmarks/bfcl/tests -q
cargo check --manifest-path packages/benchmarks/HyperliquidBench/Cargo.toml --quiet
PYTHONPATH=packages/benchmarks python -m HyperliquidBench --coverage --max-steps 1 --output /tmp/eliza-hyperliquid-smoke
PYTHONPATH=packages python -m benchmarks.bfcl run --mock --sample 1 --no-report --no-exec --output /tmp/eliza-bfcl-smoke
PYTHONPATH=packages/benchmarks/adhdbench python packages/benchmarks/adhdbench/scripts/run_benchmark.py run --quick --ids L0-001 --output /tmp/eliza-adhdbench-smoke
```

## Results

- Docs gate: passed, 22 launchdocs markdown files checked, 0 errors.
- Docs gate tests: passed, 6 tests.
- Built-app UI smoke: passed, 35 route entries plus the visible safe app tiles/button click-safety test. Artifact directory: `/var/folders/1g/77s889gx10n7mtl6z1nfrxzm0000gn/T/launch-qa-vxSi7X`.
- Launch runner docs task after docs-site move: passed. Artifact directory: `/var/folders/1g/77s889gx10n7mtl6z1nfrxzm0000gn/T/launch-qa-ej5kda`.
- Titlebar navigation smoke: passed, 1 Playwright test.
- Benchmark adapter discovery: passed, 4 pytest tests.
- Python benchmark compile smoke: passed.
- ADHDBench test suite: passed, 142 tests.
- ADHDBench quick filtered smoke: passed, 2 scenario results.
- BFCL test suite: passed, 45 tests.
- BFCL mock sample smoke: passed, 1 test.
- HyperliquidBench Cargo check: passed.
- HyperliquidBench Python coverage smoke: passed, 1 scenario.

## Remaining Human Work

- Physical iOS and Android release QA on real devices, including install, permissions, backgrounding, local model performance, and thermal/performance behavior.
- Live cloud production QA with real login, billing/credits, agent creation, and migration to desktop or phone.
- Live wallet QA only with dedicated test wallets and controlled testnet or tiny-mainnet funds.
- OAuth and messaging connector QA with real provider accounts because provider UX, anti-abuse gates, and permission screens change outside the codebase.
- macOS packaged app permission prompts for Computer Use, accessibility, and screen recording.
- Product judgment on final onboarding clarity, colors, button feel, and model output quality.
