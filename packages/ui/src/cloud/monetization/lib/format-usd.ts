/**
 * Local USD formatter for the monetization cloud surfaces.
 *
 * The cloud-frontend originals imported `formatUsd` from
 * `@elizaos/shared/utils/format`, but `@elizaos/shared` does not export that
 * subpath and `@elizaos/ui` deliberately avoids pulling the shared server
 * bundle. This is the same en-US currency formatting, ported locally (matching
 * the `steward-url.ts` "port the helper rather than add a dependency" pattern in
 * this folder).
 */

export function formatUsd(value: number | string | null | undefined): string {
  const amount = typeof value === "string" ? Number.parseFloat(value) : value;
  if (amount == null || !Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}
