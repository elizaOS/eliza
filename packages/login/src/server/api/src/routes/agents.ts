/**
 * Agent CRUD, batch creation, token generation, and policy management routes.
 *
 * Mount: app.route("/agents", agentRoutes)
 */

import { logger } from "@elizaos/logger";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import {
  getAgentTokenExpiry,
  hashSha256Hex,
  importP256PublicKey,
  revocationStore,
} from "../../../auth/src/index.ts";
import { agentPolicies, toPersistedPolicyRule } from "../../../db/src/index.ts";
import {
  getSpend,
  getSpendByHost,
  invalidateCache,
  type SpendPeriod,
} from "../../../redis/src/index.ts";
import { redactedThrownDiagnostics } from "../../../shared/src/index.ts";
import { isRedisAvailable } from "../middleware/redis";
import { deleteAgentAuthority } from "../services/agent-deletion";
import {
  type AuditEventInput,
  withTenantAuditedTransaction,
  writeAuditEvent,
} from "../services/audit";
import {
  type AgentIdentity,
  type ApiResponse,
  type AppVariables,
  agentKeyQuorums,
  agentSigners,
  agents,
  agentWallets,
  approvalQueue,
  createAgentTokenForExistingAgent,
  db,
  encryptedChainKeys,
  encryptedKeys,
  ensureAgentForTenant,
  getConditionSetReferenceValidationError,
  getTransactionStats,
  isNonEmptyString,
  isValidAgentId,
  type PolicyRule,
  parseAgentTokenScopes,
  policies,
  priceOracle,
  requireAgentAccess,
  requireTenantLevel,
  safeJsonParse,
  sanitizeErrorMessage,
  setNoStoreHeaders,
  toPolicyRule,
  transactions,
  vault,
  vaultSigningFreezes,
} from "../services/context";
import {
  publicGasSponsorshipState,
  readTenantGasSponsorshipConfig,
} from "../services/gas-sponsorship";
import { getPolicyRulesValidationError } from "../services/policy-validation";
import { isRecentMfaTimestamp } from "../services/recent-mfa";
import { createSignerCredentialHash } from "../services/signer-credentials";
import { redactWalletMetadataSecrets } from "../services/wallet-metadata";
import { dispatchWebhook } from "../services/webhook-dispatch";

export const agentRoutes = new Hono<{ Variables: AppVariables }>();

agentRoutes.use("*", async (c, next) => {
  setNoStoreHeaders(c);
  await next();
});

const MAX_BATCH_AGENTS = 25;
const MAX_POLICIES_PER_AGENT = 100;
const MAX_AGENT_LIST_LIMIT = 200;
const MAX_AGENT_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const MAX_CUSTOM_TOKEN_BALANCES = 25;
const MAX_AGENT_SIGNER_PERMISSIONS = 32;
const MAX_AGENT_SIGNER_METADATA_BYTES = 8_192;
const MAX_AGENT_KEY_QUORUM_MEMBERS = 32;
const SPEND_PERIODS = [
  "day",
  "week",
  "month",
] as const satisfies readonly SpendPeriod[];
const AGENT_SIGNER_TYPES = new Set([
  "owner",
  "delegated",
  "service",
  "quorum_member",
]);
const AGENT_SIGNER_SUBJECT_TYPES = new Set([
  "user",
  "wallet",
  "api_key",
  "external",
]);
const AGENT_SIGNER_STATUSES = new Set(["active", "paused", "revoked"]);
const AGENT_KEY_QUORUM_STATUSES = new Set(["active", "paused", "revoked"]);
const AGENT_SIGNER_KEY_TYPES = new Set(["hmac", "p256"]);
const PREGENERATED_USER_WALLET_TYPE = "pregenerated_user";
const PREGENERATED_CLAIM_PREFIX = "pregenerated:";
const CLAIMED_PREGENERATED_CLAIM_PREFIX = "claimed:";
const EXPIRED_PREGENERATED_CLAIM_PREFIX = "expired:";
const DEFAULT_PREGENERATED_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PREGENERATED_CLAIM_TTL_MS = 5 * 60 * 1000;
const MAX_PREGENERATED_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESERVED_SIGNER_METADATA_KEYS = new Set([
  "credentialHash",
  "credentialCreatedAt",
  "credentialLastUsedAt",
]);
const ACCOUNT_CAPABILITIES = [
  "sign_transaction",
  "sign_message",
  "sign_typed_data",
  "sign_user_operation",
  "sign_authorization",
  "send_calls",
  "transfer",
  "solana_transaction",
] as const;

type PortfolioAsset = {
  token: string;
  symbol: string;
  balance: string;
  formatted: string;
  decimals: number;
  usdPrice: number | null;
  usdValue: number | null;
  usdPriceText: string | null;
  usdValueText: string | null;
};
type AgentSignerRow = typeof agentSigners.$inferSelect;
type AgentKeyQuorumRow = typeof agentKeyQuorums.$inferSelect;
type PolicyRow = typeof policies.$inferSelect;
type AgentWalletChainFamily = "evm" | "solana" | "bitcoin" | "monero";
type BitcoinNetwork = "mainnet" | "testnet";
type BitcoinAddressType = "p2wpkh" | "p2tr";
type MoneroNetwork = "mainnet" | "stagenet";

const USD_SCALE_DECIMALS = 18;

function parseDecimalToScaled(
  value: string,
  scaleDecimals = USD_SCALE_DECIMALS,
): bigint | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const scaledFraction = fraction
    .slice(0, scaleDecimals)
    .padEnd(scaleDecimals, "0");
  return (
    BigInt(whole) * 10n ** BigInt(scaleDecimals) + BigInt(scaledFraction || "0")
  );
}

function formatScaledDecimal(
  value: bigint,
  scaleDecimals = USD_SCALE_DECIMALS,
): string {
  const whole = value / 10n ** BigInt(scaleDecimals);
  const fraction = value % 10n ** BigInt(scaleDecimals);
  const trimmedFraction = fraction
    .toString()
    .padStart(scaleDecimals, "0")
    .replace(/0+$/, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole.toString();
}

function priceToScaledText(price: number | null): string | null {
  if (price === null || !Number.isFinite(price) || price < 0) return null;
  const scaled = parseDecimalToScaled(price.toFixed(USD_SCALE_DECIMALS));
  return scaled === null ? null : formatScaledDecimal(scaled);
}

function tokenAmountUsdText(
  balance: string,
  decimals: number,
  price: number | null,
): string | null {
  if (price === null || !Number.isFinite(price) || price < 0) return null;
  if (!/^\d+$/.test(balance) || !Number.isSafeInteger(decimals) || decimals < 0)
    return null;
  const scaledPrice = parseDecimalToScaled(price.toFixed(USD_SCALE_DECIMALS));
  if (scaledPrice === null) return null;
  const usdScaled = (BigInt(balance) * scaledPrice) / 10n ** BigInt(decimals);
  return formatScaledDecimal(usdScaled);
}

function sumUsdText(values: Array<string | null>): string | null {
  let total = 0n;
  let hasValue = false;
  for (const value of values) {
    if (value === null) continue;
    const scaled = parseDecimalToScaled(value);
    if (scaled === null) continue;
    total += scaled;
    hasValue = true;
  }
  return hasValue ? formatScaledDecimal(total) : null;
}

function sumNullableUsd(values: Array<number | null>): number | null {
  let total = 0;
  let hasValue = false;
  for (const value of values) {
    if (value === null) continue;
    total += value;
    hasValue = true;
  }
  return hasValue ? total : null;
}

function agentWalletRowsToAccountWallets(
  agent: AgentIdentity,
  rows: Array<{
    id: string;
    chainFamily: AgentWalletChainFamily;
    address: string;
    venue: string | null;
    purpose: string | null;
    metadata: Record<string, unknown>;
    createdAt: Date;
  }>,
) {
  if (rows.length > 0) {
    return rows.map((wallet) => ({
      id: wallet.id,
      chainFamily: wallet.chainFamily,
      address: wallet.address,
      venue: wallet.venue,
      purpose: wallet.purpose,
      metadata: redactWalletMetadataSecrets(wallet.metadata),
      createdAt: wallet.createdAt,
    }));
  }

  return [
    {
      id: `${agent.id}:evm`,
      chainFamily: "evm" as const,
      address: agent.walletAddress,
      venue: null,
      purpose: "primary",
      metadata: {},
      createdAt: agent.createdAt,
    },
  ];
}

function agentAuditEvent(
  c: Parameters<typeof requireTenantLevel>[0],
  event: {
    tenantId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  },
): AuditEventInput {
  const authType = c.get("authType");
  return {
    tenantId: event.tenantId,
    actorType: authType === "api-key" ? "api-key" : "user",
    actorId:
      authType === "api-key"
        ? event.tenantId
        : (c.get("userId") ?? authType ?? event.tenantId),
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    metadata: event.metadata,
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  };
}

async function writeAgentAudit(
  c: Parameters<typeof requireTenantLevel>[0],
  event: Parameters<typeof agentAuditEvent>[1],
): Promise<void> {
  await writeAuditEvent(agentAuditEvent(c, event));
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

function normalizeAgentTokenExpiry(value: unknown): string | null {
  const requested =
    typeof value === "string" && value.trim()
      ? value.trim()
      : getAgentTokenExpiry();
  const seconds = parseDurationSeconds(requested);
  if (!seconds || seconds > MAX_AGENT_TOKEN_SECONDS) return null;
  return requested;
}

function parseListLimit(value: string | undefined, fallback = 100): number {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_AGENT_LIST_LIMIT);
}

function parseListOffset(value: string | undefined): number {
  const parsed = value ? Number(value) : 0;
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 100_000);
}

function requireTenantAdminSession(
  c: Parameters<typeof requireTenantLevel>[0],
): boolean {
  const role = c.get("tenantRole");
  return (
    c.get("authType") === "session-jwt" &&
    (role === "owner" || role === "admin")
  );
}

function requireTenantAdminOrApiKey(
  c: Parameters<typeof requireTenantLevel>[0],
): boolean {
  if (c.get("authType") === "api-key") return true;
  return requireTenantAdminSession(c);
}

/**
 * SEC-209: agent-token minting, vault-policy-set replacement, and agent
 * deletion are root-equivalent mutations. A bare tenant API key (one shared
 * secret, no step-up possible) is no longer sufficient for them by default —
 * they require a human owner/admin session with recent MFA, consistent with
 * the sibling webhooks/secrets/audit surfaces. Operators that depend on
 * machine automation can explicitly restore the legacy api-key path via
 * STEWARD_ALLOW_API_KEY_ADMIN_MUTATIONS=true (documented as fully-root).
 */
function allowApiKeyAdminMutations(
  c: Parameters<typeof requireTenantLevel>[0],
): boolean {
  return (
    c.get("authType") === "api-key" &&
    process.env.STEWARD_ALLOW_API_KEY_ADMIN_MUTATIONS === "true"
  );
}

function requireSensitiveMutationPrincipal(
  c: Parameters<typeof requireTenantLevel>[0],
): boolean {
  return requireTenantAdminSession(c) || allowApiKeyAdminMutations(c);
}

function generateAgentId(): string {
  return `agt_${crypto.randomUUID()}`;
}

function generatePregeneratedWalletClaimToken(): string {
  return `stwd_claim_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

function pregeneratedClaimPlatformId(
  claimTokenHash: string,
  expiresAt: Date,
): string {
  return `${PREGENERATED_CLAIM_PREFIX}${claimTokenHash}:${expiresAt.getTime()}`;
}

function isPregeneratedClaimPlatformId(
  platformId: string | null | undefined,
): boolean {
  return (
    platformId?.startsWith(PREGENERATED_CLAIM_PREFIX) ||
    platformId?.startsWith(CLAIMED_PREGENERATED_CLAIM_PREFIX) ||
    platformId?.startsWith(EXPIRED_PREGENERATED_CLAIM_PREFIX) ||
    false
  );
}

function redactPregeneratedClaimPlatformId(
  agent: AgentIdentity,
): AgentIdentity {
  if (!isPregeneratedClaimPlatformId(agent.platformId)) return agent;
  const { platformId: _platformId, ...redacted } = agent;
  return redacted;
}

function pregeneratedClaimStatus(platformId: string | null): {
  status: "claimable" | "claimed" | "expired" | "unknown";
  claimExpiresAt: string | null;
} {
  if (!platformId) return { status: "unknown", claimExpiresAt: null };
  if (platformId.startsWith(CLAIMED_PREGENERATED_CLAIM_PREFIX)) {
    return { status: "claimed", claimExpiresAt: null };
  }
  if (platformId.startsWith(EXPIRED_PREGENERATED_CLAIM_PREFIX)) {
    return { status: "expired", claimExpiresAt: null };
  }
  if (!platformId.startsWith(PREGENERATED_CLAIM_PREFIX)) {
    return { status: "unknown", claimExpiresAt: null };
  }
  const [, expiresAtRaw] = platformId
    .slice(PREGENERATED_CLAIM_PREFIX.length)
    .split(":");
  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
    return { status: "claimable", claimExpiresAt: null };
  }
  return {
    status: expiresAtMs <= Date.now() ? "expired" : "claimable",
    claimExpiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function normalizePregeneratedClaimExpiry(value: unknown): Date | string {
  if (value === undefined || value === null) {
    return new Date(Date.now() + DEFAULT_PREGENERATED_CLAIM_TTL_MS);
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) {
    return "claimExpiresInSeconds must be an integer number of seconds";
  }
  const ttlMs = seconds * 1000;
  if (
    ttlMs < MIN_PREGENERATED_CLAIM_TTL_MS ||
    ttlMs > MAX_PREGENERATED_CLAIM_TTL_MS
  ) {
    return "claimExpiresInSeconds must be between 300 and 2592000 seconds";
  }
  return new Date(Date.now() + ttlMs);
}

async function deleteAgentRows(
  agentId: string,
  tenantId: string,
): Promise<void> {
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

async function deleteAgentWalletRows(
  agentId: string,
  chainFamily: AgentWalletChainFamily,
  venue: string | null,
): Promise<void> {
  const venueCondition =
    venue === null
      ? sql`${encryptedChainKeys.venue} is null`
      : eq(encryptedChainKeys.venue, venue);
  const walletVenueCondition =
    venue === null
      ? sql`${agentWallets.venue} is null`
      : eq(agentWallets.venue, venue);
  await db.transaction(async (tx) => {
    await tx
      .delete(encryptedChainKeys)
      .where(
        and(
          eq(encryptedChainKeys.agentId, agentId),
          eq(encryptedChainKeys.chainFamily, chainFamily),
          venueCondition,
        ),
      );
    await tx
      .delete(agentWallets)
      .where(
        and(
          eq(agentWallets.agentId, agentId),
          eq(agentWallets.chainFamily, chainFamily),
          walletVenueCondition,
        ),
      );
  });
}

async function deleteAgentSignerRow(signerId: string): Promise<void> {
  await db.delete(agentSigners).where(eq(agentSigners.id, signerId));
}

async function restoreAgentSigner(row: AgentSignerRow): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(agentSigners).where(eq(agentSigners.id, row.id));
    await tx.insert(agentSigners).values(row);
  });
}

async function deleteAgentKeyQuorumRow(quorumId: string): Promise<void> {
  await db.delete(agentKeyQuorums).where(eq(agentKeyQuorums.id, quorumId));
}

async function restoreAgentKeyQuorum(row: AgentKeyQuorumRow): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(agentKeyQuorums).where(eq(agentKeyQuorums.id, row.id));
    await tx.insert(agentKeyQuorums).values(row);
  });
}

async function snapshotAgentPolicies(agentId: string): Promise<PolicyRow[]> {
  return db.select().from(policies).where(eq(policies.agentId, agentId));
}

async function restoreAgentPolicies(
  agentId: string,
  snapshot: PolicyRow[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(policies).where(eq(policies.agentId, agentId));
    if (snapshot.length > 0) {
      await tx.insert(policies).values(snapshot);
    }
  });
}

/**
 * Drop the cached policy set after any per-agent policy mutation so a tightening
 * change (lowering a limit, disabling/deleting a rule) is never masked by a stale
 * permissive cache entry. Best-effort: a Redis failure must not block the write —
 * the next read falls back to the DB. No-op when Redis is unavailable (tests/pglite).
 */
async function invalidateAgentPolicyCache(
  agentId: string,
  tenantId: string,
): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await invalidateCache(agentId, tenantId);
  } catch (err) {
    logger.error(
      {
        details: [
          "[policy] Failed to invalidate policy cache",
          redactedThrownDiagnostics(err),
        ],
      },
      "[Login:agents] error",
    );
  }
}

function parseCustomTokenList(
  value: string | undefined,
): string[] | string | undefined {
  if (!value) return undefined;
  if (value.length > 2_500) return "tokens query is too long";
  const tokens = [
    ...new Set(
      value
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  ];
  if (tokens.length > MAX_CUSTOM_TOKEN_BALANCES) {
    return `tokens cannot contain more than ${MAX_CUSTOM_TOKEN_BALANCES} addresses`;
  }
  for (const token of tokens) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(token))
      return "tokens must be comma-separated EVM addresses";
  }
  return tokens;
}

function parseOptionalChainId(
  value: string | undefined,
): number | string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) return "chainId must be a positive integer";
  const chainId = Number(value);
  if (!Number.isSafeInteger(chainId) || chainId <= 0)
    return "chainId must be a positive integer";
  return chainId;
}

function normalizeOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${field} is too long`);
  return normalized;
}

