# #9626 run-turbo Windows fallback evidence

Date: 2026-06-29
Machine: Windows, Node v24.15.0, Bun 1.4.0

## Before

`bun run verify` failed before any package checks could run because the wrapper
hard-coded the missing Bun shim path:

```text
Error: spawn C:\Users\Administrator\.codex\worktrees\b862\eliza\node_modules\.bin\turbo ENOENT
    at ChildProcess._handle.onexit (node:internal/child_process:287:19)
```

This checkout had `node_modules/turbo/bin/turbo`, but no `node_modules/.bin`
directory after repeated `bun install` attempts hung or exited early.

## After

The wrapper now falls back to `node node_modules/turbo/bin/turbo` when no direct
Turbo executable shim exists.

```text
> node packages\scripts\run-turbo.mjs --version
2.10.0
```

```text
> bun run biome check packages\scripts\run-turbo.mjs
Checked 1 file in 514ms. No fixes applied.
```

```text
> node packages\scripts\run-turbo.mjs run build --filter=@elizaos/logger --concurrency=1
• turbo 2.10.0

   • Packages in scope: @elizaos/logger
   • Running build in 1 packages
   • Remote caching disabled, using shared worktree cache

@elizaos/logger:build: $ bun run build:dist
@elizaos/logger:build: $ node ../scripts/rm-path-recursive.mjs dist && tsc --noCheck -p tsconfig.build.json && node ../scripts/prepare-package-dist.mjs packages/logger

 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    44.096s
```

## Remaining Local Blocker

Full `bun run verify` progressed past the Turbo wrapper and into package builds,
then failed because this local `node_modules/.bun` store is incomplete
(`vitest`, Drizzle internals, Mammoth transitives, and other package files are
missing). Multiple repair attempts with `bun install`, `bun run install:light`,
`bun install --ignore-scripts`, and `bun install --backend=copyfile` hung or
exited before restoring the store. That is recorded separately from this
wrapper fix.

Screenshots/video: N/A, CLI-only build-script repair.
