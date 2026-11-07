/**
 * Cache-first affiliate markup resolution for Worker inference admission.
 *
 * Affiliate configuration is mutable money policy, so a request consumes only
 * a validated record. A warm request reads the shared cache; a miss or
 * malformed record reads the primary once, inline (coalesced per isolate), and
 * projects the record into the cache under the Worker lifetime.
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

/** The primary affiliate record is unreadable or carries an invalid markup. */
export class InferenceAffiliateCacheUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Inference affiliate policy is unavailable; retry the request", options);
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

const affiliateReadsInFlight = new Map<string, Promise<CachedAffiliate>>();

/** One primary read per code per isolate; the cache projection runs off-response. */
function readAffiliateFromPrimary(
  code: string,
  executionCtx: { waitUntil(promise: Promise<unknown>): void },
): Promise<CachedAffiliate> {
  const existing = affiliateReadsInFlight.get(code);
  if (existing) return existing;
  const read = Promise.resolve()
    .then(() => affiliatesRepository.getAffiliateCodeByCode(code))
    .then((record): CachedAffiliate => record ?? NEGATIVE_AFFILIATE);
  affiliateReadsInFlight.set(code, read);
  const cleanup = () => {
    if (affiliateReadsInFlight.get(code) === read) affiliateReadsInFlight.delete(code);
  };
  read.then(cleanup, cleanup);
  executionCtx.waitUntil(
    read
      .then(async (record) => {
        const outcome = await cache.setWithOutcome(
          CacheKeys.affiliate.codeByCode(code),
          record,
          CacheTTL.affiliate.data,
        );
        if (outcome.kind !== "written") {
          throw new Error(`Affiliate cache write failed: ${outcome.kind}`);
        }
      })
      .catch((error) => {
        // error-policy:J7 the projection is outside model dispatch; the next
        // request reads the primary again.
        logger.warn("[InferenceBilling] affiliate cache projection failed", {
          code,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
  );
  return read;
}

/**
 * Inactive, missing, self-referral, and non-positive markup records retain the
 * authoritative billing semantics of `reserveCredits`: they contribute no
 * affiliate markup. Returns `undefined` for a record that cannot be trusted.
 */
function attributionFromRecord(
  record: unknown,
  code: string,
  userId: string,
): AffiliateBillingAttribution | null | undefined {
  if (isNegativeAffiliate(record)) return null;
  if (!isAffiliateCode(record) || record.code !== code) return undefined;
  if (!record.is_active || record.user_id === userId) return null;
  if (typeof record.markup_percent === "string" && record.markup_percent.trim() === "")
    return undefined;
  const storedPercent = Number(record.markup_percent);
  if (!Number.isFinite(storedPercent) || storedPercent > 1000) return undefined;
  if (storedPercent <= 0) return null;
  return Object.freeze({
    affiliateCodeId: record.id,
    affiliateUserId: record.user_id,
    affiliateCode: record.code,
    markupPercent: storedPercent / 100,
  });
}

/**
 * Return immutable affiliate attribution for one inference charge. Malformed
 * data is unavailable, never interpreted as a valid zero-markup policy.
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
    const cached = attributionFromRecord(outcome.value, code, params.userId);
    if (cached !== undefined) return cached;
  }
  let record: CachedAffiliate;
  try {
    record = await readAffiliateFromPrimary(code, params.executionCtx);
  } catch (error) {
    throw new InferenceAffiliateCacheUnavailableError({ cause: error });
  }
  const authoritative = attributionFromRecord(record, code, params.userId);
  if (authoritative === undefined) throw new InferenceAffiliateCacheUnavailableError();
  return authoritative;
}

/** Test hook for isolating in-flight primary reads. */
export function __clearInferenceAffiliateCacheState(): void {
  affiliateReadsInFlight.clear();
}
