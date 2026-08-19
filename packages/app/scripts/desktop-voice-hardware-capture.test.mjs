/** Exercises platform device preflight for desktop hardware voice capture. */

import { describe, expect, test } from "vitest";
import { captureInputs } from "./desktop-voice-hardware-capture.mjs";

describe("desktop hardware capture inputs", () => {
  test("builds one macOS recorder with distinct physical and loopback devices", () => {
    const result = captureInputs("darwin", {
      ELIZA_VOICE_HARDWARE_SCREEN_DEVICE: "1",
      ELIZA_VOICE_HARDWARE_MIC_DEVICE: "USB Microphone",
      ELIZA_VOICE_HARDWARE_SPEAKER_LOOPBACK_DEVICE: "BlackHole 2ch",
    });
    expect(result.args.join(" ")).toContain("1:none");
    expect(result.args.join(" ")).toContain("none:USB Microphone");
    expect(result.args.join(" ")).toContain("none:BlackHole 2ch");
  });

  test("fails preflight before launch when a hardware device is unspecified", () => {
    expect(() =>
      captureInputs("win32", {
        ELIZA_VOICE_HARDWARE_MIC_DEVICE: "USB Microphone",
      }),
    ).toThrow(/ELIZA_VOICE_HARDWARE_SPEAKER_LOOPBACK_DEVICE is required/);
  });
});
