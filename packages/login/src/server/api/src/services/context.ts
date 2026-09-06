/**
 * Shared application context — singletons and utilities used across route modules.
 *
 * This module centralises the database, vault, policy engine, webhook dispatcher,
 * tenant config cache, and helper functions so that route files don't each
 * re-instantiate them (which would lead to duplicate connections / inconsistent state).
 */

import { logger } from "@elizaos/logger";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Context, Next } from "hono";
import {
  ACCESS_TOKEN_EXPIRY,
  assertTokenNotRevoked,
  getAgentTokenExpiry,
  signAccessToken,
  signAgentToken,
  validateApiKey,
  verifyToken,
} from "../../../auth/src/index.ts";
import {
  agents,
  conditionSetItems,
  conditionSets,
  getDatabaseDriver,
  getDb,
  hasTenantTransactionDatabase,
  inArray,
  operatorTransferReservations,
  policies,
  sessionSigners,
  type TenantTransactionCharacteristics,
  tenantContextFromAuthenticatedPrincipal,
  toPolicyRule,
  transactions,
  users,
  withTenantRlsTransaction,
  withTenantTransactionDatabase,
} from "../../../db/src/index.ts";
import {
  type AggregationLookup,
  aggregationLookupFromMap,
  aggregationQueriesForPolicies,
  aggregationQueryKey,
  PolicyEngine,
} from "../../../policy-engine/src/index.ts";
import { getAggregationSnapshot } from "../../../redis/src/index.ts";
import {
  type AgentIdentity,
  type ApiResponse,
  createPriceOracle,
  type PolicyRule,
  type PriceOracle,
  redactedThrownDiagnostics,
  type SignRequest,
  type Tenant,
  type TenantConfig,
} from "../../../shared/src/index.ts";
import type { Vault } from "../../../vault/src/index.ts";
import { WebhookDispatcher } from "../../../webhooks/src/index.ts";
import { sanitizePublicError } from "./public-error";
import { getConfiguredVault } from "./vault-factory";

// ─── Constants ────────────────────────────────────────────────────────────────

// Re-export for existing callers while keeping the version constant available
// from a dependency-light module for audit signing and maintenance scripts.
export { API_VERSION } from "./version";
export const DEFAULT_TENANT_ID = "default";

/**
 * Read a positive-integer env override, falling back to a safe default when the
 * variable is unset or malformed. Used for operator-tunable limits so a bad
 * value can never silently disable a guard — it just reverts to the default.
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

// Global in-memory request rate limit (Bun entry only). Operator-tunable via env
// so load tests and local e2e suites — which hammer a single socket IP far harder
// than any real client — can raise the ceiling without changing the production
// default (100 requests / 60s per client IP). A missing or invalid override
// falls back to that default, so this can never weaken the guard unintentionally.
export const RATE_LIMIT_WINDOW_MS = positiveIntEnv(
  "STEWARD_RATE_LIMIT_WINDOW_MS",
  60_000,
);
export const RATE_LIMIT_MAX_REQUESTS = positiveIntEnv(
  "STEWARD_RATE_LIMIT_MAX_REQUESTS",
  100,
);
// ─── JWT helpers ──────────────────────────────────────────────────────────────

/**
 * User access token TTL. Refresh tokens (30d) handle long-lived sessions.
 */
export const JWT_EXPIRY = ACCESS_TOKEN_EXPIRY;
export const AGENT_SCOPE = "agent";
export const PROXY_SCOPE = "api:proxy";
/** Scope prefix on tokens minted by the capability issuance layer
 * (`cap:<manifest>`, see @stwd/plugin-capabilities — the core never imports
 * plugin packages, so the prefix is mirrored here). These are least-privilege
 * credentials for the capability surface ONLY; the tenant gate below refuses
 * them so they can never act as general agent credentials. */
export const CAPABILITY_TOKEN_SCOPE_PREFIX = "cap:";

export function normalizeAgentTokenScopes(scopes?: string[]): string[] {
  if (!scopes || scopes.length === 0) return [AGENT_SCOPE];
  const normalized = new Set<string>();
  for (const scope of scopes ?? []) {
    if (typeof scope === "string" && scope.trim()) {
      normalized.add(scope.trim());
    }
  }
  return normalized.size > 0 ? [...normalized] : [AGENT_SCOPE];
}

export function parseAgentTokenScopes(value: unknown): string[] | null {
  if (value === undefined || value === null || value === "") {
    return [AGENT_SCOPE];
  }

  const requested = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;

  if (!requested || !requested.every((scope) => typeof scope === "string"))
    return null;

  const scopes = normalizeAgentTokenScopes(
    requested.map((scope) => scope.trim()).filter(Boolean),
  );
  return scopes.every((scope) => scope === AGENT_SCOPE || scope === PROXY_SCOPE)
    ? scopes
    : null;
}

export function hasAgentTokenScope(
  scopes: readonly string[] | undefined,
  required = AGENT_SCOPE,
): boolean {
  return Boolean(scopes?.includes(required));
}

