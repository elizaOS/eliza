/** Parses optional timestamps and normalizes inference confidence across domains. */

/** Parse an ISO timestamp to milliseconds, returning null on any failure. */
export function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resolve an exact YYYY-MM-DDTHH:mm in the supplied zone. Invalid dates/zones,
 * skipped wall times and repeated wall times return null: callers must obtain
 * an unambiguous input instead of silently choosing an offset or a host zone.
 * This is input validation, not the compatible disambiguation used by recurring
 * schedulers. No clock, locale, host-zone fallback or execution policy is used.
 */
export function parseUnambiguousZonedDateTime(
  local: unknown,
  timeZone: unknown,
): number | null {
  const match =
    typeof local === "string" &&
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match || typeof timeZone !== "string" || !timeZone.trim()) return null;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]),
    hour = Number(match[4]),
    minute = Number(match[5]);
  if (!year || year < 1 || year > 9999) return null;
  // Date.UTC maps years 0..99 to 1900..1999. Explicit full-year setters avoid
  // that coercion, and the round trip rejects calendar normalization.
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, 0, 0);
  if (
    wall.getUTCFullYear() !== year ||
    wall.getUTCMonth() + 1 !== month ||
    wall.getUTCDate() !== day ||
    wall.getUTCHours() !== hour ||
    wall.getUTCMinutes() !== minute
  )
    return null;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      era: "short",
    });
  } catch {
    // Unknown zone is invalid input; never substitute the runtime's zone.
    return null;
  }
  const parts = (instant: number) =>
    Object.fromEntries(
      formatter.formatToParts(instant).map((p) => [p.type, p.value]),
    );
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = wall.getTime() + hours * 3600000;
    const p = parts(instant);
    const equivalent = new Date(0);
    equivalent.setUTCFullYear(
      p.era === "BC" ? 1 - Number(p.year) : Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
    );
    equivalent.setUTCHours(
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
      0,
    );
    offsets.add(equivalent.getTime() - instant);
  }
  const candidates = [...offsets]
    .map((offset) => wall.getTime() - offset)
    .filter((instant) => {
      const p = parts(instant);
      return (
        p.era === "AD" &&
        Number(p.year) === year &&
        Number(p.month) === month &&
        Number(p.day) === day &&
        Number(p.hour) === hour &&
        Number(p.minute) === minute &&
        Number(p.second) === 0
      );
    });
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/** Clamp a 0-1 confidence value and round to two decimals. */
export function roundConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}
