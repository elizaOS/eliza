import { describe, expect, it } from "vitest";
import type { GlassSide } from "../protocol.js";
import { type LensState, missingViewEvidence } from "../ui/SmartglassesView.js";

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
});