export function setNoStoreHeaders(c: Pick<Context, "header">): void {
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
}

export async function createSessionToken(
  address: string,
  tenantId: string,
): Promise<string> {
  return signAccessToken({ address, tenantId }, JWT_EXPIRY);
}

export async function createAgentToken(
  agentId: string,
  tenantId: string,
  expiresIn?: string,
  scopes?: string[],
): Promise<string> {
  const tokenScopes = normalizeAgentTokenScopes(scopes);
  return signAgentToken(
    { agentId, tenantId, scopes: tokenScopes },
    expiresIn || getAgentTokenExpiry(),
  );
}

/** Mint while holding the same agent-row lock used by deletion. */
export async function createAgentTokenForExistingAgent(
  agentId: string,
  tenantId: string,
  expiresIn?: string,
  scopes?: string[],
): Promise<string | null> {
  return getDb().transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
      .for("update");
    if (!agent) return null;
    return createAgentToken(agentId, tenantId, expiresIn, scopes);
  });
}

export async function verifySessionToken(token: string) {
  try {
    const payload = (await verifyToken(token)) as {
      address: string;
      tenantId: string;
      agentId?: string;
      scope?: string;
      scopes?: string[];
      typ?: string;
      tokenType?: string;
      userId?: string;
      email?: string;
      mfaVerifiedAt?: number;
      mfaMethod?: string;
      jti?: string;
      exp?: number;
      iat?: number;
      authMethod?: string;
      factorEnrollmentVerifiedAt?: number;
    };
    if (payload.typ === "identity") return null;
    // Never accept a refresh JWT as an access token (SEC-055).
    if (payload.tokenType === "refresh") return null;
    await assertTokenNotRevoked(payload);
    if (payload.userId) {
      const [user] = payload.tenantId
        ? rowsFromDbResult<{
            deactivated_at: Date | string | null;
            is_guest: boolean;
            guest_expires_at: Date | string | null;
            membership_role: string | null;
          }>(
            await getDb().execute(sql`
              SELECT * FROM steward_bootstrap.session_subject(
                ${payload.userId}::uuid,
                ${payload.tenantId}
              )
            `),
          )
        : await getDb()
            .select({
              deactivated_at: users.deactivatedAt,
              is_guest: users.isGuest,
              guest_expires_at: users.guestExpiresAt,
              membership_role: sql<string | null>`NULL`,
            })
            .from(users)
            .where(eq(users.id, payload.userId));
      if (!user || user.deactivated_at) return null;
      // Fail-closed guest expiry: enforce the guest's hard expiry against the
      // authoritative DB column, not just the access-token `exp`. A refreshed
      // access token (or one minted with a longer TTL) is still rejected once
      // the guest window has elapsed. Full accounts have guestExpiresAt = null.
      const guestExpiresAt = user.guest_expires_at
        ? new Date(user.guest_expires_at)
        : null;
      if (
        user.is_guest &&
        guestExpiresAt &&
        guestExpiresAt.getTime() <= Date.now()
      ) {
        return null;
      }
      if (payload.tenantId && !user.membership_role) return null;
    }
    return payload;
  } catch {
    // error-policy:J1 reject credentials when signature or session authority validation fails.
    return null;
  }
}

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
  return (
    typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
  );
}

export function isValidAnyAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.startsWith("0x")
    ? isValidAddress(value)
    : isValidSolanaAddress(value);
}

export async function safeJsonParse<T>(c: Context): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

export function sanitizeErrorMessage(error: unknown): string {
  return sanitizePublicError(error);
}

export { PublicApiError } from "./public-error";
export { extractRpcErrorMessage, isRpcError } from "./rpc-error";

// ─── Environment ──────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const isPGLiteRuntime =
  process.env.STEWARD_DB_MODE === "pglite" ||
  process.env.STEWARD_PGLITE_MEMORY === "true";

export const DATABASE_URL =
  process.env.DATABASE_URL?.trim() ||
  (isPGLiteRuntime ? "" : requireEnv("DATABASE_URL"));
export const MASTER_PASSWORD = requireEnv("STEWARD_MASTER_PASSWORD");

