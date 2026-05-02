# Steward Auth + Wallet Wave — Worker Plan

## Pre-flight
- Branch from `develop` (commit `7407f53`)
- All workers operate on separate packages/files to avoid merge conflicts
- Workers should NOT modify existing files in `packages/api/src/index.ts` — that gets wired up after merge

---

## Worker 1: Schema Expansion (`feat/auth-schema`)

**Goal:** Add users, authenticators, sessions, accounts tables + user-wallet relationship to the DB schema.

**Files to create/modify:**
- `packages/db/src/schema.ts` — ADD new tables (do not remove existing tables)
- `packages/db/src/schema-auth.ts` — NEW: auth-specific tables (users, authenticators, sessions, accounts)

**Schema to add:**

```typescript
// packages/db/src/schema-auth.ts

// Users — central identity, decoupled from tenants
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).unique(),
  emailVerified: boolean("email_verified").default(false),
  name: varchar("name", { length: 255 }),
  image: text("image"),
  walletAddress: varchar("wallet_address", { length: 128 }),
  stewardWalletId: varchar("steward_wallet_id", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// WebAuthn credentials (passkeys)
export const authenticators = pgTable("authenticators", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull().unique(),
  credentialPublicKey: text("credential_public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  credentialDeviceType: varchar("credential_device_type", { length: 32 }),
  credentialBackedUp: boolean("credential_backed_up").default(false),
  transports: text("transports").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Sessions
export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionToken: text("session_token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// OAuth accounts
export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 64 }).notNull(),
  providerAccountId: varchar("provider_account_id", { length: 255 }).notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: integer("expires_at"),
}, (table) => ({
  providerUnique: uniqueIndex("accounts_provider_unique").on(table.provider, table.providerAccountId),
}));

// User-tenant membership (a user can belong to multiple tenants)
export const userTenants = pgTable("user_tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tenantId: varchar("tenant_id", { length: 64 }).notNull().references(() => tenants.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 32 }).notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userTenantUnique: uniqueIndex("user_tenants_unique").on(table.userId, table.tenantId),
}));
```

**Also modify `packages/db/src/schema.ts`:**
- Add `ownerUserId` to agents table: `ownerUserId: uuid("owner_user_id")`
- Add `walletType` to agents table: `walletType: varchar("wallet_type", { length: 32 }).default("agent")`
- Re-export everything from schema-auth.ts
- Add relations for all new tables

**Also modify `packages/db/src/index.ts`:**
- Export all new tables and types

**Test:** `bun run build` should pass with no type errors.

---

## Worker 2: Passkey Auth (`feat/passkey-auth`)

**Goal:** Full WebAuthn passkey registration + authentication flow.

**Dependencies to install:**
```bash
cd packages/auth && bun add @simplewebauthn/server@^13
```

**Files to create:**
- `packages/auth/src/passkey.ts` — PasskeyAuth class
- `packages/auth/src/session.ts` — JWT session creation + verification (extract from api/src/index.ts pattern)

**PasskeyAuth class interface:**
```typescript
export interface PasskeyConfig {
  rpName: string;       // "Steward" or custom
  rpID: string;         // "steward.fi" or custom domain
  origin: string;       // "https://steward.fi"
}

export class PasskeyAuth {
  constructor(config: PasskeyConfig) {}

  // Registration flow (new user or adding passkey to existing)
  async generateRegistrationOptions(userId: string, email: string, existingCredentials?: string[]): Promise<PublicKeyCredentialCreationOptionsJSON>
  async verifyRegistration(userId: string, response: RegistrationResponseJSON, expectedChallenge: string): Promise<VerifiedRegistrationResponse>

  // Authentication flow (returning user)
  async generateAuthenticationOptions(email: string): Promise<PublicKeyCredentialRequestOptionsJSON>
  async verifyAuthentication(response: AuthenticationResponseJSON, expectedChallenge: string, credentialPublicKey: string, counter: number): Promise<VerifiedAuthenticationResponse>
}
```

