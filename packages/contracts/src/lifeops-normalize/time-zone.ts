/**
 * Time-zone normalization helpers (runtime-level primitives).
 *
 * Pure `Intl`-backed helpers for resolving and validating IANA time zones.
 * No DB, no plugin imports. Consumed by the LifeOps normalize primitives and by
 * `@elizaos/plugin-personal-assistant` (which re-exports them from
 * `lifeops/defaults.ts` for historical import paths).
 */

export function resolveDefaultTimeZone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return resolved && resolved.trim().length > 0 ? resolved : "UTC";
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    // error-policy:J3 invalid IANA time zone -> false
    return false;
  }
}

/**
 * UTC spellings a model routinely emits as a timezone value. A planner that
 * reads a Zulu-suffixed datetime ("2026-08-19T14:00:00Z") happily stamps
 * `timeZone: "Z"`; Intl rejects that and, pre-normalization, the whole
 * calendar create failed at the action boundary with "Invalid time zone
 * specified: Z" (observed live). Zulu and zero-offset spellings ARE UTC —
 * mapping them here (rather than falling through to the deployment default)
 * preserves the instant the model actually meant.
 */
const UTC_ALIAS_RE =
  /^(?:z|zulu|utc|gmt|etc\/utc|etc\/gmt|utc[+-]0{1,2}(?::?00)?|gmt[+-]0{1,2}(?::?00)?|[+-]00:?00)$/i;

export function normalizeTimeZone(timeZone?: string | null): string {
  const candidate = typeof timeZone === "string" ? timeZone.trim() : "";
  if (UTC_ALIAS_RE.test(candidate)) {
    return "UTC";
  }
  if (candidate && isValidTimeZone(candidate)) {
    return candidate;
  }
  return resolveDefaultTimeZone();
}
