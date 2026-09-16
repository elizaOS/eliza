/**
 * Platform-level management routes.
 *
 * These routes are protected by X-Steward-Platform-Key and are intended for
 * trusted platform operators (e.g. Eliza Cloud) to manage tenants and agents
 * programmatically.
 *
 * Mount: app.route("/platform", platformRoutes)
 *
 * All responses follow ApiResponse<T> shape:
 *   { ok: true, data: T }  |  { ok: false, error: string }
 */

import { randomBytes } from "node:crypto";
import { logger } from "@elizaos/logger";
import {
  and,
  count,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { type Context, Hono } from "hono";
import {
  generateApiKey,
  hashSha256Hex,
  hasPlatformScope,
  isDevSecretAllowed,
  isValidE164,
  platformAuthMiddleware,
  revocationStore,
} from "../../../auth/src/index.ts";
import {
  accounts,
  agents,
  agentWallets,
  approvalQueue,
  auditEvents,
  encryptedChainKeys,
  encryptedKeys,
  getDb,
  intents,
  isPersistedPolicyType,
  policies,
  providerActionBindings,
  proxyAuditLog,
  refreshTokens,
  secretRoutes,
  secrets,
  type TenantEmailConfig,
  tenantConfigs,
  tenantInvitations,
  tenants,
  toPersistedPolicyRule,
  transactions,
  upstreamCredentialLeases,
  users,
  userTenants,
  vaultSigningFreezes,
} from "../../../db/src/index.ts";
import {
  type AgentIdentity,
  type ApiResponse,
  type PolicyRule,
  redactedThrownDiagnostics,
  type SponsoredGasSpendSummary,
  type TenantAuthAbuseConfig,
  type TenantOidcProviderConfig,
  type TenantTestAccountConfig,
} from "../../../shared/src/index.ts";
import { containsAsciiControl } from "../../../shared/src/text-boundaries";
import { KeyStore, type Vault } from "../../../vault/src/index.ts";
import { deleteAgentAuthority } from "../services/agent-deletion";
import {
  withTenantAuditedTransaction,
  writeAuditEvent,
} from "../services/audit";
import {
  type AppVariables,
  continueWithTenantDatabase,
  createAgentTokenForExistingAgent,
  getConditionSetReferenceValidationError,
  parseAgentTokenScopes,
  setNoStoreHeaders,
} from "../services/context";
import {
  normalizeGasSpendQuery,
  querySponsoredGasSpend,
} from "../services/gas-sponsorship";
import { normalizeOidcProviders } from "../services/oidc-provider-config";
import { getPolicyRulesValidationError } from "../services/policy-validation";
import { lockUserSession, lockUserSessions } from "../services/session-lock";
import {
  createTenantTestAccountConfig,
  publicTestAccount,
  redactedTestAccount,
} from "../services/test-account-credentials";
import { getConfiguredVault } from "../services/vault-factory";
import { dispatchWebhook } from "../services/webhook-dispatch";
import { getEmailAuthForTenant, invalidateEmailAuthForTenant } from "./auth";

const TENANT_MEMBER_ROLES = new Set(["owner", "admin", "member"]);
const TENANT_INVITATION_ROLES = new Set([
  "admin",
  "developer",
  "billing",
  "viewer",
  "member",
]);
const MAX_PLATFORM_AGENT_TOKEN_SECONDS = 7 * 24 * 60 * 60;
const PLATFORM_AUDIT_TENANT_ID = "platform";
const MAX_PLATFORM_LIST_LIMIT = 200;
const MAX_PLATFORM_METADATA_BYTES = 16_384;
const MAX_PLATFORM_METADATA_DEPTH = 8;
const MAX_PLATFORM_METADATA_KEYS = 100;
const MAX_PLATFORM_METADATA_STRING_BYTES = 4_096;
const WALLET_EXTERNAL_ID_PROVIDER = "wallet_external_id";
const MAX_WALLET_EXTERNAL_ID_LENGTH = 180;
type PlatformTenantConfigRow = typeof tenantConfigs.$inferSelect;

interface TenantCapabilityCleanup {
  activeGrantsRetired: number;
  terminalGrantsRemoved: number;
  capabilitiesRemoved: number;
  invocationEvidenceRetained: number;
}

function resultRows<T>(result: unknown): T[] {
  return (
    Array.isArray(result)
      ? result
      : ((result as { rows?: T[] } | null)?.rows ?? [])
  ) as T[];
}

async function cleanupOptionalTenantCapabilities(
  tx: ReturnType<typeof getDb>,
  tenantId: string,
): Promise<TenantCapabilityCleanup | null> {
  const [relations] = resultRows<{
    capabilities: string | null;
    grants: string | null;
    invocations: string | null;
  }>(
    await tx.execute(sql`
      SELECT
        to_regclass('public.capabilities')::text AS capabilities,
        to_regclass('public.capability_grants')::text AS grants,
        to_regclass('public.capability_invocations')::text AS invocations
    `),
  );
  const cleanup: TenantCapabilityCleanup = {
    activeGrantsRetired: 0,
    terminalGrantsRemoved: 0,
    capabilitiesRemoved: 0,
    invocationEvidenceRetained: 0,
  };

  let tenantCapabilityIds: string[] = [];
  if (relations?.capabilities) {
    tenantCapabilityIds = resultRows<{ id: string }>(
      await tx.execute(sql`
        SELECT id::text AS id
        FROM public.capabilities
        WHERE tenant_id = ${tenantId}
        FOR UPDATE
      `),
    ).map((row) => row.id);
  }
  if (relations?.grants) {
    const grants = resultRows<{ status: string }>(
      await tx.execute(sql`
        SELECT status
        FROM public.capability_grants
        WHERE tenant_id = ${tenantId}
        FOR UPDATE
      `),
    );
    cleanup.activeGrantsRetired = grants.filter(
      (grant) => grant.status === "active",
    ).length;
    cleanup.terminalGrantsRemoved = grants.length - cleanup.activeGrantsRetired;
    if (relations.capabilities) {
      const crossTenantGrants = resultRows<{ id: string }>(
        await tx.execute(sql`
          SELECT capability_grant.id::text AS id
          FROM public.capability_grants AS capability_grant
          INNER JOIN public.capabilities AS capability
            ON capability.id = capability_grant.capability_id
          WHERE capability.tenant_id = ${tenantId}
            AND capability_grant.tenant_id <> ${tenantId}
          FOR UPDATE OF capability_grant
        `),
      );
      if (crossTenantGrants.length > 0) return null;
    }
    await tx.execute(sql`
      UPDATE public.capability_grants
      SET status = 'revoked'
      WHERE tenant_id = ${tenantId} AND status = 'active'
    `);
    await tx.execute(
      sql`DELETE FROM public.capability_grants WHERE tenant_id = ${tenantId}`,
    );
  }
  if (relations?.capabilities) {
    await tx.execute(
      sql`DELETE FROM public.capabilities WHERE tenant_id = ${tenantId}`,
    );
    cleanup.capabilitiesRemoved = tenantCapabilityIds.length;
  }
  if (relations?.invocations) {
    const [countRow] = resultRows<{ count: number }>(
      await tx.execute(sql`
        SELECT count(*)::int AS count
        FROM public.capability_invocations
        WHERE tenant_id = ${tenantId}
      `),
    );
    cleanup.invocationEvidenceRetained = countRow?.count ?? 0;
  }
  return cleanup;
}

function parseDurationSeconds(value: string): number | null {
  const match = value.trim().match(/^(\d+)([smhd])$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === "s"
      ? 1
      : unit === "m"
        ? 60
        : unit === "h"
          ? 60 * 60
          : 24 * 60 * 60;
  return amount * multiplier;
}

async function snapshotPlatformTenantConfigRow(
  tenantId: string,
): Promise<PlatformTenantConfigRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));
  return row ?? null;
}

async function restorePlatformTenantConfigRow(
  tenantId: string,
  snapshot: PlatformTenantConfigRow | null,
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(tenantConfigs).where(eq(tenantConfigs.tenantId, tenantId));
    if (snapshot) {
      await tx.insert(tenantConfigs).values(snapshot);
    }
  });
}

async function deletePlatformCreatedTenant(tenantId: string): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(tenants).where(eq(tenants.id, tenantId));
  });
}

async function deletePlatformCreatedAgent(
  agentId: string,
  tenantId: string,
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(approvalQueue).where(eq(approvalQueue.agentId, agentId));
    await tx.delete(transactions).where(eq(transactions.agentId, agentId));
    await tx.delete(policies).where(eq(policies.agentId, agentId));
    await tx
      .delete(encryptedChainKeys)
      .where(eq(encryptedChainKeys.agentId, agentId));
    await tx.delete(encryptedKeys).where(eq(encryptedKeys.agentId, agentId));
    await tx.delete(agentWallets).where(eq(agentWallets.agentId, agentId));
    await tx
      .delete(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
  });
}

async function tenantIdHasRetainedState(tenantId: string): Promise<boolean> {
  const db = getDb();
  const [[secret], [secretRoute], [proxyAudit], [auditEvent]] =
    await Promise.all([
      db
        .select({ id: secrets.id })
        .from(secrets)
        .where(eq(secrets.tenantId, tenantId))
        .limit(1),
      db
        .select({ id: secretRoutes.id })
        .from(secretRoutes)
        .where(eq(secretRoutes.tenantId, tenantId))
        .limit(1),
      db
        .select({ id: proxyAuditLog.id })
        .from(proxyAuditLog)
        .where(eq(proxyAuditLog.tenantId, tenantId))
        .limit(1),
      db
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.tenantId, tenantId))
        .limit(1),
    ]);

  return Boolean(secret || secretRoute || proxyAudit || auditEvent);
}

function normalizePlatformAgentTokenExpiry(value: string | undefined): string {
  const requested = value?.trim() || "24h";
  const seconds = parseDurationSeconds(requested);
  if (!seconds || seconds > MAX_PLATFORM_AGENT_TOKEN_SECONDS) {
    throw new Error(
      "expiresIn must be a duration up to 7d using s, m, h, or d",
    );
  }
  return requested;
}

function normalizeTenantMemberRole(
  role: string | undefined,
): "owner" | "admin" | "member" {
  const normalized = (role ?? "member").trim().toLowerCase();
  if (!TENANT_MEMBER_ROLES.has(normalized)) {
    throw new Error("role must be one of: owner, admin, member");
  }
  return normalized as "owner" | "admin" | "member";
}

function normalizeTenantInvitationRole(
  role: string | undefined,
): "admin" | "developer" | "billing" | "viewer" | "member" {
  const normalized = (role ?? "member").trim().toLowerCase();
  if (!TENANT_INVITATION_ROLES.has(normalized)) {
    throw new Error(
      "role must be one of: admin, developer, billing, viewer, member",
    );
  }
  return normalized as "admin" | "developer" | "billing" | "viewer" | "member";
}

function normalizeInvitationExpiry(value: unknown): Date {
  const maxSeconds = 30 * 24 * 60 * 60;
  const defaultSeconds = 7 * 24 * 60 * 60;
  const seconds =
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? Math.min(value, maxSeconds)
      : defaultSeconds;
  return new Date(Date.now() + seconds * 1000);
}

async function activeTenantOwnerCount(
  tx: Pick<ReturnType<typeof getDb>, "select">,
  tenantId: string,
  excludeUserId?: string,
): Promise<number> {
  const conditions = [
    eq(userTenants.tenantId, tenantId),
    eq(userTenants.role, "owner"),
    isNull(users.deactivatedAt),
  ];
  if (excludeUserId) conditions.push(ne(userTenants.userId, excludeUserId));
  const [ownerCount] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(userTenants)
    .innerJoin(users, eq(users.id, userTenants.userId))
    .where(and(...conditions));
  return Number(ownerCount?.count ?? 0);
}

function tenantOwnerLifecycleLockKey(tenantId: string): string {
  return `tenant_owner_lifecycle_${tenantId}`;
}

