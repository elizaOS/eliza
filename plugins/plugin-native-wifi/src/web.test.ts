import { afterEach, describe, expect, it, vi } from "vitest";

import { WiFiWeb } from "./web";

describe("WiFiWeb fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns disabled fallback state and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wifi = new WiFiWeb();

    await expect(wifi.getWifiState()).resolves.toEqual({
      enabled: false,
      connected: false,
      rssi: null,
    });
    await expect(wifi.getConnectedNetwork()).resolves.toEqual({
      network: null,
    });
    await expect(wifi.listAvailableNetworks({ limit: 10 })).resolves.toEqual({
      networks: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { maxAge: -1 },
    { maxAge: Number.POSITIVE_INFINITY },
    { limit: -1 },
    { limit: 1.5 },
    { limit: Number.NaN },
  ])("rejects malformed scan options %#", async (options) => {
    const wifi = new WiFiWeb();

    await expect(wifi.listAvailableNetworks(options)).rejects.toThrow(
      /must be a non-negative/,
    );
  });

  it.each([
    null,
    "limit=1",
    1,
    false,
  ])("rejects non-object scan options %# without warning", async (options) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wifi = new WiFiWeb();

    await expect(wifi.listAvailableNetworks(options as never)).rejects.toThrow(
      "options must be an object",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects malformed connect options before Android-only fallback responses", async () => {
    const wifi = new WiFiWeb();

    await expect(wifi.connectToNetwork({ ssid: " \t\n " })).rejects.toThrow(
      "ssid is required",
    );
    await expect(
      wifi.connectToNetwork({
        ssid: ["home"] as unknown as string,
        password: { value: "secret" } as unknown as string,
      }),
    ).rejects.toThrow("ssid is required");
    await expect(
      wifi.connectToNetwork({
        ssid: "home",
        password: { value: "secret" } as unknown as string,
      }),
    ).rejects.toThrow("password must be a string");
    await expect(wifi.connectToNetwork({ ssid: "home" })).resolves.toEqual({
      success: false,
      message: "Wi-Fi controls are only available on Android.",
    });
  });

  it("keeps fallback state stable across repeated unavailable operations", async () => {
    const wifi = new WiFiWeb();

    await expect(
      Promise.all([
        wifi.listAvailableNetworks({ limit: 0 }),
        wifi.connectToNetwork({ ssid: "__proto__", password: "" }),
        wifi.disconnectFromNetwork(),
      ]),
    ).resolves.toEqual([
      { networks: [] },
      {
        success: false,
        message: "Wi-Fi controls are only available on Android.",
      },
      {
        success: false,
        message: "Wi-Fi controls are only available on Android.",
      },
    ]);
  });
});
