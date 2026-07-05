# #13776 task workdir lock evidence

Scope: first rollout step from the D3 Project-entity decision doc. Persist the
first resolved workdir on the durable orchestrator task and reuse it for later
task spawns that do not explicitly request a different workdir.

## Verification

- `bunx vitest run plugins/plugin-agent-orchestrator/__tests__/unit/orchestrator-task-service.test.ts --testNamePattern 'pins follow-up spawns|assigns distinct names'`
  - Result: 1 file passed, 2 tests passed, 60 skipped.
  - Note: Vitest emitted a root `package.json` duplicate-key warning for
    `test:desktop:packaged:windows`, unrelated to this change.
- `bunx vitest run plugins/plugin-agent-orchestrator/__tests__/unit/orchestrator-task-service.test.ts`
  - Result: 1 file passed, 62 tests passed.
  - Note: same unrelated duplicate-key warning as above.
- `bun run --cwd plugins/plugin-agent-orchestrator typecheck`
  - Result: passed.
- `bun run --cwd plugins/plugin-agent-orchestrator lint:check`
  - Result: passed, 292 files checked.
- `bun run --cwd plugins/plugin-agent-orchestrator format:check`
  - Result: passed, 290 files checked before the final rebase; no fixes applied.

## Manual Review

Reviewed the regression test and service diff by hand. The test creates a real
temporary directory under the checkout, spawns a task agent with that workdir,
then spawns again without a workdir and asserts both ACP spawns use the same
directory and the task DTO exposes `metadata.resolvedWorkdir`.

## Evidence Types

- Screenshots/video: N/A - no frontend or rendered UI changed.
- Live LLM trajectory: N/A - no model prompt/action/provider behavior changed.
- Backend logs: N/A - covered by the durable service unit path; no live server
  route behavior changed.
