/**
 * user.ts — User-facing wallet routes
 *
 * Route group mounted under `/user` (or wherever the main app mounts it).
 * All routes require a valid JWT session token in the `Authorization: Bearer <token>` header.
 *
 * Routes:
 *   GET  /me                  — current user info
 *   GET  /me/wallet           — wallet address + on-chain balance
 *   POST /me/wallet/sign      — sign a transaction (policy-enforced)
 *   GET  /me/wallet/history   — transaction history
 *   GET  /me/wallet/policies  — view active policies on the user's wallet
 *   POST /me/wallet/sign-message — sign arbitrary message data
 *
 * NOTE: Do NOT import or modify packages/api/src/index.ts.
 *       This file exports a Hono route group ready for mounting.
 */

import {
  getDb,
  policies,
  tenantConfigs,
  tenants,
  toPolicyRule,
  toTxRecord,
  transactions,
  userTenants,
} from "@stwd/db";
import { PolicyEngine } from "@stwd/policy-engine";
import type {
  AgentBalance,
  AgentIdentity,
  ApiResponse,
  PolicyRule,
  SignRequest,
} from "@stwd/shared";
import {
  getUserWallet,
  provisionUserWallet,
  USER_WALLET_DEFAULT_POLICIES,
  Vault,
} from "@stwd/vault";
import { and, eq, sql } from "drizzle-orm";
import { type Context, Hono, type Next } from "hono";
import { jwtVerify } from "jose";

// ─── Config ───────────────────────────────────────────────────────────────────

const _jwtSecretSrc = process.env.STEWARD_SESSION_SECRET || process.env.STEWARD_MASTER_PASSWORD;
if (!_jwtSecretSrc) {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "⛔ STEWARD_SESSION_SECRET (or STEWARD_MASTER_PASSWORD) must be set in production",
    );
  }
  console.warn(
    "⚠️  [DEV ONLY] Using insecure 'dev-secret' for JWT signing. Set STEWARD_SESSION_SECRET before going to production!",
  );
}
const JWT_SECRET = new TextEncoder().encode(_jwtSecretSrc || "dev-secret");
const JWT_ISSUER = "steward";

// ─── Session payload types ────────────────────────────────────────────────────

interface UserSessionPayload {
  userId: string;
  address?: string;
  email?: string;
  tenantId?: string;
  [key: string]: unknown;
}

type UserVariables = {
  userId: string;
  userSession: UserSessionPayload;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function safeJsonParse<T>(c: Context): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

function isValidAddress(value: unknown): boolean {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Build a Vault instance from environment. Same defaults as index.ts. */
function getVault(): Vault {
  const masterPassword = process.env.STEWARD_MASTER_PASSWORD;
  if (!masterPassword) {
    throw new Error("STEWARD_MASTER_PASSWORD is required");
  }
  return new Vault({
    masterPassword,
    rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
    chainId: parseInt(process.env.CHAIN_ID || "84532", 10),
  });
}

async function getTransactionStats(agentId: string) {
  const db = getDb();
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3_600_000);
  const oneDayAgo = new Date(now.getTime() - 86_400_000);
  const oneWeekAgo = new Date(now.getTime() - 604_800_000);

  const oneHourAgoStr = oneHourAgo.toISOString();
  const oneDayAgoStr = oneDayAgo.toISOString();

  const [stats] = await db
    .select({
      recentTxCount1h: sql<number>`count(*) filter (where ${transactions.createdAt} >= ${oneHourAgoStr}::timestamptz)`,
      recentTxCount24h: sql<number>`count(*) filter (where ${transactions.createdAt} >= ${oneDayAgoStr}::timestamptz)`,
      spentToday: sql<string>`
        coalesce(
          sum(
            case
              when ${transactions.createdAt} >= ${oneDayAgoStr}::timestamptz then (${transactions.value})::numeric
              else 0
            end
          ),
          0
        )::text
      `,
      spentThisWeek: sql<string>`coalesce(sum((${transactions.value})::numeric), 0)::text`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.agentId, agentId),
        sql`${transactions.createdAt} >= ${oneWeekAgo.toISOString()}::timestamptz`,
        sql`${transactions.status} in ('signed', 'broadcast', 'confirmed')`,
      ),
    );

  return {
    recentTxCount1h: Number(stats?.recentTxCount1h ?? 0),
    recentTxCount24h: Number(stats?.recentTxCount24h ?? 0),
    spentToday: BigInt(stats?.spentToday ?? "0"),
    spentThisWeek: BigInt(stats?.spentThisWeek ?? "0"),
  };
}

