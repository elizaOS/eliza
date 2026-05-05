# Validation Report: Creation, Examples, E2E, Benchmarks

Date: 2026-05-05
Workspace: `/Users/shawwalters/eliza-workspace/milady/eliza`

## Summary

| Area | Status | Notes |
| --- | --- | --- |
| New plugin creation | PASS | Clean scaffold, install, build, typecheck, unit tests, and template e2e wrapper passed. |
| New project creation | PARTIAL / BLOCKED | Scaffold render works; upstream scaffold worked once but fresh validation later stalled in upstream init/postinstall. Generated app typecheck exposed template type-stub gaps. |
| Examples | FAIL | Sampled example tests found real failures in `polymarket` and `lp-manager`. |
| Benchmarks with Groq / gpt-oss-120b | BLOCKED / FAIL | No provider keys in environment; benchmark Python suites also fail collection. App-eval dry-run/evaluator work. |
| E2E scenarios | PARTIAL / FAIL | Scenario-runner unit tests pass. Root e2e config finds no tests from this cwd. Full UI clicksafe smoke fails after 16 route passes. |

## Environment Notes

- Bun: `1.3.13`.
- Python: `3.13.2`; pytest: `9.0.2`.
- Provider credentials: no `GROQ_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or equivalent model-provider env vars were present.
- Node runtime issue: `node -v` using the default `~/.nvm/versions/node/v22.20.0/bin/node` and the bundled Node path both hung during this session. Bun-based scripts still ran, but Node-based scripts are not reliable in this environment.
- Repo has concurrent/background activity; unrelated UI smoke and git processes were present. I did not terminate unrelated user processes.

## New Plugin Creation

Command path:

```bash
TMPDIR=$(mktemp -d /tmp/eliza-validation-plugin-pass2.XXXXXX)
cd "$TMPDIR"
bun /Users/shawwalters/eliza-workspace/milady/eliza/packages/elizaos/dist/cli.js create plugin-weather-check --template plugin --yes --github-username codex-validation --description "Weather check plugin validation" --repo-url https://github.com/codex-validation/plugin-weather-check
cd plugin-weather-check
bun install
bun run build
bun run typecheck
bun run test
```

Result:

- Created `/tmp/eliza-validation-plugin-pass2.sBVQZd/plugin-weather-check`.
- `bun install`: passed.
- `bun run build`: passed.
- `bun run typecheck`: passed.
- `bun run test`: passed.
- Test count: component/unit `35 passed`; e2e wrapper `5 passed`.

## New Project Creation

Commands run:

```bash
ELIZAOS_UPSTREAM_REPO=/Users/shawwalters/eliza-workspace/milady/eliza \
  bun /Users/shawwalters/eliza-workspace/milady/eliza/packages/elizaos/dist/cli.js create validation-project --template project --yes
