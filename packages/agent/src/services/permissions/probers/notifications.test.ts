/**
 * Unit coverage for the notifications permission prober. Drives the real
 * `notificationsProber` and `waitForAuthorizationDecision` so Darwin UN
 * status mapping, query-pending polling, request-vs-check timeouts, the
 * missing-dylib throw, and the non-Darwin renderer hand-off are asserted
 * against live `buildState` / `mapUNAuthStatus` output. Only `IS_DARWIN` and
 * the native dylib loader are stubbed OS collaborators.
 */
import { ElizaError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { darwin, mockGetNativeDylib } = vi.hoisted(() => ({
  darwin: { current: true },
  mockGetNativeDylib: vi.fn(),
}));

vi.mock("./_bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_bridge.js")>();
  return {
    ...actual,
    get IS_DARWIN() {
      return darwin.current;
    },
    getNativeDylib: mockGetNativeDylib,
  };
});

import {
  notificationsProber,
  waitForAuthorizationDecision,
} from "./notifications.ts";

const QUERY_PENDING = -2;

function nativeLib(check: number, request = check) {
  return {
    checkNotificationPermission: vi.fn(() => check),
    requestNotificationPermission: vi.fn(() => request),
  };
}

describe("notificationsProber", () => {
  beforeEach(() => {
    darwin.current = true;
    mockGetNativeDylib.mockReset();
    mockGetNativeDylib.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports id notifications without an openSettings helper", () => {
    expect(notificationsProber.id).toBe("notifications");
    expect(typeof notificationsProber.check).toBe("function");
    expect(typeof notificationsProber.request).toBe("function");
    expect(notificationsProber.openSettings).toBeUndefined();
  });
});

describe("waitForAuthorizationDecision", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately when requestAuthorization already produced a decision", async () => {
    const lib = nativeLib(0, 2);
    await expect(waitForAuthorizationDecision(lib)).resolves.toBe(2);
    expect(lib.requestNotificationPermission).toHaveBeenCalledTimes(1);
    expect(lib.checkNotificationPermission).not.toHaveBeenCalled();
  });

  it.each([
    [1, "denied"],
    [2, "granted"],
    [3, "restricted"],
    [4, "unknown-not-determined"],
    [-1, "native-failure"],
  ] as const)(
    "treats request status %i (%s) as a terminal decision without polling",
    async (status, _label) => {
      expect(_label).toEqual(expect.any(String));
      const lib = nativeLib(0, status);
      await expect(waitForAuthorizationDecision(lib)).resolves.toBe(status);
      expect(lib.checkNotificationPermission).not.toHaveBeenCalled();
    },
  );

  it("polls check() while request() is still not-determined (0)", async () => {
    vi.useFakeTimers();
    const lib = nativeLib(2, 0);
    const pending = waitForAuthorizationDecision(lib);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBe(2);
    expect(lib.requestNotificationPermission).toHaveBeenCalledTimes(1);
    expect(lib.checkNotificationPermission).toHaveBeenCalledTimes(1);
  });

  it("polls check() while request() is still query-pending (-2)", async () => {
    vi.useFakeTimers();
    const lib = nativeLib(1, QUERY_PENDING);
    const pending = waitForAuthorizationDecision(lib);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBe(1);
    expect(lib.checkNotificationPermission).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through an in-flight native query then a still-open prompt", async () => {
    vi.useFakeTimers();
    const checks = [QUERY_PENDING, 0, 3];
    const lib = {
      requestNotificationPermission: vi.fn(() => 0),
      checkNotificationPermission: vi.fn(() => checks.shift() ?? 3),
    };
    const pending = waitForAuthorizationDecision(lib);
    await vi.advanceTimersByTimeAsync(750);
    await expect(pending).resolves.toBe(3);
    expect(lib.checkNotificationPermission).toHaveBeenCalledTimes(3);
  });

  it("honours a caller-supplied poll interval when waiting for a grant", async () => {
    vi.useFakeTimers();
    const lib = nativeLib(2, 0);
    const pending = waitForAuthorizationDecision(lib, {
      timeoutMs: 1_000,
      pollIntervalMs: 40,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(39);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(2);
  });

  it("times out with NOTIFICATION_AUTHORIZATION_TIMEOUT when the prompt never decides", async () => {
    vi.useFakeTimers();
    const lib = nativeLib(0, 0);
    const pending = waitForAuthorizationDecision(lib, {
      timeoutMs: 500,
      pollIntervalMs: 250,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "ElizaError",
      code: "NOTIFICATION_AUTHORIZATION_TIMEOUT",
      context: { operation: "request", timeoutMs: 500 },
      severity: "ephemeral",
    });
    await vi.advanceTimersByTimeAsync(750);
    await rejection;
    await pending.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as Error).message).toMatch(
        /Timed out waiting for macOS notification authorization/,
      );
    });
  });

  it("times out when the native query stays pending at -2", async () => {
    vi.useFakeTimers();
    const lib = nativeLib(QUERY_PENDING, QUERY_PENDING);
    const pending = waitForAuthorizationDecision(lib, {
      timeoutMs: 200,
      pollIntervalMs: 50,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "NOTIFICATION_AUTHORIZATION_TIMEOUT",
      context: { operation: "request", timeoutMs: 200 },
    });
    await vi.advanceTimersByTimeAsync(300);
    await rejection;
  });
});

