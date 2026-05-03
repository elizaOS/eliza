# Architecture

## Overview

Steward is a **monorepo** built on Bun and TypeScript. The core API is a [Hono](https://hono.dev) server with a multi-tenant middleware chain that enforces tenant isolation on every route.

```
app (your code)
  └── @stwd/sdk (TypeScript client)
        └── REST API (packages/api)
              ├── Auth middleware (tenant isolation)
              ├── Policy Engine (packages/policy-engine)
              ├── Vault (packages/vault)
              │     └── EVM signing (viem)
              │     └── Solana signing (@solana/web3.js)
              └── DB (packages/db)
                    ├── PostgreSQL (production)
                    └── PGLite (embedded)
```

## Two Deployment Modes

### Embedded Mode (Local / PGLite)

No external services required. PGLite is a Postgres-compatible database compiled to WASM that runs in-process. The entire Steward stack — API, auth, vault, policy engine, and database — runs in a single Bun process.

```bash
STEWARD_MASTER_PASSWORD=secret bun packages/api/src/index.ts
```

When `DATABASE_URL` is not set, Steward automatically falls back to PGLite. Data is stored in `PGLITE_DATA_DIR` (default `~/.steward/data`) or in memory when `STEWARD_PGLITE_MEMORY=true`.

**Best for:** Desktop tools, local development, single-user agent setups, testing.

**Limitations:** No Redis means no cross-process rate limiting or spend tracking. In-memory challenge/token stores (passkeys, magic links) are lost on restart.

### Hosted Mode (PostgreSQL)

Backed by a real Postgres database. Redis is optional but enables:
- Cross-process rate limiting
- Persistent spend tracking
- Token/challenge stores that survive restarts (passkey registration, magic links)

```bash
DATABASE_URL=postgresql://user:pass@host/steward \
STEWARD_MASTER_PASSWORD=secret \
bun packages/api/src/index.ts
```

**Best for:** Production deployments, multi-tenant platforms, any multi-instance setup.

## Package Structure

| Package | NPM / Internal | Role |
|---------|---------------|------|
| `packages/api` | `@steward/api` | Hono REST API server (Bun runtime). All routes, middleware, rate limiting, auth middleware |
| `packages/auth` | `@stwd/auth` | Framework-agnostic auth primitives: passkeys (WebAuthn), email magic links, SIWE, JWT, API key hashing |
| `packages/db` | `@stwd/db` | Drizzle ORM schema + Postgres/PGLite client factory. Runs migrations |
| `packages/vault` | `@stwd/vault` | AES-256-GCM key management, EVM signing via viem, Solana signing via @solana/web3.js |
| `packages/policy-engine` | `@stwd/policy-engine` | Stateless policy evaluator for all 6 policy types |
| `packages/sdk` | `@stwd/sdk` | Published TypeScript client. Works in browser, Node, Bun, Deno |
| `packages/react` | `@stwd/react` | Embeddable React components: WalletOverview, PolicyControls, ApprovalQueue, SpendDashboard, TransactionHistory |
| `packages/shared` | `@stwd/shared` | Shared types, chain constants (CAIP-2), price oracle interface |
| `packages/proxy` | `@steward/proxy` | Credential injection reverse proxy. Separate service |
| `packages/webhooks` | `@stwd/webhooks` | Signed webhook dispatcher with exponential-backoff retry queue |
| `packages/eliza-plugin` | `@stwd/eliza-plugin` | ElizaOS plugin: actions, providers, evaluators |

## Request Flow

### Signing a Transaction

```
1. App → StewardClient.signTransaction("agent-id", { to, value, chainId })
2. SDK → POST /vault/{agentId}/sign  (X-Steward-Key + X-Steward-Tenant headers)
3. API middleware → tenantAuth()
     - Extracts tenantId from JWT payload OR X-Steward-Tenant header
     - Validates API key hash (PBKDF2 timing-safe compare)
     - Sets tenantId, tenant, tenantConfig in Hono context
4. Route handler → vault.ts
     a. Resolves agentId → tenant isolation check
     b. Queries recent tx counts + spend totals from DB
     c. Loads agent policies from DB
     d. policy-engine.evaluatePolicy() for each rule (AND logic)
        - All rules must pass; first failure blocks
     e. If any rule fails with "needs approval" → insert into approval_queue, return 202
     f. If all rules pass → vault.signTransaction()
        - Decrypts private key: AES-256-GCM(PBKDF2(masterPassword + agentId + salt))
        - Builds and signs EVM transaction via viem
     g. Records transaction in DB
     h. Dispatches webhook event (tx.signed or tx.pending)
5. Returns { txHash } (if broadcast:true) or { signedTx } (if broadcast:false)
```

### Auth Flow (Email Magic Link)

```
1. User → POST /auth/email/send { email }
2. Server → generates 32-byte token, SHA-256 hashes it, stores in TokenStore (10 min TTL)
3. Sends email via Resend (or console in dev) with:
   APP_URL/auth/callback/email?token=xxx&email=yyy
4. User clicks link → web app calls POST /auth/email/verify { token, email }
5. Server → hashes token, compares, deletes (one-time use)
6. findOrCreateUser(email) → upserts users row
7. provisionWalletForUser() → creates personal-{userId} tenant + EVM+Solana wallets
8. Creates 30-day refresh token (stored as hash in DB)
9. Returns { ok: true, token: JWT (24h), refreshToken, user: { id, email, walletAddress } }
```

### Auth Flow (OAuth — Google / Discord)

```
1. User → GET /auth/oauth/{provider}/authorize?redirectUri=...
2. Server → generates CSRF state, stores in ChallengeStore (5 min TTL)
3. Redirects to provider's authorization page
4. Provider → GET /auth/oauth/{provider}/callback?code=...&state=...
5. Server → validates state, exchanges code for provider access token
6. Fetches user profile from provider (email, name, provider user ID)
7. Upserts accounts row (provider + providerUserId link)
8. findOrCreateUser(email) → upserts users row
9. provisionWalletForUser() on first sign-in
10. Creates 30-day refresh token
11. Redirects to redirectUri?token=JWT&refreshToken=... (or returns JSON for POST /token)
```

## Multi-Tenancy Model

Every authenticated request is scoped to a tenant. Isolation is enforced at three layers:

### 1. Middleware

`tenantAuth()` in `packages/api/src/services/context.ts` is mounted on every authenticated route group. It:
- Extracts `tenantId` from the JWT payload or the `X-Steward-Tenant` header
- Validates the API key hash against the tenant's stored hash
- Sets `c.get("tenantId")` for all downstream handlers

### 2. Database Queries

All major tables have `tenantId` foreign keys. Every route handler filters by `tenantId` from the Hono context:

```typescript
// agents.ts — always scoped to the authenticated tenant
const tenantAgents = await db
  .select()
  .from(agents)
  .where(eq(agents.tenantId, tenantId));
```

Schema relationships:
```
tenants
  └── agents (tenantId FK)
        ├── encryptedKeys (agentId FK)
        ├── encryptedChainKeys (agentId FK)
        ├── agentWallets (agentId FK)
        ├── policies (agentId FK)
        ├── transactions (agentId FK)
        └── approvalQueue (agentId FK)
```

### 3. Vault Key Derivation

Each agent's private key is encrypted with a unique key derived from:

```
AES-256-GCM key = PBKDF2(masterPassword + agentId + salt)
```

Even if an attacker gains read access to the database, they cannot decrypt keys from another tenant without knowing both the master password and the agent-specific salt.

### Platform Routes

`packages/api/src/routes/platform.ts` mounts a separate route group that accepts `X-Steward-Platform-Key` instead of tenant credentials. Platform routes can read/write across tenants — intended for multi-tenant operators (e.g., Eliza Cloud) that need to provision new tenants or inspect aggregate data. This key must be kept highly confidential.

## User Identity Model

Users are humans who authenticate. Agents are autonomous entities with wallets.

```
users (UUID)
  ├── email, name, walletAddress, stewardWalletId
  ├── authenticators[]     — passkey credentials (1 user : N passkeys)
  ├── sessions[]           — active session records
  ├── accounts[]           — OAuth provider accounts (Google, Discord; linked on first OAuth sign-in)
  └── userTenants[]        — many-to-many with tenants; includes role field

tenants (varchar slug)
  └── agents[]
        ├── ownerUserId    — optional FK to users (a user's "personal agent")
        ├── walletAddress  — EVM address
        └── policies[]
```

**Key design decisions:**

- **Users can belong to multiple tenants.** `userTenants` is a many-to-many join table with a `(userId, tenantId)` unique constraint. A user on Eliza Cloud can be a member of both the `eliza` and `babylon` tenants.

- **Personal tenant provisioning.** On first sign-in (email/passkey/SIWE), Steward auto-creates a `personal-{userId}` tenant for the user, giving them an isolated namespace.

- **User vs. Agent.** A user is a human who authenticates. An agent is an autonomous entity with a wallet. Agents can be owned by a user (`ownerUserId` FK) or purely tenant-scoped (no user FK). The former is the "user's personal wallet"; the latter is a "platform agent."

- **Wallet provisioning.** On first sign-in, Steward calls `provisionUserWallet()` which creates an agent in the personal tenant and generates both EVM and Solana keypairs. `users.walletAddress` and `users.stewardWalletId` are updated to point to these.

## Supported Chains

| Chain | Chain ID | CAIP-2 |
|-------|----------|--------|
| Ethereum | 1 | `eip155:1` |
| BNB Smart Chain | 56 | `eip155:56` |
| BNB Testnet | 97 | `eip155:97` |
| Polygon | 137 | `eip155:137` |
| Base | 8453 | `eip155:8453` |
| Base Sepolia | 84532 | `eip155:84532` |
| Arbitrum One | 42161 | `eip155:42161` |
| Optimism | 10 | `eip155:10` |
| Avalanche | 43114 | `eip155:43114` |
| Solana Mainnet | 101 | `solana:5eykt4...` |
| Solana Devnet | 102 | `solana:EtWTRA...` |
