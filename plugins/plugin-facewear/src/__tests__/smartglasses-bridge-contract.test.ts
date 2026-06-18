// Contract test for the SmartglassesView Wi-Fi bridge parser against real-shaped
// native-bridge responses. The field-name variants below are the contract the
// plugin actually handles at runtime: they mirror the Even Realities / Mentra
// native bridge shapes normalized in src/transport/even-bridge.ts
// (normalizeBridgeWifiEvent / normalizeWifiResult) and the request `op` payloads
// documented in docs/smartglasses.md ({op:"wifi_scan"|"wifi_status"|
// "wifi_configure"|"wifi_setup"}). Each fixture's shape is verified against those
// in-repo sources, not invented. This is the SmartglassesView (gui+xr) view's
// external-data contract: SmartglassesView calls these exact parser helpers on
// the bridge response when the user clicks Scan / Status / Configure / Setup.

import { describe, expect, it } from "vitest";
import {
  callWifiBridge,
  formatWifiStatus,
  parseWifiNetworks,
  type SmartglassesBridge,
} from "../ui/SmartglassesView.helpers.ts";

describe("Wi-Fi scan response parsing (parseWifiNetworks)", () => {
  it("parses the Even Realities `networks` array of {ssid} objects", () => {
    // request_wifi_scan response shape (Even Realities native bridge).
    const response = {
      networks: [
        { ssid: "HomeNet", rssi: -42, secure: true },
        { ssid: "OfficeNet", rssi: -67, secure: true },
        { ssid: "Cafe Guest", rssi: -80, secure: false },
      ],
    };
    expect(parseWifiNetworks(response)).toEqual([
      "HomeNet",
      "OfficeNet",
      "Cafe Guest",
    ]);
  });

  it("parses the Mentra-style `accessPoints` array with uppercase SSID keys", () => {
    // Mentra SDK scan result variant: accessPoints[] with SSID (caps) keys.
    const response = {
      accessPoints: [{ SSID: "MentraAP" }, { SSID: "Lab-5G" }],
    };
    expect(parseWifiNetworks(response)).toEqual(["MentraAP", "Lab-5G"]);
  });

  it("parses the `results` array used by wifi_scan_result events", () => {
    // wifi_scan_result event payload variant (see even-bridge normalizeBridgeWifiEvent).
    const response = { results: ["NetA", { name: "NetB" }, { ssid: "NetC" }] };
    expect(parseWifiNetworks(response)).toEqual(["NetA", "NetB", "NetC"]);
  });

  it("parses the `wifiNetworks` variant and drops blank SSIDs", () => {
    const response = {
      wifiNetworks: [{ ssid: "Real" }, { ssid: "" }, { ssid: "   " }, "Hidden"],
    };
    expect(parseWifiNetworks(response)).toEqual(["Real", "Hidden"]);
  });

  it("returns an empty list for an unrecognized / empty response", () => {
    expect(parseWifiNetworks({})).toEqual([]);
    expect(parseWifiNetworks(null)).toEqual([]);
    expect(parseWifiNetworks({ networks: "not-an-array" })).toEqual([]);
  });
});

describe("Wi-Fi status response formatting (formatWifiStatus)", () => {
  it("formats a connected status from the Even Realities {connected, ssid, localIp} shape", () => {
    // request_wifi_status response (Even Realities native bridge).
    const response = {
      connected: true,
      ssid: "HomeNet",
      localIp: "192.168.1.50",
    };
    expect(formatWifiStatus(response)).toBe(
      "Connected to HomeNet at 192.168.1.50",
    );
  });

  it("formats the Mentra wifiConnected/wifiSsid/wifiLocalIp variant", () => {
    // wifi_status_change event payload variant (see even-bridge normalizeBridgeWifiEvent).
    const response = {
      wifiConnected: true,
      wifiSsid: "MentraNet",
      wifiLocalIp: "10.0.0.8",
    };
    // formatWifiStatus reads ssid/wifiSsid/SSID and localIp/wifiLocalIp/ipAddress;
    // connected is read from connected/wifiConnected.
    expect(formatWifiStatus(response)).toBe(
      "Connected to MentraNet at 10.0.0.8",
    );
  });

  it("reports a disconnected status", () => {
    expect(formatWifiStatus({ connected: false })).toBe("Wi-Fi disconnected");
    expect(formatWifiStatus({ wifiConnected: false })).toBe(
      "Wi-Fi disconnected",
    );
  });

  it("prefers an explicit status/message string when present", () => {
    expect(formatWifiStatus({ status: "Connecting…" })).toBe("Connecting…");
    expect(formatWifiStatus({ message: "Provisioning started" })).toBe(
      "Provisioning started",
    );
  });

  it("falls back when the response carries no usable status fields", () => {
    expect(formatWifiStatus({})).toBe("Wi-Fi status requested");
    expect(formatWifiStatus(null)).toBe("Wi-Fi status requested");
  });
});

