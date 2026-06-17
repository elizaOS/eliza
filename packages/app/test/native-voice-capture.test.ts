// @vitest-environment jsdom

/**
 * Native voice-capture shim (src/native/voice-capture.ts) — degradation off
 * Android. With @capacitor/core mocked to a non-android platform, the shim
 * must no-op: resolve `false`/`undefined` without throwing and never register
 * the native `VoiceCapture` plugin. This lives in its own file (not the
 * AndroidVoicePill component suite) because that suite mocks the whole shim
 * module, which would shadow the REAL implementation these tests exercise.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { capacitorPlatform, registerPluginMock } = vi.hoisted(() => ({
  capacitorPlatform: { value: "web" as string },
  registerPluginMock: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => capacitorPlatform.value,
    registerPlugin: registerPluginMock,
  },
}));

describe("native/voice-capture shim — non-Android degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    capacitorPlatform.value = "web";
  });

  it("startBackgroundVoiceCapture resolves false off Android without throwing or registering a plugin", async () => {
    const { startBackgroundVoiceCapture } = await import(
      "../src/native/voice-capture"
    );

    await expect(startBackgroundVoiceCapture("always-on")).resolves.toBe(false);
    expect(registerPluginMock).not.toHaveBeenCalled();
  });

  it("stop/setMode are no-ops off Android", async () => {
    const { stopBackgroundVoiceCapture, setBackgroundVoiceCaptureMode } =
      await import("../src/native/voice-capture");

    await expect(stopBackgroundVoiceCapture()).resolves.toBeUndefined();
    await expect(
      setBackgroundVoiceCaptureMode("vad-gated"),
    ).resolves.toBeUndefined();
    expect(registerPluginMock).not.toHaveBeenCalled();
  });
});
