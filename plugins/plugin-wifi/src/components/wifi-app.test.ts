import { describe, expect, it, vi } from "vitest";

const registerOverlayApp = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui", () => ({
  registerOverlayApp,
}));

import { registerWifiApp, WIFI_APP_NAME, wifiApp } from "./wifi-app";

describe("wifi overlay registration", () => {
  it("describes an Android-only WiFi overlay app", () => {
    expect(wifiApp).toMatchObject({
      name: WIFI_APP_NAME,
      displayName: "WiFi",
      description: "Scan, inspect, and connect to nearby Wi-Fi networks",
      category: "system",
      androidOnly: true,
    });
    expect(wifiApp.loader).toEqual(expect.any(Function));
  });

  it("registers the exported overlay descriptor", () => {
    registerWifiApp();

    expect(registerOverlayApp).toHaveBeenCalledTimes(1);
    expect(registerOverlayApp).toHaveBeenCalledWith(wifiApp);
  });
});
