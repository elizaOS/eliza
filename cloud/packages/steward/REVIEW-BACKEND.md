# Backend Code Review

**Reviewer:** Sol (automated)
**Date:** 2026-04-11
**Scope:** packages/api, packages/auth, packages/vault, packages/policy-engine, packages/db

---

## Critical (must fix)

- **[packages/api/src/routes/policies-standalone.ts:82-86] SQL injection in `updateTemplate()`** — String interpolation used to build raw SQL: `name = '${body.name.replace(/'/g, "''")}'`. The `replace(/'/g, "''")` escaping is insufficient (can be bypassed with backslash escaping in some Postgres configurations, or with multibyte characters). Use parameterized queries via drizzle's `sql` template tag instead of `sql.raw()`.

- **[packages/api/src/routes/policies-standalone.ts:92-96] SQL injection in `updateTemplate()` raw SQL** — Same issue: `rules = '${JSON.stringify(body.rules)}'::jsonb` and the WHERE clause `WHERE id = '${id}'::uuid AND tenant_id = '${tenantId}'` use string interpolation in `sql.raw()`. Any user-controlled input (the template `id` comes from the URL) is injected directly into SQL. Replace with parameterized `sql` template literals.

- **[packages/api/src/routes/erc8004.ts:48-49] Missing auth check on `register-onchain`** — `ensureAgentForTenant()` is called in a try/catch that swallows errors and returns 404, but it's checking for agent existence, not tenant ownership. The `ensureAgentForTenant` function returns `AgentIdentity | undefined`, and the `catch` block catches any error (including DB errors) and returns 404. Use the same pattern as other routes: check the return value, not exception.

- **[packages/api/src/routes/erc8004.ts:95-115] No tenant isolation on feedback endpoint** — `POST /:id/feedback` does not verify the agent belongs to the tenant. Any authenticated tenant can submit feedback for any agent ID. Add `ensureAgentForTenant(tenantId, agentId)` check.

- **[packages/api/src/services/context.ts:44-48] Duplicate JWT secret initialization** — Both `context.ts` and `routes/auth.ts` independently initialize `JWT_SECRET` with identical logic but potentially different values if env vars change between module loads. The auth routes use `STEWARD_JWT_SECRET` while the user routes use `STEWARD_SESSION_SECRET`. This means JWTs from auth routes won't validate in user routes if these env vars differ. Consolidate to a single JWT secret source.

- **[packages/api/src/routes/user.ts:27-33] Different JWT secret source** — `user.ts` reads `STEWARD_SESSION_SECRET` while `context.ts` and `auth.ts` read `STEWARD_JWT_SECRET`. If both env vars are set to different values, tokens minted by `/auth/*` will fail validation in `/user/*` routes and vice versa. This is a silent auth failure that would be very hard to debug.

- **[packages/vault/src/keystore.ts:18] Fixed salt for master key derivation** — `const salt = Buffer.from("steward-vault-v1")` uses a static salt for deriving the master key via scrypt. This defeats the purpose of salting. If the master password is weak, rainbow tables become viable. Use a randomly generated salt stored alongside the encrypted data, or at minimum, derive from a combination of the password and a per-deployment nonce.

- **[packages/api/src/routes/vault.ts:124-128] Double transaction insert** — `vault.signTransaction()` internally inserts into the `transactions` table (vault.ts:334-353), and then the route handler also does `db.update(transactions).set(...)` on the same `txId`. The vault's insert uses `onConflictDoUpdate`, so it works, but this means every successful sign creates the record in vault then immediately overwrites it from the route. This is fragile coupling — if the vault changes its internal behavior, the route breaks silently.

## High (should fix soon)

- **[packages/api/src/routes/agents.ts:159-170] Missing tenant isolation in batch policy insert** — When batch-creating agents with `applyPolicies`, the policy insert at line 165 doesn't verify the `agentSpec.id` was actually created by `vault.createAgent` successfully. If `createAgent` fails (pushed to `errors` array), the `if (body.applyPolicies)` block still deletes+inserts policies for a potentially non-existent agent. However, the FK constraint on `policies.agentId` referencing `agents.id` should catch this — but it would throw and potentially skip remaining agents in the batch.

- **[packages/api/src/routes/agents.ts:131-139] Agent delete cascade missing tenant isolation** — The `DELETE /:agentId` handler deletes from `approvalQueue`, `transactions`, `policies`, etc. using only `eq(X.agentId, agentId)` without `eq(X.tenantId, tenantId)`. While the final `agents` delete does check both `agentId` and `tenantId`, the cascade deletes operate on agentId alone. If two tenants have agents with the same ID (unlikely but possible with user-chosen IDs), this could cross-contaminate. The FK cascade on the agents table would actually prevent this since the agent row itself is tenant-scoped, but the explicit deletes before it are unnecessary given CASCADE is defined on the FK.