describe("notificationsProber.check", () => {
  beforeEach(() => {
    darwin.current = true;
    mockGetNativeDylib.mockReset();
    mockGetNativeDylib.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns not-determined with canRequest on non-Darwin without touching native", async () => {
    darwin.current = false;
    const before = Date.now();
    const state = await notificationsProber.check();
    expect(state).toMatchObject({
      id: "notifications",
      status: "not-determined",
      canRequest: true,
      platform: process.platform,
    });
    expect(state.lastChecked).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeUndefined();
    expect(state.restrictedReason).toBeUndefined();
    expect(state.reason).toBeUndefined();
    expect(mockGetNativeDylib).not.toHaveBeenCalled();
  });

  it("throws when Darwin has no native dylib", async () => {
    mockGetNativeDylib.mockResolvedValue(null);
    await expect(notificationsProber.check()).rejects.toMatchObject({
      name: "ElizaError",
      code: "NOTIFICATION_NATIVE_BRIDGE_UNAVAILABLE",
      severity: "fatal",
    });
    try {
      await notificationsProber.check();
      expect.unreachable("expected missing dylib to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as Error).message).toBe(
        "macOS notification permission bridge is unavailable",
      );
    }
    expect(mockGetNativeDylib).toHaveBeenCalled();
  });

  it.each([
    [0, "not-determined", true],
    [1, "denied", false],
    [2, "granted", false],
    [3, "restricted", false],
    [4, "not-determined", true],
  ] as const)(
    "maps native UN status %i to %s (canRequest=%s)",
    async (code, status, canRequest) => {
      const lib = nativeLib(code);
      mockGetNativeDylib.mockResolvedValue(lib);
      const before = Date.now();
      const state = await notificationsProber.check();
      expect(state.id).toBe("notifications");
      expect(state.status).toBe(status);
      expect(state.canRequest).toBe(canRequest);
      expect(state.platform).toBe(process.platform);
      expect(state.lastChecked).toBeGreaterThanOrEqual(before);
      expect(state.lastRequested).toBeUndefined();
      expect(state.restrictedReason).toBe(
        status === "restricted" ? "os_policy" : undefined,
      );
      expect(lib.requestNotificationPermission).not.toHaveBeenCalled();
    },
  );

  it("polls through query-pending then returns the settled grant", async () => {
    vi.useFakeTimers();
    const checks = [QUERY_PENDING, QUERY_PENDING, 2];
    const lib = {
      checkNotificationPermission: vi.fn(() => checks.shift() ?? 2),
      requestNotificationPermission: vi.fn(() => 0),
    };
    mockGetNativeDylib.mockResolvedValue(lib);
    const pending = notificationsProber.check();
    await vi.advanceTimersByTimeAsync(500);
    const state = await pending;
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(lib.checkNotificationPermission).toHaveBeenCalledTimes(3);
    expect(lib.requestNotificationPermission).not.toHaveBeenCalled();
  });

  it("times out when Darwin check stays query-pending", async () => {
    vi.useFakeTimers();
    const lib = nativeLib(QUERY_PENDING);
    mockGetNativeDylib.mockResolvedValue(lib);
    const pending = notificationsProber.check();
    const rejection = expect(pending).rejects.toMatchObject({
      name: "ElizaError",
      code: "NOTIFICATION_AUTHORIZATION_TIMEOUT",
      context: { operation: "check", timeoutMs: 2_000 },
      severity: "ephemeral",
    });
    await vi.advanceTimersByTimeAsync(2_250);
    await rejection;
    await pending.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as Error).message).toMatch(
        /Timed out reading macOS notification authorization/,
      );
    });
    expect(lib.requestNotificationPermission).not.toHaveBeenCalled();
  });

  it("propagates a negative native status as NOTIFICATION_AUTHORIZATION_FAILED", async () => {
    mockGetNativeDylib.mockResolvedValue(nativeLib(-1));
    await expect(notificationsProber.check()).rejects.toMatchObject({
      name: "ElizaError",
      code: "NOTIFICATION_AUTHORIZATION_FAILED",
      context: { nativeStatus: -1 },
      severity: "fatal",
    });
  });
});

