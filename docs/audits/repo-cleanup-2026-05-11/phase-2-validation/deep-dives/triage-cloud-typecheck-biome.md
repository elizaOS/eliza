# Phase 2 Deep Dive: cloud typecheck and Biome blockers

Status: blocked for `cloud` validation. No source, config, or test files were changed during this investigation.

## Scope

Investigated:

- `cloud/apps/frontend verify` stopping in Biome.
- `cloud verify` stopping in Biome.
- Direct `cloud/apps/frontend typecheck` failing with duplicate Drizzle physical install type identities.
- Why repo-root typecheck can pass while the cloud frontend direct typecheck fails.

Local shell note: `bun` was not on `PATH` in this Codex session, so reproduction used `/Users/shawwalters/.bun/bin/bun`.

## Reproduction Summary

`/Users/shawwalters/.bun/bin/bun run --cwd cloud/apps/frontend verify`

- Fails at `bun run lint`.
- Command does not reach frontend typecheck or build.
- Biome checked 311 files and reported 1 formatting error.

`/Users/shawwalters/.bun/bin/bun run --cwd cloud verify`

- Fails at `bun run lint:check`.
- Command does not reach `deps:circular` or `typecheck`.
- Biome checked 2270 files and reported 15 errors across 14 files, plus 1 schema/CLI version info message.

`/Users/shawwalters/.bun/bin/bun run --cwd cloud/apps/frontend typecheck`

- Fails with TypeScript exit code 2.
- The error cascade is limited to Drizzle-backed backend source pulled into the frontend typecheck graph:

```text
31 ../../packages/db/repositories/agents/agents.ts
21 ../../packages/db/repositories/agents/entities.ts
82 ../../packages/db/repositories/agents/memories.ts
40 ../../packages/db/repositories/agents/participants.ts
43 ../../packages/db/repositories/agents/rooms.ts
 7 ../../packages/db/repositories/dashboard.ts
 6 ../../packages/lib/services/agents/rooms.ts
```

## Exact Biome Files

Frontend `verify` reports only:

- `cloud/apps/frontend/src/pages/payment/[paymentRequestId]/page.tsx`

Cloud `verify` reports:

- `cloud/apps/api/auth/logout/route.ts`
- `cloud/apps/api/auth/steward-session/route.ts`
- `cloud/apps/api/v1/apis/tunnels/tailscale/auth-key/route.ts`
- `cloud/apps/frontend/src/pages/payment/[paymentRequestId]/page.tsx`
- `cloud/packages/db/schemas/voice-imprints.ts`
- `cloud/packages/lib/auth/cookie-domain.ts`
- `cloud/packages/lib/services/content-safety.ts`
- `cloud/packages/lib/services/oauth-callback-bus.ts`
- `cloud/packages/lib/services/sensitive-callback-bus.ts`
- `cloud/packages/scripts/run-integration-tests.mjs`
- `cloud/packages/tests/unit/cookie-domain.test.ts`
- `cloud/packages/tests/unit/oauth-callback-bus.test.ts`
- `cloud/packages/tests/unit/payment-callback-bus.test.ts`
- `cloud/packages/tests/unit/sensitive-callback-bus.test.ts`

`cloud/packages/scripts/run-integration-tests.mjs` has both `assist/source/organizeImports` and formatter diagnostics, which explains 15 Biome errors across 14 files.

There is also a local install mismatch:

- `cloud/package.json` pins `@biomejs/biome` to `2.4.14`.
- `cloud/bun.lock` resolves `@biomejs/biome` to `2.4.14`.
- `cloud/biome.json` uses schema `https://biomejs.dev/schemas/2.4.14/schema.json`.
- `cloud/node_modules/.bin/biome --version` reports `2.4.15`.
- `cloud/node_modules/@biomejs/biome` currently points to `cloud/node_modules/.bun/@biomejs+biome@2.4.15/...`.

