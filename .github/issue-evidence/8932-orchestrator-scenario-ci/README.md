# #8932 Orchestrator Scenario CI Follow-Up Evidence

Purpose: prove the strict orchestrator scenario lane boots and runs after
removing UI-bearing package-barrel imports from personal-assistant server paths
and passing `runtime` into custom scenario final checks.

## Scenario Run

Command:

```bash
EVAL_MODEL_PROVIDER=deterministic \
CEREBRAS_API_KEY= \
EVAL_CEREBRAS_API_KEY= \
ELIZA_E2E_CEREBRAS_API_KEY= \
SCENARIO_USE_LLM_PROXY=1 \
SCENARIO_LLM_PROXY_STRICT=1 \
bun --conditions=eliza-source packages/scenario-runner/src/cli.ts run \
  plugins/plugin-agent-orchestrator/test/scenarios \
  --lane pr-deterministic \
  --report-dir .github/issue-evidence/8932-orchestrator-scenario-ci/pr-deterministic-report \
  --run-dir .github/issue-evidence/8932-orchestrator-scenario-ci/pr-deterministic-run \
  --export-native .github/issue-evidence/8932-orchestrator-scenario-ci/pr-deterministic-native.jsonl
```

Result: 5 passed, 0 failed, 0 skipped. Run id:
`46a8578d-2a81-44f2-b225-eb1795fa2de3`.

This run was captured after rebasing onto `origin/develop` at
`fdde392e68`.

Native export note: the exporter ran and wrote
`pr-deterministic-native.jsonl` plus a manifest. The deterministic harness
scenarios do not create trajectory DB files, so the native row count is 0.

## Artifacts

- JSON report bundle: `pr-deterministic-report/`
- Run viewer: `pr-deterministic-run/viewer/index.html`
- Full-page screenshot: `pr-deterministic-run-viewer.png`
- Video walkthrough: `video/pr-deterministic-run-viewer.webm`
- Native export manifest: `pr-deterministic-native.manifest.json`

## Verification Commands

- `bun run --cwd plugins/plugin-agent-orchestrator typecheck` - passed.
- `bun run --cwd plugins/plugin-agent-orchestrator build` - passed.
- `bun run --cwd plugins/plugin-agent-orchestrator test:unit` - 76 files,
  849 tests passed.
- `bunx vitest run --config vitest.config.ts src/executor.test.ts`
  from `packages/scenario-runner` - 1 file, 9 tests passed.
- `bun run --cwd packages/scenario-runner typecheck` - passed.
- `bun run --cwd packages/scenario-runner build` - passed.
- `bun run --cwd plugins/plugin-personal-assistant build` - passed.
- `bunx vitest run --config vitest.config.ts src/website-blocker/chat-integration/__tests__/actions.test.ts`
  from `plugins/plugin-personal-assistant` - 1 file, 3 tests passed.
- `bun --conditions=eliza-source -e 'await import("./plugins/plugin-personal-assistant/src/plugin.ts"); await import("./packages/test/mocks/helpers/mock-runtime.ts"); console.log("backend imports ok")'`
  - passed.
- `rg 'from "@elizaos/plugin-(blocker|inbox|goals|finances)"' plugins/plugin-personal-assistant/src -n`
  - no matches.
- `git diff --check` - passed.
- `bun run verify` after rebase - 507/507 tasks successful.
