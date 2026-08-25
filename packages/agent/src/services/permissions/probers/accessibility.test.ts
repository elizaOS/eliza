/**
 * Behavioral unit tests for the accessibility permission prober. Drives the
 * real module: only native-dylib and TCC.db I/O are doubled so the suite stays
 * deterministic. `buildState`, `platformUnsupportedState`, and
 * `resolveBundleId` are the production helpers.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockGetNativeDylib, mockQueryTccStatus, mockPlatform } = vi.hoisted(
  () => ({
    mockGetNativeDylib: vi.fn(),
    mockQueryTccStatus: vi.fn(),
    mockPlatform: { isDarwin: true },
  }),
);

vi.mock("./_bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_bridge.js")>();
  return {
    ...actual,
    get IS_DARWIN() {
      return mockPlatform.isDarwin;
    },
    getNativeDylib: (...args: unknown[]) => mockGetNativeDylib(...args),
    queryTccStatus: (...args: unknown[]) => mockQueryTccStatus(...args),
  };
});

import { type getNativeDylib, resolveBundleId } from "./_bridge.js";
import { accessibilityProber } from "./accessibility.ts";

type NativeDylib = NonNullable<Awaited<ReturnType<typeof getNativeDylib>>>;

function stubDylib(opts: {
  granted?: boolean;
  request?: () => boolean;
}): NativeDylib {
  return {
    checkAccessibilityPermission: () => opts.granted === true,
    requestAccessibilityPermission: opts.request ?? (() => false),
  } as NativeDylib;
}

describe("accessibilityProber", () => {
  beforeEach(() => {
    mockPlatform.isDarwin = true;
    mockGetNativeDylib.mockReset();
    mockQueryTccStatus.mockReset();
    mockGetNativeDylib.mockResolvedValue(null);
    mockQueryTccStatus.mockResolvedValue(null);
  });

  test("exports the accessibility permission id", () => {
    expect(accessibilityProber.id).toBe("accessibility");
  });

  describe("check", () => {
    test("returns platform-unsupported state on non-Darwin and skips native I/O", async () => {
      mockPlatform.isDarwin = false;
      const before = Date.now();
      const state = await accessibilityProber.check();

      expect(state.id).toBe("accessibility");
      expect(state.status).toBe("not-applicable");
      expect(state.canRequest).toBe(false);
      expect(state.restrictedReason).toBe("platform_unsupported");
      expect(state.platform).toBe(process.platform);
      expect(state.lastChecked).toBeGreaterThanOrEqual(before);
      expect(state.lastRequested).toBeUndefined();
      expect(mockGetNativeDylib).not.toHaveBeenCalled();
      expect(mockQueryTccStatus).not.toHaveBeenCalled();
    });

    test("returns granted from the native check without consulting TCC", async () => {
      mockGetNativeDylib.mockResolvedValue(stubDylib({ granted: true }));
      const before = Date.now();
      const state = await accessibilityProber.check();

      expect(state).toEqual(
        expect.objectContaining({
          id: "accessibility",
          status: "granted",
          canRequest: false,
          platform: process.platform,
        }),
      );
      expect(state.lastChecked).toBeGreaterThanOrEqual(before);
      expect(state.lastRequested).toBeUndefined();
      expect(state.restrictedReason).toBeUndefined();
      expect(mockQueryTccStatus).not.toHaveBeenCalled();
    });

    test("treats a missing dylib as not granted and consults TCC with the bundle id", async () => {
      mockGetNativeDylib.mockResolvedValue(null);
      mockQueryTccStatus.mockResolvedValue(null);
      const state = await accessibilityProber.check();

      expect(state.status).toBe("not-determined");
      expect(state.canRequest).toBe(true);
      expect(mockQueryTccStatus).toHaveBeenCalledTimes(1);
      expect(mockQueryTccStatus).toHaveBeenCalledWith(
        "kTCCServiceAccessibility",
        resolveBundleId(),
      );
    });

    test("reports denied when the native check is false and TCC is denied", async () => {
      mockGetNativeDylib.mockResolvedValue(stubDylib({ granted: false }));
      mockQueryTccStatus.mockResolvedValue("denied");
      const state = await accessibilityProber.check();

      expect(state.id).toBe("accessibility");
      expect(state.status).toBe("denied");
      expect(state.canRequest).toBe(false);
      expect(state.lastRequested).toBeUndefined();
    });

    test("reports granted when TCC is granted even though the native check is false", async () => {
      mockGetNativeDylib.mockResolvedValue(stubDylib({ granted: false }));
      mockQueryTccStatus.mockResolvedValue("granted");
      const state = await accessibilityProber.check();

      expect(state.status).toBe("granted");
      expect(state.canRequest).toBe(false);
    });

    test("reports not-determined when native is false and TCC has no row", async () => {
      mockGetNativeDylib.mockResolvedValue(stubDylib({ granted: false }));
      mockQueryTccStatus.mockResolvedValue(null);
      const state = await accessibilityProber.check();

      expect(state.status).toBe("not-determined");
      expect(state.canRequest).toBe(true);
    });
  });

  describe("request", () => {
    test("returns platform-unsupported state on non-Darwin without lastRequested", async () => {
      mockPlatform.isDarwin = false;
      const state = await accessibilityProber.request({
        reason: "needs AX for UI automation",
      });

      expect(state.status).toBe("not-applicable");
      expect(state.canRequest).toBe(false);
      expect(state.restrictedReason).toBe("platform_unsupported");
      expect(state.lastRequested).toBeUndefined();
      expect(mockGetNativeDylib).not.toHaveBeenCalled();
    });

    test("invokes the native prompt and stamps lastRequested on the re-checked state", async () => {
      const requestAccessibilityPermission = vi.fn(() => false);
      mockGetNativeDylib.mockResolvedValue(
        stubDylib({
          granted: false,
          request: requestAccessibilityPermission,
        }),
      );
      mockQueryTccStatus.mockResolvedValue(null);
      const before = Date.now();
      const state = await accessibilityProber.request({ reason: "test" });

      expect(requestAccessibilityPermission).toHaveBeenCalledTimes(1);
      expect(state.status).toBe("not-determined");
      expect(state.canRequest).toBe(true);
      expect(state.lastRequested).toBeGreaterThanOrEqual(before);
      expect(state.lastChecked).toBeGreaterThanOrEqual(before);
    });

    test("skips the native prompt when the dylib is missing and still stamps lastRequested", async () => {
      mockGetNativeDylib.mockResolvedValue(null);
      mockQueryTccStatus.mockResolvedValue("denied");
      const before = Date.now();
      const state = await accessibilityProber.request({ reason: "test" });

      expect(state.status).toBe("denied");
      expect(state.canRequest).toBe(false);
      expect(state.lastRequested).toBeGreaterThanOrEqual(before);
    });

    test("returns granted with lastRequested when the native check is already true", async () => {
      const requestAccessibilityPermission = vi.fn(() => true);
      mockGetNativeDylib.mockResolvedValue(
        stubDylib({
          granted: true,
          request: requestAccessibilityPermission,
        }),
      );
      const before = Date.now();
      const state = await accessibilityProber.request({ reason: "test" });

      expect(requestAccessibilityPermission).toHaveBeenCalledTimes(1);
      expect(state.status).toBe("granted");
      expect(state.canRequest).toBe(false);
      expect(state.lastRequested).toBeGreaterThanOrEqual(before);
      expect(mockQueryTccStatus).not.toHaveBeenCalled();
    });
  });
});
