const DEFAULT_MARKUP_RATE = 0.2;
const DEFAULT_USD_ROUNDING_PRECISION = 2;
const TWILIO_SMS_SEGMENT_CHAR_LIMIT = 160;
const DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD = 0.0075;

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
    throw new RangeError(`${fieldName} must be a finite number, received ${cost}`);
  }
  if (cost < 0) {
    throw new RangeError(`${fieldName} must be non-negative, received ${cost}`);
  }
}

function assertValidRate(markupRate: number): void {
  if (!Number.isFinite(markupRate)) {
    throw new RangeError(`markupRate must be a finite number, received ${markupRate}`);
  }
  if (markupRate < 0) {
    throw new RangeError(`markupRate must be non-negative, received ${markupRate}`);
  }
}

function roundUsd(value: number, precision: number = DEFAULT_USD_ROUNDING_PRECISION): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`value must be a finite number, received ${value}`);
  }
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function applyMarkup(cost: number, markupRate: number = DEFAULT_MARKUP_RATE): MarkupBreakdown {
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

export function resolveTwilioSmsCostPerSegment(
  rawCostPerSegment: string | number | null | undefined,
  fallbackCostPerSegment: number = DEFAULT_TWILIO_SMS_COST_PER_SEGMENT_USD,
): number {
  assertValidCost(fallbackCostPerSegment, "fallbackCostPerSegment");

  if (rawCostPerSegment === null || rawCostPerSegment === undefined || rawCostPerSegment === "") {
    return fallbackCostPerSegment;
  }

  const parsed =
    typeof rawCostPerSegment === "number"
      ? rawCostPerSegment
      : Number.parseFloat(rawCostPerSegment);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallbackCostPerSegment;
  }

  return parsed;
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