async function lockTenantOwnerLifecycle(
  tx: Pick<ReturnType<typeof getDb>, "execute">,
  tenantId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${tenantOwnerLifecycleLockKey(tenantId)}, 0))`,
  );
}

function parseListLimit(value: string | undefined, fallback = 100): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_PLATFORM_LIST_LIMIT);
}

function parseListOffset(value: string | undefined): number {
  const parsed = value ? Number(value) : 0;
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 100_000);
}

function auditCtx(c: {
  req: { header(name: string): string | undefined };
  get: (k: string) => unknown;
}): {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
} {
  return {
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: (c.get("requestId") as string | undefined) ?? null,
  };
}

function platformIdentityMigrationAllowed(): boolean {
  return process.env.STEWARD_ALLOW_PLATFORM_IDENTITY_MIGRATION === "true";
}

function platformIdentityMigrationDisabledResponse(c: Context) {
  return c.json<ApiResponse>(
    {
      ok: false,
      error:
        "Platform identity migration routes are disabled. Set STEWARD_ALLOW_PLATFORM_IDENTITY_MIGRATION=true only for audited offline migrations.",
    },
    403,
  );
}

// ─── Vault access ─────────────────────────────────────────────────────────────
// Platform routes use the shared configured-vault factory.

function getVault(): Vault {
  return getConfiguredVault({ allowDevSecretFallback: true });
}

function vault(): Vault {
  return getVault();
}

let _platformKeyStore: KeyStore | undefined;
function platformKeyStore(): KeyStore {
  if (_platformKeyStore) return _platformKeyStore;

  const masterPassword = process.env.STEWARD_MASTER_PASSWORD;
  if (!masterPassword) {
    if (!isDevSecretAllowed()) {
      throw new Error(
        "⛔ STEWARD_MASTER_PASSWORD must be set. For local development only, opt in to the " +
          "insecure dev fallback with STEWARD_ALLOW_DEV_SECRETS=true.",
      );
    }
    logger.warn(
      {
        details: [
          "⚠️  [DEV ONLY] Using insecure 'dev-secret' as vault master password. Set STEWARD_MASTER_PASSWORD before going to production!",
        ],
      },
      "[Login:platform] warn",
    );
  }

  _platformKeyStore = new KeyStore(masterPassword || "dev-secret");
  return _platformKeyStore;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

const AGENT_ID_RE = /^[a-zA-Z0-9_\-.:]{1,128}$/;
const TENANT_ID_RE = /^[a-zA-Z0-9_\-.:]{1,64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidAgentId(id: unknown): id is string {
  return typeof id === "string" && AGENT_ID_RE.test(id);
}

function isValidTenantId(id: unknown): id is string {
  return typeof id === "string" && TENANT_ID_RE.test(id);
}

function isReservedTenantId(id: string): boolean {
  const normalized = id.toLowerCase();
  return (
    normalized === PLATFORM_AUDIT_TENANT_ID ||
    normalized === "system" ||
    normalized === "default" ||
    normalized === "personal" ||
    normalized.startsWith("personal-") ||
    normalized.startsWith("eth:") ||
    normalized.startsWith("t-") ||
    normalized.startsWith("solana:")
  );
}

function isValidUserId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

function isValidAccountProvider(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value.trim())
  );
}

function isValidProviderAccountId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 255
  );
}

function isThirdPartyWalletProvider(provider: string): boolean {
  return provider === "wallet:ethereum" || provider === "wallet:solana";
}

async function userHasLinkedThirdPartyWallet(userId: string): Promise<boolean> {
  const [linkedWallet] = await getDb()
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        or(
          eq(accounts.provider, "wallet:ethereum"),
          eq(accounts.provider, "wallet:solana"),
        ),
      ),
    )
    .limit(1);
  return Boolean(linkedWallet);
}

async function tenantIdsForWalletPolicy(
  userId: string,
  tenantId?: string,
): Promise<string[]> {
  const memberships = rowsFromExecute<{ tenant_id: string }>(
    await getDb().execute(
      sql`SELECT * FROM steward_bootstrap.platform_user_tenant_ids(${userId}::uuid)`,
    ),
  );
  const tenantIds = memberships.map((membership) => membership.tenant_id);
  return tenantId
    ? tenantIds.filter((candidate) => candidate === tenantId)
    : tenantIds;
}

async function restrictedWalletPolicyTenantIds(
  userId: string,
  tenantId?: string,
): Promise<string[]> {
  const tenantIds = await tenantIdsForWalletPolicy(userId, tenantId);
  if (tenantId && tenantIds.length === 0) return [];
  if (tenantIds.length === 0) return [];
  const configs = await getDb()
    .select({
      tenantId: tenantConfigs.tenantId,
      authAbuseConfig: tenantConfigs.authAbuseConfig,
    })
    .from(tenantConfigs)
    .where(inArray(tenantConfigs.tenantId, tenantIds));
  return configs
    .filter(
      (config) =>
        (config.authAbuseConfig as TenantAuthAbuseConfig | null)?.wallet
          ?.restrictToOneThirdPartyWallet === true,
    )
    .map((config) => config.tenantId);
}

function isValidWalletExternalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_WALLET_EXTERNAL_ID_LENGTH &&
    !containsAsciiControl(value.trim())
  );
}

function walletExternalProviderAccountId(
  tenantId: string,
  externalId: string,
): string {
  return `${tenantId}:${externalId.trim()}`;
}

function parseWalletExternalProviderAccountId(
  providerAccountId: string,
  tenantIds: string[],
): { tenantId: string; externalId: string } | null {
  const tenantId = tenantIds.find((id) =>
    providerAccountId.startsWith(`${id}:`),
  );
  if (!tenantId) return null;
  return {
    tenantId,
    externalId: providerAccountId.slice(tenantId.length + 1),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isOptionalEmailBrandName(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (isNonEmptyString(value) &&
      value.trim().length <= 100 &&
      !/[\r\n]/.test(value))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a deployer-supplied `templates` payload for the email-config
 * PATCH: `{ magicLink?, otp? }` where each present entry must carry
 * non-empty `subject`, `text`, and `html` strings. `undefined` (absent) and
 * `null` (explicit clear) are both accepted; anything else is rejected so a
 * malformed body can't be persisted and later break auth email rendering.
 */
function isValidEmailTemplates(
  value: unknown,
): value is TenantEmailConfig["templates"] | null | undefined {
  if (value === undefined || value === null) return true;
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  if (!keys.every((key) => key === "magicLink" || key === "otp")) return false;
  return keys.every((key) => {
    const entry = value[key];
    if (!isPlainObject(entry)) return false;
    const entryKeys = Object.keys(entry);
    if (
      !entryKeys.every((k) => k === "subject" || k === "text" || k === "html")
    )
      return false;
    return (
      isNonEmptyString(entry.subject) &&
      isNonEmptyString(entry.text) &&
      isNonEmptyString(entry.html)
    );
  });
}

function getPlatformMetadataValidationError(
  value: unknown,
  label: "customMetadata" | "tenantCustomMetadata",
): string | null {
  if (!isPlainObject(value)) return `${label} must be an object`;

  let keyCount = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop() as { value: unknown; depth: number };
    if (current.depth > MAX_PLATFORM_METADATA_DEPTH) {
      return `${label} must not exceed ${MAX_PLATFORM_METADATA_DEPTH} levels`;
    }

    if (typeof current.value === "string") {
      if (
        new TextEncoder().encode(current.value).length >
        MAX_PLATFORM_METADATA_STRING_BYTES
      ) {
        return `${label} string values must not exceed ${MAX_PLATFORM_METADATA_STRING_BYTES} bytes`;
      }
      continue;
    }

    if (
      current.value === null ||
      typeof current.value === "number" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }

    if (Array.isArray(current.value)) {
      keyCount += current.value.length;
      if (keyCount > MAX_PLATFORM_METADATA_KEYS) {
        return `${label} must not contain more than ${MAX_PLATFORM_METADATA_KEYS} keys or items`;
      }
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }

    if (isPlainObject(current.value)) {
      const entries = Object.entries(current.value);
      keyCount += entries.length;
      if (keyCount > MAX_PLATFORM_METADATA_KEYS) {
        return `${label} must not contain more than ${MAX_PLATFORM_METADATA_KEYS} keys or items`;
      }
      for (const [, child] of entries) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }

    return `${label} must contain only JSON values`;
  }

  if (
    new TextEncoder().encode(JSON.stringify(value)).length >
    MAX_PLATFORM_METADATA_BYTES
  ) {
    return `${label} must not exceed ${MAX_PLATFORM_METADATA_BYTES} bytes`;
  }

  return null;
}

function clampLimit(value: string | null, fallback = 50): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, 100));
}

function parseOffset(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

function parseQueryList(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

async function resolveTenantWalletExternalIds(
  tenantId: string,
  externalIds: string[],
): Promise<string[] | Error> {
  const normalized = [
    ...new Set(externalIds.map((id) => id.trim()).filter(Boolean)),
  ];
  if (normalized.length === 0) return [];
  if (normalized.length > 100)
    return new Error("wallet_external_ids can include at most 100 ids");
  if (!normalized.every((id) => isValidWalletExternalId(id))) {
    return new Error(
      "wallet_external_ids contains an invalid wallet external id",
    );
  }

  const rows = await getDb()
    .select({ id: agents.id, platformId: agents.platformId })
    .from(agents)
    .where(
      and(
        eq(agents.tenantId, tenantId),
        inArray(agents.platformId, normalized),
      ),
    );

  const byExternalId = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.platformId) continue;
    const ids = byExternalId.get(row.platformId) ?? [];
    ids.push(row.id);
    byExternalId.set(row.platformId, ids);
  }

  const missing = normalized.filter(
    (externalId) => !byExternalId.has(externalId),
  );
  if (missing.length > 0) {
    return new Error(`Unknown wallet_external_ids: ${missing.join(", ")}`);
  }

  const ambiguous = [...byExternalId.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([externalId]) => externalId);
  if (ambiguous.length > 0) {
    return new Error(`Ambiguous wallet_external_ids: ${ambiguous.join(", ")}`);
  }

  return normalized.map(
    (externalId) => (byExternalId.get(externalId) as string[])[0],
  );
}

async function getTenantOr404(tenantId: string) {
  const db = getDb();
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return tenant ?? null;
}

async function safeJsonParse<T>(c: {
  req: { json: <X>() => Promise<X> };
}): Promise<T | null> {
  try {
    return await (c.req.json as () => Promise<T>)();
  } catch {
    return null;
  }
}

function rowsFromExecute<T>(result: unknown): T[] {
  return (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] })?.rows ?? [])
  ) as T[];
}

// ─── Route group ─────────────────────────────────────────────────────────────

const platform = new Hono<{ Variables: AppVariables }>();

const PLATFORM_READ_ONLY_POST_PATHS = new Set([
  "/users/email/address",
  "/users/phone/number",
  "/users/wallet/address",
  "/users/wallet/external-id",
  "/users/smart-wallet/address",
  "/users/custom-auth/id",
  "/users/discord/username",
  "/users/github/username",
  "/users/farcaster/id",
  "/users/instagram/username",
  "/users/spotify/subject",
  "/users/telegram/user-id",
  "/users/telegram/username",
  "/users/twitch/username",
  "/users/twitter/subject",
  "/users/twitter/username",
]);

function isPlatformReadLikeRequest(
  c: Context<{ Variables: AppVariables }>,
): boolean {
  if (c.req.method === "GET" || c.req.method === "HEAD") return true;
  if (c.req.method !== "POST") return false;
  const pathname = new URL(c.req.url).pathname.replace(/^\/platform(?=\/)/, "");
  return PLATFORM_READ_ONLY_POST_PATHS.has(pathname);
}

// All platform routes require a valid platform key
platform.use("*", platformAuthMiddleware());
platform.use("*", async (c, next) => {
  setNoStoreHeaders(c);
  await next();
});
platform.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return next();
  }
  const scopes = c.get("platformScopes");
  if (isPlatformReadLikeRequest(c)) {
    if (!hasPlatformScope(scopes, "platform:read")) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Platform read routes require a scoped platform key with platform:read or platform:*",
        },
        403,
      );
    }
    return next();
  }
  if (!hasPlatformScope(scopes, "platform:write")) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Platform write routes require a scoped platform key with platform:write or platform:*",
      },
      403,
    );
  }
  return next();
});

// Resolve exceptional tenant authority that is not carried in a tenant route.
platform.use("*", async (c, next) => {
  const pathname = new URL(c.req.url).pathname.replace(/^\/platform(?=\/)/, "");
  const agentRevocationMatch = pathname.match(
    /^\/agents\/([^/]+)\/revoke-tokens$/,
  );
  if (agentRevocationMatch) {
    if (
      !hasPlatformScope(c.get("platformScopes"), "platform:agent-token:revoke")
    )
      return next();
    const agentId = agentRevocationMatch[1] ?? "";
    if (!isValidAgentId(agentId)) return next();
    const result = await getDb().execute(
      sql`SELECT * FROM steward_bootstrap.agent_tenant_subject(${agentId})`,
    );
    const [subject] = (
      Array.isArray(result)
        ? result
        : ((result as { rows?: unknown[] }).rows ?? [])
    ) as Array<{ tenant_id: string }> | [];
    if (!subject?.tenant_id) return next();
    return continueWithTenantDatabase(
      subject.tenant_id,
      "platform-agent-token-revocation",
      "platform",
      next,
    );
  }
  if (pathname.startsWith("/tenants/")) return next();
  let tenantId =
    c.req.query("tenantId")?.trim() || c.req.query("tenant_id")?.trim() || "";
  if (["POST", "PUT", "PATCH"].includes(c.req.method)) {
    try {
      const body = (await c.req.raw.clone().json()) as { tenantId?: unknown };
      tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    } catch {
      // The route owns malformed-body reporting; do not mint an RLS context.
    }
  }
  if (
    (!tenantId || !isValidTenantId(tenantId)) &&
    /^\/users(?:\/|$)/.test(pathname)
  ) {
    await getDb().execute(
      sql`SELECT steward_bootstrap.ensure_platform_tenant()`,
    );
    tenantId = PLATFORM_AUDIT_TENANT_ID;
  }
  if (!tenantId || !isValidTenantId(tenantId)) return next();
  return continueWithTenantDatabase(
    tenantId,
    "platform-tenant-operation",
    "platform",
    next,
  );
});

// A named middleware route limits this to reachable tenant routes. Hono does
// not expose a later handler's params while earlier middleware is executing,
// so resolve the value from the matched path segment before entering downstream.
export async function bindPlatformTenantDatabase(
  c: Context<{ Variables: AppVariables }>,
  next: () => Promise<void>,
) {
  const match = new URL(c.req.url).pathname.match(
    /(?:^|\/platform)\/tenants\/([^/]+)(?:\/|$)/,
  );
  let tenantId = "";
  try {
    tenantId = match ? decodeURIComponent(match[1]) : "";
  } catch {
    return next();
  }
  if (!tenantId || !isValidTenantId(tenantId)) return next();
  return continueWithTenantDatabase(
    tenantId,
    "platform-tenant-operation",
    "platform",
    next,
  );
}

platform.use("/tenants/:tenantId", bindPlatformTenantDatabase);
platform.use("/tenants/:tenantId/*", bindPlatformTenantDatabase);
platform.use("/apps/gas_spend", async (c, next) => {
  const tenantId = c.req.query("tenant_id")?.trim() || "";
  if (!tenantId || !isValidTenantId(tenantId)) return next();
  return continueWithTenantDatabase(
    tenantId,
    "platform-tenant-operation",
    "platform",
    next,
  );
});
platform.use("/tenants", async (c, next) => {
  if (c.req.method !== "POST") return next();
  let tenantId = "";
  try {
    const body = (await c.req.raw.clone().json()) as { id?: unknown };
    tenantId = typeof body.id === "string" ? body.id : "";
  } catch {
    // The route owns malformed-body reporting; do not mint an RLS context.
  }
  if (!tenantId || !isValidTenantId(tenantId)) return next();
  return continueWithTenantDatabase(
    tenantId,
    "platform-tenant-operation",
    "platform",
    next,
  );
});

function requirePlatformRouteScope(
  c: Context<{ Variables: AppVariables }>,
  scope: string,
): Response | null {
  if (hasPlatformScope(c.get("platformScopes"), scope)) return null;
  return c.json<ApiResponse>(
    {
      ok: false,
      error: `Platform route requires scoped platform key with ${scope}`,
    },
    403,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform stats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /stats
 * Returns aggregate counts: tenants, agents, transactions.
 */
platform.get("/stats", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:stats:read");
  if (scopeResponse) return scopeResponse;

  const result = await getDb().execute(
    sql`SELECT * FROM steward_bootstrap.platform_stats()`,
  );
  const [stats] = (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] }).rows ?? [])
  ) as
    | Array<{
        tenant_count: number;
        agent_count: number;
        transaction_count: number;
      }>
    | [];

  return c.json<
    ApiResponse<{ tenants: number; agents: number; transactions: number }>
  >({
    ok: true,
    data: {
      tenants: Number(stats?.tenant_count ?? 0),
      agents: Number(stats?.agent_count ?? 0),
      transactions: Number(stats?.transaction_count ?? 0),
    },
  });
});

/**
 * GET /apps/gas_spend
 * Query: tenant_id=<tenant>&wallet_ids=<agent-1,agent-2>&wallet_external_ids=<external-1,external-2>&start_timestamp=<unix>&end_timestamp=<unix>
 *
 * Returns sponsored gas reservations and settled spend for tenant-scoped wallets.
 * Timestamps may be Unix seconds or milliseconds; range is capped at 30 days.
 * wallet_external_ids are tenant-scoped agent platform IDs and resolve before
 * spend lookup, so history responses still use canonical wallet IDs.
 */
platform.get("/apps/gas_spend", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:gas-spend:read");
  if (scopeResponse) return scopeResponse;

  const tenantId = c.req.query("tenant_id")?.trim();
  if (!tenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "tenant_id is required" },
      400,
    );
  }

  const parseTimestamp = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  };

  const externalWalletIds = parseQueryList(
    c.req.query("wallet_external_ids") ?? c.req.query("walletExternalIds"),
  );
  const resolvedExternalWalletIds = await resolveTenantWalletExternalIds(
    tenantId,
    externalWalletIds,
  );
  if (resolvedExternalWalletIds instanceof Error) {
    const status = resolvedExternalWalletIds.message.startsWith("Ambiguous")
      ? 409
      : resolvedExternalWalletIds.message.startsWith("Unknown")
        ? 404
        : 400;
    return c.json<ApiResponse>(
      { ok: false, error: resolvedExternalWalletIds.message },
      status,
    );
  }

  const normalized = normalizeGasSpendQuery({
    walletIds: [
      ...parseQueryList(c.req.query("wallet_ids")),
      ...resolvedExternalWalletIds,
    ],
    startTimestamp: parseTimestamp(c.req.query("start_timestamp")),
    endTimestamp: parseTimestamp(c.req.query("end_timestamp")),
  });
  if (typeof normalized === "string") {
    return c.json<ApiResponse>({ ok: false, error: normalized }, 400);
  }

  const data = await querySponsoredGasSpend({
    tenantId,
    ...normalized,
  });
  return c.json<ApiResponse<SponsoredGasSpendSummary>>({ ok: true, data });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenant management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /tenants
 * Body: { id: string; name: string; webhookUrl?: string; defaultPolicies?: PolicyRule[] }
 *
 * Creates a new tenant, auto-generates an API key, and returns the raw key
 * (once — it is never stored in plaintext and cannot be retrieved later).
 */
platform.post("/tenants", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:tenant:create");
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const body = await safeJsonParse<{
    id: string;
    name: string;
    webhookUrl?: string;
    defaultPolicies?: PolicyRule[];
  }>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (!isValidTenantId(body.id)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Invalid tenant id — must be 1-64 alphanumeric chars (plus _ - . :)",
      },
      400,
    );
  }
  if (isReservedTenantId(body.id)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant id is reserved" },
      400,
    );
  }

  if (!isNonEmptyString(body.name)) {
    return c.json<ApiResponse>(
      { ok: false, error: "name is required and must be a non-empty string" },
      400,
    );
  }
  if (body.defaultPolicies !== undefined) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "defaultPolicies are not persisted by this endpoint; configure per-agent policies instead",
      },
      501,
    );
  }

  // Check for duplicates
  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, body.id));

  if (existing) {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant already exists" },
      409,
    );
  }
  if (await tenantIdHasRetainedState(body.id)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Tenant id has retained historical state and cannot be reused",
      },
      409,
    );
  }

  const apiKeyPair = generateApiKey();

  await writeAuditEvent({
    tenantId: body.id,
    actorType: "platform",
    action: "tenant.create.authorized",
    resourceType: "tenant",
    resourceId: body.id,
    metadata: { name: body.name, viaPlatform: true },
    ...auditCtx(c),
  });
  await writeAuditEvent({
    tenantId: body.id,
    actorType: "platform",
    action: "tenant.api_key.create.authorized",
    resourceType: "tenant",
    resourceId: body.id,
    ...auditCtx(c),
  });

  const [tenant] = await db
    .insert(tenants)
    .values({
      id: body.id,
      name: body.name,
      apiKeyHash: apiKeyPair.hash,
    })
    .returning();

  if (!tenant) {
    return c.json<ApiResponse>(
      { ok: false, error: "Failed to create tenant" },
      500,
    );
  }

  try {
    await writeAuditEvent({
      tenantId: tenant.id,
      actorType: "platform",
      action: "tenant.create",
      resourceType: "tenant",
      resourceId: tenant.id,
      metadata: { name: tenant.name, viaPlatform: true },
      ...auditCtx(c),
    });
    await writeAuditEvent({
      tenantId: tenant.id,
      actorType: "platform",
      action: "tenant.api_key.create",
      resourceType: "tenant",
      resourceId: tenant.id,
      ...auditCtx(c),
    });
  } catch (error) {
    await deletePlatformCreatedTenant(tenant.id);
    throw error;
  }

  return c.json<
    ApiResponse<{
      id: string;
      name: string;
      createdAt: Date;
      apiKey: string;
      webhookUrl?: string;
      defaultPolicies?: PolicyRule[];
    }>
  >(
    {
      ok: true,
      data: {
        id: tenant.id,
        name: tenant.name,
        createdAt: tenant.createdAt,
        // Raw key — returned ONCE on creation only
        apiKey: apiKeyPair.key,
        webhookUrl: body.webhookUrl,
      },
    },
    201,
  );
});

/**
 * GET /tenants
 * Lists all tenants (id, name, createdAt — no key hashes exposed).
 */
platform.get("/tenants", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:tenant:read");
  if (scopeResponse) return scopeResponse;

  const limit = parseListLimit(c.req.query("limit"));
  const offset = parseListOffset(c.req.query("offset"));
  const result = await getDb().execute(
    sql`SELECT * FROM steward_bootstrap.platform_tenants(${limit}, ${offset})`,
  );
  const rawRows = (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] }).rows ?? [])
  ) as
    | Array<{
        id: string;
        name: string;
        owner_address: string | null;
        created_at: Date | string;
        updated_at: Date | string;
      }>
    | [];
  const rows = rawRows.map((row) => ({
    id: row.id,
    name: row.name,
    ownerAddress: row.owner_address,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }));

  return c.json<ApiResponse<typeof rows>>({ ok: true, data: rows });
});

/**
 * POST /tenants/:id/freeze
 * Tenant-wide, fail-closed kill-switch for blast-radius incidents: halts ALL
 * signing for every agent under the tenant at the vault chokepoint (checked
 * before key decryption). Gated behind a scoped platform key.
 */
platform.post("/tenants/:id/freeze", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-freeze:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant)
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);

  let reason: string | null = null;
  const body = await safeJsonParse<{ reason?: unknown }>(c);
  if (body && body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string") {
      return c.json<ApiResponse>(
        { ok: false, error: "reason must be a string" },
        400,
      );
    }
    const trimmed = body.reason.trim();
    reason = trimmed ? trimmed.slice(0, 1024) : null;
  }

  const [existing] = await db
    .select({ id: vaultSigningFreezes.id })
    .from(vaultSigningFreezes)
    .where(
      and(
        eq(vaultSigningFreezes.tenantId, tenantId),
        eq(vaultSigningFreezes.scopeType, "tenant"),
        isNull(vaultSigningFreezes.liftedAt),
      ),
    )
    .limit(1);

  if (existing) {
    return c.json<ApiResponse>({
      ok: true,
      data: {
        tenantId,
        scopeType: "tenant",
        signingState: "frozen",
        freezeId: existing.id,
      },
    });
  }

  const [row] = await db
    .insert(vaultSigningFreezes)
    .values({
      tenantId,
      scopeType: "tenant",
      reason,
      createdByType: "platform",
      createdById: "platform",
    })
    .returning({ id: vaultSigningFreezes.id });

  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "tenant.freeze",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: { freezeId: row.id, scopeType: "tenant", reason },
    ...auditCtx(c),
  });

  dispatchWebhook(tenantId, tenantId, "wallet.frozen", {
    tenant_id: tenantId,
    scope_type: "tenant",
    freeze_id: row.id,
    reason,
  });

  return c.json<ApiResponse>({
    ok: true,
    data: {
      tenantId,
      scopeType: "tenant",
      signingState: "frozen",
      freezeId: row.id,
    },
  });
});

/**
 * POST /tenants/:id/unfreeze
 * Lifts the active tenant-wide signing freeze. Gated behind a scoped platform key.
 */
platform.post("/tenants/:id/unfreeze", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-freeze:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  const lifted = await db
    .update(vaultSigningFreezes)
    .set({
      liftedAt: sql`now()`,
      liftedByType: "platform",
      liftedById: "platform",
    })
    .where(
      and(
        eq(vaultSigningFreezes.tenantId, tenantId),
        eq(vaultSigningFreezes.scopeType, "tenant"),
        isNull(vaultSigningFreezes.liftedAt),
      ),
    )
    .returning({ id: vaultSigningFreezes.id });

  if (lifted.length === 0) {
    return c.json<ApiResponse>({
      ok: true,
      data: {
        tenantId,
        scopeType: "tenant",
        signingState: "active",
        freezeId: null,
      },
    });
  }

  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "tenant.unfreeze",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: { freezeId: lifted[0].id, scopeType: "tenant" },
    ...auditCtx(c),
  });

  dispatchWebhook(tenantId, tenantId, "wallet.unfrozen", {
    tenant_id: tenantId,
    scope_type: "tenant",
    freeze_id: lifted[0].id,
  });

  return c.json<ApiResponse>({
    ok: true,
    data: {
      tenantId,
      scopeType: "tenant",
      signingState: "active",
      freezeId: lifted[0].id,
    },
  });
});

/**
 * GET /tenants/:id
 * Returns a single tenant's details (no key hash).
 */
platform.get("/tenants/:id", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:tenant:read");
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  const [tenant] = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      ownerAddress: tenants.ownerAddress,
      createdAt: tenants.createdAt,
      updatedAt: tenants.updatedAt,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  // Also pull agent count for convenience
  const [{ agentCount }] = await db
    .select({ agentCount: count() })
    .from(agents)
    .where(eq(agents.tenantId, tenantId));

  return c.json<ApiResponse<typeof tenant & { agentCount: number }>>({
    ok: true,
    data: { ...tenant, agentCount: agentCount ?? 0 },
  });
});

/**
 * PATCH /tenants/:tenantId/email-config
 * Body: { apiKey, from, replyTo?, brandName?, templateId?, subjectOverride?, templates? }
 *   or template-only: { brandName?, templateId?, subjectOverride?, replyTo?, templates? }
 *   (no apiKey)
 *
 * Upserts the tenant-specific email provider config. When `apiKey` is
 * omitted the tenant keeps the platform's global Resend provider and only
 * the branding fields (brandName/templateId/subjectOverride/replyTo/templates) are
 * stored — merged over any existing config so magic-link overrides survive.
 * `templates` carries deployer-supplied raw subject/text/html bodies with
 * {{placeholder}} substitution (see TenantEmailConfig.templates); pass
 * `templates: null` to clear them.
 */
platform.patch("/tenants/:tenantId/email-config", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-email-config:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("tenantId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  if (!(await getTenantOr404(tenantId))) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const body = await safeJsonParse<{
    apiKey: string;
    from: string;
    replyTo?: string;
    brandName?: string;
    templateId?: string;
    subjectOverride?: string;
    magicLinkBaseUrl?: string;
    magicLinkCallbackPath?: string;
    templates?: TenantEmailConfig["templates"] | null;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (!isValidEmailTemplates(body.templates)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "templates must be { magicLink?, otp? } where each entry has non-empty subject, text, and html strings (or null to clear)",
      },
      400,
    );
  }

  const isTemplateOnly = body.apiKey === undefined;

  if (isTemplateOnly) {
    if (body.from !== undefined) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "from requires apiKey (per-tenant provider config)",
        },
        400,
      );
    }
    if (
      !body.templateId &&
      !body.brandName &&
      !body.subjectOverride &&
      !body.replyTo &&
      !body.magicLinkBaseUrl &&
      !body.magicLinkCallbackPath &&
      body.templates === undefined
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Provide apiKey+from for provider config, or at least one of brandName, templateId, subjectOverride, replyTo, magicLinkBaseUrl, magicLinkCallbackPath, templates",
        },
        400,
      );
    }
  } else if (!isNonEmptyString(body.apiKey) || !isNonEmptyString(body.from)) {
    return c.json<ApiResponse>(
      { ok: false, error: "apiKey and from are required" },
      400,
    );
  }

  if (
    !isOptionalString(body.replyTo) ||
    !isOptionalEmailBrandName(body.brandName) ||
    !isOptionalString(body.templateId) ||
    !isOptionalString(body.subjectOverride) ||
    !isOptionalString(body.magicLinkBaseUrl) ||
    !isOptionalString(body.magicLinkCallbackPath)
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "brandName must be a non-empty single-line string of at most 100 characters; replyTo, templateId, subjectOverride, magicLinkBaseUrl, and magicLinkCallbackPath must be non-empty strings",
      },
      400,
    );
  }

  if (body.magicLinkBaseUrl) {
    try {
      const url = new URL(body.magicLinkBaseUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new Error("protocol");
    } catch {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "magicLinkBaseUrl must be an absolute HTTP(S) URL",
        },
        400,
      );
    }
  }
  if (
    body.magicLinkCallbackPath &&
    (!body.magicLinkCallbackPath.startsWith("/") ||
      body.magicLinkCallbackPath.startsWith("//"))
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "magicLinkCallbackPath must be a root-relative path",
      },
      400,
    );
  }

  const [existingRow] = await db
    .select({ emailConfig: tenantConfigs.emailConfig })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  // `templates: null` clears stored templates; undefined leaves them alone
  // (template-only merge) or omits them (full provider replace).
  const templatesPatch =
    body.templates === undefined
      ? {}
      : body.templates === null
        ? { templates: undefined }
        : { templates: body.templates };

  const emailConfig = isTemplateOnly
    ? {
        // Merge branding fields over the existing config so a template-only
        // PATCH can't clobber magic-link overrides or provider creds.
        ...(existingRow?.emailConfig ?? {}),
        ...(body.replyTo ? { replyTo: body.replyTo.trim() } : {}),
        ...(body.brandName ? { brandName: body.brandName.trim() } : {}),
        ...(body.templateId ? { templateId: body.templateId.trim() } : {}),
        ...(body.subjectOverride
          ? { subjectOverride: body.subjectOverride.trim() }
          : {}),
        ...(body.magicLinkBaseUrl
          ? { magicLinkBaseUrl: body.magicLinkBaseUrl.trim() }
          : {}),
        ...(body.magicLinkCallbackPath
          ? { magicLinkCallbackPath: body.magicLinkCallbackPath.trim() }
          : {}),
        ...templatesPatch,
      }
    : {
        provider: "resend" as const,
        apiKeyEncrypted: JSON.stringify(
          platformKeyStore().encrypt(body.apiKey.trim()),
        ),
        from: body.from.trim(),
        ...(body.replyTo ? { replyTo: body.replyTo.trim() } : {}),
        ...(body.brandName ? { brandName: body.brandName.trim() } : {}),
        ...(body.templateId ? { templateId: body.templateId.trim() } : {}),
        ...(body.subjectOverride
          ? { subjectOverride: body.subjectOverride.trim() }
          : {}),
        ...(body.magicLinkBaseUrl
          ? { magicLinkBaseUrl: body.magicLinkBaseUrl.trim() }
          : {}),
        ...(body.magicLinkCallbackPath
          ? { magicLinkCallbackPath: body.magicLinkCallbackPath.trim() }
          : {}),
        ...templatesPatch,
      };

  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "tenant.email_config.update.authorized",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: { from: emailConfig.from, hasReplyTo: !!emailConfig.replyTo },
    ...auditCtx(c),
  });

  const previousConfigRow = await snapshotPlatformTenantConfigRow(tenantId);
  const [existingConfig] = await db
    .select({ tenantId: tenantConfigs.tenantId })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  if (existingConfig) {
    await db
      .update(tenantConfigs)
      .set({ emailConfig, updatedAt: new Date() })
      .where(eq(tenantConfigs.tenantId, tenantId));
  } else {
    await db.insert(tenantConfigs).values({
      tenantId,
      emailConfig,
    });
  }

  invalidateEmailAuthForTenant(tenantId);

  try {
    await writeAuditEvent({
      tenantId,
      actorType: "platform",
      action: "tenant.email_config.update",
      resourceType: "tenant",
      resourceId: tenantId,
      metadata: { from: emailConfig.from, hasReplyTo: !!emailConfig.replyTo },
      ...auditCtx(c),
    });
  } catch (error) {
    await restorePlatformTenantConfigRow(tenantId, previousConfigRow);
    invalidateEmailAuthForTenant(tenantId);
    throw error;
  }

  return c.json<
    ApiResponse<{
      provider?: "resend";
      from?: string;
      replyTo?: string;
      brandName?: string;
      templateId?: string;
      subjectOverride?: string;
      hasApiKey: boolean;
    }>
  >({
    ok: true,
    data: {
      provider: emailConfig.provider,
      from: emailConfig.from,
      replyTo: emailConfig.replyTo,
      brandName: emailConfig.brandName,
      templateId: emailConfig.templateId,
      subjectOverride: emailConfig.subjectOverride,
      hasApiKey: Boolean(emailConfig.apiKeyEncrypted),
    },
  });
});

/**
 * GET /tenants/:tenantId/email-config
 * Returns the tenant-specific email config without exposing the encrypted API key.
 */
platform.get("/tenants/:tenantId/email-config", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-email-config:read",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("tenantId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  if (!(await getTenantOr404(tenantId))) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const [row] = await db
    .select({ emailConfig: tenantConfigs.emailConfig })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  const emailConfig = row?.emailConfig;

  return c.json<
    ApiResponse<{
      emailConfig: {
        provider?: "resend";
        from?: string;
        replyTo?: string;
        brandName?: string;
        templateId?: string;
        subjectOverride?: string;
        magicLinkBaseUrl?: string;
        magicLinkCallbackPath?: string;
        templates?: TenantEmailConfig["templates"];
      } | null;
      hasApiKey: boolean;
    }>
  >({
    ok: true,
    data: emailConfig
      ? {
          emailConfig: {
            provider: emailConfig.provider,
            from: emailConfig.from,
            replyTo: emailConfig.replyTo,
            brandName: emailConfig.brandName,
            templateId: emailConfig.templateId,
            subjectOverride: emailConfig.subjectOverride,
            magicLinkBaseUrl: emailConfig.magicLinkBaseUrl,
            magicLinkCallbackPath: emailConfig.magicLinkCallbackPath,
            templates: emailConfig.templates,
          },
          hasApiKey: Boolean(emailConfig.apiKeyEncrypted),
        }
      : {
          emailConfig: null,
          hasApiKey: false,
        },
  });
});

/**
 * GET /tenants/:tenantId/join-mode
 * Returns the tenant's join_mode ('open' | 'invite' | 'closed'; null when no
 * tenant_configs row exists — the join gate then treats it as not self-joinable).
 */
platform.get("/tenants/:tenantId/join-mode", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-join-mode:read",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("tenantId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  if (!(await getTenantOr404(tenantId))) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const [config] = await db
    .select({ joinMode: tenantConfigs.joinMode })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  return c.json<ApiResponse<{ tenantId: string; joinMode: string | null }>>({
    ok: true,
    data: { tenantId, joinMode: config?.joinMode ?? null },
  });
});

/**
 * PATCH /tenants/:tenantId/join-mode
 * Sets how users may join the tenant: 'open' (anyone authenticating with this
 * tenantId is auto-linked), 'invite' (existing user_tenants link required), or
 * 'closed' (no new members).
 *
 * This is the only application write surface for join_mode. It mirrors the
 * email-config mutation contract: scoped authorization, paired audits,
 * rollback on audit failure, and update-or-insert persistence.
 */
platform.patch("/tenants/:tenantId/join-mode", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-join-mode:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("tenantId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  if (!(await getTenantOr404(tenantId))) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const body = await safeJsonParse<{ joinMode: string }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  const joinMode =
    typeof body.joinMode === "string" ? body.joinMode.trim() : "";
  if (!["open", "invite", "closed"].includes(joinMode)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "joinMode must be one of 'open', 'invite', 'closed'",
      },
      400,
    );
  }

  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "tenant.join_mode.update.authorized",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: { joinMode },
    ...auditCtx(c),
  });

  const previousConfigRow = await snapshotPlatformTenantConfigRow(tenantId);
  const [existingConfig] = await db
    .select({ tenantId: tenantConfigs.tenantId })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  if (existingConfig) {
    await db
      .update(tenantConfigs)
      .set({ joinMode, updatedAt: new Date() })
      .where(eq(tenantConfigs.tenantId, tenantId));
  } else {
    await db.insert(tenantConfigs).values({ tenantId, joinMode });
  }

  try {
    await writeAuditEvent({
      tenantId,
      actorType: "platform",
      action: "tenant.join_mode.update",
      resourceType: "tenant",
      resourceId: tenantId,
      metadata: { joinMode },
      ...auditCtx(c),
    });
  } catch (error) {
    await restorePlatformTenantConfigRow(tenantId, previousConfigRow);
    throw error;
  }

  return c.json<ApiResponse<{ tenantId: string; joinMode: string }>>({
    ok: true,
    data: { tenantId, joinMode },
  });
});

platform.get("/tenants/:tenantId/oidc-providers", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-oidc:read",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("tenantId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!(await getTenantOr404(tenantId))) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const [row] = await db
    .select({ oidcProviders: tenantConfigs.oidcProviders })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  return c.json<ApiResponse<{ providers: TenantOidcProviderConfig[] }>>({
    ok: true,
    data: { providers: row?.oidcProviders ?? [] },
  });
});

platform.put("/tenants/:tenantId/oidc-providers", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-oidc:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("tenantId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!(await getTenantOr404(tenantId))) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const body = await safeJsonParse<{ providers?: unknown }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  const providers = normalizeOidcProviders(body.providers, tenantId);
  if (typeof providers === "string") {
    return c.json<ApiResponse>({ ok: false, error: providers }, 400);
  }

  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "tenant.oidc_providers.update.authorized",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: { providerIds: providers.map((provider) => provider.id) },
    ...auditCtx(c),
  });

  const previousConfigRow = await snapshotPlatformTenantConfigRow(tenantId);
  const [existingConfig] = await db
    .select({ tenantId: tenantConfigs.tenantId })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  if (existingConfig) {
    await db
      .update(tenantConfigs)
      .set({ oidcProviders: providers, updatedAt: new Date() })
      .where(eq(tenantConfigs.tenantId, tenantId));
  } else {
    await db
      .insert(tenantConfigs)
      .values({ tenantId, oidcProviders: providers });
  }

  try {
    await writeAuditEvent({
      tenantId,
      actorType: "platform",
      action: "tenant.oidc_providers.update",
      resourceType: "tenant",
      resourceId: tenantId,
      metadata: { providerIds: providers.map((provider) => provider.id) },
      ...auditCtx(c),
    });
  } catch (error) {
    await restorePlatformTenantConfigRow(tenantId, previousConfigRow);
    throw error;
  }

  return c.json<ApiResponse<{ providers: TenantOidcProviderConfig[] }>>({
    ok: true,
    data: { providers },
  });
});

platform.get("/tenants/:tenantId/test-account", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-test-account:read",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("tenantId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!(await getTenantOr404(tenantId))) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const [row] = await db
    .select({ testAccount: tenantConfigs.testAccount })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  return c.json<ApiResponse<{ testAccount: TenantTestAccountConfig }>>({
    ok: true,
    data: { testAccount: redactedTestAccount(row?.testAccount) },
  });
});

platform.post("/tenants/:tenantId/test-account", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-test-account:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("tenantId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!(await getTenantOr404(tenantId))) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const { testAccount, otp } = createTenantTestAccountConfig();
  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "tenant.test_account.enable.authorized",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: {
      email: testAccount.email,
      phone: testAccount.phone,
      rotated: true,
    },
    ...auditCtx(c),
  });

  const previousConfigRow = await snapshotPlatformTenantConfigRow(tenantId);
  const [existingConfig] = await db
    .select({ tenantId: tenantConfigs.tenantId })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  if (existingConfig) {
    await db
      .update(tenantConfigs)
      .set({ testAccount, updatedAt: new Date() })
      .where(eq(tenantConfigs.tenantId, tenantId));
  } else {
    await db.insert(tenantConfigs).values({ tenantId, testAccount });
  }

  try {
    await writeAuditEvent({
      tenantId,
      actorType: "platform",
      action: "tenant.test_account.enable",
      resourceType: "tenant",
      resourceId: tenantId,
      metadata: {
        email: testAccount.email,
        phone: testAccount.phone,
        rotated: true,
      },
      ...auditCtx(c),
    });
  } catch (error) {
    await restorePlatformTenantConfigRow(tenantId, previousConfigRow);
    throw error;
  }

  return c.json<ApiResponse<{ testAccount: TenantTestAccountConfig }>>({
    ok: true,
    data: { testAccount: publicTestAccount(testAccount, otp) },
  });
});

platform.delete("/tenants/:tenantId/test-account", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-test-account:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("tenantId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!(await getTenantOr404(tenantId))) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const disabled = { enabled: false, updatedAt: new Date().toISOString() };
  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "tenant.test_account.disable.authorized",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: {},
    ...auditCtx(c),
  });

  const previousConfigRow = await snapshotPlatformTenantConfigRow(tenantId);
  const [existingConfig] = await db
    .select({ tenantId: tenantConfigs.tenantId })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  if (existingConfig) {
    await db
      .update(tenantConfigs)
      .set({ testAccount: disabled, updatedAt: new Date() })
      .where(eq(tenantConfigs.tenantId, tenantId));
  } else {
    await db.insert(tenantConfigs).values({ tenantId, testAccount: disabled });
  }

  try {
    await writeAuditEvent({
      tenantId,
      actorType: "platform",
      action: "tenant.test_account.disable",
      resourceType: "tenant",
      resourceId: tenantId,
      metadata: {},
      ...auditCtx(c),
    });
  } catch (error) {
    await restorePlatformTenantConfigRow(tenantId, previousConfigRow);
    throw error;
  }

  return c.json<ApiResponse<{ testAccount: TenantTestAccountConfig }>>({
    ok: true,
    data: { testAccount: { enabled: false } },
  });
});

/**
 * DELETE /tenants/:tenantId/email-config
 * Clears the tenant-specific email config.
 */
platform.delete("/tenants/:tenantId/email-config", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-email-config:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("tenantId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  if (!(await getTenantOr404(tenantId))) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const [existingConfig] = await db
    .select({ tenantId: tenantConfigs.tenantId })
    .from(tenantConfigs)
    .where(eq(tenantConfigs.tenantId, tenantId));

  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "tenant.email_config.delete.authorized",
    resourceType: "tenant",
    resourceId: tenantId,
    ...auditCtx(c),
  });

  const previousConfigRow = await snapshotPlatformTenantConfigRow(tenantId);
  if (existingConfig) {
    await db
      .update(tenantConfigs)
      .set({ emailConfig: null, updatedAt: new Date() })
      .where(eq(tenantConfigs.tenantId, tenantId));
  }

  invalidateEmailAuthForTenant(tenantId);

  try {
    await writeAuditEvent({
      tenantId,
      actorType: "platform",
      action: "tenant.email_config.delete",
      resourceType: "tenant",
      resourceId: tenantId,
      ...auditCtx(c),
    });
  } catch (error) {
    await restorePlatformTenantConfigRow(tenantId, previousConfigRow);
    invalidateEmailAuthForTenant(tenantId);
    throw error;
  }

  return c.json<ApiResponse>({ ok: true });
});

/**
 * DELETE /tenants/:id
 * Permanently deletes a tenant and all associated agents (cascade in DB).
 */
platform.delete("/tenants/:id", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:tenant:delete");
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  const result = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      // This advisory fence is also acquired by every lease/provider/route/
      // capability writer installed by migration 0110. Whichever side wins is
      // authoritative: a prior writer becomes visible to the preflight; a late
      // writer waits until the tenant and its parents are gone, then fails.
      await tx.execute(
        sql`SELECT public.steward_lock_tenant_deletion(${tenantId})`,
      );
      const [existing] = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for("update");
      if (!existing) return { status: "missing" as const };

      const tenantAgents = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.tenantId, tenantId))
        .for("update");
      const tenantMembers = await tx
        .select({ userId: userTenants.userId })
        .from(userTenants)
        .where(eq(userTenants.tenantId, tenantId));
      const [
        [unresolvedLease],
        [retainedProviderIntent],
        [retainedProviderBinding],
      ] = await Promise.all([
        tx
          .select({ id: upstreamCredentialLeases.id })
          .from(upstreamCredentialLeases)
          .where(
            and(
              eq(upstreamCredentialLeases.tenantId, tenantId),
              or(
                notInArray(upstreamCredentialLeases.status, [
                  "revoked",
                  "expired",
                  "failed",
                ]),
                isNotNull(upstreamCredentialLeases.tokenHash),
                isNotNull(upstreamCredentialLeases.tokenCiphertext),
                isNotNull(upstreamCredentialLeases.tokenIv),
                isNotNull(upstreamCredentialLeases.tokenAuthTag),
                isNotNull(upstreamCredentialLeases.tokenSalt),
              ),
            ),
          )
          .limit(1),
        tx
          .select({ id: intents.id })
          .from(intents)
          .where(
            and(
              eq(intents.tenantId, tenantId),
              eq(intents.intentType, "provider-action"),
            ),
          )
          .limit(1),
        tx
          .select({ intentId: providerActionBindings.intentId })
          .from(providerActionBindings)
          .where(eq(providerActionBindings.tenantId, tenantId))
          .limit(1),
      ]);
      if (unresolvedLease) return { status: "blocked_by_lease" as const };
      if (retainedProviderIntent || retainedProviderBinding) {
        return { status: "blocked_by_provider" as const };
      }

      const capabilityCleanup = await cleanupOptionalTenantCapabilities(
        tx,
        tenantId,
      );
      if (!capabilityCleanup)
        return { status: "blocked_by_capability_integrity" as const };

      await appendRequiredAudit({
        tenantId,
        actorType: "platform",
        action: "tenant.delete.authorized",
        resourceType: "tenant",
        resourceId: tenantId,
        metadata: {
          agentTokenRevocationTargets: tenantAgents.length,
          userTokenRevocationTargets: tenantMembers.length,
          capabilityCleanup,
        },
        ...auditCtx(c),
      });
      await appendRequiredAudit({
        tenantId,
        actorType: "platform",
        action: "tenant.delete",
        resourceType: "tenant",
        resourceId: tenantId,
        metadata: {
          agentTokenRevocationTargets: tenantAgents.length,
          userTokenRevocationTargets: tenantMembers.length,
          capabilityCleanup,
        },
        ...auditCtx(c),
      });

      await tx
        .delete(refreshTokens)
        .where(eq(refreshTokens.tenantId, tenantId));
      await tx.delete(secretRoutes).where(eq(secretRoutes.tenantId, tenantId));
      await tx.delete(secrets).where(eq(secrets.tenantId, tenantId));
      await tx
        .delete(proxyAuditLog)
        .where(eq(proxyAuditLog.tenantId, tenantId));
      await tx.delete(tenants).where(eq(tenants.id, tenantId));
      return {
        status: "deleted" as const,
        agentIds: tenantAgents.map((agent) => agent.id),
        userIds: tenantMembers.map((member) => member.userId),
      };
    },
  );

  if (result.status === "missing") {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }
  if (result.status === "blocked_by_lease") {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant has unresolved upstream credential leases" },
      409,
    );
  }
  if (result.status === "blocked_by_provider") {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant has retained provider action evidence" },
      409,
    );
  }
  if (result.status === "blocked_by_capability_integrity") {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Tenant capability authority has cross-tenant references",
      },
      409,
    );
  }

  const [agentRevocationCutoffs, userRevocationCutoffs] = await Promise.all([
    Promise.all(
      result.agentIds.map((agentId) =>
        revocationStore.revokeAgentTokens(agentId),
      ),
    ),
    Promise.all(
      result.userIds.map((userId) => revocationStore.revokeUserTokens(userId)),
    ),
  ]);
  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "tenant.delete.token_revocation_completed",
    resourceType: "tenant",
    resourceId: tenantId,
    metadata: {
      agentRevocationCutoffsEstablished: agentRevocationCutoffs.length,
      userRevocationCutoffsEstablished: userRevocationCutoffs.length,
    },
    ...auditCtx(c),
  });

  return c.json<ApiResponse>({ ok: true });
});

/**
 * PUT /tenants/:id/policies
 * Body: PolicyRule[]
 *
 * Sets the default policy set for all agents in a tenant.
 * These are applied when an agent has no per-agent policies.
 *
 * Note: Because default policies live in-process (TenantConfig) in the main
 * API, this route stores them as a JSONB blob on the tenant row using a
 * dedicated `default_policies` column convention — integrate with the in-memory
 * tenantConfigs map when mounting in the main app.
 */
platform.put("/tenants/:id/policies", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-policy:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  if (!existing) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const body = await safeJsonParse<PolicyRule[]>(c);
  if (!body || !Array.isArray(body)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Request body must be a JSON array of PolicyRule objects",
      },
      400,
    );
  }

  // Validate each rule
  const validPolicyTypes = [
    "spending-limit",
    "approved-addresses",
    "auto-approve-threshold",
    "time-window",
    "rate-limit",
    "allowed-chains",
    "reputation-threshold",
    "reputation-scaling",
  ] as const;

  for (const rule of body) {
    if (!isNonEmptyString(rule.type)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Each policy must have a non-empty 'type' field" },
        400,
      );
    }
    if (!isPersistedPolicyType(rule.type)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Unknown policy type "${rule.type}" — supported: ${validPolicyTypes.join(", ")}`,
        },
        400,
      );
    }
    if (typeof rule.enabled !== "boolean") {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Policy "${rule.id ?? rule.type}": enabled must be a boolean`,
        },
        400,
      );
    }
    if (
      typeof rule.config !== "object" ||
      rule.config === null ||
      Array.isArray(rule.config)
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Policy "${rule.id ?? rule.type}": config must be a plain object`,
        },
        400,
      );
    }
  }

  return c.json<ApiResponse>(
    {
      ok: false,
      error:
        "Tenant default policies are not persisted or enforced by this endpoint; configure per-agent policies instead",
    },
    501,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-tenant agent management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /tenants/:id/agents
 * Body: { id: string; name: string; platformId?: string }
 *
 * Creates a single agent within the specified tenant.
 */
platform.post("/tenants/:id/agents", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:agent:create");
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  // Ensure tenant exists
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const body = await safeJsonParse<{
    id: string;
    name: string;
    platformId?: string;
  }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (!isValidAgentId(body.id)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Invalid agent id — must be 1-128 alphanumeric chars (plus _ - . :)",
      },
      400,
    );
  }

  if (!isNonEmptyString(body.name)) {
    return c.json<ApiResponse>(
      { ok: false, error: "name is required and must be a non-empty string" },
      400,
    );
  }

  try {
    await writeAuditEvent({
      tenantId,
      actorType: "platform",
      action: "agent.create.authorized",
      resourceType: "agent",
      resourceId: body.id,
      metadata: { name: body.name, platformId: body.platformId ?? null },
      ...auditCtx(c),
    });
    const identity = await vault().createAgent(
      tenantId,
      body.id,
      body.name,
      body.platformId,
    );
    try {
      await writeAuditEvent({
        tenantId,
        actorType: "platform",
        action: "agent.create",
        resourceType: "agent",
        resourceId: body.id,
        metadata: { name: body.name, platformId: body.platformId ?? null },
        ...auditCtx(c),
      });
    } catch (error) {
      await deletePlatformCreatedAgent(body.id, tenantId);
      throw error;
    }
    return c.json<ApiResponse<AgentIdentity>>(
      { ok: true, data: identity },
      201,
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return c.json<ApiResponse>({ ok: false, error: message }, 400);
  }
});

