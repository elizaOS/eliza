/**
 * Local USD formatter for the admin cloud surfaces.
 *
 * The cloud-frontend redemptions client imported `formatUsd` from
 * `@elizaos/shared/utils/format`, but `@elizaos/shared` does not export that
 * subpath and `@elizaos/ui` deliberately avoids pulling the shared server
 * bundle. Same en-US currency formatting, ported locally (matching the
 * `monetization/lib/format-usd.ts` pattern in the sibling cloud domains).
 */

export function formatUsd(value: number | string | null | undefined): string {
  const amount = typeof value === "string" ? Number.parseFloat(value) : value;
  if (amount == null || !Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}
