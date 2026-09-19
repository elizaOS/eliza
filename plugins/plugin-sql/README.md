# @elizaos/plugin-sql

SQL database adapter plugin for elizaOS — provides persistent storage via PostgreSQL or embedded PGlite (WASM), with Drizzle ORM, automatic schema migrations, and optional Row Level Security.

## Installation

```bash
bun add @elizaos/plugin-sql
```

## Overview

This plugin registers a `DatabaseAdapter` with the elizaOS agent runtime so that all core runtime persistence (memories, entities, rooms, tasks, cache, logs, relationships, etc.) works against a real SQL backend. On Node/Bun it selects PostgreSQL when `POSTGRES_URL` is set, otherwise falls back to embedded PGlite. In the browser build it always uses PGlite (WASM).

## Identity authority

The plugin registers `SqlPrincipalService` as the runtime's canonical
identity authority. Its private person-link endpoints let an authenticated
OWNER or ADMIN attest that two preserved principals represent the same person
without merging or deleting either principal:

- `POST /api/identity/person-links/attest` accepts the two principal IDs, the
  exact expected identity generation, a reason, and an idempotency key. Actor,
  role, authority kind, and transport evidence are derived from a required
  authenticated `AccessContext`; missing context fails closed.
- `GET /api/identity/person-links/verify` verifies the pair at an exact
  generation and returns `attested` or `not_attested`.

The attestation request rejects unknown fields, including client-authored
`confirmed`, `verified`, actor, and role values. Attestations are immutable
audit evidence and never create canonical redirects or merge-journal rows.

## Membership authority

`SqlMembershipService` is the durable authority for connector-account room
membership. Each scope first registers a publisher instance, generation, and
evidence mode. Only an atomic explicitly complete roster snapshot, an ordered
delta following a complete snapshot in the same publisher generation, or a
bounded point-query proof can make evidence current. Durable cursor continuity,
scope generations, and exact idempotency receipts prevent duplicate or
out-of-order evidence from resurrecting a newer revocation.

Every authorization rechecks persisted `validUntil` values against the trusted
service clock. Missing, expired, stale, unavailable, and unsupported authority
deny explicitly. Complete snapshots atomically upsert observed members and
retain absent active members as revoked facts; incomplete or failed pagination
atomically marks the scope stale without changing the roster or advancing its
durable cursor. Authorization also requires a membership fact to match the
scope's current publisher generation. Point proof for one principal creates no
fact about another.
The service invalidates registered dependent caches before notifying observers.
Connector composition and document authorization remain separate slices, and
the service exposes no model-callable mutation action.

## Database Schema

The plugin uses the following main tables:

- **Agent**: Agent information and configurations
- **Room / Channel**: Conversation rooms and messaging channels
- **Participant / ChannelParticipant**: Participants in rooms and channels
- **Memory**: Agent memories with vector embeddings for semantic search
- **Embedding**: Vector embeddings for entities
- **Entity**: Entities agents interact with
- **Relationship**: Relationships between entities
- **Component**: Agent components and configurations
- **Tasks**: Tasks and goals
- **Log**: System logs
- **Cache**: Frequently accessed data cache
- **World**: World settings and configurations

Table definitions live in `src/schema/`.

## Electric Sync (PGlite ↔ Electric Cloud)

When `ELIZA_ELECTRIC_SYNC_URL` and `AGENT_ID` are set, PGlite connects to an Electric sync service and streams real-time updates for all core tables. Each agent syncs only its own rows (filtered by `agent_id` / `id`), preserving per-agent isolation in shared-Neon deployments.

### Local dev with Electric Cloud

