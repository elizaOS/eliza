# Issue #10200: run-all-tests plan mode

## Change

- Added `node packages/scripts/run-all-tests.mjs --list` / `--dry-run`.
- The mode prints the discovered runnable task plan after lane/filter/shard/skip handling.
- It exits before PostgreSQL preparation and before any test child process is spawned.

## Validation

```bash
~/.bun/bin/bun test packages/scripts/__tests__/run-all-tests-plan.test.ts packages/scripts/__tests__/test-task-pool.test.ts
```

Result: passed, 28 tests.

```bash
~/.bun/bin/bun test packages/scripts/__tests__/run-all-tests-plan.test.ts
```

Result: passed, 3 tests.

```bash
node packages/scripts/run-all-tests.mjs --list --filter=packages/core --only=test --no-cloud --concurrency=3
```

Reviewed output:

```text
[eliza-test] plan
  lane: pr
  scripts: test
  cloud: disabled
  shard: none
  concurrency: 3
  package filters: packages/core
  script filter: none
  start at: none
  excludes: 0
  runnable tasks: 1
  parallel task(s): 1
  serial task(s): 0
  skipped during discovery: 1
  parallel @elizaos/core (packages/core)#test
  skip @elizaos/cloud-e2e (packages/test/cloud-e2e) (cloud package skipped by --no-cloud)
```

```bash
~/.bun/bin/bunx @biomejs/biome@2.5.1 check --write packages/scripts/run-all-tests.mjs packages/scripts/__tests__/run-all-tests-plan.test.ts
```

Result: passed with no fixes applied. Biome reported existing `noUndeclaredEnvVars` warnings in `run-all-tests.mjs` for pre-existing environment variables used by the runner.

```bash
bun run --cwd packages/benchmarks/solana/solana-gym-env/docs/trajectory-viewer lint
```

Result: passed. This was added after the first full verify attempt exposed two ambiguous-link lint failures in the generated trajectory viewer docs page.

```bash
bun run typecheck:dist
```

Result: passed after regenerating `tsconfig.dist-paths.json`.

```bash
bun run verify
```

Result: passed.

- Turbo typecheck/lint: 474 successful, 474 total.
- `audit-build-typecheck`: passed.
- `audit-turbo-build-deps`: passed.
- `audit-tee-secret-leak`: passed.
- `audit-scripts`: passed.
- `typecheck:dist`: checked 28 dist-path consumer configs.

## Artifact matrix

- Screenshots/video: N/A. This is a CLI runner change with no app UI surface.
- Live model trajectory: N/A. This does not change agent/model/prompt behavior.
- Domain artifacts: the reviewed CLI plan output above.