// ─── Session auth middleware ──────────────────────────────────────────────────

/**
 * Reads `Authorization: Bearer <jwt>`, verifies it with jose, and populates
 * `c.get("userId")` + `c.get("userSession")` for downstream handlers.
 *
 * The JWT is expected to contain either:
 *   - `userId`  (user-wallet / passkey session), OR
 *   - `address` + `tenantId` (SIWE session from index.ts — address used as userId)
 *
 * This keeps us compatible with both session styles without breaking the main API.
 */
async function userSessionAuth(
  c: Context<{ Variables: UserVariables }>,
  next: Next,
): Promise<Response | undefined> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json<ApiResponse>(
      { ok: false, error: "Authorization: Bearer <token> header is required" },
      401,
    );
  }

  const token = authHeader.slice(7);

  let payload: UserSessionPayload;
  try {
    const result = await jwtVerify(token, JWT_SECRET, { issuer: JWT_ISSUER });
    payload = result.payload as unknown as UserSessionPayload;
  } catch {
    return c.json<ApiResponse>({ ok: false, error: "Invalid or expired session token" }, 401);
  }

  // Support both userId (new) and address (SIWE legacy)
  const userId = (payload.userId as string | undefined) || (payload.address as string | undefined);
  if (!userId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Session token missing userId or address claim" },
      401,
    );
  }

  c.set("userId", userId);
  c.set("userSession", { ...payload, userId });

  await next();
}

// ─── Route group ──────────────────────────────────────────────────────────────

const user = new Hono<{ Variables: UserVariables }>();

// Apply session auth to all routes in this group
user.use("*", userSessionAuth);

// ─── GET /me ─────────────────────────────────────────────────────────────────

user.get("/me", async (c) => {
  const session = c.get("userSession");
  const userId = c.get("userId");

  // Check if the user already has a wallet provisioned
  let walletInfo: { address: string; agentId: string } | null = null;
  try {
    const vault = getVault();
    const wallet = await getUserWallet(vault, userId);
    if (wallet) {
      walletInfo = { address: wallet.walletAddress, agentId: wallet.id };
    }
  } catch {
    // Non-fatal — wallet may not be provisioned yet
  }

  return c.json<
    ApiResponse<{
      userId: string;
      address?: string;
      email?: string;
      wallet: { address: string; agentId: string } | null;
    }>
  >({
    ok: true,
    data: {
      userId,
      address: session.address as string | undefined,
      email: session.email as string | undefined,
      wallet: walletInfo,
    },
  });
});

// ─── GET /me/wallet ───────────────────────────────────────────────────────────

