import { describe, expect, it, vi } from "vitest";

const registerOverlayApp = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui", () => ({
  registerOverlayApp,
}));

import {
  DEVICE_SETTINGS_APP_NAME,
  deviceSettingsApp,
  registerDeviceSettingsApp,
} from "./device-settings-app";

describe("device settings overlay registration", () => {
  it("describes an Android-only device settings overlay app", () => {
    expect(deviceSettingsApp).toMatchObject({
      name: DEVICE_SETTINGS_APP_NAME,
      displayName: "Device Settings",
      description: "Brightness, volume, Android roles, and device settings",
      category: "system",
      androidOnly: true,
    });
    expect(deviceSettingsApp.loader).toEqual(expect.any(Function));
  });

  it("registers the exported overlay descriptor", () => {
    registerDeviceSettingsApp();

    expect(registerOverlayApp).toHaveBeenCalledTimes(1);
    expect(registerOverlayApp).toHaveBeenCalledWith(deviceSettingsApp);
  });
});