/**
 * POST /tenants/:id/agents/batch
 * Body: {
 *   agents: Array<{ id: string; name: string; platformId?: string }>;
 *   applyPolicies?: PolicyRule[];
 * }
 *
 * Batch-creates multiple agents in one request.  Returns both successful
 * creations and per-item errors (partial success is acceptable).
 */
platform.post("/tenants/:id/agents/batch", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:agent:create");
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const body = await safeJsonParse<{
    agents: Array<{ id: string; name: string; platformId?: string }>;
    applyPolicies?: PolicyRule[];
  }>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (!Array.isArray(body.agents) || body.agents.length === 0) {
    return c.json<ApiResponse>(
      { ok: false, error: "agents array is required and must not be empty" },
      400,
    );
  }

  if (body.agents.length > 100) {
    return c.json<ApiResponse>(
      { ok: false, error: "Batch size limit is 100 agents per request" },
      400,
    );
  }

  // Validate all specs upfront
  const agentIds = new Set<string>();
  for (const spec of body.agents) {
    if (!isValidAgentId(spec.id)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Invalid agent id "${String(spec.id)}" — must be 1-128 alphanumeric chars (plus _ - . :)`,
        },
        400,
      );
    }
    if (agentIds.has(spec.id)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Duplicate agent id "${spec.id}" in batch request`,
        },
        400,
      );
    }
    agentIds.add(spec.id);
    if (!isNonEmptyString(spec.name)) {
      return c.json<ApiResponse>(
        { ok: false, error: `Agent "${spec.id}" is missing a name` },
        400,
      );
    }
  }

  let persistedApplyPolicies: ReturnType<typeof toPersistedPolicyRule>[] = [];
  if (body.applyPolicies !== undefined) {
    if (!Array.isArray(body.applyPolicies)) {
      return c.json<ApiResponse>(
        { ok: false, error: "applyPolicies must be an array" },
        400,
      );
    }
    const rulesValidationError = getPolicyRulesValidationError(
      body.applyPolicies,
    );
    if (rulesValidationError) {
      return c.json<ApiResponse>(
        { ok: false, error: rulesValidationError },
        400,
      );
    }
    const conditionSetValidationError =
      await getConditionSetReferenceValidationError(
        tenantId,
        body.applyPolicies,
      );
    if (conditionSetValidationError) {
      return c.json<ApiResponse>(
        { ok: false, error: conditionSetValidationError },
        400,
      );
    }
  }

  if (body.applyPolicies && body.applyPolicies.length > 0) {
    try {
      persistedApplyPolicies = body.applyPolicies.map(toPersistedPolicyRule);
    } catch (err) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : "Invalid applyPolicies payload",
        },
        400,
      );
    }
  }

  const created: AgentIdentity[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const spec of body.agents) {
    let createdAgentId: string | null = null;
    try {
      await writeAuditEvent({
        tenantId,
        actorType: "platform",
        action: "agent.create.authorized",
        resourceType: "agent",
        resourceId: spec.id,
        metadata: {
          name: spec.name,
          platformId: spec.platformId ?? null,
          batch: true,
          appliedPolicyCount: persistedApplyPolicies.length,
        },
        ...auditCtx(c),
      });
      const identity = await vault().createAgent(
        tenantId,
        spec.id,
        spec.name,
        spec.platformId,
      );
      createdAgentId = spec.id;

      // Optionally apply default policies
      if (persistedApplyPolicies.length > 0) {
        await db.transaction(async (tx) => {
          await tx.delete(policies).where(eq(policies.agentId, spec.id));
          await tx.insert(policies).values(
            persistedApplyPolicies.map((policy) => ({
              id: policy.id || crypto.randomUUID(),
              agentId: spec.id,
              type: policy.type,
              enabled: policy.enabled,
              config: policy.config,
            })),
          );
        });
      }

      await writeAuditEvent({
        tenantId,
        actorType: "platform",
        action: "agent.create",
        resourceType: "agent",
        resourceId: spec.id,
        metadata: {
          name: spec.name,
          platformId: spec.platformId ?? null,
          batch: true,
          appliedPolicyCount: persistedApplyPolicies.length,
        },
        ...auditCtx(c),
      });
      created.push(identity);
    } catch (e: unknown) {
      if (createdAgentId) {
        await deletePlatformCreatedAgent(createdAgentId, tenantId);
      }
      errors.push({
        id: spec.id,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  return c.json<
    ApiResponse<{
      created: AgentIdentity[];
      errors: Array<{ id: string; error: string }>;
    }>
  >({
    ok: true,
    data: { created, errors },
  });
});

/**
 * GET /tenants/:id/agents
 * Lists all agents belonging to the specified tenant.
 */
platform.get("/tenants/:id/agents", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:agent:read");
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const limit = parseListLimit(c.req.query("limit"));
  const offset = parseListOffset(c.req.query("offset"));
  const tenantAgents = await vault().listAgentsByTenant(tenantId, {
    limit,
    offset,
  });

  return c.json<ApiResponse<AgentIdentity[]>>({
    ok: true,
    data: tenantAgents,
  });
});

/**
 * DELETE /tenants/:id/agents/:agentId
 *
 * Permanently deletes a single agent within the specified tenant, cascading to
 * its wallets, encrypted keys, policies, transactions, and queued approvals.
 *
 * Mirrors the tenant-scoped (owner/admin-session-only) DELETE /agents/:agentId
 * route, but authorized via a scoped platform key (platform:agent:delete) so
 * platform operators can deprovision agents without a tenant session JWT.
 */
platform.delete("/tenants/:id/agents/:agentId", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:agent:delete");
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");
  const agentId = c.req.param("agentId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!isValidAgentId(agentId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid agent id format" },
      400,
    );
  }

  // Ensure the agent exists and belongs to this tenant before deleting.
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));
  if (!agent) {
    return c.json<ApiResponse>(
      { ok: false, error: "Agent not found in tenant" },
      404,
    );
  }

  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "agent.delete.authorized",
    resourceType: "agent",
    resourceId: agentId,
    ...auditCtx(c),
  });

  let issuedBefore = 0;
  const completionAudit = {
    tenantId,
    actorType: "platform" as const,
    action: "agent.delete",
    resourceType: "agent",
    resourceId: agentId,
    metadata: {},
    ...auditCtx(c),
  };
  const deletion = await deleteAgentAuthority({
    tenantId,
    agentId,
    completionAudit,
    beforeDelete: async () => {
      issuedBefore = await revocationStore.revokeAgentTokens(agentId);
      completionAudit.metadata = {
        revokedAgentTokensIssuedBefore: issuedBefore,
      };
    },
  });
  if (deletion === "blocked_by_upstream_lease") {
    return c.json<ApiResponse>(
      { ok: false, error: "Agent has unresolved upstream credential leases" },
      409,
    );
  }
  if (deletion === "blocked_by_executing_proxy") {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Agent has an executing proxy request; retry deletion later",
      },
      409,
    );
  }
  if (deletion === "blocked_by_unresolved_execution") {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Agent has unresolved execution evidence; reconcile it first",
      },
      409,
    );
  }
  if (deletion === "missing") {
    return c.json<ApiResponse>(
      { ok: false, error: "Agent not found in tenant" },
      404,
    );
  }

  return c.json<ApiResponse<{ deleted: string }>>({
    ok: true,
    data: { deleted: agentId },
  });
});

