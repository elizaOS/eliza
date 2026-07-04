# Issues #13478 / #13484 orchestrator lifecycle benchmark

## Change

- `report_active_subagent_status` now requires a `status_query` lifecycle event; `spawn` and `share` no longer satisfy status reporting.
- The TypeScript benchmark bridge/provider prompts now tell the agent to use normal task-management/orchestrator actions for lifecycle operations and to use REPLY only for user-facing narration.
- Regression coverage pins both the stricter Python evaluator contract and the updated benchmark prompt language.

## Verification

- `pytest packages/benchmarks/orchestrator_lifecycle/tests/test_evaluator.py -q` passed: 12 tests.
- `bunx vitest run --config packages/lifeops-bench/vitest.config.ts packages/lifeops-bench/src/server-utils.test.ts` passed: 16 tests.
- `python -m packages.benchmarks.orchestrator_lifecycle.cli --mode simulate --max-scenarios 3 --output /tmp/olc-smoke-13478-13484` passed with 100% harness self-check.
- `git diff --check` passed for the touched files.

## Notes

- `bun test packages/lifeops-bench/src/server-utils.test.ts` reached all 16 passing assertions but hung while printing coverage output; it was interrupted and replaced with the Vitest command above for a clean exit code.
- A real bridge/model run is still required for publishable benchmark evidence; this patch verifies evaluator and prompt contracts plus deterministic smoke only.
