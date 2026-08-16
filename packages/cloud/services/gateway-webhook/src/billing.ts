// Handles webhook gateway billing behavior for authenticated connector fan-in.
const DEFAULT_MARKUP_RATE = 0.2;
const DEFAULT_USD_ROUNDING_PRECISION = 2;
const TWILIO_SMS_SEGMENT_CHAR_LIMIT = 160;
export const DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD = 0.0075;

interface MarkupBreakdown {
  rawCost: number;
  markup: number;
  billedCost: number;
  markupRate: number;
}

interface TwilioSmsBillingBreakdown extends MarkupBreakdown {
  segments: number;
  costPerSegment: number;
}

function assertValidCost(cost: number, fieldName: string): void {
  if (!Number.isFinite(cost)) {
    throw new RangeError(
      `${fieldName} must be a finite number, received ${cost}`,
    );
  }
  if (cost < 0) {
    throw new RangeError(`${fieldName} must be non-negative, received ${cost}`);
  }
}

function assertValidRate(markupRate: number): void {
  if (!Number.isFinite(markupRate)) {
    throw new RangeError(
      `markupRate must be a finite number, received ${markupRate}`,
    );
  }
  if (markupRate < 0) {
    throw new RangeError(
      `markupRate must be non-negative, received ${markupRate}`,
    );
  }
}

function roundUsd(
  value: number,
  precision: number = DEFAULT_USD_ROUNDING_PRECISION,
): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`value must be a finite number, received ${value}`);
  }
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function applyMarkup(
  cost: number,
  markupRate: number = DEFAULT_MARKUP_RATE,
): MarkupBreakdown {
  assertValidCost(cost, "cost");
  assertValidRate(markupRate);

  const rawCost = roundUsd(cost);
  const billedCost = roundUsd(rawCost * (1 + markupRate));

  return {
    rawCost,
    markup: roundUsd(billedCost - rawCost),
    billedCost,
    markupRate,
  };
}

function estimateTwilioSmsSegments(body: string): number {
  if (body.length === 0) return 1;
  return Math.ceil(body.length / TWILIO_SMS_SEGMENT_CHAR_LIMIT);
}

/**
 * Classification of a raw Twilio SMS cost configuration value.
 *
 * `absent` means no value was supplied (null/undefined/empty) and the caller
 * should silently fall back to the default. `invalid` means a value was
 * supplied but is not a strictly-parseable, finite, non-negative cost and the
 * caller should both warn and fall back. `valid` carries the parsed cost.
 */
export type TwilioSmsCostConfig =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; value: number };

/**
 * Decimal-only cost grammar: optional leading `+`, an integer/fraction, and an
 * optional exponent. It deliberately excludes the non-decimal literals that
 * bare `Number()` would otherwise coerce (`"0x10"` → 16, `"0b1"`, `"0o7"`,
 * `"Infinity"`), so hex/binary/octal configuration is rejected rather than
 * billed as an absurd per-segment cost.
 */
const TWILIO_SMS_COST_PATTERN = /^\+?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/**
 * Classify a raw Twilio SMS cost value using strict full-string parsing.
 *
 * The whole trimmed string must be a decimal number: partially numeric values
 * such as `"0.01USD"` or `"1.2.3"` and non-decimal literals such as `"0x10"`
 * are rejected rather than truncated or coerced. A whitespace-only value trims
 * to empty and is treated as `absent` (silent default) so a stray space in the
 * env var cannot zero out billing. This is the single strict contract shared by
 * {@link resolveTwilioSmsCostPerSegment} and the adapter's
 * invalid-configuration warning gate so the two cannot drift.
 */
export function classifyTwilioSmsCostConfig(
  rawCostPerSegment: string | number | null | undefined,
): TwilioSmsCostConfig {
  if (rawCostPerSegment === null || rawCostPerSegment === undefined) {
    return { status: "absent" };
  }

  let parsed: number;
  if (typeof rawCostPerSegment === "number") {
    parsed = rawCostPerSegment;
  } else {
    const trimmed = rawCostPerSegment.trim();
    if (trimmed === "") {
      return { status: "absent" };
    }
    if (!TWILIO_SMS_COST_PATTERN.test(trimmed)) {
      return { status: "invalid" };
    }
    parsed = Number(trimmed);
  }

  if (!Number.isFinite(parsed) || parsed < 0) {
    return { status: "invalid" };
  }

  return { status: "valid", value: parsed };
}

export function resolveTwilioSmsCostPerSegment(
  rawCostPerSegment: string | number | null | undefined,
  fallbackCostPerSegment: number = DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD,
): number {
  assertValidCost(fallbackCostPerSegment, "fallbackCostPerSegment");

  const classified = classifyTwilioSmsCostConfig(rawCostPerSegment);
  return classified.status === "valid"
    ? classified.value
    : fallbackCostPerSegment;
}

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