/**
 * POST /tenants/:id/agents/:agentId/token
 * Body: { expiresIn?: string, scopes?: string[] | string }
 *
 * Generates a scoped JWT for the specified agent.
 * Used by platform operators (e.g. Milady Cloud provisioner) to mint
 * agent tokens during container provisioning without needing a tenant
 * session JWT.
 */
platform.post("/tenants/:id/agents/:agentId/token", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:agent-token:create",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");
  const agentId = c.req.param("agentId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  // Ensure tenant exists
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  // Ensure agent belongs to tenant
  const agent = await vault().getAgent(tenantId, agentId);
  if (!agent) {
    return c.json<ApiResponse>(
      { ok: false, error: "Agent not found in tenant" },
      404,
    );
  }

  const body = await safeJsonParse<{
    expiresIn?: string;
    scopes?: string[] | string;
  }>(c);
  let expiresIn: string;
  try {
    expiresIn = normalizePlatformAgentTokenExpiry(body?.expiresIn);
  } catch (err) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Invalid expiresIn",
      },
      400,
    );
  }
  const scopes = parseAgentTokenScopes(body?.scopes ?? c.req.query("scopes"));
  if (!scopes) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Invalid scopes — supported values: agent, api:proxy",
      },
      400,
    );
  }

  try {
    const token = await createAgentTokenForExistingAgent(
      agentId,
      tenantId,
      expiresIn,
      scopes,
    );
    if (!token) {
      return c.json<ApiResponse>(
        { ok: false, error: "Agent not found in tenant" },
        404,
      );
    }
    await writeAuditEvent({
      tenantId,
      actorType: "platform",
      action: "agent.token.create",
      resourceType: "agent",
      resourceId: agentId,
      metadata: { scopes, expiresIn },
      ...auditCtx(c),
    });
    return c.json<
      ApiResponse<{
        token: string;
        agentId: string;
        tenantId: string;
        scope: string;
        scopes: string[];
      }>
    >({
      ok: true,
      data: { token, agentId, tenantId, scope: "agent", scopes },
    });
  } catch (e: unknown) {
    logger.error(
      {
        details: [
          `[platform] Failed to generate agent token for ${agentId}`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:platform] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: "Failed to generate token" },
      500,
    );
  }
});

