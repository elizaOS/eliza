/**
 * Per-organization rate limit tier service.
 *
 * Resolves the central subscription entitlement, preserves audited manual
 * overrides as highest authority, and caches a version-fenced inference tier.
 * Which economic credit provenances should qualify remains policy work in
 * #23019; selector keys such as `paid` are not subscription labels.
 */

import { ElizaError } from "@elizaos/core";
import { and, eq, sql } from "drizzle-orm";
import { dbRead } from "../../db/helpers";
import { orgRateLimitOverridesRepository } from "../../db/repositories/org-rate-limit-overrides";
import { subscriptionEntitlementsRepository } from "../../db/repositories/subscription-entitlements";
import { creditTransactions } from "../../db/schemas/credit-transactions";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";
import {
  FREE_SUBSCRIPTION_ENTITLEMENT_LIMITS,
  type LegacyEntitlementSelection,
  type ManualEntitlementOverride,
  type SubscriptionEntitlementProjection,
  type SubscriptionEntitlementResolution,
  SubscriptionEntitlementService,
  type SubscriptionEntitlementSource,
  type SubscriptionEntitlementSources,
} from "./subscription-entitlement-resolver";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EndpointType = "completions" | "embeddings" | "standard" | "strict";

export interface OrgRateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface OrgTierData {
  tierName: string;
  completionsRpm: number;
  embeddingsRpm: number;
  standardRpm: number;
  strictRpm: number;
  catalogVersion: string;
  entitlementVersion: string;
  manualOverrideVersion: string | null;
}

export interface OrgTierOverrideValues {
  completions_rpm: number | null;
  embeddings_rpm: number | null;
  standard_rpm: number | null;
  strict_rpm: number | null;
}

// ---------------------------------------------------------------------------
// Legacy selector thresholds — ordered highest-first for threshold matching.
// Names such as `paid` are internal keys, not product or subscription labels.
// ---------------------------------------------------------------------------

const TIER_THRESHOLDS: ReadonlyArray<
  { name: string; minSpend: number } & Record<`${EndpointType}Rpm`, number>
> = [
  {
    name: "growth",
    minSpend: 100,
    completionsRpm: 300,
    embeddingsRpm: 600,
    standardRpm: 120,
    strictRpm: 30,
  },
  {
    name: "paid",
    minSpend: 5,
    completionsRpm: 120,
    embeddingsRpm: 200,
    standardRpm: 60,
    strictRpm: 10,
  },
  {
    name: "free",
    minSpend: 0,
    completionsRpm: 60,
    embeddingsRpm: 100,
    standardRpm: 30,
    strictRpm: 5,
  },
];

/** Sorted highest-first at module load for threshold matching. */
const SORTED_THRESHOLDS = [...TIER_THRESHOLDS].sort((a, b) => b.minSpend - a.minSpend);
const FREE_TIER = SORTED_THRESHOLDS[SORTED_THRESHOLDS.length - 1];

/** Metadata markers excluded by the current selector; #23019 owns economic qualification. */
export const ORG_TIER_EXCLUDED_CREDIT_METADATA_TYPES = [
  "initial_free_credits",
  "wallet_signup",
  "signup_code_bonus",
] as const;

export interface OrgTierCacheExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export type OrgTierCacheResolution =
  | { kind: "ready"; tier: OrgTierData }
  | {
      kind: "warming" | "unavailable";
      cacheRead: "miss" | "invalid" | "unavailable" | "error";
    };

const orgTierHydrations = new Map<string, Promise<void>>();

function isOrgTierData(value: unknown): value is OrgTierData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OrgTierData>;
  return (
    typeof candidate.tierName === "string" &&
    candidate.tierName.length > 0 &&
    Number.isSafeInteger(candidate.completionsRpm) &&
    (candidate.completionsRpm ?? 0) > 0 &&
    Number.isSafeInteger(candidate.embeddingsRpm) &&
    (candidate.embeddingsRpm ?? 0) > 0 &&
    Number.isSafeInteger(candidate.standardRpm) &&
    (candidate.standardRpm ?? 0) > 0 &&
    Number.isSafeInteger(candidate.strictRpm) &&
    (candidate.strictRpm ?? 0) > 0 &&
    candidate.catalogVersion === "v1" &&
    typeof candidate.entitlementVersion === "string" &&
    candidate.entitlementVersion.length > 0 &&
    (candidate.manualOverrideVersion === null ||
      (typeof candidate.manualOverrideVersion === "string" &&
        candidate.manualOverrideVersion.length > 0))
  );
}