if (process.env.DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

// ─── Singletons ───────────────────────────────────────────────────────────────

// `db` is a late-bound Proxy over getDb() rather than a captured handle.
//
// In production this is behaviorally identical to `const db = getDb()`:
// getDb() memoizes a single `globalDb` connection on first call and returns
// that same handle on every subsequent call, so each property access resolves
// to the one real connection.
//
// The reason for the Proxy is the test harness: the api suite runs all ~135
// test files in ONE `bun test` process, and Bun shares the module registry, so
// context.ts evaluates exactly once — a captured `const db = getDb()` would
// freeze whichever file imported a route first and route every later file's
// writes to that stale db. Resolving getDb() per access instead picks up each
// file's own setPGLiteOverride(). Methods are bound to the live handle so
// Drizzle's internal `this` (private session/dialect fields) stays intact.
type DbHandle = ReturnType<typeof getDb>;
export const db: DbHandle = new Proxy({} as DbHandle, {
  get(_target, property) {
    const active = getDb() as unknown as Record<PropertyKey, unknown>;
    const value = active[property];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(active)
      : value;
  },
});

// `vault` is a late-bound Proxy resolving the Vault for the CURRENT master
// password, memoized per password. In production STEWARD_MASTER_PASSWORD is
// fixed before this module loads, so exactly one Vault is ever built and every
// access returns it — behaviorally identical to `const vault = new Vault(...)`.
//
// In the single-process api test suite, individual files set their own
// STEWARD_MASTER_PASSWORD in beforeAll, and a few construct their OWN Vault with
// that password to seal keys directly into their per-file PGLite db. A captured
// singleton would have frozen the first (preload) password, so the route-level
// vault could not decrypt keys those files sealed under a different password —
// surfacing as AES-GCM "Unsupported state or unable to authenticate data". A
// per-password memo keeps the route vault in lockstep with whatever password
// sealed each key. MASTER_PASSWORD (captured at import) is the fallback when the
// env var is transiently unset (e.g. another file's afterAll deleted it).
function activeVault(): Vault {
  return getConfiguredVault({ fallbackPassword: MASTER_PASSWORD });
}
export const vault: Vault = new Proxy({} as Vault, {
  get(_target, property) {
    const active = activeVault() as unknown as Record<PropertyKey, unknown>;
    const value = active[property];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(active)
      : value;
  },
  // Forward assignments to the live instance. Production never mutates the
  // vault; this exists so tests that monkeypatch a method (e.g.
  // `context.vault.getBalance = mock`) and restore it in a `finally` land on
  // the same per-password instance the get trap resolves — without a set trap
  // the assignment would silently write to the empty Proxy target and the get
  // trap would keep returning the real method.
  set(_target, property, value) {
    (activeVault() as unknown as Record<PropertyKey, unknown>)[property] =
      value;
    return true;
  },
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

/** Initializes the default tenant against the current database before the listener opens. */
export async function initializeDefaultTenant(): Promise<void> {
  await db.execute(sql`
    SELECT steward_bootstrap.ensure_default_tenant(${process.env.STEWARD_DEFAULT_TENANT_KEY || ""})
  `);
}

// ─── App variable types ───────────────────────────────────────────────────────

export type AuthenticatedPrincipal = {
  type: "tenant" | "user" | "agent";
  id: string;
};

function rowsFromDbResult<T>(result: unknown): T[] {
  return (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] })?.rows ?? [])
  ) as T[];
}

// AppVariables now lives in @stwd/shared so opt-in plugins can type their own
// hono routes against the same per-request context WITHOUT importing @stwd/api
// (which would be a circular dependency). imported for local use in this file's
// type positions AND re-exported so the many existing
// `import { AppVariables } from "../services/context"` sites keep working.
import type { AppVariables } from "../../../shared/src/index.ts";

export type { AppVariables };

// ─── Shared query helpers ─────────────────────────────────────────────────────

export function getTenantPayload(
  tenant: Tenant,
): Omit<Tenant, "apiKeyHash"> & TenantConfig {
  const config = tenantConfigs.get(tenant.id);
  const { apiKeyHash: _apiKeyHash, ...safeTenant } = tenant;
  return {
    ...safeTenant,
    name: config?.name || tenant.name,
    webhookUrl: config?.webhookUrl,
    defaultPolicies: config?.defaultPolicies,
  };
}

function parseAppId(
  value: string | undefined | null,
): { tenantId: string; clientId: string } | null {
  if (!value) return null;
  const index = value.lastIndexOf("/");
  if (index <= 0 || index >= value.length - 1) return null;
  const tenantId = value.slice(0, index);
  const clientId = value.slice(index + 1);
  if (
    !isValidTenantId(tenantId) ||
    !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(clientId)
  )
    return null;
  return { tenantId, clientId };
}

function parseBasicAuth(
  value: string | undefined | null,
): { username: string; password: string } | null {
  if (!value?.startsWith("Basic ")) return null;
  let decoded = "";
  try {
    decoded = atob(value.slice(6));
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator <= 0) return null;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

export async function findTenant(
  tenantId: string,
): Promise<Tenant | undefined> {
  const [row] = rowsFromDbResult<{
    id: string;
    name: string;
    api_key_hash: string;
    owner_address: string | null;
    created_at: Date | string;
    updated_at: Date | string;
  }>(
    await getDb().execute(
      sql`SELECT * FROM steward_bootstrap.tenant_api_key_subject(${tenantId})`,
    ),
  );
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    apiKeyHash: row.api_key_hash,
    createdAt: new Date(row.created_at),
  };
}

async function findUserTenantMembership(userId: string, tenantId: string) {
  const [subject] = rowsFromDbResult<{ membership_role: string | null }>(
    await getDb().execute(
      sql`SELECT membership_role FROM steward_bootstrap.session_subject(${userId}::uuid, ${tenantId})`,
    ),
  );
  return subject?.membership_role ? { role: subject.membership_role } : null;
}

