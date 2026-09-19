/**
 * Calendar time zone owner: resolution precedence (owner resolver, agent
 * `TIMEZONE` setting, host default), fail-closed handling of resolver
 * failures and invalid zones, and the owner-day calendar key. Deterministic
 * with a fake runtime; default-zone assertions compare against
 * `resolveDefaultTimeZone()` so they hold on any host.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  CALENDAR_TIME_ZONE_INVALID,
  CALENDAR_TIME_ZONE_UNAVAILABLE,
  type CalendarTimeZoneRuntime,
  calendarDateKey,
  registerCalendarTimeZoneResolver,
  resolveCalendarTimeZone,
  unregisterCalendarTimeZoneResolver,
} from "./calendar-time-zone";
import { LifeOpsServiceError } from "./service-error";
import { resolveDefaultTimeZone } from "./time-zone";

// 2026-03-03T03:30Z is still the evening of March 2 west of Greenwich and
// already the afternoon of March 3 in Tokyo: the window where a UTC-day
// comparison misclassifies a "2026-03-02" calendar date.
const NOW = new Date("2026-03-03T03:30:00.000Z");

function fakeRuntime(setting: unknown): CalendarTimeZoneRuntime {
  return { getSetting: (key) => (key === "TIMEZONE" ? setting : undefined) };
}

const runtimes: CalendarTimeZoneRuntime[] = [];
function runtimeWith(setting: unknown): CalendarTimeZoneRuntime {
  const runtime = fakeRuntime(setting);
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    unregisterCalendarTimeZoneResolver(runtime);
  }
});

describe("calendarDateKey", () => {
  it.each([
    ["UTC", "2026-03-03"],
    ["America/Los_Angeles", "2026-03-02"],
    ["Pacific/Honolulu", "2026-03-02"],
    ["Asia/Tokyo", "2026-03-03"],
  ])("reads %s as calendar day %s", (zone, expected) => {
    expect(calendarDateKey(NOW, zone)).toBe(expected);
  });

  it("zero-pads month and day", () => {
    expect(calendarDateKey(new Date("2026-01-05T12:00:00.000Z"), "UTC")).toBe(
      "2026-01-05",
    );
  });
});

describe("resolveCalendarTimeZone", () => {
  it("uses the host zone and says so when nothing is configured", async () => {
    const resolution = await resolveCalendarTimeZone(
      runtimeWith(undefined),
      NOW,
    );
    expect(resolution).toEqual({
      timeZone: resolveDefaultTimeZone(),
      source: "runtime-default",
    });
  });

  it("uses the agent TIMEZONE setting when no owner resolver is registered", async () => {
    const resolution = await resolveCalendarTimeZone(
      runtimeWith(" Pacific/Honolulu "),
      NOW,
    );
    expect(resolution).toEqual({
      timeZone: "Pacific/Honolulu",
      source: "agent-setting",
    });
  });

  it("prefers the registered owner zone over the agent setting", async () => {
    const runtime = runtimeWith("Asia/Tokyo");
    registerCalendarTimeZoneResolver(
      runtime,
      async () => "America/Los_Angeles",
    );
    expect(await resolveCalendarTimeZone(runtime, NOW)).toEqual({
      timeZone: "America/Los_Angeles",
      source: "owner",
    });
  });

  it("treats a null owner zone as absent configuration and continues to the setting", async () => {
    const runtime = runtimeWith("Pacific/Honolulu");
    registerCalendarTimeZoneResolver(runtime, async () => null);
    expect(await resolveCalendarTimeZone(runtime, NOW)).toEqual({
      timeZone: "Pacific/Honolulu",
      source: "agent-setting",
    });
  });

  it("scopes resolvers per runtime", async () => {
    const configured = runtimeWith(undefined);
    const other = runtimeWith(undefined);
    registerCalendarTimeZoneResolver(configured, async () => "Asia/Tokyo");
    expect((await resolveCalendarTimeZone(configured, NOW)).source).toBe(
      "owner",
    );
    expect((await resolveCalendarTimeZone(other, NOW)).source).toBe(
      "runtime-default",
    );
  });

  it("passes the instant to the resolver so travel-dependent zones can be derived", async () => {
    const runtime = runtimeWith(undefined);
    let seen: Date | null = null;
    registerCalendarTimeZoneResolver(runtime, async (_runtime, now) => {
      seen = now;
      return "UTC";
    });
    await resolveCalendarTimeZone(runtime, NOW);
    expect(seen).toBe(NOW);
  });

  it("fails closed when the owner resolver throws", async () => {
    const runtime = runtimeWith("America/Los_Angeles");
    const cause = new Error("fact store unavailable");
    registerCalendarTimeZoneResolver(runtime, async () => {
      throw cause;
    });
    const error = await resolveCalendarTimeZone(runtime, NOW).catch((e) => e);
    expect(error).toBeInstanceOf(LifeOpsServiceError);
    expect(error).toMatchObject({
      status: 503,
      code: CALENDAR_TIME_ZONE_UNAVAILABLE,
      cause,
    });
  });

  it("rejects an invalid owner zone instead of substituting the setting", async () => {
    const runtime = runtimeWith("America/Los_Angeles");
    registerCalendarTimeZoneResolver(runtime, async () => "Mars/Phobos");
    await expect(resolveCalendarTimeZone(runtime, NOW)).rejects.toMatchObject({
      status: 422,
      code: CALENDAR_TIME_ZONE_INVALID,
    });
  });

  it("rejects an invalid agent setting instead of substituting the host zone", async () => {
    await expect(
      resolveCalendarTimeZone(runtimeWith("not-a-zone"), NOW),
    ).rejects.toMatchObject({ status: 422, code: CALENDAR_TIME_ZONE_INVALID });
  });

  it("unregistering restores setting-based resolution", async () => {
    const runtime = runtimeWith("Asia/Tokyo");
    registerCalendarTimeZoneResolver(runtime, async () => "UTC");
    unregisterCalendarTimeZoneResolver(runtime);
    expect((await resolveCalendarTimeZone(runtime, NOW)).timeZone).toBe(
      "Asia/Tokyo",
    );
  });
});