This schema mismatch is not the formatter blocker, but it should be cleaned up or avoided by a fresh frozen install before validating.

## Drizzle Resolution Evidence

The frontend typecheck loads two Drizzle physical installs in one TypeScript program:

- Cloud Drizzle:
  `/Users/shawwalters/eliza-workspace/eliza/eliza/cloud/node_modules/.bun/drizzle-orm@0.45.2+cee48a6471b6eae6/node_modules/drizzle-orm`

- Root/plugin Drizzle:
  `/Users/shawwalters/eliza-workspace/eliza/eliza/node_modules/.bun/drizzle-orm@0.45.2+fc0f68b157690761/node_modules/drizzle-orm`

Trace examples:

- `cloud/packages/db/client.ts` resolves `drizzle-orm/*` to the cloud install.
- `cloud/packages/db/schemas/*` resolves `drizzle-orm` and `drizzle-orm/pg-core` to the cloud install.
- `cloud/packages/db/schemas/eliza.ts` resolves `@elizaos/plugin-sql` to `plugins/plugin-sql/src/index.ts`.
- `plugins/plugin-sql/src/index.ts` and `plugins/plugin-sql/src/schema/agent.ts` resolve `drizzle-orm` and `drizzle-orm/pg-core` to the root/plugin install.
- `packages/core/src/...` files imported through `@elizaos/core` also resolve `drizzle-orm` to the root/plugin install.

The representative TypeScript error compares these two paths and fails on Drizzle private/protected class members:

```text
.../eliza/node_modules/.bun/drizzle-orm@0.45.2+fc0f68b157690761/...
is not assignable to
.../eliza/cloud/node_modules/.bun/drizzle-orm@0.45.2+cee48a6471b6eae6/...
Property 'config' is protected but type 'Column<...>' is not a class derived from 'Column<...>'.
```

The package versions are both `0.45.2`; the failure is physical type identity, not semver drift.

## Likely Causes

1. `cloud` is its own Bun workspace with its own `bun.lock` and `node_modules`, while the repo root also has a separate install. This creates multiple valid Drizzle physical locations.

2. `cloud/apps/frontend/tsconfig.json` defines its own `compilerOptions.paths`. Its resolved config does not include the parent `cloud/tsconfig.json` Drizzle aliases:

```json
"paths": {
  "@/lib/*": ["../../packages/lib/*"],
  "@/db/*": ["../../packages/db/*"],
  "@elizaos/core": ["../../../packages/core/src/index.node.ts"],
  "@elizaos/plugin-sql": ["../../../plugins/plugin-sql/src/index.ts"],
  "@/*": ["./src/*"]
}
```

3. The frontend graph imports cloud server/shared code through aliases such as `@/lib/*` and `@/db/*`. One concrete frontend import is `cloud/apps/frontend/src/lib/data/invoices.ts`, which imports `type { Invoice } from "@/db/schemas"`. That pulls cloud Drizzle schema types into the frontend typecheck.

4. `cloud/packages/db/schemas/eliza.ts` re-exports plugin-sql tables from source, so the same frontend typecheck also pulls `plugins/plugin-sql/src/*`, which resolves Drizzle from the root/plugin install.

5. `cloud/apps/api/tsconfig.json` already has explicit Drizzle path aliases to avoid this class of split:

```json
"drizzle-orm": ["../../../plugins/plugin-sql/node_modules/drizzle-orm"],
"drizzle-orm/*": ["../../../plugins/plugin-sql/node_modules/drizzle-orm/*"]
```

The frontend tsconfig lacks an equivalent mapping.

6. Repo-root `bun run typecheck` is not evidence that cloud frontend is healthy. The root workspace list includes `cloud/packages/sdk`, but not `cloud/apps/frontend`, `cloud/packages/db`, or `cloud/packages/lib`. Cloud validation is gated separately by `typecheck:cloud` / `verify:cloud`.

