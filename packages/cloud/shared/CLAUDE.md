# @elizaos/cloud-shared

Shared backend code for Eliza Cloud: billing arithmetic, Drizzle DB schemas/repositories/migrations, server-side service library, transport types, and route/auth helpers.

## Role

Single private workspace package (`@elizaos/cloud-shared`) consumed by the rest of the cloud stack:

- `@elizaos/cloud-api` — Hono API on Cloudflare Workers (imports `lib/`, `db/`, `billing/`, `types/`).
- `packages/app` — Vite + React 19 Cloud surfaces; imports only the isomorphic bits (`billing/`, some `types/`).
- `@elizaos/cloud-services/*` and a few plugins.

Consumers use subpath exports for billing, database, service-library, and type
surfaces; keep those boundaries explicit rather than importing internal files.

## Layout

```
src/
  index.ts                 top barrel — re-exports billing/db/lib/types as namespaces
  billing/                 @elizaos/cloud-shared/billing — pure, isomorphic markup math
    markup.ts              applyMarkup, Twilio SMS billing, USD rounding
    credit-markup.ts       calculateCreditMarkup, platform fee breakdown
    index.ts
  db/                      @elizaos/cloud-shared/db — Drizzle (Railway prod, PGlite local)
    schemas/               ~100 table schemas (apps, agents, billing, containers, ...)
    repositories/          ~69 CQRS repositories (readers/writers split)
    migrations/            generated SQL — never hand-edit applied migrations
    client.ts              DB client (Worker routes through the Hyperdrive binding)
    crypto/  utils/
    index.ts
  lib/                     @elizaos/cloud-shared/lib — SERVER-ONLY services + use-cases
    services/              ~245 service modules (containers, gateways, billing, ...)
    auth.ts auth-anonymous.ts auth-errors.ts   session/API-key/wallet auth
    oidc/                  OpenID Connect PROVIDER domain (Eliza Cloud as the OP):
                           config/keys/clients/codes/claims/username/tokens.
                           Routes live in cloud-api; nothing here reads a request.
    api/  middleware/  cors/  http/  session/   request-edge helpers
    stripe.ts  pricing.ts  promotion-pricing.ts
    utils/logger.ts        the structured logger used across lib/
    index.ts
  types/                   @elizaos/cloud-shared/types
    cloud-api.ts           API DTO types
    cloud-worker-env.ts    Cloudflare Worker env bindings
    stripe-queue-message.ts
    index.ts
drizzle.config.ts          points at ./src/db/{schemas,migrations}
scripts/messaging-gateway-preflight.mjs   preflight:messaging-gateways
scripts/managed-accounts-doctor.mjs       verify:managed-accounts (managed provider accounts, #19910)
docs/                      WHY docs (auth consistency, provisioning, messaging gateways)
```

Subpath imports: `import { ... } from "@elizaos/cloud-shared/db"`, `".../billing"`, `".../lib/services/<x>"`, `".../types"`. Exports map: `.` `./billing` `./db` `./db/*` `./lib` `./lib/*` `./types` `./types/*` (see `package.json`).

## Key exports

- `src/index.ts` — namespaces: `billing`, `db`, `lib`, `types`.
- `billing/index.ts` — `applyMarkup`, `applyMarkupCents`, `calculateCreditMarkup`, `calculateTwilioSmsBilling`, `roundUsd`, plus `DEFAULT_MARKUP_RATE`, `PLATFORM_MARKUP_MULTIPLIER`, `DEFAULT_PLATFORM_FEE_RATE`, and the `MarkupBreakdown` / `CreditMarkupBreakdown` types.
- `db/index.ts` re-exports a few repositories (`userCharactersRepository`, `dockerNodesRepository`, `voiceImprintsRepository`); most schemas/repositories are imported by their own subpath, e.g. `@elizaos/cloud-shared/db/repositories/apps`.
- `lib/index.ts` — `logger`, container/provisioning helpers (`WarmPoolManager`, `getHetznerContainersClient`, `getHetznerPoolContainerCreator`, `provisioningJobService`, `elizaSandboxService`, `dockerNodeManager`), `runWithCloudBindingsAsync`, envelope helpers (`envelope`, `errorEnvelope`).

## Commands

```bash
bun run --cwd packages/cloud/shared typecheck              # tsc --noEmit
bun run --cwd packages/cloud/shared lint                   # biome check
bun run --cwd packages/cloud/shared lint:fix
bun run --cwd packages/cloud/shared test                   # scripts/run-bun-tests.mjs (bun test --isolate; win32: PGlite quarantine, #15785)
bun run --cwd packages/cloud/shared db:generate            # drizzle-kit generate
bun run --cwd packages/cloud/shared db:migrate             # migrate-with-diagnostics.ts
bun run --cwd packages/cloud/shared db:migrate:drizzle     # alias of guarded db:migrate
bun run --cwd packages/cloud/shared db:studio              # drizzle-kit studio
bun run --cwd packages/cloud/shared db:check-migrations    # drizzle-kit check
bun run --cwd packages/cloud/shared preflight:messaging-gateways
bun run --cwd packages/cloud/shared verify:managed-accounts   # managed provider account status; :strict fails closed
bun run --cwd packages/cloud/shared generate:email-templates
```

`build:linked-workspaces` defers to the repo-root `build:core`; there is no standalone build step here (consumers import `src/` directly).

## Config / env vars