async function findAgentBootstrapSubject(
  tenantId: string,
  agentId: string,
  jti?: string,
) {
  const [row] = rowsFromDbResult<{
    agent_id: string;
    agent_name: string;
    wallet_address: string;
    signer_id: string | null;
    signer_policy_ids: string[] | null;
    signer_expires_at: Date | string | null;
    signer_revoked_at: Date | string | null;
  }>(
    await getDb().execute(sql`
      SELECT * FROM steward_bootstrap.agent_subject(${agentId}, ${tenantId}, ${jti ?? null})
    `),
  );
  return row ?? null;
}

export async function ensureAgentForTenant(
  tenantId: string,
  agentId: string,
): Promise<AgentIdentity | undefined> {
  return vault.getAgent(tenantId, agentId);
}

export async function getPolicySet(
  tenantId: string,
  agentId: string,
): Promise<PolicyRule[]> {
  const storedPolicies = await db
    .select()
    .from(policies)
    .where(eq(policies.agentId, agentId));

  if (storedPolicies.length > 0) return storedPolicies.map(toPolicyRule);
  return tenantConfigs.get(tenantId)?.defaultPolicies || [];
}

export async function getScopedPolicySet(
  tenantId: string,
  agentId: string,
  policyIds: readonly string[] | undefined,
): Promise<PolicyRule[]> {
  if (!policyIds || policyIds.length === 0)
    return getPolicySet(tenantId, agentId);

  const uniquePolicyIds = [
    ...new Set(policyIds.filter((id) => typeof id === "string" && id)),
  ];
  if (uniquePolicyIds.length === 0) return [];

  const storedPolicies = await db
    .select()
    .from(policies)
    .where(
      and(eq(policies.agentId, agentId), inArray(policies.id, uniquePolicyIds)),
    );

  return storedPolicies.map(toPolicyRule);
}

export async function loadConditionSetsForPolicies(
  tenantId: string,
  policySet: PolicyRule[],
): Promise<Record<string, string[]>> {
  const ids = getConditionSetIdsFromPolicies(policySet);

  if (ids.length === 0) return {};

  const existingSets = await db
    .select({ id: conditionSets.id })
    .from(conditionSets)
    .where(
      and(eq(conditionSets.tenantId, tenantId), inArray(conditionSets.id, ids)),
    );
  const existingIds = existingSets.map((row) => row.id);

  if (existingIds.length === 0) return {};

  const rows = await db
    .select({
      conditionSetId: conditionSetItems.conditionSetId,
      value: conditionSetItems.value,
    })
    .from(conditionSetItems)
    .where(
      and(
        eq(conditionSetItems.tenantId, tenantId),
        inArray(conditionSetItems.conditionSetId, existingIds),
      ),
    );

  const loaded: Record<string, string[]> = {};
  for (const id of existingIds) loaded[id] = [];
  for (const row of rows) loaded[row.conditionSetId].push(row.value);
  return loaded;
}

