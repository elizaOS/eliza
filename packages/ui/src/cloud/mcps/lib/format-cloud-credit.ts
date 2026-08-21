/** Formats MCP cloud-credit amounts without rounding micro-prices down to zero. */

const CLOUD_CREDIT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 15,
});

export function formatCloudCreditUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${CLOUD_CREDIT_FORMATTER.format(value)}`;
}
