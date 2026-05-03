/**
 * Shared application context — singletons and utilities used across route modules.
 *
 * This module centralises the database, vault, policy engine, webhook dispatcher,
 * tenant config cache, and helper functions so that route files don't each
 * re-instantiate them (which would lead to duplicate connections / inconsistent state).
 */

import { validateApiKey } from "@stwd/auth";
import { getDb, policies, tenants, toPolicyRule, transactions } from "@stwd/db";
import { PolicyEngine } from "@stwd/policy-engine";
import {
  type AgentIdentity,
  type ApiResponse,
  createPriceOracle,
  type PolicyRule,
  type PriceOracle,
  type Tenant,
  type TenantConfig,
} from "@stwd/shared";
import { Vault } from "@stwd/vault";
import { WebhookDispatcher } from "@stwd/webhooks";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Context, Next } from "hono";
import { jwtVerify, SignJWT } from "jose";

// ─── Constants ────────────────────────────────────────────────────────────────

export const API_VERSION = process.env.API_VERSION || "0.3.0";
export const DEFAULT_TENANT_ID = "default";
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_REQUESTS = 100;
export const AGENT_TOKEN_EXPIRY = process.env.AGENT_TOKEN_EXPIRY || "30d";

// ─── JWT helpers ──────────────────────────────────────────────────────────────

const jwtSecretSource = process.env.STEWARD_SESSION_SECRET || process.env.STEWARD_MASTER_PASSWORD;
if (!process.env.STEWARD_SESSION_SECRET && process.env.STEWARD_MASTER_PASSWORD) {
  console.warn(
    "⚠️ STEWARD_SESSION_SECRET not set, falling back to master password. Set a separate JWT secret for production.",
  );
}
if (!jwtSecretSource) {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "⛔ STEWARD_SESSION_SECRET (or STEWARD_MASTER_PASSWORD) must be set in production",
    );
  }
  console.warn(
    "⚠️  [DEV ONLY] Using insecure 'dev-secret' for JWT signing. Set STEWARD_SESSION_SECRET before going to production!",
  );
}
export const JWT_SECRET = new TextEncoder().encode(jwtSecretSource || "dev-secret");
export const JWT_ISSUER = "steward";
export const JWT_EXPIRY = "24h";

export async function createSessionToken(address: string, tenantId: string): Promise<string> {
  return new SignJWT({ address, tenantId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setExpirationTime(JWT_EXPIRY)
    .sign(JWT_SECRET);
}

export async function createAgentToken(
  agentId: string,
  tenantId: string,
  expiresIn?: string,
): Promise<string> {
  return new SignJWT({ agentId, tenantId, scope: "agent" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setExpirationTime(expiresIn || AGENT_TOKEN_EXPIRY)
    .sign(JWT_SECRET);
}

export async function verifySessionToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
    });
    return payload as {
      address: string;
      tenantId: string;
      agentId?: string;
      scope?: string;
      userId?: string;
      email?: string;
    };
  } catch {
    return null;
  }
}

// ─── SIWE nonce store ─────────────────────────────────────────────────────────

export const nonceStore = new Map<string, { nonce: string; expiresAt: number }>();

export const nonceCleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of nonceStore.entries()) {
      if (entry.expiresAt <= now) nonceStore.delete(key);
    }
  },
  5 * 60 * 1000,
);

// ─── Input validation helpers ─────────────────────────────────────────────────

const AGENT_ID_RE = /^[a-zA-Z0-9_\-.:]{1,128}$/;
const TENANT_ID_RE = /^[a-zA-Z0-9_\-.:]{1,64}$/;

export function isValidAgentId(id: unknown): id is string {
  return typeof id === "string" && AGENT_ID_RE.test(id);
}

export function isValidTenantId(id: unknown): id is string {
  return typeof id === "string" && TENANT_ID_RE.test(id);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isValidAddress(value: unknown): boolean {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function isValidSolanaAddress(value: unknown): boolean {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

export function isValidAnyAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.startsWith("0x") ? isValidAddress(value) : isValidSolanaAddress(value);
}

export async function safeJsonParse<T>(c: Context): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const safe = ["already exists", "not found", "Unsupported chain"];
    if (safe.some((s) => error.message.includes(s))) return error.message;
  }
  return "Internal server error";
}

