/** Browser-safe display arithmetic; callers retain labels and locale selection. */
export interface MinorCurrencyValue {
  amountMinor: number;
  currency: string;
  currencyDigits?: number;
}

/** Preserve every minor unit by passing an exact decimal string to modern Intl. */
export function formatMinorCurrency(
  value: MinorCurrencyValue,
  locale: string,
): string {
  if (
    !Number.isSafeInteger(value.amountMinor) ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    !Intl.supportedValuesOf("currency").includes(value.currency)
  ) {
    throw new Error("Invalid money value");
  }
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: value.currency,
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  if (value.currencyDigits !== undefined && value.currencyDigits !== digits) {
    throw new Error("Currency exponent does not match the amount");
  }
  const minor = BigInt(value.amountMinor);
  const absolute = (minor < 0n ? -minor : minor)
    .toString()
    .padStart(digits + 1, "0");
  const decimal = `${minor < 0n ? "-" : ""}${digits ? `${absolute.slice(0, -digits)}.${absolute.slice(-digits)}` : absolute}`;
  return formatter.format(decimal as unknown as number);
}

export function isIsoCalendarDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

/** Inclusive canonical calendar-date range; rejects normalization and reversal. */
export function isOrderedIsoDateRange(start: unknown, end: unknown): boolean {
  return isIsoCalendarDate(start) && isIsoCalendarDate(end) && start <= end;
}
