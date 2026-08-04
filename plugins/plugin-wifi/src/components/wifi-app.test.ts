import { describe, expect, it, vi } from "vitest";

const registerOverlayApp = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/shared", () => ({
  registerOverlayApp,
}));

import { registerWifiApp, wifiApp } from "./wifi-app";

describe("wifi overlay registration", () => {
  it("registers the exported overlay descriptor", () => {
    registerWifiApp();

    expect(registerOverlayApp).toHaveBeenCalledTimes(1);
    expect(registerOverlayApp).toHaveBeenCalledWith(wifiApp);
  });
});