export function isRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  const rpcIndicators = [
    "insufficient funds",
    "insufficient balance",
    "nonce too low",
    "nonce too high",
    "gas too low",
    "gas limit",
    "underpriced",
    "replacement transaction",
    "exceeds block gas limit",
    "execution reverted",
    "out of gas",
    "invalid sender",
    "invalid signature",
    "account not found",
    "blockhash not found",
    "transaction simulation failed",
    "instruction error",
    "custom program error",
    "rpc error",
    "failed to send transaction",
    "transaction failed",
    "0x",
  ];
  return rpcIndicators.some((indicator) => msg.includes(indicator));
}

export function extractRpcErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const innerMatch = error.message.match(/message["\s:]+([^"]+)/i);
    if (innerMatch) return innerMatch[1].trim();
    return error.message;
  }
  return "RPC error";
}

// ─── Environment ──────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const DATABASE_URL = requireEnv("DATABASE_URL");
export const MASTER_PASSWORD = requireEnv("STEWARD_MASTER_PASSWORD");

process.env.DATABASE_URL = DATABASE_URL;

// ─── Singletons ───────────────────────────────────────────────────────────────

export const db = getDb();

export const vault = new Vault({
  masterPassword: MASTER_PASSWORD,
  rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
  chainId: parseInt(process.env.CHAIN_ID || "84532", 10),
});

export const policyEngine = new PolicyEngine();
export const priceOracle: PriceOracle = createPriceOracle({
  cacheTtlMs: 60_000,
});
export const webhookDispatcher = new WebhookDispatcher();

// ─── Tenant config cache ──────────────────────────────────────────────────────

const defaultTenantConfig: TenantConfig = {
  id: DEFAULT_TENANT_ID,
  name: "Default Tenant",
};

export const tenantConfigs = new Map<string, TenantConfig>([
  [defaultTenantConfig.id, defaultTenantConfig],
]);

export const defaultTenantReady = db
  .insert(tenants)
  .values({
    id: DEFAULT_TENANT_ID,
    name: "Default Tenant",
    apiKeyHash: process.env.STEWARD_DEFAULT_TENANT_KEY || "",
  })
  .onConflictDoNothing();

// ─── App variable types ───────────────────────────────────────────────────────

export type AppVariables = {
  tenant: Tenant;
  tenantConfig: TenantConfig;
  tenantId: string;
  userId?: string;
  agentScope?: string;
  authType?: "api-key" | "session-jwt" | "agent-token" | "dashboard-jwt";
};

// ─── Shared query helpers ─────────────────────────────────────────────────────

export function getTenantPayload(tenant: Tenant): Tenant & TenantConfig {
  const config = tenantConfigs.get(tenant.id);
  return {
    ...tenant,
    name: config?.name || tenant.name,
    webhookUrl: config?.webhookUrl,
    defaultPolicies: config?.defaultPolicies,
  };
}

export async function findTenant(tenantId: string): Promise<Tenant | undefined> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  return tenant;
}

export async function ensureAgentForTenant(
  tenantId: string,
  agentId: string,
): Promise<AgentIdentity | undefined> {
  return vault.getAgent(tenantId, agentId);
}

export async function getPolicySet(tenantId: string, agentId: string): Promise<PolicyRule[]> {
  const storedPolicies = await db.select().from(policies).where(eq(policies.agentId, agentId));

  if (storedPolicies.length > 0) return storedPolicies.map(toPolicyRule);
  return tenantConfigs.get(tenantId)?.defaultPolicies || [];
}

export async function getTransactionStats(agentId: string) {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600_000);
  const oneDayAgo = new Date(now.getTime() - 86400_000);
  const oneWeekAgo = new Date(now.getTime() - 604800_000);

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
        gte(transactions.createdAt, oneWeekAgo),
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

// ─── Auth middleware ──────────────────────────────────────────────────────────