user.get("/me/wallet", async (c) => {
  const userId = c.get("userId");

  let vault: Vault;
  try {
    vault = getVault();
  } catch (_e) {
    return c.json<ApiResponse>({ ok: false, error: "Vault not configured" }, 503);
  }

  // Auto-provision if not yet created
  let wallet: AgentIdentity | null = await getUserWallet(vault, userId);
  if (!wallet) {
    try {
      const session = c.get("userSession");
      const displayName = (session.address as string | undefined) ?? userId;
      const _result = await provisionUserWallet(vault, userId, displayName);
      wallet = await getUserWallet(vault, userId);
      if (!wallet) throw new Error("Provision succeeded but agent not found");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return c.json<ApiResponse>({ ok: false, error: `Failed to provision wallet: ${msg}` }, 500);
    }
  }

  const chainIdParam = c.req.query("chainId");
  const chainId = chainIdParam ? parseInt(chainIdParam, 10) : undefined;

  try {
    const balance = await vault.getBalance(`personal-${userId}`, wallet.id, chainId);

    return c.json<ApiResponse<AgentBalance>>({
      ok: true,
      data: {
        agentId: wallet.id,
        walletAddress: wallet.walletAddress,
        balances: {
          native: balance.native.toString(),
          nativeFormatted: balance.nativeFormatted,
          chainId: balance.chainId,
          symbol: balance.symbol,
        },
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return c.json<ApiResponse>({ ok: false, error: msg }, 500);
  }
});

// ─── POST /me/wallet/sign ─────────────────────────────────────────────────────

user.post("/me/wallet/sign", async (c) => {
  const userId = c.get("userId");

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>({ ok: false, error: "Vault not configured" }, 503);
  }

  const wallet = await getUserWallet(vault, userId);
  if (!wallet) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "No wallet found — call GET /me/wallet first to provision",
      },
      404,
    );
  }

  const body = await safeJsonParse<Omit<SignRequest, "agentId" | "tenantId">>(c);
  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (!isNonEmptyString(body.to)) {
    return c.json<ApiResponse>({ ok: false, error: "'to' address is required" }, 400);
  }
  if (!isValidAddress(body.to)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "'to' must be a valid Ethereum address (0x + 40 hex chars)",
      },
      400,
    );
  }
  if (body.value === undefined || body.value === null) {
    return c.json<ApiResponse>(
      { ok: false, error: "'value' is required (wei amount as string)" },
      400,
    );
  }

  const tenantId = `personal-${userId}`;
  const agentId = wallet.id;
  const signRequest: SignRequest = { ...body, tenantId, agentId };

  // Fetch active policies
  const db = getDb();
  const storedPolicies = await db.select().from(policies).where(eq(policies.agentId, agentId));

  const policySet: PolicyRule[] =
    storedPolicies.length > 0 ? storedPolicies.map(toPolicyRule) : USER_WALLET_DEFAULT_POLICIES;

  const stats = await getTransactionStats(agentId);
  const engine = new PolicyEngine();
  const evaluation = await engine.evaluate(policySet, {
    request: signRequest,
    recentTxCount1h: stats.recentTxCount1h,
    recentTxCount24h: stats.recentTxCount24h,
    spentToday: stats.spentToday,
    spentThisWeek: stats.spentThisWeek,
  });

  if (!evaluation.approved) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Transaction rejected by policy",
        data: { results: evaluation.results },
      },
      403,
    );
  }

  try {
    const txId = crypto.randomUUID();
    const txHash = await vault.signTransaction(signRequest, {
      txId,
      policyResults: evaluation.results,
      status: "signed",
    });

    return c.json<ApiResponse<{ txId: string; txHash: string }>>({
      ok: true,
      data: { txId, txHash },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error(`[UserWallet] Sign failed for user "${userId}":`, e);
    return c.json<ApiResponse>({ ok: false, error: msg }, 500);
  }
});

// ─── GET /me/wallet/history ───────────────────────────────────────────────────

user.get("/me/wallet/history", async (c) => {
  const userId = c.get("userId");

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>({ ok: false, error: "Vault not configured" }, 503);
  }

  const wallet = await getUserWallet(vault, userId);
  if (!wallet) {
    return c.json<ApiResponse<[]>>({ ok: true, data: [] });
  }

  const db = getDb();
  const history = await db.select().from(transactions).where(eq(transactions.agentId, wallet.id));

  return c.json<ApiResponse>({
    ok: true,
    data: history.map(toTxRecord),
  });
});

// ─── GET /me/wallet/policies ──────────────────────────────────────────────────

user.get("/me/wallet/policies", async (c) => {
  const userId = c.get("userId");

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>({ ok: false, error: "Vault not configured" }, 503);
  }

  const wallet = await getUserWallet(vault, userId);
  if (!wallet) {
    // No wallet yet — return the defaults so the user can preview them
    return c.json<ApiResponse<PolicyRule[]>>({
      ok: true,
      data: USER_WALLET_DEFAULT_POLICIES,
    });
  }

  const db = getDb();
  const storedPolicies = await db.select().from(policies).where(eq(policies.agentId, wallet.id));

  const activePolicies: PolicyRule[] =
    storedPolicies.length > 0 ? storedPolicies.map(toPolicyRule) : USER_WALLET_DEFAULT_POLICIES;

  return c.json<ApiResponse<PolicyRule[]>>({ ok: true, data: activePolicies });
});

// ─── POST /me/wallet/sign-message ─────────────────────────────────────────────

user.post("/me/wallet/sign-message", async (c) => {
  const userId = c.get("userId");

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>({ ok: false, error: "Vault not configured" }, 503);
  }

  const wallet = await getUserWallet(vault, userId);
  if (!wallet) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "No wallet found — call GET /me/wallet first to provision",
      },
      404,
    );
  }

  const body = await safeJsonParse<{ message: string }>(c);
  if (!body || !isNonEmptyString(body.message)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "'message' is required and must be a non-empty string",
      },
      400,
    );
  }

  try {
    const signature = await vault.signMessage(`personal-${userId}`, wallet.id, body.message);

    return c.json<ApiResponse<{ signature: string; address: string }>>({
      ok: true,
      data: { signature, address: wallet.walletAddress },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error(`[UserWallet] sign-message failed for user "${userId}":`, e);
    return c.json<ApiResponse>({ ok: false, error: msg }, 500);
  }
});

