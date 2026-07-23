/**
 * Immutable affiliate economics captured before an inference provider dispatch.
 *
 * Admission, reservation, settlement, and payout share this snapshot so a
 * mutable affiliate row cannot change the beneficiary or markup mid-charge.
 */

export interface AffiliateBillingAttribution {
  readonly affiliateCodeId: string;
  readonly affiliateUserId: string;
  readonly affiliateCode: string;
  /** Affiliate markup expressed as a decimal fraction (20% = 0.2). */
  readonly markupPercent: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate the snapshot before any value reaches a PostgreSQL UUID boundary. */
export function isAffiliateBillingAttribution(
  value: unknown,
): value is AffiliateBillingAttribution {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.affiliateCodeId === "string" &&
    UUID_PATTERN.test(candidate.affiliateCodeId) &&
    typeof candidate.affiliateUserId === "string" &&
    UUID_PATTERN.test(candidate.affiliateUserId) &&
    typeof candidate.affiliateCode === "string" &&
    candidate.affiliateCode.trim() !== "" &&
    typeof candidate.markupPercent === "number" &&
    Number.isFinite(candidate.markupPercent) &&
    candidate.markupPercent > 0 &&
    candidate.markupPercent <= 10
  );
}
