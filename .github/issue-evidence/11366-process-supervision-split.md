# Issue #11366 - process supervision split

## Outcome

Chose the documented-split path instead of extracting a shared helper.

The inspected seams do not have identical lifecycle behavior:

- `api-supervisor.mjs`: long-lived single API child, hot-reload restarts,
  rolling crash-window give-up, `SIGTERM` to `SIGKILL` restart escalation.
- `dev-ui.mjs` / `dev-platform.mjs`: dev-session orchestration around the API
  supervisor with Vite/Electrobun-specific stream filtering, port allocation,
  and whole-session teardown.
- `dev-all.mjs`: long-lived detached service stack, process-group shutdown,
  fixed `SIGKILL` fallback, and stop-the-stack-on-any-service-exit behavior.
- `run-all-tests.mjs` / `test-task-pool.mjs`: bounded batch execution, no
  respawn, deterministic shard membership through `digest.readUInt32BE(0)`,
  quiet buffered output for pooled tasks, and all-failures reporting.

The in-tree rationale is recorded in
`packages/scripts/process-supervision.md`, linked from
`packages/app-core/scripts/README.md`, and guarded by
`packages/scripts/__tests__/test-task-pool.test.ts`.

## Verification

```bash
bun test packages/scripts/__tests__/test-task-pool.test.ts
```

Result: 28 tests passed, 0 failed, 1899 assertions. This includes shard
bucketing, `--plan` mode, and the process-supervision-boundary documentation
guard.

```bash
node packages/scripts/run-all-tests.mjs --plan=json --only=test --no-cloud --filter=^@elizaos/core
```

Result: passed. Plan mode printed a one-task JSON inventory for
`@elizaos/core (packages/core)#test`, with `cloudStep: false`.

```bash
bunx @biomejs/biome check packages/scripts/process-supervision.md \
  packages/scripts/__tests__/test-task-pool.test.ts \
  packages/app-core/scripts/README.md
```

Result: passed. Biome checked the TypeScript test file and reported no fixes
needed; Markdown files are outside this Biome target.

```bash
bun run audit:scripts
```

Result: passed. The audit reported no orphan, no-op, or broken scripts.

```bash
bun run audit:scripts:inventory
```

Result: passed. Summary showed 90 total `packages/scripts/*.mjs` files and 0
orphan files.

```bash
bun run verify
```

Result: failed before reaching this change path in the existing type-safety
ratchet:

```text
as unknown as: 80 current > 77 baseline
`?? {}` (core/agent/app-core): 379 current > 377 baseline
```

UI evidence: N/A - documentation/test-only build-script change with no rendered
UI surface.