- **[packages/api/src/routes/tenants.ts:36-42] Tenant creation accepts raw API key hash from client** — The `POST /tenants` endpoint accepts `apiKeyHash` directly from the request body. A client could provide a known hash to bypass security. This route should generate its own API key (like `platform.ts` does) rather than accepting a pre-computed hash. Currently it even auto-hashes if the provided value doesn't look like a hash (line 41), but this still means the raw key is sent in the request body.

- **[packages/api/src/routes/platform.ts:238-251] Default policies not actually persisted** — `PUT /tenants/:id/policies` validates policies but then just returns them without saving to the database. The TODO comment confirms: "Once Worker 1 adds `defaultPolicies` to tenants schema, do: `await db.update(tenants).set({ defaultPolicies: body }).where(...)`". This is a silent no-op that looks like it succeeded.

- **[packages/api/src/routes/approvals.ts:115-148] Approval doesn't trigger vault signing** — `POST /:txId/approve` in the approval routes only updates the status to "approved" but does NOT actually sign and broadcast the transaction. Compare with `vault.ts`'s `POST /:agentId/approve/:txId` which does the actual signing. The approvals route is essentially a status update that doesn't complete the workflow. This could confuse API consumers who approve via `/approvals/:txId/approve` expecting the tx to be signed.

- **[packages/api/src/index.ts:109-113] Auth routes (`/auth/*`) have no rate limiting or auth middleware** — All `/auth/*` endpoints are publicly accessible without any middleware. While individual auth endpoints implement their own rate limiting (e.g., `checkAuthRateLimit`), the global rate limiter in index.ts does apply. However, auth endpoints like `/auth/nonce` and `/auth/providers` have no per-endpoint rate limits, making them susceptible to enumeration attacks.

- **[packages/api/src/routes/dashboard.ts:1-95] Dashboard route accesses balance without try/catch** — The `vault.getBalance()` call uses `.catch(() => null)` in the Promise.all, which is good, but the `formatWei` function on line 82 will throw if it receives a non-numeric string. Since `spentToday`, `spentThisWeek`, and `spentThisMonth` come from DB aggregation that could return unexpected values, add defensive parsing.

- **[packages/auth/src/session.ts:88-94] Session invalidation is a no-op** — `SessionManager.invalidateSession()` is explicitly a no-op with a TODO. This means `/auth/logout` and session revocation don't actually invalidate tokens server-side. Compromised tokens remain valid until expiry. The refresh token rotation partially mitigates this for the auth routes, but agent tokens (30d expiry) are a significant risk.

- **[packages/vault/src/solana.ts:109] Lamports cast to Number risks precision loss** — `lamports: Number(lamports)` in `signSolanaTransaction` casts a BigInt to Number. For values > 2^53 (about 9M SOL), this loses precision. Use `.toString()` and pass as string, or keep as BigInt and use a Solana-native method that accepts it.

- **[packages/api/src/services/context.ts:148-157] `defaultTenantReady` is a fire-and-forget promise** — The `defaultTenantReady` const is assigned a promise that inserts the default tenant, but it's only awaited inside `tenantAuth()`. If the DB is slow and a request arrives before this completes, the first request would trigger the await. However, if the insert fails, subsequent calls to `tenantAuth` will re-await the same rejected promise repeatedly. Consider wrapping in a proper init function with error handling.

## Medium (tech debt)

- **[packages/api/src/services/context.ts + routes/auth.ts + routes/user.ts] Three separate JWT implementations** — JWT creation/verification is implemented independently in `context.ts`, `auth.ts`, and `user.ts` with slightly different secret sources, expiry times, and claim structures. `context.ts` uses `JWT_EXPIRY = "24h"`, `auth.ts` uses `ACCESS_TOKEN_EXPIRY = "15m"`, and `user.ts` reads `STEWARD_SESSION_SECRET`. This divergence will cause bugs. Consolidate into the `@stwd/auth` SessionManager.

- **[packages/api/src/services/context.ts + routes/auth.ts] Duplicate nonce store** — Both `context.ts` (line 96) and `auth.ts` (line 134) maintain separate `nonceStore` Maps with separate cleanup intervals. The SIWE nonce from one module won't be found in the other.

- **[packages/api/src/routes/user.ts:62-93] Duplicated `getTransactionStats` function** — The exact same function exists in both `context.ts` and `user.ts`. This is a maintenance risk — fixes in one won't propagate to the other. Import from context.ts instead.

