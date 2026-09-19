/**
 * One owner for the calendar time zone a runtime's domain services reason in.
 *
 * Bill dueness, day boundaries and similar calendar judgments must agree
 * across every surface that reaches the same runtime (chat action, HTTP route,
 * briefing). A domain plugin that owns the user's zone (the personal-assistant
 * owner facts) registers one resolver per runtime; every consumer resolves
 * through `resolveCalendarTimeZone`, so the answer cannot differ by caller.
 * The registration lives on the runtime object under a global symbol, so a
 * consumer that loaded another copy of this module (dist versus source, or a
 * bundled duplicate) still finds the same resolver.
 *
 * Resolution is fail-closed: a registered resolver that throws, or a zone
 * (from the resolver or the agent `TIMEZONE` setting) that Intl rejects, is a
 * `LifeOpsServiceError` the caller surfaces, never a quiet substitution of
 * another zone. Absent configuration is not a failure: with no owner zone and
 * no setting, the runtime host zone is used and reported as such.
 */
import { LifeOpsServiceError } from "./service-error.js";
import { isValidTimeZone, resolveDefaultTimeZone } from "./time-zone.js";

/** Where the resolved zone came from, so callers can tell configured from defaulted. */
export type CalendarTimeZoneSource =
  | "owner"
  | "agent-setting"
  | "runtime-default";

export interface CalendarTimeZoneResolution {
  timeZone: string;
  source: CalendarTimeZoneSource;
}

/**
 * Supplies the owner's configured IANA zone at `now`, or null when no owner
 * zone is configured. Throwing means the configured zone could not be read;
 * `resolveCalendarTimeZone` turns that into a fail-closed error.
 */
export type CalendarTimeZoneResolver = (
  runtime: CalendarTimeZoneRuntime,
  now: Date,
) => Promise<string | null>;

/** The runtime surface this module needs: identity for the registry and the settings reader. */
export interface CalendarTimeZoneRuntime {
  getSetting(key: string): unknown;
}

export const CALENDAR_TIME_ZONE_UNAVAILABLE = "CALENDAR_TIME_ZONE_UNAVAILABLE";
export const CALENDAR_TIME_ZONE_INVALID = "CALENDAR_TIME_ZONE_INVALID";

const RESOLVER_KEY = Symbol.for("@elizaos/shared:calendar-time-zone-resolver");

interface CalendarTimeZoneResolverHost extends CalendarTimeZoneRuntime {
  [RESOLVER_KEY]?: CalendarTimeZoneResolver;
}

/** Registers the runtime's owner-zone resolver; a second registration replaces the first. */
export function registerCalendarTimeZoneResolver(
  runtime: CalendarTimeZoneRuntime,
  resolver: CalendarTimeZoneResolver,
): void {
  (runtime as CalendarTimeZoneResolverHost)[RESOLVER_KEY] = resolver;
}

/** Removes the runtime's resolver (teardown and tests). */
export function unregisterCalendarTimeZoneResolver(
  runtime: CalendarTimeZoneRuntime,
): void {
  delete (runtime as CalendarTimeZoneResolverHost)[RESOLVER_KEY];
}

function requireValidZone(
  timeZone: string,
  source: CalendarTimeZoneSource,
): string {
  const candidate = timeZone.trim();
  if (!candidate || !isValidTimeZone(candidate)) {
    throw new LifeOpsServiceError(
      422,
      `Configured calendar time zone "${timeZone}" (${source}) is not a valid IANA time zone`,
      CALENDAR_TIME_ZONE_INVALID,
    );
  }
  return candidate;
}

/**
 * Resolves the calendar zone for `runtime` at `now`: the registered owner
 * resolver first, then the agent `TIMEZONE` setting, then the host zone.
 */
export async function resolveCalendarTimeZone(
  runtime: CalendarTimeZoneRuntime,
  now: Date,
): Promise<CalendarTimeZoneResolution> {
  const resolver = (runtime as CalendarTimeZoneResolverHost)[RESOLVER_KEY];
  if (resolver) {
    let ownerZone: string | null;
    try {
      ownerZone = await resolver(runtime, now);
    } catch (error) {
      // error-policy:J2 the owner's zone exists but cannot be read; classifying
      // in another zone would be a silent wrong answer, so fail closed.
      throw Object.assign(
        new LifeOpsServiceError(
          503,
          "The owner's calendar time zone could not be resolved",
          CALENDAR_TIME_ZONE_UNAVAILABLE,
        ),
        { cause: error },
      );
    }
    if (ownerZone !== null) {
      return {
        timeZone: requireValidZone(ownerZone, "owner"),
        source: "owner",
      };
    }
  }
  const setting = runtime.getSetting("TIMEZONE");
  if (typeof setting === "string" && setting.trim().length > 0) {
    return {
      timeZone: requireValidZone(setting, "agent-setting"),
      source: "agent-setting",
    };
  }
  return { timeZone: resolveDefaultTimeZone(), source: "runtime-default" };
}

/**
 * `YYYY-MM-DD` for `now` as read on a calendar in `timeZone`. Bare date
 * strings stored from user text are calendar days in the owner's zone, so
 * comparisons against "today" must use this key, not the UTC day.
 */
export function calendarDateKey(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const read = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value;
  const year = read("year");
  const month = read("month");
  const day = read("day");
  if (!year || !month || !day) {
    throw new LifeOpsServiceError(
      500,
      `Unable to derive a calendar date in time zone "${timeZone}"`,
      CALENDAR_TIME_ZONE_INVALID,
    );
  }
  return `${year}-${month}-${day}`;
}