export function getConditionSetIdsFromPolicies(
  policySet: PolicyRule[],
): string[] {
  return Array.from(
    new Set(
      policySet
        .filter((policy) => policy.type === "condition-set")
        .map((policy) => policy.config.conditionSetId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
}

export async function getConditionSetReferenceValidationError(
  tenantId: string,
  policySet: PolicyRule[],
): Promise<string | null> {
  const ids = getConditionSetIdsFromPolicies(policySet);
  if (ids.length === 0) return null;

  const existingRows = await db
    .select({ id: conditionSets.id })
    .from(conditionSets)
    .where(
      and(eq(conditionSets.tenantId, tenantId), inArray(conditionSets.id, ids)),
    );
  const existingIds = new Set(existingRows.map((row) => row.id));
  const missingIds = ids.filter((id) => !existingIds.has(id));

  if (missingIds.length > 0) {
    return `condition-set.conditionSetId not found for tenant: ${missingIds.join(", ")}`;
  }

  return null;
}

/**
 * Materialise the rolling-aggregate lookup for a policy set's `aggregation`
 * conditions. Snapshots are computed from the authoritative Redis tracker —
 * never from caller-supplied request fields — and exposed to the engine as a
 * synchronous lookup. Any snapshot that cannot be sourced is simply omitted
 * from the map, which makes the evaluator fail closed (deny) for that
 * condition.
 *
 * Callers wire the returned lookup onto the `aggregations` field of the
 * evaluation context. The recording side (recordAggregationEvent) must be
 * driven on transaction commit, inside the same per-agent serialization window
 * used for spend caps, so the aggregate cannot be raced.
 */
export async function loadAggregationsForPolicies(
  policySet: PolicyRule[],
  request: SignRequest,
  now: number = Date.now(),
): Promise<AggregationLookup> {
  const queries = aggregationQueriesForPolicies(policySet, request);
  if (queries.length === 0) return aggregationLookupFromMap(new Map());

  const snapshots = new Map<string, bigint>();
  await Promise.all(
    queries.map(async (query) => {
      const value = await getAggregationSnapshot(
        {
          agentId: query.agentId,
          metric: query.metric,
          windowSeconds: query.windowSeconds,
          scope: query.scope,
          scopeKey: query.scopeKey,
        },
        now,
      );
      // null → unavailable; leave it out so the evaluator denies that condition.
      if (value !== null) snapshots.set(aggregationQueryKey(query), value);
    }),
  );

  return aggregationLookupFromMap(snapshots);
}

export async function getTransactionStats(agentId: string, chainId?: number) {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600_000);
  const oneDayAgo = new Date(now.getTime() - 86400_000);
  const oneWeekAgo = new Date(now.getTime() - 604800_000);

  const oneHourAgoStr = oneHourAgo.toISOString();
  const oneDayAgoStr = oneDayAgo.toISOString();

  // Spend caps for native value are denominated in a single chain's base unit
  // (wei for EVM, lamports/SPL base units for Solana). The `value` column holds
  // raw per-chain base units, so summing across chains and re-pricing the total
  // at one chain's native price corrupts the cap (issue #110). When a chainId is
  // supplied, scope the spend aggregates to that chain so the counters stay in a
  // single consistent unit. When omitted, the fragment is empty and the result
  // is byte-for-byte the prior cross-chain sum (used by display-only callers).
  const chainFilter =
    chainId === undefined
      ? sql``
      : sql` and ${transactions.chainId} = ${chainId}`;

  const [stats] = await db
    .select({
      recentTxCount1h: sql<number>`count(*) filter (where ${transactions.createdAt} >= ${oneHourAgoStr}::timestamptz)`,
      recentTxCount24h: sql<number>`count(*) filter (where ${transactions.createdAt} >= ${oneDayAgoStr}::timestamptz)`,
      operatorTxCount1h: sql<number>`
        (select count(*)
         from ${operatorTransferReservations}
         where ${operatorTransferReservations.agentId} = ${agentId}
           and ${operatorTransferReservations.createdAt} >= ${oneHourAgoStr}::timestamptz
           and ${operatorTransferReservations.status} in ('pending', 'final'))
      `,
      operatorTxCount24h: sql<number>`
        (select count(*)
         from ${operatorTransferReservations}
         where ${operatorTransferReservations.agentId} = ${agentId}
           and ${operatorTransferReservations.createdAt} >= ${oneDayAgoStr}::timestamptz
           and ${operatorTransferReservations.status} in ('pending', 'final'))
      `,
      spentToday: sql<string>`
        coalesce(
          sum(
            case
              when ${transactions.createdAt} >= ${oneDayAgoStr}::timestamptz${chainFilter} then (${transactions.value})::numeric
              else 0
            end
          ),
          0
        )::text
      `,
      spentThisWeek: sql<string>`coalesce(sum((${transactions.value})::numeric) filter (where true${chainFilter}), 0)::text`,
      additionalUsdSpentTodayMicros: sql<string>`
        coalesce((
          select sum((${operatorTransferReservations.amountBaseUnits})::numeric)
          from ${operatorTransferReservations}
          where ${operatorTransferReservations.agentId} = ${agentId}
            and ${operatorTransferReservations.createdAt} >= ${oneDayAgoStr}::timestamptz
            and ${operatorTransferReservations.status} in ('pending', 'final')
        ), 0)::text
      `,
      additionalUsdSpentThisWeekMicros: sql<string>`
        coalesce((
          select sum((${operatorTransferReservations.amountBaseUnits})::numeric)
          from ${operatorTransferReservations}
          where ${operatorTransferReservations.agentId} = ${agentId}
            and ${operatorTransferReservations.createdAt} >= ${oneWeekAgo.toISOString()}::timestamptz
            and ${operatorTransferReservations.status} in ('pending', 'final')
        ), 0)::text
      `,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.agentId, agentId),
        gte(transactions.createdAt, oneWeekAgo),
        // An ambiguous broadcast may already have spent funds. Count it until
        // receipt reconciliation proves the final chain outcome.
        sql`${transactions.status} in ('signed', 'broadcast', 'confirmed', 'outcome_unknown')`,
      ),
    );

  return {
    recentTxCount1h:
      Number(stats?.recentTxCount1h ?? 0) +
      Number(stats?.operatorTxCount1h ?? 0),
    recentTxCount24h:
      Number(stats?.recentTxCount24h ?? 0) +
      Number(stats?.operatorTxCount24h ?? 0),
    spentToday: BigInt(stats?.spentToday ?? "0"),
    spentThisWeek: BigInt(stats?.spentThisWeek ?? "0"),
    additionalUsdSpentTodayMicros: BigInt(
      stats?.additionalUsdSpentTodayMicros ?? "0",
    ),
    additionalUsdSpentThisWeekMicros: BigInt(
      stats?.additionalUsdSpentThisWeekMicros ?? "0",
    ),
  };
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

export async function withAuthenticatedTenantDatabase<T>(
  tenantId: string,
  method: string,
  subject: string,
  callback: () => Promise<T>,
  userId?: string,
  characteristics?: TenantTransactionCharacteristics,
): Promise<T> {
  if (hasTenantTransactionDatabase({ tenantId, userId, ...characteristics }))
    return callback();
  const context = tenantContextFromAuthenticatedPrincipal({
    tenantId,
    method,
    subject,
    userId,
  });
  const driver = isPGLiteRuntime ? "pglite" : getDatabaseDriver();
  return withTenantRlsTransaction(
    getDb() as never,
    driver,
    context,
    async (tx) =>
      withTenantTransactionDatabase(
        tx as never,
        { tenantId, userId },
        callback,
        characteristics,
      ),
    characteristics,
  );
}

export async function continueWithTenantDatabase(
  tenantId: string,
  method: string,
  subject: string,
  next: Next,
  userId?: string,
) {
  return withAuthenticatedTenantDatabase(
    tenantId,
    method,
    subject,
    next,
    userId,
  );
}

export async function tenantAuth(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
  options?: { requireTenantMatch?: string; bindTenantDatabase?: boolean },
) {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const payload = await verifySessionToken(token);
    if (payload?.tenantId) {
      const headerTenant = c.req.header("X-Steward-Tenant");
      if (headerTenant && headerTenant !== payload.tenantId) {
        return c.json<ApiResponse>(
          { ok: false, error: "Tenant header does not match token" },
          403,
        );
      }
      const jwtTenant = await findTenant(payload.tenantId);
      if (jwtTenant) {
        if (
          options?.requireTenantMatch &&
          payload.tenantId !== options.requireTenantMatch
        ) {
          return c.json<ApiResponse>({ ok: false, error: "Forbidden" }, 403);
        }

        const isAgentToken =
          payload.scope === "agent" && typeof payload.agentId === "string";
        const agentTokenScopes = normalizeAgentTokenScopes(payload.scopes);
        if (isAgentToken) {
          // Fail closed: a capability-scoped token (`cap:<manifest>`) is a
          // least-privilege credential for the capability surface only. Refuse
          // it on the general tenant surface even if a minter stamped the
          // broad `agent` scope alongside it.
          if (
            agentTokenScopes.some((scope) =>
              scope.startsWith(CAPABILITY_TOKEN_SCOPE_PREFIX),
            )
          ) {
            return c.json<ApiResponse>({ ok: false, error: "Forbidden" }, 403);
          }
          const agentSubject = await findAgentBootstrapSubject(
            payload.tenantId,
            payload.agentId as string,
            typeof payload.jti === "string" ? payload.jti : undefined,
          );
          if (!agentSubject) {
            return c.json<ApiResponse>(
              { ok: false, error: "Agent not found" },
              403,
            );
          }
          if (typeof payload.jti === "string" && payload.jti) {
            if (agentSubject.signer_id) {
              const signerExpiresAt = agentSubject.signer_expires_at
                ? new Date(agentSubject.signer_expires_at)
                : null;
              if (
                agentSubject.signer_revoked_at ||
                !signerExpiresAt ||
                signerExpiresAt.getTime() <= Date.now()
              ) {
                return c.json<ApiResponse>(
                  { ok: false, error: "Session signer is revoked or expired" },
                  401,
                );
              }
              if ((agentSubject.signer_policy_ids?.length ?? 0) > 0) {
                c.set("agentPolicyIds", agentSubject.signer_policy_ids ?? []);
              }
              try {
                await continueWithTenantDatabase(
                  payload.tenantId,
                  "agent-jwt-signer-use",
                  String(payload.agentId),
                  async () => {
                    await db
                      .update(sessionSigners)
                      .set({ lastUsedAt: new Date() })
                      .where(
                        eq(sessionSigners.id, agentSubject.signer_id as string),
                      );
                  },
                );
              } catch (err) {
                logger.error(
                  {
                    details: [
                      `[session-signer] failed to update lastUsedAt for ${agentSubject.signer_id}`,
                      redactedThrownDiagnostics(err),
                    ],
                  },
                  "[Login:context] error",
                );
              }
            }
          }
        } else {
          if (!payload.userId) {
            return c.json<ApiResponse>(
              { ok: false, error: "User session token is missing userId" },
              401,
            );
          }

          const membership = await findUserTenantMembership(
            payload.userId,
            payload.tenantId,
          );
          if (!membership) {
            return c.json<ApiResponse>(
              { ok: false, error: "Not a member of this tenant" },
              403,
            );
          }
          c.set("tenantRole", membership.role);
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
        if (
          typeof (payload as { mfaVerifiedAt?: unknown }).mfaVerifiedAt ===
          "number"
        ) {
          c.set(
            "sessionMfaVerifiedAt",
            (payload as unknown as { mfaVerifiedAt: number }).mfaVerifiedAt,
          );
        }
        if (isAgentToken) {
          c.set("agentScope", payload.agentId);
          const tokenSubject = (payload as { sub?: unknown }).sub;
          c.set(
            "agentSubject",
            typeof tokenSubject === "string"
              ? tokenSubject
              : `agent:${payload.agentId}`,
          );
          c.set("agentScopes", agentTokenScopes);
          c.set("authType", "agent-token");
        } else {
          if (typeof payload.mfaVerifiedAt === "number") {
            c.set("sessionMfaVerifiedAt", payload.mfaVerifiedAt);
          }
          if (typeof payload.mfaMethod === "string") {
            c.set("sessionMfaMethod", payload.mfaMethod);
          }
          c.set("authType", "session-jwt");
        }
        if (options?.bindTenantDatabase === false) return next();
        return continueWithTenantDatabase(
          payload.tenantId,
          isAgentToken ? "agent-jwt" : "session-jwt",
          isAgentToken ? String(payload.agentId) : String(payload.userId),
          next,
          isAgentToken ? undefined : payload.userId,
        );
      }
    }
  }

  const tenantId = c.req.header("X-Steward-Tenant") || DEFAULT_TENANT_ID;
  const appId = c.req.header("X-Steward-App-Id");
  const basic = parseBasicAuth(authHeader);
  if (appId || basic) {
    if (!appId || !basic) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "App secret auth requires Basic auth and X-Steward-App-Id",
        },
        401,
      );
    }
    if (basic.username !== appId) {
      return c.json<ApiResponse>({ ok: false, error: "App id mismatch" }, 403);
    }
    const parsedAppId = parseAppId(appId);
    if (!parsedAppId) {
      return c.json<ApiResponse>({ ok: false, error: "Invalid app id" }, 400);
    }
    if (
      options?.requireTenantMatch &&
      parsedAppId.tenantId !== options.requireTenantMatch
    ) {
      return c.json<ApiResponse>({ ok: false, error: "Forbidden" }, 403);
    }
    const appTenant = await findTenant(parsedAppId.tenantId);
    if (!appTenant)
      return c.json<ApiResponse>({ ok: false, error: "Forbidden" }, 403);
    const now = new Date();
    const rows = rowsFromDbResult<{
      secret_hash: string;
      secret_status: string;
      expires_at: Date | string | null;
      revoked_at: Date | string | null;
      client_enabled: boolean;
    }>(
      await getDb().execute(sql`
        SELECT * FROM steward_bootstrap.app_client_subject(
          ${parsedAppId.tenantId},
          ${parsedAppId.clientId}
        )
      `),
    );

    const match = rows.some((row) => {
      if (!row.client_enabled || row.revoked_at) return false;
      if (row.expires_at && new Date(row.expires_at) <= now) return false;
      return validateApiKey(basic.password, row.secret_hash);
    });
    if (!match)
      return c.json<ApiResponse>({ ok: false, error: "Forbidden" }, 403);

    c.set("tenantId", parsedAppId.tenantId);
    c.set("tenant", appTenant);
    c.set(
      "tenantConfig",
      tenantConfigs.get(parsedAppId.tenantId) || {
        id: appTenant.id,
        name: appTenant.name,
      },
    );
    c.set("authType", "app-secret");
    if (options?.bindTenantDatabase === false) return next();
    await continueWithTenantDatabase(
      parsedAppId.tenantId,
      "app-secret",
      parsedAppId.clientId,
      next,
    );
    return;
  }

  const apiKey = c.req.header("X-Steward-Key");
  if (!apiKey) {
    return c.json<ApiResponse>(
      { ok: false, error: "Authentication required" },
      401,
    );
  }

  const tenant = await findTenant(tenantId);

  if (!tenant)
    return c.json<ApiResponse>({ ok: false, error: "Forbidden" }, 403);

  if (options?.requireTenantMatch && tenantId !== options.requireTenantMatch) {
    return c.json<ApiResponse>({ ok: false, error: "Forbidden" }, 403);
  }

  if (!tenant.apiKeyHash || !validateApiKey(apiKey, tenant.apiKeyHash)) {
    return c.json<ApiResponse>({ ok: false, error: "Forbidden" }, 403);
  }

  c.set("tenantId", tenantId);
  c.set("tenant", tenant);
  c.set(
    "tenantConfig",
    tenantConfigs.get(tenantId) || { id: tenant.id, name: tenant.name },
  );
  c.set("authType", "api-key");

  if (options?.bindTenantDatabase === false) return next();
  await continueWithTenantDatabase(tenantId, "api-key", tenantId, next);
}

