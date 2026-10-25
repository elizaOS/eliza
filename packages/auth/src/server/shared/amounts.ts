const USD_SCALE_DECIMALS = 18;
const MAX_UINT256_DECIMAL =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const MAX_UINT256_DECIMAL_DIGITS = 78;

export function parseDecimalToScaled(
  value: string,
  scaleDecimals = USD_SCALE_DECIMALS,
): bigint | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const scaledFraction = fraction
    .slice(0, scaleDecimals)
    .padEnd(scaleDecimals, "0");
  return (
    BigInt(whole) * 10n ** BigInt(scaleDecimals) + BigInt(scaledFraction || "0")
  );
}

export function formatScaledDecimal(
  value: bigint,
  scaleDecimals = USD_SCALE_DECIMALS,
): string {
  const whole = value / 10n ** BigInt(scaleDecimals);
  const fraction = value % 10n ** BigInt(scaleDecimals);
  const trimmedFraction = fraction
    .toString()
    .padStart(scaleDecimals, "0")
    .replace(/0+$/, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole.toString();
}

export function priceToScaledText(price: number | null): string | null {
  if (price === null || !Number.isFinite(price) || price < 0) return null;
  const scaled = parseDecimalToScaled(price.toFixed(USD_SCALE_DECIMALS));
  return scaled === null ? null : formatScaledDecimal(scaled);
}

export function tokenAmountUsdText(
  balance: string,
  decimals: number,
  price: number | null,
): string | null {
  if (price === null || !Number.isFinite(price) || price < 0) return null;
  if (!/^\d+$/.test(balance) || !Number.isSafeInteger(decimals) || decimals < 0)
    return null;
  const scaledPrice = parseDecimalToScaled(price.toFixed(USD_SCALE_DECIMALS));
  if (scaledPrice === null) return null;
  const usdScaled = (BigInt(balance) * scaledPrice) / 10n ** BigInt(decimals);
  return formatScaledDecimal(usdScaled);
}

export function sumUsdText(values: Array<string | null>): string | null {
  let total = 0n;
  let hasValue = false;
  for (const value of values) {
    if (value === null) continue;
    const scaled = parseDecimalToScaled(value);
    if (scaled === null) continue;
    total += scaled;
    hasValue = true;
  }
  return hasValue ? formatScaledDecimal(total) : null;
}

export function isUint256DecimalString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  const normalized = value.replace(/^0+/, "") || "0";
  if (normalized.length > MAX_UINT256_DECIMAL_DIGITS) return false;
  return (
    normalized.length < MAX_UINT256_DECIMAL_DIGITS ||
    normalized <= MAX_UINT256_DECIMAL
  );
}