The e2e write-back test (`__tests__/integration/electric-write-back.test.ts`) uses a [Caddy](https://caddyserver.com) reverse proxy to forward shape requests to Electric Cloud with auth. Caddy is the proxy [recommended by Electric](https://electric.ax/docs/sync/guides/troubleshooting#missing-headers).

```bash
# 1. Set your Electric Cloud credentials (get these from dashboard.electric-sql.cloud)
export ELECTRIC_CLOUD_SOURCE_ID=svc-xxxxxxxxxxxx
export ELECTRIC_CLOUD_SECRET=eyJ...

# 2. Start the Caddy proxy
caddy run --config plugins/plugin-sql/caddy/electric-proxy.Caddyfile

# 3. Run the e2e test
bun run --cwd plugins/plugin-sql test -- \
  __tests__/integration/electric-write-back.test.ts
```

The Caddyfile at `plugins/plugin-sql/caddy/electric-proxy.Caddyfile` forwards every incoming request to `api.electric-sql.cloud` with auth query params appended.

## Environment Variables

| Variable | Required | Default | Effect |
|----------|----------|---------|--------|
| `POSTGRES_URL` | No | — | PostgreSQL connection string. When absent, PGlite is used. |
| `PGLITE_DATA_DIR` | No | `.eliza/.elizadb` | Directory (or `idb://` URL) for PGlite data storage. |
| `ELIZA_ELECTRIC_SYNC_URL` | No | — | Base URL of Electric sync service (e.g. `http://localhost:3001` via Caddy). |
| `AGENT_ID` | Conditional | — | UUID of the agent. Required when `ELIZA_ELECTRIC_SYNC_URL` is set (per-agent WHERE filter). |
| `ELIZA_CLOUD_WRITE_BASE_URL` | No | — | Write-back cloud endpoint for forwarding local PGlite writes to Postgres. |
| `ELIZA_CLOUD_SERVICE_KEY` | No | — | Service key for authenticating write-back requests. |
| `ELECTRIC_CLOUD_SOURCE_ID` | Test-only | — | Electric Cloud source ID (consumed by Caddy, not the runtime). |
| `ELECTRIC_CLOUD_SECRET` | Test-only | — | Electric Cloud JWT secret (consumed by Caddy, not the runtime). |
| `ELIZA_PGLITE_DISABLE_EXTENSIONS` | No | `false` | Set to `1` to disable PGlite extensions (vector, live, fuzzystrmatch, pg_trgm, Electric sync). |
| `ENABLE_DATA_ISOLATION` | No | `false` | When `true`, enables PostgreSQL Row Level Security per-server isolation. |
| `ELIZA_SERVER_ID` | Conditional | — | Required when `ENABLE_DATA_ISOLATION=true`; becomes the RLS server UUID. |
| `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS` | No | `false` | Allow column drops and other destructive schema changes at startup. |
| `ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS` | No | auto | Controls automatic install of the `message_search_document` generated column and message-search GIN indexes. Production Postgres adapters skip this DDL by default; set `true` after scheduling the generated-column/index migration. |
| `ELIZA_MEMBERSHIP_TTL_DESTRUCTIVE_TEST` | Test-only | — | Must be exactly `1` before the real-PostgreSQL membership-TTL concurrency proof may execute destructive setup. |
| `ELIZA_MEMBERSHIP_TTL_SCRATCH_DATABASE` | Test-only | — | Exact dedicated database name for that proof; must match `eliza_membership_ttl_test_<16-32 lowercase hex>`, be owned by the connected user, and contain no membership-authority relations. |
| `NODE_ENV` | No | `development` | `production` disables verbose migration logging and tightens safety checks. |

Settings are read via `runtime.getSetting(key)` inside `plugin.init`.

## Vector Dimensions

```typescript
VECTOR_DIMS = {
  SMALL: 384,
  MEDIUM: 512,
  LARGE: 768,
  XL: 1024,
  XXL: 1536,
  XXXL: 3072,
};
```

Unversioned embedding stores retain the dimension-based migration path: runtime boot deletes vectors in other dimension columns and queues their source memories for re-embedding.

Call `ensureEmbeddingSpace(spaceId)` after selecting a dimension to activate an explicitly identified representation. The identifier must include the model, pooling, normalization, and any revision that changes the vector space. This operation preserves existing memory text and vectors, excludes other representations from reads and similarity searches, and returns the current agent's text-bearing memories that still need re-embedding. Repeating it after a restart returns any unfinished work. New vectors receive the active identifier; legacy vectors are never adopted merely because their dimensions match. A running adapter rejects changes to an already selected representation or dimension.

Stop older runtimes that access the same database before activating a named representation, and restart all participating runtimes with compatible code. The database write fence rejects an older writer's in-place overwrite of a tagged vector, including rolling back its enclosing transaction. It does not make older readers representation-aware or prevent an older binary from deleting and recreating a row. Rolling back to an older binary after cutover therefore requires an explicit database/vector migration, not just an application rollback. Complete schema migrations before calling the activation method; a failure must stop embedding use until corrected.

## Runtime Migrations

Plugins export a `schema` object; `DatabaseMigrationService` diffs the schema against the live DB at startup and runs migrations automatically. No manual `drizzle-kit generate` / `drizzle-kit push` step is needed in normal development.

```typescript
// In your plugin
export const plugin = {
  name: "@your-org/plugin-name",
  schema: schema, // Drizzle schema object
  // ...
};
```

Destructive changes (column drops, type changes) are blocked by default. Set `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true` to allow them.

Document list, lookup, and fragment queries authorize each parent before
pagination, counts, bytes, or ranking. A parent `roomId` is its room entitlement
and is joined to current requester membership. Validated
`directGrantEntityIds` provide read-only access independent of room membership,
but never expose `agent-private` documents or grant mutation authority.

Message-search DDL is also guarded on production Postgres. The generated column and GIN indexes are still installed automatically for development/test and embedded PGlite. For production Postgres, schedule the table rewrite/index creation and run with `ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS=true` once the deployment window is approved.

## Connection Management

Both `PostgresConnectionManager` and `PGliteClientManager` are stored under `Symbol.for("elizaos.plugin-sql.global-singletons")` on `globalThis`. This prevents multiple pools when the module is imported from multiple paths in the same process. Do not construct manager instances directly — always go through `createDatabaseAdapter()`.

## Database Pool Configuration

Default Postgres pool configuration (`src/pg/manager.ts`):

```typescript
{
    max: 20,
    min: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000
}
```

## Retry Configuration

`BaseDrizzleAdapter` retries failed operations with exponential backoff and jitter (`src/base.ts`):

```typescript
{
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 10000,
    jitterMax: 1000
}
```

## Requirements

- Node.js or Bun
- PostgreSQL with vector extension (for Postgres mode)

## Conditional embedding persistence

Background embedding results use `updateMemoryEmbedding({id, expected, embedding})`.
The adapter must atomically compare the stored source text, agent, author and room
with `expected` before writing. A changed or deleted source returns `false` and
receives no vector or completion event; database failures throw. Custom database
adapters must implement this contract when upgrading core. A separate read followed
by an unconditional update is insufficient. Vector-only runtime writes retain the
existing reconciliation-lease bypass and invalidate the room cache on success.
