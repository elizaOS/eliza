import { describe, expect, it } from "vitest";
import type { GlassSide } from "../protocol.js";
import {
  callWifiBridge,
  formatWifiStatus,
  type LensState,
  missingViewEvidence,
  parseWifiNetworks,
} from "../ui/SmartglassesView.js";

const completeTests: Record<string, boolean> = {
  headsetConnected: true,
  init: true,
  display: true,
  serial: true,
  settings: true,
  microphone: true,
  micEnableWrite: true,
  micDisableWrite: true,
  tapMicEnable: true,
  tapMicDisable: true,
  audio: true,
  transcript: false,
  eventStream: true,
};

const connectedLenses: Record<GlassSide, LensState> = {
  left: "connected",
  right: "connected",
};

describe("Smartglasses View Manager diagnostics", () => {
  it("accepts complete whole-headset tap and audio evidence", () => {
    expect(
      missingViewEvidence(completeTests, connectedLenses, "wearing", null),
    ).toEqual([]);
  });

  it("flags cradle state separately from missing tap and audio evidence", () => {
    expect(
      missingViewEvidence(
        {
          ...completeTests,
          micEnableWrite: false,
          tapMicEnable: false,
          audio: false,
        },
        connectedLenses,
        "charged_in_cradle",
        "cradle_charging_cable_changed",
      ),
    ).toEqual(
      expect.arrayContaining([
        "wearingStateObserved",
        "headsetInCradle",
        "rightMicEnableWrite",
        "tapMicEnable",
        "rightOrBridgeAudio",
      ]),
    );
  });

  it("rejects partial headset pairing", () => {
    expect(
      missingViewEvidence(
        completeTests,
        { left: "connected", right: "idle" },
        "wearing",
        null,
      ),
    ).toEqual(["rightLensConnected"]);
  });

  it("normalizes common native bridge Wi-Fi scan result shapes", () => {
    expect(
      parseWifiNetworks({
        wifiNetworks: [
          { ssid: "Home" },
          { SSID: "Office" },
          { name: "Phone hotspot" },
          { ssid: "   " },
        ],
      }),
    ).toEqual(["Home", "Office", "Phone hotspot"]);

    expect(parseWifiNetworks({ accessPoints: ["Cafe", " Lab "] })).toEqual([
      "Cafe",
      "Lab",
    ]);
  });

  it("formats common native bridge Wi-Fi status payloads", () => {
    expect(
      formatWifiStatus({
        connected: true,
        ssid: "Home",
        localIp: "192.168.1.44",
      }),
    ).toBe("Connected to Home at 192.168.1.44");
    expect(formatWifiStatus({ wifiConnected: false })).toBe(
      "Wi-Fi disconnected",
    );
    expect(formatWifiStatus({ state: "joining" })).toBe("joining");
  });

  it("uses direct native Wi-Fi bridge methods before raw bridge fallbacks", async () => {
    const calls: unknown[] = [];
    const bridge = {
      requestWifiScan: () => ({ networks: ["Direct"] }),
      requestWifiStatus: () => ({ connected: true, ssid: "Direct" }),
      requestWifiSetup: (reason?: string) => calls.push(["setup", reason]),
      setWifiCredentials: (ssid: string, password: string) =>
        calls.push(["credentials", ssid, password]),
      rawBridge: {
        callEvenApp: (name: string, payload?: Record<string, unknown>) =>
          calls.push(["raw", name, payload]),
      },
    };

    await expect(callWifiBridge(bridge, "request_wifi_scan")).resolves.toEqual({
      networks: ["Direct"],
    });
    await callWifiBridge(bridge, "set_wifi_credentials", {
      ssid: "Home",
      password: "secret",
    });
    await callWifiBridge(bridge, "request_wifi_setup", {
      reason: "Need Wi-Fi",
    });
    await expect(
      callWifiBridge(bridge, "request_wifi_status"),
    ).resolves.toEqual({
      connected: true,
      ssid: "Direct",
    });

    expect(calls).toEqual([
      ["credentials", "Home", "secret"],
      ["setup", "Need Wi-Fi"],
    ]);
  });
});