export async function sessionAuth(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json<ApiResponse>(
      { ok: false, error: "Authorization header required" },
      401,
    );
  }

  const token = authHeader.slice(7);
  const payload = await verifySessionToken(token);
  if (!payload) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired session token" },
      401,
    );
  }

  const tenant = await findTenant(payload.tenantId);
  if (!tenant)
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);

  c.set("tenantId", payload.tenantId);
  c.set("tenant", tenant);
  c.set(
    "tenantConfig",
    tenantConfigs.get(payload.tenantId) || { id: tenant.id, name: tenant.name },
  );
  if (
    typeof (payload as { mfaVerifiedAt?: unknown }).mfaVerifiedAt === "number"
  ) {
    c.set(
      "sessionMfaVerifiedAt",
      (payload as unknown as { mfaVerifiedAt: number }).mfaVerifiedAt,
    );
  }

  await continueWithTenantDatabase(
    payload.tenantId,
    "session-jwt",
    String(payload.userId ?? payload.address),
    next,
    payload.userId,
  );
}

export function getAuthenticatedPrincipal(
  c: Context<{ Variables: AppVariables }>,
): AuthenticatedPrincipal {
  const authType = c.get("authType");
  if (authType === "agent-token") {
    return {
      type: "agent",
      id: c.get("agentScope") || c.req.param("agentId") || "unknown",
    };
  }

  const userId = c.get("userId");
  if ((authType === "session-jwt" || authType === "dashboard-jwt") && userId) {
    return { type: "user", id: userId };
  }

  return { type: "tenant", id: c.get("tenantId") || DEFAULT_TENANT_ID };
}

