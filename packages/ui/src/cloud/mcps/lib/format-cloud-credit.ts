/** Formats MCP cloud-credit amounts without rounding micro-prices down to zero. */

const CLOUD_CREDIT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 15,
});

export function formatCloudCreditUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${CLOUD_CREDIT_FORMATTER.format(value)}`;
}

function formatExactCloudCreditUsd(value: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return "—";
  const [integer, rawFraction = ""] = value.split(".");
  const fraction = rawFraction.replace(/0+$/, "");
  const groupedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${groupedInteger}${fraction ? `.${fraction}` : ""}`;
}

/** Owner stats always render the persisted fee-inclusive debit authority. */
export function formatMcpUsageTotal(stats: {
  totalCloudCreditsCharged: string;
}): string {
  return formatExactCloudCreditUsd(stats.totalCloudCreditsCharged);
}
