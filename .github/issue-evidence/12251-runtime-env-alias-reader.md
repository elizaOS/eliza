# #12251 runtime env alias reader slice

## What This Proves

The runtime environment resolvers now read brand-prefixed BootConfig aliases
without writing mirrored `ELIZA_*` keys into the env record. This slice covers
the server-facing settings named in the issue: API ports, API bind host, API
token, CORS origins, allowed hosts, null-origin policy, and disable-auto-token.

The regression tests use a non-`ELIZA` brand prefix (`ACME_*`) and assert that
the canonical runtime helpers resolve the branded values while the env object
does not gain mirrored `ELIZA_*` properties.

## Verification

```bash
bun run install:light
bun run --cwd packages/shared build:i18n
bun run --cwd packages/cloud/routing build
bun run --cwd packages/shared test -- runtime-env.test.ts utils/env.test.ts
```

Result: `2 passed (2)` test files, `27 passed (27)` tests.

```bash
bunx @biomejs/biome check \
  packages/shared/src/runtime-env.ts \
  packages/shared/src/runtime-env.test.ts \
  packages/core/src/runtime-env.ts
```

Result: `Checked 3 files ... No fixes applied.`

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

## Remaining Work For #12251

This is not the full issue closeout. The mutating alias sync functions and
their call sites still remain. A later slice still needs to migrate the rest of
the raw aliased `process.env` reads and then remove the sync wrappers and script
copies entirely.
