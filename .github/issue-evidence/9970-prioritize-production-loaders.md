# Issue #9970: PRIORITIZE Production Loader Evidence

Date: 2026-06-28
Platform: Windows, PowerShell, `C:\Users\Administrator\.codex\worktrees\b862\eliza`
Branch: `fix/9970-prioritize-production-loaders`

## What Changed

- `PRIORITIZE` default loaders now read production data instead of always returning empty arrays:
  - `rank_todos` reads the registered `todos` runtime service for pending/in-progress owner todos.
  - `rank_threads` reads LifeOps work threads scoped by `ownerEntityId`.
  - `rank_decisions` reads pending approval queue requests scoped by `subjectUserId`.
- Loader calls now receive the triggering `Memory` so production reads use the owner entity from the actual request.
- Unit coverage verifies the production default path for todos, work threads, and approvals.

## Validation

```text
bun run biome check --write plugins\plugin-personal-assistant\src\actions\prioritize.ts plugins\plugin-personal-assistant\test\prioritize-action.test.ts
Checked 2 files in 894ms. No fixes applied.
```

```text
bun run --cwd plugins\plugin-personal-assistant test test\prioritize-action.test.ts
Test Files  1 passed (1)
Tests       14 passed (14)
Duration    108.59s
```

```text
bun run --cwd plugins\plugin-personal-assistant build:types
$ tsc --noCheck -p tsconfig.build.json
```

```text
bun run --cwd plugins\plugin-personal-assistant build:js
ESM Build success in 8293ms
```

```text
git diff --check
passed with no output
```

## Blocked/Not Covered In This Chunk

- `bun run --cwd plugins\plugin-personal-assistant typecheck` is blocked by existing unrelated package-wide errors, beginning with missing workspace subpath declarations such as `@elizaos/plugin-blocker/services/app-blocker/index` and existing scheduled-task re-export errors.
- `bun run --cwd plugins\plugin-personal-assistant test` exceeded 5 minutes without producing output; the orphaned test processes from this worktree were stopped. The focused `PRIORITIZE` unit file passed.
- This chunk addresses the `PRIORITIZE` empty-list production wiring from issue #9970. Ambient app-usage provider injection and broader outcome scenario work remain for follow-up chunks.
