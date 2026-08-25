/**
 * Behavioral coverage for the calendar EventKit permission prober. Drives the
 * real calendarProber with live buildState / mapNativePrivacyAuthStatus mapping:
 * non-Darwin short-circuit, native auth codes including write-only (4), TCC
 * fallback when the dylib is missing, and request() lastRequested stamping.
 * Native dylib, TCC, and System Settings are stubbed OS collaborators.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const darwin = vi.hoisted(() => ({ current: true }));
const getNativeDylib = vi.hoisted(() => vi.fn());
const queryTccStatus = vi.hoisted(() => vi.fn());
const resolveBundleId = vi.hoisted(() =>
  vi.fn(() => "ai.elizaos.calendar-test"),
);
const openPrivacyPane = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./_bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_bridge.js")>();
  return {
    ...actual,
    get IS_DARWIN() {
      return darwin.current;
    },
    getNativeDylib,
    queryTccStatus,
    resolveBundleId,
    openPrivacyPane,
  };
});

import { calendarProber } from "./calendar.js";

const CALENDAR_TCC_SERVICE = "kTCCServiceCalendar";
const BUNDLE_ID = "ai.elizaos.calendar-test";

function nativeCalendar(check: number, request = check) {
  return {
    checkCalendarPermission: () => check,
    requestCalendarPermission: () => request,
  };
}

describe("calendarProber", () => {
  beforeEach(() => {
    darwin.current = true;
    getNativeDylib.mockReset();
    queryTccStatus.mockReset();
    resolveBundleId.mockReset();
    resolveBundleId.mockReturnValue(BUNDLE_ID);
    openPrivacyPane.mockReset();
    openPrivacyPane.mockResolvedValue(undefined);
  });

  afterEach(() => {
    darwin.current = true;
  });

  it("exports id calendar", () => {
    expect(calendarProber.id).toBe("calendar");
  });
});

describe("calendarProber.check", () => {
  beforeEach(() => {
    darwin.current = true;
    getNativeDylib.mockReset();
    queryTccStatus.mockReset();
    resolveBundleId.mockReset();
    resolveBundleId.mockReturnValue(BUNDLE_ID);
    openPrivacyPane.mockReset();
  });

  it("returns platform-unsupported on non-Darwin without probing native or TCC", async () => {
    darwin.current = false;
    const state = await calendarProber.check();
    expect(state.id).toBe("calendar");
    expect(state.status).toBe("not-applicable");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBe("platform_unsupported");
    expect(getNativeDylib).not.toHaveBeenCalled();
    expect(queryTccStatus).not.toHaveBeenCalled();
  });

  it("maps native granted (2) without consulting TCC", async () => {
    getNativeDylib.mockResolvedValue(nativeCalendar(2));
    const state = await calendarProber.check();
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBeUndefined();
    expect(queryTccStatus).not.toHaveBeenCalled();
  });

  it("maps native denied (1) without consulting TCC", async () => {
    getNativeDylib.mockResolvedValue(nativeCalendar(1));
    const state = await calendarProber.check();
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBeUndefined();
    expect(queryTccStatus).not.toHaveBeenCalled();
  });

  it("maps native not-determined (0) as requestable", async () => {
    getNativeDylib.mockResolvedValue(nativeCalendar(0));
    const state = await calendarProber.check();
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(state.restrictedReason).toBeUndefined();
  });

  it("maps native restricted (3) with os_policy and canRequest false", async () => {
    getNativeDylib.mockResolvedValue(nativeCalendar(3));
    const state = await calendarProber.check();
    expect(state.status).toBe("restricted");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBe("os_policy");
  });

  it("maps native write-only (4) as restricted but still requestable", async () => {
    getNativeDylib.mockResolvedValue(nativeCalendar(4));
    const state = await calendarProber.check();
    expect(state.status).toBe("restricted");
    expect(state.canRequest).toBe(true);
    expect(state.restrictedReason).toBe("os_policy");
  });

  it("maps unknown native codes to not-determined", async () => {
    getNativeDylib.mockResolvedValue(nativeCalendar(99));
    const state = await calendarProber.check();
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
  });

  it("falls back to TCC granted when the dylib is missing", async () => {
    getNativeDylib.mockResolvedValue(null);
    queryTccStatus.mockResolvedValue("granted");
    const state = await calendarProber.check();
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(queryTccStatus).toHaveBeenCalledWith(
      CALENDAR_TCC_SERVICE,
      BUNDLE_ID,
    );
  });

  it("falls back to TCC denied when the dylib is missing", async () => {
    getNativeDylib.mockResolvedValue(null);
    queryTccStatus.mockResolvedValue("denied");
    const state = await calendarProber.check();
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(queryTccStatus).toHaveBeenCalledWith(
      CALENDAR_TCC_SERVICE,
      BUNDLE_ID,
    );
  });

  it("treats a missing TCC row as not-determined and requestable", async () => {
    getNativeDylib.mockResolvedValue(null);
    queryTccStatus.mockResolvedValue(null);
    const state = await calendarProber.check();
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(queryTccStatus).toHaveBeenCalledWith(
      CALENDAR_TCC_SERVICE,
      BUNDLE_ID,
    );
  });
});

describe("calendarProber.request", () => {
  beforeEach(() => {
    darwin.current = true;
    getNativeDylib.mockReset();
    queryTccStatus.mockReset();
    resolveBundleId.mockReset();
    resolveBundleId.mockReturnValue(BUNDLE_ID);
    openPrivacyPane.mockReset();
    openPrivacyPane.mockResolvedValue(undefined);
  });

  it("returns platform-unsupported on non-Darwin without lastRequested", async () => {
    darwin.current = false;
    const state = await calendarProber.request({ reason: "unit-test" });
    expect(state.status).toBe("not-applicable");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBe("platform_unsupported");
    expect(state.lastRequested).toBeUndefined();
    expect(getNativeDylib).not.toHaveBeenCalled();
    expect(openPrivacyPane).not.toHaveBeenCalled();
  });

  it("uses the native request result and stamps lastRequested", async () => {
    const requestCalendarPermission = vi.fn(() => 2);
    const checkCalendarPermission = vi.fn(() => {
      throw new Error("checkCalendarPermission must not run on native request");
    });
    getNativeDylib.mockResolvedValue({
      checkCalendarPermission,
      requestCalendarPermission,
    });
    const before = Date.now();
    const state = await calendarProber.request({ reason: "unit-test" });
    const after = Date.now();
    expect(requestCalendarPermission).toHaveBeenCalledTimes(1);
    expect(checkCalendarPermission).not.toHaveBeenCalled();
    expect(openPrivacyPane).not.toHaveBeenCalled();
    expect(queryTccStatus).not.toHaveBeenCalled();
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(state.lastRequested).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeLessThanOrEqual(after);
  });

  it("maps a native write-only request (4) as restricted and requestable", async () => {
    getNativeDylib.mockResolvedValue(nativeCalendar(0, 4));
    const state = await calendarProber.request({ reason: "unit-test" });
    expect(state.status).toBe("restricted");
    expect(state.canRequest).toBe(true);
    expect(state.restrictedReason).toBe("os_policy");
    expect(state.lastRequested).toBeTypeOf("number");
  });

  it("opens the Calendars privacy pane and re-checks TCC when the dylib is missing", async () => {
    getNativeDylib.mockResolvedValue(null);
    queryTccStatus.mockResolvedValue("denied");
    const before = Date.now();
    const state = await calendarProber.request({ reason: "unit-test" });
    const after = Date.now();
    expect(openPrivacyPane).toHaveBeenCalledTimes(1);
    expect(openPrivacyPane).toHaveBeenCalledWith("Calendars");
    expect(queryTccStatus).toHaveBeenCalledWith(
      CALENDAR_TCC_SERVICE,
      BUNDLE_ID,
    );
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(state.lastRequested).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeLessThanOrEqual(after);
  });

  it("stamps lastRequested on the TCC granted fallback after opening settings", async () => {
    getNativeDylib.mockResolvedValue(null);
    queryTccStatus.mockResolvedValue("granted");
    const state = await calendarProber.request({ reason: "unit-test" });
    expect(openPrivacyPane).toHaveBeenCalledWith("Calendars");
    expect(state.status).toBe("granted");
    expect(state.lastRequested).toBeTypeOf("number");
  });
});