/**
 * POST /agents/:id/revoke-tokens
 * Revokes all outstanding agent tokens issued before the revocation line.
 *
 * Implementation note: Redis stores both a marker key
 * `revoked-agent:<agentId>:<issuedBefore>` and the latest cutoff pointer. When
 * REDIS_URL is absent this uses the auth package's in-memory fallback, suitable
 * only for single-instance/embedded mode.
 */
platform.post("/agents/:id/revoke-tokens", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:agent-token:revoke",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const agentId = c.req.param("id");

  if (!isValidAgentId(agentId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid agent id format" },
      400,
    );
  }

  const [agent] = await db
    .select({ id: agents.id, tenantId: agents.tenantId })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  await writeAuditEvent({
    tenantId: agent.tenantId,
    actorType: "platform",
    action: "agent.token.revoke_all.authorized",
    resourceType: "agent",
    resourceId: agentId,
    ...auditCtx(c),
  });
  const issuedBefore = await revocationStore.revokeAgentTokens(agentId);
  await writeAuditEvent({
    tenantId: agent.tenantId,
    actorType: "platform",
    action: "agent.token.revoke_all",
    resourceType: "agent",
    resourceId: agentId,
    metadata: { issuedBefore },
    ...auditCtx(c),
  });
  return c.json<
    ApiResponse<{ agentId: string; tenantId: string; issuedBefore: number }>
  >({
    ok: true,
    data: { agentId, tenantId: agent.tenantId, issuedBefore },
  });
});

type PlatformWalletExternalLink = PlatformWalletExternalIdRow & {
  isNew: boolean;
};

async function linkWalletExternalIdForUser(input: {
  userId: string;
  tenantId: string;
  externalId: string;
}): Promise<PlatformWalletExternalLink | Error> {
  const db = getDb();
  const externalId = input.externalId.trim();
  if (!isValidWalletExternalId(externalId))
    return new Error("Invalid walletExternalId");

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, input.tenantId));
  if (!tenant) return new Error("Tenant not found");

  const [membership] = await db
    .select({ id: userTenants.id })
    .from(userTenants)
    .where(
      and(
        eq(userTenants.userId, input.userId),
        eq(userTenants.tenantId, input.tenantId),
      ),
    );
  if (!membership) return new Error("User not found in tenant");

  const providerAccountId = walletExternalProviderAccountId(
    input.tenantId,
    externalId,
  );
  const [existingForExternalId] = await db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, WALLET_EXTERNAL_ID_PROVIDER),
        eq(accounts.providerAccountId, providerAccountId),
      ),
    );
  if (existingForExternalId && existingForExternalId.userId !== input.userId) {
    return new Error(
      "walletExternalId already belongs to another user in this tenant",
    );
  }

  const existingForUser = await db
    .select({ providerAccountId: accounts.providerAccountId })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, input.userId),
        eq(accounts.provider, WALLET_EXTERNAL_ID_PROVIDER),
      ),
    );
  const existingForTenant = existingForUser
    .map((row) =>
      parseWalletExternalProviderAccountId(row.providerAccountId, [
        input.tenantId,
      ]),
    )
    .find((row) => row?.tenantId === input.tenantId);
  if (existingForTenant && existingForTenant.externalId !== externalId) {
    return new Error(
      "walletExternalId is immutable for this user in this tenant",
    );
  }
  if (existingForTenant) {
    return { tenantId: input.tenantId, externalId, isNew: false };
  }

  await db.insert(accounts).values({
    userId: input.userId,
    provider: WALLET_EXTERNAL_ID_PROVIDER,
    providerAccountId,
  });
  return { tenantId: input.tenantId, externalId, isNew: true };
}

async function insertTenantMembershipIfMissing(input: {
  userId: string;
  tenantId: string;
  role: string;
}): Promise<boolean> {
  const [created] = await getDb()
    .insert(userTenants)
    .values(input)
    .onConflictDoNothing()
    .returning({ id: userTenants.id });
  return Boolean(created);
}

async function rollbackTenantMembership(input: {
  userId: string;
  tenantId: string;
}) {
  await getDb()
    .delete(userTenants)
    .where(
      and(
        eq(userTenants.userId, input.userId),
        eq(userTenants.tenantId, input.tenantId),
      ),
    );
}

function walletExternalLinkStatus(error: Error): 400 | 404 | 409 | 500 {
  switch (error.message) {
    case "Invalid walletExternalId":
      return 400;
    case "Tenant not found":
    case "User not found in tenant":
      return 404;
    case "walletExternalId already belongs to another user in this tenant":
    case "walletExternalId is immutable for this user in this tenant":
      return 409;
    default:
      return 500;
  }
}

type PlatformUserCreateData = {
  userId: string;
  isNew: boolean;
  tenantId?: string;
  walletExternalId?: string;
};

/**
 * POST /platform/users
 * Pre-provision a user record without sending an email or requiring interaction.
 * Intended for migration tooling (e.g. importing users from another auth provider).
 *
 * The route is idempotent: if a user with this email already exists, it returns
 * the existing record's ID and isNew=false — no data is overwritten. When
 * tenantId + walletExternalId are provided, the user is linked to the tenant and
 * assigned an immutable per-tenant wallet external ID at creation time.
 *
 * Body: { email: string; emailVerified?: boolean; name?: string; customMetadata?: object; tenantId?: string; walletExternalId?: string }
 * Returns: { ok: true; userId: string; isNew: boolean; tenantId?: string; walletExternalId?: string }
 */
platform.post("/users", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:user:write");
  if (scopeResponse) return scopeResponse;

  const body = await safeJsonParse<{
    email: string;
    emailVerified?: boolean;
    name?: string;
    customMetadata?: Record<string, unknown>;
    tenantId?: unknown;
    walletExternalId?: unknown;
    externalId?: unknown;
  }>(c);
  if (
    !body?.email ||
    typeof body.email !== "string" ||
    !body.email.includes("@")
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "A valid email is required" },
      400,
    );
  }
  const walletExternalId =
    typeof body.walletExternalId === "string"
      ? body.walletExternalId
      : typeof body.externalId === "string"
        ? body.externalId
        : undefined;
  const tenantId =
    typeof body.tenantId === "string" ? body.tenantId.trim() : undefined;
  if (tenantId !== undefined && !isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (walletExternalId !== undefined) {
    if (!tenantId)
      return c.json<ApiResponse>(
        { ok: false, error: "tenantId is required with walletExternalId" },
        400,
      );
    if (!isValidTenantId(tenantId)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid tenant id format" },
        400,
      );
    }
    if (!isValidWalletExternalId(walletExternalId)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid walletExternalId" },
        400,
      );
    }
  }
  if (body.customMetadata !== undefined) {
    const metadataError = getPlatformMetadataValidationError(
      body.customMetadata,
      "customMetadata",
    );
    if (metadataError)
      return c.json<ApiResponse>({ ok: false, error: metadataError }, 400);
  }

  const db = getDb();
  const email = body.email.toLowerCase().trim();

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));

  if (existing) {
    if (tenantId && walletExternalId !== undefined) {
      const [tenant] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      if (!tenant)
        return c.json<ApiResponse>(
          { ok: false, error: "Tenant not found" },
          404,
        );
      const createdMembership = await insertTenantMembershipIfMissing({
        userId: existing.id,
        tenantId,
        role: "member",
      });
      const linked = await linkWalletExternalIdForUser({
        userId: existing.id,
        tenantId,
        externalId: walletExternalId,
      });
      if (linked instanceof Error) {
        if (createdMembership) {
          await rollbackTenantMembership({ userId: existing.id, tenantId });
        }
        return c.json<ApiResponse>(
          { ok: false, error: linked.message },
          walletExternalLinkStatus(linked),
        );
      }
    }
    await writeAuditEvent({
      tenantId: tenantId ?? PLATFORM_AUDIT_TENANT_ID,
      actorType: "platform",
      action: "user.provision.existing",
      resourceType: "user",
      resourceId: existing.id,
      metadata: { email, hasWalletExternalId: walletExternalId !== undefined },
      ...auditCtx(c),
    });
    return c.json<ApiResponse<PlatformUserCreateData>>({
      ok: true,
      data: { userId: existing.id, isNew: false, tenantId, walletExternalId },
    });
  }

  if (tenantId) {
    const [tenant] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenant)
      return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  await writeAuditEvent({
    tenantId: tenantId ?? PLATFORM_AUDIT_TENANT_ID,
    actorType: "platform",
    action: "user.provision.create",
    resourceType: "user",
    resourceId: email,
    metadata: {
      email,
      emailVerified: body.emailVerified ?? false,
      hasCustomMetadata: !!body.customMetadata,
      hasWalletExternalId: walletExternalId !== undefined,
    },
    ...auditCtx(c),
  });

  const [newUser] = await db
    .insert(users)
    .values({
      email,
      emailVerified: body.emailVerified ?? false,
      name: body.name ?? null,
      customMetadata: body.customMetadata ?? {},
    })
    .returning();

  if (tenantId && walletExternalId !== undefined) {
    await insertTenantMembershipIfMissing({
      userId: newUser.id,
      tenantId,
      role: "member",
    });
    const linked = await linkWalletExternalIdForUser({
      userId: newUser.id,
      tenantId,
      externalId: walletExternalId,
    });
    if (linked instanceof Error) {
      await db.delete(users).where(eq(users.id, newUser.id));
      return c.json<ApiResponse>(
        { ok: false, error: linked.message },
        walletExternalLinkStatus(linked),
      );
    }
  }

  dispatchWebhook(
    tenantId ?? PLATFORM_AUDIT_TENANT_ID,
    newUser.id,
    "user.created",
    {
      userId: newUser.id,
      source: "platform.provision",
      hasEmail: true,
    },
  );

  return c.json<ApiResponse<PlatformUserCreateData>>(
    {
      ok: true,
      data: { userId: newUser.id, isNew: true, tenantId, walletExternalId },
    },
    201,
  );
});

/**
 * POST /users/wallet/external-id/connect-or-create
 * Resolve a tenant wallet external ID to a user, or create/connect a user when
 * no mapping exists. This is the backend primitive for connect-or-create wallet
 * parity; hosted/modal UX can call it after external-wallet selection.
 */
platform.post("/users/wallet/external-id/connect-or-create", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:user:write");
  if (scopeResponse) return scopeResponse;

  const body = await safeJsonParse<{
    tenantId?: unknown;
    walletExternalId?: unknown;
    externalId?: unknown;
    email?: unknown;
    emailVerified?: boolean;
    name?: string;
    customMetadata?: Record<string, unknown>;
    role?: unknown;
  }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  const tenantId =
    typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  const walletExternalId =
    typeof body.walletExternalId === "string"
      ? body.walletExternalId
      : typeof body.externalId === "string"
        ? body.externalId
        : "";
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!isValidWalletExternalId(walletExternalId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid walletExternalId" },
      400,
    );
  }
  if (
    body.email !== undefined &&
    (typeof body.email !== "string" || !body.email.includes("@"))
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "email must be valid when provided" },
      400,
    );
  }
  if (body.customMetadata !== undefined) {
    const metadataError = getPlatformMetadataValidationError(
      body.customMetadata,
      "customMetadata",
    );
    if (metadataError)
      return c.json<ApiResponse>({ ok: false, error: metadataError }, 400);
  }

  const db = getDb();
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant)
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);

  const email =
    typeof body.email === "string" ? body.email.toLowerCase().trim() : null;
  const [existingByEmail] = email
    ? await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
    : [];
  const existingByExternalId = await lookupPlatformUserIdentity({
    tenantId,
    walletExternalId,
  });
  if (existingByExternalId) {
    if (existingByEmail && existingByEmail.id !== existingByExternalId.userId) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "walletExternalId already belongs to another user in this tenant",
        },
        409,
      );
    }
    return c.json<
      ApiResponse<
        PlatformUserCreateData & {
          createdExternalId: boolean;
          user: PlatformUserIdentity;
        }
      >
    >({
      ok: true,
      data: {
        userId: existingByExternalId.userId,
        isNew: false,
        createdExternalId: false,
        tenantId,
        walletExternalId: walletExternalId.trim(),
        user: existingByExternalId,
      },
    });
  }

  const role =
    typeof body.role === "string" && TENANT_MEMBER_ROLES.has(body.role)
      ? body.role
      : "member";
  let userId = existingByEmail?.id;
  let isNew = false;
  if (!userId) {
    const [created] = await db
      .insert(users)
      .values({
        email,
        emailVerified: body.emailVerified ?? false,
        name: body.name ?? null,
        customMetadata: body.customMetadata ?? {},
      })
      .returning({ id: users.id });
    userId = created.id;
    isNew = true;
  }
  const createdMembership = await insertTenantMembershipIfMissing({
    userId,
    tenantId,
    role,
  });
  const linked = await linkWalletExternalIdForUser({
    userId,
    tenantId,
    externalId: walletExternalId,
  });
  if (linked instanceof Error) {
    if (isNew) {
      await db.delete(users).where(eq(users.id, userId));
    } else if (createdMembership) {
      await rollbackTenantMembership({ userId, tenantId });
    }
    return c.json<ApiResponse>(
      { ok: false, error: linked.message },
      walletExternalLinkStatus(linked),
    );
  }

  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "user.wallet_external_id.connect_or_create",
    resourceType: "user",
    resourceId: userId,
    metadata: { isNew, createdExternalId: linked.isNew, hasEmail: !!email },
    ...auditCtx(c),
  });
  const user = (await lookupPlatformUserIdentity({
    tenantId,
    walletExternalId,
  })) as PlatformUserIdentity;
  return c.json<
    ApiResponse<
      PlatformUserCreateData & {
        createdExternalId: boolean;
        user: PlatformUserIdentity;
      }
    >
  >(
    {
      ok: true,
      data: {
        userId,
        isNew,
        createdExternalId: linked.isNew,
        tenantId,
        walletExternalId: walletExternalId.trim(),
        user,
      },
    },
    linked.isNew ? 201 : 200,
  );
});

type PlatformLinkedAccountRow = {
  id: string;
  provider: string;
  providerAccountId: string;
  expiresAt: number | null;
};

type PlatformWalletExternalIdRow = {
  tenantId: string;
  externalId: string;
};

type PlatformUserIdentity = {
  userId: string;
  email: string | null;
  emailVerified: boolean | null;
  name: string | null;
  image: string | null;
  walletAddress: string | null;
  walletChain: string | null;
  customMetadata: Record<string, unknown>;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  tenantIds: string[];
  linkedAccounts: PlatformLinkedAccountRow[];
  walletExternalIds: PlatformWalletExternalIdRow[];
};

async function serializePlatformUserIdentity(
  userId: string,
): Promise<PlatformUserIdentity | null> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return null;
  const [tenantRows, accountRows] = await Promise.all([
    db
      .execute(
        sql`SELECT * FROM steward_bootstrap.platform_user_tenant_ids(${userId}::uuid)`,
      )
      .then((result) => rowsFromExecute<{ tenant_id: string }>(result)),
    db
      .select({
        id: accounts.id,
        provider: accounts.provider,
        providerAccountId: accounts.providerAccountId,
        expiresAt: accounts.expiresAt,
      })
      .from(accounts)
      .where(eq(accounts.userId, userId)),
  ]);
  const tenantIds = tenantRows.map((row) => row.tenant_id);
  const walletExternalIds = accountRows
    .filter((row) => row.provider === WALLET_EXTERNAL_ID_PROVIDER)
    .map((row) =>
      parseWalletExternalProviderAccountId(row.providerAccountId, tenantIds),
    )
    .filter((row): row is PlatformWalletExternalIdRow => row !== null);

  return {
    userId: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    name: user.name,
    image: user.image,
    walletAddress: user.walletAddress,
    walletChain: user.walletChain,
    customMetadata: user.customMetadata ?? {},
    deactivatedAt: user.deactivatedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    tenantIds,
    linkedAccounts: accountRows.filter(
      (row) => row.provider !== WALLET_EXTERNAL_ID_PROVIDER,
    ),
    walletExternalIds,
  };
}

