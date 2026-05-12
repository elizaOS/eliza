# Phase 2 Validation - Typecheck

Worker: validation worker B
Date: 2026-05-11
Workspace: `/Users/shawwalters/eliza-workspace/milady/eliza`
Bun: `/Users/shawwalters/.bun/bin/bun`
Node options: `NODE_OPTIONS=--max-old-space-size=8192`

## Summary

Overall result: **fail for targeted validation**.

The root repository typecheck passed. Direct targeted checks passed for
`packages/ui` and `packages/app`. `cloud/apps/frontend` failed its direct
typecheck with Drizzle type identity errors caused by two physical
`drizzle-orm@0.45.2` installs being resolved at once. `plugins/app-lifeops`
has no `typecheck` script, so no direct package typecheck was run there.

## Commands Run

| Area | Command | Exit | Result |
| --- | --- | ---: | --- |
| Root | `NODE_OPTIONS=--max-old-space-size=8192 /Users/shawwalters/.bun/bin/bun run typecheck` | 0 | Pass |
| `packages/ui` | `NODE_OPTIONS=--max-old-space-size=8192 /Users/shawwalters/.bun/bin/bun run --cwd packages/ui typecheck` | 0 | Pass |
| `packages/app` | `NODE_OPTIONS=--max-old-space-size=8192 /Users/shawwalters/.bun/bin/bun run --cwd packages/app typecheck` | 0 | Pass |
| `plugins/app-lifeops` | Not run: no `typecheck` script exists in `plugins/app-lifeops/package.json`. | n/a | Skipped |
| `cloud/apps/frontend` | `NODE_OPTIONS=--max-old-space-size=8192 /Users/shawwalters/.bun/bin/bun run --cwd cloud/apps/frontend typecheck` | 2 | Fail |

Additional non-reporting diagnostics were run to group the cloud frontend
failure output by file. They did not write files.

## Root Result

Root `bun run typecheck` completed successfully.

Key observed output:

- Turbo ran typecheck across the workspace and reported `163 successful, 163 total`.
- Turbo summary: `Cached: 20 cached, 163 total`.
- Turbo time: `12m35.081s`.
- The root script then ran `node scripts/run-examples-benchmarks.mjs typecheck` and exited 0.
- Several packages intentionally skip typecheck with echo scripts, for example no TypeScript config or release-skip packages. These skips did not fail the root command.

The root workspace does not cover the direct `cloud/apps/frontend` typecheck
failure below, so the root pass is not enough to validate the cloud frontend.

## Targeted Results

`packages/ui` passed with:

```text
$ tsc --noEmit -p tsconfig.json
```

`packages/app` passed with:

```text
$ tsc --noEmit -p tsconfig.typecheck.json
```

`plugins/app-lifeops` was skipped because it has no `typecheck` script.
It does have `build:types`, but that script is `tsc --noCheck -p
tsconfig.build.json` and is a dist-emitting type generation step, not a
typecheck validation.

`cloud/apps/frontend` failed with:

```text
$ tsc --noEmit
```

Diagnostic grouping of top-level `error TS` lines from a filtered rerun:

```text
  82 packages/db/repositories/agents/memories.ts
  43 packages/db/repositories/agents/rooms.ts
  40 packages/db/repositories/agents/participants.ts
  31 packages/db/repositories/agents/agents.ts
  21 packages/db/repositories/agents/entities.ts
   7 packages/db/repositories/dashboard.ts
   6 packages/lib/services/agents/rooms.ts
```

Total grouped top-level TypeScript error lines: 230 across 7 files.

## Key Failure Pattern

The cloud frontend failure is dominated by Drizzle type identity conflicts.
Representative errors include:

```text
../../packages/db/repositories/agents/agents.ts(60,9): error TS2322:
Type 'PgColumn<...>' is not assignable to type
'SQL<unknown> | Aliased<unknown> | Subquery<...> | PgColumn<...> | PgTable<...>'.

../../packages/db/repositories/agents/agents.ts(70,13): error TS2345:
Argument of type 'PgTableWithColumns<...>' is not assignable to parameter
of type 'SQL<unknown> | PgTable<TableConfig> | PgViewBase<...> | Subquery<...>'.

../../packages/db/repositories/agents/agents.ts(71,17): error TS2769:
No overload matches this call.
```

The detailed error text shows the same package version resolving from two
different physical install roots:

```text
/Users/shawwalters/eliza-workspace/milady/eliza/node_modules/.bun/drizzle-orm@0.45.2+fc0f68b157690761/...
/Users/shawwalters/eliza-workspace/milady/eliza/cloud/node_modules/.bun/drizzle-orm@0.45.2+cee48a6471b6eae6/...
```

Because Drizzle classes include protected/private members such as `config`
and `shouldInlineParams`, structurally identical versions from different
install paths are not assignable to each other.

Cascading errors then appear as typed query results degrade to
`{ [x: string]: unknown; }`, producing failures such as:

- `AgentInfo | null` mismatch in `packages/db/repositories/agents/agents.ts`.
- `AgentInfo[]` mismatch in `packages/db/repositories/agents/agents.ts`.
- `Room[]` / `Room` conversion warnings in `packages/lib/services/agents/rooms.ts`.
- `{}` to `string` / `Date` mismatches in `packages/db/repositories/dashboard.ts`.

## Likely Owners

Primary likely owners:

- Cloud package/dependency owners for `cloud/apps/frontend`, `cloud/packages/db`, and `cloud/packages/lib`.
- Workspace package-management owners for root-vs-cloud dependency resolution.

The failing files are cloud-side repository/service files, but the root cause
appears to be dependency graph shape rather than the individual query code.
The direct frontend typecheck imports cloud packages that resolve Drizzle from
both the root `node_modules` and `cloud/node_modules`.

## Side Effects

- No destructive commands were run.
- No source, config, or test files were edited by this worker.
- The only file created by this worker is this report:
  `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/validation-typecheck.md`.
- The worktree was already dirty before validation began, with many modified
  and untracked files from other concurrent work.
- The post-run worktree status differed substantially from the pre-run
  snapshot while other workers were active. I did not revert or attribute
  those changes.
- Root typecheck logged one possible generated-content step:
  `eliza-app:typecheck: node ../app-core/scripts/write-homepage-release-data.mjs`
  with `homepage release data: stable=v1.7.2`.
- Turbo also replayed cached build logs for dependency tasks such as
  `@elizaos/core`, `@elizaos/shared`, `@elizaos/plugin-health`, and
  `@elizaos/app-lifeops`. No tracked build-output change was isolated by this
  worker.

## Next Actions

1. Align Drizzle resolution for the cloud frontend typecheck so
   `cloud/apps/frontend` and imported cloud packages use one physical
   `drizzle-orm` instance.
2. Check `cloud/package.json`, the cloud lockfile, workspace linking, and
   TypeScript path resolution for why imports from `../../packages/db` and
   `../../packages/lib` cross root and cloud dependency trees.
3. Rerun:
   `NODE_OPTIONS=--max-old-space-size=8192 /Users/shawwalters/.bun/bin/bun run --cwd cloud/apps/frontend typecheck`.
4. Consider adding cloud frontend typecheck coverage to the root validation
   path or CI gate, since root `bun run typecheck` passed while the direct
   cloud frontend check failed.
5. If `plugins/app-lifeops` should be part of targeted typecheck validation,
   add a non-emitting `typecheck` script. The current `build:types` script is
   not equivalent because it uses `--noCheck` and emits `dist`.
