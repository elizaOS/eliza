# @elizaos/cloud-shared

Shared backend code for Eliza Cloud: billing arithmetic, Drizzle DB schemas/repositories/migrations, the server-side service library, transport types, and route/auth helpers. This is a private workspace library — there is no app or dev server here. Consumers import its source directly via subpath exports.

## Consumers

- `@elizaos/cloud-api` — Hono API on Cloudflare Workers; imports `lib/`, `db/`, `billing/`, `types/`.
- `@elizaos/cloud-frontend` — Vite + React 19 (Cloudflare Pages); imports only the isomorphic bits (`billing/`, some `types/`).
- `@elizaos/cloud-services/container-control-plane` — Node service for Hetzner container provisioning.
- A few plugins (e.g. `plugin-streaming` via `@elizaos/cloud-routing`).

## Source layout

```
src/
  index.ts        top barrel — re-exports billing/db/lib/types as namespaces
  billing/        pure, isomorphic markup math (applyMarkup, credit markup, Twilio SMS)
  db/             Drizzle layer — schemas/ (97), repositories/ (66, CQRS), migrations/,
                  client.ts, database-url.ts, crypto/, utils/
  lib/            SERVER-ONLY services + use-cases — services/ (207), auth*.ts,
                  api/ middleware/ cors/ http/ session/, stripe.ts, pricing.ts,
                  promotion-pricing.ts, utils/logger.ts
  types/          cloud-api.ts (DTOs), cloud-worker-env.ts, stripe-queue-message.ts
drizzle.config.ts            schema ./src/db/schemas, out ./src/db/migrations
scripts/messaging-gateway-preflight.mjs
docs/                        WHY docs (provisioning, messaging gateways)
```

Import via subpath: `@elizaos/cloud-shared/billing`, `/db`, `/db/repositories/apps`, `/lib`, `/lib/services/<x>`, `/types`. Exports map (`package.json`): `.` `./billing` `./db` `./db/*` `./lib` `./lib/*` `./types` `./types/*`.

Synthetic test consumers use `/db/repositories/synthetic-environment-leases`.
Its guarded callback receives the same locked PostgreSQL/PGlite transaction as
the generation check, so an old reset generation cannot commit afterward.
`/db/repositories/synthetic-world-commands` persists the storage-neutral
command journal in that transaction. Its PGlite contract test uses the real
agents repository to prove the domain mutation, transactional readback, result
serialization, and `COMMITTED` transition commit or roll back together.
The lease and subprocess authorities share the exact 512-character namespace
validator. Treat a transaction/transport exception as ambiguous and reconcile
the canonical snapshot before retrying an acquire, rollover, or release.

`src/lib/` is server-only — browser code lives in `cloud-frontend`. Only the isomorphic helpers (`billing/`, math/string/validation) are safe to import from the frontend.

## Commands

```bash
bun run --cwd packages/cloud/shared typecheck            # tsc --noEmit
bun run --cwd packages/cloud/shared lint                 # biome check
bun run --cwd packages/cloud/shared lint:fix
bun run --cwd packages/cloud/shared test                 # bun test
bun run --cwd packages/cloud/shared db:generate          # drizzle-kit generate
bun run --cwd packages/cloud/shared db:migrate           # migrate-with-diagnostics.ts
bun run --cwd packages/cloud/shared db:migrate:drizzle   # alias of guarded db:migrate
bun run --cwd packages/cloud/shared db:studio            # drizzle-kit studio
bun run --cwd packages/cloud/shared db:check-migrations  # drizzle-kit check
bun run --cwd packages/cloud/shared preflight:messaging-gateways
```

There is no build step here (`build:linked-workspaces` defers to the repo-root `build:core`).

## Config

`db/database-url.ts` resolves the Postgres URL: explicit `DATABASE_URL` / `TEST_DATABASE_URL` (Railway in production) wins; otherwise local dev falls back to a file-backed PGlite store at `pglite://<cwd>/.eliza/.pgdata` (override the path with `PGLITE_DATA_DIR` / `LOCAL_DATABASE_PATH`). The `lib/` services read service-specific env (Stripe, Steward session/JWT secrets, BitRouter/provider keys, Telegram/Discord/WhatsApp, Hetzner/container infra). See `.env.example` for the full set.

