import { describe, expect, it, vi } from "vitest";

const registerOverlayApp = vi.hoisted(() => vi.fn());

vi.mock("../../../../packages/ui/src/apps/overlay-app-registry", () => ({
  registerOverlayApp,
}));

import {
  deviceSettingsApp,
  registerDeviceSettingsApp,
} from "./device-settings-app";

describe("device settings overlay registration", () => {
  it("registers the exported overlay descriptor", () => {
    registerDeviceSettingsApp();

    expect(registerOverlayApp).toHaveBeenCalledTimes(1);
    expect(registerOverlayApp).toHaveBeenCalledWith(deviceSettingsApp);
  });
});
