# #12251 runtime env alias reader slice

## What This Proves

The runtime environment resolvers now read brand-prefixed BootConfig aliases
without writing mirrored `ELIZA_*` keys into the env record. This slice covers
the server-facing settings named in the issue: API ports, API bind host, API
token, CORS origins, allowed hosts, null-origin policy, disable-auto-token, and
mobile platform detection.

The regression tests use a non-`ELIZA` brand prefix (`ACME_*`) and assert that
the canonical runtime helpers resolve the branded values while the env object
does not gain mirrored `ELIZA_*` properties.

## Verification

```bash
bun run install:light
bun run --cwd packages/shared build:i18n
bun run --cwd packages/cloud/routing build
bun run --cwd packages/shared test -- runtime-env.test.ts utils/env.test.ts
bun run --cwd packages/app test -- src/brand-env.test.ts
```

Result: `2 passed (2)` test files, `29 passed (29)` tests.
App alias-table result: `1 passed (1)` test file, `1 passed (1)` test.

```bash
bunx @biomejs/biome check \
  packages/shared/src/runtime-env.ts \
  packages/shared/src/runtime-env.test.ts \
  packages/core/src/boot-env.ts \
  packages/core/src/runtime-env.ts \
  packages/app/src/brand-env.ts \
  packages/app/src/brand-env.test.ts \
  packages/elizaos/templates/project/apps/app/src/brand-env.ts
```

Result: passed.

```bash
bun run --cwd packages/core typecheck
```

Result: passed.

```bash
bun run --cwd packages/contracts build
bun run --cwd packages/shared typecheck
```

Result: passed. `packages/shared typecheck` needs the workspace contracts
package built first in this fresh worktree.

## Evidence Matrix

- UI screenshots/video: N/A - no rendered UI surface changed.
- Live LLM trajectories: N/A - no model/action/provider behavior changed.
- Backend logs: N/A - this is a pure environment-resolution helper slice.
- Domain artifacts: N/A - no database, memory, wallet, scheduled-task, or
  generated user artifact is produced.

## Scope Note

The parent #12251 tracker is closed by the broader batch, and this PR preserves
one tested migration slice: runtime-facing reads resolve through BootConfig
aliases without requiring mirrored `ELIZA_*` writes. The mutating sync helpers
remain available for older raw env reads that are outside this slice.
