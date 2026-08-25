/**
 * Parses a duration string (`500ms`, `30s`, `5m`, `2h`, `1d`) to milliseconds,
 * with a configurable default unit for bare numbers. Throws on empty or
 * unparseable input. Used by config zod schemas and CLI flag parsing.
 */
export type DurationMsParseOptions = {
  defaultUnit?: "ms" | "s" | "m" | "h" | "d" | "w";
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
    /^(\d+(?:\.\d+)?)(ms|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/.exec(
      trimmed,
    );
  if (!m) {
    throw new Error(`invalid duration: ${raw}`);
  }

  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid duration: ${raw}`);
  }

  const rawUnit = m[2] ?? opts?.defaultUnit ?? "ms";
  const multiplier = (() => {
    switch (rawUnit) {
      case "ms":
      case "millisecond":
      case "milliseconds":
        return 1;
      case "s":
      case "sec":
      case "secs":
      case "second":
      case "seconds":
        return 1000;
      case "m":
      case "min":
      case "mins":
      case "minute":
      case "minutes":
        return 60_000;
      case "h":
      case "hr":
      case "hrs":
      case "hour":
      case "hours":
        return 3_600_000;
      case "d":
      case "day":
      case "days":
        return 86_400_000;
      case "w":
      case "week":
      case "weeks":
        return 604_800_000;
      default:
        throw new Error(`invalid duration: ${raw}`);
    }
  })();
  const milliseconds = value * multiplier;
  if (
    !Number.isFinite(milliseconds) ||
    !Number.isSafeInteger(Math.round(milliseconds))
  ) {
    throw new Error(`invalid duration: ${raw}`);
  }
  return Math.round(milliseconds);
}
