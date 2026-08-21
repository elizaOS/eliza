/**
 * Unit coverage for the accessibility permission prober — macOS TCC
 * classification (granted/denied/not-determined), non-Darwin unsupported,
 * and the request() path.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./services/permissions/probers/_bridge.js", () => ({
  IS_DARWIN: true,
  buildState: (id: string, state: string, extra: Record<string, unknown> = {}) => ({
    id,
    state,
    ...extra,
  }),
  getNativeDylib: vi.fn(),
  platformUnsupportedState: (id: string) => ({ id, state: "unsupported" }),
  queryTccStatus: vi.fn(),
  resolveBundleId: vi.fn(() => "com.example.app"),
}));

import { accessibilityProber } from "./services/permissions/probers/accessibility.ts";
import {
  getNativeDylib,
  queryTccStatus,
  IS_DARWIN,
} from "./services/permissions/probers/_bridge.js";

const mockGetDylib = vi.mocked(getNativeDylib);
const mockQueryTcc = vi.mocked(queryTccStatus);

describe("accessibilityProber.check", () => {
  beforeEach(() => {
    mockGetDylib.mockReset();
    mockQueryTcc.mockReset();
  });

  it("returns unsupported on non-Darwin platforms", async () => {
    (IS_DARWIN as boolean) = false;
    const state = await accessibilityProber.check();
    expect(state.state).toBe("unsupported");
    (IS_DARWIN as boolean) = true;
  });

  it("returns granted when the native check is true", async () => {
    mockGetDylib.mockResolvedValue({ checkAccessibilityPermission: () => true } as never);
    const state = await accessibilityProber.check();
    expect(state.state).toBe("granted");
    expect(state.canRequest).toBe(false);
    expect(mockQueryTcc).not.toHaveBeenCalled();
  });

  it("treats missing dylib as not-granted and consults TCC", async () => {
    mockGetDylib.mockResolvedValue(null);
    mockQueryTcc.mockResolvedValue("not-determined" as never);
    const state = await accessibilityProber.check();
    expect(state.state).toBe("not-determined");
    expect(state.canRequest).toBe(true);
  });

  it("reports denied when native false and TCC says denied", async () => {
    mockGetDylib.mockResolvedValue({ checkAccessibilityPermission: () => false } as never);
    mockQueryTcc.mockResolvedValue("denied" as never);
    const state = await accessibilityProber.check();
    expect(state.state).toBe("denied");
    expect(state.canRequest).toBe(false);
  });

  it("reports granted when TCC disagrees (granted despite native false)", async () => {
    mockGetDylib.mockResolvedValue({ checkAccessibilityPermission: () => false } as never);
    mockQueryTcc.mockResolvedValue("granted" as never);
    const state = await accessibilityProber.check();
    expect(state.state).toBe("granted");
  });
});

describe("accessibilityProber.request", () => {
  beforeEach(() => {
    mockGetDylib.mockReset();
    mockQueryTcc.mockReset();
  });

  it("returns unsupported on non-Darwin", async () => {
    (IS_DARWIN as boolean) = false;
    const state = await accessibilityProber.request({ reason: "test" });
    expect(state.state).toBe("unsupported");
    (IS_DARWIN as boolean) = true;
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
    expect(state.state).toBe("not-determined");
    expect(state.lastRequested).toBeTypeOf("number");
  });
});
