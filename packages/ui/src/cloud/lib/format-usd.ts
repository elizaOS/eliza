/**
 * Local en-US USD formatter for the cloud surfaces. cloud-frontend imported
 * `formatUsd` from a cloud-shared package; ported locally here to avoid pulling a
 * server bundle into the client.
 *
 * Canonical shared copy for all cloud domains.
 */
export function formatUsd(value: number | string | null | undefined): string {
  const amount = typeof value === "string" ? Number.parseFloat(value) : value;
  if (amount == null || !Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}
