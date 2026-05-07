/**
 * Gateway passthrough billing markup.
 *
 * Eliza Cloud bills SMS / voice / iMessage (and other gateway passthrough
 * traffic) at raw-provider-cost multiplied by a fixed platform markup rate.
 * This matches the 20% markup already applied by `@/lib/pricing` for AI
 * inference, but is kept as a separate utility because the gateway services
 * (`gateway-webhook`, `gateway-discord`) do not currently depend on the
 * Next.js `lib/` module graph and must stay lightweight.
 *
 * All arithmetic is done with integer cents to avoid float drift when many
 * small charges are aggregated for a month-to-date breakdown. Callers that
 * already work in cents should use {@link applyMarkupCents}. Callers that
 * start from a dollar amount can use {@link applyMarkup} which handles the
 * cents conversion once, at the boundary.
 */

/**
 * Default platform markup rate applied to gateway passthrough usage.
 *
 * Expressed as a multiplier delta: 0.20 means the user is billed
 * cost * 1.20.
 */
export const DEFAULT_MARKUP_RATE = 0.2;

/**
 * Platform markup multiplier applied to provider costs.
 *
 * 1.2 means the user is billed provider cost plus 20%.
 */
export const PLATFORM_MARKUP_MULTIPLIER = 1 + DEFAULT_MARKUP_RATE;

export interface MarkupBreakdown {
  /** Raw provider cost in USD. */
  rawCost: number;
  /** Additional charge applied on top of rawCost in USD. */
  markup: number;
  /** Final billed amount in USD (rawCost + markup). */
  billedCost: number;
  /** Markup rate used (e.g. 0.2 for 20%). */
  markupRate: number;
}

export interface TwilioSmsBillingBreakdown extends MarkupBreakdown {
  /** SMS segments billed by Twilio. */
  segments: number;
  /** Raw provider cost per SMS segment in USD. */
  costPerSegment: number;
}

function assertValidRate(markupRate: number): void {
  if (!Number.isFinite(markupRate)) {
    throw new RangeError(`markupRate must be a finite number, received ${markupRate}`);
  }
  if (markupRate < 0) {
    throw new RangeError(`markupRate must be non-negative, received ${markupRate}`);
  }
}

function assertValidCost(cost: number, fieldName: string): void {
  if (!Number.isFinite(cost)) {
    throw new RangeError(`${fieldName} must be a finite number, received ${cost}`);
  }
  if (cost < 0) {
    throw new RangeError(`${fieldName} must be non-negative, received ${cost}`);
  }
}

/**
 * Apply the platform markup to a dollar-denominated cost and return the
 * full breakdown rounded to whole cents (the unit we bill in).
 */
export function applyMarkup(
  cost: number,
  markupRate: number = DEFAULT_MARKUP_RATE,
): MarkupBreakdown {
  assertValidCost(cost, "cost");
  assertValidRate(markupRate);

  const rawCents = Math.round(cost * 100);
  const markedUpCents = applyMarkupCents(rawCents, markupRate);
  const markupCents = markedUpCents - rawCents;

  return {
    rawCost: rawCents / 100,
    markup: markupCents / 100,
    billedCost: markedUpCents / 100,
    markupRate,
  };
}

/**
 * Apply markup to an integer-cents amount, returning integer cents.
 * Rounding is to-nearest (half-up via `Math.round`).
 */
export function applyMarkupCents(
  rawCents: number,
  markupRate: number = DEFAULT_MARKUP_RATE,
): number {
  if (!Number.isInteger(rawCents)) {
    throw new RangeError(`rawCents must be an integer, received ${rawCents}`);
  }
  assertValidCost(rawCents, "rawCents");
  assertValidRate(markupRate);

  if (rawCents === 0) return 0;
  return Math.round(rawCents * (1 + markupRate));
}

const TWILIO_SMS_SEGMENT_CHAR_LIMIT = 160;

/**
 * Estimate the number of Twilio SMS segments for a body.
 *
 * This uses the same plain-text segmentation model the gateway currently bills
 * against: 160 characters per segment, with empty messages still counting as a
 * single segment to avoid zero-cost acknowledgements.
 */
export function estimateTwilioSmsSegments(body: string): number {
  if (body.length === 0) return 1;
  return Math.ceil(body.length / TWILIO_SMS_SEGMENT_CHAR_LIMIT);
}

/**
 * Calculate Twilio SMS provider cost plus platform markup for a message body.
 */
export function calculateTwilioSmsBilling(
  body: string,
  costPerSegment: number,
  markupRate: number = DEFAULT_MARKUP_RATE,
): TwilioSmsBillingBreakdown {
  assertValidCost(costPerSegment, "costPerSegment");
  const segments = estimateTwilioSmsSegments(body);
  const rawCost = segments * costPerSegment;
  const breakdown = applyMarkup(rawCost, markupRate);

  return {
    ...breakdown,
    segments,
    costPerSegment,
  };
}
