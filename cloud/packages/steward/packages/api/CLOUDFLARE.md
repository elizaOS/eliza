# Steward API on Cloudflare Workers

Steward now ships three runtime adapters that share the same Hono app
(`packages/api/src/app.ts`):

| Adapter        | Entry point                          | Use case                                                          |
| -------------- | ------------------------------------ | ----------------------------------------------------------------- |
| Bun (existing) | `packages/api/src/index.ts`          | Production server with TCP Postgres + ioredis. Long-lived process.|
| PGLite         | `packages/api/src/embedded.ts`       | Electrobun / desktop. In-process WASM Postgres, no external deps.  |
| Workers (new)  | `packages/api/src/worker.ts`         | Cloudflare Workers. HTTP Postgres (Neon) + REST Redis (Upstash). |

The adapters are additive — switching to Workers does NOT change the Bun
or PGLite paths.

## Architecture

- **DB driver** is selected by the `DATABASE_DRIVER` env var:
  - `postgres-js` (default): TCP pool, used by Bun/Node.
  - `neon-http`: Neon's HTTP/fetch driver, used by Workers.
  - PGLite (set via `setPGLiteOverride()` in `embedded.ts`).
- **Redis** is selected by `REDIS_DRIVER`:
  - `ioredis` (default): persistent TCP connection, used by Bun/Node.
  - `upstash`: REST adapter (`packages/redis/src/upstash-adapter.ts`)
    around `@upstash/redis`. Same ioredis-shaped surface, fetch-based.
- **JWT verification** stays local using `jose` (HMAC HS256) — works the
  same on Workers.
- **SIWE / SIWS nonces** go through the pluggable `StoreBackend` abstraction
  (`packages/auth/src/store-backends.ts`). On Workers this resolves to
  Upstash; on Bun it resolves to ioredis or Postgres `auth_kv_store`.
- **Migrations** never run inside the Worker. The Bun entry runs them at
  boot unless `SKIP_MIGRATIONS=1`. Workers expect migrations to be applied
  out-of-band via `bun run migrate:neon` (see
  `packages/db/CLOUDFLARE.md`).
- **No setInterval** in the worker entry. All TTL-based cleanup
  (auth challenges, SIWE nonces, rate-limit windows) is enforced by the
  backing store (Upstash / Postgres native expiry).

### Per-request usage on Workers

The neon-http driver is HTTP-only, so a fresh client per request is
acceptable. For the singleton case `getDb()` continues to work, but for
hot paths consider:

```ts
import { createDbForRequest } from "@stwd/db";

app.use("*", async (c, next) => {
  c.set("db", createDbForRequest(c.env));
  await next();
});
```

(Currently Steward calls `getDb()` directly in route handlers; it's still
correct on Workers because the neon-http client is cheap to construct.)

## One-time setup

1. Cloudflare account + `wrangler login`.
2. Provision a Neon project and copy the TCP-capable connection string for
   migrations (e.g. `postgres://...neon.tech/db?sslmode=require`).
3. Provision an Upstash Redis database and copy `KV_REST_API_URL` +
   `KV_REST_API_TOKEN`.
4. (Optional) Reserve any custom domains in Cloudflare so you can attach
   them later.

## Secrets

Set these via `wrangler secret put <NAME>` from the `packages/api`
directory. Do NOT put them in `wrangler.toml`.

