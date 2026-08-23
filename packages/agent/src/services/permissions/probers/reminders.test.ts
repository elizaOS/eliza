/**
 * Behavioral coverage for the reminders EventKit permission prober. Drives the
 * real remindersProber with live buildState / mapNativePrivacyAuthStatus
 * mapping: non-Darwin short-circuit, native auth codes including write-only
 * (4), TCC fallback when the dylib is missing, and request() lastRequested
 * stamping. Native dylib, TCC, and System Settings are stubbed OS
 * collaborators.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const darwin = vi.hoisted(() => ({ current: true }));
const getNativeDylib = vi.hoisted(() => vi.fn());
const queryTccStatus = vi.hoisted(() => vi.fn());
const resolveBundleId = vi.hoisted(() =>
  vi.fn(() => "ai.elizaos.reminders-test"),
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

import { platformUnsupportedState } from "./_bridge.js";
import { remindersProber } from "./reminders.ts";

const REMINDERS_TCC_SERVICE = "kTCCServiceReminders";
const BUNDLE_ID = "ai.elizaos.reminders-test";

function nativeReminders(check: number, request = check) {
  return {
    checkRemindersPermission: () => check,
    requestRemindersPermission: () => request,
  };
}

function resetCollaborators(): void {
  darwin.current = true;
  getNativeDylib.mockReset();
  queryTccStatus.mockReset();
  resolveBundleId.mockReset();
  resolveBundleId.mockReturnValue(BUNDLE_ID);
  openPrivacyPane.mockReset();
  openPrivacyPane.mockResolvedValue(undefined);
}

describe("remindersProber", () => {
  beforeEach(resetCollaborators);

  afterEach(() => {
    darwin.current = true;
  });

  it("exports id reminders without openSettings", () => {
    expect(remindersProber.id).toBe("reminders");
    expect(remindersProber.openSettings).toBeUndefined();
    expect(typeof remindersProber.check).toBe("function");
    expect(typeof remindersProber.request).toBe("function");
  });
});

describe("remindersProber.check", () => {
  beforeEach(resetCollaborators);

  it("returns platform-unsupported on non-Darwin without probing native or TCC", async () => {
    darwin.current = false;
    const state = await remindersProber.check();
    const expected = platformUnsupportedState("reminders");
    expect(state).toEqual({
      ...expected,
      lastChecked: state.lastChecked,
    });
    expect(state.id).toBe("reminders");
    expect(state.status).toBe("not-applicable");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBe("platform_unsupported");
    expect(state.lastRequested).toBeUndefined();
    expect(getNativeDylib).not.toHaveBeenCalled();
    expect(queryTccStatus).not.toHaveBeenCalled();
    expect(resolveBundleId).not.toHaveBeenCalled();
    expect(openPrivacyPane).not.toHaveBeenCalled();
  });

  it("maps native granted (2) without consulting TCC", async () => {
    getNativeDylib.mockResolvedValue(nativeReminders(2));
    const before = Date.now();
    const state = await remindersProber.check();
    expect(state.status).toBe("granted");
    expect(state.id).toBe("reminders");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBeUndefined();
    expect(state.lastRequested).toBeUndefined();
    expect(state.reason).toBeUndefined();
    expect(state.lastChecked).toBeGreaterThanOrEqual(before);
    expect(queryTccStatus).not.toHaveBeenCalled();
    expect(resolveBundleId).not.toHaveBeenCalled();
  });

  it("maps native denied (1) without consulting TCC", async () => {
    getNativeDylib.mockResolvedValue(nativeReminders(1));
    const state = await remindersProber.check();
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBeUndefined();
    expect(queryTccStatus).not.toHaveBeenCalled();
  });

  it("maps native not-determined (0) as requestable", async () => {
    getNativeDylib.mockResolvedValue(nativeReminders(0));
    const state = await remindersProber.check();
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(state.restrictedReason).toBeUndefined();
  });

  it("maps native restricted (3) with os_policy and canRequest false", async () => {
    getNativeDylib.mockResolvedValue(nativeReminders(3));
    const state = await remindersProber.check();
    expect(state.status).toBe("restricted");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBe("os_policy");
  });

  it("maps native write-only (4) as restricted but still requestable", async () => {
    getNativeDylib.mockResolvedValue(nativeReminders(4));
    const state = await remindersProber.check();
    expect(state.status).toBe("restricted");
    expect(state.canRequest).toBe(true);
    expect(state.restrictedReason).toBe("os_policy");
  });

  it("maps unknown native codes to not-determined", async () => {
    getNativeDylib.mockResolvedValue(nativeReminders(99));
    const state = await remindersProber.check();
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(state.restrictedReason).toBeUndefined();
  });

  it("maps a negative native code to not-determined", async () => {
    getNativeDylib.mockResolvedValue(nativeReminders(-1));
    const state = await remindersProber.check();
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
  });

  it("falls back to TCC granted when the dylib is missing", async () => {
    getNativeDylib.mockResolvedValue(null);
    queryTccStatus.mockResolvedValue("granted");
    const state = await remindersProber.check();
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBeUndefined();
    expect(queryTccStatus).toHaveBeenCalledWith(
      REMINDERS_TCC_SERVICE,
      BUNDLE_ID,
    );
  });

  it("falls back to TCC denied when the dylib is missing", async () => {
    getNativeDylib.mockResolvedValue(null);
    queryTccStatus.mockResolvedValue("denied");
    const state = await remindersProber.check();
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(queryTccStatus).toHaveBeenCalledWith(
      REMINDERS_TCC_SERVICE,
      BUNDLE_ID,
    );
  });

  it("treats a missing TCC row as not-determined and requestable", async () => {
    getNativeDylib.mockResolvedValue(null);
    queryTccStatus.mockResolvedValue(null);
    const state = await remindersProber.check();
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(state.lastRequested).toBeUndefined();
    expect(queryTccStatus).toHaveBeenCalledWith(
      REMINDERS_TCC_SERVICE,
      BUNDLE_ID,
    );
  });
});

describe("remindersProber.request", () => {
  beforeEach(resetCollaborators);

  it("returns platform-unsupported on non-Darwin without lastRequested", async () => {
    darwin.current = false;
    const state = await remindersProber.request({ reason: "unit-test" });
    const expected = platformUnsupportedState("reminders");
    expect(state).toEqual({
      ...expected,
      lastChecked: state.lastChecked,
    });
    expect(state.status).toBe("not-applicable");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBe("platform_unsupported");
    expect(state.lastRequested).toBeUndefined();
    expect(getNativeDylib).not.toHaveBeenCalled();
    expect(openPrivacyPane).not.toHaveBeenCalled();
    expect(queryTccStatus).not.toHaveBeenCalled();
  });

  it("uses the native request result and stamps lastRequested", async () => {
    const requestRemindersPermission = vi.fn(() => 2);
    const checkRemindersPermission = vi.fn(() => {
      throw new Error(
        "checkRemindersPermission must not run on native request",
      );
    });
    getNativeDylib.mockResolvedValue({
      checkRemindersPermission,
      requestRemindersPermission,
    });
    const before = Date.now();
    const state = await remindersProber.request({ reason: "unit-test" });
    const after = Date.now();
    expect(requestRemindersPermission).toHaveBeenCalledTimes(1);
    expect(checkRemindersPermission).not.toHaveBeenCalled();
    expect(openPrivacyPane).not.toHaveBeenCalled();
    expect(queryTccStatus).not.toHaveBeenCalled();
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(state.lastRequested).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeLessThanOrEqual(after);
  });

  it("maps a native write-only request (4) as restricted and requestable", async () => {
    getNativeDylib.mockResolvedValue(nativeReminders(0, 4));
    const state = await remindersProber.request({ reason: "unit-test" });
    expect(state.status).toBe("restricted");
    expect(state.canRequest).toBe(true);
    expect(state.restrictedReason).toBe("os_policy");
    expect(state.lastRequested).toBeTypeOf("number");
  });

  it("maps a native denied request without opening System Settings", async () => {
    getNativeDylib.mockResolvedValue(nativeReminders(0, 1));
    const state = await remindersProber.request({ reason: "unit-test" });
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(state.lastRequested).toBeTypeOf("number");
    expect(openPrivacyPane).not.toHaveBeenCalled();
  });

  it("opens the Reminders privacy pane and re-checks TCC when the dylib is missing", async () => {
    getNativeDylib.mockResolvedValue(null);
    queryTccStatus.mockResolvedValue("denied");
    const before = Date.now();
    const state = await remindersProber.request({ reason: "unit-test" });
    const after = Date.now();
    expect(openPrivacyPane).toHaveBeenCalledTimes(1);
    expect(openPrivacyPane).toHaveBeenCalledWith("Reminders");
    expect(queryTccStatus).toHaveBeenCalledWith(
      REMINDERS_TCC_SERVICE,
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
    const state = await remindersProber.request({ reason: "unit-test" });
    expect(openPrivacyPane).toHaveBeenCalledWith("Reminders");
    expect(state.status).toBe("granted");
    expect(state.lastRequested).toBeTypeOf("number");
  });

  it("keeps a missing TCC row requestable after opening settings", async () => {
    getNativeDylib.mockResolvedValue(null);
    queryTccStatus.mockResolvedValue(null);
    const state = await remindersProber.request({ reason: "need reminders" });
    expect(openPrivacyPane).toHaveBeenCalledWith("Reminders");
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(state.lastRequested).toBeTypeOf("number");
  });

  it("does not copy the caller reason onto the returned state", async () => {
    getNativeDylib.mockResolvedValue(nativeReminders(2));
    const state = await remindersProber.request({
      reason: "distinct-caller-reason",
    });
    expect(state.reason).toBeUndefined();
    expect(state.status).toBe("granted");
  });
});
