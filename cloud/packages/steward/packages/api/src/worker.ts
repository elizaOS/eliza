/**
 * Cloudflare Workers entry point for the Steward API.
 *
 * The Hono app itself is built in `./app.ts` and is runtime-agnostic. This
 * file is the thin Workers shim that:
 *
 *   - Forwards the `fetch` event to the Hono app.
 *   - Surfaces `env` to per-request middleware via `app.fetch(request, env, ctx)`
 *     (Hono passes them through as `c.env` and `c.executionCtx`).
 *   - Does NOT call `setInterval` (rate-limit GC, nonce GC) — TTLs handle expiry.
 *   - Does NOT call `runMigrations()` — migrations are run out-of-band via
 *     `drizzle-kit migrate` against the Neon URL (see `packages/db/CLOUDFLARE.md`).
 *   - Does NOT register `process.on(SIGINT|SIGTERM)` — Workers are stateless.
 *   - Does NOT have any top-level `await` that hits the network at module init.
 *
 * Required bindings (set via `wrangler secret put` or `vars` in wrangler.toml):
 *   - DATABASE_URL                  Neon HTTP connection string
 *   - DATABASE_DRIVER=neon-http     Selects the HTTP-based postgres driver
 *   - REDIS_DRIVER=upstash          Selects the Upstash REST adapter
 *   - KV_REST_API_URL               Upstash REST endpoint
 *   - KV_REST_API_TOKEN             Upstash REST token
 *   - SKIP_MIGRATIONS=1             Migrations run via wrangler-driven CI script
 *   - STEWARD_SESSION_SECRET        HS256 JWT signing secret
 *   - STEWARD_MASTER_PASSWORD       Vault keystore master password
 *   - RESEND_API_KEY                Magic-link email provider
 *   - GOOGLE/DISCORD/GITHUB/TWITTER OAuth client IDs + secrets
 *   - PASSKEY_RP_ID, PASSKEY_ORIGIN, PASSKEY_RP_NAME
 */

import { app } from "./app";

export interface Env {
  DATABASE_URL: string;
  DATABASE_DRIVER?: string;
  REDIS_DRIVER?: string;
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  SKIP_MIGRATIONS?: string;
  STEWARD_SESSION_SECRET?: string;
  STEWARD_MASTER_PASSWORD?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  APP_URL?: string;
  EMAIL_AUTH_REDIRECT_BASE_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  TWITTER_CLIENT_ID?: string;
  TWITTER_CLIENT_SECRET?: string;
  PASSKEY_RP_ID?: string;
  PASSKEY_ORIGIN?: string;
  PASSKEY_RP_NAME?: string;
  [key: string]: unknown;
}

/**
 * Pull Worker `env` bindings into `globalThis.process.env` so any code that
 * reads `process.env.X` at request time (e.g. JWT secret, RPC URL) can find it.
 *
 * Workers expose `nodejs_compat`'s `process.env` as an empty object on cold
 * boot — bindings come in via the `fetch` handler's `env` argument instead.
 * We do this on each request because Workers may reuse isolates across
 * different deployments (and therefore different binding sets).
 */
function hydrateProcessEnv(env: Env): void {
  // biome-ignore lint/suspicious/noExplicitAny: process.env type from nodejs_compat
  const target = (globalThis as any).process?.env;
  if (!target) return;
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (typeof value === "string" && target[key] === undefined) {
      target[key] = value;
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    hydrateProcessEnv(env);
    return app.fetch(request, env, ctx);
  },
};
