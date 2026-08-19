/** Exercises platform device preflight for desktop hardware voice capture. */

import { describe, expect, test } from "vitest";
import {
  assertConfiguredDevicesListed,
  captureInputs,
  classifyPhysicalMicrophoneEndpoint,
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

  test("resolves duplicate macOS indices within their canonical media sections", () => {
    const resolved = assertConfiguredDevicesListed(
      "darwin",
      {
        screen: "0",
        microphone: "1",
        speakerLoopback: "0",
      },
      [
        "AVFoundation video devices:",
        "[0] Capture screen 0",
        "[1] USB webcam",
        "AVFoundation audio devices:",
        "[0] BlackHole 2ch",
        "[1] Shure MV7 USB Microphone",
      ].join("\n"),
    );
    expect(resolved).toEqual({
      microphone: "Shure MV7 USB Microphone",
      "speaker loopback": "BlackHole 2ch",
      screen: "Capture screen 0",
    });
  });

  test.each([
    ["darwin", "BlackHole 16ch"],
    ["win32", "VB-Audio Virtual Cable"],
    ["win32", "CABLE Output (VB-Audio Virtual Cable)"],
    ["win32", "Stereo Mix (Realtek Audio)"],
    ["win32", "virtual-audio-capturer"],
    ["darwin", "PulseAudio monitor"],
    ["win32", "Null Audio Input"],
    ["darwin", "Aggregate Device"],
    ["darwin", "Multi-Output Device"],
  ])("rejects %s virtual microphone endpoint %s", (platform, label) => {
    expect(() =>
      classifyPhysicalMicrophoneEndpoint(platform, label, label),
    ).toThrow(/physical voice evidence requires a real microphone input/);
  });

  test("rejects a virtual canonical endpoint hidden behind a numeric selector", () => {
    expect(() =>
      classifyPhysicalMicrophoneEndpoint("darwin", "2", "BlackHole 2ch"),
    ).toThrow(/physical voice evidence requires a real microphone input/);
  });

  test("fails closed on a platform without an explicit classifier", () => {
    expect(() =>
      classifyPhysicalMicrophoneEndpoint("linux", "hw:1", "USB microphone"),
    ).toThrow(/supports darwin or win32/);
  });

  test("records the exact enumerated non-virtual endpoint and classifier basis", () => {
    expect(
      classifyPhysicalMicrophoneEndpoint(
        "darwin",
        "2",
        "Shure MV7 USB Microphone",
      ),
    ).toEqual({
      kind: "physical-microphone",
      device: "2",
      enumeratedLabel: "Shure MV7 USB Microphone",
      classification: "operator-selected-enumerated-nonvirtual-endpoint",
      classifier: "eliza-voice-physical-microphone-v1",
      platform: "darwin",
    });
  });
});