**Session management:**
```typescript
export interface SessionConfig {
  secret: string;       // JWT signing secret
  issuer?: string;      // default: "steward"
  expiresIn?: string;   // default: "7d"
}

export class SessionManager {
  constructor(config: SessionConfig) {}

  async createSession(userId: string, extra?: Record<string, unknown>): Promise<string>
  async verifySession(token: string): Promise<{ userId: string; [key: string]: unknown } | null>
  async invalidateSession(token: string): Promise<void>
}
```

**Challenge store:** Use a simple in-memory Map with TTL (5 min) for WebAuthn challenges. Same pattern as the existing nonce store in the API.

**Export from packages/auth/src/index.ts**

**Test:** Unit tests for session creation/verification. Mock tests for passkey flows.

---

## Worker 3: Platform Auth + Tenant Management (`feat/platform-auth`)

**Goal:** Platform-level API key that lets Eliza Cloud (or any platform) manage tenants and agents programmatically.

**Files to create:**
- `packages/auth/src/platform.ts` — platform key validation
- `packages/api/src/routes/platform.ts` — Hono route group for platform endpoints

**Platform auth concept:**
- Env var: `STEWARD_PLATFORM_KEYS` — comma-separated list of valid platform API keys
- Header: `X-Steward-Platform-Key: stw_platform_xxx`
- Platform keys can: create tenants, list tenants, manage agents across tenants, set default policies

**Platform routes (new file, separate from main index.ts):**
```typescript
// packages/api/src/routes/platform.ts
import { Hono } from "hono";

const platform = new Hono();

// Middleware: verify platform key
platform.use("*", platformAuthMiddleware);

// Tenant management
platform.post("/tenants", async (c) => { ... });           // create tenant
platform.get("/tenants", async (c) => { ... });             // list all tenants
platform.get("/tenants/:id", async (c) => { ... });         // get tenant
platform.delete("/tenants/:id", async (c) => { ... });      // delete tenant
platform.put("/tenants/:id/policies", async (c) => { ... }); // set default policies

// Cross-tenant agent management
platform.post("/tenants/:id/agents", async (c) => { ... });      // create agent in tenant
platform.post("/tenants/:id/agents/batch", async (c) => { ... }); // batch create
platform.get("/tenants/:id/agents", async (c) => { ... });        // list agents in tenant

// Platform stats
platform.get("/stats", async (c) => { ... });  // total tenants, agents, tx counts

export { platform as platformRoutes };
```

**Platform auth middleware:**
```typescript
export function platformAuthMiddleware() {
  return createMiddleware(async (c, next) => {
    const key = c.req.header("X-Steward-Platform-Key");
    if (!key) return c.json({ ok: false, error: "Platform key required" }, 401);

    const validKeys = (process.env.STEWARD_PLATFORM_KEYS || "").split(",").map(k => k.trim()).filter(Boolean);
    if (!validKeys.includes(key)) return c.json({ ok: false, error: "Invalid platform key" }, 403);

    await next();
  });
}
```

**Also create:** `packages/api/src/routes/auth.ts` — extracted auth routes (SIWE nonce/verify/session/logout) from main index.ts, so they can be mounted cleanly.

**Test:** Create a test that provisions a tenant + agent via platform key.

---

## Worker 4: User Wallets + Auto-Provisioning (`feat/user-wallets`)

**Goal:** When a user is created (via any auth method), auto-create a Steward-managed embedded wallet for them.

**Files to create:**
- `packages/vault/src/user-wallet.ts` — user wallet provisioning logic
- `packages/api/src/routes/user.ts` — user-facing wallet routes

**User wallet provisioning:**
```typescript
// packages/vault/src/user-wallet.ts
import { Vault } from "./vault";

export interface UserWalletResult {
  userId: string;
  agentId: string;  // Steward agent ID backing this wallet
  walletAddress: string;
  chainType: "evm";
}

export async function provisionUserWallet(
  vault: Vault,
  userId: string,
  displayName: string,
  tenantId?: string  // optional: assign to a tenant
): Promise<UserWalletResult> {
  const agentId = `user-wallet-${userId}`;
  const agent = await vault.createAgent(
    tenantId || `personal-${userId}`,
    agentId,
    `${displayName}'s Wallet`,
    `user:${userId}`
  );

  return {
    userId,
    agentId: agent.id,
    walletAddress: agent.walletAddress,
    chainType: "evm",
  };
}
```

**User-facing routes:**
```typescript
// packages/api/src/routes/user.ts
// These routes require session auth (JWT from passkey/oauth login)

