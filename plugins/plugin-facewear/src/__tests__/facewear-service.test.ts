/**
 * Facewear service tests cover the coordinator behavior when XR and
 * smartglasses services are absent or available through the runtime.
 */
import { describe, expect, it, vi } from "vitest";
import {
  FACEWEAR_SERVICE_TYPE,
  FacewearService,
} from "../services/facewear-service.ts";

describe("FacewearService", () => {
  it("has correct serviceType", () => {
    expect(FacewearService.serviceType).toBe(FACEWEAR_SERVICE_TYPE);
    expect(FACEWEAR_SERVICE_TYPE).toBe("facewear");
  });

  it("getConnectedDevices returns empty array with no services", () => {
    const mockRuntime = {
      getService: vi.fn().mockReturnValue(undefined),
    };
    const svc = new FacewearService(mockRuntime as never);
    expect(svc.getConnectedDevices()).toEqual([]);
    expect(svc.hasActiveDevice()).toBe(false);
  });

  it("capabilityDescription is defined", () => {
    const mockRuntime = { getService: vi.fn().mockReturnValue(undefined) };
    const svc = new FacewearService(mockRuntime as never);
    expect(svc.capabilityDescription).toBeTruthy();
    expect(typeof svc.capabilityDescription).toBe("string");
  });

  it("stop() resolves without error", async () => {
    const mockRuntime = { getService: vi.fn().mockReturnValue(undefined) };
    const svc = new FacewearService(mockRuntime as never);
    await expect(svc.stop()).resolves.toBeUndefined();
  });
});