`db/database-url.ts` resolves the Postgres URL: explicit `DATABASE_URL`/`TEST_DATABASE_URL` (Railway in prod) wins; otherwise local (non-CI, non-production) dev falls back to a file-backed PGlite store at `pglite://<cwd>/.eliza/.pgdata` (override the path with `PGLITE_DATA_DIR`/`LOCAL_DATABASE_PATH`; set `DISABLE_LOCAL_PGLITE_FALLBACK=1` to opt out). The `pglite:server` script runs a pglite-socket sidecar so `drizzle-kit` can connect. The `lib/` services read service-specific env (Stripe, Steward session/JWT secrets, BitRouter/provider keys, Telegram/Discord/WhatsApp, Hetzner/container infra, etc.). See `.env.example` for the full set.

`CREDIT_COST_BUFFER` (`credits-config.ts`, default `1.5`) sizes the safety margin on every pre-request credit reservation and affiliate-admission check (`credits.ts`'s `reserve()` and `organization-inference-admission.ts`). Must be one auditable canonical decimal spelling from `1` through `1000` (`1` = no buffer) — no leading zeros, no exponent notation, no leading `+`/`.`, no `_` separators (e.g. `"01"`, `"0001.5"`, `"1e1"`, `".5"`, `"1_000"` are all rejected as non-canonical, not just out of range); unset/blank uses the default, anything else throws `ElizaError` (`INVALID_CREDIT_COST_BUFFER`) at module load. The minimum is `1`, not `0` — a buffer below `1` underflows the reservation calculation back toward `MIN_RESERVATION`, defeating the purpose of the setting; the canonical grammar's ban on a leading-zero integer part means no string can represent a value below `1` in the first place, so this bound can never be affected by float-rounding. The `1000` ceiling is compared against the decimal text exactly (integer-part length/value, then an all-zero-or-absent fraction), not the `Number()`-converted value — `"1000.0000000000000001"` is textually above `1000` even though it rounds to exactly `1000` in double precision, and is rejected accordingly.

`INFERENCE_AUTH_HYDRATION_DEADLINE_MS` (`inference-auth-context.ts`, default `10000`) bounds a background auth hydration attempt. It must be a canonical decimal integer from `1` through `2147483647`; unset/blank uses the default, and invalid values throw `ElizaError` (`INVALID_INFERENCE_AUTH_HYDRATION_DEADLINE`) at module load.

Plaid uses `PLAID_CLIENT_ID` plus an environment-specific secret:
`PLAID_SANDBOX_SECRET`, `PLAID_DEVELOPMENT_SECRET`, or
`PLAID_PRODUCTION_SECRET`. `PLAID_SECRET` remains a compatibility alias only
for the active `PLAID_ENV`; cross-environment Item cleanup fails closed unless
the stored Item environment's explicit secret is configured.

## How to extend

- **New table:** add a schema in `src/db/schemas/`, then `bun run --cwd packages/cloud/shared db:generate`, review the SQL in `src/db/migrations/`, run `db:migrate`, commit schema + migration together. Add a repository in `src/db/repositories/` (reader and writer split per CQRS).
- **New service / use-case:** add a module under `src/lib/services/` (or the relevant `lib/` subdir). Keep business computation here, not in `cloud-api` routes. Import `logger` from `../utils/logger`. Export from `lib/index.ts` only if a consumer needs the top barrel; otherwise rely on the `./lib/*` subpath.
- **New DTO type:** add to `src/types/cloud-api.ts` (or a sibling) and export via `types/index.ts`.

## Conventions / gotchas

- **`src/lib/` is server-only.** Browser code (React, hooks, stores, Tailwind
  utilities) lives in `packages/app`, not here. Only pure isomorphic helpers
  (`billing/`, math/string/validation) are safe to import from the frontend.
- **Migrations are append-only.** Never edit an applied migration. No `CREATE INDEX CONCURRENTLY` (runs in a transaction). Use `IF NOT EXISTS` / `IF EXISTS`. Keep migrations small and targeted (<100 lines): add objects, backfill, and drop in separate migrations — no omnibus recreate-the-schema files (they lock active prod tables). Never `db:push`.
- **`typecheck` noise:** errors that surface are often from transitive imports (e.g. `plugins/plugin-elizacloud/...`) pulled in via tsconfig paths, not this package's own source. Filter to your files: `bun run --cwd packages/cloud/shared typecheck 2>&1 | grep <your-file>`.
- **win32 PGlite quarantine (#15785):** on Windows the `test` entry (`scripts/run-bun-tests.mjs`) runs the PGlite tenant-db placement-claimer and authenticated native pairing suites in their own child `bun test` process and retries them (bounded) ONLY on a Bun native-crash signature (`panic(main thread): Illegal instruction`, exit 3), capturing the panic to `.tmp/bun-pglite-crash/` for the upstream Bun report (`scripts/bun-pglite-crash-upstream-report.md`). Genuine test failures never retry; non-win32 behavior is a plain `bun test --isolate`. Renamed a suite? Update `DEFAULT_QUARANTINED_SUITES` in `scripts/run-bun-tests-helpers.mjs` (the run fails loudly until you do).
- **Repo-wide rules** (logger-only/no-console, ESM, naming, clean-architecture commandments, CQRS, validate-at-boundary, DTO fields required) live in the root `CLAUDE.md`. The WHY docs under `docs/` explain non-obvious choices: `messaging-onboarding-gateway-design.md` and `CLOUD_ONBOARDING_PROVISIONING_REVIEW.md`.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
