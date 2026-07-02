import type { OwnerFactsView } from "./types.js";

/**
 * Sentinel `tz` value on cron triggers meaning "the owner's timezone,
 * whatever it currently is". Default task packs use it so a pack authored
 * once fires at the owner's local hour everywhere.
 */
export const OWNER_LOCAL_TZ = "owner_local";

/**
 * Resolve a cron trigger's `tz` to a concrete IANA zone before it reaches
 * core's cron scheduler. `owner_local` resolves against owner facts, with an
 * explicit UTC fallback when the owner has no timezone on file. Any other
 * value passes through unchanged — core warns once and evaluates in UTC for
 * invalid IANA names.
 */
export function resolveTriggerTz(
  tz: string,
  ownerFacts: OwnerFactsView | undefined,
): string {
  if (tz === OWNER_LOCAL_TZ) return ownerFacts?.timezone ?? "UTC";
  return tz;
}
