export interface MinorCurrencyValue {
  amountMinor: number;
  currency: string;
  currencyDigits?: number;
}

/** Preserve every minor unit by passing an exact decimal string to modern Intl. */
export function formatMinorCurrency(
  value: MinorCurrencyValue,
  locale: string,
): string;

export function isIsoCalendarDate(value: unknown): value is string;

/** Inclusive canonical calendar-date range; rejects normalization and reversal. */
export function isOrderedIsoDateRange(start: unknown, end: unknown): boolean;
