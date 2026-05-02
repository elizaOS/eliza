/**
 * Per-organization rate limit tier service.
 *
 * Automatically computes a rate limit tier based on cumulative paid credits,
 * merges any manual overrides from the org_rate_limit_overrides table,
 * and caches the result in Redis (1h TTL) for fast lookups.
 */

import { and, eq, sql } from "drizzle-orm";
import { dbRead } from "@/db/helpers";
import { orgRateLimitOverridesRepository } from "@/db/repositories/org-rate-limit-overrides";
import { creditTransactions } from "@/db/schemas/credit-transactions";
import { cache } from "@/lib/cache/client";
import { logger } from "@/lib/utils/logger";

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
}

// ---------------------------------------------------------------------------
// Tier thresholds — ordered highest-first for threshold matching
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

/** Credit transaction metadata types that represent free/bonus credits (excluded from spend). */
const FREE_CREDIT_TYPES = ["initial_free_credits", "wallet_signup", "signup_code_bonus"];

const TIER_CACHE_TTL_SECONDS = 3600; // 1h
const tierCacheKey = (orgId: string) => `orgtier:${orgId}:v1`;

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Recalculates an org's rate limit tier from the DB and caches the result.
 *
 * The tier is based on cumulative **paid** credits (purchases via Stripe).
 * Free/bonus credits are excluded. An org that bought $100 of credits is tier
 * "growth" regardless of how much they consumed.
 */
export async function recalculateOrgTier(orgId: string): Promise<OrgTierData> {
  // 1. Sum paid credit purchases + load overrides in parallel
  const [creditResult, override] = await Promise.all([
    dbRead
      .select({
        totalSpend: sql<string>`COALESCE(SUM(${creditTransactions.amount}), '0')`,
      })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.organization_id, orgId),
          eq(creditTransactions.type, "credit"),
          sql`COALESCE(${creditTransactions.metadata}->>'type', '') NOT IN (${sql.join(
            FREE_CREDIT_TYPES.map((t) => sql`${t}`),
            sql`, `,
          )})`,
        ),
      ),
    orgRateLimitOverridesRepository.findByOrganizationId(orgId).catch((err) => {
      logger.warn("[OrgRateLimits] Failed to load overrides, using tier defaults", {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }),
  ]);

  const totalSpend = Number.parseFloat(creditResult[0]?.totalSpend ?? "0");

  // 2. Match tier (first threshold where totalSpend >= minSpend)
  const matchedTier = SORTED_THRESHOLDS.find((t) => totalSpend >= t.minSpend) ?? FREE_TIER;

  // 3. Merge override non-null fields
  let tierData: OrgTierData = {
    tierName: matchedTier.name,
    completionsRpm: matchedTier.completionsRpm,
    embeddingsRpm: matchedTier.embeddingsRpm,
    standardRpm: matchedTier.standardRpm,
    strictRpm: matchedTier.strictRpm,
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
    };
  }

  // 4. Cache (non-fatal: if Redis is down, next request will re-query DB)
  try {
    await cache.set(tierCacheKey(orgId), tierData, TIER_CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn("[OrgRateLimits] Failed to cache tier, will re-query on next request", {
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.debug("[OrgRateLimits] Tier computed", {
    orgId,
    tier: tierData.tierName,
    totalSpend,
  });

  return tierData;
}

/**
 * Returns the cached tier for an org, computing it lazily on cache miss.
 */
export async function getOrgTier(orgId: string): Promise<OrgTierData> {
  const cached = await cache.get<OrgTierData>(tierCacheKey(orgId));
  if (cached) return cached;
  return recalculateOrgTier(orgId);
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

/**
 * Invalidates the cached tier for an org. The next request will trigger
 * a lazy recalculation via getOrgTier().
 */
export async function invalidateOrgTierCache(orgId: string): Promise<void> {
  await cache.del(tierCacheKey(orgId));
  logger.debug("[OrgRateLimits] Tier cache invalidated", { orgId });
}
