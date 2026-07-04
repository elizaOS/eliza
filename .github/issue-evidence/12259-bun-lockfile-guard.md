# Issue #12259 - Bun lockfile version guard

PR scope:

- `packages/scripts/run-turbo.mjs` now parses `bun.lock` before spawning
  Turbo and fails loudly when `lockfileVersion` exceeds the version supported by
  the pinned Turbo parser.
- The old Bun lockfile warning filter was removed; Turbo output now passes
  through directly instead of hiding lockfile parser warnings.
- `packages/scripts/run-turbo.self-test.mjs` proves a synthetic
  `lockfileVersion: 1` passes and `lockfileVersion: 2` fails with the Turbo/Bun
  compatibility pointer.

Local verification on 2026-07-04:

```bash
node --check packages/scripts/run-turbo.mjs
node --check packages/scripts/run-turbo.self-test.mjs
node packages/scripts/run-turbo.self-test.mjs
# run-turbo self-test passed

RUN_TURBO_LOCKFILE_CHECK_ONLY=1 \
  node packages/scripts/run-turbo.mjs run build --dry=json

git diff --check
```

Attempted full Turbo dry run:

```bash
node packages/scripts/run-turbo.mjs run build --dry=json \
  --filter=__run_turbo_lockfile_no_match__
```

Result: not run in this auxiliary worktree because no ancestor
`node_modules/turbo` exists. The wrapper failed before Turbo spawn with the
expected "Unable to find turbo" message. The lockfile guard path itself was
verified with `RUN_TURBO_LOCKFILE_CHECK_ONLY=1`.

Screenshots/recordings: N/A, CLI guard only; no UI changed.
