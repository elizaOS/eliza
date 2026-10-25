/** Parses bounded history limits for the TASKS action without loading the orchestrator runtime graph. */

/** Accepts positive canonical integers and otherwise preserves the caller's metric-specific fallback. */
export function parseHistoryLimit(value: unknown, fallback: number): number {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0
      ? Math.min(value, 100)
      : fallback;
  }
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(parsed, 100) : fallback;
}