function normalizeRequiredText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const normalized = normalizeOptionalText(value, field, maxLength);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function normalizeSignerPermissions(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error("permissions must be an array of strings");
  if (value.length > MAX_AGENT_SIGNER_PERMISSIONS) {
    throw new Error(
      `permissions cannot contain more than ${MAX_AGENT_SIGNER_PERMISSIONS} entries`,
    );
  }

  return [
    ...new Set(
      value.map((permission) => {
        if (typeof permission !== "string" || !permission.trim()) {
          throw new Error("permissions must be non-empty strings");
        }
        const normalized = permission.trim();
        if (normalized.length > 128)
          throw new Error("permissions entries must be 128 chars or less");
        return normalized;
      }),
    ),
  ];
}

function normalizeSignerPolicyIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error("policyIds must be an array of policy rule ids");
  if (value.length > 64)
    throw new Error("policyIds cannot contain more than 64 entries");
  return [
    ...new Set(
      value.map((policyId) => {
        if (typeof policyId !== "string" || !policyId.trim()) {
          throw new Error("policyIds must contain non-empty strings");
        }
        const normalized = policyId.trim();
        if (!isValidPolicyRuleId(normalized)) {
          throw new Error("policyIds entries must be valid policy rule ids");
        }
        return normalized;
      }),
    ),
  ];
}

async function validateSignerPolicyIdsForAgent(
  agentId: string,
  policyIds: string[],
): Promise<void> {
  if (policyIds.length === 0) return;
  const rows = await db
    .select({ id: policies.id })
    .from(policies)
    .where(and(eq(policies.agentId, agentId), inArray(policies.id, policyIds)));
  const found = new Set(rows.map((row) => row.id));
  const missing = policyIds.filter((policyId) => !found.has(policyId));
  if (missing.length > 0) {
    throw new Error(
      `policyIds must reference policies on this agent: ${missing.join(", ")}`,
    );
  }
}

function hasRecentSessionMfa(
  c: Parameters<typeof requireTenantLevel>[0],
  maxAgeMs = 5 * 60_000,
) {
  return isRecentMfaTimestamp(c.get("sessionMfaVerifiedAt"), maxAgeMs);
}

function requireRecentAdminMfa(
  c: Parameters<typeof requireTenantLevel>[0],
  reason: string,
) {
  // Tenant API keys are root machine credentials, not human sessions, so they
  // cannot perform a session MFA step-up. Session JWT callers still require MFA.
  if (c.get("authType") === "api-key") return null;
  if (hasRecentSessionMfa(c)) return null;
  return c.json<ApiResponse>(
    { ok: false, error: `${reason} requires recent MFA verification` },
    403,
  );
}

function normalizeSignerMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata must be an object");
  }
  if (JSON.stringify(value).length > MAX_AGENT_SIGNER_METADATA_BYTES) {
    throw new Error(
      `metadata cannot exceed ${MAX_AGENT_SIGNER_METADATA_BYTES} bytes`,
    );
  }
  for (const key of Object.keys(value)) {
    if (RESERVED_SIGNER_METADATA_KEYS.has(key)) {
      throw new Error(
        `metadata.${key} is reserved and cannot be set by clients`,
      );
    }
  }
  return value as Record<string, unknown>;
}

function mergeSignerMetadataPreservingReserved(
  existing: unknown,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...next };
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    for (const key of RESERVED_SIGNER_METADATA_KEYS) {
      const value = (existing as Record<string, unknown>)[key];
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

function normalizeOptionalQuorumMemberIds(
  value: unknown,
  field: string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  if (value.length > MAX_AGENT_KEY_QUORUM_MEMBERS) {
    throw new Error(
      `${field} cannot contain more than ${MAX_AGENT_KEY_QUORUM_MEMBERS}`,
    );
  }
  const ids = [
    ...new Set(
      value.map((id) => {
        if (typeof id !== "string" || !id.trim()) {
          throw new Error(`${field} must contain non-empty strings`);
        }
        return id.trim();
      }),
    ),
  ];
  return ids;
}

function normalizeQuorumMemberSignerIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("memberSignerIds must be a non-empty array");
  }
  return normalizeOptionalQuorumMemberIds(value, "memberSignerIds");
}

function normalizeQuorumThreshold(value: unknown, memberCount: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error("threshold must be a positive integer");
  }
  const threshold = Number(value);
  if (threshold > memberCount)
    throw new Error("threshold cannot exceed member count");
  return threshold;
}

async function validateQuorumMembers(
  tenantId: string,
  agentId: string,
  memberSignerIds: string[],
  memberQuorumIds: string[] = [],
  selfQuorumId?: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: agentSigners.id, status: agentSigners.status })
    .from(agentSigners)
    .where(
      and(
        eq(agentSigners.tenantId, tenantId),
        eq(agentSigners.agentId, agentId),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row.status]));
  for (const id of memberSignerIds) {
    const status = byId.get(id);
    if (!status) return `memberSignerIds contains unknown signer ${id}`;
    if (status !== "active")
      return `memberSignerIds contains inactive signer ${id}`;
  }
  if (memberQuorumIds.length > 0) {
    const quorumRows = await db
      .select({ id: agentKeyQuorums.id, status: agentKeyQuorums.status })
      .from(agentKeyQuorums)
      .where(
        and(
          eq(agentKeyQuorums.tenantId, tenantId),
          eq(agentKeyQuorums.agentId, agentId),
        ),
      );
    const quorumById = new Map(quorumRows.map((row) => [row.id, row.status]));
    for (const id of memberQuorumIds) {
      if (selfQuorumId && id === selfQuorumId)
        return "memberQuorumIds cannot include itself";
      const status = quorumById.get(id);
      if (!status) return `memberQuorumIds contains unknown quorum ${id}`;
      if (status !== "active")
        return `memberQuorumIds contains inactive quorum ${id}`;
    }
  }
  return null;
}

