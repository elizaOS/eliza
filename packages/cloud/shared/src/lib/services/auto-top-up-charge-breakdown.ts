/**
 * Auto top-up charge disclosure (#23020).
 *
 * When a buyer's organization is attributed to an affiliate, a card auto
 * top-up credits the configured base amount but charges the base plus the
 * affiliate markup plus the platform fee. This module owns that arithmetic
 * (one formula shared by the durable charge snapshot and the pre-save preview)
 * and the receipt breakdown parsed back from the signed Stripe metadata, so
 * clients render server amounts and never recompute money.
 *
 * The formula is unchanged from the durable auto top-up path: both fees are
 * percentages of the credited base, rounded half-up to whole cents, and apply
 * only while an affiliate is attributed.
 */

import Decimal from "decimal.js";
import { logger } from "../utils/logger";

export const AUTO_TOP_UP_AFFILIATE_PLATFORM_FEE_PERCENT = new Decimal(20);
export const AUTO_TOP_UP_AFFILIATE_MAX_MARKUP_PERCENT = new Decimal(1000);

export interface AutoTopUpChargeCents {
  creditAmountCents: number;
  affiliateFeeCents: number;
  platformFeeCents: number;
  chargeAmountCents: number;
}

/**
 * Customer-facing line items for one auto top-up charge. Amounts are USD
 * strings with two decimals; `totalChargeUsd` always equals the sum of the
 * three lines and the amount sent to the card provider.
 */
export interface AutoTopUpChargeBreakdown {
  creditedBaseUsd: string;
  affiliateMarkupUsd: string;
  platformFeeUsd: string;
  totalChargeUsd: string;
  /** True when an affiliate surcharge (markup plus platform fee) applies. */
  surchargeApplies: boolean;
}

function percentOfCents(baseCents: number, percent: Decimal): number {
  return new Decimal(baseCents)
    .mul(percent)
    .div(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
}

function centsToUsd(cents: number): string {
  return new Decimal(cents).div(100).toFixed(2);
}

/**
 * Charge components for a credited base. `affiliateMarkupPercent` is null when
 * no affiliate is attributed, in which case the card is charged the base only.
 */
export function computeAutoTopUpChargeCents(
  creditAmountCents: number,
  affiliateMarkupPercent: Decimal | null,
): AutoTopUpChargeCents {
  if (!affiliateMarkupPercent) {
    return {
      creditAmountCents,
      affiliateFeeCents: 0,
      platformFeeCents: 0,
      chargeAmountCents: creditAmountCents,
    };
  }
  const affiliateFeeCents = percentOfCents(creditAmountCents, affiliateMarkupPercent);
  const platformFeeCents = percentOfCents(
    creditAmountCents,
    AUTO_TOP_UP_AFFILIATE_PLATFORM_FEE_PERCENT,
  );
  return {
    creditAmountCents,
    affiliateFeeCents,
    platformFeeCents,
    chargeAmountCents: creditAmountCents + affiliateFeeCents + platformFeeCents,
  };
}

export function autoTopUpChargeBreakdownFromCents(
  charge: AutoTopUpChargeCents,
): AutoTopUpChargeBreakdown {
  return {
    creditedBaseUsd: centsToUsd(charge.creditAmountCents),
    affiliateMarkupUsd: centsToUsd(charge.affiliateFeeCents),
    platformFeeUsd: centsToUsd(charge.platformFeeCents),
    totalChargeUsd: centsToUsd(charge.chargeAmountCents),
    surchargeApplies: charge.affiliateFeeCents > 0 || charge.platformFeeCents > 0,
  };
}

function exactCents(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(raw)) return null;
  const [whole, fraction] = raw.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

/**
 * Receipt breakdown from the durable auto top-up metadata that was signed into
 * the Stripe PaymentIntent and copied onto the credit transaction.
 *
 * Returns null for rows that are not durable auto top-ups (legacy rows carry no
 * fee fields). A durable row whose lines do not add up to the charged total is
 * reported and also returns null, so one corrupt row cannot break a listing and
 * a wrong breakdown is never shown.
 */
export function autoTopUpChargeBreakdownFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): AutoTopUpChargeBreakdown | null {
  if (!metadata || metadata.type !== "auto_top_up" || metadata.fees_included !== "true") {
    return null;
  }
  const base = exactCents(metadata.base_amount);
  const total = exactCents(metadata.total_charged);
  const platform = exactCents(metadata.platform_fee_amount);
  const affiliate =
    metadata.affiliate_fee_amount === undefined ? 0 : exactCents(metadata.affiliate_fee_amount);
  if (
    base === null ||
    total === null ||
    platform === null ||
    affiliate === null ||
    base + platform + affiliate !== total
  ) {
    // error-policy:J3 untrusted stored receipt metadata; omit the breakdown
    // rather than render lines that do not match the charged total.
    logger.warn("[AutoTopUp] Receipt metadata has an inconsistent charge breakdown", {
      attemptId:
        typeof metadata.auto_top_up_attempt_id === "string"
          ? metadata.auto_top_up_attempt_id
          : undefined,
    });
    return null;
  }
  return autoTopUpChargeBreakdownFromCents({
    creditAmountCents: base,
    affiliateFeeCents: affiliate,
    platformFeeCents: platform,
    chargeAmountCents: total,
  });
}

/**
 * Validate a breakdown previously stored on an invoice record
 * (`metadata.charge_breakdown`). Returns null when absent or malformed.
 */
export function parseStoredAutoTopUpChargeBreakdown(
  value: unknown,
): AutoTopUpChargeBreakdown | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const base = exactCents(record.creditedBaseUsd);
  const affiliate = exactCents(record.affiliateMarkupUsd);
  const platform = exactCents(record.platformFeeUsd);
  const total = exactCents(record.totalChargeUsd);
  if (
    base === null ||
    affiliate === null ||
    platform === null ||
    total === null ||
    base + affiliate + platform !== total
  ) {
    return null;
  }
  return autoTopUpChargeBreakdownFromCents({
    creditAmountCents: base,
    affiliateFeeCents: affiliate,
    platformFeeCents: platform,
    chargeAmountCents: total,
  });
}
