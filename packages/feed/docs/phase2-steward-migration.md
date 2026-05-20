# Phase 2: Replace Privy with Steward — Full Migration Plan

> **Status**: Planning complete (LARP-assessed). Ready for implementation.
> **Repos involved**: [Babylon](https://github.com/BabylonSocial/babylon) · [Steward](https://github.com/Steward-Fi/steward) · [ElizaCloud](https://github.com/elizaOS/cloud)
> **Related PR**: [#1483](https://github.com/BabylonSocial/babylon/pull/1483) (Phase 1 — crypto removal, prerequisite)
> **Assessed**: April 2026. 10 bugs found and corrected below.

---

## Table of Contents

1. [Context & Why](#1-context--why)
2. [What Steward Is (and Is Not)](#2-what-steward-is-and-is-not)
3. [Honest Gap Analysis](#3-honest-gap-analysis)
4. [Architecture Overview](#4-architecture-overview)
5. [Repository Work Breakdown](#5-repository-work-breakdown)
   - [5a. Steward PR — Twitter/X OAuth](#5a-steward-pr--twitterx-oauth)
   - [5b. ElizaCloud PR — Steward Hosting Infrastructure](#5b-elizacloud-pr--steward-hosting-infrastructure)
   - [5c. Babylon PR — Full Privy Replacement](#5c-babylon-pr--full-privy-replacement)
6. [Detailed Step-by-Step: Babylon](#6-detailed-step-by-step-babylon)
7. [User Migration Strategy](#7-user-migration-strategy)
8. [New Environment Variables](#8-new-environment-variables)
9. [Full File Inventory](#9-full-file-inventory)
10. [Implementation Order](#10-implementation-order)
11. [Quality Gates](#11-quality-gates)
12. [Open Questions / Decisions](#12-open-questions--decisions)

---

## 1. Context & Why

Babylon currently uses [Privy](https://privy.io) for:
- User authentication (email, Twitter, Farcaster, Discord, Telegram)
- Farcaster mini-app auto-auth (`useLoginToMiniApp`)
- Telegram mini-app auth
- Social account linking (`useLinkAccount`)
- JWT issuance and server-side verification

**Why replace it:**
- Privy is a closed third-party SaaS. We want a self-hostable, open-source auth layer we control.
- Phase 1 already removed wallet-based auth and all crypto dependencies. Privy is now only used for identity — a much smaller surface to replace.
- Steward is built by a team we work alongside. We can contribute to it, shape its roadmap, and run it on ElizaCloud.

**Phase 1 prerequisite** (already merged via PR #1483): All EVM/Solana wallet auth, Agent0, Solana registry, SIWE, and embedded wallets removed. `privyId` is the only remaining Privy dependency on the backend. Frontend still calls `usePrivy()` in ~15 files.

**Steward is a sibling directory** (`../steward`, separate git repo). The `@stwd/sdk` package (v0.5.0, verified on npm) is installed via npm/bun. Steward itself is run as a Docker service in local dev (build from sibling source) and hosted on ElizaCloud in production.

---

## 2. What Steward Is (and Is Not)

Steward ([steward.fi](https://steward.fi)) is an **agent wallet infrastructure** system — encrypted wallets, policy enforcement, API proxy, spend tracking. It also ships a complete **auth module** (`packages/auth`) that can serve as a user identity provider:

- **Email magic links** — `POST /auth/email/send` + `/auth/email/verify`
- **Passkeys (WebAuthn)** — `POST /auth/passkey/register/*` + `/auth/passkey/login/*`
- **Google OAuth** — `GET /auth/oauth/google/authorize` + callback (VERIFIED: redirects to `redirect_uri?token=<jwt>&refreshToken=<rt>`)
- **Discord OAuth** — same pattern
- **JWT issuance** — HS256 (`STEWARD_JWT_SECRET` env var), 15-minute access tokens + 30-day refresh tokens
- **Token refresh** — `POST /auth/refresh` (rotation, one-time use)
- **Multi-tenant** — one Steward instance, multiple isolated tenants via `X-Steward-Tenant` header

**What Steward does NOT have (requires custom work on top):**
- Twitter/X OAuth — **requires Steward PR** (see §5a — has a specific bug with Twitter's no-email API that must be fixed)
- Farcaster login — use `@farcaster/auth-client` directly (already installed in Babylon)
- Farcaster mini-app auth — use `@farcaster/miniapp-sdk`'s `quickAuth.getToken()` (already installed, verified working)
- Telegram mini-app auth — use Telegram WebApp SDK + HMAC verification

**SDK**: `@stwd/sdk@0.5.0` is published on npm. Exports `StewardAuth` class for frontend use. Verified: exports match Steward source at v0.5.0.

---

## 3. Honest Gap Analysis

| Login Method | Privy | Steward | Gap / Solution |
|---|---|---|---|
| Email magic link | ✅ | ✅ | None |
| Passkeys (WebAuthn) | ✅ | ✅ | None |
| Google OAuth | ✅ | ✅ | None — redirect flow verified |
| Discord OAuth | ✅ | ✅ | None |
| Twitter/X | ✅ | ❌ | Add to Steward **with no-email fix** (Steward PR §5a) |
| Farcaster login | ✅ | ❌ | `@farcaster/auth-client` already installed; `createAppClient().verifySignInMessage()` |
| Farcaster mini-app | ✅ `useLoginToMiniApp` | ❌ | `sdk.quickAuth.getToken()` verified in installed `@farcaster/miniapp-sdk@0.2.3` |
| Telegram mini-app | ✅ | ❌ | Telegram WebApp SDK HMAC verify |
| JWT issuance | ✅ | ✅ | None |
| Token refresh | ✅ | ✅ | `POST /auth/refresh` (rotation) |
| `getAccessToken()` | ✅ Privy | ✅ | `stewardAuth.getToken()` |
| `useLinkAccount` | ✅ | ❌ | Per-provider OAuth redirects (same as login) |
| HTTP-only cookies | ✅ auto | ❌ localStorage | Cookie bridge: `POST /api/auth/session` sets `steward-token` httpOnly cookie |

---

## 4. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                      Babylon (Next.js)                            │
│                                                                    │
│  StewardAuthProvider (StewardAuth SDK v0.5.0 from npm)            │
│    ↓ getToken()  ↓ signInWithEmail()  ↓ signInWithPasskey()       │
│  useAuth hook  →  LoginModal  →  auth callbacks                   │
│                                                                    │
│  POST /api/auth/session  →  sets steward-token httpOnly cookie     │
│    (token received via POST body, NOT URL param — see §6 step 10) │
│                                                                    │
│  POST /api/auth/farcaster       → SIWF verify → provision user    │
│  POST /api/auth/farcaster-miniapp → quickAuth verify → same       │
│  POST /api/auth/telegram-miniapp  → HMAC verify → same            │
│                                                                    │
│  auth-middleware  →  jwtVerify(STEWARD_JWT_SECRET, issuer:'steward')│
│    WHERE stewardId = payload.userId    (Steward UUID)             │
│    OR email bridge → set stewardId                                │
│    OR social bridge (fid/telegramId) → set stewardId              │
└────────────────────────────┬─────────────────────────────────────┘
                             │ HTTP to port 3200
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Steward API (:3200)                              │
│                                                                    │
│  POST /auth/email/send      POST /auth/email/verify               │
│  POST /auth/passkey/login/* POST /auth/passkey/register/*         │
│  GET  /auth/oauth/google/*  GET  /auth/oauth/discord/*            │
│  GET  /auth/oauth/twitter/* (after Steward PR, with no-email fix) │
│  POST /auth/refresh         POST /auth/revoke                     │
│  GET  /auth/session                                               │
│  POST /platform/tenants     (platform admin — tenant provisioning) │
│                                                                    │
│  JWT env var: STEWARD_JWT_SECRET  (auth.ts reads this)            │
│  (separate from STEWARD_SESSION_SECRET used by user.ts routes)    │
│                                                                    │
│  HS256 JWT: { userId (UUID), tenantId:"babylon", email?, exp }    │
└────────────────────────────┬─────────────────────────────────────┘
                             │ Postgres (steward DB in Babylon's PG)
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Steward DB (separate 'steward' database in Babylon's Postgres)   │
│  users · authenticators · sessions · accounts · refresh_tokens   │
│  tenants · user_tenants                                           │
└──────────────────────────────────────────────────────────────────┘

Local dev:  Docker Compose, build from ../steward sibling directory
Production: ElizaCloud-hosted Steward instance
```

### JWT flow (verified against Steward source)

```
User: POST /auth/email/send { email }          → Steward sends magic link
User: clicks link → /auth/callback/email?token=...&email=...
Browser: POST /auth/email/verify { token, email, tenantId:"babylon" }
Steward: creates/finds user → mints JWT:
  { userId: "uuid", tenantId: "babylon", email: "...", iss: "steward", exp: now+900 }
Browser: POST /api/auth/session { token, refreshToken }   ← body, NOT URL param
Babylon API route: jwtVerify(token, STEWARD_JWT_SECRET) → sets steward-token httpOnly cookie
All subsequent requests: cookie → auth-middleware → WHERE stewardId = payload.userId
```

---

## 5. Repository Work Breakdown

### 5a. Steward PR — Twitter/X OAuth

**Verified**: `packages/auth/src/oauth.ts` exists and supports exactly the extension pattern needed. `BUILT_IN_PROVIDERS` tuple, `getProviderConfig()` switch, `getEnabledProviders()` list.

**CRITICAL BUG to fix first**: Twitter's v2 API (`/2/users/me`) does NOT return email. Even requesting the `email` scope requires special app-level approval from Twitter and Twitter's API returns it in a non-standard field. Steward's `provisionOAuthUser()` calls `findOrCreateUser(email)` which will receive `""` and fail or create a user with blank email. This makes the plan's Twitter support non-functional without this fix.

**Fix**: Steward's `provisionOAuthUser()` and `OAuthClient.getUserInfo()` must handle the no-email case. Two parts:

**Part 1** — `packages/auth/src/oauth.ts`: Add Twitter config:
```ts
case "twitter": {
  const clientId = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Twitter OAuth not configured: TWITTER_CLIENT_ID and TWITTER_CLIENT_SECRET are required");
  }
  return {
    clientId, clientSecret,
    authorizationUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    userInfoUrl: "https://api.twitter.com/2/users/me?user.fields=id,name,username,profile_image_url",
    scopes: ["tweet.read", "users.read", "offline.access"],
  };
}
```

Twitter also requires PKCE (`code_challenge_method=S256`). Add PKCE support to `OAuthClient.generateAuthUrl()`:
- Generate `code_verifier` (random 43-128 char string)
- Compute `code_challenge = base64url(sha256(code_verifier))`
- Include `code_challenge_method=S256&code_challenge=<challenge>` in the auth URL
- Store `code_verifier` in the challenge store alongside the CSRF state
- Include `code_verifier` in `exchangeCode()` body for Twitter

**Part 2** — `packages/api/src/routes/auth.ts` `provisionOAuthUser()`: Change the email requirement from hard-fail to a fallback using Twitter's account ID as a synthetic email:

```ts
// Twitter (and potentially other providers) may not return an email.
// Fall back to a deterministic synthetic email using provider + account ID.
// This is never displayed or sent — it's an internal identity key.
const email = providerUser.email
  ? providerUser.email.toLowerCase().trim()
  : `${providerName}.${providerUser.id}@id.steward.internal`;
```

This allows `findOrCreateUser(email)` to work. On the Babylon side, when we see `@id.steward.internal` in the email claim, we know it's a Twitter account without a real email and match by `accounts.provider + accounts.providerAccountId` instead.

**Part 3** — `getUserInfo()` normalization for Twitter:
Twitter's `/2/users/me` returns `{ data: { id, name, username, profile_image_url } }` not a flat object. The `getUserInfo()` method in `OAuthClient` needs a provider-specific data normalization:
```ts
// After: const data = await res.json()
// Twitter returns { data: { id, name, username } } not flat
const flat = (data as Record<string, unknown>).data
  ? (data as { data: Record<string, unknown> }).data
  : data as Record<string, unknown>;
return {
  id: String(flat["id"] ?? ""),
  email: String(flat["email"] ?? ""),
  name: flat["name"] != null ? String(flat["name"]) : flat["username"] != null ? String(flat["username"]) : undefined,
  // ...
};
```

**Env vars added to Steward `.env.example`**:
```env
TWITTER_CLIENT_ID=
TWITTER_CLIENT_SECRET=
```

**PR target**: `Steward-Fi/steward` → `develop` branch.

---

### 5b. ElizaCloud PR — Steward Hosting Infrastructure

ElizaCloud already has `packages/lib/services/steward-client.ts`. This PR adds:

1. **`docker-compose.yml`**: Add `steward` service (build from pinned release or local source)
2. **New route**: `app/api/v1/steward/tenants/route.ts` — POST creates a Steward tenant for a customer organization via `X-Steward-Platform-Key`
3. **DB**: Add `stewardTenantId` + `stewardTenantApiKey` columns to `organizations` table
4. **`.env.example`**: Add `STEWARD_API_URL`, `STEWARD_PLATFORM_KEYS`, `STEWARD_MASTER_PASSWORD`, `STEWARD_JWT_SECRET`, `STEWARD_SESSION_SECRET`
5. **Docs**: `docs/steward-integration.md`

**PR target**: `elizaOS/cloud` → `dev` branch.

---

### 5c. Babylon PR — Full Privy Replacement

See §6 for step-by-step.

**Branch**: `feat/steward-auth-phase2` → `staging`.

---

## 6. Detailed Step-by-Step: Babylon

### Step 1 — Docker Compose: Add Steward service

Steward runs as a sibling directory (`../steward`). Docker allows relative build contexts outside the project directory as long as the `docker-compose.yml` is explicit:

```yaml
  steward:
    build:
      context: ../steward          # sibling directory — verified Docker supports this
      dockerfile: Dockerfile
    container_name: babylon-steward
    restart: unless-stopped
    ports:
      - "3200:3200"
    environment:
      PORT: 3200
      NODE_ENV: development
      STEWARD_MASTER_PASSWORD: ${STEWARD_MASTER_PASSWORD}
      STEWARD_JWT_SECRET: ${STEWARD_JWT_SECRET}
      STEWARD_SESSION_SECRET: ${STEWARD_JWT_SECRET}   # same value; Steward uses both var names
      DATABASE_URL: "postgresql://babylon:babylon_dev_password@postgres:5432/steward"
      STEWARD_PLATFORM_KEYS: ${STEWARD_PLATFORM_KEYS}
      RESEND_API_KEY: ${RESEND_API_KEY:-}
      EMAIL_FROM: ${EMAIL_FROM:-login@babylon.social}
      APP_URL: ${NEXT_PUBLIC_APP_URL:-http://localhost:3000}
      PASSKEY_RP_NAME: Babylon
      PASSKEY_RP_ID: localhost
      PASSKEY_ORIGIN: ${NEXT_PUBLIC_APP_URL:-http://localhost:3000}
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:-}
      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:-}
      DISCORD_CLIENT_ID: ${DISCORD_CLIENT_ID:-}
      DISCORD_CLIENT_SECRET: ${DISCORD_CLIENT_SECRET:-}
      TWITTER_CLIENT_ID: ${TWITTER_CLIENT_ID:-}
      TWITTER_CLIENT_SECRET: ${TWITTER_CLIENT_SECRET:-}
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:3200/health || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 8
      start_period: 45s
```

**Note on env var naming**: Steward's `auth.ts` reads `STEWARD_JWT_SECRET`; `user.ts` reads `STEWARD_SESSION_SECRET`. Both must be set. In docker-compose, set both to the same value.

Create the `steward` Postgres database on first boot via an init script at `scripts/docker/init-steward-db.sh`:

```bash
#!/bin/bash
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  SELECT 'CREATE DATABASE steward'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'steward')\gexec
  GRANT ALL PRIVILEGES ON DATABASE steward TO $POSTGRES_USER;
EOSQL
```

Mount it in the `postgres` service:
```yaml
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./scripts/docker/init-steward-db.sh:/docker-entrypoint-initdb.d/20-steward.sh
```

Steward runs `runMigrations()` automatically on startup. No manual step.

---

### Step 2 — Update `scripts/pre-dev/pre-dev-local.ts`

Add Steward health check after existing services:

```ts
const STEWARD_CONTAINER = 'babylon-steward';
const stewardRunning = await $`docker ps --filter name=${STEWARD_CONTAINER} --format "{{.Names}}"`.quiet().text();
if (stewardRunning.trim() !== STEWARD_CONTAINER) {
  console.info('[Script] Starting Steward auth service...');
  await dockerComposeUp('steward' as DockerService).catch(() => {
    console.warn('[Script] ⚠️  Steward start failed — auth will not work');
  });
}
let stewardReady = false;
for (let i = 0; i < 30; i++) {
  const ok = await fetch('http://localhost:3200/health').then(r => r.ok).catch(() => false);
  if (ok) { stewardReady = true; break; }
  await new Promise(r => setTimeout(r, 2000));
}
console.info(stewardReady
  ? '[Script] ✅ Steward is ready at http://localhost:3200'
  : '[Script] ⚠️  Steward did not become healthy within 60s');
```

Add to status printout: `  Steward:    http://localhost:3200`

---

### Step 3 — Tenant provisioning script (`scripts/steward-init.ts`)

**VERIFIED**: `POST /platform/tenants` exists in Steward and requires `X-Steward-Platform-Key` header. Returns `{ ok: true, apiKey: "stw_...", tenant: { id } }` on creation, 409 on conflict.

```ts
#!/usr/bin/env bun
/**
 * One-time idempotent script to provision the "babylon" tenant in Steward.
 * Run: bun run scripts/steward-init.ts
 * Copy the output STEWARD_TENANT_ID and STEWARD_TENANT_API_KEY into .env
 */
const STEWARD_API_URL = process.env.STEWARD_API_URL ?? 'http://localhost:3200';
const PLATFORM_KEY = (process.env.STEWARD_PLATFORM_KEYS ?? '').split(',')[0].trim();
if (!PLATFORM_KEY) { console.error('❌ STEWARD_PLATFORM_KEYS is required'); process.exit(1); }

const res = await fetch(`${STEWARD_API_URL}/platform/tenants`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Steward-Platform-Key': PLATFORM_KEY,
  },
  body: JSON.stringify({ id: 'babylon', name: 'Babylon Social' }),
});
const data = await res.json() as { ok: boolean; apiKey?: string; error?: string };

if (res.status === 409) {
  console.info('ℹ️  Tenant "babylon" already exists. API key is not re-returned. Check existing .env.');
} else if (!res.ok) {
  console.error('❌ Failed:', data.error); process.exit(1);
} else {
  console.info('✅ Babylon tenant created. Add to .env:\n');
  console.info(`STEWARD_TENANT_ID=babylon`);
  console.info(`STEWARD_TENANT_API_KEY=${data.apiKey}`);
}
```

Add to root `package.json`: `"steward:init": "bun run scripts/steward-init.ts"`

---

### Step 4 — Add Steward PR: user provisioning endpoint

**VERIFIED**: Steward has NO admin endpoint to create users without sending emails. This blocks the migration strategy. We must add one.

**Steward PR addition** — `packages/api/src/routes/platform.ts`, new route:

```ts
/**
 * POST /platform/users
 * Provision a user record in Steward without sending email.
 * Intended for migration use: pre-seeding users from another auth provider.
 *
 * Body: { email: string; emailVerified?: boolean; name?: string }
 * Returns: { ok: true; userId: string; isNew: boolean }
 */
platform.post("/users", async (c) => {
  const body = await safeJsonParse<{ email: string; emailVerified?: boolean; name?: string }>(c);
  if (!body?.email) {
    return c.json<ApiResponse>({ ok: false, error: "email is required" }, 400);
  }
  const db = getDb();
  const email = body.email.toLowerCase().trim();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    return c.json({ ok: true, userId: existing.id, isNew: false });
  }
  const [newUser] = await db
    .insert(users)
    .values({ email, emailVerified: body.emailVerified ?? false, name: body.name ?? null })
    .returning({ id: users.id });
  return c.json({ ok: true, userId: newUser.id, isNew: true });
});
```

This is part of the Steward PR. Without it, the migration script can't pre-seed users safely in production.

---

### Step 5 — DB migration: add `stewardId` to Babylon users

In `packages/db/src/schema/users.ts`:

```ts
stewardId: text('stewardId').unique(),
```

Generate and apply:
```bash
bun run db:generate
bun run db:migrate
```

`privyId` stays nullable — coexists with `stewardId` until Phase 3 drops it.

---

### Step 6 — User migration script (`scripts/migrate-privy-to-steward.ts`)

**CORRECTED**: The original plan said "direct Postgres INSERT into Steward's users table". This is impossible in production (ElizaCloud-hosted Steward). The script now calls Steward's new `/platform/users` admin endpoint instead.

```ts
#!/usr/bin/env bun
/**
 * Migrate all Privy users to Steward.
 *
 * Phase A: Export from Privy Admin API
 * Phase B: Pre-seed each user in Steward via POST /platform/users
 * Phase C: Build manifest of email-less users (social-only accounts)
 * Phase D: Report (no DB writes to Babylon — those happen at runtime via bridge)
 *
 * Usage:
 *   bun run scripts/migrate-privy-to-steward.ts --dry-run    # report only
 *   bun run scripts/migrate-privy-to-steward.ts              # actually migrate
 */
import { writeFileSync } from 'fs';

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? '';
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET ?? '';
const STEWARD_API_URL = process.env.STEWARD_API_URL ?? 'http://localhost:3200';
const PLATFORM_KEY = (process.env.STEWARD_PLATFORM_KEYS ?? '').split(',')[0].trim();
const DRY_RUN = process.argv.includes('--dry-run');

if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
  console.error('❌ NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET required (read Privy dashboard)');
  process.exit(1);
}
if (!PLATFORM_KEY) {
  console.error('❌ STEWARD_PLATFORM_KEYS required');
  process.exit(1);
}

const basicAuth = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString('base64');

// Phase A: paginate all Privy users
// Privy Admin API: GET https://auth.privy.io/api/v1/users
// Auth: Basic base64(appId:appSecret) + privy-app-id header
// Returns: { data: User[], next_cursor?: string }
const allUsers: Array<{
  id: string; // did:privy:xxx
  email?: { address: string };
  farcaster?: { fid: number; username: string };
  twitter?: { username: string };
  telegram?: { telegram_user_id: string; username: string };
}> = [];

let cursor: string | undefined;
do {
  const url = new URL('https://auth.privy.io/api/v1/users');
  url.searchParams.set('limit', '500');
  if (cursor) url.searchParams.set('cursor', cursor);

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'privy-app-id': PRIVY_APP_ID,
    },
  });
  if (!res.ok) { console.error(`Privy API error: ${res.status} ${await res.text()}`); process.exit(1); }

  const body = await res.json() as { data: typeof allUsers; next_cursor?: string };
  allUsers.push(...body.data);
  cursor = body.next_cursor;
  console.info(`Fetched ${allUsers.length} users so far...`);
} while (cursor);

console.info(`✅ Exported ${allUsers.length} Privy users`);

const withEmail = allUsers.filter(u => u.email?.address);
const withoutEmail = allUsers.filter(u => !u.email?.address);

console.info(`  With email: ${withEmail.length}`);
console.info(`  Without email (social-only): ${withoutEmail.length}`);

// Phase B: pre-seed users in Steward
let seeded = 0, existed = 0, failed = 0;
for (const user of withEmail) {
  const email = user.email!.address;
  if (DRY_RUN) { seeded++; continue; }

  const res = await fetch(`${STEWARD_API_URL}/platform/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Steward-Platform-Key': PLATFORM_KEY,
    },
    body: JSON.stringify({ email, emailVerified: true }),
  });
  const data = await res.json() as { ok: boolean; isNew?: boolean };
  if (!data.ok) { failed++; console.warn(`Failed: ${email}`); }
  else if (data.isNew) seeded++;
  else existed++;
}

console.info(`\n✅ Steward seeding: ${seeded} created, ${existed} already existed, ${failed} failed`);

// Phase C: write manifest of email-less users
const emaillessManifest = withoutEmail.map(u => ({
  privyId: u.id,
  farcasterFid: u.farcaster?.fid ?? null,
  farcasterUsername: u.farcaster?.username ?? null,
  twitterUsername: u.twitter?.username ?? null,
  telegramId: u.telegram?.telegram_user_id ?? null,
  telegramUsername: u.telegram?.username ?? null,
}));
writeFileSync('migrations/privy-emailless-users.json', JSON.stringify(emaillessManifest, null, 2));
console.info(`📄 Wrote ${emaillessManifest.length} email-less users to migrations/privy-emailless-users.json`);
console.info('   These users will be auto-linked at login time via social profile matching.');
```

---

### Step 7 — Rewrite `packages/api/src/auth-middleware.ts`

Replace `PrivyClient.verifyAuthToken()` with `jwtVerify` from `jose`.

**Verified**: Steward's auth.ts uses `STEWARD_JWT_SECRET` env var and `issuer: "steward"` with HS256. Our middleware verification must match exactly.

```ts
import { jwtVerify } from 'jose';

const STEWARD_JWT_SECRET = new TextEncoder().encode(
  process.env.STEWARD_JWT_SECRET ?? ''
);

// In authenticate():
// Cookie takes priority over Authorization header (same pattern as Privy cookie)
const cookieToken = request.cookies.get('steward-token')?.value;
const authHeaderToken = request.headers.get('authorization')?.startsWith('Bearer ')
  ? request.headers.get('authorization')!.slice(7)
  : undefined;
const token = cookieToken ?? authHeaderToken;

if (!token) throw new AuthenticationError('Missing authentication');

const { payload } = await jwtVerify(token, STEWARD_JWT_SECRET, {
  issuer: 'steward',
  algorithms: ['HS256'],
});
// payload: { userId: string, tenantId: string, email?: string, address?: string }
```

**User lookup chain** (replaces `WHERE privyId = claims.userId`):

```ts
// 1. Fast path: already linked
let dbUser = await db.select().from(users)
  .where(eq(users.stewardId, payload.userId as string))
  .limit(1).then(r => r[0]);

// 2. Email bridge: existing Privy user logs in via Steward for first time
if (!dbUser && payload.email && !String(payload.email).includes('@id.steward.internal')) {
  const emailUser = await db.select().from(users)
    .where(and(eq(users.email, payload.email as string), isNull(users.stewardId)))
    .limit(1).then(r => r[0]);
  if (emailUser) {
    await db.update(users).set({ stewardId: payload.userId as string })
      .where(eq(users.id, emailUser.id));
    dbUser = { ...emailUser, stewardId: payload.userId as string };
  }
}

// 3. New user: first time we've seen this Steward userId
if (!dbUser) {
  dbUser = await ensureUserFromSteward(
    payload.userId as string,
    payload.email && !String(payload.email).includes('@id.steward.internal')
      ? payload.email as string : undefined,
  );
}
```

**Dev bypass paths**: Update test DID format:
- Old: `did:privy:test-${userId}` (format from Phase 1)
- New: `steward:test:${userId}`

Update all integration test fixtures. The `extractDevUserIdFromBearerToken` function in `dev-credentials.ts` needs updating to match the new prefix.

**CORRECTED from plan**: Remove `PRIVY_AUTH_FALLBACK` flag. It was a placeholder with no implementation. Instead, during cutover, the `auth-middleware` simply tries Steward JWT first. If it fails (wrong issuer or wrong secret), it falls through to an error. Users with old Privy sessions will see a login prompt, which is expected behavior. No parallel dual-auth system is needed — the cookie name changed (`privy-token` → `steward-token`), so old Privy sessions naturally expire within their TTL (typically 24 hours for Privy JWTs) and users re-authenticate.

---

### Step 8 — Update `packages/api/src/users/ensure-user.ts`

Add `ensureUserFromSteward()`:

```ts
export async function ensureUserFromSteward(
  stewardUserId: string,
  email?: string,
): Promise<CanonicalUser> {
  const [user] = await db.insert(users)
    .values({
      stewardId: stewardUserId,
      email: email ?? null,
    })
    .onConflictDoUpdate({
      target: users.stewardId,
      set: { email: email ?? sql`excluded.email` },
    })
    .returning(canonicalUserSelect);
  return user;
}
```

Update `findUserByIdentifier()` in `user-lookup.ts`: add `'stewardId'` alongside existing `'id'`, `'privyId'`, `'username'` kinds. The `resolveUserIdentifierKind()` function in `packages/shared` needs updating to detect Steward UUIDs (standard UUID v4 format) as the `'stewardId'` kind. Add a separate UUID regex path: if identifier matches `/^[0-9a-f-]{36}$/` and is not a known Babylon ID, try `stewardId` lookup.

---

### Step 9 — Cookie bridge API routes

**`apps/web/src/app/api/auth/session/route.ts`** (new):

```ts
// POST: validates Steward JWT, sets httpOnly steward-token cookie
// DELETE: clears the cookie

export async function POST(req: NextRequest) {
  const { token, refreshToken } = await req.json() as { token: string; refreshToken?: string };

  // Verify locally before storing — reject tampered tokens immediately
  const STEWARD_JWT_SECRET = new TextEncoder().encode(process.env.STEWARD_JWT_SECRET ?? '');
  const { payload } = await jwtVerify(token, STEWARD_JWT_SECRET, {
    issuer: 'steward',
    algorithms: ['HS256'],
  }).catch(() => { throw new Error('Invalid token'); });

  const response = NextResponse.json({ ok: true, userId: payload.userId });
  response.cookies.set('steward-token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30, // 30d (refresh token lifetime)
    path: '/',
  });
  // Refresh token stored in a separate httpOnly cookie
  if (refreshToken) {
    response.cookies.set('steward-refresh', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
    });
  }
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete('steward-token');
  response.cookies.delete('steward-refresh');
  return response;
}
```

---

### Step 10 — Auth callback pages

**`apps/web/src/app/auth/callback/email/page.tsx`** (new):

```tsx
'use client';
import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { StewardAuth } from '@stwd/sdk';

export default function EmailCallbackPage() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const token = params.get('token');
    const email = params.get('email');
    const returnTo = params.get('returnTo') ?? '/feed';
    if (!token || !email) { router.replace('/'); return; }

    const auth = new StewardAuth({ baseUrl: process.env.NEXT_PUBLIC_STEWARD_API_URL! });
    auth.verifyEmailCallback(token, email).then(async (result) => {
      // Send token via POST body — NOT URL params — to avoid browser history / server log exposure
      await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: result.token, refreshToken: result.refreshToken }),
      });
      router.replace(returnTo);
    }).catch(() => router.replace('/?error=auth_failed'));
  }, []);

  return <div>Completing sign in…</div>;
}
```

**`apps/web/src/app/auth/callback/[provider]/page.tsx`** (new, for Google/Discord/Twitter):

**CORRECTED security issue from plan**: The Steward OAuth callback delivers the JWT as a URL query param (`?token=<jwt>`). This exposes the token in browser history, server access logs, and Referer headers. Fix: immediately read and then replace the URL:

```tsx
'use client';
import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function OAuthCallbackPage() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const token = params.get('token');
    const refreshToken = params.get('refreshToken');
    const returnTo = params.get('returnTo') ?? '/feed';

    // SECURITY: Replace URL immediately to remove token from browser history
    // before any async work that could be interrupted
    window.history.replaceState(null, '', window.location.pathname);

    if (!token) { router.replace('/'); return; }

    fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, refreshToken }),
    }).then(() => router.replace(returnTo))
      .catch(() => router.replace('/?error=auth_failed'));
  }, []);

  return <div>Completing sign in…</div>;
}
```

**OAuth App setup**: The OAuth providers (Google, Discord, Twitter) must whitelist the Steward API's callback URL, NOT Babylon's:
- **Google**: Authorized redirect URI → `http://localhost:3200/auth/oauth/google/callback` (dev), `https://<steward-prod-url>/auth/oauth/google/callback` (prod)
- **Discord**: Same pattern
- **Twitter**: Same pattern

Babylon's `/auth/callback/[provider]` page receives the already-processed JWT from Steward, not the OAuth code. This is a two-hop redirect: Provider → Steward callback → Babylon callback.

---

### Step 11 — Frontend: `StewardAuthProvider.tsx`

New file: `apps/web/src/components/providers/StewardAuthProvider.tsx`

```tsx
'use client';

import { StewardAuth, type StewardSession } from '@stwd/sdk';
import { createContext, useContext, useEffect, useState } from 'react';

const STEWARD_API_URL = process.env.NEXT_PUBLIC_STEWARD_API_URL!;

// Module-level singleton — one StewardAuth instance for the lifetime of the browser tab
// This is safe because StewardAuth stores state in localStorage and notifies via callbacks
const _stewardAuth = new StewardAuth({ baseUrl: STEWARD_API_URL });

export interface StewardAuthContextValue {
  auth: StewardAuth;
  session: StewardSession | null;
  isLoading: boolean;
}

const StewardAuthContext = createContext<StewardAuthContextValue | null>(null);

export function StewardAuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<StewardSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setSession(_stewardAuth.getSession());
    setIsLoading(false);
    return _stewardAuth.onSessionChange(setSession);
  }, []);

  return (
    <StewardAuthContext.Provider value={{ auth: _stewardAuth, session, isLoading }}>
      {children}
    </StewardAuthContext.Provider>
  );
}

export function useStewardAuth(): StewardAuthContextValue {
  const ctx = useContext(StewardAuthContext);
  if (!ctx) throw new Error('useStewardAuth must be used within StewardAuthProvider');
  return ctx;
}
```

---

### Step 12 — Update `apps/web/src/components/providers/Providers.tsx`

Remove `PrivyProvider`, `ThemedPrivyProvider`, `PrivyProviderWrapper` and all Privy config imports. Add `StewardAuthProvider` in their place.

---

### Step 13 — Rewrite `apps/web/src/hooks/useAuth.ts`

Public API surface stays identical. Internal implementation changes:

| Old (Privy) | New (Steward) |
|---|---|
| `const { authenticated } = usePrivy()` | `!!session` from `useStewardAuth()` |
| `getAccessToken()` | reads `steward-token` httpOnly cookie via `GET /api/auth/token`, or `stewardAuth.getToken()` in client context |
| `login()` | sets `isLoginModalOpen = true` (new modal state) |
| `logout()` | `stewardAuth.revokeSession()` + `DELETE /api/auth/session` |
| `user.id` (DID `did:privy:xxx`) | `session.userId` (Steward UUID) |
| `user.email` | `session.email` |

`getAccessToken()` implementation detail: When called server-side (SSR), it reads the `steward-token` cookie from the request. When called client-side, it returns `stewardAuth.getToken()`. The SDK auto-refreshes when near expiry (120-second threshold built in).

---

### Step 14 — Login modal (`apps/web/src/components/auth/LoginModal.tsx`)

New component. Opens when `useAuth().login()` is called.

**Verified packages**: `@farcaster/auth-kit@0.8.2` is already in `apps/web/package.json` (v0.8.1 specified). Peer deps are only `react >= 17` — no wagmi/viem conflict. `@farcaster/auth-client@0.7.1` is also already installed.

**Button implementations:**

- **Passkey**: `stewardAuth.signInWithPasskey(email)` → on success: `POST /api/auth/session { token, refreshToken }` → close modal
- **Magic link**: `stewardAuth.signInWithEmail(email)` → shows "Check inbox" state. Callback page handles the rest.
- **Google**: redirect to `${STEWARD_API_URL}/auth/oauth/google/authorize?redirect_uri=${APP_URL}/auth/callback/google&tenant_id=babylon`
- **Discord**: same pattern
- **Twitter**: same pattern (requires Steward PR to be merged first)
- **Farcaster**: `<SignInButton>` from `@farcaster/auth-kit`; on success, data goes to `POST /api/auth/farcaster`

---

### Step 15 — Farcaster regular login

**`apps/web/src/app/api/auth/farcaster/route.ts`** (new):

```ts
import { createAppClient, viemConnector } from '@farcaster/auth-client';

export async function POST(req: NextRequest) {
  const { message, signature, nonce } = await req.json();

  // Server-side verification using @farcaster/auth-client (already installed)
  const appClient = createAppClient({
    relay: 'https://relay.farcaster.xyz',
    ethereum: viemConnector(),
  });

  const { data, success, fid } = await appClient.verifySignInMessage({
    message,
    signature,
    nonce,
    domain: new URL(process.env.NEXT_PUBLIC_APP_URL!).hostname,
  });

  if (!success) return NextResponse.json({ ok: false, error: 'Invalid Farcaster signature' }, { status: 401 });

  // Look up existing Babylon user by FID, then stewardId, then create
  // Use ensureUserFromFarcaster() — create if needed, mint JWT
  const { token, refreshToken } = await mintSessionForFarcasterUser(fid, data);
  return NextResponse.json({ ok: true, token, refreshToken });
}
```

`mintSessionForFarcasterUser()`: finds or creates Babylon user by FID (social profile table), then creates a Steward user via `POST /platform/users` if one doesn't exist, gets back the `stewardId`, mints a JWT using `jose` `SignJWT` with `STEWARD_JWT_SECRET` in the same format Steward uses:

```ts
const token = await new SignJWT({ userId: stewardUserId, tenantId: 'babylon', fid })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuer('steward')
  .setIssuedAt()
  .setExpirationTime('15m')
  .sign(new TextEncoder().encode(process.env.STEWARD_JWT_SECRET!));
```

**CORRECTED from original plan**: The original said "Babylon mints a JWT" without ensuring the `userId` exists in Steward's `users` table. Fixed: we call `POST /platform/users` first to ensure the Steward user record exists, THEN use the returned `userId` as the JWT's `userId` claim. This ensures `WHERE stewardId = payload.userId` succeeds in auth-middleware.

---

### Step 16 — Farcaster mini-app auth

**VERIFIED**: `quickAuth.getToken()` exists in `@farcaster/miniapp-sdk@0.2.3` (installed). It internally calls `miniAppHost.signIn()` which is the same as the current flow that calls `sdk.actions.signIn()`. The `quickAuth.getToken()` is the correct abstraction.

**VERIFIED**: `quickAuth.getToken()` returns `{ token: string }` where the JWT payload has `{ sub: fid (number), address, iss, aud, exp, iat }`.

**`apps/web/src/components/providers/FarcasterMiniAppProvider.tsx`**:

Replace:
```ts
import { usePrivy } from '@privy-io/react-auth';
import { useLoginToMiniApp } from '@privy-io/react-auth/farcaster';
// ...
const { initLoginToMiniApp, loginToMiniApp } = useLoginToMiniApp();
const { nonce } = await initLoginToMiniApp();
const result = await sdk.actions.signIn({ nonce });
await loginToMiniApp({ message, signature });
```

With:
```ts
import { sdk } from '@farcaster/miniapp-sdk';
// ...
const { token } = await sdk.quickAuth.getToken();
const res = await fetch('/api/auth/farcaster-miniapp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token }),
});
const { sessionToken, refreshToken } = await res.json();
await fetch('/api/auth/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: sessionToken, refreshToken }),
});
```

Also remove the `createWallet` useEffect entirely (embedded wallets removed in Phase 1).

**`apps/web/src/app/api/auth/farcaster-miniapp/route.ts`** (new):

```ts
import { createClient } from '@farcaster/quick-auth';

export async function POST(req: NextRequest) {
  const { token } = await req.json();

  // VERIFIED: createClient() has verifyJwt() method that fetches JWKS from
  // https://auth.farcaster.xyz — requires network access (not a local verify).
  // This is acceptable for a server-side API route.
  const quickAuthClient = createClient(); // from @farcaster/quick-auth (already installed)
  const payload = await quickAuthClient.verifyJwt({
    token,
    domain: new URL(process.env.NEXT_PUBLIC_APP_URL!).hostname,
  });
  // payload.sub = FID (number), payload.address = custody address

  const fid = payload.sub; // number
  const { sessionToken, refreshToken } = await mintSessionForFarcasterUser(fid, {});
  return NextResponse.json({ ok: true, sessionToken, refreshToken });
}
```

**CLARIFIED**: `verifyJwt` makes a network call to `https://auth.farcaster.xyz` to fetch the JWKS public key. This is a ~50-100ms network request on the server side, acceptable. The original plan didn't mention this — it's now documented.

**CLARIFIED**: The `domain` parameter in `verifyJwt` must match the Farcaster app's registered domain. In dev: `localhost`. In prod: `babylon.social` (or whatever). Use `new URL(process.env.NEXT_PUBLIC_APP_URL!).hostname` to derive it.

---

### Step 17 — Telegram mini-app auth

**`apps/web/src/components/providers/TelegramMiniAppProvider.tsx`**:

Replace Privy Telegram auth with:
```ts
const initData = window.Telegram?.WebApp?.initData;
if (initData) {
  const res = await fetch('/api/auth/telegram-miniapp', {
    method: 'POST',
    body: JSON.stringify({ initData }),
  });
  const { token, refreshToken } = await res.json();
  await fetch('/api/auth/session', {
    method: 'POST',
    body: JSON.stringify({ token, refreshToken }),
  });
}
```

**`apps/web/src/app/api/auth/telegram-miniapp/route.ts`** (new):

```ts
import crypto from 'node:crypto';

export async function POST(req: NextRequest) {
  const { initData } = await req.json();

  // Standard Telegram WebApp initData HMAC-SHA256 verification
  // https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) return NextResponse.json({ ok: false, error: 'Telegram not configured' }, { status: 503 });

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) {
    return NextResponse.json({ ok: false, error: 'Invalid Telegram initData' }, { status: 401 });
  }

  const user = JSON.parse(params.get('user') ?? '{}') as { id: number; username?: string };
  const { token, refreshToken } = await mintSessionForTelegramUser(user.id, user.username);
  return NextResponse.json({ ok: true, token, refreshToken });
}
```

`mintSessionForTelegramUser()`: same pattern as Farcaster — find/create Babylon user by Telegram ID, ensure Steward user exists via `POST /platform/users`, mint JWT.

---

### Step 18 — Social account linking

**`apps/web/src/components/profile/LinkSocialAccountsModal.tsx`**:

Remove `useLinkAccount` from `@privy-io/react-auth`. Replace per platform:

- **Google/Discord/Twitter**: Redirect to Steward OAuth with extra `mode=link&babylonUserId=${userId}` query params (Steward stores these in state; after OAuth completes, Babylon callback calls `POST /api/users/[userId]/link-social`)
- **Farcaster**: `<SignInButton>` from `@farcaster/auth-kit` in link mode; on success POST to `/api/auth/farcaster` → `/api/users/[userId]/link-social`
- **Telegram**: Telegram Login Widget (script embed) with callback → `/api/auth/telegram-miniapp` → `/api/users/[userId]/link-social`

The existing `POST /api/users/[userId]/link-social` route already supports non-wallet platforms. No changes needed to the route itself.

---

### Step 19 — Mechanical sweep: `getAccessToken` callers (9 files)

All these files do `const { getAccessToken } = usePrivy()`. Change to `useAuth()`:

1. `apps/web/src/hooks/useSSE.ts`
2. `apps/web/src/hooks/useChatMessages.ts`
3. `apps/web/src/hooks/useTeamChat.ts`
4. `apps/web/src/hooks/useToggleReaction.ts`
5. `apps/web/src/hooks/useQueuedOutcomes.ts`
6. `apps/web/src/components/points/BuyPointsModal.tsx`
7. `apps/web/src/components/chats/NftVerificationBanner.tsx`
8. `apps/web/src/components/settings/SecurityTab.tsx`
9. `apps/web/src/components/providers/OnboardingProvider.tsx` (also uses `const { user: privyUser } = usePrivy()` — replace with Babylon user from `useAuth()`)

---

### Step 20 — Remove Privy packages, update deps

**CORRECTED**: `@farcaster/auth-kit` and `@farcaster/auth-client` are already installed in `apps/web/package.json`. Do NOT re-add them. `@stwd/sdk` is new.

```bash
# Remove
bun remove @privy-io/react-auth @privy-io/server-auth @privy-io/node

# Add (only what's actually missing)
bun add @stwd/sdk @simplewebauthn/browser
# Note: @simplewebauthn/browser is a peer dep of StewardAuth passkey flow — not auto-installed
```

**Delete:**
- `packages/shared/src/auth/privy-config.ts`
- `packages/api/src/services/privy/privy-node.ts`
- `packages/api/src/services/privy/authed-user.ts` (if remaining)

---

## 7. User Migration Strategy

### The Real Constraints (Corrected)

**What does NOT work:**
- Direct Postgres INSERT into Steward's DB (impossible for prod ElizaCloud-hosted instance)
- Sending magic link emails to all users during migration (spammy, unreliable)

**What DOES work (the corrected strategy):**

**Layer 1 — Pre-seeding via Steward admin API** (requires new Steward PR endpoint `POST /platform/users`)

Run `scripts/migrate-privy-to-steward.ts` against production AFTER the Steward PR is deployed:
- For each Privy user WITH email: call `POST /platform/users { email, emailVerified: true }` — creates Steward user record, returns UUID
- For each Privy user WITHOUT email: write to `migrations/privy-emailless-users.json`

**Layer 2 — Runtime email bridge** (in `auth-middleware.ts`)

When Steward JWT arrives and `stewardId` not found in Babylon:
1. If `payload.email` exists (real email, not `@id.steward.internal`): look up Babylon user by email, set `stewardId` on match

**Layer 3 — Runtime social bridge** (in custom auth API routes)

When Farcaster/Twitter/Telegram user logs in through their respective custom API route:
- Match by FID (Farcaster), Twitter username, or Telegram ID in `socialProfiles` table
- Set `stewardId` on match

**Layer 4 — "Claim account" prompt** (for edge cases)

If user cannot be matched automatically:
- Show: "We found an existing account associated with @[handle]. Enter your email to confirm."
- On verification: link accounts

### User Category Coverage

| Category | % (estimated) | Strategy |
|---|---|---|
| Has email in Privy | ~70% | Pre-seed + email bridge at login |
| Farcaster-only | ~20% | Farcaster API route links by FID |
| Twitter-only | ~7% | Twitter API route links by username |
| Telegram-only | ~2% | Telegram API route links by Telegram ID |
| True orphans (no linked data) | <1% | Claim account prompt |

### Cutover Sequence

1. Run `bun run scripts/migrate-privy-to-steward.ts --dry-run` → review report
2. Deploy Phase C code (backend auth swap) but keep Privy `NEXT_PUBLIC_PRIVY_APP_ID` in env (login modal still shows as fallback during transition — **actually the old modal is completely replaced, so there is no fallback**. Users who have existing `privy-token` cookies will get a login prompt because the cookie name changed. This is expected. They re-authenticate once.)
3. Run `bun run scripts/migrate-privy-to-steward.ts` → pre-seed Steward users
4. Deploy full code (all phases)
5. Monitor for 2 weeks — watch for users who cannot re-authenticate
6. After 30 days: remove `PRIVY_APP_SECRET` from all environments, delete Privy app from Privy dashboard

### Privy "Fallback" Correction

The original plan described `PRIVY_AUTH_FALLBACK=true` as a grace period flag. **This does not need to exist.** Privy's JWTs use `privy-token` cookies. Steward uses `steward-token` cookies. These are different cookie names. When we deploy:
- All existing `privy-token` cookies are ignored by the new middleware (it only reads `steward-token`)
- Users see a login prompt on their next page load
- They log in via Steward, get `steward-token` set, are linked via email/social bridge

There is no dual-auth complexity needed. The old cookies simply don't work and users re-authenticate once. This is acceptable for a breaking auth migration.

---

## 8. New Environment Variables

### Remove (Privy vars)

```env
NEXT_PUBLIC_PRIVY_APP_ID
PRIVY_APP_SECRET
PRIVY_APP_ID
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
```

### Add

```env
# ── Steward Auth Service ────────────────────────────────────────────────────
STEWARD_API_URL=http://localhost:3200
NEXT_PUBLIC_STEWARD_API_URL=http://localhost:3200

# [REQUIRED] Vault master password. Rotating requires re-encrypting all vault entries.
# Generate: openssl rand -hex 32
STEWARD_MASTER_PASSWORD=

# [REQUIRED] JWT signing secret used by Steward's auth.ts module.
# Babylon's auth-middleware verifies JWTs using this secret.
# Generate: openssl rand -hex 32
STEWARD_JWT_SECRET=

# [REQUIRED] Same value as STEWARD_JWT_SECRET — Steward's user.ts reads this var name.
# Set both to the same value to avoid confusion.
STEWARD_SESSION_SECRET=   # <- set equal to STEWARD_JWT_SECRET

# [REQUIRED] Platform operator key(s). Comma-separated. Used for tenant admin.
# Generate: openssl rand -hex 32
STEWARD_PLATFORM_KEYS=

# [REQUIRED] Output of bun run steward:init
STEWARD_TENANT_ID=babylon
STEWARD_TENANT_API_KEY=

# ── OAuth providers (all routed through Steward) ────────────────────────────
# Google: console.cloud.google.com
# Redirect URI in Google: http://localhost:3200/auth/oauth/google/callback
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Discord: discord.com/developers/applications
# Redirect URI in Discord: http://localhost:3200/auth/oauth/discord/callback
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=

# Twitter/X: developer.twitter.com
# App type: Confidential client, OAuth2 with PKCE
# Scopes: tweet.read users.read offline.access
# Redirect URI in Twitter: http://localhost:3200/auth/oauth/twitter/callback
# NOTE: Twitter does NOT return email via API.
# Steward uses a synthetic internal email (provider.id@id.steward.internal) for Twitter users.
TWITTER_CLIENT_ID=
TWITTER_CLIENT_SECRET=

# ── Email (Steward sends magic links via Resend) ────────────────────────────
# If RESEND_API_KEY is blank, tokens are printed to console (safe for dev)
RESEND_API_KEY=
EMAIL_FROM=login@babylon.social

# ── Telegram (mini-app HMAC verification) ──────────────────────────────────
TELEGRAM_BOT_TOKEN=
```

### OAuth App Setup (verified redirect URIs)

**Google Cloud Console:**
- Create OAuth 2.0 Client → Web application
- Authorized redirect URI: `http://localhost:3200/auth/oauth/google/callback`
- Prod: `https://<steward-api-prod-url>/auth/oauth/google/callback`

**Discord Developer Portal:**
- Create app → OAuth2 → Redirect: `http://localhost:3200/auth/oauth/discord/callback`

**Twitter Developer Portal:**
- Create Project → App → OAuth 2.0 → Type: Confidential client
- Callback URI: `http://localhost:3200/auth/oauth/twitter/callback`
- Required scopes: `tweet.read users.read offline.access`
- Enable PKCE (required by Twitter OAuth2 for confidential clients)

---

## 9. Full File Inventory

### Steward repo (PR: `Steward-Fi/steward`)

| File | Change |
|---|---|
| `packages/auth/src/oauth.ts` | Add Twitter/X with PKCE + no-email fix |
| `packages/api/src/routes/auth.ts` | `provisionOAuthUser()`: synthetic email for no-email providers |
| `packages/api/src/routes/platform.ts` | **NEW route**: `POST /platform/users` (migration support) |
| `packages/auth/src/__tests__/oauth.test.ts` | Add Twitter test cases |
| `.env.example` | Add `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET` |

### ElizaCloud repo (PR: `elizaOS/cloud`)

| File | Change |
|---|---|
| `docker-compose.yml` | Add `steward` service |
| `app/api/v1/steward/tenants/route.ts` | **NEW** — tenant provisioning API |
| `packages/db/schemas/organizations.ts` | Add `stewardTenantId`, `stewardTenantApiKey` |
| `packages/db/migrations/<N>_steward_tenant.sql` | **NEW** |
| `.env.example` | Add Steward env vars |
| `docs/steward-integration.md` | **NEW** |

### Babylon repo (PR: `BabylonSocial/babylon`)

**Infrastructure:**

| File | Change |
|---|---|
| `docker-compose.yml` | Add `steward` service (build from `../steward`) |
| `scripts/docker/init-steward-db.sh` | **NEW** |
| `scripts/pre-dev/pre-dev-local.ts` | Add Steward startup + health check |
| `scripts/steward-init.ts` | **NEW** |
| `scripts/migrate-privy-to-steward.ts` | **NEW** |
| `migrations/privy-emailless-users.json` | **GENERATED** (gitignored) |

**Database:**

| File | Change |
|---|---|
| `packages/db/src/schema/users.ts` | Add `stewardId: text().unique()` |
| `packages/db/drizzle/migrations/<N>.sql` | **NEW** |

**Backend:**

| File | Change |
|---|---|
| `packages/api/src/auth-middleware.ts` | Replace Privy → jose `jwtVerify`, `steward-token` cookie, user lookup chain |
| `packages/api/src/users/ensure-user.ts` | Add `ensureUserFromSteward()`, `mintSessionForFarcasterUser()`, `mintSessionForTelegramUser()` |
| `packages/api/src/users/user-lookup.ts` | Add `'stewardId'` kind |
| `packages/api/src/dev-credentials.ts` | Update test DID prefix `did:privy:test-` → `steward:test:` |
| `packages/shared/src/auth/privy-config.ts` | **DELETE** |
| `packages/api/src/services/privy/privy-node.ts` | **DELETE** |
| `packages/api/src/services/privy/authed-user.ts` | **DELETE** (if remaining) |

**Frontend — providers:**

| File | Change |
|---|---|
| `apps/web/src/components/providers/StewardAuthProvider.tsx` | **NEW** |
| `apps/web/src/components/providers/Providers.tsx` | Remove Privy, add Steward |
| `apps/web/src/components/providers/FarcasterMiniAppProvider.tsx` | Remove Privy; use `quickAuth.getToken()` |
| `apps/web/src/components/providers/OnboardingProvider.tsx` | Remove `usePrivy()` |

**Frontend — hooks:**

| File | Change |
|---|---|
| `apps/web/src/hooks/useAuth.ts` | Full rewrite |
| `apps/web/src/hooks/useSSE.ts` | `getAccessToken` from `useAuth` |
| `apps/web/src/hooks/useChatMessages.ts` | `getAccessToken` from `useAuth` |
| `apps/web/src/hooks/useTeamChat.ts` | `getAccessToken` from `useAuth` |
| `apps/web/src/hooks/useToggleReaction.ts` | `getAccessToken` from `useAuth` |
| `apps/web/src/hooks/useQueuedOutcomes.ts` | `getAccessToken` from `useAuth` |

**Frontend — components:**

| File | Change |
|---|---|
| `apps/web/src/components/auth/LoginModal.tsx` | **NEW** |
| `apps/web/src/components/profile/LinkSocialAccountsModal.tsx` | Remove `useLinkAccount` |
| `apps/web/src/components/points/BuyPointsModal.tsx` | `getAccessToken` from `useAuth` |
| `apps/web/src/components/chats/NftVerificationBanner.tsx` | `getAccessToken` from `useAuth` |
| `apps/web/src/components/settings/SecurityTab.tsx` | Remove `usePrivy/useWallets` |

**Frontend — pages & API routes:**

| File | Change |
|---|---|
| `apps/web/src/app/api/auth/session/route.ts` | **NEW** — cookie bridge (POST/DELETE) |
| `apps/web/src/app/api/auth/farcaster/route.ts` | **NEW** — SIWF exchange |
| `apps/web/src/app/api/auth/farcaster-miniapp/route.ts` | **NEW** — quickAuth exchange |
| `apps/web/src/app/api/auth/telegram-miniapp/route.ts` | **NEW** — HMAC verify |
| `apps/web/src/app/auth/callback/email/page.tsx` | **NEW** — magic link callback |
| `apps/web/src/app/auth/callback/[provider]/page.tsx` | **NEW** — OAuth callback (with URL sanitization) |

**Config:**

| File | Change |
|---|---|
| `apps/web/package.json` | Remove `@privy-io/*`, add `@stwd/sdk @simplewebauthn/browser` |
| `apps/web/.env.example` | Swap vars |
| `apps/web/src/middleware.ts` | Update `privy-token` cookie ref → `steward-token` |

---

## 10. Implementation Order

```
Phase A — Steward PR (prerequisite, unblocks Twitter + migration)
├── Twitter/X OAuth to packages/auth/src/oauth.ts (with PKCE + no-email fix)
├── provisionOAuthUser() synthetic email patch
├── POST /platform/users admin endpoint
└── Merge to Steward develop

Phase B — ElizaCloud PR (infrastructure)
├── Steward Docker service in docker-compose.yml
├── Tenant provisioning API
└── Merge to ElizaCloud dev

Phase C — Babylon: Infrastructure
├── 1. docker-compose.yml: steward service (../steward build context)
├── 2. scripts/docker/init-steward-db.sh
├── 3. scripts/pre-dev/pre-dev-local.ts: Steward health check
├── 4. scripts/steward-init.ts
└── QG: bun run check + typecheck ✅

Phase D — Babylon: Database
├── 5. DB migration: stewardId column
└── QG: bun run db:migrate ✅

Phase E — Babylon: Backend auth swap
├── 6. auth-middleware.ts: Steward JWT verification
├── 7. ensure-user.ts + user-lookup.ts
├── 8. /api/auth/session cookie bridge
├── 9. /api/auth/farcaster route
├── 10. /api/auth/farcaster-miniapp route
├── 11. /api/auth/telegram-miniapp route
└── QG: integration tests pass ✅

Phase F — Babylon: User migration
├── 12. scripts/migrate-privy-to-steward.ts --dry-run (review output)
└── 13. Run migration against production Steward

Phase G — Babylon: Frontend swap
├── 14. StewardAuthProvider.tsx
├── 15. Providers.tsx (remove PrivyProvider)
├── 16. useAuth.ts rewrite
├── 17. Mechanical sweep: 9 getAccessToken callers
└── QG: bun run typecheck ✅

Phase H — Babylon: Login + callbacks
├── 18. LoginModal.tsx
├── 19. /auth/callback/email/page.tsx
├── 20. /auth/callback/[provider]/page.tsx (URL sanitization included)
└── QG: manually test each login method ✅

Phase I — Babylon: Mini-apps + linking
├── 21. FarcasterMiniAppProvider.tsx (quickAuth.getToken())
├── 22. LinkSocialAccountsModal.tsx
└── QG: test Farcaster + Telegram mini-app flows ✅

Phase J — Babylon: Cleanup
├── 23. bun remove @privy-io/react-auth @privy-io/server-auth @privy-io/node
├── 24. bun add @stwd/sdk @simplewebauthn/browser
├── 25. Delete dead files (privy-config.ts, privy-node.ts, etc.)
├── 26. Update .env.example
└── QG: full quality gate ✅

Phase K — Cutover
├── 27. Deploy (users with old privy-token cookies get login prompt — expected)
├── 28. Monitor 2 weeks
└── 29. Remove PRIVY_APP_SECRET from environments, delete Privy app
```

---

## 11. Quality Gates

```bash
# Format + lint
bun run check

# TypeScript (zero errors)
bun run typecheck

# Lint (zero warnings)
bun run lint

# Unit tests
bun run test:unit

# Integration tests (after backend changes)
bun run test:integration

# Build
bun run build
```

**Migration-specific checks:**

```bash
# No @privy-io imports remain
rg "@privy-io" apps/web/src packages --type ts

# No usePrivy() calls remain
rg "usePrivy\(\)" apps/web/src

# steward-token cookie set after login
# Browser DevTools → Application → Cookies → steward-token → HttpOnly: ✓

# Token NOT present in URL after OAuth callback
# Browser → check URL bar after login — should be clean (token removed by replaceState)

# JWT verification (curl test)
curl -H "Cookie: steward-token=$(cat /tmp/test-token)" \
  http://localhost:3000/api/users/me | jq .

# Migration report
bun run scripts/migrate-privy-to-steward.ts --dry-run | tail -20
```

---

## 12. Open Questions / Decisions

| # | Question | Status |
|---|---|---|
| 1 | Steward sibling vs subtree | **Decided**: sibling directory (`../steward`) |
| 2 | Production Steward URL | **Decided**: ElizaCloud-hosted |
| 3 | Twitter/X required | **Decided**: Yes (Steward PR covers this) |
| 4 | Email provider | **Decided**: Resend |
| 5 | `STEWARD_MASTER_PASSWORD` rotation strategy | **Open**: document in runbook; rotation requires re-encrypting Steward vault |
| 6 | Farcaster relay | **Decided**: default `relay.farcaster.xyz` |
| 7 | ElizaCloud Steward prod URL | **Open**: needed before prod deploy |
| 8 | Email-less user outreach | **Decided**: in-app claim-account prompt (Layer 4 bridge) |

---

## Appendix A: LARP Assessment Issues Fixed in This Document

The following issues were identified in the original plan and corrected above:

| # | Original Issue | Fix Applied |
|---|---|---|
| 1 | Twitter OAuth returns no email — `provisionOAuthUser()` would crash | Steward PR must fix with synthetic `@id.steward.internal` email |
| 2 | Custom Farcaster/Telegram JWTs referenced non-existent Steward `userId` | Routes now call `POST /platform/users` first, use returned `userId` |
| 3 | User migration via direct Postgres INSERT (impossible on prod) | Migration uses new `POST /platform/users` API endpoint instead |
| 4 | `PRIVY_AUTH_FALLBACK=true` described as existing flag | Removed. Cookie name change (`privy-token` → `steward-token`) is the natural cutover. |
| 5 | `@farcaster/auth-kit` listed as new dependency | Already installed. Only `@stwd/sdk @simplewebauthn/browser` are new. |
| 6 | `quickAuth.verifyJwt` described as simple local verify | Documented as network call to Farcaster auth server (JWKS fetch) — acceptable |
| 7 | Docker build context for sibling directory not addressed | Confirmed Docker supports `../steward` relative context; documented |
| 8 | OAuth JWT token delivered and stored via URL query param | `window.history.replaceState()` called immediately in callback page |
| 9 | `STEWARD_JWT_SECRET` vs `STEWARD_SESSION_SECRET` mismatch | Docker-compose sets both to same value; documented the difference |
| 10 | `verifyJwt` domain parameter origin not specified | `new URL(process.env.NEXT_PUBLIC_APP_URL!).hostname` — documented |

---

## Appendix B: Steward API Endpoints Used by Babylon

| Method | Path | Used for | Notes |
|---|---|---|---|
| `POST` | `/auth/email/send` | Send magic link | |
| `POST` | `/auth/email/verify` | Verify token | Returns JWT + refresh token |
| `POST` | `/auth/passkey/register/options` | Start passkey registration | |
| `POST` | `/auth/passkey/register/verify` | Complete registration | |
| `POST` | `/auth/passkey/login/options` | Start passkey login | |
| `POST` | `/auth/passkey/login/verify` | Complete login | |
| `GET` | `/auth/oauth/:provider/authorize` | Redirect to OAuth provider | Sets state in challenge store |
| `GET` | `/auth/oauth/:provider/callback` | OAuth callback (Steward-internal) | Redirects to Babylon with `?token=<jwt>` |
| `GET` | `/auth/session` | Validate existing JWT | Used on StewardAuthProvider mount |
| `POST` | `/auth/refresh` | Rotate tokens | One-time use refresh token |
| `POST` | `/auth/revoke` | Revoke refresh token | Logout |
| `GET` | `/health` | Health check | Used in pre-dev-local.ts |
| `POST` | `/platform/tenants` | Create Babylon tenant | Run once via steward-init.ts |
| `POST` | `/platform/users` | Pre-seed users (migration) | **New endpoint — requires Steward PR** |

Babylon's `auth-middleware` verifies JWTs **locally** using `jose jwtVerify` + `STEWARD_JWT_SECRET`. No network call to Steward per request.

---

## Appendix C: Package Changes

**Remove (3 packages):**
```
@privy-io/react-auth
@privy-io/server-auth
@privy-io/node
```

**Add (2 packages — only what's not already present):**
```
@stwd/sdk@0.5.0                # StewardAuth client (verified on npm)
@simplewebauthn/browser        # peer dep for passkey WebAuthn (not auto-installed by @stwd/sdk)
```

**Already installed — do NOT add again:**
```
@farcaster/auth-kit@0.8.1      # already in apps/web/package.json
@farcaster/auth-client@0.7.0   # already in apps/web/package.json
@farcaster/miniapp-sdk@0.2.1   # already in apps/web/package.json (includes quickAuth)
@farcaster/quick-auth          # already pulled in as transitive dep
jose                           # already used in Babylon backend
```

---

*Last updated: April 2026. LARP-assessed by AI agent. Transcript: [Phase 2 Steward Planning](6a30dbe2-2ca4-4de0-9d8e-c7d24ecf4d68).*