export async function tenantAuth(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
  options?: { requireTenantMatch?: string },
) {
  await defaultTenantReady;

  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const payload = await verifySessionToken(token);
    if (payload?.tenantId) {
      const jwtTenant = await findTenant(payload.tenantId);
      if (jwtTenant) {
        if (options?.requireTenantMatch && payload.tenantId !== options.requireTenantMatch) {
          return c.json<ApiResponse>({ ok: false, error: "Forbidden" }, 403);
        }
        c.set("tenantId", payload.tenantId);
        c.set("tenant", jwtTenant);
        c.set(
          "tenantConfig",
          tenantConfigs.get(payload.tenantId) || {
            id: jwtTenant.id,
            name: jwtTenant.name,
          },
        );

        if (payload.userId) c.set("userId", payload.userId);
        if (payload.scope === "agent" && payload.agentId) {
          c.set("agentScope", payload.agentId);
          c.set("authType", "agent-token");
        } else {
          c.set("authType", "session-jwt");
        }
        return next();
      }
    }
  }

  const tenantId = c.req.header("X-Steward-Tenant") || DEFAULT_TENANT_ID;
  const tenant = await findTenant(tenantId);

  if (!tenant) return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);

  if (options?.requireTenantMatch && tenantId !== options.requireTenantMatch) {
    return c.json<ApiResponse>({ ok: false, error: "Forbidden" }, 403);
  }

  const apiKey = c.req.header("X-Steward-Key") || "";

  if (tenant.apiKeyHash) {
    if (!validateApiKey(apiKey, tenant.apiKeyHash)) {
      return c.json<ApiResponse>({ ok: false, error: "Forbidden" }, 403);
    }
  } else {
    if (!apiKey) return c.json<ApiResponse>({ ok: false, error: "API key required" }, 401);
    return c.json<ApiResponse>({ ok: false, error: "Tenant not configured for API key auth" }, 403);
  }

  c.set("tenantId", tenantId);
  c.set("tenant", tenant);
  c.set("tenantConfig", tenantConfigs.get(tenantId) || { id: tenant.id, name: tenant.name });
  c.set("authType", "api-key");

  await next();
}

export async function sessionAuth(c: Context<{ Variables: AppVariables }>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json<ApiResponse>({ ok: false, error: "Authorization header required" }, 401);
  }

  const token = authHeader.slice(7);
  const payload = await verifySessionToken(token);
  if (!payload) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid or expired session token" }, 401);
  }

  const tenant = await findTenant(payload.tenantId);
  if (!tenant) return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);

  c.set("tenantId", payload.tenantId);
  c.set("tenant", tenant);
  c.set(
    "tenantConfig",
    tenantConfigs.get(payload.tenantId) || { id: tenant.id, name: tenant.name },
  );

  await next();
}

export function requireAgentAccess(c: Context<{ Variables: AppVariables }>): boolean {
  const agentScope = c.get("agentScope");
  if (!agentScope) return true;
  return agentScope === c.req.param("agentId");
}

export function requireTenantLevel(c: Context<{ Variables: AppVariables }>): boolean {
  return c.get("authType") !== "agent-token";
}

/**
 * dashboardAuthMiddleware
 * Accepts a session JWT (Bearer token) issued by the auth routes.
 * Extracts userId and tenantId, looks up the tenant, and sets context variables
 * so dashboard routes can make authenticated API calls on behalf of the user.
 *
 * The dashboard is user-centric (not API-key-centric) so only session JWTs are
 * accepted here — no API key fallback.
 */
export async function dashboardAuthMiddleware(c: Context<{ Variables: AppVariables }>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json<ApiResponse>({ ok: false, error: "Authorization header required" }, 401);
  }

  const token = authHeader.slice(7);
  const payload = await verifySessionToken(token);

  if (!payload?.tenantId) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid or expired session token" }, 401);
  }

  const tenant = await findTenant(payload.tenantId);
  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  c.set("tenantId", payload.tenantId);
  c.set("tenant", tenant);
  c.set(
    "tenantConfig",
    tenantConfigs.get(payload.tenantId) || { id: tenant.id, name: tenant.name },
  );
  c.set("authType", "dashboard-jwt");
  if (payload.userId) c.set("userId", payload.userId);

  return next();
}

// Re-export drizzle schemas used in route modules
export {
  agents,
  agentWallets,
  approvalQueue,
  autoApprovalRules,
  encryptedChainKeys,
  encryptedKeys,
  policies,
  tenants,
  toPolicyRule,
  toSignRequest,
  toTxRecord,
  transactions,
  webhookConfigs,
  webhookDeliveries,
} from "@stwd/db";

export type {
  AgentBalance,
  AgentIdentity,
  ApiResponse,
  PolicyRule,
  RpcRequest,
  RpcResponse,
  SignRequest,
  SignSolanaTransactionRequest,
  SignTypedDataRequest,
  Tenant,
  TenantConfig,
} from "@stwd/shared";
