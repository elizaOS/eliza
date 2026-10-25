/**
 * Trigger timezone helpers resolve owner-local cron triggers before they reach
 * the core scheduler.
 */
import { isValidTimeZone } from "@elizaos/contracts";
import type { OwnerFactsView } from "./types.js";

/** Sentinel cron timezone that resolves to the owner's current timezone. */
export const OWNER_LOCAL_TZ = "owner_local";

/**
 * Resolve a cron trigger's `tz` to a concrete IANA zone before it reaches
 * core's cron scheduler. `owner_local` resolves against owner facts, with an
 * explicit UTC fallback when the owner has no timezone on file. Any other
 * value passes through unchanged. Validation refuses an invalid IANA name on a
 * new trigger; core evaluates one stored before that check in UTC.
 */
export function resolveTriggerTz(
  tz: string,
  ownerFacts: OwnerFactsView | undefined,
): string {
  if (tz === OWNER_LOCAL_TZ) return ownerFacts?.timezone ?? "UTC";
  return tz;
}

/**
 * The time zone saved in the scheduling plugin settings ("Timezone",
 * DEFAULT_TIMEZONE), used for the owner when no owner timezone is on file.
 */
export function configuredDefaultTimeZone(runtime: {
  getSetting?: (key: string) => unknown;
}): string | undefined {
  const value = runtime.getSetting?.("DEFAULT_TIMEZONE");
  const zone = typeof value === "string" ? value.trim() : "";
  return zone && isValidTimeZone(zone) ? zone : undefined;
}