function scheduleOrgTierHydration(orgId: string, executionCtx: OrgTierCacheExecutionContext): void {
  let hydration = orgTierHydrations.get(orgId);
  if (!hydration) {
    hydration = recalculateOrgTier(orgId)
      .then(() => undefined)
      .catch((error) => {
        // error-policy:J7 cache hydration is observed here and by the warming
        // response; a retry remains fail-closed until a valid tier is cached.
        logger.warn("[OrgRateLimits] Background tier hydration failed", {
          orgId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        orgTierHydrations.delete(orgId);
      });
    orgTierHydrations.set(orgId, hydration);
  }
  executionCtx.waitUntil(hydration);
}

/** Test hook: isolate cache-only tier hydration state between cases. */
export function __clearOrgTierHydrationsForTests(): void {
  orgTierHydrations.clear();
}

function parseTierSourceCreditTotal(value: unknown, orgId: string): number {
  const normalized = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!/^[+-]?(?:\d+|\d*\.\d+)$/.test(normalized)) {
    throw new ElizaError("Organization tier-source credit total is not a valid NUMERIC", {
      code: "ORG_RATE_LIMIT_SOURCE_INVALID",
      context: { orgId, field: "tier_source_credit_total" },
      severity: "fatal",
    });
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ElizaError(
      "Organization tier-source credit total is not a valid non-negative value",
      {
        code: "ORG_RATE_LIMIT_SOURCE_INVALID",
        context: { orgId, field: "tier_source_credit_total" },
        severity: "fatal",
      },
    );
  }
  return parsed;
}

/**
 * Pure tier resolver shared by the normal source reader and the coherent
 * account-billing snapshot transaction. Keeping threshold/override semantics
 * here prevents the snapshot from maintaining a second policy table.
 */
export function resolveOrgTierFromSourceValues(
  orgId: string,
  tierSourceCreditTotal: unknown,
  override?: OrgTierOverrideValues,
): { tierData: OrgTierData; tierSourceCreditTotal: number } {
  const parsedTierSourceCreditTotal = parseTierSourceCreditTotal(tierSourceCreditTotal, orgId);
  const matchedTier =
    SORTED_THRESHOLDS.find((tier) => parsedTierSourceCreditTotal >= tier.minSpend) ?? FREE_TIER;

  let tierData: OrgTierData = {
    tierName: matchedTier.name,
    completionsRpm: matchedTier.completionsRpm,
    embeddingsRpm: matchedTier.embeddingsRpm,
    standardRpm: matchedTier.standardRpm,
    strictRpm: matchedTier.strictRpm,
    catalogVersion: "v1",
    entitlementVersion: `legacy:credit-total:${parsedTierSourceCreditTotal}`,
    manualOverrideVersion: null,
  };

  if (override) {
    const hasRpmOverride =
      override.completions_rpm != null ||
      override.embeddings_rpm != null ||
      override.standard_rpm != null ||
      override.strict_rpm != null;
    tierData = {
      tierName: hasRpmOverride ? "custom" : matchedTier.name,
      completionsRpm: override.completions_rpm ?? tierData.completionsRpm,
      embeddingsRpm: override.embeddings_rpm ?? tierData.embeddingsRpm,
      standardRpm: override.standard_rpm ?? tierData.standardRpm,
      strictRpm: override.strict_rpm ?? tierData.strictRpm,
      catalogVersion: tierData.catalogVersion,
      entitlementVersion: hasRpmOverride
        ? `${tierData.entitlementVersion}|override:legacy-inline`
        : tierData.entitlementVersion,
      manualOverrideVersion: hasRpmOverride ? "legacy-inline" : null,
    };
  }

  if (!isOrgTierData(tierData)) {
    throw new ElizaError("Organization rate-limit override is invalid", {
      code: "ORG_RATE_LIMIT_SOURCE_INVALID",
      context: { orgId, field: "org_rate_limit_overrides" },
      severity: "fatal",
    });
  }

  return { tierData, tierSourceCreditTotal: parsedTierSourceCreditTotal };
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

function sourceUnavailable<T>(error: unknown): SubscriptionEntitlementSource<T> {
  return {
    kind: "unavailable",
    reason: error instanceof Error ? error.message : "entitlement source failed",
    retryable: true,
  };
}

async function readLegacyTierSourceTotal(orgId: string): Promise<unknown> {
  const creditResult = await dbRead
    .select({
      tierSourceCreditTotal: sql<string>`COALESCE(SUM(${creditTransactions.amount}), '0')`,
    })
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.organization_id, orgId),
        eq(creditTransactions.type, "credit"),
        sql`COALESCE(${creditTransactions.metadata}->>'type', '') NOT IN (${sql.join(
          ORG_TIER_EXCLUDED_CREDIT_METADATA_TYPES.map((t) => sql`${t}`),
          sql`, `,
        )})`,
      ),
    );
  return creditResult[0]?.tierSourceCreditTotal;
}

