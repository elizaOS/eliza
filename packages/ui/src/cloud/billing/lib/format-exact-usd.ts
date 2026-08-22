/** Format an already-validated canonical USD decimal without Number coercion. */

const EXACT_NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function formatExactUsd(value: string): string {
  if (!EXACT_NON_NEGATIVE_DECIMAL.test(value)) return "\u2014";

  const [integer, rawFraction = ""] = value.split(".");
  const groupedInteger = BigInt(integer).toLocaleString("en-US", {
    maximumFractionDigits: 0,
    useGrouping: true,
  });
  const significantFraction = rawFraction.replace(/0+$/, "");
  const fraction = significantFraction.padEnd(2, "0");

  return `$${groupedInteger}.${fraction}`;
}
