/** Browser-safe analytics display arithmetic shared by SDK consumers. */

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Return `(numerator / denominator) * 100`, or zero for an empty denominator. */
export function toRatePercent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return roundToOneDecimal((numerator / denominator) * 100);
}
