/**
 * Numeric parsing boundary for app credit balance rows and aggregate reads.
 */

export function parseAppCreditBalanceNumber(
  value: string | number | null | undefined,
  fieldName: string,
): number {
  if (value === null || value === undefined) {
    throw new Error(`Unable to read app credit balance ${fieldName}`);
  }
  if (typeof value === "string" && !/^[+-]?(?:\d+|\d*\.\d+)$/.test(value.trim())) {
    throw new Error(`Unable to read app credit balance ${fieldName}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to read app credit balance ${fieldName}`);
  }
  return parsed;
}
