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
    return false;
  }
}

export function normalizeTimeZone(timeZone?: string | null): string {
  const candidate = typeof timeZone === "string" ? timeZone.trim() : "";
  if (candidate && isValidTimeZone(candidate)) {
    return candidate;
  }
  return resolveDefaultTimeZone();
}