export function isSameAuthenticatedPrincipal(
  left: { type: string; id: string },
  right: { type: string; id: string },
): boolean {
  return left.type === right.type && left.id === right.id;
}

export function formatAuthenticatedPrincipal(
  principal: AuthenticatedPrincipal,
): string {
  return `${principal.type}:${principal.id}`;
}

export function requireAgentAccess(
  c: Context<{ Variables: AppVariables }>,
): boolean {
  const agentScope = c.get("agentScope");
  if (agentScope) {
    return (
      agentScope === c.req.param("agentId") &&
      hasAgentTokenScope(c.get("agentScopes"))
    );
  }
  return requireTenantLevel(c);
}

export function requireTenantLevel(
  c: Context<{ Variables: AppVariables }>,
): boolean {
  const authType = c.get("authType");
  // SEC-153: the legacy tenant-wide X-Steward-Key ("api-key") is unscoped
  // full-tenant authority — a standing single point of compromise. It remains
  // for backwards compatibility only; new integrations should use app-client
  // secrets ("app-secret", per-client revocation) or owner/admin sessions.
  if (authType === "api-key") return true;
  if (authType === "agent-token") return false;

  const tenantRole = c.get("tenantRole");
  return tenantRole === "owner" || tenantRole === "admin";
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
export async function dashboardAuthMiddleware(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json<ApiResponse>(
      { ok: false, error: "Authorization header required" },
      401,
    );
  }

  const token = authHeader.slice(7);
  const payload = await verifySessionToken(token);

  if (!payload?.tenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired session token" },
      401,
    );
  }
  const headerTenant = c.req.header("X-Steward-Tenant");
  if (headerTenant && headerTenant !== payload.tenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant header does not match token" },
      403,
    );
  }

  if (payload.scope === "agent" || payload.agentId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Dashboard routes do not accept agent tokens" },
      403,
    );
  }

  if (!payload.userId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Dashboard routes require a user session token" },
      401,
    );
  }

  const tenant = await findTenant(payload.tenantId);
  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const membership = await findUserTenantMembership(
    payload.userId,
    payload.tenantId,
  );
  if (!membership) {
    return c.json<ApiResponse>(
      { ok: false, error: "Not a member of this tenant" },
      403,
    );
  }

  c.set("tenantId", payload.tenantId);
  c.set("tenant", tenant);
  c.set(
    "tenantConfig",
    tenantConfigs.get(payload.tenantId) || { id: tenant.id, name: tenant.name },
  );
  c.set("authType", "dashboard-jwt");
  c.set("tenantRole", membership.role);
  if (payload.userId) c.set("userId", payload.userId);
  if (typeof payload.mfaVerifiedAt === "number") {
    c.set("sessionMfaVerifiedAt", payload.mfaVerifiedAt);
  }
  if (typeof payload.mfaMethod === "string") {
    c.set("sessionMfaMethod", payload.mfaMethod);
  }

  return continueWithTenantDatabase(
    payload.tenantId,
    "dashboard-jwt",
    payload.userId,
    next,
    payload.userId,
  );
}

// Re-export drizzle schemas used in route modules
export {
  agentKeyQuorums,
  agentSigners,
  agents,
  agentWallets,
  approvalQueue,
  autoApprovalRules,
  conditionSetItems,
  conditionSets,
  encryptedChainKeys,
  encryptedKeys,
  intents,
  pendingProxyRequests,
  policies,
  tenants,
  toPolicyRule,
  toSignRequest,
  toTxRecord,
  transactions,
  vaultSigningFreezes,
  webhookConfigs,
  webhookDeliveries,
} from "../../../db/src/index.ts";
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
} from "../../../shared/src/index.ts";