describe("Wi-Fi bridge command dispatch (callWifiBridge)", () => {
  it("dispatches request_wifi_scan to the typed requestWifiScan method", async () => {
    const calls: string[] = [];
    const bridge: SmartglassesBridge = {
      requestWifiScan: async () => {
        calls.push("requestWifiScan");
        return { networks: [{ ssid: "X" }] };
      },
    };
    await expect(
      callWifiBridge(bridge, "request_wifi_scan"),
    ).resolves.toMatchObject({ networks: [{ ssid: "X" }] });
    expect(calls).toEqual(["requestWifiScan"]);
  });

  it("dispatches request_wifi_status to requestWifiStatus", async () => {
    const calls: string[] = [];
    const bridge: SmartglassesBridge = {
      requestWifiStatus: async () => {
        calls.push("requestWifiStatus");
        return { connected: true, ssid: "Y" };
      },
    };
    await callWifiBridge(bridge, "request_wifi_status");
    expect(calls).toEqual(["requestWifiStatus"]);
  });

  it("dispatches request_wifi_setup with the reason payload", async () => {
    let receivedReason: string | undefined;
    const bridge: SmartglassesBridge = {
      requestWifiSetup: async (reason) => {
        receivedReason = reason;
        return { status: "ok" };
      },
    };
    await callWifiBridge(bridge, "request_wifi_setup", {
      reason: "Eliza needs headset Wi-Fi",
    });
    expect(receivedReason).toBe("Eliza needs headset Wi-Fi");
  });

  it("dispatches set_wifi_credentials to setWifiCredentials(ssid, password)", async () => {
    const received: Array<[string, string]> = [];
    const bridge: SmartglassesBridge = {
      setWifiCredentials: async (ssid, password) => {
        received.push([ssid, password]);
        return { status: "accepted" };
      },
    };
    await callWifiBridge(bridge, "set_wifi_credentials", {
      ssid: "Home Wi-Fi",
      password: "secret",
    });
    expect(received).toEqual([["Home Wi-Fi", "secret"]]);
  });

  it("falls back to sendWifiCredentials when setWifiCredentials is absent", async () => {
    const received: Array<[string, string]> = [];
    const bridge: SmartglassesBridge = {
      sendWifiCredentials: async (ssid, password) => {
        received.push([ssid, password]);
        return { status: "queued" };
      },
    };
    await callWifiBridge(bridge, "set_wifi_credentials", {
      ssid: "Net",
      password: "pw",
    });
    expect(received).toEqual([["Net", "pw"]]);
  });

  it("falls back to rawBridge.callEvenApp for commands the typed API does not cover", async () => {
    const calls: Array<{ name: string; payload?: Record<string, unknown> }> =
      [];
    const bridge: SmartglassesBridge = {
      rawBridge: {
        callEvenApp: async (name, payload) => {
          calls.push({ name, payload });
          return { status: "queued" };
        },
      },
    };
    await callWifiBridge(bridge, "request_wifi_scan");
    expect(calls).toEqual([{ name: "request_wifi_scan", payload: undefined }]);
  });

  it("throws for an unsupported Wi-Fi command when the bridge cannot service it", async () => {
    // A bridge with only a display method exposes no Wi-Fi pathway.
    const bridge: SmartglassesBridge = { displayText: () => undefined };
    await expect(callWifiBridge(bridge, "request_wifi_scan")).rejects.toThrow(
      "does not support Wi-Fi command: request_wifi_scan",
    );
  });
});