## Exact restore quarantine start

`prepareAgentBackupRestoreQuarantine` joins the concrete quarantined-create
runtime to the start service below. It requires explicit enablement and a caller
deadline, snapshots the target before yielding, and stops on a provider outcome
requiring reconciliation. After successful create or exact create replay it
takes a fresh operation claim, checks the retained container, starts the host
and releases its own claim. Lost start replies reject; retry reloads the durable
create result and probes the same host. Claim-release failure also rejects rather
than reporting completion. A lost claim-acquire acknowledgement stays fenced
until that claim expires. The production worker/API dispatcher and subsequent
streaming/materialization steps still need to invoke this preparation turn; its
`quarantine_running` result is not an activated or restored Agent.

`startAgentBackupRestoreQuarantine` is a disabled-first service for a coordinator
that already owns a restore operation claim. It admits only `container_created`
with settled provider authority, using the existing PRIMARY lock order to check
the source, lease, claim, sandbox, node occurrence and replacement. Locks remain
held through a deadline-bounded dedicated SSH session. No phase or capacity
advance is performed; ambiguous transport or transaction outcomes require exact
retry. This is not a workload boot, activation or routing grant.

The remote command verifies the exact container, child image manifest, startup
arguments and quarantine settings, then starts only that retained ID. Running
replay checks the live quarantine PID 1 without restarting it. The opt-in
`restore-quarantine-start.docker.test.ts` suite executes this generated command
against local Docker. Build the Agent package and preload `node:24.15.0-alpine`
plus its native child-manifest reference before running with
`AGENT_RESTORE_V3_DOCKER_TESTS=1`. The harness translates the Linux boot-id path
and Docker socket for the local machine; it is not a real SSH, remote boot-fence,
PostgreSQL concurrency or restored-runtime proof. Test-owned containers and
temporary files are removed after each test; no image is pulled implicitly.

## Catalogue-backed restore streaming

`executeAgentBackupRestoreQuarantineMaterializer` executes one private framed
Agent request under the same PRIMARY quarantine guard as start. It verifies the
request's restore attempt, source operation, manifest and raw payload, retains
the shorter request/caller deadline, and sends owned, zeroized frame bytes through
a dedicated SSH session. The generated command requires the exact quarantine to
be running; it never starts a stopped container. Only the worker's exact canonical
receipt digest counts as success. Root device/inode authorities are supplied by
the trusted coordinator and checked by the Agent, not discovered or provisioned
by this service.

This receipt is not a candidate-ledger commit. The service owns a PRIMARY
transaction and must not be called from a candidate-materialization callback
already holding those locks. The durable stream/ledger integration still needs
one shared transaction boundary and crash-recoverable session/root authority.
PGlite covers the real service with SSH stubbed; the native Docker command test
materializes/replays a real character and rejects a substituted root inode. It
does not establish remote SSH or a booted restored Agent.

`streamAgentBackupRestoreV3FromCatalogue` loads the selected manifest-v3 copy
and its private object locators from PRIMARY, then invokes the existing exact
GET and authenticated five-component stream. It requires explicit enablement,
an absolute deadline and trusted storage/KMS/isolated-staging capabilities.
Callers do not supply an object inventory or override authority revalidation.
The source loader also accepts optional operation control, setting transaction-
local statement/lock timeouts and rejecting cancellation before returning data.

Before reading payloads and again before sealing, the stream reloads the source
and compares the complete canonical object authority, including provider
generations. The kernel additionally checks the exact lease fence. A changed
catalogue or wrong configured backend rejects; neither triggers discovery,
another copy selection, an empty restore, activation or route publication.

Composition tests execute the real AES-GCM stream and exact GET adapter against
a simulated catalogue and native R2 binding; separate PGlite tests exercise the
real source loader and its operation control. These are not live R2/Hetzner,
remote Agent materialization or booted-runtime evidence. The production
dispatcher and durable Agent transport still need to supply and invoke this
path together with quarantine preparation.

## More

See [CLAUDE.md](./CLAUDE.md) for the migration workflow, how to add tables/services/DTOs, and the architecture rules (CQRS, server-only `lib/`, append-only migrations). WHY docs live under `docs/`.