type PlatformUserLookupInput = {
  email?: string;
  phone?: string;
  walletAddress?: string;
  walletExternalId?: string;
  smartWalletId?: string;
  customAuthId?: string;
  provider?: string;
  providerAccountId?: string;
  tenantId?: string;
};

async function lookupPlatformUserIdentity(
  input: PlatformUserLookupInput,
): Promise<PlatformUserIdentity | null> {
  const db = getDb();
  const email = input.email?.trim().toLowerCase();
  const phone = input.phone?.trim();
  const walletAddress = input.walletAddress?.trim();
  const walletExternalId = input.walletExternalId?.trim();
  const smartWalletId = input.smartWalletId?.trim();
  const customAuthId = input.customAuthId?.trim();
  const provider = input.provider?.trim();
  const providerAccountId = input.providerAccountId?.trim();
  const tenantId = input.tenantId?.trim();

  let candidateUserId: string | null = null;
  if (email) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    candidateUserId = user?.id ?? null;
  } else if (phone) {
    if (!isValidE164(phone)) throw new Error("phone must be E.164");
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.walletAddress, `phone:${hashSha256Hex(phone)}`));
    candidateUserId = user?.id ?? null;
  } else if (walletAddress) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.walletAddress, walletAddress));
    candidateUserId = user?.id ?? null;
  } else if (walletExternalId) {
    if (!tenantId)
      throw new Error("tenantId is required for walletExternalId lookup");
    if (!isValidWalletExternalId(walletExternalId))
      throw new Error("Invalid walletExternalId");
    const [account] = await db
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, WALLET_EXTERNAL_ID_PROVIDER),
          eq(
            accounts.providerAccountId,
            walletExternalProviderAccountId(tenantId, walletExternalId),
          ),
        ),
      );
    candidateUserId = account?.userId ?? null;
  } else if (smartWalletId) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.stewardWalletId, smartWalletId));
    candidateUserId = user?.id ?? null;
  } else if (customAuthId) {
    const [account] = await db
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, "custom"),
          eq(accounts.providerAccountId, customAuthId),
        ),
      );
    candidateUserId = account?.userId ?? null;
  } else if (provider && providerAccountId) {
    const [account] = await db
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, provider),
          eq(accounts.providerAccountId, providerAccountId),
        ),
      );
    candidateUserId = account?.userId ?? null;
  } else {
    throw new Error(
      "email, phone, walletAddress, walletExternalId, smartWalletId, customAuthId, or provider + providerAccountId is required",
    );
  }

  if (!candidateUserId) return null;
  if (tenantId) {
    const [link] = await db
      .select({ id: userTenants.id })
      .from(userTenants)
      .where(
        and(
          eq(userTenants.userId, candidateUserId),
          eq(userTenants.tenantId, tenantId),
        ),
      );
    if (!link) return null;
  }

  const identity = await serializePlatformUserIdentity(candidateUserId);
  if (!identity) return null;
  if (!tenantId) return identity;
  return {
    ...identity,
    tenantIds: [tenantId],
    linkedAccounts: [],
    walletExternalIds: identity.walletExternalIds.filter(
      (row) => row.tenantId === tenantId,
    ),
  };
}

/**
 * GET /users/lookup
 * Lookup by email, phone, walletAddress, walletExternalId, smartWalletId,
 * customAuthId, or provider + providerAccountId. Optional tenantId constrains
 * the result to users linked to that tenant. walletExternalId requires tenantId.
 */
platform.get("/users/lookup", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:user:read");
  if (scopeResponse) return scopeResponse;

  const tenantId = c.req.query("tenantId")?.trim();

  if (tenantId && !isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  let user: PlatformUserIdentity | null;
  try {
    user = await lookupPlatformUserIdentity({
      email: c.req.query("email"),
      phone: c.req.query("phone"),
      walletAddress: c.req.query("walletAddress"),
      walletExternalId: c.req.query("walletExternalId"),
      smartWalletId: c.req.query("smartWalletId"),
      customAuthId: c.req.query("customAuthId"),
      provider: c.req.query("provider"),
      providerAccountId: c.req.query("providerAccountId"),
      tenantId,
    });
  } catch (error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Invalid lookup request",
      },
      400,
    );
  }

  return c.json<ApiResponse<{ user: PlatformUserIdentity | null }>>({
    ok: true,
    data: { user },
  });
});

async function platformUserLookupAlias(
  c: Context<{ Variables: AppVariables }>,
  input: PlatformUserLookupInput,
) {
  const scopeResponse = requirePlatformRouteScope(c, "platform:user:read");
  if (scopeResponse) return scopeResponse;

  if (input.tenantId && !isValidTenantId(input.tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  try {
    const user = await lookupPlatformUserIdentity(input);
    return c.json<ApiResponse<{ user: PlatformUserIdentity | null }>>({
      ok: true,
      data: { user },
    });
  } catch (error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Invalid lookup request",
      },
      400,
    );
  }
}

platform.post("/users/email/address", async (c) => {
  const body = await safeJsonParse<{ email?: unknown; tenantId?: unknown }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  return platformUserLookupAlias(c, {
    email: typeof body.email === "string" ? body.email : undefined,
    tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
  });
});

platform.post("/users/phone/number", async (c) => {
  const body = await safeJsonParse<{ phone?: unknown; tenantId?: unknown }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  return platformUserLookupAlias(c, {
    phone: typeof body.phone === "string" ? body.phone : undefined,
    tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
  });
});

platform.post("/users/wallet/address", async (c) => {
  const body = await safeJsonParse<{
    walletAddress?: unknown;
    tenantId?: unknown;
  }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  return platformUserLookupAlias(c, {
    walletAddress:
      typeof body.walletAddress === "string" ? body.walletAddress : undefined,
    tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
  });
});

platform.post("/users/wallet/external-id", async (c) => {
  const body = await safeJsonParse<{
    walletExternalId?: unknown;
    externalId?: unknown;
    tenantId?: unknown;
  }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  return platformUserLookupAlias(c, {
    walletExternalId:
      typeof body.walletExternalId === "string"
        ? body.walletExternalId
        : typeof body.externalId === "string"
          ? body.externalId
          : undefined,
    tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
  });
});

platform.post("/users/smart-wallet/address", async (c) => {
  const body = await safeJsonParse<{
    smartWalletId?: unknown;
    smartWalletAddress?: unknown;
    tenantId?: unknown;
  }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  return platformUserLookupAlias(c, {
    smartWalletId:
      typeof body.smartWalletId === "string"
        ? body.smartWalletId
        : typeof body.smartWalletAddress === "string"
          ? body.smartWalletAddress
          : undefined,
    tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
  });
});

platform.post("/users/custom-auth/id", async (c) => {
  const body = await safeJsonParse<{
    customAuthId?: unknown;
    tenantId?: unknown;
  }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  return platformUserLookupAlias(c, {
    customAuthId:
      typeof body.customAuthId === "string" ? body.customAuthId : undefined,
    tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
  });
});

function providerLookupAlias(provider: string) {
  return async (c: Context<{ Variables: AppVariables }>) => {
    const body = await safeJsonParse<{
      providerAccountId?: unknown;
      subject?: unknown;
      username?: unknown;
      id?: unknown;
      tenantId?: unknown;
    }>(c);
    if (!body)
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid JSON in request body" },
        400,
      );
    const providerAccountId =
      typeof body.providerAccountId === "string"
        ? body.providerAccountId
        : typeof body.subject === "string"
          ? body.subject
          : typeof body.username === "string"
            ? body.username
            : typeof body.id === "string"
              ? body.id
              : undefined;
    return platformUserLookupAlias(c, {
      provider,
      providerAccountId,
      tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
    });
  };
}

platform.post("/users/discord/username", providerLookupAlias("discord"));
platform.post("/users/github/username", providerLookupAlias("github"));
platform.post("/users/farcaster/id", providerLookupAlias("farcaster"));
platform.post("/users/instagram/username", providerLookupAlias("instagram"));
platform.post("/users/spotify/subject", providerLookupAlias("spotify"));
platform.post("/users/telegram/user-id", providerLookupAlias("telegram"));
platform.post("/users/telegram/username", providerLookupAlias("telegram"));
platform.post("/users/twitch/username", providerLookupAlias("twitch"));
platform.post("/users/twitter/subject", providerLookupAlias("twitter"));
platform.post("/users/twitter/username", providerLookupAlias("twitter"));

/**
 * GET /users/:userId
 * Platform-level identity graph read. Includes global linked accounts and
 * tenant membership IDs, unlike tenant-scoped user routes.
 */
platform.get("/users/:userId", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:user:read");
  if (scopeResponse) return scopeResponse;

  const userId = c.req.param("userId");
  if (!isValidUserId(userId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid user id format" },
      400,
    );
  }

  const identity = await serializePlatformUserIdentity(userId);
  if (!identity)
    return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);
  return c.json<ApiResponse<PlatformUserIdentity>>({
    ok: true,
    data: identity,
  });
});

/**
 * PATCH /users/:userId/metadata
 * Replace global user custom metadata. Tenant-scoped metadata remains under
 * /tenants/:id/users/:userId/metadata.
 * Body: { customMetadata: object }
 */
platform.patch("/users/:userId/metadata", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:user:write");
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const userId = c.req.param("userId");
  if (!isValidUserId(userId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid user id format" },
      400,
    );
  }

  const body = await safeJsonParse<{
    customMetadata?: Record<string, unknown>;
  }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  if (body.customMetadata === undefined) {
    return c.json<ApiResponse>(
      { ok: false, error: "customMetadata is required" },
      400,
    );
  }
  const metadataError = getPlatformMetadataValidationError(
    body.customMetadata,
    "customMetadata",
  );
  if (metadataError)
    return c.json<ApiResponse>({ ok: false, error: metadataError }, 400);

  const [existing] = await db
    .select({
      id: users.id,
      customMetadata: users.customMetadata,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!existing)
    return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);

  await writeAuditEvent({
    tenantId: PLATFORM_AUDIT_TENANT_ID,
    actorType: "platform",
    action: "user.metadata.update.authorized",
    resourceType: "user",
    resourceId: userId,
    metadata: { updatedGlobal: true },
    ...auditCtx(c),
  });

  const [updated] = await db
    .update(users)
    .set({ customMetadata: body.customMetadata, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (!updated)
    return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);

  try {
    await writeAuditEvent({
      tenantId: PLATFORM_AUDIT_TENANT_ID,
      actorType: "platform",
      action: "user.metadata.update",
      resourceType: "user",
      resourceId: userId,
      metadata: { updatedGlobal: true },
      ...auditCtx(c),
    });
  } catch (error) {
    await db
      .update(users)
      .set({
        customMetadata: existing.customMetadata,
        updatedAt: existing.updatedAt,
      })
      .where(eq(users.id, userId));
    throw error;
  }
  dispatchWebhook(PLATFORM_AUDIT_TENANT_ID, userId, "user.updated_account", {
    userId,
    scope: "global",
    field: "customMetadata",
  });

  const identity = await serializePlatformUserIdentity(userId);
  return c.json<ApiResponse<PlatformUserIdentity>>({
    ok: true,
    data: identity as PlatformUserIdentity,
  });
});

/**
 * PATCH /users/:userId/deactivate
 * Deactivates a global user, clears refresh tokens, and blocks future auth.
 * Body: { deactivated?: boolean } where false reactivates the user.
 */
platform.patch("/users/:userId/deactivate", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:user-lifecycle:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const userId = c.req.param("userId");
  if (!isValidUserId(userId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid user id format" },
      400,
    );
  }
  const body = await safeJsonParse<{ deactivated?: boolean }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  const deactivated = body.deactivated !== false;

  await writeAuditEvent({
    tenantId: PLATFORM_AUDIT_TENANT_ID,
    actorType: "platform",
    action: deactivated
      ? "user.deactivate.authorized"
      : "user.reactivate.authorized",
    resourceType: "user",
    resourceId: userId,
    ...auditCtx(c),
  });

  const result = await Promise.resolve()
    .then(async () => {
      const [updated] = rowsFromExecute<{
        user_id: string;
        previous_deactivated_at: Date | null;
        previous_updated_at: Date;
        deactivated_at: Date | null;
      }>(
        await db.execute(sql`
          SELECT * FROM steward_bootstrap.platform_set_user_deactivation(
            ${userId}::uuid,
            ${deactivated}
          )
        `),
      );
      if (!updated) throw new Error("User not found");
      const issuedBefore = await revocationStore.revokeUserTokens(userId);
      return { issuedBefore, updated };
    })
    .catch((err: unknown) => {
      if (err instanceof Error && err.message === "User not found") return null;
      if (
        err instanceof Error &&
        err.message === "Cannot deactivate the sole active tenant owner"
      ) {
        return err.message;
      }
      throw err;
    });
  if (result === null) {
    return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);
  }
  if (result === "Cannot deactivate the sole active tenant owner") {
    return c.json<ApiResponse>({ ok: false, error: result }, 409);
  }
  await writeAuditEvent({
    tenantId: PLATFORM_AUDIT_TENANT_ID,
    actorType: "platform",
    action: deactivated ? "user.deactivate" : "user.reactivate",
    resourceType: "user",
    resourceId: userId,
    metadata: { issuedBefore: result.issuedBefore },
    ...auditCtx(c),
  });
  return c.json<ApiResponse<{ userId: string; deactivatedAt: Date | null }>>({
    ok: true,
    data: { userId, deactivatedAt: result.updated.deactivated_at },
  });
});

/**
 * DELETE /users/:userId
 * Hard-deletes a global user and cascades linked auth rows. Refresh tokens use
 * text user ids, so delete them explicitly before removing the user record.
 */
platform.delete("/users/:userId", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:user:delete");
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const userId = c.req.param("userId");
  if (!isValidUserId(userId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid user id format" },
      400,
    );
  }

  await writeAuditEvent({
    tenantId: PLATFORM_AUDIT_TENANT_ID,
    actorType: "platform",
    action: "user.delete.authorized",
    resourceType: "user",
    resourceId: userId,
    ...auditCtx(c),
  });

  const issuedBefore = await Promise.resolve()
    .then(async () => {
      const [deleted] = rowsFromExecute<{ user_id: string }>(
        await db.execute(sql`
          SELECT * FROM steward_bootstrap.platform_delete_user(${userId}::uuid)
        `),
      );
      if (!deleted) throw new Error("User not found");
      return revocationStore.revokeUserTokens(userId);
    })
    .catch((error: unknown) => {
      if (error instanceof Error && error.message === "User not found")
        return null;
      if (
        error instanceof Error &&
        error.message === "Cannot delete the sole active tenant owner"
      ) {
        return error.message;
      }
      throw error;
    });
  if (issuedBefore === null) {
    return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);
  }
  if (issuedBefore === "Cannot delete the sole active tenant owner") {
    return c.json<ApiResponse>({ ok: false, error: issuedBefore }, 409);
  }

  await writeAuditEvent({
    tenantId: PLATFORM_AUDIT_TENANT_ID,
    actorType: "platform",
    action: "user.delete",
    resourceType: "user",
    resourceId: userId,
    metadata: { issuedBefore },
    ...auditCtx(c),
  });
  return c.json<ApiResponse<{ userId: string; deleted: boolean }>>({
    ok: true,
    data: { userId, deleted: true },
  });
});

/**
 * POST /users/:userId/wallet/external-id
 * Assign an immutable per-tenant external ID to a user's wallet identity.
 * Body: { tenantId: string; walletExternalId: string }
 */
platform.post("/users/:userId/wallet/external-id", async (c) => {
  const scopeResponse = requirePlatformRouteScope(c, "platform:user:write");
  if (scopeResponse) return scopeResponse;

  const userId = c.req.param("userId");
  if (!isValidUserId(userId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid user id format" },
      400,
    );
  }
  const body = await safeJsonParse<{
    tenantId?: unknown;
    walletExternalId?: unknown;
    externalId?: unknown;
  }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  const tenantId =
    typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  const walletExternalId =
    typeof body.walletExternalId === "string"
      ? body.walletExternalId
      : typeof body.externalId === "string"
        ? body.externalId
        : "";
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!isValidWalletExternalId(walletExternalId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid walletExternalId" },
      400,
    );
  }

  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "user.wallet_external_id.link.authorized",
    resourceType: "user",
    resourceId: userId,
    metadata: { hasWalletExternalId: true },
    ...auditCtx(c),
  });
  const linked = await linkWalletExternalIdForUser({
    userId,
    tenantId,
    externalId: walletExternalId,
  });
  if (linked instanceof Error) {
    return c.json<ApiResponse>(
      { ok: false, error: linked.message },
      walletExternalLinkStatus(linked),
    );
  }

  dispatchWebhook(tenantId, userId, "user.updated_account", {
    userId,
    field: "walletExternalId",
  });
  return c.json<ApiResponse<PlatformWalletExternalLink>>(
    { ok: true, data: linked },
    linked.isNew ? 201 : 200,
  );
});

/**
 * POST /users/:userId/accounts
 * Platform-only linked account mutation. Tenant-scoped routes intentionally
 * remain disabled to avoid cross-tenant identity mutation.
 */
