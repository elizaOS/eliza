/**
 * Verifies the native device-control handler validates requests and returns
 * human-readable, capability-backed outcomes.
 */

import { describe, expect, it, vi } from "vitest";
import { createDeviceControlInteractHandler } from "./device-control-interact";

describe("device-control interact", () => {
  it.each([
    [true, "Turned the flashlight on."],
    [false, "Turned the flashlight off."],
  ] as const)("sets flashlight enabled=%s", async (enabled, text) => {
    const setFlashlight = vi
      .fn()
      .mockResolvedValue({ available: true, enabled });
    const interact = createDeviceControlInteractHandler({ setFlashlight });

    await expect(interact("set-flashlight", { enabled })).resolves.toEqual({
      success: true,
      text,
      data: { available: true, enabled },
    });
    expect(setFlashlight).toHaveBeenCalledWith({ enabled });
  });

  it("rejects unknown capabilities and malformed parameters", async () => {
    const setFlashlight = vi.fn();
    const interact = createDeviceControlInteractHandler({ setFlashlight });

    await expect(interact("set-volume", {})).rejects.toThrow(
      "Unsupported device-control capability: set-volume",
    );
    await expect(
      interact("set-flashlight", { enabled: "yes" }),
    ).rejects.toThrow("set-flashlight requires boolean parameter enabled");
    expect(setFlashlight).not.toHaveBeenCalled();
  });

  it("fails closed when the native bridge reports no flashlight", async () => {
    const interact = createDeviceControlInteractHandler({
      setFlashlight: vi
        .fn()
        .mockResolvedValue({ available: false, enabled: false }),
    });

    await expect(interact("set-flashlight", { enabled: true })).rejects.toThrow(
      "Flashlight is unavailable on this device",
    );
  });
});