user.get("/me", ...);                    // get current user + wallet info
user.get("/me/wallet", ...);             // get wallet address + balance
user.post("/me/wallet/sign", ...);       // sign a transaction (policy-enforced)
user.get("/me/wallet/history", ...);     // transaction history
user.get("/me/wallet/policies", ...);    // view policies on user's wallet
```

**Default policies for user wallets:**
```typescript
const USER_WALLET_DEFAULT_POLICIES: PolicyRule[] = [
  {
    id: "user-spend-limit",
    type: "spending-limit",
    enabled: true,
    config: {
      maxPerTx: parseEther("0.5").toString(),
      maxPerDay: parseEther("2.0").toString(),
      maxPerWeek: parseEther("10.0").toString(),
    },
  },
  {
    id: "user-rate-limit",
    type: "rate-limit",
    enabled: true,
    config: { maxTxPerHour: 10, maxTxPerDay: 50 },
  },
];
```

**Test:** Provision a user wallet, verify address returned, verify default policies applied.

---

## Worker 5: Email Auth (`feat/email-auth`)

**Goal:** Magic link email auth. User enters email, gets a login link, clicks it, gets a session.

**Dependencies:**
```bash
cd packages/auth && bun add resend
```

**Files to create:**
- `packages/auth/src/email.ts` — magic link generation + verification
- `packages/auth/src/email-provider.ts` — Resend adapter (pluggable for SendGrid/SMTP later)

**Magic link flow:**
```typescript
export interface EmailAuthConfig {
  from: string;           // "login@steward.fi"
  resendApiKey: string;
  baseUrl: string;        // "https://steward.fi" — for building callback URLs
  tokenTtlMs?: number;    // default: 10 minutes
  callbackPath?: string;  // default: "/auth/callback/email"
}

export class EmailAuth {
  constructor(config: EmailAuthConfig) {}

  // Generate magic link token, send email, return token hash for verification
  async sendMagicLink(email: string): Promise<{ tokenHash: string; expiresAt: Date }>

  // Verify the token from the callback URL
  async verifyMagicLink(token: string): Promise<{ email: string; valid: boolean }>
}
```

**Email template:** Simple, clean, no heavy HTML. Just:
```
Subject: Sign in to Steward

Click here to sign in: {link}

This link expires in 10 minutes. If you didn't request this, ignore this email.
```

**Token storage:** In-memory Map with TTL (same pattern as nonce store). For production, move to Redis/postgres.

**API routes (add to auth routes):**
```
POST /auth/email/send     — { email } → sends magic link
GET  /auth/callback/email — { token } → verifies, creates session, redirects
```

**Test:** Unit test for token generation + verification. Integration test with mocked Resend.

---

## Integration Notes (Post-Worker Merge)

After all 5 workers complete, I'll wire everything together in `packages/api/src/index.ts`:

1. Mount platform routes: `app.route("/platform", platformRoutes)`
2. Mount auth routes: `app.route("/auth", authRoutes)`
3. Mount user routes: `app.route("/user", userRoutes)`
4. Add `onUserCreated` hook that calls `provisionUserWallet`
5. Run `drizzle-kit generate` for migration SQL
6. Apply migration to production DB
7. Test E2E: register with passkey → verify wallet created → sign transaction

---

## Environment Variables (New)

```env
# Passkey config
STEWARD_RP_NAME=Steward
STEWARD_RP_ID=steward.fi
STEWARD_ORIGIN=https://steward.fi

# Platform keys (comma-separated)
STEWARD_PLATFORM_KEYS=stw_platform_elizacloud_xxx

# Email auth
STEWARD_EMAIL_FROM=login@steward.fi
RESEND_API_KEY=re_xxx

# Session
STEWARD_SESSION_SECRET=xxx  # falls back to STEWARD_MASTER_PASSWORD
STEWARD_SESSION_EXPIRY=7d
```
