/**
 * Parses a duration string (e.g. `500ms`, `500 ms`, `30s`, `20 seconds`, `5 mins`, `2h`, `1 day`)
 * to milliseconds, with a configurable default unit for bare numbers. Throws on empty or
 * unparseable input. Used by config zod schemas and CLI flag parsing.
 */
export type DurationMsParseOptions = {
  defaultUnit?: "ms" | "s" | "m" | "h" | "d";
};

const UNIT_ALIASES: Record<string, "ms" | "s" | "m" | "h" | "d"> = {
  ms: "ms",
  millis: "ms",
  millisecond: "ms",
  milliseconds: "ms",
  s: "s",
  sec: "s",
  secs: "s",
  second: "s",
  seconds: "s",
  m: "m",
  min: "m",
  mins: "m",
  minute: "m",
  minutes: "m",
  h: "h",
  hr: "h",
  hrs: "h",
  hour: "h",
  hours: "h",
  d: "d",
  day: "d",
  days: "d",
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
  } else {
    const mapped = UNIT_ALIASES[rawUnit];
    if (!mapped) {
      throw new Error(`invalid duration: ${raw}`);
    }
    unit = mapped;
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
