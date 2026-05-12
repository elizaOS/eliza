# Cloud Drizzle Boundary Fix

Date: 2026-05-12

## Summary

The cloud frontend TypeScript program was resolving `drizzle-orm` through the root workspace instead of the cloud workspace.

The direct cause was in `cloud/apps/frontend/tsconfig.json`:

- `@/db/*` resolved frontend imports such as `@/db/schemas` into `cloud/packages/db/*`.
- `@elizaos/core` resolved into root source at `packages/core/src/index.node.ts`.
- `@elizaos/plugin-sql` resolved into root source at `plugins/plugin-sql/src/index.ts`.
- `drizzle-orm` and `drizzle-orm/*` resolved through `../../../plugins/plugin-sql/node_modules/drizzle-orm`, which symlinked back into the root install under `/Users/shawwalters/eliza-workspace/milady/eliza/node_modules/.bun/...`.

That meant cloud DB source and root package/plugin source could share one TypeScript program while using the root Drizzle type identity. In cloud checks that also resolve package dependencies through `cloud/node_modules`, this creates a duplicate Drizzle identity boundary between:

- `/Users/shawwalters/eliza-workspace/milady/eliza/node_modules`
- `/Users/shawwalters/eliza-workspace/milady/eliza/cloud/node_modules`

## Fix

`cloud/apps/frontend/tsconfig.json` now maps `drizzle-orm` and `drizzle-orm/*` to `../../node_modules/drizzle-orm`, the same cloud workspace dependency root used by `cloud/tsconfig.json`.

This keeps the frontend's cloud package source imports on the cloud Drizzle type identity instead of routing them through `plugins/plugin-sql/node_modules`.

## Verification

Initial repro command:

```sh
bun run --cwd cloud/apps/frontend typecheck
```

The shell did not have a global `bun` on `PATH`, so the repo-local Bun binary was used:

```sh
./node_modules/.bin/bun run --cwd cloud/apps/frontend typecheck
```

Before the fix, the command completed successfully in this workspace, but `tsc --traceResolution` showed the boundary issue: `drizzle-orm` resolved to the root install while `@/db/schemas` resolved to `cloud/packages/db/schemas/index.ts`.

After the fix, the frontend program resolves `drizzle-orm` through `cloud/node_modules/drizzle-orm`.

Post-fix commands:

```sh
./node_modules/.bin/bun run --cwd cloud/apps/frontend typecheck
```

Result: passed.

```sh
./node_modules/.bin/bun run --cwd cloud typecheck
```

Result: not completed. The split checker was still in its first phase after about 100 seconds, with `packages/db` and `packages/lib/actions` passed and the run moving into additional package-lib slices. The run was terminated to avoid monopolizing the shared workspace.
