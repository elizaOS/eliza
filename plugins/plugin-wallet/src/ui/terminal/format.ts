/** Display formatting for crypto terminal prices, changes, and quantities. */

export function formatTerminalUsd(value: number): string {
  const digits = Math.abs(value) >= 1 ? 2 : Math.abs(value) >= 0.01 ? 4 : 8;
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  });
}

export function formatTerminalChange(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

export function formatTerminalUnits(units: number): string {
  return units.toLocaleString("en-US", { maximumFractionDigits: 8 });
}
