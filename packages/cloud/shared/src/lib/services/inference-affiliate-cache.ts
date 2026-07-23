/**
 * Cache-only affiliate markup resolution for Worker inference admission.
 *
 * Affiliate configuration is mutable money policy, so a request may consume
 * only a validated shared-cache record. A miss or malformed record schedules
 * authoritative hydration under the Worker lifetime and returns a retryable
 * state; Postgres never joins model dispatch.
 */

import { affiliatesRepository } from "../../db/repositories/affiliates";
import type { AffiliateCode } from "../../db/schemas/affiliates";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";
import type { AffiliateBillingAttribution } from "./affiliate-billing-attribution";

const NEGATIVE_AFFILIATE = { __none: true } as const;
type CachedAffiliate = AffiliateCode | typeof NEGATIVE_AFFILIATE;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InferenceAffiliateCacheWarmingError extends Error {
  constructor() {
    super("Inference affiliate cache is warming; retry the request");
    this.name = "InferenceAffiliateCacheWarmingError";
  }
}

export class InferenceAffiliateCacheUnavailableError extends Error {
  constructor() {
    super("Inference affiliate cache is unavailable; retry the request");
    this.name = "InferenceAffiliateCacheUnavailableError";
  }
}

function isNegativeAffiliate(value: unknown): value is typeof NEGATIVE_AFFILIATE {
  return (
    typeof value === "object" && value !== null && (value as { __none?: unknown }).__none === true
  );
}

function isAffiliateCode(value: unknown): value is AffiliateCode {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    UUID_PATTERN.test(candidate.id) &&
    typeof candidate.user_id === "string" &&
    UUID_PATTERN.test(candidate.user_id) &&
    typeof candidate.code === "string" &&
    candidate.code.trim() !== "" &&
    typeof candidate.is_active === "boolean" &&
    (typeof candidate.markup_percent === "string" || typeof candidate.markup_percent === "number")
  );
}

const affiliateHydrationInFlight = new Map<string, Promise<void>>();

function hydrateAffiliate(code: string): Promise<void> {
  const existing = affiliateHydrationInFlight.get(code);
  if (existing) return existing;

  const hydration = Promise.resolve()
    .then(() => affiliatesRepository.getAffiliateCodeByCode(code))
    .then(async (record) => {
      const cached: CachedAffiliate = record ?? NEGATIVE_AFFILIATE;
      const outcome = await cache.setWithOutcome(
        CacheKeys.affiliate.codeByCode(code),
        cached,
        CacheTTL.affiliate.data,
      );
      if (outcome.kind !== "written") {
        throw new Error(`Affiliate cache write failed: ${outcome.kind}`);
      }
    });
  affiliateHydrationInFlight.set(code, hydration);
  const cleanup = () => {
    if (affiliateHydrationInFlight.get(code) === hydration) {
      affiliateHydrationInFlight.delete(code);
    }
  };
  hydration.then(cleanup, cleanup);
  return hydration;
}

function scheduleAffiliateHydration(
  code: string,
  executionCtx: { waitUntil(promise: Promise<unknown>): void },
): void {
  const observed = hydrateAffiliate(code).then(
    () => undefined,
    (error) => {
      // error-policy:J7 affiliate hydration is deliberately outside model
      // dispatch; log the failure and leave the cache cold for a safe retry.
      logger.warn("[InferenceBilling] affiliate cache hydration failed", {
        code,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  executionCtx.waitUntil(observed);
}

/**
 * Return immutable affiliate attribution for one inference charge.
 *
 * Inactive, missing, self-referral, and non-positive markup records retain the
 * authoritative billing semantics of `reserveCredits`: they contribute no
 * affiliate markup. Malformed cache data is unavailable, never interpreted as
 * a valid zero-markup policy.
 */
export async function getCachedInferenceAffiliateAttribution(params: {
  affiliateCode?: string | null;
  organizationId: string;
  userId: string;
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
}): Promise<AffiliateBillingAttribution | null> {
  const code = params.affiliateCode?.trim();
  if (!code || params.organizationId === "anonymous") return null;

  const outcome = await cache.getWithOutcome<unknown>(CacheKeys.affiliate.codeByCode(code));
  if (outcome.kind === "hit") {
    if (isNegativeAffiliate(outcome.value)) return null;
    if (!isAffiliateCode(outcome.value) || outcome.value.code !== code) {
      scheduleAffiliateHydration(code, params.executionCtx);
      throw new InferenceAffiliateCacheUnavailableError();
    }
    if (!outcome.value.is_active || outcome.value.user_id === params.userId) return null;

    if (
      typeof outcome.value.markup_percent === "string" &&
      outcome.value.markup_percent.trim() === ""
    ) {
      scheduleAffiliateHydration(code, params.executionCtx);
      throw new InferenceAffiliateCacheUnavailableError();
    }
    const storedPercent = Number(outcome.value.markup_percent);
    if (!Number.isFinite(storedPercent) || storedPercent > 1000) {
      scheduleAffiliateHydration(code, params.executionCtx);
      throw new InferenceAffiliateCacheUnavailableError();
    }
    if (storedPercent <= 0) return null;
    return Object.freeze({
      affiliateCodeId: outcome.value.id,
      affiliateUserId: outcome.value.user_id,
      affiliateCode: outcome.value.code,
      markupPercent: storedPercent / 100,
    });
  }

  scheduleAffiliateHydration(code, params.executionCtx);
  if (outcome.kind === "miss") {
    throw new InferenceAffiliateCacheWarmingError();
  }
  throw new InferenceAffiliateCacheUnavailableError();
}

/** Backward-compatible numeric view for callers not yet carrying attribution. */
export async function getCachedInferenceAffiliateMarkup(params: {
  affiliateCode?: string | null;
  organizationId: string;
  userId: string;
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
}): Promise<number> {
  const attribution = await getCachedInferenceAffiliateAttribution(params);
  return attribution?.markupPercent ?? 0;
}

/** Test hook for isolating in-flight hydrations. */
export function __clearInferenceAffiliateCacheState(): void {
  affiliateHydrationInFlight.clear();
}