function mapProjection(
  row: Awaited<ReturnType<typeof subscriptionEntitlementsRepository.find>>,
): SubscriptionEntitlementProjection | null {
  if (!row) return null;
  return {
    planKey: row.plan_key,
    state: row.state,
    catalogVersion: row.catalog_version,
    projectionRevision: row.projection_revision,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    limits: {
      completionsRpm: row.completions_rpm,
      embeddingsRpm: row.embeddings_rpm,
      standardRpm: row.standard_rpm,
      strictRpm: row.strict_rpm,
      cloudCharacters: row.cloud_characters_ceiling,
      agentSandboxes: row.agent_sandboxes_ceiling,
      containers: row.containers_ceiling,
      storageGiB: row.storage_gib_ceiling,
      apps: row.apps_ceiling,
    },
  };
}

const repositoryEntitlementSources: SubscriptionEntitlementSources = {
  async readProjection(orgId) {
    try {
      return {
        kind: "available",
        value: mapProjection(await subscriptionEntitlementsRepository.find(orgId)),
      };
    } catch (error) {
      // error-policy:J4 inference entitlement resolution exposes source failure
      // explicitly and never substitutes a permissive projection.
      return sourceUnavailable<SubscriptionEntitlementProjection>(error);
    }
  },
  async readManualOverride(orgId) {
    try {
      const row = await orgRateLimitOverridesRepository.findByOrganizationId(orgId);
      if (!row) return { kind: "available", value: null };
      const fields = {
        ...(row.completions_rpm !== null && { completionsRpm: row.completions_rpm }),
        ...(row.embeddings_rpm !== null && { embeddingsRpm: row.embeddings_rpm }),
        ...(row.standard_rpm !== null && { standardRpm: row.standard_rpm }),
        ...(row.strict_rpm !== null && { strictRpm: row.strict_rpm }),
      };
      if (Object.keys(fields).length === 0) return { kind: "available", value: null };
      return {
        kind: "available",
        value: {
          auditId: row.id,
          version: row.updated_at.toISOString(),
          fields,
        } satisfies ManualEntitlementOverride,
      };
    } catch (error) {
      // error-policy:J4 inference entitlement resolution exposes override-store
      // failure explicitly because an unknown override cannot be ignored safely.
      return sourceUnavailable<ManualEntitlementOverride>(error);
    }
  },
  async readLegacySelection(orgId) {
    try {
      const total = await readLegacyTierSourceTotal(orgId);
      const { tierData, tierSourceCreditTotal } = resolveOrgTierFromSourceValues(orgId, total);
      return {
        kind: "available",
        value: {
          selectorKey: tierData.tierName,
          selectorVersion: `credit-total:${tierSourceCreditTotal}`,
          limits: {
            ...FREE_SUBSCRIPTION_ENTITLEMENT_LIMITS,
            completionsRpm: tierData.completionsRpm,
            embeddingsRpm: tierData.embeddingsRpm,
            standardRpm: tierData.standardRpm,
            strictRpm: tierData.strictRpm,
          },
        } satisfies LegacyEntitlementSelection,
      };
    } catch (error) {
      // error-policy:J4 malformed or unavailable legacy authority becomes a
      // typed unavailable result and cannot hydrate a permissive cache entry.
      return sourceUnavailable<LegacyEntitlementSelection>(error);
    }
  },
};

export const subscriptionEntitlementService = new SubscriptionEntitlementService(
  repositoryEntitlementSources,
);

function tierFromEntitlement(
  organizationId: string,
  resolution: SubscriptionEntitlementResolution,
): OrgTierData {
  if (resolution.kind === "unavailable") {
    throw new ElizaError("Organization subscription entitlement is unavailable", {
      code: "ORG_ENTITLEMENT_UNAVAILABLE",
      context: { organizationId, reason: resolution.reason, detail: resolution.detail },
      severity: "ephemeral",
    });
  }
  return {
    tierName:
      resolution.source === "manual_override"
        ? "custom"
        : resolution.baseSource === "subscription"
          ? resolution.planKey
          : (resolution.legacySelectorKey ?? resolution.baseSource),
    completionsRpm: resolution.limits.completionsRpm,
    embeddingsRpm: resolution.limits.embeddingsRpm,
    standardRpm: resolution.limits.standardRpm,
    strictRpm: resolution.limits.strictRpm,
    catalogVersion: resolution.catalogVersion,
    entitlementVersion: resolution.entitlementVersion,
    manualOverrideVersion: resolution.versions.manualOverride,
  };
}

