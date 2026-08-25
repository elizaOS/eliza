/**
 * Unit coverage for the camera permission prober. Drives the real module
 * through Darwin AVCaptureDevice status mapping, the missing-dylib fallback,
 * the non-Darwin renderer hand-off, and request() including the denied-state
 * privacy-pane open. Native FFI and System Settings are stubbed; mapAVAuthStatus
 * and buildState stay the production helpers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { darwin, mockGetNativeDylib, mockOpenPrivacyPane } = vi.hoisted(() => ({
  darwin: { current: true },
  mockGetNativeDylib: vi.fn(),
  mockOpenPrivacyPane: vi.fn(),
}));

vi.mock("./_bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_bridge.js")>();
  return {
    ...actual,
    get IS_DARWIN() {
      return darwin.current;
    },
    getNativeDylib: mockGetNativeDylib,
    openPrivacyPane: mockOpenPrivacyPane,
  };
});

import { cameraProber } from "./camera.ts";

function nativeLib(status: number, request = vi.fn()) {
  return {
    checkCameraPermission: () => status,
    requestCameraPermission: request,
  };
}

describe("cameraProber", () => {
  beforeEach(() => {
    darwin.current = true;
    mockGetNativeDylib.mockReset();
    mockOpenPrivacyPane.mockReset();
    mockOpenPrivacyPane.mockResolvedValue(undefined);
    mockGetNativeDylib.mockResolvedValue(null);
  });

  it("exports id camera", () => {
    expect(cameraProber.id).toBe("camera");
    expect(typeof cameraProber.check).toBe("function");
    expect(typeof cameraProber.request).toBe("function");
  });
});

describe("cameraProber.check", () => {
  beforeEach(() => {
    darwin.current = true;
    mockGetNativeDylib.mockReset();
    mockOpenPrivacyPane.mockReset();
    mockGetNativeDylib.mockResolvedValue(null);
  });

  it("returns not-determined with canRequest on non-Darwin without touching native", async () => {
    darwin.current = false;
    const before = Date.now();
    const state = await cameraProber.check();
    expect(state).toMatchObject({
      id: "camera",
      status: "not-determined",
      canRequest: true,
      platform: process.platform,
    });
    expect(state.lastChecked).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeUndefined();
    expect(mockGetNativeDylib).not.toHaveBeenCalled();
    expect(mockOpenPrivacyPane).not.toHaveBeenCalled();
  });

  it("treats a missing dylib as AV status 0 (not-determined)", async () => {
    mockGetNativeDylib.mockResolvedValue(null);
    const state = await cameraProber.check();
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(state.id).toBe("camera");
    expect(mockGetNativeDylib).toHaveBeenCalledTimes(1);
  });

  it.each([
    [0, "not-determined", true],
    [1, "denied", false],
    [2, "granted", false],
    [3, "restricted", false],
  ] as const)(
    "maps native AV status %i to %s (canRequest=%s)",
    async (code, status, canRequest) => {
      mockGetNativeDylib.mockResolvedValue(nativeLib(code));
      const state = await cameraProber.check();
      expect(state.status).toBe(status);
      expect(state.canRequest).toBe(canRequest);
      expect(state.id).toBe("camera");
      expect(state.platform).toBe(process.platform);
    },
  );

  it.each([4, -1, 99])(
    "maps unknown native AV status %i to not-determined",
    async (code) => {
      mockGetNativeDylib.mockResolvedValue(nativeLib(code));
      const state = await cameraProber.check();
      expect(state.status).toBe("not-determined");
      expect(state.canRequest).toBe(true);
    },
  );

  it("does not invoke requestCameraPermission from check()", async () => {
    const request = vi.fn();
    mockGetNativeDylib.mockResolvedValue(nativeLib(2, request));
    await cameraProber.check();
    expect(request).not.toHaveBeenCalled();
    expect(mockOpenPrivacyPane).not.toHaveBeenCalled();
  });
});

describe("cameraProber.request", () => {
  beforeEach(() => {
    darwin.current = true;
    mockGetNativeDylib.mockReset();
    mockOpenPrivacyPane.mockReset();
    mockOpenPrivacyPane.mockResolvedValue(undefined);
    mockGetNativeDylib.mockResolvedValue(null);
  });

  it("returns not-determined on non-Darwin without lastRequested or native I/O", async () => {
    darwin.current = false;
    const state = await cameraProber.request({ reason: "unit-test" });
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(state.id).toBe("camera");
    expect(state.lastRequested).toBeUndefined();
    expect(mockGetNativeDylib).not.toHaveBeenCalled();
    expect(mockOpenPrivacyPane).not.toHaveBeenCalled();
  });

  it("invokes native request and stamps lastRequested without opening settings when granted", async () => {
    const request = vi.fn();
    mockGetNativeDylib.mockResolvedValue(nativeLib(2, request));
    const before = Date.now();
    const state = await cameraProber.request({ reason: "unit-test" });
    const after = Date.now();
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(state.lastRequested).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeLessThanOrEqual(after);
    expect(mockOpenPrivacyPane).not.toHaveBeenCalled();
  });

  it("opens the Camera privacy pane only when the re-check is denied", async () => {
    const request = vi.fn();
    mockGetNativeDylib.mockResolvedValue(nativeLib(1, request));
    const state = await cameraProber.request({ reason: "unit-test" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
    expect(mockOpenPrivacyPane).toHaveBeenCalledTimes(1);
    expect(mockOpenPrivacyPane).toHaveBeenCalledWith("Camera");
    expect(state.lastRequested).toBeTypeOf("number");
  });

  it("does not open the privacy pane when status is not-determined", async () => {
    mockGetNativeDylib.mockResolvedValue(nativeLib(0));
    const state = await cameraProber.request({ reason: "unit-test" });
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(mockOpenPrivacyPane).not.toHaveBeenCalled();
    expect(state.lastRequested).toBeTypeOf("number");
  });

  it("does not open the privacy pane when status is restricted", async () => {
    mockGetNativeDylib.mockResolvedValue(nativeLib(3));
    const state = await cameraProber.request({ reason: "unit-test" });
    expect(state.status).toBe("restricted");
    expect(state.canRequest).toBe(false);
    expect(mockOpenPrivacyPane).not.toHaveBeenCalled();
    expect(state.lastRequested).toBeTypeOf("number");
  });

  it("tolerates a missing dylib on Darwin request (optional chaining)", async () => {
    mockGetNativeDylib.mockResolvedValue(null);
    const state = await cameraProber.request({ reason: "unit-test" });
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(state.lastRequested).toBeTypeOf("number");
    expect(mockOpenPrivacyPane).not.toHaveBeenCalled();
  });
});
