/**
 * Local en-US USD formatter for the cloud surfaces — canonical shared copy for
 * all cloud domains (kept local so the client never pulls a server bundle for
 * one formatter).
 */
export function formatUsd(value: number | string | null | undefined): string {
  const amount = typeof value === "string" ? Number.parseFloat(value) : value;
  if (amount == null || !Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}
