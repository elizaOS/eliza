/** Exercises platform device preflight for desktop hardware voice capture. */

import { describe, expect, test } from "vitest";
import {
  assertConfiguredDevicesListed,
  captureInputs,
} from "./desktop-voice-hardware-capture.mjs";

describe("desktop hardware capture inputs", () => {
  test("builds one macOS recorder with distinct physical and loopback devices", () => {
    const result = captureInputs("darwin", {
      ELIZA_VOICE_HARDWARE_SCREEN_DEVICE: "1",
      ELIZA_VOICE_HARDWARE_MIC_DEVICE: "USB Microphone",
      ELIZA_VOICE_HARDWARE_SPEAKER_LOOPBACK_DEVICE: "BlackHole 2ch",
      ELIZA_VOICE_BROWSER_MIC_DEVICE_ID: "browser-mic-id",
      ELIZA_VOICE_BROWSER_SPEAKER_DEVICE_ID: "browser-speaker-id",
    });
    expect(result.args.join(" ")).toContain("1:none");
    expect(result.args.join(" ")).toContain("none:USB Microphone");
    expect(result.args.join(" ")).toContain("none:BlackHole 2ch");
  });

  test("fails preflight before launch when a hardware device is unspecified", () => {
    expect(() =>
      captureInputs("win32", {
        ELIZA_VOICE_HARDWARE_MIC_DEVICE: "USB Microphone",
        ELIZA_VOICE_BROWSER_MIC_DEVICE_ID: "browser-mic-id",
        ELIZA_VOICE_BROWSER_SPEAKER_DEVICE_ID: "browser-speaker-id",
      }),
    ).toThrow(/ELIZA_VOICE_HARDWARE_SPEAKER_LOOPBACK_DEVICE is required/);
  });

  test("rejects a loopback source reused as the claimed physical microphone", () => {
    expect(() =>
      captureInputs("win32", {
        ELIZA_VOICE_HARDWARE_MIC_DEVICE: "Stereo Mix",
        ELIZA_VOICE_HARDWARE_SPEAKER_LOOPBACK_DEVICE: "Stereo Mix",
        ELIZA_VOICE_BROWSER_MIC_DEVICE_ID: "browser-mic-id",
        ELIZA_VOICE_BROWSER_SPEAKER_DEVICE_ID: "browser-speaker-id",
      }),
    ).toThrow(/must be distinct/);
  });

  test("requires every configured ffmpeg endpoint in the live enumeration", () => {
    const inputs = captureInputs("darwin", {
      ELIZA_VOICE_HARDWARE_SCREEN_DEVICE: "1",
      ELIZA_VOICE_HARDWARE_MIC_DEVICE: "USB Microphone",
      ELIZA_VOICE_HARDWARE_SPEAKER_LOOPBACK_DEVICE: "BlackHole 2ch",
      ELIZA_VOICE_BROWSER_MIC_DEVICE_ID: "browser-mic-id",
      ELIZA_VOICE_BROWSER_SPEAKER_DEVICE_ID: "browser-speaker-id",
    });
    expect(() =>
      assertConfiguredDevicesListed(
        "darwin",
        inputs,
        '[1] "Screen 1"\n[2] "USB Microphone"',
      ),
    ).toThrow(/speaker loopback.*absent/);
    expect(() =>
      assertConfiguredDevicesListed(
        "darwin",
        inputs,
        '[1] "Screen 1"\n[2] "USB Microphone"\n[3] "BlackHole 2ch"',
      ),
    ).not.toThrow();
    expect(() =>
      assertConfiguredDevicesListed(
        "darwin",
        { ...inputs, microphone: "2", speakerLoopback: "USB Microphone" },
        '[1] "Screen 1"\n[2] "USB Microphone"',
      ),
    ).toThrow(/resolve to the same device/);
  });
});
