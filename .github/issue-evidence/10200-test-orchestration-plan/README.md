# Issue #10200 evidence: run-all-tests plan inventory

## Scope

- Issue: https://github.com/elizaOS/eliza/issues/10200
- Slice: residual `run-all-tests.mjs` auditability / orchestration consolidation.
- PR scope is intentionally local to `packages/scripts`: add a non-executing test-plan inventory mode and pin shard determinism under Bun.

## Change

- Added `node packages/scripts/run-all-tests.mjs --plan[=text|json]`.
- Plan mode performs the same workspace/script discovery, filters, sharding, parallel/serial classification, and cloud-step decision as the real runner, then exits before:
  - preparing local PostgreSQL,
  - spawning package test scripts,
  - running `bun run test:cloud`.
- JSON output includes:
  - summary counts,
  - package/script task rows,
  - parallel-safe classification,
  - structured skip reasons,
  - cloud-step metadata.
- Text output gives a compact human-readable plan.
- The JSON plan self-test strips `PATH` to prove plan mode does not prepare PostgreSQL or spawn package test commands.
- Replaced shard bucket conversion with `digest.readUInt32BE(0)` so the existing partition/balance invariants pass under Bun's test runtime.

## Validation

Commands run from `/home/shaw/eliza/eliza-wt-10200-test-orchestration`:

```bash
bun test packages/scripts/__tests__/test-task-pool.test.ts
bunx @biomejs/biome check packages/scripts/run-all-tests.mjs packages/scripts/lib/test-task-pool.mjs packages/scripts/__tests__/test-task-pool.test.ts
node packages/scripts/run-all-tests.mjs --plan=json --only=test --no-cloud --filter=packages/core
node packages/scripts/run-all-tests.mjs --plan --only=test --filter=packages/core
git diff --check
```

Results:

- `test-task-pool.test.ts`: 27 pass, 0 fail, 1892 expectations.
- Biome check: exit 0. It emitted pre-existing `noUndeclaredEnvVars` warnings for `run-all-tests.mjs`; no errors.
- `git diff --check`: passed.
- JSON plan artifact: `core-test-plan.json`.
- Text plan artifact: `core-test-plan.txt`.

## Evidence N/A

- Android capture: N/A. This is a repository script/test-orchestration change; no Android, app, native, UI, or runtime behavior changed.
- Screenshot/screen recording: N/A for the same reason.
- Live model trajectory: N/A. No agent, prompt, model, or action behavior changed.