cd validation-project
bun install
bun run typecheck
```

First result:

- Created `/tmp/eliza-validation-project-final.veyCG6/validation-project`.
- `bun install`: passed with peer dependency warnings.
- `bun run typecheck`: failed.
- Initial dominant error: generated app typecheck reached upstream packages whose package exports pointed at missing `dist` declarations, especially `@elizaos/core`.
- After building `eliza/packages/core`, typecheck progressed but then failed because generated app `tsconfig` stubs for `@elizaos/app-core` did not cover side-effect app UI imports and shared/core declarations.

Current template state verified:

- `packages/elizaos/build.ts` now tolerates a checkout without `packages/templates` by using packaged templates in `packages/elizaos/templates`.
- `packages/elizaos/templates/project/apps/app/tsconfig.json` contains type-stub paths for app side-effect imports, `@elizaos/core`, `@elizaos/shared`, and app-core CSS imports.
- Added/verified project template stubs under `packages/elizaos/templates/project/apps/app/src/type-stubs/`.
- `bun run --cwd packages/elizaos build`: passed.
- `bun run --cwd packages/elizaos test`: `3 files, 16 tests passed`.
- `bun run --cwd packages/elizaos typecheck`: passed.
- Render-only scaffold: `create validation-project --template project --yes --skip-upstream` passed.

Remaining blocker:

- A later fresh upstream project run stalled during upstream initialization before the project directory was created.
- Another generated-project install stalled in dependency postinstall scripts (`tsup`, platform deps, node-pty), with zero CPU for over two minutes.
- Generated-workspace typecheck attempts were also blocked by runtime hangs in that temp workspace.

## Examples

Inventory found 43 example package manifests under `packages/examples` plus 2 under `cloud/examples`.

Sample command:

```bash
bun test packages/examples/lp-manager packages/examples/polymarket packages/examples/a2a/test-runner.ts packages/examples/mcp/test-client.ts
```

Result:

- `packages/examples/polymarket/streaming.test.ts`: 7 passed.
- `packages/examples/polymarket/lib.test.ts`: 7 passed.
- `packages/examples/polymarket/runner.test.ts`: failed (Polymarket example integration not resolvable in this workspace).
- `packages/examples/polymarket/live.test.ts`: unhandled import error for the Polymarket example dependency.
- `packages/examples/lp-manager`: many tests passed, but `Character Consistency > name appears in message examples` failed with `TypeError: convo.some is not a function`.
- The combined run was stopped after it stopped making forward progress.

Conclusion: examples are not all green.

## Benchmarks

The root `benchmarks/` directory is absent. Benchmark code lives under `packages/benchmarks`.

App-eval dry-runs:

```bash
bun run packages/benchmarks/app-eval/run-benchmarks.ts --dry-run --type research
bun run packages/benchmarks/app-eval/run-benchmarks.ts --dry-run --type coding
```

Result:

- Research task inventory: 10 tasks loaded.
- Coding task inventory: 10 tasks loaded.

App-eval deterministic evaluator:

```bash
python3 packages/benchmarks/app-eval/evaluate.py /tmp/app-eval-synthetic.JLnbqO --format json
```

Result:

- Loaded 2 synthetic result files and 20 task definitions.
- Completed 2 / failed 0.
- Synthetic scores: research `1.0`, coding `7.0`, overall `4.0`.

Python benchmark suite checks:

```bash
python3 -m pytest packages/benchmarks/realm/tests packages/benchmarks/bfcl/tests packages/benchmarks/adhdbench/tests packages/benchmarks/context-bench/tests -q
```

Result:

- `bfcl`: collection failed, `ModuleNotFoundError: No module named 'benchmarks.bfcl.plugin'`.
- `realm`: collection failed, `SyntaxError` in `packages/benchmarks/realm/cli.py` line 289 and missing `benchmarks.realm.plugin.actions`.
- `adhdbench`: collection failed, missing `elizaos_adhdbench.distractor_plugin`.

Groq / gpt-oss-120b:

- Not run live. Required provider credentials were not present.
- I did not find an app-eval CLI flag that selects Groq or `gpt-oss-120b`; live model selection appears to depend on the agent/runtime provider configuration.

## E2E And UI

Scenario runner:

```bash
bun run --cwd packages/scenario-runner test
```

Result: `8 files, 48 tests passed`.

Root e2e config:

```bash
bunx --bun vitest run --config test/vitest/e2e.config.ts --passWithNoTests
```

Result: no tests found. The include patterns are rooted at `eliza/...`, which do not match from `/Users/shawwalters/eliza-workspace/milady/eliza`.

Focused UI smoke:

```bash
bun --cwd packages/app scripts/run-ui-playwright.mjs --config playwright.ui-smoke.config.ts test/ui-smoke/all-pages-clicksafe.spec.ts --grep 'desktop apps catalog'
```

Result: `1 passed`.

Full UI clicksafe smoke:

```bash
bun --cwd packages/app scripts/run-ui-playwright.mjs --config playwright.ui-smoke.config.ts test/ui-smoke/all-pages-clicksafe.spec.ts
```

Observed result:

- Started `35` tests.
- Tests 1-16 passed: desktop chat, connectors, apps catalog, automations, browser, character, character knowledge, wallet, settings, lifeops, tasks, plugins, skills, fine tuning, trajectories, relationships.
- Test 17, desktop memories, failed after about 1 minute.
- Tests 18-34 then failed very quickly, suggesting the smoke server/page state was bad after the memories failure.
- The session ended with code `-1` before a complete Playwright failure summary was emitted.

Conclusion: all UI buttons/interactions are not green.

## Open Items

1. Fix or isolate generated project upstream init and postinstall hangs, then rerun a clean `create -> install -> typecheck -> test`.
2. Fix generated app typecheck pathing fully enough to pass in a fresh generated workspace without prebuilding upstream packages.
3. Repair example failures:
   - restore or stub Polymarket example wiring for `packages/examples/polymarket` tests;
   - fix `lp-manager` `messageExamples` shape or test expectation.
4. Repair benchmark package collection failures in `realm`, `bfcl`, and `adhdbench`.
5. Add a documented Groq/gpt-oss-120b benchmark invocation path with required env vars and expected score thresholds.
6. Fix root `test/vitest/e2e.config.ts` include patterns or invocation cwd so it actually discovers e2e tests.
7. Debug full `all-pages-clicksafe.spec.ts` at desktop memories, then rerun the full UI smoke suite.