## Safest Fix Shape

Recommended minimal fix:

- Add explicit `drizzle-orm` and `drizzle-orm/*` path mappings to `cloud/apps/frontend/tsconfig.json`.
- Mirror `cloud/apps/api/tsconfig.json` unless the cloud owner intentionally wants the canonical Drizzle install to be `cloud/node_modules`.
- This is local to frontend type resolution and avoids package/lockfile churn.

Candidate shape:

```json
"drizzle-orm": ["../../../plugins/plugin-sql/node_modules/drizzle-orm"],
"drizzle-orm/*": ["../../../plugins/plugin-sql/node_modules/drizzle-orm/*"]
```

Safer long-term fix:

- Stop importing backend Drizzle row types and server modules into the browser app.
- Move client DTOs used by `cloud/apps/frontend` into `cloud/packages/types` or frontend-local API types.
- Keep `@/db/*` and server-heavy `@/lib/*` out of frontend typecheck and Vite SSR bundle paths where practical.

Biome fix:

- Run Biome formatting only after coordinating with active cloud/file owners.
- Prefer targeted formatting for the listed files, or run `biome check --write` in `cloud` only when the worktree is otherwise coordinated.
- Reinstall or relink `cloud/node_modules` from `cloud/bun.lock` before final validation so the Biome binary matches `2.4.14`, or intentionally migrate both package/lock/schema to `2.4.15` as a separate package-management change.

## Validation Commands

After a tsconfig fix:

```bash
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd cloud/apps/frontend typecheck
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd cloud/apps/api typecheck
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd cloud typecheck
```

After formatting:

```bash
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd cloud/apps/frontend lint
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd cloud lint:check
```

Final cloud gate:

```bash
PATH=/Users/shawwalters/.bun/bin:$PATH bun run --cwd cloud verify
```

Optional resolver sanity check:

```bash
cd cloud/apps/frontend
node_modules/.bin/tsc --showConfig
node_modules/.bin/tsc --noEmit --incremental false --traceResolution --pretty false 2>&1 | rg "drizzle-orm.*was successfully resolved"
```

Expected outcome: Drizzle imports in the frontend typecheck should resolve to one physical Drizzle install, not both `cloud/node_modules/.bun/...cee48...` and `node_modules/.bun/...fc0...`.

## Owners

No repository-level CODEOWNERS entry applies to `cloud`; the only CODEOWNERS file found is under `packages/inference/llama.cpp`.

Practical owners to coordinate with:

- Cloud/frontend and cloud package validation: recent relevant commits are by Shaw.
- Cloud CI and formatting hygiene: recent cloud workflow/package commits include Shaw and lalalune.
- Plugin-sql / Drizzle identity: coordinate with the plugin-sql and cloud-db maintainers before changing package layout or dependency ownership.

## Risks

- Running `biome check --write .` from `cloud` will touch 14 files across API, frontend, db, lib, scripts, and tests. That can collide with concurrent workers.
- Updating Biome schema/package/lock to `2.4.15` just to silence the local schema info message is package churn. A fresh frozen install may be enough because the lock resolves `2.4.14`.
- A tsconfig Drizzle alias is a narrow compatibility fix. It does not address the broader issue that frontend typecheck currently sees backend database and server modules.
- Changing cloud/root dependency hoisting or removing one Drizzle install has larger blast radius across Cloudflare API, plugin-sql, core, PGlite, Neon, and tests.
- `skipLibCheck` will not hide this failure because the incompatibility is in project source types, not only external declaration checking.

## Blocker Decision

Implementation should happen before the cleanup program treats cloud validation as green. The minimal path is:

1. Coordinate and apply the listed Biome formatting.
2. Add a frontend Drizzle path mapping that matches the API app or otherwise forces one Drizzle physical identity.
3. Re-run frontend lint/typecheck, cloud lint:check/typecheck, then `cloud verify`.