- **[packages/api/src/routes/user.ts:38-42] Duplicated `getVault` function** — Both `user.ts` and `auth.ts` define identical `getVault()` functions. Additionally, `context.ts` creates a global vault singleton. This means up to 3 Vault instances could exist in memory. Consolidate.

- **[packages/api/src/routes/policies-standalone.ts:35-61] Raw SQL for CRUD on `policy_templates`** — Uses `db.execute(sql`...`)` with raw SQL instead of drizzle schema definitions. This means the `policy_templates` table has no drizzle schema definition in `packages/db/src/schema.ts`, so it's invisible to migrations and type checking.

- **[packages/api/src/routes/erc8004.ts] Raw SQL for `agent_registrations`, `reputation_cache`, `registry_index`** — These tables are referenced via raw SQL but have no drizzle schema definitions. They won't be created by migrations. If these tables don't exist, every erc8004 route will 500.

- **[packages/api/src/routes/audit.ts:87-95] Client-side pagination for merged results is inefficient** — When both tx and proxy audit data are requested, the code fetches up to 1000 rows from each source, merges in memory, then paginates. For tenants with high volume, this is O(n log n) per request. Consider using a database UNION query or separate paginated endpoints.

- **[packages/vault/src/vault.ts] Multiple DB round-trips per operation** — `signTransaction()`, `signTypedData()`, `signSolanaTransaction()`, etc. each make 3-5 separate DB queries (verify agent, find key, sign, insert tx). These could be batched into fewer queries or use CTEs.

- **[packages/api/src/routes/policies-standalone.ts:135-151] N+1 query in template assignment** — `POST /:id/assign` validates each agent with a separate `ensureAgentForTenant()` call in a loop, then inserts policies one by one in another loop. Use a batch query for validation and batch insert for policies.

- **[packages/api/src/index.ts:80-95] In-memory rate limiter doesn't scale** — The `requestLog` Map is per-process. Behind a load balancer with multiple instances, each instance has its own counter. A client could get N * RATE_LIMIT_MAX_REQUESTS through. When Redis is available, this should defer to Redis-based rate limiting.

- **[packages/vault/src/vault.ts:334-353] Transaction insert `onConflictDoUpdate` masks data integrity issues** — Using upsert on the transactions table means if a transaction ID collision occurs (UUID collision, or re-signing with the same txId), the old transaction data is silently overwritten. This could mask bugs where the same txId is reused.

- **[packages/api/src/routes/tenant-config.ts] PUT /:id/config has no field validation** — The endpoint accepts arbitrary JSON and stores it directly as JSONB. No validation on `policyExposure` values, `featureFlags` types, or `theme` structure. Malformed config could break the dashboard.

- **[packages/api/src/services/context.ts:138-140] Tenant config cache is never updated from DB** — The `tenantConfigs` Map is populated only at startup (for the default tenant) and via the `tenants.ts` route's POST/PUT. If another instance updates the DB, this instance's cache is stale forever. No TTL, no refresh mechanism.

- **[packages/auth/src/api-keys.ts:18] `validateApiKey` vulnerable to hex parsing edge cases** — `Buffer.from(hash, "hex")` will silently truncate if the hash string contains non-hex characters or has odd length. Add explicit validation that both inputs are 64-char hex strings before comparison.

## Low (nice to have)

- **[packages/api/src/routes/vault.ts] Webhook dispatch is fire-and-forget with no retry** — `dispatchWebhook()` calls `webhookDispatcher.dispatch().catch(console.error)`. Failed webhook deliveries are logged but not retried or recorded. The webhook_deliveries table exists but isn't used by this code path. Wire up the delivery tracking.

- **[packages/api/src/routes/agents.ts:182-216] Policy type validation duplicated** — `PUT /:agentId/policies` has inline policy type validation. The same validation list appears in `platform.ts:222`. Extract to a shared validator in context.ts or @stwd/shared.

- **[packages/api/src/routes/user.ts:253-254] Missing pagination on `/me/wallet/history`** — Returns all transactions for a user without limit. Should accept `limit`/`offset` query params.

- **[packages/api/src/routes/vault.ts:302-310] History endpoint has no pagination** — `GET /:agentId/history` returns all transactions without limit/offset. For agents with many transactions, this will be slow.

- **[packages/vault/src/vault.ts:254-255] Hardcoded gas for non-broadcast EVM tx** — `gas: request.gasLimit ? BigInt(request.gasLimit) : 21000n` hardcodes gas to 21000 for simple transfers, but contract interactions need more. Should estimate gas if not provided.