platform.post("/users/:userId/accounts", async (c) => {
  if (!platformIdentityMigrationAllowed()) {
    return platformIdentityMigrationDisabledResponse(c);
  }
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:identity-migration",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const userId = c.req.param("userId");
  if (!isValidUserId(userId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid user id format" },
      400,
    );
  }
  const body = await safeJsonParse<{
    provider?: unknown;
    providerAccountId?: unknown;
    tenantId?: unknown;
  }>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  if (
    !isValidAccountProvider(body.provider) ||
    !isValidProviderAccountId(body.providerAccountId)
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "provider and providerAccountId are required" },
      400,
    );
  }
  const provider = body.provider.trim();
  const providerAccountId = body.providerAccountId.trim();
  const tenantId =
    typeof body.tenantId === "string" ? body.tenantId.trim() : undefined;
  if (tenantId !== undefined && !isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId));
  if (!user)
    return c.json<ApiResponse>({ ok: false, error: "User not found" }, 404);

  const [existing] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, provider),
        eq(accounts.providerAccountId, providerAccountId),
      ),
    );
  if (existing) {
    if (existing.userId !== userId) {
      return c.json<ApiResponse>(
        { ok: false, error: "Linked account already belongs to another user" },
        409,
      );
    }
    return c.json<ApiResponse<PlatformLinkedAccountRow & { isNew: boolean }>>({
      ok: true,
      data: {
        id: existing.id,
        provider: existing.provider,
        providerAccountId: existing.providerAccountId,
        expiresAt: existing.expiresAt,
        isNew: false,
      },
    });
  }

  if (isThirdPartyWalletProvider(provider)) {
    const restrictedTenantIds = await restrictedWalletPolicyTenantIds(
      userId,
      tenantId,
    );
    if (tenantId && restrictedTenantIds.length === 0) {
      const requestedTenantIds = await tenantIdsForWalletPolicy(
        userId,
        tenantId,
      );
      if (requestedTenantIds.length === 0) {
        return c.json<ApiResponse>(
          { ok: false, error: "User is not a member of tenant" },
          403,
        );
      }
    }
    if (
      restrictedTenantIds.length > 0 &&
      (await userHasLinkedThirdPartyWallet(userId))
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "User already has a linked wallet",
        },
        409,
      );
    }
  }

  await writeAuditEvent({
    tenantId: tenantId ?? PLATFORM_AUDIT_TENANT_ID,
    actorType: "platform",
    action: "user.account.link",
    resourceType: "user",
    resourceId: userId,
    metadata: { provider, tenantId },
    ...auditCtx(c),
  });
  const [created] = await db
    .insert(accounts)
    .values({ userId, provider, providerAccountId })
    .returning();
  dispatchWebhook(
    tenantId ?? PLATFORM_AUDIT_TENANT_ID,
    userId,
    "user.linked_account",
    {
      userId,
      provider,
    },
  );
  return c.json<ApiResponse<PlatformLinkedAccountRow & { isNew: boolean }>>(
    {
      ok: true,
      data: {
        id: created.id,
        provider: created.provider,
        providerAccountId: created.providerAccountId,
        expiresAt: created.expiresAt,
        isNew: true,
      },
    },
    201,
  );
});

/**
 * DELETE /users/:userId/accounts/:provider/:providerAccountId
 */
platform.delete(
  "/users/:userId/accounts/:provider/:providerAccountId",
  async (c) => {
    if (!platformIdentityMigrationAllowed()) {
      return platformIdentityMigrationDisabledResponse(c);
    }
    const scopeResponse = requirePlatformRouteScope(
      c,
      "platform:identity-migration",
    );
    if (scopeResponse) return scopeResponse;

    const db = getDb();
    const userId = c.req.param("userId");
    const provider = c.req.param("provider");
    const providerAccountId = c.req.param("providerAccountId");
    const force = c.req.query("force") === "true";
    if (force) {
      const forceScopeResponse = requirePlatformRouteScope(
        c,
        "platform:identity-migration:force",
      );
      if (forceScopeResponse) return forceScopeResponse;
    }
    if (!isValidUserId(userId)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid user id format" },
        400,
      );
    }
    if (
      !isValidAccountProvider(provider) ||
      !isValidProviderAccountId(providerAccountId)
    ) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid account identifier" },
        400,
      );
    }

    await writeAuditEvent({
      tenantId: PLATFORM_AUDIT_TENANT_ID,
      actorType: "platform",
      action: "user.account.unlink",
      resourceType: "user",
      resourceId: userId,
      metadata: { provider, forced: force },
      ...auditCtx(c),
    });

    let issuedBefore: number;
    try {
      issuedBefore = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`platform_user_account_${userId}`}, 0))`,
        );
        await lockUserSession(tx, userId);
        const [user] = await tx
          .select()
          .from(users)
          .where(eq(users.id, userId));
        if (!user) throw new Error("User not found");
        const userAccounts = await tx
          .select()
          .from(accounts)
          .where(eq(accounts.userId, userId));
        const account = userAccounts.find(
          (row) =>
            row.provider === provider &&
            row.providerAccountId === providerAccountId,
        );
        if (!account) throw new Error("Linked account not found");
        const hasOtherLogin = Boolean(
          user.email || user.walletAddress || userAccounts.length > 1,
        );
        if (!force && !hasOtherLogin) {
          throw new Error("Cannot unlink the user's last login method");
        }

        const revokedBefore = await revocationStore.revokeUserTokens(userId);
        const [deleted] = await tx
          .delete(accounts)
          .where(
            and(
              eq(accounts.id, account.id),
              eq(accounts.userId, userId),
              eq(accounts.provider, provider),
              eq(accounts.providerAccountId, providerAccountId),
            ),
          )
          .returning({ id: accounts.id });
        if (!deleted) throw new Error("Linked account changed during unlink");
        await tx.execute(
          sql`SELECT steward_bootstrap.platform_revoke_user_refresh_tokens(${userId}::uuid)`,
        );
        return revokedBefore;
      });
    } catch (error) {
      if (error instanceof Error) {
        const status =
          error.message === "User not found"
            ? 404
            : error.message === "Linked account not found"
              ? 404
              : error.message === "Cannot unlink the user's last login method"
                ? 409
                : error.message === "Linked account changed during unlink"
                  ? 409
                  : 500;
        return c.json<ApiResponse>({ ok: false, error: error.message }, status);
      }
      throw error;
    }
    await writeAuditEvent({
      tenantId: PLATFORM_AUDIT_TENANT_ID,
      actorType: "platform",
      action: "user.sessions.revoked_for_account_unlink",
      resourceType: "user",
      resourceId: userId,
      metadata: { issuedBefore },
      ...auditCtx(c),
    });
    dispatchWebhook(PLATFORM_AUDIT_TENANT_ID, userId, "user.unlinked_account", {
      userId,
      provider,
      forced: force,
    });
    return c.json<ApiResponse<{ deleted: boolean }>>({
      ok: true,
      data: { deleted: true },
    });
  },
);

/**
 * POST /users/:userId/accounts/:provider/:providerAccountId/transfer
 * Moves a linked provider account to another global user identity.
 * Body: { toUserId: string; force?: boolean }
 */
platform.post(
  "/users/:userId/accounts/:provider/:providerAccountId/transfer",
  async (c) => {
    if (!platformIdentityMigrationAllowed()) {
      return platformIdentityMigrationDisabledResponse(c);
    }
    const scopeResponse = requirePlatformRouteScope(
      c,
      "platform:identity-migration",
    );
    if (scopeResponse) return scopeResponse;

    const db = getDb();
    const fromUserId = c.req.param("userId");
    const provider = c.req.param("provider");
    const providerAccountId = c.req.param("providerAccountId");
    if (!isValidUserId(fromUserId)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid source user id format" },
        400,
      );
    }
    if (
      !isValidAccountProvider(provider) ||
      !isValidProviderAccountId(providerAccountId)
    ) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid account identifier" },
        400,
      );
    }

    const body = await safeJsonParse<{ toUserId?: unknown; force?: boolean }>(
      c,
    );
    if (!body)
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid JSON in request body" },
        400,
      );
    if (!isValidUserId(body.toUserId)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid target user id format" },
        400,
      );
    }
    const toUserId = body.toUserId;
    if (toUserId === fromUserId) {
      return c.json<ApiResponse>(
        { ok: false, error: "Target user must be different" },
        400,
      );
    }
    if (body.force === true) {
      const forceScopeResponse = requirePlatformRouteScope(
        c,
        "platform:identity-migration:force",
      );
      if (forceScopeResponse) return forceScopeResponse;
    }

    const [fromUser, toUser] = await Promise.all([
      db
        .select()
        .from(users)
        .where(eq(users.id, fromUserId))
        .then((rows) => rows[0]),
      db
        .select()
        .from(users)
        .where(eq(users.id, toUserId))
        .then((rows) => rows[0]),
    ]);
    if (!fromUser)
      return c.json<ApiResponse>(
        { ok: false, error: "Source user not found" },
        404,
      );
    if (!toUser)
      return c.json<ApiResponse>(
        { ok: false, error: "Target user not found" },
        404,
      );

    await writeAuditEvent({
      tenantId: PLATFORM_AUDIT_TENANT_ID,
      actorType: "platform",
      action: "user.account.transfer.authorized",
      resourceType: "user",
      resourceId: fromUserId,
      metadata: {
        provider,
        providerAccountId,
        toUserId,
        forced: body.force === true,
      },
      ...auditCtx(c),
    });

    let fromIssuedBefore: number;
    let toIssuedBefore: number;
    let updated: PlatformLinkedAccountRow;
    try {
      const revocation = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`platform_user_account_${fromUserId}`}, 0))`,
        );
        await lockUserSessions(tx, [fromUserId, toUserId]);
        const [lockedFromUser] = await tx
          .select()
          .from(users)
          .where(eq(users.id, fromUserId));
        if (!lockedFromUser) throw new Error("Source user not found");
        const fromAccounts = await tx
          .select()
          .from(accounts)
          .where(eq(accounts.userId, fromUserId));
        const account = fromAccounts.find(
          (row) =>
            row.provider === provider &&
            row.providerAccountId === providerAccountId,
        );
        if (!account) throw new Error("Linked account not found");
        const hasOtherLogin = Boolean(
          lockedFromUser.email ||
            lockedFromUser.walletAddress ||
            fromAccounts.length > 1,
        );
        if (!body.force && !hasOtherLogin) {
          throw new Error(
            "Cannot transfer the source user's last login method",
          );
        }

        const fromRevokedBefore =
          await revocationStore.revokeUserTokens(fromUserId);
        const toRevokedBefore =
          await revocationStore.revokeUserTokens(toUserId);
        const [updated] = await tx
          .update(accounts)
          .set({ userId: toUserId })
          .where(
            and(
              eq(accounts.id, account.id),
              eq(accounts.userId, fromUserId),
              eq(accounts.provider, provider),
              eq(accounts.providerAccountId, providerAccountId),
            ),
          )
          .returning();
        if (!updated) throw new Error("Linked account changed during transfer");
        await tx.execute(
          sql`SELECT steward_bootstrap.platform_revoke_user_refresh_tokens(${fromUserId}::uuid)`,
        );
        await tx.execute(
          sql`SELECT steward_bootstrap.platform_revoke_user_refresh_tokens(${toUserId}::uuid)`,
        );
        return {
          fromIssuedBefore: fromRevokedBefore,
          toIssuedBefore: toRevokedBefore,
          updated,
        };
      });
      fromIssuedBefore = revocation.fromIssuedBefore;
      toIssuedBefore = revocation.toIssuedBefore;
      updated = revocation.updated;
    } catch (error) {
      if (error instanceof Error) {
        const status =
          error.message === "Source user not found" ||
          error.message === "Linked account not found"
            ? 404
            : error.message ===
                  "Cannot transfer the source user's last login method" ||
                error.message === "Linked account changed during transfer"
              ? 409
              : 500;
        return c.json<ApiResponse>({ ok: false, error: error.message }, status);
      }
      throw error;
    }

    try {
      await writeAuditEvent({
        tenantId: PLATFORM_AUDIT_TENANT_ID,
        actorType: "platform",
        action: "user.account.transfer",
        resourceType: "user",
        resourceId: fromUserId,
        metadata: {
          provider,
          providerAccountId,
          toUserId,
          forced: body.force === true,
          revokedSessions: {
            fromUserId: fromIssuedBefore,
            toUserId: toIssuedBefore,
          },
        },
        ...auditCtx(c),
      });
    } catch (error) {
      await db
        .update(accounts)
        .set({ userId: fromUserId })
        .where(
          and(
            eq(accounts.id, updated.id),
            eq(accounts.userId, toUserId),
            eq(accounts.provider, provider),
            eq(accounts.providerAccountId, providerAccountId),
          ),
        );
      throw error;
    }
    dispatchWebhook(
      PLATFORM_AUDIT_TENANT_ID,
      fromUserId,
      "user.transferred_account",
      {
        fromUserId,
        toUserId,
        provider,
        forced: body.force === true,
      },
    );

    return c.json<
      ApiResponse<
        PlatformLinkedAccountRow & {
          fromUserId: string;
          toUserId: string;
        }
      >
    >({
      ok: true,
      data: {
        id: updated.id,
        provider: updated.provider,
        providerAccountId: updated.providerAccountId,
        expiresAt: updated.expiresAt,
        fromUserId,
        toUserId,
      },
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Tenant-scoped user identity graph
// ─────────────────────────────────────────────────────────────────────────────

type TenantUserRow = {
  userId: string;
  tenantId: string;
  role: string;
  joinedAt: Date;
  email: string | null;
  emailVerified: boolean | null;
  name: string | null;
  tenantCustomMetadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

function tenantUserSelection() {
  return {
    userId: users.id,
    tenantId: userTenants.tenantId,
    role: userTenants.role,
    joinedAt: userTenants.createdAt,
    email: users.email,
    emailVerified: users.emailVerified,
    name: users.name,
    tenantCustomMetadata: userTenants.customMetadata,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  };
}

async function getTenantUser(
  tenantId: string,
  userId: string,
): Promise<TenantUserRow | null> {
  const db = getDb();
  const [user] = await db
    .select(tenantUserSelection())
    .from(userTenants)
    .innerJoin(users, eq(userTenants.userId, users.id))
    .where(
      and(eq(userTenants.tenantId, tenantId), eq(userTenants.userId, userId)),
    );

  return user ?? null;
}

/**
 * GET /tenants/:id/users
 * Tenant-scoped user lookup/search. Supports q, email, walletExternalId, limit, offset.
 */
platform.get("/tenants/:id/users", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-user:read",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  if (!(await getTenantOr404(tenantId))) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const limit = clampLimit(c.req.query("limit") ?? null);
  const offset = parseOffset(c.req.query("offset") ?? null);
  const email = c.req.query("email")?.trim().toLowerCase();
  const walletExternalId = c.req.query("walletExternalId")?.trim();
  const q = c.req.query("q")?.trim();

  if (walletExternalId) {
    if (!isValidWalletExternalId(walletExternalId)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Invalid walletExternalId" },
        400,
      );
    }
    const identity = await lookupPlatformUserIdentity({
      tenantId,
      walletExternalId,
    });
    if (!identity) {
      return c.json<
        ApiResponse<{ users: TenantUserRow[]; limit: number; offset: number }>
      >({
        ok: true,
        data: { users: [], limit, offset },
      });
    }
    const user = await getTenantUser(tenantId, identity.userId);
    return c.json<
      ApiResponse<{ users: TenantUserRow[]; limit: number; offset: number }>
    >({
      ok: true,
      data: { users: user ? [user] : [], limit, offset },
    });
  }

  const filters: SQL[] = [eq(userTenants.tenantId, tenantId)];
  if (email) {
    filters.push(eq(users.email, email));
  }
  if (q) {
    const pattern = `%${q}%`;
    const qFilter = or(ilike(users.email, pattern), ilike(users.name, pattern));
    if (qFilter) filters.push(qFilter);
  }

  const rows = await db
    .select(tenantUserSelection())
    .from(userTenants)
    .innerJoin(users, eq(userTenants.userId, users.id))
    .where(and(...filters))
    .limit(limit)
    .offset(offset);

  return c.json<
    ApiResponse<{ users: TenantUserRow[]; limit: number; offset: number }>
  >({
    ok: true,
    data: { users: rows, limit, offset },
  });
});

/**
 * GET /tenants/:id/users/:userId
 * Return a tenant-scoped user profile. This intentionally omits global wallet,
 * account-link, and custom metadata fields because users can belong to multiple
 * tenants.
 */
platform.get("/tenants/:id/users/:userId", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-user:read",
  );
  if (scopeResponse) return scopeResponse;

  const tenantId = c.req.param("id");
  const userId = c.req.param("userId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!isValidUserId(userId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid user id format" },
      400,
    );
  }

  const user = await getTenantUser(tenantId, userId);
  if (!user) {
    return c.json<ApiResponse>(
      { ok: false, error: "User not found in tenant" },
      404,
    );
  }

  return c.json<ApiResponse<TenantUserRow>>({
    ok: true,
    data: user,
  });
});

/**
 * PATCH /tenants/:id/users/:userId/metadata
 * Replace tenant-scoped user metadata.
 * Body: { tenantCustomMetadata: object }
 */
platform.patch("/tenants/:id/users/:userId/metadata", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-user:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");
  const userId = c.req.param("userId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!isValidUserId(userId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid user id format" },
      400,
    );
  }

  const body = await safeJsonParse<{
    tenantCustomMetadata?: Record<string, unknown>;
  }>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  if (body.tenantCustomMetadata === undefined) {
    return c.json<ApiResponse>(
      { ok: false, error: "tenantCustomMetadata is required" },
      400,
    );
  }
  const metadataError = getPlatformMetadataValidationError(
    body.tenantCustomMetadata,
    "tenantCustomMetadata",
  );
  if (metadataError)
    return c.json<ApiResponse>({ ok: false, error: metadataError }, 400);

  if (!(await getTenantUser(tenantId, userId))) {
    return c.json<ApiResponse>(
      { ok: false, error: "User not found in tenant" },
      404,
    );
  }

  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "tenant.user.metadata.update",
    resourceType: "user",
    resourceId: userId,
    metadata: {
      updatedTenant: true,
    },
    ...auditCtx(c),
  });

  await db
    .update(userTenants)
    .set({ customMetadata: body.tenantCustomMetadata })
    .where(
      and(eq(userTenants.tenantId, tenantId), eq(userTenants.userId, userId)),
    );
  dispatchWebhook(tenantId, userId, "user.updated_account", {
    userId,
    scope: "tenant",
    field: "tenantCustomMetadata",
  });

  const user = await getTenantUser(tenantId, userId);
  return c.json<ApiResponse<TenantUserRow>>({
    ok: true,
    data: user as TenantUserRow,
  });
});

/**
 * POST /tenants/:id/users/:userId/accounts
 * Linking external provider accounts mutates global identity state and must use
 * a global identity endpoint, not a tenant-scoped path.
 */
platform.post("/tenants/:id/users/:userId/accounts", async (c) => {
  return c.json<ApiResponse>(
    { ok: false, error: "Tenant-scoped account linking is disabled" },
    410,
  );
});

/**
 * DELETE /tenants/:id/users/:userId/accounts/:provider/:providerAccountId
 * Disabled for the same reason as the tenant-scoped account link route.
 */