async function calculateOrgTierFromSources(orgId: string): Promise<OrgTierData> {
  return tierFromEntitlement(orgId, await subscriptionEntitlementService.resolve(orgId));
}

/**
 * Reads the authoritative configured tier without hydrating the inference
 * cache. Observation-only surfaces use this path so a read cannot change
 * runtime admission state.
 */
export async function readOrgTierFromSources(orgId: string): Promise<OrgTierData> {
  return await calculateOrgTierFromSources(orgId);
}

/**
 * Recalculates an org's rate limit tier from the DB and caches the result.
 *
 * The current selector sums credit rows except its legacy excluded metadata
 * markers. That input is observable implementation state, not a ratified
 * definition of paid spend; #23019 owns the qualification policy.
 */
export async function recalculateOrgTier(orgId: string): Promise<OrgTierData> {
  const tierData = await calculateOrgTierFromSources(orgId);

  // Cache is non-fatal: a later request can re-read the database.
  try {
    await cache.set(CacheKeys.org.rateLimitTier(orgId), tierData, CacheTTL.org.rateLimitTier);
  } catch (err) {
    // error-policy:J7 cache hydration is best-effort; the authoritative tier
    // has already been calculated and future requests can retry the write.
    logger.warn("[OrgRateLimits] Failed to cache tier, will re-query on next request", {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.debug("[OrgRateLimits] Tier computed", {
    orgId,
    tier: tierData.tierName,
    catalogVersion: tierData.catalogVersion,
    entitlementVersion: tierData.entitlementVersion,
  });

  return tierData;
}

/**
 * Returns the cached tier for an org, computing it lazily on cache miss.
 */
export async function getOrgTier(orgId: string): Promise<OrgTierData> {
  const cached = await cache.get<unknown>(CacheKeys.org.rateLimitTier(orgId));
  if (isOrgTierData(cached)) return cached;
  return recalculateOrgTier(orgId);
}

/**
 * Resolve a rate-limit tier without joining Postgres work to an inference
 * request. Cold, malformed, or unavailable cache state is explicit; when a
 * Worker execution context is present the authoritative refresh is retained
 * under `waitUntil` for the retry.
 */
export async function getOrgTierCacheOnly(
  orgId: string,
  options: { executionCtx?: OrgTierCacheExecutionContext } = {},
): Promise<OrgTierCacheResolution> {
  const outcome = await cache.getWithOutcome<unknown>(CacheKeys.org.rateLimitTier(orgId));
  if (outcome.kind === "hit" && isOrgTierData(outcome.value)) {
    return { kind: "ready", tier: outcome.value };
  }

  const cacheRead = outcome.kind === "hit" ? ("invalid" as const) : outcome.kind;
  if (options.executionCtx) {
    scheduleOrgTierHydration(orgId, options.executionCtx);
  }
  return {
    kind: cacheRead === "unavailable" || cacheRead === "error" ? "unavailable" : "warming",
    cacheRead,
  };
}

/**
 * Returns the rate limit config for a specific endpoint type and org.
 */
export async function getOrgRpmForEndpoint(
  orgId: string,
  endpointType: EndpointType,
): Promise<OrgRateLimitConfig> {
  const tier = await getOrgTier(orgId);
  const rpmKey = `${endpointType}Rpm` as const;
  return {
    windowMs: 60_000,
    maxRequests: tier[rpmKey],
  };
}

export type OrgRateLimitConfigCacheResolution =
  | { kind: "ready"; config: OrgRateLimitConfig }
  | Exclude<OrgTierCacheResolution, { kind: "ready" }>;

/** Cache-only counterpart used by Worker inference handlers. */
export async function getOrgRpmForEndpointCacheOnly(
  orgId: string,
  endpointType: EndpointType,
  options: { executionCtx?: OrgTierCacheExecutionContext } = {},
): Promise<OrgRateLimitConfigCacheResolution> {
  const resolution = await getOrgTierCacheOnly(orgId, options);
  if (resolution.kind !== "ready") return resolution;
  const rpmKey = `${endpointType}Rpm` as const;
  return {
    kind: "ready",
    config: {
      windowMs: 60_000,
      maxRequests: resolution.tier[rpmKey],
    },
  };
}

/**
 * Invalidates the cached tier for an org. The next request will trigger
 * a lazy recalculation via getOrgTier().
 */
export async function invalidateOrgTierCache(orgId: string): Promise<void> {
  await cache.del(CacheKeys.org.rateLimitTier(orgId));
  logger.debug("[OrgRateLimits] Tier cache invalidated", { orgId });
}