function toAgentKeyQuorumResponse(row: typeof agentKeyQuorums.$inferSelect) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentId: row.agentId,
    name: row.name,
    threshold: row.threshold,
    memberSignerIds: row.memberSignerIds,
    memberQuorumIds: row.memberQuorumIds,
    permissions: row.permissions,
    metadata: row.metadata,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function createSignerSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `stwd_signer_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function redactSignerMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const {
    credentialHash: _credentialHash,
    credentialCreatedAt: _credentialCreatedAt,
    credentialLastUsedAt: _credentialLastUsedAt,
    ...safeMetadata
  } = metadata;
  return safeMetadata;
}

function isValidPolicyRuleId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(value);
}

function normalizePolicyRuleInput(value: unknown): PolicyRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Policy rule must be an object");
  }
  const raw = value as Record<string, unknown>;
  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim()
      : crypto.randomUUID();
  if (!isValidPolicyRuleId(id)) {
    throw new Error(
      "Policy rule id must be 1-64 characters using letters, numbers, _, -, ., or :",
    );
  }
  return {
    id,
    type: raw.type as PolicyRule["type"],
    enabled: raw.enabled === undefined ? true : (raw.enabled as boolean),
    config: raw.config as Record<string, unknown>,
  };
}

function normalizePolicyRulePatch(
  existing: PolicyRule,
  value: unknown,
): PolicyRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Policy rule update must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.id !== undefined && raw.id !== existing.id) {
    throw new Error("Policy rule id cannot be changed");
  }
  return {
    ...existing,
    type:
      raw.type === undefined ? existing.type : (raw.type as PolicyRule["type"]),
    enabled:
      raw.enabled === undefined ? existing.enabled : (raw.enabled as boolean),
    config:
      raw.config === undefined
        ? existing.config
        : (raw.config as Record<string, unknown>),
  };
}

function toAgentSignerResponse(row: typeof agentSigners.$inferSelect) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentId: row.agentId,
    signerType: row.signerType,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    keyType: row.keyType,
    publicKey: row.publicKey,
    address: row.address,
    chainFamily: row.chainFamily,
    label: row.label,
    permissions: row.permissions,
    policyIds: row.policyIds,
    metadata: redactSignerMetadata(row.metadata),
    hasCredential: typeof row.metadata.credentialHash === "string",
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const TRADE_POLICY_DEFAULTS = {
  dailyCap: 1000,
  perOrderCap: 500,
  leverageCap: 10,
  allowedAssets: ["BTC", "ETH", "BNB"],
  allowedVenues: ["hyperliquid"],
  allowBuilderPerps: false,
} as const;

const TRADE_POLICY_LAYER_1_MAX = {
  dailyCap: 50_000,
  perOrderCap: 10_000,
  leverageCap: 50,
} as const;

type AgentTradePolicyResponse = {
  agentId: string;
  dailyCap: number;
  perOrderCap: number;
  leverageCap: number;
  allowedAssets: string[];
  allowedVenues: string[];
  allowBuilderPerps: boolean;
  updatedAt: string;
  updatedBy: string;
  updatedReason: string | null;
};

type AgentTradePolicySnapshot = Omit<
  AgentTradePolicyResponse,
  "updatedAt" | "updatedBy" | "updatedReason"
>;

type AgentTradePolicyPatch = {
  dailyCap?: unknown;
  perOrderCap?: unknown;
  leverageCap?: unknown;
  allowedAssets?: unknown;
  allowedVenues?: unknown;
  allowBuilderPerps?: unknown;
  reason?: unknown;
  multisigApproval?: unknown;
};

function parseNumericPolicyValue(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function policyRowToResponse(
  row: typeof agentPolicies.$inferSelect,
): AgentTradePolicyResponse {
  return {
    agentId: row.agentId,
    dailyCap: parseNumericPolicyValue(row.dailyCapUsd),
    perOrderCap: parseNumericPolicyValue(row.perOrderCapUsd),
    leverageCap: parseNumericPolicyValue(row.leverageCap),
    allowedAssets: row.allowedAssets,
    allowedVenues: row.allowedVenues,
    allowBuilderPerps: row.allowBuilderPerps,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    updatedReason: row.updatedReason ?? null,
  };
}

function defaultPolicySnapshot(agentId: string): AgentTradePolicySnapshot {
  return {
    agentId,
    dailyCap: TRADE_POLICY_DEFAULTS.dailyCap,
    perOrderCap: TRADE_POLICY_DEFAULTS.perOrderCap,
    leverageCap: TRADE_POLICY_DEFAULTS.leverageCap,
    allowedAssets: [...TRADE_POLICY_DEFAULTS.allowedAssets],
    allowedVenues: [...TRADE_POLICY_DEFAULTS.allowedVenues],
    allowBuilderPerps: TRADE_POLICY_DEFAULTS.allowBuilderPerps,
  };
}

function policyDiff(
  before: AgentTradePolicySnapshot,
  after: AgentTradePolicyResponse,
) {
  return {
    dailyCap: { before: before.dailyCap, after: after.dailyCap },
    perOrderCap: { before: before.perOrderCap, after: after.perOrderCap },
    leverageCap: { before: before.leverageCap, after: after.leverageCap },
    allowedAssets: { before: before.allowedAssets, after: after.allowedAssets },
    allowedVenues: { before: before.allowedVenues, after: after.allowedVenues },
    allowBuilderPerps: {
      before: before.allowBuilderPerps,
      after: after.allowBuilderPerps,
    },
  };
}

function validatePolicyNumber(
  name: "dailyCap" | "perOrderCap" | "leverageCap",
  value: unknown,
): number | string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return `${name} must be a positive number`;
  }
  if (value > TRADE_POLICY_LAYER_1_MAX[name]) {
    return `${name} exceeds platform ceiling ${TRADE_POLICY_LAYER_1_MAX[name]}`;
  }
  return value;
}

function validatePolicyStringArray(
  name: string,
  value: unknown,
): string[] | string {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    return `${name} must be a non-empty string array`;
  }
  return [...new Set(value)];
}

function validateOptionalBoolean(
  name: string,
  value: unknown,
): boolean | string {
  if (typeof value !== "boolean") return `${name} must be a boolean`;
  return value;
}

function hasBuilderPerpAsset(assets: readonly string[]): boolean {
  return assets.some((asset) => /^[a-z0-9]+:[A-Z0-9]+$/.test(asset));
}

/**
 * SEC-208: `agentPolicies` is the enforcement source for trade-session
 * ceilings, so an agent token must never RAISE its own limits (that would
 * defeat the human-ceiling model — any compromised agent token could mint
 * itself unlimited trading authority). Returns a human-readable violation
 * when `next` loosens any dimension relative to `before` (the current row,
 * or the platform defaults when no row exists yet); null when the change is
 * a pure tightening. Widening requires the owner/admin + recent-MFA path.
 */
function policyLooseningViolation(
  before: AgentTradePolicySnapshot,
  next: {
    dailyCap: number;
    perOrderCap: number;
    leverageCap: number;
    allowedAssets: string[];
    allowedVenues: string[];
    allowBuilderPerps: boolean;
  },
): string | null {
  if (next.dailyCap > before.dailyCap) {
    return `dailyCap cannot be raised above ${before.dailyCap} with an agent token (use an owner/admin session with recent MFA to loosen limits)`;
  }
  if (next.perOrderCap > before.perOrderCap) {
    return `perOrderCap cannot be raised above ${before.perOrderCap} with an agent token (use an owner/admin session with recent MFA to loosen limits)`;
  }
  if (next.leverageCap > before.leverageCap) {
    return `leverageCap cannot be raised above ${before.leverageCap} with an agent token (use an owner/admin session with recent MFA to loosen limits)`;
  }
  if (
    !next.allowedAssets.every((asset) => before.allowedAssets.includes(asset))
  ) {
    return "allowedAssets cannot be widened with an agent token (use an owner/admin session with recent MFA to loosen limits)";
  }
  if (
    !next.allowedVenues.every((venue) => before.allowedVenues.includes(venue))
  ) {
    return "allowedVenues cannot be widened with an agent token (use an owner/admin session with recent MFA to loosen limits)";
  }
  if (next.allowBuilderPerps && !before.allowBuilderPerps) {
    return "allowBuilderPerps cannot be enabled with an agent token (use an owner/admin session with recent MFA to loosen limits)";
  }
  return null;
}

/**
 * Exact policy compare-and-swap fence used after authorizing an agent-token
 * tightening. The attribution fields are part of the expected snapshot too:
 * two concurrent requests that produce identical limits but claim different
 * reasons must not both commit against the same audit `before` state.
 */
export function buildAgentPolicyCompareAndSwapPredicate(
  agentId: string,
  tenantId: string,
  expected: typeof agentPolicies.$inferSelect,
) {
  return and(
    eq(agentPolicies.agentId, agentId),
    eq(agentPolicies.tenantId, tenantId),
    eq(agentPolicies.dailyCapUsd, expected.dailyCapUsd),
    eq(agentPolicies.perOrderCapUsd, expected.perOrderCapUsd),
    eq(agentPolicies.leverageCap, expected.leverageCap),
    eq(agentPolicies.allowedAssets, expected.allowedAssets),
    eq(agentPolicies.allowedVenues, expected.allowedVenues),
    eq(agentPolicies.allowBuilderPerps, expected.allowBuilderPerps),
    eq(agentPolicies.updatedAt, expected.updatedAt),
    eq(agentPolicies.updatedBy, expected.updatedBy),
    expected.updatedReason === null
      ? isNull(agentPolicies.updatedReason)
      : eq(agentPolicies.updatedReason, expected.updatedReason),
  );
}

// ─── Create agent ─────────────────────────────────────────────────────────────

agentRoutes.post("/", async (c) => {
  if (!requireTenantAdminOrApiKey(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Agent creation requires owner or admin session",
      },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(c, "Agent creation");
  if (mfaResponse) return mfaResponse;

  const tenantId = c.get("tenantId");
  if (!tenantId) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant id required" }, 400);
  }
  const body = await safeJsonParse<{
    id?: string;
    name: string;
    platformId?: string;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (body.id !== undefined && !isValidAgentId(body.id)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Invalid agent id — must be 1-128 alphanumeric characters (plus _ - . :)",
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
    const agentId = generateAgentId();
    await writeAgentAudit(c, {
      tenantId,
      action: "agent.create.authorized",
      resourceType: "agent",
      resourceId: agentId,
      metadata: {
        name: body.name,
        requestedId: body.id ?? null,
        platformId: body.platformId ?? null,
      },
    });
    const identity = await vault.createAgent(
      tenantId,
      agentId,
      body.name,
      body.platformId,
    );
    try {
      await writeAgentAudit(c, {
        tenantId,
        action: "agent.create",
        resourceType: "agent",
        resourceId: agentId,
        metadata: {
          name: body.name,
          requestedId: body.id ?? null,
          platformId: body.platformId ?? null,
        },
      });
    } catch (error) {
      await deleteAgentRows(agentId, tenantId);
      throw error;
    }
    return c.json<ApiResponse<AgentIdentity>>({ ok: true, data: identity });
  } catch (e: unknown) {
    // SEC-210: never return raw internal error text (DB constraint names, RPC
    // endpoint details); sanitizeErrorMessage passes through only known-safe
    // client-facing messages.
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      400,
    );
  }
});

// ─── Create user-claimable pregenerated wallets ──────────────────────────────

agentRoutes.post("/pregenerated", async (c) => {
  if (!requireTenantAdminOrApiKey(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Pregenerated wallet creation requires owner or admin session",
      },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(c, "Pregenerated wallet creation");
  if (mfaResponse) return mfaResponse;

  const tenantId = c.get("tenantId");
  const body = await safeJsonParse<{
    count?: unknown;
    namePrefix?: unknown;
    claimExpiresInSeconds?: unknown;
    applyPolicies?: PolicyRule[];
  }>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  const count = body.count === undefined ? 1 : Number(body.count);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BATCH_AGENTS) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `count must be an integer between 1 and ${MAX_BATCH_AGENTS}`,
      },
      400,
    );
  }

  const namePrefix =
    body.namePrefix === undefined || body.namePrefix === null
      ? "Pregenerated user wallet"
      : isNonEmptyString(body.namePrefix)
        ? body.namePrefix.trim()
        : null;
  if (!namePrefix) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "namePrefix must be a non-empty string when provided",
      },
      400,
    );
  }

  const claimExpiresAt = normalizePregeneratedClaimExpiry(
    body.claimExpiresInSeconds,
  );
  if (typeof claimExpiresAt === "string") {
    return c.json<ApiResponse>({ ok: false, error: claimExpiresAt }, 400);
  }

  if (body.applyPolicies !== undefined) {
    if (!Array.isArray(body.applyPolicies)) {
      return c.json<ApiResponse>(
        { ok: false, error: "applyPolicies must be an array" },
        400,
      );
    }
    if (body.applyPolicies.length > MAX_POLICIES_PER_AGENT) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `applyPolicies cannot contain more than ${MAX_POLICIES_PER_AGENT}`,
        },
        400,
      );
    }
    const policyValidationError = getPolicyRulesValidationError(
      body.applyPolicies,
    );
    if (policyValidationError) {
      return c.json<ApiResponse>(
        { ok: false, error: policyValidationError },
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

  const wallets: Array<{
    agent: AgentIdentity;
    claimToken: string;
    claimExpiresAt: string;
  }> = [];
  const persistedPolicies = body.applyPolicies?.map(toPersistedPolicyRule);

  try {
    for (let index = 0; index < count; index += 1) {
      const agentId = generateAgentId();
      const claimToken = generatePregeneratedWalletClaimToken();
      const claimTokenHash = hashSha256Hex(claimToken);
      const platformId = pregeneratedClaimPlatformId(
        claimTokenHash,
        claimExpiresAt,
      );
      const name = count === 1 ? namePrefix : `${namePrefix} ${index + 1}`;

      await writeAgentAudit(c, {
        tenantId,
        action: "agent.pregenerated_user_wallet.create.authorized",
        resourceType: "agent",
        resourceId: agentId,
        metadata: {
          batch: count > 1,
          claimExpiresAt: claimExpiresAt.toISOString(),
        },
      });

      const identity = await vault.createAgent(
        tenantId,
        agentId,
        name,
        platformId,
      );

      try {
        await db.transaction(async (tx) => {
          await tx
            .update(agents)
            .set({
              walletType: PREGENERATED_USER_WALLET_TYPE,
              updatedAt: new Date(),
            })
            .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)));

          if (persistedPolicies && persistedPolicies.length > 0) {
            await tx.insert(policies).values(
              persistedPolicies.map((policy) => ({
                id: crypto.randomUUID(),
                agentId,
                type: policy.type,
                enabled: policy.enabled,
                config: policy.config,
              })),
            );
          }
        });

        await writeAgentAudit(c, {
          tenantId,
          action: "agent.pregenerated_user_wallet.create",
          resourceType: "agent",
          resourceId: agentId,
          metadata: {
            batch: count > 1,
            appliedPolicyCount: persistedPolicies?.length ?? 0,
            claimExpiresAt: claimExpiresAt.toISOString(),
          },
        });
      } catch (error) {
        await deleteAgentRows(agentId, tenantId);
        throw error;
      }

      wallets.push({
        agent: redactPregeneratedClaimPlatformId(identity),
        claimToken,
        claimExpiresAt: claimExpiresAt.toISOString(),
      });
    }
  } catch (error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `Failed to create pregenerated wallets: ${sanitizeErrorMessage(error)}`,
      },
      500,
    );
  }

  setNoStoreHeaders(c);
  return c.json<
    ApiResponse<{
      wallets: Array<{
        agent: AgentIdentity;
        claimToken: string;
        claimExpiresAt: string;
      }>;
      warning: string;
    }>
  >(
    {
      ok: true,
      data: {
        wallets,
        warning:
          "Claim tokens are shown once. Steward stores only SHA-256 hashes and cannot recover lost claim tokens.",
      },
    },
    201,
  );
});

// ─── List agents ──────────────────────────────────────────────────────────────

agentRoutes.get("/", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Agent listing requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const limit = parseListLimit(c.req.query("limit"));
  const offset = parseListOffset(c.req.query("offset"));
  const tenantAgents = await vault.listAgentsByTenant(tenantId, {
    limit,
    offset,
  });
  return c.json<
    ApiResponse<{ agents: AgentIdentity[]; limit: number; offset: number }>
  >({
    ok: true,
    data: {
      agents: tenantAgents.map(redactPregeneratedClaimPlatformId),
      limit,
      offset,
    },
  });
});

// ─── Pregenerated wallet inventory and claim-token rotation ──────────────────

agentRoutes.get("/pregenerated", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Pregenerated wallet inventory requires tenant-level authentication",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const limit = parseListLimit(c.req.query("limit"));
  const offset = parseListOffset(c.req.query("offset"));
  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.tenantId, tenantId),
        eq(agents.walletType, PREGENERATED_USER_WALLET_TYPE),
      ),
    )
    .limit(limit)
    .offset(offset);

  return c.json<
    ApiResponse<{
      wallets: Array<{
        agent: AgentIdentity;
        status: "claimable" | "claimed" | "expired" | "unknown";
        claimExpiresAt: string | null;
      }>;
      limit: number;
      offset: number;
    }>
  >({
    ok: true,
    data: {
      wallets: rows.map((row) => ({
        agent: redactPregeneratedClaimPlatformId({
          id: row.id,
          tenantId: row.tenantId,
          name: row.name,
          walletAddress: row.walletAddress,
          erc8004TokenId: row.erc8004TokenId ?? undefined,
          platformId: row.platformId ?? undefined,
          createdAt: row.createdAt,
        }),
        ...pregeneratedClaimStatus(row.platformId),
      })),
      limit,
      offset,
    },
  });
});

agentRoutes.post("/pregenerated/:agentId/claim-token/rotate", async (c) => {
  setNoStoreHeaders(c);
  if (!requireTenantAdminOrApiKey(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Pregenerated wallet claim-token rotation requires owner or admin session",
      },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(
    c,
    "Pregenerated wallet claim-token rotation",
  );
  if (mfaResponse) return mfaResponse;

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const body = await safeJsonParse<{ claimExpiresInSeconds?: unknown }>(c);
  const claimExpiresAt = normalizePregeneratedClaimExpiry(
    body?.claimExpiresInSeconds,
  );
  if (typeof claimExpiresAt === "string") {
    return c.json<ApiResponse>({ ok: false, error: claimExpiresAt }, 400);
  }

  const [existing] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.tenantId, tenantId),
        eq(agents.walletType, PREGENERATED_USER_WALLET_TYPE),
      ),
    );
  if (!existing) {
    return c.json<ApiResponse>(
      { ok: false, error: "Pregenerated wallet not found" },
      404,
    );
  }
  if (existing.platformId?.startsWith(CLAIMED_PREGENERATED_CLAIM_PREFIX)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Pregenerated wallet is already claimed" },
      409,
    );
  }

  const claimToken = generatePregeneratedWalletClaimToken();
  const claimTokenHash = hashSha256Hex(claimToken);
  const platformId = pregeneratedClaimPlatformId(
    claimTokenHash,
    claimExpiresAt,
  );

  await writeAgentAudit(c, {
    tenantId,
    action: "agent.pregenerated_user_wallet.claim_token.rotate.authorized",
    resourceType: "agent",
    resourceId: agentId,
    metadata: { claimExpiresAt: claimExpiresAt.toISOString() },
  });

  const [updated] = await db
    .update(agents)
    .set({ platformId, updatedAt: new Date() })
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.tenantId, tenantId),
        eq(agents.walletType, PREGENERATED_USER_WALLET_TYPE),
      ),
    )
    .returning();
  if (!updated) {
    return c.json<ApiResponse>(
      { ok: false, error: "Pregenerated wallet not found" },
      404,
    );
  }

  await writeAgentAudit(c, {
    tenantId,
    action: "agent.pregenerated_user_wallet.claim_token.rotate",
    resourceType: "agent",
    resourceId: agentId,
    metadata: { claimExpiresAt: claimExpiresAt.toISOString() },
  });

  return c.json<
    ApiResponse<{
      agent: AgentIdentity;
      claimToken: string;
      claimExpiresAt: string;
      warning: string;
    }>
  >({
    ok: true,
    data: {
      agent: redactPregeneratedClaimPlatformId({
        id: updated.id,
        tenantId: updated.tenantId,
        name: updated.name,
        walletAddress: updated.walletAddress,
        erc8004TokenId: updated.erc8004TokenId ?? undefined,
        platformId: updated.platformId ?? undefined,
        createdAt: updated.createdAt,
      }),
      claimToken,
      claimExpiresAt: claimExpiresAt.toISOString(),
      warning:
        "Claim tokens are shown once. Steward stores only SHA-256 hashes and cannot recover lost claim tokens.",
    },
  });
});

// ─── Agent token generation ───────────────────────────────────────────────────

agentRoutes.post("/:agentId/token", async (c) => {
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");

  // SEC-209: minting agent tokens is root-equivalent — human admin session
  // (API key only via explicit STEWARD_ALLOW_API_KEY_ADMIN_MUTATIONS opt-in).
  if (!requireSensitiveMutationPrincipal(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Agent token creation requires owner or admin session",
      },
      403,
    );
  }

  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<{
    expiresIn?: string;
    scopes?: string[] | string;
  }>(c);
  const expiresIn = normalizeAgentTokenExpiry(body?.expiresIn);
  if (!expiresIn) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "expiresIn must be a duration up to 30d using s, m, h, or d",
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
  const mfaResponse = requireRecentAdminMfa(c, "Agent token creation");
  if (mfaResponse) return mfaResponse;

  try {
    await writeAgentAudit(c, {
      tenantId,
      action: "agent.token.create.authorized",
      resourceType: "agent",
      resourceId: agentId,
      metadata: { scopes, expiresIn },
    });
    const token = await createAgentTokenForExistingAgent(
      agentId,
      tenantId,
      expiresIn,
      scopes,
    );
    if (!token) {
      return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
    }
    await writeAgentAudit(c, {
      tenantId,
      action: "agent.token.create",
      resourceType: "agent",
      resourceId: agentId,
      metadata: { scopes, expiresIn },
    });
    c.header("Cache-Control", "no-store, max-age=0");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    return c.json<
      ApiResponse<{
        token: string;
        agentId: string;
        tenantId: string;
        scope: string;
        scopes: string[];
        expiresIn: string;
      }>
    >({
      ok: true,
      data: { token, agentId, tenantId, scope: "agent", scopes, expiresIn },
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    logger.error(
      {
        details: [
          `[${requestId}] Failed to generate agent token for ${agentId}`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:agents] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: "Failed to generate token" },
      500,
    );
  }
});

// Create venue-scoped wallet (Sprint 4)
//
// POST /agents/:agentId/wallets
// Body: { venue?: string, scope?: string, chainType: "evm" | "solana" | "bitcoin", purpose?: string }
//
// Creates a venue-scoped wallet under (agentId, chainFamily, venue).
// Required before trading on a venue: /v1/trade/sessions and
// /v1/trade/orders/hyperliquid both call vault.getWallet({ agentId, venue })
// and reject if no row exists.
//
// Tenant-level auth required (provisions wallets, not Sol's own JWT).

agentRoutes.post("/:agentId/wallets", async (c) => {
  if (!requireTenantAdminOrApiKey(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Venue wallet creation requires owner or admin session",
      },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(c, "Venue wallet creation");
  if (mfaResponse) return mfaResponse;

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");

  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<{
    venue?: string;
    scope?: string;
    chainType?: AgentWalletChainFamily;
    purpose?: string;
    bitcoinNetwork?: BitcoinNetwork;
    bitcoinAddressType?: BitcoinAddressType;
    moneroNetwork?: MoneroNetwork;
    account?: number;
    change?: 0 | 1;
    index?: number;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  if (
    body.chainType !== "evm" &&
    body.chainType !== "solana" &&
    body.chainType !== "bitcoin" &&
    body.chainType !== "monero"
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: 'chainType must be "evm", "solana", "bitcoin", or "monero"',
      },
      400,
    );
  }
  const scope = body.scope ?? body.venue;
  // Bitcoin and Monero wallet scopes are auto-derived from their options when omitted.
  if (
    body.chainType !== "bitcoin" &&
    body.chainType !== "monero" &&
    !isNonEmptyString(scope)
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: "venue or scope is required" },
      400,
    );
  }
  if (
    body.bitcoinNetwork !== undefined &&
    !["mainnet", "testnet"].includes(body.bitcoinNetwork)
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: 'bitcoinNetwork must be "mainnet" or "testnet"' },
      400,
    );
  }
  if (
    body.moneroNetwork !== undefined &&
    !["mainnet", "stagenet"].includes(body.moneroNetwork)
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: 'moneroNetwork must be "mainnet" or "stagenet"' },
      400,
    );
  }
  if (
    body.bitcoinAddressType !== undefined &&
    !["p2wpkh", "p2tr"].includes(body.bitcoinAddressType)
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: 'bitcoinAddressType must be "p2wpkh" or "p2tr"' },
      400,
    );
  }

  try {
    await writeAgentAudit(c, {
      tenantId,
      action: "agent.wallet.create.authorized",
      resourceType: "agent",
      resourceId: agentId,
      metadata: {
        venue: scope ?? null,
        chainType: body.chainType,
        purpose: body.purpose ?? null,
        bitcoinNetwork: body.bitcoinNetwork ?? null,
        bitcoinAddressType: body.bitcoinAddressType ?? null,
        moneroNetwork: body.moneroNetwork ?? null,
      },
    });
    const wallet = await vault.createWallet({
      agentId,
      // SEC-162: vault-layer tenant verification (defense-in-depth on top of
      // ensureAgentForTenant above).
      tenantId,
      venue: body.venue,
      scope: body.scope,
      chainType: body.chainType,
      purpose: body.purpose,
      bitcoin:
        body.chainType === "bitcoin"
          ? {
              network: body.bitcoinNetwork,
              addressType: body.bitcoinAddressType,
              account: body.account,
              change: body.change,
              index: body.index,
            }
          : undefined,
      monero:
        body.chainType === "monero"
          ? {
              network: body.moneroNetwork,
              account: body.account,
            }
          : undefined,
    });
    try {
      await writeAgentAudit(c, {
        tenantId,
        action: "agent.wallet.create",
        resourceType: "agent",
        resourceId: agentId,
        metadata: {
          venue: wallet.venue,
          chainType: body.chainType,
          purpose: body.purpose ?? null,
          address: wallet.address,
          walletMetadata: redactWalletMetadataSecrets(wallet.metadata),
        },
      });
    } catch (error) {
      await deleteAgentWalletRows(agentId, wallet.chainFamily, wallet.venue);
      throw error;
    }
    return c.json<
      ApiResponse<{
        agentId: string;
        chainFamily: AgentWalletChainFamily;
        venue: string | null;
        purpose: string | null;
        address: string;
        metadata: Record<string, unknown>;
      }>
    >({
      ok: true,
      data: {
        ...wallet,
        metadata: redactWalletMetadataSecrets(wallet.metadata),
      },
    });
  } catch (e: unknown) {
    // SEC-210: never return raw internal error text (DB constraint names, RPC
    // endpoint details); sanitizeErrorMessage passes through only known-safe
    // client-facing messages.
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      400,
    );
  }
});

// ─── Agent trade policy ──────────────────────────────────────────────────────

agentRoutes.get("/:agentId/policy", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);

  const [policy] = await db
    .select()
    .from(agentPolicies)
    .where(
      and(
        eq(agentPolicies.agentId, agentId),
        eq(agentPolicies.tenantId, tenantId),
      ),
    );

  if (!policy) {
    return c.json<
      ApiResponse<{ defaults: typeof TRADE_POLICY_DEFAULTS; message: string }>
    >(
      {
        ok: false,
        error: "Agent policy not found",
        data: {
          defaults: TRADE_POLICY_DEFAULTS,
          message:
            "No agent policy row exists. Defaults apply until PUT creates one.",
        },
      },
      404,
    );
  }

  return c.json<ApiResponse<AgentTradePolicyResponse>>({
    ok: true,
    data: policyRowToResponse(policy),
  });
});

agentRoutes.put("/:agentId/policy", async (c) => {
  // Two write paths enter the trade-policy table:
  //   1. agent token (self-update): TIGHTEN-ONLY against the existing row,
  //      enforced below after validation via policyLooseningViolation, and
  //      forbidden from creating the initial row (creation activates the
  //      trade-route ceilings, so it is reserved for path 2).
  //   2. human owner/admin session with recent MFA: unrestricted subject to the
  //      platform ceilings.
  // Tenant API keys are rejected.
  const isAgentSelfUpdate = c.get("authType") === "agent-token";
  if (isAgentSelfUpdate) {
    if (!requireAgentAccess(c)) {
      return c.json<ApiResponse>(
        { ok: false, error: "Forbidden: token scope does not match agent" },
        403,
      );
    }
  } else {
    if (!requireTenantAdminSession(c)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Agent policy updates require an agent token or an owner/admin session",
        },
        403,
      );
    }
    const mfaResponse = requireRecentAdminMfa(c, "Agent policy updates");
    if (mfaResponse) return mfaResponse;
  }

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);

  const body = await safeJsonParse<AgentTradePolicyPatch>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
    return c.json<ApiResponse>({ ok: false, error: "reason is required" }, 400);
  }

  // Validate caller-provided fields before opening the write transaction, but
  // do not fill omitted partial-patch fields yet. Their values must come from
  // the row locked and re-read inside the audited transaction.
  const validatedPatch = {
    dailyCap:
      body.dailyCap === undefined
        ? undefined
        : validatePolicyNumber("dailyCap", body.dailyCap),
    perOrderCap:
      body.perOrderCap === undefined
        ? undefined
        : validatePolicyNumber("perOrderCap", body.perOrderCap),
    leverageCap:
      body.leverageCap === undefined
        ? undefined
        : validatePolicyNumber("leverageCap", body.leverageCap),
    allowedAssets:
      body.allowedAssets === undefined
        ? undefined
        : validatePolicyStringArray("allowedAssets", body.allowedAssets),
    allowedVenues:
      body.allowedVenues === undefined
        ? undefined
        : validatePolicyStringArray("allowedVenues", body.allowedVenues),
    allowBuilderPerps:
      body.allowBuilderPerps === undefined
        ? undefined
        : validateOptionalBoolean("allowBuilderPerps", body.allowBuilderPerps),
  };
  const validationError = Object.values(validatedPatch).find(
    (value) => typeof value === "string",
  );
  if (typeof validationError === "string") {
    return c.json<ApiResponse>({ ok: false, error: validationError }, 400);
  }

  const updatedBy = isAgentSelfUpdate
    ? (c.get("agentSubject") ?? `agent:${agentId}`)
    : (c.get("userId") ?? "unknown");
  const updatedReason = body.reason.trim();

  const mutation = await withTenantAuditedTransaction(
    tenantId,
    async (txRaw, appendRequiredAudit) => {
      const tx = txRaw as typeof db;
      // Serialize the complete partial-patch read/materialize/write sequence,
      // including initial-row creation where SELECT FOR UPDATE has no row to
      // lock. PGLite runs tests on one connection and lacks this PG function.
      if (process.env.STEWARD_PGLITE_MEMORY !== "true") {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-policy:${tenantId}:${agentId}`}, 0))`,
        );
      }
      const [existing] = await tx
        .select()
        .from(agentPolicies)
        .where(
          and(
            eq(agentPolicies.agentId, agentId),
            eq(agentPolicies.tenantId, tenantId),
          ),
        )
        .for("update");
      const before = existing
        ? policyRowToResponse(existing)
        : defaultPolicySnapshot(agentId);
      const dailyCapValue = (validatedPatch.dailyCap ??
        before.dailyCap) as number;
      const perOrderCapValue = (validatedPatch.perOrderCap ??
        before.perOrderCap) as number;
      const leverageCapValue = (validatedPatch.leverageCap ??
        before.leverageCap) as number;
      const allowedAssetsValue = (validatedPatch.allowedAssets ??
        before.allowedAssets) as string[];
      const allowedVenuesValue = (validatedPatch.allowedVenues ??
        before.allowedVenues) as string[];
      const allowBuilderPerpsValue = (validatedPatch.allowBuilderPerps ??
        before.allowBuilderPerps) as boolean;

      if (hasBuilderPerpAsset(allowedAssetsValue) && !allowBuilderPerpsValue) {
        return {
          kind: "invalid" as const,
          status: 400 as const,
          error: "builder perp assets require allowBuilderPerps=true",
        };
      }
      if (perOrderCapValue > dailyCapValue) {
        return {
          kind: "invalid" as const,
          status: 400 as const,
          error: "perOrderCap cannot exceed dailyCap",
        };
      }
      if (isAgentSelfUpdate) {
        if (!existing) {
          return {
            kind: "invalid" as const,
            status: 403 as const,
            error:
              "Initial trade policy creation requires an owner/admin session with recent MFA",
          };
        }
        const loosening = policyLooseningViolation(before, {
          dailyCap: dailyCapValue,
          perOrderCap: perOrderCapValue,
          leverageCap: leverageCapValue,
          allowedAssets: allowedAssetsValue,
          allowedVenues: allowedVenuesValue,
          allowBuilderPerps: allowBuilderPerpsValue,
        });
        if (loosening)
          return {
            kind: "invalid" as const,
            status: 403 as const,
            error: loosening,
          };
      }

      const nextPolicyValues = {
        dailyCapUsd: String(dailyCapValue),
        perOrderCapUsd: String(perOrderCapValue),
        leverageCap: String(leverageCapValue),
        allowedAssets: allowedAssetsValue,
        allowedVenues: allowedVenuesValue,
        allowBuilderPerps: allowBuilderPerpsValue,
        updatedAt: new Date(),
        updatedBy,
        updatedReason,
      };
      let upserted: typeof agentPolicies.$inferSelect | undefined;
      if (existing) {
        [upserted] = await tx
          .update(agentPolicies)
          .set(nextPolicyValues)
          .where(
            buildAgentPolicyCompareAndSwapPredicate(
              agentId,
              tenantId,
              existing,
            ),
          )
          .returning();
        if (!upserted) return { kind: "conflict" as const };
      } else {
        [upserted] = await tx
          .insert(agentPolicies)
          .values({ agentId, tenantId, ...nextPolicyValues })
          .returning();
      }
      if (!upserted) throw new Error("Failed to update agent policy");

      const after = policyRowToResponse(upserted);
      const diff = policyDiff(before, after);
      await appendRequiredAudit({
        tenantId,
        actorType: isAgentSelfUpdate ? "agent" : "user",
        actorId: updatedBy,
        action: "agent.policy.updated",
        resourceType: "agent_policy",
        resourceId: agentId,
        metadata: {
          agentId,
          reason: updatedReason,
          diff,
          before,
          after,
          multisigApprovalProvided: body.multisigApproval !== undefined,
        },
        ipAddress: c.req.header("x-forwarded-for") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      });
      return { kind: "updated" as const, after, diff };
    },
  );

  if (mutation.kind === "invalid") {
    return c.json<ApiResponse>(
      { ok: false, error: mutation.error },
      mutation.status,
    );
  }
  if (mutation.kind === "conflict") {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Agent policy changed concurrently; retry against the latest policy",
      },
      409,
    );
  }
  const { after, diff } = mutation;

  return c.json<
    ApiResponse<{
      policy: AgentTradePolicyResponse;
      diff: ReturnType<typeof policyDiff>;
    }>
  >({
    ok: true,
    data: { policy: after, diff },
  });
});

// ─── Get agent ────────────────────────────────────────────────────────────────

agentRoutes.get("/:agentId", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const agent = await vault.getAgent(tenantId, c.req.param("agentId"));
  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }
  return c.json<ApiResponse<AgentIdentity>>({
    ok: true,
    data: redactPregeneratedClaimPlatformId(agent),
  });
});

// ─── Delete agent ─────────────────────────────────────────────────────────────

agentRoutes.delete("/:agentId", async (c) => {
  // SEC-209: deleting an agent destroys its key material — human admin
  // session (API key only via explicit opt-in).
  if (!requireSensitiveMutationPrincipal(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Agent deletion requires owner or admin session",
      },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(c, "Agent deletion");
  if (mfaResponse) return mfaResponse;

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  try {
    await writeAgentAudit(c, {
      tenantId,
      action: "agent.delete.authorized",
      resourceType: "agent",
      resourceId: agentId,
      metadata: { walletAddress: agent.walletAddress },
    });
    let issuedBefore = 0;
    const completionAudit = agentAuditEvent(c, {
      tenantId,
      action: "agent.delete",
      resourceType: "agent",
      resourceId: agentId,
      metadata: {},
    });
    const deletion = await deleteAgentAuthority({
      tenantId,
      agentId,
      completionAudit,
      beforeDelete: async () => {
        issuedBefore = Math.floor(Date.now() / 1000);
        await revocationStore.revokeAgentTokens(agentId, issuedBefore);
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
      return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
    }

    return c.json<ApiResponse<{ deleted: string }>>({
      ok: true,
      data: { deleted: agentId },
    });
  } catch (e: unknown) {
    const requestId = c.get("requestId") || "unknown";
    logger.error(
      {
        details: [
          `[${requestId}] Failed to delete agent ${agentId}`,
          redactedThrownDiagnostics(e),
        ],
      },
      "[Login:agents] error",
    );
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      500,
    );
  }
});

// ─── Agent balance ────────────────────────────────────────────────────────────

agentRoutes.get("/:agentId/balance", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const chainId = parseOptionalChainId(c.req.query("chainId"));
  if (typeof chainId === "string") {
    return c.json<ApiResponse>({ ok: false, error: chainId }, 400);
  }

  try {
    const balance = await vault.getBalance(tenantId, agentId, chainId);
    return c.json<ApiResponse>({
      ok: true,
      data: {
        agentId,
        walletAddress: balance.walletAddress,
        balances: {
          native: balance.native.toString(),
          nativeFormatted: balance.nativeFormatted,
          chainId: balance.chainId,
          symbol: balance.symbol,
        },
      },
    });
  } catch (e: unknown) {
    // SEC-210: never return raw internal error text (DB constraint names, RPC
    // endpoint details); sanitizeErrorMessage passes through only known-safe
    // client-facing messages.
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      400,
    );
  }
});

// ─── Agent token balances (ERC-20) ────────────────────────────────────────────

agentRoutes.get("/:agentId/tokens", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  if (!agentId) {
    return c.json<ApiResponse>({ ok: false, error: "Agent id required" }, 400);
  }
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const chainId = parseOptionalChainId(c.req.query("chainId"));
  if (typeof chainId === "string") {
    return c.json<ApiResponse>({ ok: false, error: chainId }, 400);
  }
  const tokensParam = c.req.query("tokens");
  const customTokens = parseCustomTokenList(tokensParam);
  if (typeof customTokens === "string") {
    return c.json<ApiResponse>({ ok: false, error: customTokens }, 400);
  }

  try {
    // Fetch native balance
    const balance = await vault.getBalance(tenantId, agentId, chainId);

    // Fetch ERC-20 token balances
    const tokenBalances = await vault.getTokenBalances(
      tenantId,
      agentId,
      chainId,
      customTokens,
    );

    return c.json<ApiResponse>({
      ok: true,
      data: {
        agentId,
        walletAddress: balance.walletAddress,
        chainId: balance.chainId,
        native: {
          symbol: balance.symbol,
          balance: balance.native.toString(),
          formatted: balance.nativeFormatted,
        },
        tokens: tokenBalances,
      },
    });
  } catch (e: unknown) {
    // SEC-210: never return raw internal error text (DB constraint names, RPC
    // endpoint details); sanitizeErrorMessage passes through only known-safe
    // client-facing messages.
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      400,
    );
  }
});

// ─── Agent spend summary ─────────────────────────────────────────────────────

agentRoutes.get("/:agentId/spend", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const txStats = await getTransactionStats(agentId);
  const sponsorship = publicGasSponsorshipState(
    await readTenantGasSponsorshipConfig(tenantId),
  );
  const oneMonthAgo = new Date(Date.now() - 30 * 86400_000);
  const [monthlyStats] = await db
    .select({
      spentThisMonth: sql<string>`coalesce(sum((${transactions.value})::numeric), 0)::text`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.agentId, agentId),
        gte(transactions.createdAt, oneMonthAgo),
        sql`${transactions.status} in ('signed', 'broadcast', 'confirmed')`,
      ),
    );

  const realtimeEnabled = isRedisAvailable();
  const realtimePeriods = realtimeEnabled
    ? await Promise.all(
        SPEND_PERIODS.map(async (period) => ({
          period,
          spentUsd: await getSpend(agentId, period),
          byHost: await getSpendByHost(agentId, period),
        })),
      )
    : SPEND_PERIODS.map((period) => ({ period, spentUsd: null, byHost: {} }));

  return c.json<ApiResponse>({
    ok: true,
    data: {
      agentId,
      walletAddress: agent.walletAddress,
      onchain: {
        todayWei: txStats.spentToday.toString(),
        weekWei: txStats.spentThisWeek.toString(),
        monthWei: monthlyStats?.spentThisMonth ?? "0",
      },
      realtime: {
        enabled: realtimeEnabled,
        periods: realtimePeriods,
      },
      sponsorship: {
        enabled: sponsorship.enabled,
        provider: sponsorship.provider,
        mode: sponsorship.mode,
        circuitBreakerEnabled: sponsorship.circuitBreakerEnabled,
      },
    },
  });
});

// ─── Agent account aggregation ───────────────────────────────────────────────

async function getAgentAccountAggregation(
  c: Context<{ Variables: AppVariables }>,
) {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  if (!tenantId) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant id required" }, 400);
  }
  const requestedAgentId = c.req.param("agentId");
  if (!requestedAgentId) {
    return c.json<ApiResponse>(
      { ok: false, error: "agentId is required" },
      400,
    );
  }
  const agentId: string = requestedAgentId;
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const chainId = parseOptionalChainId(c.req.query("chainId"));
  if (typeof chainId === "string") {
    return c.json<ApiResponse>({ ok: false, error: chainId }, 400);
  }
  const tokensParam = c.req.query("tokens");
  const customTokens = parseCustomTokenList(tokensParam);
  if (typeof customTokens === "string") {
    return c.json<ApiResponse>({ ok: false, error: customTokens }, 400);
  }

  const [
    walletRows,
    txStats,
    monthlyStats,
    balanceResult,
    tokenBalancesResult,
    gasSponsorshipConfig,
  ] = await Promise.all([
    db
      .select({
        id: agentWallets.id,
        chainFamily: agentWallets.chainFamily,
        address: agentWallets.address,
        venue: agentWallets.venue,
        purpose: agentWallets.purpose,
        metadata: agentWallets.metadata,
        createdAt: agentWallets.createdAt,
      })
      .from(agentWallets)
      .where(eq(agentWallets.agentId, agentId)),
    getTransactionStats(agentId),
    db
      .select({
        spentThisMonth: sql<string>`coalesce(sum((${transactions.value})::numeric), 0)::text`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.agentId, agentId),
          gte(transactions.createdAt, new Date(Date.now() - 30 * 86400_000)),
          sql`${transactions.status} in ('signed', 'broadcast', 'confirmed')`,
        ),
      ),
    vault.getBalance(tenantId, agentId, chainId).catch((error: unknown) => ({
      unavailable: true as const,
      reason: sanitizeErrorMessage(error),
    })),
    vault
      .getTokenBalances(tenantId, agentId, chainId, customTokens)
      .catch((error: unknown) => ({
        unavailable: true as const,
        reason: sanitizeErrorMessage(error),
      })),
    readTenantGasSponsorshipConfig(tenantId),
  ]);
  const sponsorship = publicGasSponsorshipState(gasSponsorshipConfig);

  const wallets = agentWalletRowsToAccountWallets(agent, walletRows);
  const addresses = wallets.reduce<Record<string, string>>((acc, wallet) => {
    acc[wallet.chainFamily] = wallet.address;
    return acc;
  }, {});
  const portfolioChainId =
    "unavailable" in balanceResult ? (chainId ?? null) : balanceResult.chainId;
  const nativeAsset: PortfolioAsset | null =
    "unavailable" in balanceResult
      ? null
      : await (async () => {
          const balance = balanceResult.native.toString();
          const usdPrice = await priceOracle.getNativeUsdPrice(
            balanceResult.chainId,
          );
          const usdValue = await priceOracle.weiToUsd(
            balance,
            balanceResult.chainId,
          );
          return {
            token: "native",
            symbol: balanceResult.symbol,
            balance,
            formatted: balanceResult.nativeFormatted,
            decimals: 18,
            usdPrice,
            usdValue,
            usdPriceText: priceToScaledText(usdPrice),
            usdValueText: tokenAmountUsdText(balance, 18, usdPrice),
          };
        })();
  const tokenAssets: PortfolioAsset[] =
    "unavailable" in tokenBalancesResult
      ? []
      : await Promise.all(
          tokenBalancesResult.map(async (token) => {
            const usdPrice =
              portfolioChainId === null
                ? null
                : await priceOracle.getTokenUsdPrice(
                    portfolioChainId,
                    token.token,
                  );
            const usdValue =
              portfolioChainId === null
                ? null
                : await priceOracle.weiToUsd(
                    token.balance,
                    portfolioChainId,
                    token.token,
                  );
            return {
              token: token.token,
              symbol: token.symbol,
              balance: token.balance,
              formatted: token.formatted,
              decimals: token.decimals,
              usdPrice,
              usdValue,
              usdPriceText: priceToScaledText(usdPrice),
              usdValueText: tokenAmountUsdText(
                token.balance,
                token.decimals,
                usdPrice,
              ),
            };
          }),
        );
  const portfolioUnavailableReasons = [
    "unavailable" in balanceResult ? balanceResult.reason : null,
    "unavailable" in tokenBalancesResult ? tokenBalancesResult.reason : null,
  ].filter((reason): reason is string => Boolean(reason));
  const totalUsd = sumNullableUsd([
    nativeAsset?.usdValue ?? null,
    ...tokenAssets.map((token) => token.usdValue),
  ]);
  const totalUsdText = sumUsdText([
    nativeAsset?.usdValueText ?? null,
    ...tokenAssets.map((token) => token.usdValueText),
  ]);

  return c.json<ApiResponse>({
    ok: true,
    data: {
      id: agentId,
      type: "agent",
      agentId,
      tenantId,
      name: agent.name,
      walletAddress: agent.walletAddress,
      walletAddresses: addresses,
      wallets,
      balances:
        "unavailable" in balanceResult
          ? {
              evm: null,
              unavailableReason: balanceResult.reason,
            }
          : {
              evm: {
                native: balanceResult.native.toString(),
                nativeFormatted: balanceResult.nativeFormatted,
                chainId: balanceResult.chainId,
                symbol: balanceResult.symbol,
                walletAddress: balanceResult.walletAddress,
              },
            },
      portfolio: {
        chainId: portfolioChainId,
        walletAddress:
          "unavailable" in balanceResult
            ? agent.walletAddress
            : balanceResult.walletAddress,
        native: nativeAsset,
        tokens: tokenAssets,
        totalUsd,
        totalUsdText,
        ...(portfolioUnavailableReasons.length > 0
          ? { unavailableReason: portfolioUnavailableReasons.join("; ") }
          : {}),
      },
      spend: {
        todayWei: txStats.spentToday.toString(),
        weekWei: txStats.spentThisWeek.toString(),
        monthWei: monthlyStats[0]?.spentThisMonth ?? "0",
      },
      capabilities: ACCOUNT_CAPABILITIES,
      sponsorship: {
        enabled: sponsorship.enabled,
        provider: sponsorship.provider,
        mode: sponsorship.mode,
        circuitBreakerEnabled: sponsorship.circuitBreakerEnabled,
      },
      createdAt: agent.createdAt,
    },
  });
}

agentRoutes.get("/:agentId/account", getAgentAccountAggregation);

agentRoutes.get("/:agentId/aggregation", getAgentAccountAggregation);

// ─── Agent owners and delegated signers ──────────────────────────────────────

agentRoutes.get("/:agentId/signers", async (c) => {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Signer inventory requires owner or admin session" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const status = c.req.query("status");
  if (status && !AGENT_SIGNER_STATUSES.has(status)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid signer status filter" },
      400,
    );
  }

  const conditions = [
    eq(agentSigners.tenantId, tenantId),
    eq(agentSigners.agentId, agentId),
  ];
  if (status) conditions.push(eq(agentSigners.status, status));
  const rows = await db
    .select()
    .from(agentSigners)
    .where(and(...conditions))
    .orderBy(agentSigners.createdAt);

  return c.json<ApiResponse>({
    ok: true,
    data: { signers: rows.map(toAgentSignerResponse) },
  });
});

agentRoutes.post("/:agentId/signers", async (c) => {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Signer creation requires owner or admin session" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const body = await safeJsonParse<Record<string, unknown>>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (
    body.credentialSecret !== undefined &&
    body.credentialSecret !== null &&
    body.credentialSecret !== ""
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "credentialSecret is server-generated; use issueCredential=true",
      },
      400,
    );
  }

  const mfaResponse = requireRecentAdminMfa(c, "Signer creation");
  if (mfaResponse) return mfaResponse;

  let signerType: string;
  let subjectType: string;
  let subjectId: string;
  let keyType: string;
  let publicKey: string | null;
  let address: string | null;
  let chainFamily: "evm" | "solana" | null;
  let label: string | null;
  let permissions: string[];
  let policyIds: string[];
  let metadata: Record<string, unknown>;
  let credentialSecret: string | null;
  try {
    signerType = normalizeRequiredText(body.signerType, "signerType", 32);
    subjectType = normalizeRequiredText(body.subjectType, "subjectType", 32);
    subjectId = normalizeRequiredText(body.subjectId, "subjectId", 255);
    if (!AGENT_SIGNER_TYPES.has(signerType)) {
      throw new Error(
        "signerType must be one of: owner, delegated, service, quorum_member",
      );
    }
    if (!AGENT_SIGNER_SUBJECT_TYPES.has(subjectType)) {
      throw new Error(
        "subjectType must be one of: user, wallet, api_key, external",
      );
    }
    keyType =
      body.keyType === undefined || body.keyType === null
        ? "hmac"
        : normalizeRequiredText(body.keyType, "keyType", 16);
    if (!AGENT_SIGNER_KEY_TYPES.has(keyType)) {
      throw new Error("keyType must be one of: hmac, p256");
    }
    publicKey = normalizeOptionalText(body.publicKey, "publicKey", 16_384);
    if (keyType === "p256") {
      if (!publicKey)
        throw new Error("publicKey is required when keyType is p256");
      if (!(await importP256PublicKey(publicKey))) {
        throw new Error("publicKey must be a valid P-256 public key");
      }
      if (body.issueCredential === true) {
        throw new Error("issueCredential is only supported for hmac signers");
      }
    } else if (publicKey) {
      throw new Error("publicKey is only supported when keyType is p256");
    }
    address = normalizeOptionalText(body.address, "address", 128);
    if (
      address &&
      !/^0x[a-fA-F0-9]{40}$/.test(address) &&
      !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(address)
    ) {
      throw new Error("address must be an EVM or Solana address");
    }
    chainFamily =
      body.chainFamily === undefined || body.chainFamily === null
        ? null
        : body.chainFamily === "evm" || body.chainFamily === "solana"
          ? body.chainFamily
          : (() => {
              throw new Error("chainFamily must be evm or solana");
            })();
    label = normalizeOptionalText(body.label, "label", 255);
    permissions = normalizeSignerPermissions(body.permissions);
    policyIds = normalizeSignerPolicyIds(body.policyIds);
    await validateSignerPolicyIdsForAgent(agentId, policyIds);
    metadata = normalizeSignerMetadata(body.metadata);
    credentialSecret =
      body.issueCredential === true ? createSignerSecret() : null;
  } catch (error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Invalid signer payload",
      },
      400,
    );
  }

  const [existingSigner] = await db
    .select({ id: agentSigners.id })
    .from(agentSigners)
    .where(
      and(
        eq(agentSigners.tenantId, tenantId),
        eq(agentSigners.agentId, agentId),
        eq(agentSigners.subjectType, subjectType),
        eq(agentSigners.subjectId, subjectId),
      ),
    );
  if (existingSigner) {
    return c.json<ApiResponse>(
      { ok: false, error: "Signer already exists for this agent and subject" },
      409,
    );
  }

  await writeAgentAudit(c, {
    tenantId,
    action: "agent.signer.create.authorized",
    resourceType: "agent",
    resourceId: agentId,
    metadata: { signerType, subjectType, subjectId, permissions, policyIds },
  });

  try {
    const storedMetadata = {
      ...metadata,
      ...(credentialSecret
        ? {
            credentialHash: await createSignerCredentialHash(credentialSecret),
            credentialCreatedAt: new Date().toISOString(),
          }
        : {}),
    };
    const [row] = await db
      .insert(agentSigners)
      .values({
        tenantId,
        agentId,
        signerType,
        subjectType,
        subjectId,
        keyType,
        publicKey,
        address,
        chainFamily,
        label,
        permissions,
        policyIds,
        metadata: storedMetadata,
        status: "active",
        createdBy: c.get("userId") ?? c.get("authType") ?? null,
      })
      .returning();

    try {
      await writeAgentAudit(c, {
        tenantId,
        action: "agent.signer.create",
        resourceType: "agent_signer",
        resourceId: row.id,
        metadata: { agentId, signerType, subjectType, subjectId },
      });
    } catch (error) {
      await deleteAgentSignerRow(row.id);
      throw error;
    }

    if (credentialSecret) {
      c.header("Cache-Control", "no-store, max-age=0");
      c.header("Pragma", "no-cache");
      c.header("Expires", "0");
    }
    return c.json<ApiResponse>(
      {
        ok: true,
        data: {
          ...toAgentSignerResponse(row),
          ...(credentialSecret ? { credentialSecret } : {}),
        },
      },
      201,
    );
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    const duplicateSigner =
      message.includes("agent_signers_agent_subject_idx") ||
      message.toLowerCase().includes("duplicate key") ||
      message.toLowerCase().includes("unique constraint");
    return c.json<ApiResponse>(
      {
        ok: false,
        error: duplicateSigner
          ? "Signer already exists for this agent and subject"
          : message,
      },
      duplicateSigner ? 409 : 500,
    );
  }
});

agentRoutes.patch("/:agentId/signers/:signerId", async (c) => {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Signer updates require owner or admin session" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const signerId = c.req.param("signerId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const [existingSigner] = await db
    .select()
    .from(agentSigners)
    .where(
      and(
        eq(agentSigners.id, signerId),
        eq(agentSigners.tenantId, tenantId),
        eq(agentSigners.agentId, agentId),
      ),
    );
  if (!existingSigner)
    return c.json<ApiResponse>({ ok: false, error: "Signer not found" }, 404);

  const body = await safeJsonParse<Record<string, unknown>>(c);
  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  const updates: Partial<typeof agentSigners.$inferInsert> = {};
  let privilegedSignerUpdate = false;
  try {
    if (body.signerType !== undefined) {
      const signerType = normalizeRequiredText(
        body.signerType,
        "signerType",
        32,
      );
      if (!AGENT_SIGNER_TYPES.has(signerType)) {
        throw new Error(
          "signerType must be one of: owner, delegated, service, quorum_member",
        );
      }
      if (signerType !== existingSigner.signerType)
        privilegedSignerUpdate = true;
      updates.signerType = signerType;
    }
    const nextKeyType =
      body.keyType === undefined
        ? existingSigner.keyType
        : normalizeRequiredText(body.keyType, "keyType", 16);
    if (!AGENT_SIGNER_KEY_TYPES.has(nextKeyType)) {
      throw new Error("keyType must be one of: hmac, p256");
    }
    const nextPublicKey =
      body.publicKey === undefined
        ? existingSigner.publicKey
        : normalizeOptionalText(body.publicKey, "publicKey", 16_384);
    if (body.keyType !== undefined || body.publicKey !== undefined) {
      if (nextKeyType === "p256") {
        if (!nextPublicKey)
          throw new Error("publicKey is required when keyType is p256");
        if (!(await importP256PublicKey(nextPublicKey))) {
          throw new Error("publicKey must be a valid P-256 public key");
        }
      } else if (nextPublicKey) {
        throw new Error("publicKey is only supported when keyType is p256");
      }
      if (nextKeyType !== existingSigner.keyType) {
        privilegedSignerUpdate = true;
        updates.keyType = nextKeyType;
      }
      if ((nextPublicKey ?? null) !== (existingSigner.publicKey ?? null)) {
        privilegedSignerUpdate = true;
        updates.publicKey = nextPublicKey;
      }
    }
    if (body.address !== undefined) {
      const address = normalizeOptionalText(body.address, "address", 128);
      if (
        address &&
        !/^0x[a-fA-F0-9]{40}$/.test(address) &&
        !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(address)
      ) {
        throw new Error("address must be an EVM or Solana address");
      }
      // Re-pointing the resolvable address of an active signer is functionally
      // credential takeover for any flow that resolves authority through
      // agentSigners.address, so this needs the same recent-MFA gate as a
      // permissions/status change. Matches the key-quorum PATCH model.
      if ((address ?? null) !== (existingSigner.address ?? null))
        privilegedSignerUpdate = true;
      updates.address = address;
    }
    if (body.chainFamily !== undefined) {
      const chainFamily =
        body.chainFamily === null
          ? null
          : body.chainFamily === "evm" || body.chainFamily === "solana"
            ? body.chainFamily
            : (() => {
                throw new Error("chainFamily must be evm or solana");
              })();
      if ((chainFamily ?? null) !== (existingSigner.chainFamily ?? null)) {
        privilegedSignerUpdate = true;
      }
      updates.chainFamily = chainFamily;
    }
    if (body.label !== undefined)
      updates.label = normalizeOptionalText(body.label, "label", 255);
    if (body.permissions !== undefined) {
      privilegedSignerUpdate = true;
      updates.permissions = normalizeSignerPermissions(body.permissions);
    }
    if (body.policyIds !== undefined) {
      privilegedSignerUpdate = true;
      const policyIds = normalizeSignerPolicyIds(body.policyIds);
      await validateSignerPolicyIdsForAgent(agentId, policyIds);
      updates.policyIds = policyIds;
    }
    if (body.metadata !== undefined) {
      privilegedSignerUpdate = true;
      updates.metadata = mergeSignerMetadataPreservingReserved(
        existingSigner.metadata,
        normalizeSignerMetadata(body.metadata),
      );
    }
    if (body.status !== undefined) {
      const status = normalizeRequiredText(body.status, "status", 32);
      if (!AGENT_SIGNER_STATUSES.has(status)) {
        throw new Error("status must be one of: active, paused, revoked");
      }
      if (status !== existingSigner.status) privilegedSignerUpdate = true;
      updates.status = status;
    }
  } catch (error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Invalid signer update",
      },
      400,
    );
  }

  if (Object.keys(updates).length === 0) {
    return c.json<ApiResponse>(
      { ok: false, error: "No signer updates provided" },
      400,
    );
  }
  // Single MFA gate for any privileged field change, mirroring the key-quorum PATCH
  // handler. Cosmetic-only updates (label) are exempt; everything that affects
  // signer authority requires a recent step-up.
  if (privilegedSignerUpdate) {
    const mfaResponse = requireRecentAdminMfa(c, "Signer updates");
    if (mfaResponse) return mfaResponse;
  }

  await writeAgentAudit(c, {
    tenantId,
    action: "agent.signer.update.authorized",
    resourceType: "agent_signer",
    resourceId: signerId,
    metadata: { agentId, fields: Object.keys(updates) },
  });

  const [row] = await db
    .update(agentSigners)
    .set(updates)
    .where(
      and(
        eq(agentSigners.id, signerId),
        eq(agentSigners.tenantId, tenantId),
        eq(agentSigners.agentId, agentId),
      ),
    )
    .returning();

  if (!row)
    return c.json<ApiResponse>({ ok: false, error: "Signer not found" }, 404);

  try {
    await writeAgentAudit(c, {
      tenantId,
      action: "agent.signer.update",
      resourceType: "agent_signer",
      resourceId: row.id,
      metadata: { agentId, status: row.status },
    });
  } catch (error) {
    await restoreAgentSigner(existingSigner);
    throw error;
  }

  return c.json<ApiResponse>({ ok: true, data: toAgentSignerResponse(row) });
});

agentRoutes.delete("/:agentId/signers/:signerId", async (c) => {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Signer revocation requires owner or admin session" },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(c, "Signer revocation");
  if (mfaResponse) return mfaResponse;
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const signerId = c.req.param("signerId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }
  const [existingSigner] = await db
    .select()
    .from(agentSigners)
    .where(
      and(
        eq(agentSigners.id, signerId),
        eq(agentSigners.tenantId, tenantId),
        eq(agentSigners.agentId, agentId),
      ),
    );
  if (!existingSigner)
    return c.json<ApiResponse>({ ok: false, error: "Signer not found" }, 404);

  await writeAgentAudit(c, {
    tenantId,
    action: "agent.signer.revoke.authorized",
    resourceType: "agent_signer",
    resourceId: signerId,
    metadata: { agentId },
  });

  const [row] = await db
    .update(agentSigners)
    .set({ status: "revoked" })
    .where(
      and(
        eq(agentSigners.id, signerId),
        eq(agentSigners.tenantId, tenantId),
        eq(agentSigners.agentId, agentId),
      ),
    )
    .returning();

  if (!row)
    return c.json<ApiResponse>({ ok: false, error: "Signer not found" }, 404);

  try {
    await writeAgentAudit(c, {
      tenantId,
      action: "agent.signer.revoke",
      resourceType: "agent_signer",
      resourceId: row.id,
      metadata: { agentId },
    });
  } catch (error) {
    await restoreAgentSigner(existingSigner);
    throw error;
  }

  return c.json<ApiResponse>({ ok: true, data: toAgentSignerResponse(row) });
});

// ─── Agent signing freeze (kill-switch) ──────────────────────────────────────

function freezeActor(c: Parameters<typeof requireTenantLevel>[0]): {
  createdByType: string;
  createdById: string;
} {
  const authType = c.get("authType");
  if (authType === "api-key") {
    return { createdByType: "api-key", createdById: c.get("tenantId") };
  }
  return {
    createdByType: "user",
    createdById: c.get("userId") ?? authType ?? c.get("tenantId"),
  };
}

function normalizeFreezeReason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("reason must be a string");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 1024)
    throw new Error("reason cannot exceed 1024 characters");
  return trimmed;
}

/**
 * POST /:agentId/freeze
 * Atomic, fail-closed kill-switch: halts ALL signing for this agent's wallets at
 * the vault chokepoint (checked before key decryption). Owner/admin + recent MFA.
 */
agentRoutes.post("/:agentId/freeze", async (c) => {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Freezing an agent requires owner or admin session" },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(c, "Agent freeze");
  if (mfaResponse) return mfaResponse;

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);

  let reason: string | null;
  try {
    const body = await safeJsonParse<{ reason?: unknown }>(c);
    reason = normalizeFreezeReason(body?.reason);
  } catch (error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Invalid freeze request",
      },
      400,
    );
  }

  // Idempotent: if an active agent freeze already exists, return it unchanged
  // rather than violating the partial unique index.
  const [existing] = await db
    .select({ id: vaultSigningFreezes.id })
    .from(vaultSigningFreezes)
    .where(
      and(
        eq(vaultSigningFreezes.tenantId, tenantId),
        eq(vaultSigningFreezes.scopeType, "agent"),
        eq(vaultSigningFreezes.agentId, agentId),
        isNull(vaultSigningFreezes.liftedAt),
      ),
    )
    .limit(1);

  if (existing) {
    return c.json<ApiResponse>({
      ok: true,
      data: {
        agentId,
        scopeType: "agent",
        signingState: "frozen",
        freezeId: existing.id,
      },
    });
  }

  const actor = freezeActor(c);
  const [row] = await db
    .insert(vaultSigningFreezes)
    .values({
      tenantId,
      scopeType: "agent",
      agentId,
      reason,
      createdByType: actor.createdByType,
      createdById: actor.createdById,
    })
    .returning({ id: vaultSigningFreezes.id });

  await writeAgentAudit(c, {
    tenantId,
    action: "agent.freeze",
    resourceType: "agent",
    resourceId: agentId,
    metadata: { freezeId: row.id, scopeType: "agent", reason },
  });

  dispatchWebhook(tenantId, agentId, "wallet.frozen", {
    agent_id: agentId,
    wallet_id: agentId,
    scope_type: "agent",
    freeze_id: row.id,
    reason,
  });

  return c.json<ApiResponse>({
    ok: true,
    data: {
      agentId,
      scopeType: "agent",
      signingState: "frozen",
      freezeId: row.id,
    },
  });
});

/**
 * POST /:agentId/unfreeze
 * Lifts the active agent-scoped signing freeze, restoring signing. Owner/admin +
 * recent MFA.
 */
agentRoutes.post("/:agentId/unfreeze", async (c) => {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Unfreezing an agent requires owner or admin session",
      },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(c, "Agent unfreeze");
  if (mfaResponse) return mfaResponse;

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);

  const actor = freezeActor(c);
  const lifted = await db
    .update(vaultSigningFreezes)
    .set({
      liftedAt: sql`now()`,
      liftedByType: actor.createdByType,
      liftedById: actor.createdById,
    })
    .where(
      and(
        eq(vaultSigningFreezes.tenantId, tenantId),
        eq(vaultSigningFreezes.scopeType, "agent"),
        eq(vaultSigningFreezes.agentId, agentId),
        isNull(vaultSigningFreezes.liftedAt),
      ),
    )
    .returning({ id: vaultSigningFreezes.id });

  if (lifted.length === 0) {
    return c.json<ApiResponse>({
      ok: true,
      data: {
        agentId,
        scopeType: "agent",
        signingState: "active",
        freezeId: null,
      },
    });
  }

  await writeAgentAudit(c, {
    tenantId,
    action: "agent.unfreeze",
    resourceType: "agent",
    resourceId: agentId,
    metadata: { freezeId: lifted[0].id, scopeType: "agent" },
  });

  dispatchWebhook(tenantId, agentId, "wallet.unfrozen", {
    agent_id: agentId,
    wallet_id: agentId,
    scope_type: "agent",
    freeze_id: lifted[0].id,
  });

  return c.json<ApiResponse>({
    ok: true,
    data: {
      agentId,
      scopeType: "agent",
      signingState: "active",
      freezeId: lifted[0].id,
    },
  });
});

// ─── Agent key quorums ───────────────────────────────────────────────────────

agentRoutes.get("/:agentId/key-quorums", async (c) => {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Key quorum inventory requires owner or admin session",
      },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);

  const status = c.req.query("status");
  if (status && !AGENT_KEY_QUORUM_STATUSES.has(status)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid key quorum status filter" },
      400,
    );
  }
  const conditions = [
    eq(agentKeyQuorums.tenantId, tenantId),
    eq(agentKeyQuorums.agentId, agentId),
  ];
  if (status) conditions.push(eq(agentKeyQuorums.status, status));
  const rows = await db
    .select()
    .from(agentKeyQuorums)
    .where(and(...conditions))
    .orderBy(agentKeyQuorums.createdAt);

  return c.json<ApiResponse>({
    ok: true,
    data: { quorums: rows.map(toAgentKeyQuorumResponse) },
  });
});

agentRoutes.post("/:agentId/key-quorums", async (c) => {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Key quorum creation requires owner or admin session",
      },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(c, "Key quorum creation");
  if (mfaResponse) return mfaResponse;
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);

  const body = await safeJsonParse<Record<string, unknown>>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );

  let name: string;
  let threshold: number;
  let memberSignerIds: string[];
  let memberQuorumIds: string[];
  let permissions: string[];
  let metadata: Record<string, unknown>;
  try {
    name = normalizeRequiredText(body.name, "name", 255);
    memberSignerIds = normalizeQuorumMemberSignerIds(body.memberSignerIds);
    memberQuorumIds = normalizeOptionalQuorumMemberIds(
      body.memberQuorumIds,
      "memberQuorumIds",
    );
    if (memberSignerIds.length + memberQuorumIds.length === 0) {
      throw new Error(
        "key quorum must include at least one signer or child quorum",
      );
    }
    threshold = normalizeQuorumThreshold(
      body.threshold,
      memberSignerIds.length + memberQuorumIds.length,
    );
    permissions = normalizeSignerPermissions(body.permissions);
    metadata = normalizeSignerMetadata(body.metadata);
  } catch (error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Invalid key quorum payload",
      },
      400,
    );
  }
  const memberError = await validateQuorumMembers(
    tenantId,
    agentId,
    memberSignerIds,
    memberQuorumIds,
  );
  if (memberError)
    return c.json<ApiResponse>({ ok: false, error: memberError }, 400);

  await writeAgentAudit(c, {
    tenantId,
    action: "agent.key_quorum.create.authorized",
    resourceType: "agent_key_quorum",
    resourceId: agentId,
    metadata: {
      agentId,
      name,
      threshold,
      memberSignerIds,
      memberQuorumIds,
      permissions,
    },
  });

  const [row] = await db
    .insert(agentKeyQuorums)
    .values({
      tenantId,
      agentId,
      name,
      threshold,
      memberSignerIds,
      memberQuorumIds,
      permissions,
      metadata,
      status: "active",
      createdBy: c.get("userId") ?? c.get("authType") ?? null,
    })
    .returning();

  try {
    await writeAgentAudit(c, {
      tenantId,
      action: "agent.key_quorum.create",
      resourceType: "agent_key_quorum",
      resourceId: row.id,
      metadata: { agentId, threshold, memberSignerIds, memberQuorumIds },
    });
  } catch (error) {
    await deleteAgentKeyQuorumRow(row.id);
    throw error;
  }

  return c.json<ApiResponse>(
    { ok: true, data: toAgentKeyQuorumResponse(row) },
    201,
  );
});

agentRoutes.patch("/:agentId/key-quorums/:quorumId", async (c) => {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Key quorum updates require owner or admin session" },
      403,
    );
  }
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const quorumId = c.req.param("quorumId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);

  const [existing] = await db
    .select()
    .from(agentKeyQuorums)
    .where(
      and(
        eq(agentKeyQuorums.id, quorumId),
        eq(agentKeyQuorums.tenantId, tenantId),
        eq(agentKeyQuorums.agentId, agentId),
      ),
    );
  if (!existing)
    return c.json<ApiResponse>(
      { ok: false, error: "Key quorum not found" },
      404,
    );

  const body = await safeJsonParse<Record<string, unknown>>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );

  const updates: Partial<typeof agentKeyQuorums.$inferInsert> = {};
  let privilegedUpdate = false;
  try {
    if (body.name !== undefined)
      updates.name = normalizeRequiredText(body.name, "name", 255);
    const nextMemberSignerIds =
      body.memberSignerIds === undefined
        ? existing.memberSignerIds
        : normalizeQuorumMemberSignerIds(body.memberSignerIds);
    const nextMemberQuorumIds =
      body.memberQuorumIds === undefined
        ? existing.memberQuorumIds
        : normalizeOptionalQuorumMemberIds(
            body.memberQuorumIds,
            "memberQuorumIds",
          );
    if (body.memberSignerIds !== undefined) {
      updates.memberSignerIds = nextMemberSignerIds;
      privilegedUpdate = true;
    }
    if (body.memberQuorumIds !== undefined) {
      updates.memberQuorumIds = nextMemberQuorumIds;
      privilegedUpdate = true;
    }
    if (body.threshold !== undefined) {
      updates.threshold = normalizeQuorumThreshold(
        body.threshold,
        nextMemberSignerIds.length + nextMemberQuorumIds.length,
      );
      privilegedUpdate = true;
    } else if (
      (body.memberSignerIds !== undefined ||
        body.memberQuorumIds !== undefined) &&
      existing.threshold >
        nextMemberSignerIds.length + nextMemberQuorumIds.length
    ) {
      throw new Error("threshold cannot exceed member count");
    }
    if (body.permissions !== undefined) {
      updates.permissions = normalizeSignerPermissions(body.permissions);
      privilegedUpdate = true;
    }
    if (body.metadata !== undefined)
      updates.metadata = normalizeSignerMetadata(body.metadata);
    if (body.status !== undefined) {
      const status = normalizeRequiredText(body.status, "status", 32);
      if (!AGENT_KEY_QUORUM_STATUSES.has(status)) {
        throw new Error("status must be one of: active, paused, revoked");
      }
      updates.status = status;
      if (status !== existing.status) privilegedUpdate = true;
    }
    if (
      body.memberSignerIds !== undefined ||
      body.memberQuorumIds !== undefined
    ) {
      if (nextMemberSignerIds.length + nextMemberQuorumIds.length === 0) {
        throw new Error(
          "key quorum must include at least one signer or child quorum",
        );
      }
      const memberError = await validateQuorumMembers(
        tenantId,
        agentId,
        nextMemberSignerIds,
        nextMemberQuorumIds,
        quorumId,
      );
      if (memberError) throw new Error(memberError);
    }
  } catch (error) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Invalid key quorum update",
      },
      400,
    );
  }

  if (Object.keys(updates).length === 0) {
    return c.json<ApiResponse>(
      { ok: false, error: "No key quorum updates provided" },
      400,
    );
  }
  if (privilegedUpdate) {
    const mfaResponse = requireRecentAdminMfa(
      c,
      "Key quorum privilege updates",
    );
    if (mfaResponse) return mfaResponse;
  }

  await writeAgentAudit(c, {
    tenantId,
    action: "agent.key_quorum.update.authorized",
    resourceType: "agent_key_quorum",
    resourceId: quorumId,
    metadata: { agentId, fields: Object.keys(updates) },
  });

  const [row] = await db
    .update(agentKeyQuorums)
    .set({ ...updates, updatedAt: new Date() })
    .where(
      and(
        eq(agentKeyQuorums.id, quorumId),
        eq(agentKeyQuorums.tenantId, tenantId),
        eq(agentKeyQuorums.agentId, agentId),
      ),
    )
    .returning();

  try {
    await writeAgentAudit(c, {
      tenantId,
      action: "agent.key_quorum.update",
      resourceType: "agent_key_quorum",
      resourceId: row.id,
      metadata: { agentId, status: row.status },
    });
  } catch (error) {
    await restoreAgentKeyQuorum(existing);
    throw error;
  }

  return c.json<ApiResponse>({ ok: true, data: toAgentKeyQuorumResponse(row) });
});

agentRoutes.delete("/:agentId/key-quorums/:quorumId", async (c) => {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Key quorum revocation requires owner or admin session",
      },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(c, "Key quorum revocation");
  if (mfaResponse) return mfaResponse;
  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const quorumId = c.req.param("quorumId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  const [existing] = await db
    .select()
    .from(agentKeyQuorums)
    .where(
      and(
        eq(agentKeyQuorums.id, quorumId),
        eq(agentKeyQuorums.tenantId, tenantId),
        eq(agentKeyQuorums.agentId, agentId),
      ),
    );
  if (!existing)
    return c.json<ApiResponse>(
      { ok: false, error: "Key quorum not found" },
      404,
    );

  await writeAgentAudit(c, {
    tenantId,
    action: "agent.key_quorum.revoke.authorized",
    resourceType: "agent_key_quorum",
    resourceId: quorumId,
    metadata: { agentId },
  });

  const [row] = await db
    .update(agentKeyQuorums)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(
      and(
        eq(agentKeyQuorums.id, quorumId),
        eq(agentKeyQuorums.tenantId, tenantId),
        eq(agentKeyQuorums.agentId, agentId),
      ),
    )
    .returning();
  if (!row)
    return c.json<ApiResponse>(
      { ok: false, error: "Key quorum not found" },
      404,
    );

  try {
    await writeAgentAudit(c, {
      tenantId,
      action: "agent.key_quorum.revoke",
      resourceType: "agent_key_quorum",
      resourceId: row.id,
      metadata: { agentId },
    });
  } catch (error) {
    await restoreAgentKeyQuorum(existing);
    throw error;
  }

  return c.json<ApiResponse>({ ok: true, data: toAgentKeyQuorumResponse(row) });
});

// ─── Batch create agents ──────────────────────────────────────────────────────

export async function createAgentBatch(
  c: Context<{ Variables: AppVariables }>,
) {
  if (!requireTenantAdminOrApiKey(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Batch agent creation requires owner or admin session",
      },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(c, "Batch agent creation");
  if (mfaResponse) return mfaResponse;

  const tenantId = c.get("tenantId");
  const body = await safeJsonParse<{
    agents?: Array<{
      id?: string;
      name: string;
      platformId?: string;
      externalId?: string;
    }>;
    wallets?: Array<{
      id?: string;
      name: string;
      platformId?: string;
      externalId?: string;
    }>;
    applyPolicies?: PolicyRule[];
  }>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }
  const requestedAgents = body.agents ?? body.wallets;
  if (!Array.isArray(requestedAgents) || requestedAgents.length === 0) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "agents or wallets array is required and must not be empty",
      },
      400,
    );
  }
  const normalizedAgents = requestedAgents.map(
    ({ externalId, platformId, ...agent }) => ({
      ...agent,
      platformId: platformId ?? externalId,
    }),
  );
  if (normalizedAgents.length > MAX_BATCH_AGENTS) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `agents array cannot contain more than ${MAX_BATCH_AGENTS} agents`,
      },
      400,
    );
  }

  for (const agentSpec of normalizedAgents) {
    if (agentSpec.id !== undefined && !isValidAgentId(agentSpec.id)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `Invalid agent id "${String(agentSpec.id)}" — must be 1-128 alphanumeric characters (plus _ - . :)`,
        },
        400,
      );
    }
    if (!isNonEmptyString(agentSpec.name)) {
      return c.json<ApiResponse>(
        { ok: false, error: `Agent "${agentSpec.id}" is missing a name` },
        400,
      );
    }
  }
  if (body.applyPolicies !== undefined) {
    if (!Array.isArray(body.applyPolicies)) {
      return c.json<ApiResponse>(
        { ok: false, error: "applyPolicies must be an array" },
        400,
      );
    }
    if (body.applyPolicies.length > MAX_POLICIES_PER_AGENT) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: `applyPolicies cannot contain more than ${MAX_POLICIES_PER_AGENT}`,
        },
        400,
      );
    }
    const policyValidationError = getPolicyRulesValidationError(
      body.applyPolicies,
    );
    if (policyValidationError) {
      return c.json<ApiResponse>(
        { ok: false, error: policyValidationError },
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

  const created: AgentIdentity[] = [];
  const errors: Array<{ id: string; error: string }> = [];
  const batchIds = new Set<string>();

  for (const agentSpec of normalizedAgents) {
    const clientReferenceId = agentSpec.id ?? crypto.randomUUID();
    try {
      if (batchIds.has(clientReferenceId)) {
        errors.push({
          id: clientReferenceId,
          error: "Duplicate agent reference id in batch",
        });
        continue;
      }
      batchIds.add(clientReferenceId);
      const agentId = generateAgentId();
      await writeAgentAudit(c, {
        tenantId,
        action: "agent.create.authorized",
        resourceType: "agent",
        resourceId: agentId,
        metadata: {
          name: agentSpec.name,
          requestedId: agentSpec.id ?? null,
          platformId: agentSpec.platformId ?? null,
          batch: true,
          appliedPolicyCount: body.applyPolicies?.length ?? 0,
        },
      });
      let identity: AgentIdentity | null = null;
      identity = await vault.createAgent(
        tenantId,
        agentId,
        agentSpec.name,
        agentSpec.platformId,
      );

      try {
        if (body.applyPolicies && body.applyPolicies.length > 0) {
          const persistedPolicies = body.applyPolicies.map(
            toPersistedPolicyRule,
          );
          await db.transaction(async (tx) => {
            await tx.delete(policies).where(eq(policies.agentId, agentId));
            await tx.insert(policies).values(
              persistedPolicies.map((policy) => ({
                id: crypto.randomUUID(),
                agentId,
                type: policy.type,
                enabled: policy.enabled,
                config: policy.config,
              })),
            );
          });
        }

        created.push(identity);
        await writeAgentAudit(c, {
          tenantId,
          action: "agent.create",
          resourceType: "agent",
          resourceId: agentId,
          metadata: {
            name: agentSpec.name,
            requestedId: agentSpec.id ?? null,
            platformId: agentSpec.platformId ?? null,
            batch: true,
            appliedPolicyCount: body.applyPolicies?.length ?? 0,
          },
        });
      } catch (postCreateError) {
        await deleteAgentRows(agentId, tenantId);
        throw postCreateError;
      }
    } catch (e: unknown) {
      errors.push({
        id: clientReferenceId,
        error:
          e instanceof Error && e.message.includes("already exists")
            ? "Agent id already exists"
            : "Failed to create agent",
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
}

agentRoutes.post("/batch", createAgentBatch);

// ─── Get agent policies ───────────────────────────────────────────────────────

agentRoutes.get("/:agentId/policies", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const agentPolicies = await db
    .select()
    .from(policies)
    .where(eq(policies.agentId, agentId));

  return c.json<ApiResponse<PolicyRule[]>>({
    ok: true,
    data: agentPolicies.map(toPolicyRule),
  });
});

// ─── Update agent policies ────────────────────────────────────────────────────

agentRoutes.put("/:agentId/policies", async (c) => {
  // SEC-209: replacing an agent's vault policy set removes its spend caps —
  // human admin session (API key only via explicit opt-in).
  if (!requireSensitiveMutationPrincipal(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Policy updates require owner or admin session" },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(c, "Policy updates");
  if (mfaResponse) return mfaResponse;

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);

  if (!agent) {
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);
  }

  const nextPolicies = await safeJsonParse<PolicyRule[]>(c);

  if (!nextPolicies || !Array.isArray(nextPolicies)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Request body must be a JSON array of policies" },
      400,
    );
  }

  const policyValidationError = getPolicyRulesValidationError(nextPolicies);
  if (policyValidationError) {
    return c.json<ApiResponse>(
      { ok: false, error: policyValidationError },
      400,
    );
  }
  const conditionSetValidationError =
    await getConditionSetReferenceValidationError(tenantId, nextPolicies);
  if (conditionSetValidationError) {
    return c.json<ApiResponse>(
      { ok: false, error: conditionSetValidationError },
      400,
    );
  }
  if (nextPolicies.length > MAX_POLICIES_PER_AGENT) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `Policy list cannot contain more than ${MAX_POLICIES_PER_AGENT}`,
      },
      400,
    );
  }

  await writeAgentAudit(c, {
    tenantId,
    action: "agent.policies.update.authorized",
    resourceType: "agent",
    resourceId: agentId,
    metadata: {
      count: nextPolicies.length,
      types: nextPolicies.map((policy) => policy.type),
    },
  });

  const previousPolicies = await snapshotAgentPolicies(agentId);
  const storedPolicies = await db.transaction(async (tx) => {
    await tx.delete(policies).where(eq(policies.agentId, agentId));

    if (nextPolicies.length > 0) {
      const persistedPolicies = nextPolicies.map(toPersistedPolicyRule);
      await tx.insert(policies).values(
        persistedPolicies.map((policy) => ({
          id: crypto.randomUUID(),
          agentId,
          type: policy.type,
          enabled: policy.enabled,
          config: policy.config,
        })),
      );
    }

    return tx.select().from(policies).where(eq(policies.agentId, agentId));
  });

  await invalidateAgentPolicyCache(agentId, tenantId);

  try {
    await writeAgentAudit(c, {
      tenantId,
      action: "agent.policies.update",
      resourceType: "agent",
      resourceId: agentId,
      metadata: {
        count: storedPolicies.length,
        types: storedPolicies.map((p) => p.type),
      },
    });
  } catch (error) {
    await restoreAgentPolicies(agentId, previousPolicies);
    throw error;
  }

  return c.json<ApiResponse<PolicyRule[]>>({
    ok: true,
    data: storedPolicies.map(toPolicyRule),
  });
});

// ─── Privy-style nested policy rule CRUD ─────────────────────────────────────

agentRoutes.get("/:agentId/policies/rules", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);

  const rows = await db
    .select()
    .from(policies)
    .where(eq(policies.agentId, agentId));
  return c.json<ApiResponse<{ rules: PolicyRule[] }>>({
    ok: true,
    data: { rules: rows.map(toPolicyRule) },
  });
});

agentRoutes.post("/:agentId/policies/rules", async (c) => {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Policy rule creation requires owner or admin session",
      },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(c, "Policy rule creation");
  if (mfaResponse) return mfaResponse;

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);

  const body = await safeJsonParse<unknown>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );

  let nextRule: PolicyRule;
  try {
    nextRule = { ...normalizePolicyRuleInput(body), id: crypto.randomUUID() };
  } catch (e) {
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      400,
    );
  }

  const currentRules = (
    await db.select().from(policies).where(eq(policies.agentId, agentId))
  ).map(toPolicyRule);
  const nextRules = [...currentRules, nextRule];
  const policyValidationError = getPolicyRulesValidationError(nextRules);
  if (policyValidationError) {
    return c.json<ApiResponse>(
      { ok: false, error: policyValidationError },
      400,
    );
  }
  const conditionSetValidationError =
    await getConditionSetReferenceValidationError(tenantId, nextRules);
  if (conditionSetValidationError) {
    return c.json<ApiResponse>(
      { ok: false, error: conditionSetValidationError },
      400,
    );
  }

  await writeAgentAudit(c, {
    tenantId,
    action: "agent.policy_rule.create.authorized",
    resourceType: "policy_rule",
    resourceId: nextRule.id,
    metadata: { agentId, type: nextRule.type },
  });

  const persistedRule = toPersistedPolicyRule(nextRule);
  await db.insert(policies).values({
    id: persistedRule.id,
    agentId,
    type: persistedRule.type,
    enabled: persistedRule.enabled,
    config: persistedRule.config,
  });

  try {
    await writeAgentAudit(c, {
      tenantId,
      action: "agent.policy_rule.create",
      resourceType: "policy_rule",
      resourceId: nextRule.id,
      metadata: { agentId, type: nextRule.type },
    });
  } catch (error) {
    await db
      .delete(policies)
      .where(and(eq(policies.agentId, agentId), eq(policies.id, nextRule.id)));
    throw error;
  }

  await invalidateAgentPolicyCache(agentId, tenantId);
  return c.json<ApiResponse<PolicyRule>>({ ok: true, data: nextRule }, 201);
});

agentRoutes.get("/:agentId/policies/rules/:ruleId", async (c) => {
  if (!requireAgentAccess(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Forbidden: token scope does not match agent" },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const ruleId = c.req.param("ruleId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);

  const [rule] = await db
    .select()
    .from(policies)
    .where(and(eq(policies.agentId, agentId), eq(policies.id, ruleId)));
  if (!rule)
    return c.json<ApiResponse>(
      { ok: false, error: "Policy rule not found" },
      404,
    );

  return c.json<ApiResponse<PolicyRule>>({
    ok: true,
    data: toPolicyRule(rule),
  });
});

agentRoutes.patch("/:agentId/policies/rules/:ruleId", async (c) => {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Policy rule updates require owner or admin session",
      },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(c, "Policy rule updates");
  if (mfaResponse) return mfaResponse;

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const ruleId = c.req.param("ruleId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);

  const body = await safeJsonParse<unknown>(c);
  if (!body)
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );

  const currentRows = await db
    .select()
    .from(policies)
    .where(eq(policies.agentId, agentId));
  const existing = currentRows.find((rule) => rule.id === ruleId);
  if (!existing)
    return c.json<ApiResponse>(
      { ok: false, error: "Policy rule not found" },
      404,
    );

  let nextRule: PolicyRule;
  try {
    nextRule = normalizePolicyRulePatch(toPolicyRule(existing), body);
  } catch (e) {
    return c.json<ApiResponse>(
      { ok: false, error: sanitizeErrorMessage(e) },
      400,
    );
  }

  const nextRules = currentRows.map((rule) =>
    rule.id === ruleId ? nextRule : toPolicyRule(rule),
  );
  const policyValidationError = getPolicyRulesValidationError(nextRules);
  if (policyValidationError) {
    return c.json<ApiResponse>(
      { ok: false, error: policyValidationError },
      400,
    );
  }
  const conditionSetValidationError =
    await getConditionSetReferenceValidationError(tenantId, nextRules);
  if (conditionSetValidationError) {
    return c.json<ApiResponse>(
      { ok: false, error: conditionSetValidationError },
      400,
    );
  }

  await writeAgentAudit(c, {
    tenantId,
    action: "agent.policy_rule.update.authorized",
    resourceType: "policy_rule",
    resourceId: ruleId,
    metadata: { agentId, type: nextRule.type },
  });

  const persistedRule = toPersistedPolicyRule(nextRule);
  const [updated] = await db
    .update(policies)
    .set({
      type: persistedRule.type,
      enabled: persistedRule.enabled,
      config: persistedRule.config,
      updatedAt: new Date(),
    })
    .where(and(eq(policies.agentId, agentId), eq(policies.id, ruleId)))
    .returning();
  if (!updated)
    return c.json<ApiResponse>(
      { ok: false, error: "Policy rule not found" },
      404,
    );

  try {
    await writeAgentAudit(c, {
      tenantId,
      action: "agent.policy_rule.update",
      resourceType: "policy_rule",
      resourceId: ruleId,
      metadata: { agentId, type: nextRule.type },
    });
  } catch (error) {
    await db
      .update(policies)
      .set({
        type: existing.type,
        enabled: existing.enabled,
        config: existing.config,
        updatedAt: existing.updatedAt,
      })
      .where(and(eq(policies.agentId, agentId), eq(policies.id, ruleId)));
    throw error;
  }

  await invalidateAgentPolicyCache(agentId, tenantId);
  return c.json<ApiResponse<PolicyRule>>({
    ok: true,
    data: toPolicyRule(updated),
  });
});

agentRoutes.delete("/:agentId/policies/rules/:ruleId", async (c) => {
  if (!requireTenantAdminSession(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Policy rule deletion requires owner or admin session",
      },
      403,
    );
  }
  const mfaResponse = requireRecentAdminMfa(c, "Policy rule deletion");
  if (mfaResponse) return mfaResponse;

  const tenantId = c.get("tenantId");
  const agentId = c.req.param("agentId");
  const ruleId = c.req.param("ruleId");
  const agent = await ensureAgentForTenant(tenantId, agentId);
  if (!agent)
    return c.json<ApiResponse>({ ok: false, error: "Agent not found" }, 404);

  await writeAgentAudit(c, {
    tenantId,
    action: "agent.policy_rule.delete.authorized",
    resourceType: "policy_rule",
    resourceId: ruleId,
    metadata: { agentId },
  });

  const [deleted] = await db
    .delete(policies)
    .where(and(eq(policies.agentId, agentId), eq(policies.id, ruleId)))
    .returning();
  if (!deleted)
    return c.json<ApiResponse>(
      { ok: false, error: "Policy rule not found" },
      404,
    );

  try {
    await writeAgentAudit(c, {
      tenantId,
      action: "agent.policy_rule.delete",
      resourceType: "policy_rule",
      resourceId: ruleId,
      metadata: { agentId, type: deleted.type },
    });
  } catch (error) {
    await db.insert(policies).values(deleted);
    throw error;
  }

  await invalidateAgentPolicyCache(agentId, tenantId);
  return c.json<ApiResponse<PolicyRule>>({
    ok: true,
    data: toPolicyRule(deleted),
  });
});