describe("notificationsProber.request", () => {
  beforeEach(() => {
    darwin.current = true;
    mockGetNativeDylib.mockReset();
    mockGetNativeDylib.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns not-determined on non-Darwin without lastRequested or native I/O", async () => {
    darwin.current = false;
    const state = await notificationsProber.request({ reason: "unit-test" });
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(state.id).toBe("notifications");
    expect(state.lastRequested).toBeUndefined();
    expect(state.restrictedReason).toBeUndefined();
    expect(mockGetNativeDylib).not.toHaveBeenCalled();
  });

  it("throws when Darwin has no native dylib", async () => {
    mockGetNativeDylib.mockResolvedValue(null);
    await expect(
      notificationsProber.request({ reason: "unit-test" }),
    ).rejects.toMatchObject({
      code: "NOTIFICATION_NATIVE_BRIDGE_UNAVAILABLE",
      severity: "fatal",
    });
  });

  it("invokes native request and stamps lastRequested when granted immediately", async () => {
    const lib = nativeLib(2, 2);
    mockGetNativeDylib.mockResolvedValue(lib);
    const before = Date.now();
    const state = await notificationsProber.request({ reason: "unit-test" });
    const after = Date.now();
    expect(lib.requestNotificationPermission).toHaveBeenCalledTimes(1);
    expect(lib.checkNotificationPermission).not.toHaveBeenCalled();
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(state.lastRequested).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeLessThanOrEqual(after);
    expect(state.restrictedReason).toBeUndefined();
  });

  it("maps an immediate denial without polling check()", async () => {
    const lib = nativeLib(0, 1);
    mockGetNativeDylib.mockResolvedValue(lib);
    const state = await notificationsProber.request({ reason: "unit-test" });
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(state.lastRequested).toBeTypeOf("number");
    expect(lib.checkNotificationPermission).not.toHaveBeenCalled();
  });

  it("stamps lastRequested and os_policy when the OS reports restricted", async () => {
    mockGetNativeDylib.mockResolvedValue(nativeLib(3, 3));
    const state = await notificationsProber.request({ reason: "unit-test" });
    expect(state.status).toBe("restricted");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBe("os_policy");
    expect(state.lastRequested).toBeTypeOf("number");
  });

  it("maps unknown positive UN status 4 to not-determined and still stamps lastRequested", async () => {
    mockGetNativeDylib.mockResolvedValue(nativeLib(4, 4));
    const state = await notificationsProber.request({ reason: "unit-test" });
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(state.lastRequested).toBeTypeOf("number");
  });

  it("re-checks after request so a grant that lands during the prompt is returned", async () => {
    vi.useFakeTimers();
    const lib = nativeLib(2, 0);
    mockGetNativeDylib.mockResolvedValue(lib);
    const pending = notificationsProber.request({ reason: "unit-test" });
    await vi.advanceTimersByTimeAsync(250);
    const state = await pending;
    expect(lib.requestNotificationPermission).toHaveBeenCalledTimes(1);
    expect(lib.checkNotificationPermission).toHaveBeenCalledTimes(1);
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(state.lastRequested).toBeTypeOf("number");
  });

  it("does not copy the caller reason onto the returned state", async () => {
    mockGetNativeDylib.mockResolvedValue(nativeLib(2, 2));
    const state = await notificationsProber.request({
      reason: "distinct-caller-reason",
    });
    expect(state.reason).toBeUndefined();
    expect(state.status).toBe("granted");
  });

  it("propagates a negative native request decision as NOTIFICATION_AUTHORIZATION_FAILED", async () => {
    mockGetNativeDylib.mockResolvedValue(nativeLib(0, -1));
    await expect(
      notificationsProber.request({ reason: "unit-test" }),
    ).rejects.toMatchObject({
      code: "NOTIFICATION_AUTHORIZATION_FAILED",
      context: { nativeStatus: -1 },
      severity: "fatal",
    });
  });
});
