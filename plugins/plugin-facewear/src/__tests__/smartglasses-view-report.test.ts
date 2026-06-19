import { describe, expect, it } from "vitest";
import {
  G1AiStatus,
  G1Command,
  G1ScreenAction,
  G1TextStatus,
} from "../protocol/smartglasses.ts";
import {
  buildViewDisplayPackets,
  callWifiBridge,
  formatWifiStatus,
  type LensState,
  missingViewEvidence,
  parseWifiNetworks,
  viewCommandName,
  viewNextAction,
  viewPhysicalBlocker,
  viewScanDiagnosis,
  viewSetupHint,
} from "../ui/SmartglassesView.helpers.ts";

const baseTests = {
  headsetConnected: false,
  init: false,
  display: false,
  serial: false,
  serialObserved: false,
  settings: false,
  microphone: false,
  micEnableWrite: false,
  micDisableWrite: false,
  tapMicEnable: false,
  tapMicDisable: false,
  audio: false,
  transcript: false,
  eventStream: false,
};

function lenses(left: LensState, right: LensState) {
  return { left, right };
}

describe("smartglasses View Manager report helpers", () => {
  it("classifies whole-headset and partial pairing states", () => {
    expect(viewScanDiagnosis(lenses("idle", "idle"))).toBe("not_scanned");
    expect(viewScanDiagnosis(lenses("connected", "idle"))).toBe(
      "right_lens_missing",
    );
    expect(viewScanDiagnosis(lenses("idle", "connected"))).toBe(
      "left_lens_missing",
    );
    expect(viewScanDiagnosis(lenses("connected", "connected"))).toBe(
      "whole_headset_seen",
    );
    expect(viewScanDiagnosis(lenses("connected", "failed"))).toBe(
      "pairing_failed",
    );
  });

  it("requires wearing state, both lenses, display/settings, tap mic toggles, and audio", () => {
    expect(
      missingViewEvidence(
        baseTests,
        lenses("connected", "idle"),
        "charged_in_cradle",
        "cradle_fully_charged",
      ),
    ).toEqual(
      expect.arrayContaining([
        "rightLensConnected",
        "wearingStateObserved",
        "headsetInCradle",
        "connectionReadySent",
        "displayPacketsSent",
        "serialRequested",
        "serialObserved",
        "settingsSent",
        "rightMicEnableWrite",
        "rightMicDisableWrite",
        "tapMicEnable",
        "tapMicDisable",
        "rightOrBridgeAudio",
      ]),
    );

    expect(
      missingViewEvidence(
        {
          ...baseTests,
          init: true,
          display: true,
          serial: true,
          serialObserved: true,
          settings: true,
          micEnableWrite: true,
          micDisableWrite: true,
          tapMicEnable: true,
          tapMicDisable: true,
          audio: true,
        },
        lenses("connected", "connected"),
        "wearing",
        null,
        [
          {
            at: "2026-05-20T00:00:01.000Z",
            type: "tap",
            detail: "single_tap",
          },
          {
            at: "2026-05-20T00:00:03.000Z",
            type: "tap",
            detail: "double_tap",
          },
        ],
        [
          {
            at: "2026-05-20T00:00:02.000Z",
            side: "right",
            command: "open-mic",
            bytes: 2,
            hex: "0e01",
          },
          {
            at: "2026-05-20T00:00:04.000Z",
            side: "right",
            command: "open-mic",
            bytes: 2,
            hex: "0e00",
          },
        ],
      ),
    ).toEqual([]);
  });

  it("requires microphone writes to happen after the matching side tap", () => {
    const passedTests = {
      ...baseTests,
      init: true,
      display: true,
      serial: true,
      serialObserved: true,
      settings: true,
      micEnableWrite: true,
      micDisableWrite: true,
      tapMicEnable: true,
      tapMicDisable: true,
      audio: true,
    };
    const tapEvents = [
      {
        at: "2026-05-20T00:00:02.000Z",
        type: "tap",
        detail: "single_tap",
      },
      {
        at: "2026-05-20T00:00:04.000Z",
        type: "tap",
        detail: "double_tap",
      },
    ];
    const writes = [
      {
        at: "2026-05-20T00:00:01.000Z",
        side: "right" as const,
        command: "open-mic",
        bytes: 2,
        hex: "0e00",
      },
      {
        at: "2026-05-20T00:00:03.000Z",
        side: "right" as const,
        command: "open-mic",
        bytes: 2,
        hex: "0e01",
      },
    ];

    expect(
      missingViewEvidence(
        passedTests,
        lenses("connected", "connected"),
        "wearing",
        null,
        tapEvents,
        writes,
      ),
    ).toEqual(["rightMicDisableWrite"]);

    expect(
      viewPhysicalBlocker(
        passedTests,
        lenses("connected", "connected"),
        "wearing",
        null,
        tapEvents,
        writes,
      ),
    ).toBe("evidence_missing");
  });

  it("reports the current physical blocker and next setup action", () => {
    expect(
      viewPhysicalBlocker(baseTests, lenses("idle", "idle"), null, null),
    ).toBe("not_connected");
    expect(viewNextAction("not_connected")).toBe("Connect Headset");

    expect(
      viewPhysicalBlocker(
        baseTests,
        lenses("connected", "idle"),
        "wearing",
        null,
      ),
    ).toBe("partial_headset");
    expect(viewSetupHint("partial_headset", "wearing", null)).toBe(
      "Reconnect the whole headset so both left and right lenses are present.",
    );

    expect(
      viewPhysicalBlocker(
        baseTests,
        lenses("connected", "connected"),
        "charged_in_cradle",
        "cradle_fully_charged",
      ),
    ).toBe("in_charging_base");

    expect(
      viewPhysicalBlocker(
        baseTests,
        lenses("connected", "connected"),
        null,
        null,
      ),
    ).toBe("wearing_state_missing");

    expect(
      viewPhysicalBlocker(
        baseTests,
        lenses("connected", "connected"),
        "wearing",
        null,
      ),
    ).toBe("evidence_missing");

    expect(
      viewPhysicalBlocker(
        {
          ...baseTests,
          init: true,
          display: true,
          serial: true,
          serialObserved: true,
          settings: true,
          micEnableWrite: true,
          micDisableWrite: true,
          tapMicEnable: true,
          tapMicDisable: true,
          audio: true,
        },
        lenses("connected", "connected"),
        "wearing",
        null,
        [
          {
            at: "2026-05-20T00:00:01.000Z",
            type: "tap",
            detail: "single_tap",
          },
          {
            at: "2026-05-20T00:00:03.000Z",
            type: "tap",
            detail: "double_tap",
          },
        ],
        [
          {
            at: "2026-05-20T00:00:02.000Z",
            side: "right",
            command: "open-mic",
            bytes: 2,
            hex: "0e01",
          },
          {
            at: "2026-05-20T00:00:04.000Z",
            side: "right",
            command: "open-mic",
            bytes: 2,
            hex: "0e00",
          },
        ],
      ),
    ).toBeNull();
  });

  it("names G1 writes in copied View Manager diagnostics", () => {
    expect(viewCommandName(Uint8Array.from([0x4d, 0x01]))).toBe("init");
    expect(viewCommandName(Uint8Array.from([0x4e, 0x00]))).toBe(
      "display-result",
    );
    expect(viewCommandName(Uint8Array.from([0x0e, 0x01]))).toBe("open-mic");
    expect(viewCommandName(Uint8Array.from([0xab]))).toBe("0xab");
    expect(viewCommandName(Uint8Array.from([]))).toBe("empty");
  });

  it("streams View Manager display pages with incrementing sequence IDs and completion", () => {
    const display = buildViewDisplayPackets(
      Array.from({ length: 90 }, (_, index) => `word${index}`).join(" "),
      { startSeq: 41 },
    );
    const statuses = display.packets.map((packet) => packet[4]);

    expect(display.pages).toBeGreaterThan(1);
    expect(display.nextSeq).toBe(41 + display.pages + 1);
    expect(
      display.packets.every((packet) => packet[0] === G1Command.SendResult),
    ).toBe(true);
    expect([...new Set(display.packets.map((packet) => packet[1]))]).toEqual(
      Array.from({ length: display.pages + 1 }, (_, index) => 41 + index),
    );
    expect(statuses[0]).toBe(G1AiStatus.Displaying | G1ScreenAction.NewContent);
    expect(statuses.at(-2)).toBe(G1AiStatus.Displaying);
    expect(statuses.at(-1)).toBe(G1AiStatus.DisplayComplete);
  });

  it("can send direct text display status without an extra AI completion page", () => {
    const display = buildViewDisplayPackets("plain text mode", {
      startSeq: 7,
      mode: "text",
    });

    expect(display.nextSeq).toBe(8);
    expect(display.packets).toHaveLength(1);
    expect(display.packets[0][1]).toBe(7);
    expect(display.packets[0][4]).toBe(
      G1TextStatus.TextShow | G1ScreenAction.NewContent,
    );
  });

  it("normalizes View Manager Wi-Fi responses and rejects unsupported bridge commands", async () => {
    expect(
      parseWifiNetworks({
        networks: [{ ssid: "Home" }, { SSID: "Office" }, "Guest"],
      }),
    ).toEqual(["Home", "Office", "Guest"]);
    expect(formatWifiStatus({ connected: true, ssid: "Home" })).toBe(
      "Connected to Home",
    );

    const calls: Array<{ name: string; payload?: Record<string, unknown> }> =
      [];
    await expect(
      callWifiBridge(
        {
          rawBridge: {
            callEvenApp: async (name, payload) => {
              calls.push({ name, payload });
              return { status: "queued" };
            },
          },
        },
        "set_wifi_credentials",
        { ssid: "Home", password: "secret" },
      ),
    ).resolves.toMatchObject({ status: "queued" });
    expect(calls).toEqual([
      {
        name: "set_wifi_credentials",
        payload: { ssid: "Home", password: "secret" },
      },
    ]);

    await expect(
      callWifiBridge({ displayText: () => undefined }, "request_wifi_scan"),
    ).rejects.toThrow("does not support Wi-Fi command");
  });
});
