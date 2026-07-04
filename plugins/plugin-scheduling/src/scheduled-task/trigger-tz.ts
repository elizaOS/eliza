/**
 * Trigger timezone helpers resolve owner-local cron triggers before they reach
 * the core scheduler.
 */
import type { OwnerFactsView } from "./types.js";

/** Sentinel cron timezone that resolves to the owner's current timezone. */
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