// ─── POST /me/wallet/export ────────────────────────────────────────────────────

user.post("/me/wallet/export", async (c) => {
  const userId = c.get("userId");

  let vault: Vault;
  try {
    vault = getVault();
  } catch {
    return c.json<ApiResponse>({ ok: false, error: "Vault not configured" }, 503);
  }

  const wallet = await getUserWallet(vault, userId);
  if (!wallet) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "No wallet found — call GET /me/wallet first to provision",
      },
      404,
    );
  }

  const personalTenantId = `personal-${userId}`;

  try {
    const keys = await vault.exportPrivateKey(personalTenantId, wallet.id);

    return c.json<
      ApiResponse<{
        evm?: { privateKey: string; address: string };
        solana?: { privateKey: string; address: string };
        warning: string;
      }>
    >({
      ok: true,
      data: {
        ...keys,
        warning: "This key controls real funds. Store securely.",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error(`[UserWallet] export failed for user "${userId}":`, e);
    return c.json<ApiResponse>({ ok: false, error: msg }, 500);
  }
});

// ─── Tenant membership routes ─────────────────────────────────────────────────

/**
 * GET /me/tenants
 * List all tenants the authenticated user belongs to.
 */
user.get("/me/tenants", async (c) => {
  const userId = c.get("userId");
  const db = getDb();

  const memberships = await db
    .select({
      tenantId: userTenants.tenantId,
      tenantName: tenants.name,
      role: userTenants.role,
      joinedAt: userTenants.createdAt,
    })
    .from(userTenants)
    .innerJoin(tenants, eq(userTenants.tenantId, tenants.id))
    .where(eq(userTenants.userId, userId));

  return c.json<ApiResponse<typeof memberships>>({
    ok: true,
    data: memberships,
  });
});

/**
 * GET /me/tenants/:tenantId
 * Get single tenant membership info for the authenticated user.
 */
user.get("/me/tenants/:tenantId", async (c) => {
  const userId = c.get("userId");
  const tenantId = c.req.param("tenantId");
  const db = getDb();

  const [membership] = await db
    .select({
      tenantId: userTenants.tenantId,
      tenantName: tenants.name,
      role: userTenants.role,
      joinedAt: userTenants.createdAt,
    })
    .from(userTenants)
    .innerJoin(tenants, eq(userTenants.tenantId, tenants.id))
    .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)));

  if (!membership) {
    return c.json<ApiResponse>({ ok: false, error: "Not a member of this tenant" }, 404);
  }

  return c.json<ApiResponse<typeof membership>>({ ok: true, data: membership });
});

/**
 * POST /me/tenants/:tenantId/join
 * Join a tenant that has join_mode = 'open'.
 */
user.post("/me/tenants/:tenantId/join", async (c) => {
  const userId = c.get("userId");
  const tenantId = c.req.param("tenantId");
  const db = getDb();

  // 1. Verify tenant exists
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  // 2. Check if already a member
  const [existing] = await db
    .select({ id: userTenants.id })
    .from(userTenants)
    .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)));

  if (existing) {
    return c.json({ ok: true, tenantId, role: "member", alreadyMember: true });
  }

  // 3. Check join_mode
  const [config] = await db
    .select({ joinMode: tenantConfigs.joinMode })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  const joinMode = config?.joinMode ?? "open";

  if (joinMode !== "open") {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `Tenant is not open for joining (mode: ${joinMode})`,
      },
      403,
    );
  }

  // 4. Create membership
  await db.insert(userTenants).values({ userId, tenantId, role: "member" }).onConflictDoNothing();

  return c.json({ ok: true, tenantId, role: "member" });
});

/**
 * DELETE /me/tenants/:tenantId/leave
 * Leave a tenant. Cannot leave personal tenant.
 */
user.delete("/me/tenants/:tenantId/leave", async (c) => {
  const userId = c.get("userId");
  const tenantId = c.req.param("tenantId");

  // Cannot leave personal tenant
  if (tenantId === `personal-${userId}`) {
    return c.json<ApiResponse>({ ok: false, error: "Cannot leave your personal tenant" }, 400);
  }

  const db = getDb();
  const [deleted] = await db
    .delete(userTenants)
    .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)))
    .returning();

  if (!deleted) {
    return c.json<ApiResponse>({ ok: false, error: "Not a member of this tenant" }, 404);
  }

  return c.json<ApiResponse>({ ok: true });
});

export { user as userRoutes };