- **[packages/api/src/middleware/tenant-cors.ts:58-60] CORS bypass for non-preflight requests** — When an origin is not in the allowlist, preflight (OPTIONS) returns 403 but actual requests proceed without CORS headers. The browser will block the response, but the server still processes the request, which wastes resources and could trigger side effects.

- **[packages/db/src/schema.ts] No index on `transactions.status`** — Queries in audit.ts and context.ts filter by `transactions.status` frequently (`in ('signed', 'broadcast', 'confirmed')`). Adding an index on `(agentId, status)` or `(agentId, createdAt, status)` would improve query performance.

- **[packages/db/src/schema.ts] No index on `transactions.createdAt`** — Audit queries and spend calculations filter heavily on `createdAt`. A composite index on `(agentId, createdAt)` would help.

- **[packages/api/src/routes/secrets.ts] All secret routes check `requireTenantLevel()` individually** — Instead of calling `requireTenantLevel(c)` in every single handler, add it as middleware for the entire route group: `secretsRoutes.use("*", (c, next) => { if (!requireTenantLevel(c)) return c.json(...); return next(); })`.

- **[packages/policy-engine/src/evaluators.ts:162] Time-window uses UTC only** — `evaluateTimeWindow` uses `getUTCHours()` and `getUTCDay()`. Tenants in different timezones can't configure business-hours policies in local time. Consider adding a `timezone` config field.

- **[packages/api/src/routes/auth.ts] Missing rate limit on `/auth/nonce`** — The nonce endpoint has no rate limiting, allowing an attacker to fill the in-memory nonce store. Each nonce is stored for 5 minutes, so a flood of requests could cause memory issues.

- **[packages/vault/src/vault.ts:21-28] Chain list in Vault doesn't include all chains from tokens.ts** — Vault's `CHAINS` map includes `bscTestnet` (97) but tokens.ts doesn't. Minor inconsistency but could cause confusion.

## Stubs / TODOs Found

- **[packages/auth/src/session.ts:87-94]** `invalidateSession()` — "TODO: persist token `jti` to a blocklist (Redis / DB) and check it in verifySession"

- **[packages/api/src/routes/platform.ts:245-246]** Default policies not persisted — "TODO: Once Worker 1 adds `defaultPolicies` to tenants schema, do: `await db.update(tenants).set({ defaultPolicies: body }).where(...)`"

- **[packages/auth/src/middleware.ts:29-31]** `dashboardAuthMiddleware()` — Returns 501 "Dashboard auth not implemented". This is dead code since `context.ts` defines its own `dashboardAuthMiddleware`.

- **[packages/api/src/routes/erc8004.ts:37]** Registry address hardcoded — `const registryAddress = "0x0000000000000000000000000000000000008004"` is a placeholder zero-ish address, not a deployed contract.

- **[packages/api/src/routes/erc8004.ts] Tables not in drizzle schema** — `agent_registrations`, `reputation_cache`, and `registry_index` are referenced in raw SQL but have no corresponding drizzle schema definitions or migrations. These tables likely don't exist in production databases.

- **[packages/api/src/routes/policies-standalone.ts:35-61] `policy_templates` table has no drizzle schema** — Used via raw SQL only. No migration will create this table automatically.

- **[packages/vault/src/vault.ts:67-68]** Chain RPC URLs are public endpoints — Comments note override with env, but no production RPC configuration is documented. Public RPCs have rate limits and reliability issues.

- **[packages/api/src/services/context.ts:100]** SIWE nonce store is in-memory — Won't work across multiple server instances. The comment pattern suggests Redis should be used but isn't implemented for this store.

- **[packages/api/src/routes/auth.ts:42-43]** Auth rate limit store is in-memory — Fallback when Redis is unavailable. Fine for single-instance but won't scale.

---

## Summary

**Critical issues:** 4 (SQL injection in policy templates, missing tenant isolation in ERC-8004 feedback, JWT secret divergence between modules, fixed salt in keystore)

**Key themes:**
1. **Code duplication** — JWT handling, Vault instantiation, `getTransactionStats`, and validation logic are duplicated across 3+ files. This creates drift risk and already has caused the JWT secret divergence bug.
2. **Missing drizzle schemas for raw-SQL tables** — ERC-8004 tables (`agent_registrations`, `reputation_cache`, `registry_index`) and `policy_templates` exist only in raw SQL. They have no migrations and likely don't exist in production.
3. **In-memory stores** — Nonce store, auth rate limit, tenant config cache, and request rate limiter are all in-memory Maps. Multi-instance deployments will have inconsistent state.
4. **Tenant isolation gaps** — Most routes properly scope to tenant, but ERC-8004 feedback, agent delete cascade queries, and the tenant creation endpoint accepting pre-computed hashes are gaps.
