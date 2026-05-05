const DEFAULT_MARKUP_RATE = 0.2;

export interface MarkupBreakdown {
  rawCost: number;
  markup: number;
  billedCost: number;
  markupRate: number;
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

function applyMarkupCents(rawCents: number, markupRate: number): number {
  if (!Number.isInteger(rawCents)) {
    throw new RangeError(`rawCents must be an integer, received ${rawCents}`);
  }
  assertValidCost(rawCents, "rawCents");
  assertValidRate(markupRate);

  if (rawCents === 0) return 0;
  return Math.round(rawCents * (1 + markupRate));
}

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