| Secret                          | Why                                                                    |
| ------------------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`                  | Neon connection string. Workers use HTTP; migrations need TCP.         |
| `KV_REST_API_URL`               | Upstash REST endpoint.                                                 |
| `KV_REST_API_TOKEN`             | Upstash REST token.                                                    |
| `STEWARD_SESSION_SECRET`        | HS256 JWT signing secret. Canonical name (auth.ts and context.ts).     |
| `STEWARD_MASTER_PASSWORD`       | Vault keystore master password. Used by `KeyStore` (AES-256-GCM).      |
| `STEWARD_KDF_SALT`              | Per-deployment hex salt for the KeyStore KDF. Recommended for prod.    |
| `RESEND_API_KEY`                | Magic-link email delivery.                                             |
| `EMAIL_FROM`                    | Optional: from address for magic links.                                |
| `APP_URL`                       | Optional: base URL for magic-link callbacks.                           |
| `EMAIL_AUTH_REDIRECT_BASE_URL`  | Optional: where to redirect after email auth (defaults elizacloud.ai). |
| `GOOGLE_CLIENT_ID`/`_SECRET`    | Google OAuth.                                                          |
| `DISCORD_CLIENT_ID`/`_SECRET`   | Discord OAuth.                                                         |
| `GITHUB_CLIENT_ID`/`_SECRET`    | GitHub OAuth.                                                          |
| `TWITTER_CLIENT_ID`/`_SECRET`   | Twitter/X OAuth (PKCE).                                                |
| `PASSKEY_RP_ID`                 | WebAuthn relying-party ID (your apex domain).                          |
| `PASSKEY_ORIGIN`                | WebAuthn origin (https://...).                                         |
| `PASSKEY_RP_NAME`               | Display name for the WebAuthn UI.                                      |
| `PASSKEY_ALLOWED_ORIGINS`       | Optional comma-separated additional origins for multi-tenant passkeys. |

`SKIP_MIGRATIONS=1`, `DATABASE_DRIVER=neon-http`, and `REDIS_DRIVER=upstash`
are already in `wrangler.toml` `[vars]` so they ship with every deploy.

## Migrations

```bash
cd packages/db
DATABASE_URL="postgres://...neon.tech/db?sslmode=require" bun run migrate:neon
```

Run this BEFORE `wrangler deploy` so the schema is up to date when traffic
arrives. See `packages/db/CLOUDFLARE.md` for the deeper rationale and CI
example.

## Deploy

```bash
cd packages/api

# Local smoke test (boots a workerd instance against your local secrets):
bunx wrangler dev

# Real deploy to staging or prod:
bunx wrangler deploy --env staging
bunx wrangler deploy --env production
```

`wrangler deploy --dry-run --outdir=dist` (or `bun run wrangler:dry-run`)
builds the worker bundle without uploading. Current bundle size:
**3.3 MiB raw / 949 KiB gzipped** — comfortably under the 10 MiB compressed
Workers limit.

## Testing locally

`wrangler dev` boots a local workerd instance with full nodejs_compat. It
will read `.dev.vars` for secrets — do NOT commit it. Example shape:

```
DATABASE_URL=postgres://USER:PASS@ep-XYZ.us-east-2.aws.neon.tech/db?sslmode=require
KV_REST_API_URL=https://YOUR-DB.upstash.io
KV_REST_API_TOKEN=YOUR_TOKEN
STEWARD_SESSION_SECRET=...
STEWARD_MASTER_PASSWORD=...
RESEND_API_KEY=...
```

## Known limitations

- **No long-lived background work.** Workers don't allow `setInterval`,
  background fetches outside `ctx.waitUntil()`, or persistent connections.
  The Bun entry's IP rate-limit GC and SIWE nonce GC have been replaced by
  TTL-driven cleanup in the storage backends. Anything new that needs a
  cron should use Cloudflare Cron Triggers (add a `scheduled()` handler in
  `worker.ts`).
- **Per-request DB client.** `neon-http` is fetch-based, so we don't
  benefit from connection pooling. For very high QPS, look at
  Hyperdrive (Cloudflare's Postgres pooler) or sharding the workload.
- **No `node:fs` at runtime.** PGLite, the Drizzle file-based migrator,
  and any code that reads from the SQL migrations folder cannot run on a
  Worker. The pluggable factories make sure these paths are dead-code in
  the worker bundle.
- **Web Crypto vs node:crypto.** All current usages
  (`createCipheriv`, `randomBytes`, `scryptSync`, `createPublicKey`,
  `verify`) are supported under `nodejs_compat` (released GA September
  2024). Inline comments at each import site document the verification
  status and a tweetnacl/`crypto.subtle` fallback in case any path fails
  in practice.

## When to fall back

- **Heavy CPU work** (e.g. raising `scryptSync` N to 65536+) may exceed
  the default 10 ms CPU budget. Bump the budget via Cloudflare paid plans
  or move the work off the request path.
- **WebSockets / streaming** — Workers support both, but Steward's API is
  request/response only today.
