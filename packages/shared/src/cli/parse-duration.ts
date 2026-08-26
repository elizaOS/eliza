/**
 * Parses a duration string (`500ms`, `30s`, `5m`, `2h`, `1d`) to milliseconds,
 * with a configurable default unit for bare numbers. Throws on empty or
 * unparseable input. Used by config zod schemas and CLI flag parsing.
 */
export type DurationMsParseOptions = {
  defaultUnit?: "ms" | "s" | "m" | "h" | "d";
};

export function parseDurationMs(
  raw: string,
  opts?: DurationMsParseOptions,
): number {
  if (typeof raw !== "string") {
    throw new Error("invalid duration (empty)");
  }
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    throw new Error("invalid duration (empty)");
  }

  const m =
    /^(\d+(?:\.\d+)?)\s*(milliseconds?|millis|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)?$/.exec(
      trimmed,
    );
  if (!m) {
    throw new Error(`invalid duration: ${raw}`);
  }

  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid duration: ${raw}`);
  }

  const rawUnit = m[2];
  let unit: "ms" | "s" | "m" | "h" | "d";
  if (!rawUnit) {
    unit = opts?.defaultUnit ?? "ms";
  } else if (
    rawUnit === "ms" ||
    rawUnit === "millis" ||
    rawUnit.startsWith("milli")
  ) {
    unit = "ms";
  } else if (rawUnit === "s" || rawUnit.startsWith("sec")) {
    unit = "s";
  } else if (rawUnit === "m" || rawUnit.startsWith("min")) {
    unit = "m";
  } else if (
    rawUnit === "h" ||
    rawUnit.startsWith("hr") ||
    rawUnit.startsWith("hour")
  ) {
    unit = "h";
  } else if (rawUnit === "d" || rawUnit.startsWith("day")) {
    unit = "d";
  } else {
    unit = opts?.defaultUnit ?? "ms";
  }
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  const milliseconds = value * multiplier;
  if (
    !Number.isFinite(milliseconds) ||
    !Number.isSafeInteger(Math.round(milliseconds))
  ) {
    throw new Error(`invalid duration: ${raw}`);
  }
  return Math.round(milliseconds);
}
