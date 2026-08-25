/**
 * Unit coverage for the HealthKit permission prober. Drives the real
 * `healthProber` through Darwin entitlement gating (unsigned-dev restricted
 * vs signed not-determined bridge), request() lastRequested stamping, and
 * the non-Darwin platform-unsupported short-circuit. Platform and entitlement
 * detection are stubbed OS collaborators; `buildState` and
 * `platformUnsupportedState` stay the production helpers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { darwin, mockHasEmbeddedProvisioningEntitlement } = vi.hoisted(() => ({
  darwin: { current: true },
  mockHasEmbeddedProvisioningEntitlement: vi.fn(),
}));

vi.mock("./_bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_bridge.js")>();
  return {
    ...actual,
    get IS_DARWIN() {
      return darwin.current;
    },
    hasEmbeddedProvisioningEntitlement: mockHasEmbeddedProvisioningEntitlement,
  };
});

import { platformUnsupportedState } from "./_bridge.js";
import { healthProber } from "./health.ts";

const HEALTHKIT_ENTITLEMENT = "com.apple.developer.healthkit";

describe("healthProber", () => {
  beforeEach(() => {
    darwin.current = true;
    mockHasEmbeddedProvisioningEntitlement.mockReset();
    mockHasEmbeddedProvisioningEntitlement.mockReturnValue(false);
  });

  it("exports id health without an openSettings helper", () => {
    expect(healthProber.id).toBe("health");
    expect(typeof healthProber.check).toBe("function");
    expect(typeof healthProber.request).toBe("function");
    expect(healthProber.openSettings).toBeUndefined();
  });
});

describe("healthProber.check", () => {
  beforeEach(() => {
    darwin.current = true;
    mockHasEmbeddedProvisioningEntitlement.mockReset();
    mockHasEmbeddedProvisioningEntitlement.mockReturnValue(false);
  });

  it("returns platform-unsupported on non-Darwin without reading entitlements", async () => {
    darwin.current = false;
    const before = Date.now();
    const state = await healthProber.check();
    const expected = platformUnsupportedState("health");
    expect(state).toEqual({
      ...expected,
      lastChecked: state.lastChecked,
    });
    expect(state.id).toBe("health");
    expect(state.status).toBe("not-applicable");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBe("platform_unsupported");
    expect(state.lastChecked).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeUndefined();
    expect(state.lastBlockedFeature).toBeUndefined();
    expect(state.reason).toBeUndefined();
    expect(state.platform).toBe(process.platform);
    expect(mockHasEmbeddedProvisioningEntitlement).not.toHaveBeenCalled();
  });

  it("reports restricted/entitlement_required when Darwin has no HealthKit entitlement", async () => {
    mockHasEmbeddedProvisioningEntitlement.mockReturnValue(false);
    const before = Date.now();
    const state = await healthProber.check();
    expect(mockHasEmbeddedProvisioningEntitlement).toHaveBeenCalledTimes(1);
    expect(mockHasEmbeddedProvisioningEntitlement).toHaveBeenCalledWith(
      HEALTHKIT_ENTITLEMENT,
    );
    expect(state).toMatchObject({
      id: "health",
      status: "restricted",
      canRequest: false,
      restrictedReason: "entitlement_required",
      platform: process.platform,
    });
    expect(state.lastChecked).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeUndefined();
    expect(state.lastBlockedFeature).toBeUndefined();
    expect(state.reason).toBeUndefined();
  });

  it("surfaces not-determined with canRequest when Darwin has the HealthKit entitlement", async () => {
    mockHasEmbeddedProvisioningEntitlement.mockReturnValue(true);
    const before = Date.now();
    const state = await healthProber.check();
    expect(mockHasEmbeddedProvisioningEntitlement).toHaveBeenCalledWith(
      HEALTHKIT_ENTITLEMENT,
    );
    expect(state.id).toBe("health");
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(state.restrictedReason).toBeUndefined();
    expect(state.lastChecked).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeUndefined();
    expect(state.reason).toBeUndefined();
    expect(state.platform).toBe(process.platform);
  });

  it("does not stamp lastRequested from check() even when entitlement is present", async () => {
    mockHasEmbeddedProvisioningEntitlement.mockReturnValue(true);
    const state = await healthProber.check();
    expect(state.lastRequested).toBeUndefined();
  });
});

describe("healthProber.request", () => {
  beforeEach(() => {
    darwin.current = true;
    mockHasEmbeddedProvisioningEntitlement.mockReset();
    mockHasEmbeddedProvisioningEntitlement.mockReturnValue(false);
  });

  it("returns platform-unsupported on non-Darwin without lastRequested or entitlement I/O", async () => {
    darwin.current = false;
    const state = await healthProber.request({ reason: "sync sleep data" });
    const expected = platformUnsupportedState("health");
    expect(state).toEqual({
      ...expected,
      lastChecked: state.lastChecked,
    });
    expect(state.status).toBe("not-applicable");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBe("platform_unsupported");
    expect(state.lastRequested).toBeUndefined();
    expect(state.reason).toBeUndefined();
    expect(mockHasEmbeddedProvisioningEntitlement).not.toHaveBeenCalled();
  });

  it("stamps lastRequested on Darwin without entitlement while remaining restricted", async () => {
    mockHasEmbeddedProvisioningEntitlement.mockReturnValue(false);
    const before = Date.now();
    const state = await healthProber.request({ reason: "sync sleep data" });
    const after = Date.now();
    expect(mockHasEmbeddedProvisioningEntitlement).toHaveBeenCalledTimes(1);
    expect(mockHasEmbeddedProvisioningEntitlement).toHaveBeenCalledWith(
      HEALTHKIT_ENTITLEMENT,
    );
    expect(state.id).toBe("health");
    expect(state.status).toBe("restricted");
    expect(state.canRequest).toBe(false);
    expect(state.restrictedReason).toBe("entitlement_required");
    expect(state.lastRequested).toBeTypeOf("number");
    expect(state.lastRequested).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeLessThanOrEqual(after);
    expect(state.lastChecked).toBeGreaterThanOrEqual(before);
    expect(state.reason).toBeUndefined();
  });

  it("mirrors the requestable not-determined state when Darwin has the entitlement", async () => {
    mockHasEmbeddedProvisioningEntitlement.mockReturnValue(true);
    const before = Date.now();
    const state = await healthProber.request({ reason: "sync sleep data" });
    const after = Date.now();
    expect(state.status).toBe("not-determined");
    expect(state.canRequest).toBe(true);
    expect(state.restrictedReason).toBeUndefined();
    expect(state.lastRequested).toBeGreaterThanOrEqual(before);
    expect(state.lastRequested).toBeLessThanOrEqual(after);
    expect(state.id).toBe("health");
    expect(state.platform).toBe(process.platform);
  });

  it("drops the free-text request reason rather than copying it onto the state", async () => {
    mockHasEmbeddedProvisioningEntitlement.mockReturnValue(true);
    const state = await healthProber.request({
      reason: "this string must not leak",
    });
    expect(state.reason).toBeUndefined();
  });
});