platform.delete(
  "/tenants/:id/users/:userId/accounts/:provider/:providerAccountId",
  async (c) => {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant-scoped account unlinking is disabled" },
      410,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Tenant member management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /tenants/:id/members
 * List all members of a tenant.
 */
platform.get("/tenants/:id/members", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-member:read",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");
  const limit = parseListLimit(c.req.query("limit"));
  const offset = parseListOffset(c.req.query("offset"));

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  // Verify tenant exists
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const members = await db
    .select({
      userId: userTenants.userId,
      role: userTenants.role,
      joinedAt: userTenants.createdAt,
      email: users.email,
      name: users.name,
    })
    .from(userTenants)
    .innerJoin(users, eq(userTenants.userId, users.id))
    .where(eq(userTenants.tenantId, tenantId))
    .limit(limit)
    .offset(offset);

  return c.json<ApiResponse<typeof members>>({ ok: true, data: members });
});

/**
 * GET /tenants/:id/invitations
 * List pending/accepted/revoked invitations for a tenant.
 */
platform.get("/tenants/:id/invitations", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-member:read",
  );
  if (scopeResponse) return scopeResponse;

  const tenantId = c.req.param("id");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  const status = c.req.query("status")?.trim().toLowerCase() || "pending";
  if (!["pending", "accepted", "revoked", "expired", "all"].includes(status)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid invitation status" },
      400,
    );
  }

  const filters = [eq(tenantInvitations.tenantId, tenantId)];
  if (status !== "all") filters.push(eq(tenantInvitations.status, status));
  const rows = await getDb()
    .select({
      id: tenantInvitations.id,
      tenantId: tenantInvitations.tenantId,
      email: tenantInvitations.email,
      role: tenantInvitations.role,
      status: tenantInvitations.status,
      invitedByUserId: tenantInvitations.invitedByUserId,
      acceptedByUserId: tenantInvitations.acceptedByUserId,
      acceptedAt: tenantInvitations.acceptedAt,
      revokedAt: tenantInvitations.revokedAt,
      expiresAt: tenantInvitations.expiresAt,
      createdAt: tenantInvitations.createdAt,
      updatedAt: tenantInvitations.updatedAt,
    })
    .from(tenantInvitations)
    .where(and(...filters))
    .limit(parseListLimit(c.req.query("limit"), 100))
    .offset(parseListOffset(c.req.query("offset")));

  return c.json<ApiResponse<{ invitations: typeof rows }>>({
    ok: true,
    data: { invitations: rows },
  });
});

/**
 * POST /tenants/:id/invitations
 * Create a single-use invitation token. Tokens are returned once and stored
 * hashed, so callers must deliver the token through their own email channel.
 */
platform.post("/tenants/:id/invitations", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-member:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  const body = await safeJsonParse<{
    email: string;
    role?: string;
    expiresInSeconds?: number;
    invitedByUserId?: string;
    sendEmail?: boolean;
  }>(c);
  if (!body || !isNonEmptyString(body.email)) {
    return c.json<ApiResponse>({ ok: false, error: "email is required" }, 400);
  }

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const email = body.email.toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json<ApiResponse>(
      { ok: false, error: "valid email is required" },
      400,
    );
  }
  let role: ReturnType<typeof normalizeTenantInvitationRole>;
  try {
    role = normalizeTenantInvitationRole(body.role);
  } catch (err) {
    return c.json<ApiResponse>(
      { ok: false, error: err instanceof Error ? err.message : "Invalid role" },
      400,
    );
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashSha256Hex(token);
  const expiresAt = normalizeInvitationExpiry(body.expiresInSeconds);
  let invitedByUserId: string | null = null;
  if (body.invitedByUserId !== undefined) {
    if (!isValidUserId(body.invitedByUserId)) {
      return c.json<ApiResponse>(
        { ok: false, error: "invitedByUserId must be a valid user id" },
        400,
      );
    }
    const [inviterMembership] = await db
      .select({ userId: userTenants.userId })
      .from(userTenants)
      .where(
        and(
          eq(userTenants.tenantId, tenantId),
          eq(userTenants.userId, body.invitedByUserId),
        ),
      )
      .limit(1);
    if (!inviterMembership) {
      return c.json<ApiResponse>(
        { ok: false, error: "invitedByUserId must belong to the tenant" },
        400,
      );
    }
    invitedByUserId = body.invitedByUserId;
  }

  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "tenant.invitation.create.authorized",
    resourceType: "tenant_invitation",
    resourceId: email,
    metadata: { email, role, expiresAt: expiresAt.toISOString() },
    ...auditCtx(c),
  });

  const previousPendingInvitations = await db
    .select()
    .from(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.tenantId, tenantId),
        eq(tenantInvitations.email, email),
        eq(tenantInvitations.status, "pending"),
      ),
    );

  const invitation = await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(tenantInvitations)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          eq(tenantInvitations.email, email),
          eq(tenantInvitations.status, "pending"),
        ),
      );

    const [created] = await tx
      .insert(tenantInvitations)
      .values({ tenantId, email, role, tokenHash, invitedByUserId, expiresAt })
      .returning({
        id: tenantInvitations.id,
        tenantId: tenantInvitations.tenantId,
        email: tenantInvitations.email,
        role: tenantInvitations.role,
        status: tenantInvitations.status,
        expiresAt: tenantInvitations.expiresAt,
        createdAt: tenantInvitations.createdAt,
      });
    return created;
  });

  try {
    await writeAuditEvent({
      tenantId,
      actorType: "platform",
      action: "tenant.invitation.create",
      resourceType: "tenant_invitation",
      resourceId: invitation.id,
      metadata: { email, role, expiresAt: expiresAt.toISOString() },
      ...auditCtx(c),
    });
  } catch (error) {
    await db.transaction(async (tx) => {
      await tx
        .delete(tenantInvitations)
        .where(eq(tenantInvitations.id, invitation.id));
      for (const previous of previousPendingInvitations) {
        await tx
          .update(tenantInvitations)
          .set({
            status: previous.status,
            revokedAt: previous.revokedAt,
            updatedAt: previous.updatedAt,
          })
          .where(eq(tenantInvitations.id, previous.id));
      }
    });
    throw error;
  }

  let emailSent = false;
  if (body.sendEmail === true) {
    try {
      const emailAuth = await getEmailAuthForTenant(tenantId);
      await emailAuth.sendTenantInvitation(email, {
        tenantId,
        token,
        expiresAt,
      });
      emailSent = true;
    } catch (error) {
      logger.error(
        {
          details: [
            "[TenantInvitation] Email delivery failed",
            redactedThrownDiagnostics(error),
          ],
        },
        "[Login:platform] error",
      );
    }
  }

  setNoStoreHeaders(c);
  return c.json<
    ApiResponse<{
      invitation: typeof invitation;
      token: string;
      emailSent: boolean;
    }>
  >({ ok: true, data: { invitation, token, emailSent } }, 201);
});

/**
 * DELETE /tenants/:id/invitations/:invitationId
 * Revoke a pending invitation.
 */
platform.delete("/tenants/:id/invitations/:invitationId", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-member:write",
  );
  if (scopeResponse) return scopeResponse;

  const tenantId = c.req.param("id");
  const invitationId = c.req.param("invitationId");
  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!isValidUserId(invitationId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid invitation id format" },
      400,
    );
  }

  const db = getDb();
  const [candidate] = await db
    .select()
    .from(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.tenantId, tenantId),
        eq(tenantInvitations.id, invitationId),
        eq(tenantInvitations.status, "pending"),
      ),
    )
    .limit(1);
  if (!candidate) {
    return c.json<ApiResponse>(
      { ok: false, error: "Pending invitation not found" },
      404,
    );
  }

  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "tenant.invitation.revoke.authorized",
    resourceType: "tenant_invitation",
    resourceId: candidate.id,
    metadata: { email: candidate.email, role: candidate.role },
    ...auditCtx(c),
  });

  const [invitation] = await db
    .update(tenantInvitations)
    .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(tenantInvitations.tenantId, tenantId),
        eq(tenantInvitations.id, invitationId),
        eq(tenantInvitations.status, "pending"),
      ),
    )
    .returning({
      id: tenantInvitations.id,
      email: tenantInvitations.email,
      role: tenantInvitations.role,
    });
  if (!invitation) {
    return c.json<ApiResponse>(
      { ok: false, error: "Pending invitation not found" },
      404,
    );
  }

  try {
    await writeAuditEvent({
      tenantId,
      actorType: "platform",
      action: "tenant.invitation.revoke",
      resourceType: "tenant_invitation",
      resourceId: invitation.id,
      metadata: { email: invitation.email, role: invitation.role },
      ...auditCtx(c),
    });
  } catch (error) {
    await db
      .update(tenantInvitations)
      .set({
        status: candidate.status,
        revokedAt: candidate.revokedAt,
        updatedAt: candidate.updatedAt,
      })
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          eq(tenantInvitations.id, invitationId),
        ),
      );
    throw error;
  }

  return c.json<ApiResponse>({ ok: true });
});

/**
 * POST /tenants/:id/members
 * Invite a user by email to a tenant. Creates the user if they don't exist.
 * Body: { email: string; role?: string }
 */
platform.post("/tenants/:id/members", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-member:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }

  const body = await safeJsonParse<{ email: string; role?: string }>(c);
  if (!body || !isNonEmptyString(body.email)) {
    return c.json<ApiResponse>({ ok: false, error: "email is required" }, 400);
  }

  // Verify tenant exists
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  if (!tenant) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant not found" }, 404);
  }

  const email = body.email.toLowerCase().trim();
  let role: "owner" | "admin" | "member";
  try {
    role = normalizeTenantMemberRole(body.role);
  } catch (err) {
    return c.json<ApiResponse>(
      { ok: false, error: err instanceof Error ? err.message : "Invalid role" },
      400,
    );
  }

  // Find user now; create after audit if needed so audit failure cannot create identity state.
  let [user] = await db.select().from(users).where(eq(users.email, email));
  const [existingMembership] = user
    ? await db
        .select({ role: userTenants.role })
        .from(userTenants)
        .where(
          and(
            eq(userTenants.userId, user.id),
            eq(userTenants.tenantId, tenantId),
          ),
        )
    : [undefined];
  const actualRole = existingMembership?.role ?? role;

  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "tenant.member.add",
    resourceType: "user",
    resourceId: user?.id ?? email,
    metadata: {
      email,
      role: actualRole,
      requestedRole: role,
      isNew: !existingMembership,
    },
    ...auditCtx(c),
  });

  const createdUser = !user;
  if (!user) {
    const [newUser] = await db
      .insert(users)
      .values({ email, emailVerified: false })
      .returning();
    user = newUser;
  }

  if (!existingMembership) {
    await db
      .insert(userTenants)
      .values({ userId: user.id, tenantId, role })
      .onConflictDoNothing();
  }
  if (createdUser) {
    dispatchWebhook(tenantId, user.id, "user.created", {
      userId: user.id,
      source: "platform.tenant_member",
      hasEmail: true,
    });
  }

  return c.json<
    ApiResponse<{
      userId: string;
      email: string;
      tenantId: string;
      role: string;
    }>
  >(
    { ok: true, data: { userId: user.id, email, tenantId, role: actualRole } },
    201,
  );
});

/**
 * DELETE /tenants/:id/members/:userId
 * Remove a member from a tenant.
 */
platform.delete("/tenants/:id/members/:userId", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-member:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");
  const userId = c.req.param("userId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!isValidUserId(userId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid user id format" },
      400,
    );
  }

  let currentMember: { role: string } | undefined;
  try {
    currentMember = await db.transaction(async (tx) => {
      await lockTenantOwnerLifecycle(tx, tenantId);
      const [current] = await tx
        .select({ role: userTenants.role })
        .from(userTenants)
        .where(
          and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.userId, userId),
          ),
        );
      if (!current) return undefined;
      if (current.role === "owner") {
        if ((await activeTenantOwnerCount(tx, tenantId, userId)) < 1) {
          throw new Error("Cannot remove the sole tenant owner");
        }
      }
      return current;
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "Cannot remove the sole tenant owner"
    ) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 409);
    }
    throw err;
  }

  if (!currentMember) {
    return c.json<ApiResponse>(
      { ok: false, error: "Member not found in tenant" },
      404,
    );
  }

  const revokedBefore = await revocationStore.revokeUserTokens(userId);

  await writeAuditEvent({
    tenantId,
    actorType: "platform",
    action: "tenant.member.remove",
    resourceType: "user",
    resourceId: userId,
    metadata: { revokedUserTokensIssuedBefore: revokedBefore },
    ...auditCtx(c),
  });

  let deleted: typeof userTenants.$inferSelect | undefined;
  try {
    deleted = await db.transaction(async (tx) => {
      await lockTenantOwnerLifecycle(tx, tenantId);
      const [current] = await tx
        .select({ role: userTenants.role })
        .from(userTenants)
        .where(
          and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.userId, userId),
          ),
        );
      if (!current) return undefined;
      if (current.role === "owner") {
        if ((await activeTenantOwnerCount(tx, tenantId, userId)) < 1) {
          throw new Error("Cannot remove the sole tenant owner");
        }
      }
      const [row] = await tx
        .delete(userTenants)
        .where(
          and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.userId, userId),
          ),
        )
        .returning();
      return row;
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "Cannot remove the sole tenant owner"
    ) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 409);
    }
    throw err;
  }
  if (!deleted) {
    return c.json<ApiResponse>(
      { ok: false, error: "Member not found in tenant" },
      404,
    );
  }

  await db
    .delete(refreshTokens)
    .where(
      and(
        eq(refreshTokens.tenantId, tenantId),
        eq(refreshTokens.userId, userId),
      ),
    );

  return c.json<ApiResponse>({ ok: true });
});

/**
 * PATCH /tenants/:id/members/:userId
 * Update a member's role in a tenant.
 * Body: { role: string }
 */
platform.patch("/tenants/:id/members/:userId", async (c) => {
  const scopeResponse = requirePlatformRouteScope(
    c,
    "platform:tenant-member:write",
  );
  if (scopeResponse) return scopeResponse;

  const db = getDb();
  const tenantId = c.req.param("id");
  const userId = c.req.param("userId");

  if (!isValidTenantId(tenantId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid tenant id format" },
      400,
    );
  }
  if (!isValidUserId(userId)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid user id format" },
      400,
    );
  }

  const body = await safeJsonParse<{ role: string }>(c);
  if (!body || !isNonEmptyString(body.role)) {
    return c.json<ApiResponse>({ ok: false, error: "role is required" }, 400);
  }

  let role: "owner" | "admin" | "member";
  try {
    role = normalizeTenantMemberRole(body.role);
  } catch (err) {
    return c.json<ApiResponse>(
      { ok: false, error: err instanceof Error ? err.message : "Invalid role" },
      400,
    );
  }

  let currentMember: { role: string } | undefined;
  try {
    currentMember = await db.transaction(async (tx) => {
      await lockTenantOwnerLifecycle(tx, tenantId);
      const [current] = await tx
        .select({ role: userTenants.role })
        .from(userTenants)
        .where(
          and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.userId, userId),
          ),
        );
      if (!current) return undefined;
      if (current.role === "owner" && role !== "owner") {
        if ((await activeTenantOwnerCount(tx, tenantId, userId)) < 1) {
          throw new Error("Cannot downgrade the sole tenant owner");
        }
      }
      return current;
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "Cannot downgrade the sole tenant owner"
    ) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 409);
    }
    throw err;
  }

  if (!currentMember) {
    return c.json<ApiResponse>(
      { ok: false, error: "Member not found in tenant" },
      404,
    );
  }

  let updated:
    | {
        row: typeof userTenants.$inferSelect;
        previousRole: string;
        revokedUserTokensIssuedBefore: number | null;
      }
    | undefined;
  try {
    updated = await db.transaction(async (tx) => {
      await lockTenantOwnerLifecycle(tx, tenantId);
      const [current] = await tx
        .select({ role: userTenants.role })
        .from(userTenants)
        .where(
          and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.userId, userId),
          ),
        );
      if (!current) return undefined;
      if (current.role === "owner" && role !== "owner") {
        if ((await activeTenantOwnerCount(tx, tenantId, userId)) < 1) {
          throw new Error("Cannot downgrade the sole tenant owner");
        }
      }
      const revokedUserTokensIssuedBefore =
        current.role === role ? null : Math.floor(Date.now() / 1000) + 1;
      if (revokedUserTokensIssuedBefore !== null) {
        await revocationStore.revokeUserTokens(
          userId,
          revokedUserTokensIssuedBefore,
        );
        await tx
          .delete(refreshTokens)
          .where(
            and(
              eq(refreshTokens.tenantId, tenantId),
              eq(refreshTokens.userId, userId),
            ),
          );
      }
      const [row] = await tx
        .update(userTenants)
        .set({ role })
        .where(
          and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.userId, userId),
          ),
        )
        .returning();
      return row
        ? {
            row,
            previousRole: current.role,
            revokedUserTokensIssuedBefore,
          }
        : undefined;
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "Cannot downgrade the sole tenant owner"
    ) {
      return c.json<ApiResponse>({ ok: false, error: err.message }, 409);
    }
    throw err;
  }
  if (!updated) {
    return c.json<ApiResponse>(
      { ok: false, error: "Member not found in tenant" },
      404,
    );
  }

  try {
    await writeAuditEvent({
      tenantId,
      actorType: "platform",
      action: "tenant.member.role.update",
      resourceType: "user",
      resourceId: userId,
      metadata: {
        previousRole: updated.previousRole,
        role,
        revokedUserTokensIssuedBefore: updated.revokedUserTokensIssuedBefore,
      },
      ...auditCtx(c),
    });
  } catch (error) {
    await db
      .update(userTenants)
      .set({ role: updated.previousRole })
      .where(
        and(eq(userTenants.tenantId, tenantId), eq(userTenants.userId, userId)),
      );
    throw error;
  }

  return c.json<
    ApiResponse<{ userId: string; tenantId: string; role: string }>
  >({
    ok: true,
    data: { userId, tenantId, role },
  });
});

export { platform as platformRoutes };
