/**
 * Behavioral unit tests for the screen-recording permission prober. Drives the
 * real module: only native-dylib and TCC.db I/O are doubled so the suite stays
 * deterministic. `buildState`, `platformUnsupportedState`, and
 * `resolveBundleId` are the production helpers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { resolveBundleId } from "./_bridge.js";
import { screenRecordingProber } from "./screen-recording.ts";

function stubDylib(opts: { granted?: boolean; request?: () => boolean }) {
  return {
    checkScreenRecordingPermission: () => opts.granted === true,
    requestScreenRecordingPermission: opts.request ?? (() => false),
  };
}

describe("screenRecordingProber", () => {
  beforeEach(() => {
    mockPlatform.isDarwin = true;
    mockGetNativeDylib.mockReset();
    mockQueryTccStatus.mockReset();
    mockGetNativeDylib.mockResolvedValue(null);
    mockQueryTccStatus.mockResolvedValue(null);
  });

  it("exports the screen-recording permission id", () => {
    expect(screenRecordingProber.id).toBe("screen-recording");
    expect(typeof screenRecordingProber.check).toBe("function");
    expect(typeof screenRecordingProber.request).toBe("function");
  });

  describe("check", () => {
    it("returns platform-unsupported state on non-Darwin and skips native I/O", async () => {
      mockPlatform.isDarwin = false;
      const before = Date.now();
      const state = await screenRecordingProber.check();

      expect(state.id).toBe("screen-recording");
      expect(state.status).toBe("not-applicable");
      expect(state.canRequest).toBe(false);
      expect(state.restrictedReason).toBe("platform_unsupported");
      expect(state.platform).toBe(process.platform);
      expect(state.lastChecked).toBeGreaterThanOrEqual(before);
      expect(state.lastRequested).toBeUndefined();
      expect(mockGetNativeDylib).not.toHaveBeenCalled();
      expect(mockQueryTccStatus).not.toHaveBeenCalled();
    });

    it("returns granted from the native check without consulting TCC", async () => {
      mockGetNativeDylib.mockResolvedValue(stubDylib({ granted: true }));
      const before = Date.now();
      const state = await screenRecordingProber.check();

      expect(state).toEqual(
        expect.objectContaining({
          id: "screen-recording",
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

    it("treats a missing dylib as not granted and consults TCC with the bundle id", async () => {
      mockGetNativeDylib.mockResolvedValue(null);
      mockQueryTccStatus.mockResolvedValue(null);
      const state = await screenRecordingProber.check();

      expect(state.status).toBe("not-determined");
      expect(state.canRequest).toBe(true);
      expect(state.id).toBe("screen-recording");
      expect(mockGetNativeDylib).toHaveBeenCalledTimes(1);
      expect(mockQueryTccStatus).toHaveBeenCalledTimes(1);
      expect(mockQueryTccStatus).toHaveBeenCalledWith(
        "kTCCServiceScreenCapture",
        resolveBundleId(),
      );
    });

    it("treats an undefined native check as not granted (?? false) and consults TCC", async () => {
      mockGetNativeDylib.mockResolvedValue({
        checkScreenRecordingPermission: () => undefined,
        requestScreenRecordingPermission: () => false,
      });
      mockQueryTccStatus.mockResolvedValue(null);
      const state = await screenRecordingProber.check();

      expect(state.status).toBe("not-determined");
      expect(state.canRequest).toBe(true);
      expect(mockQueryTccStatus).toHaveBeenCalledTimes(1);
    });

    it("reports denied when the native check is false and TCC is denied", async () => {
      mockGetNativeDylib.mockResolvedValue(stubDylib({ granted: false }));
      mockQueryTccStatus.mockResolvedValue("denied");
      const state = await screenRecordingProber.check();

      expect(state.id).toBe("screen-recording");
      expect(state.status).toBe("denied");
      expect(state.canRequest).toBe(false);
      expect(state.lastRequested).toBeUndefined();
    });

    it("reports granted when TCC is granted even though the native check is false", async () => {
      mockGetNativeDylib.mockResolvedValue(stubDylib({ granted: false }));
      mockQueryTccStatus.mockResolvedValue("granted");
      const state = await screenRecordingProber.check();

      expect(state.status).toBe("granted");
      expect(state.canRequest).toBe(false);
    });

    it("reports not-determined when native is false and TCC has no row", async () => {
      mockGetNativeDylib.mockResolvedValue(stubDylib({ granted: false }));
      mockQueryTccStatus.mockResolvedValue(null);
      const state = await screenRecordingProber.check();

      expect(state.status).toBe("not-determined");
      expect(state.canRequest).toBe(true);
    });

    it("does not invoke requestScreenRecordingPermission from check()", async () => {
      const requestScreenRecordingPermission = vi.fn(() => false);
      mockGetNativeDylib.mockResolvedValue(
        stubDylib({
          granted: true,
          request: requestScreenRecordingPermission,
        }),
      );
      await screenRecordingProber.check();
      expect(requestScreenRecordingPermission).not.toHaveBeenCalled();
    });
  });

  describe("request", () => {
    it("returns platform-unsupported state on non-Darwin without lastRequested", async () => {
      mockPlatform.isDarwin = false;
      const state = await screenRecordingProber.request({
        reason: "needs screen capture for sharing",
      });

      expect(state.status).toBe("not-applicable");
      expect(state.canRequest).toBe(false);
      expect(state.restrictedReason).toBe("platform_unsupported");
      expect(state.id).toBe("screen-recording");
      expect(state.lastRequested).toBeUndefined();
      expect(mockGetNativeDylib).not.toHaveBeenCalled();
      expect(mockQueryTccStatus).not.toHaveBeenCalled();
    });

    it("invokes the native prompt and stamps lastRequested on the re-checked state", async () => {
      const requestScreenRecordingPermission = vi.fn(() => false);
      mockGetNativeDylib.mockResolvedValue(
        stubDylib({
          granted: false,
          request: requestScreenRecordingPermission,
        }),
      );
      mockQueryTccStatus.mockResolvedValue(null);
      const before = Date.now();
      const state = await screenRecordingProber.request({ reason: "test" });
      const after = Date.now();

      expect(requestScreenRecordingPermission).toHaveBeenCalledTimes(1);
      expect(state.status).toBe("not-determined");
      expect(state.canRequest).toBe(true);
      expect(state.lastRequested).toBeGreaterThanOrEqual(before);
      expect(state.lastRequested).toBeLessThanOrEqual(after);
      expect(state.lastChecked).toBeGreaterThanOrEqual(before);
    });

    it("skips the native prompt when the dylib is missing and still stamps lastRequested", async () => {
      mockGetNativeDylib.mockResolvedValue(null);
      mockQueryTccStatus.mockResolvedValue("denied");
      const before = Date.now();
      const state = await screenRecordingProber.request({ reason: "test" });

      expect(state.status).toBe("denied");
      expect(state.canRequest).toBe(false);
      expect(state.lastRequested).toBeGreaterThanOrEqual(before);
    });

    it("returns granted with lastRequested when the native check is already true", async () => {
      const requestScreenRecordingPermission = vi.fn(() => true);
      mockGetNativeDylib.mockResolvedValue(
        stubDylib({
          granted: true,
          request: requestScreenRecordingPermission,
        }),
      );
      const before = Date.now();
      const state = await screenRecordingProber.request({ reason: "test" });

      expect(requestScreenRecordingPermission).toHaveBeenCalledTimes(1);
      expect(state.status).toBe("granted");
      expect(state.canRequest).toBe(false);
      expect(state.lastRequested).toBeGreaterThanOrEqual(before);
      expect(mockQueryTccStatus).not.toHaveBeenCalled();
    });

    it("re-checks after request so a grant that lands during the prompt is returned", async () => {
      let granted = false;
      const requestScreenRecordingPermission = vi.fn(() => {
        granted = true;
        return true;
      });
      mockGetNativeDylib.mockResolvedValue({
        checkScreenRecordingPermission: () => granted,
        requestScreenRecordingPermission,
      });
      const state = await screenRecordingProber.request({ reason: "test" });

      expect(requestScreenRecordingPermission).toHaveBeenCalledTimes(1);
      expect(state.status).toBe("granted");
      expect(state.canRequest).toBe(false);
      expect(state.lastRequested).toBeTypeOf("number");
      expect(mockQueryTccStatus).not.toHaveBeenCalled();
    });

    it("stamps lastRequested on a TCC-granted re-check after the native prompt", async () => {
      const requestScreenRecordingPermission = vi.fn(() => false);
      mockGetNativeDylib.mockResolvedValue(
        stubDylib({
          granted: false,
          request: requestScreenRecordingPermission,
        }),
      );
      mockQueryTccStatus.mockResolvedValue("granted");
      const before = Date.now();
      const state = await screenRecordingProber.request({
        reason: "any-caller-supplied-reason",
      });
      const after = Date.now();

      expect(requestScreenRecordingPermission).toHaveBeenCalledTimes(1);
      expect(state.status).toBe("granted");
      expect(state.canRequest).toBe(false);
      expect(state.lastRequested).toBeGreaterThanOrEqual(before);
      expect(state.lastRequested).toBeLessThanOrEqual(after);
    });
  });
});
