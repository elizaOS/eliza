/**
 * Unit coverage for the accessibility permission prober — macOS TCC
 * classification (granted/denied/not-determined), non-Darwin unsupported,
 * and the request() path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPlatform = vi.hoisted(() => ({ isDarwin: true }));

vi.mock("../_bridge.js", () => ({
  get IS_DARWIN() {
    return mockPlatform.isDarwin;
  },
  buildState: (
    id: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    status,
    ...extra,
  }),
  getNativeDylib: vi.fn(),
  platformUnsupportedState: (id: string) => ({
    id,
    status: "not-applicable",
  }),
  queryTccStatus: vi.fn(),
  resolveBundleId: vi.fn(() => "com.example.app"),
}));

import { getNativeDylib, queryTccStatus } from "../_bridge.js";
import { accessibilityProber } from "../accessibility.ts";

const mockGetDylib = vi.mocked(getNativeDylib);
const mockQueryTcc = vi.mocked(queryTccStatus);

describe("accessibilityProber.check", () => {
  beforeEach(() => {
    mockPlatform.isDarwin = true;
    mockGetDylib.mockReset();
    mockQueryTcc.mockReset();
  });

  it("returns unsupported on non-Darwin platforms", async () => {
    mockPlatform.isDarwin = false;
    const state = await accessibilityProber.check();
    expect(state.status).toBe("not-applicable");
  });

  it("returns granted when the native check is true", async () => {
    mockGetDylib.mockResolvedValue({
      checkAccessibilityPermission: () => true,
    } as never);
    const state = await accessibilityProber.check();
    expect(state.status).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(mockQueryTcc).not.toHaveBeenCalled();
  });

  it("treats missing dylib as not-granted and consults TCC", async () => {
    mockGetDylib.mockResolvedValue(null);
    mockQueryTcc.mockResolvedValue("not-determined" as never);
    const state = await accessibilityProber.check();
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
  });

  it("reports denied when native false and TCC says denied", async () => {
    mockGetDylib.mockResolvedValue({
      checkAccessibilityPermission: () => false,
    } as never);
    mockQueryTcc.mockResolvedValue("denied" as never);
    const state = await accessibilityProber.check();
    expect(state.status).toBe("denied");
    expect(state.canRequest).toBe(false);
  });

  it("reports granted when TCC disagrees (granted despite native false)", async () => {
    mockGetDylib.mockResolvedValue({
      checkAccessibilityPermission: () => false,
    } as never);
    mockQueryTcc.mockResolvedValue("granted" as never);
    const state = await accessibilityProber.check();
    expect(state.status).toBe("granted");
  });
});

describe("accessibilityProber.request", () => {
  beforeEach(() => {
    mockPlatform.isDarwin = true;
    mockGetDylib.mockReset();
    mockQueryTcc.mockReset();
  });

  it("returns unsupported on non-Darwin", async () => {
    mockPlatform.isDarwin = false;
    const state = await accessibilityProber.request({ reason: "test" });
    expect(state.status).toBe("not-applicable");
  });

  it("invokes the native request and returns the re-checked state with lastRequested", async () => {
    const requestAccessibilityPermission = vi.fn();
    mockGetDylib.mockResolvedValue({
      checkAccessibilityPermission: () => false,
      requestAccessibilityPermission,
    } as never);
    mockQueryTcc.mockResolvedValue("not-determined" as never);
    const state = await accessibilityProber.request({ reason: "test" });
    expect(requestAccessibilityPermission).toHaveBeenCalledTimes(1);
    expect(state.status).toBe("not-determined");
    expect(state.lastRequested).toBeTypeOf("number");
  });
});
