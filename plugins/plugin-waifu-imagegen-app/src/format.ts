/** Format a USD amount, using extra precision for sub-cent values. */
export function formatUsd(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}
