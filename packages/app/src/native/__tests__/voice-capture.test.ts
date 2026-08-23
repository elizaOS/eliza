/**
 * Unit coverage for the Android-only VoiceCapture Capacitor shim. Capacitor is
 * mocked at the host boundary; start/stop/setMode are the real module,
 * re-imported after each case so the module-level cache does not leak.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundCaptureMode } from "../voice-capture.js";

const mocks = vi.hoisted(() => ({
  getPlatform: vi.fn(),
  registerPlugin: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => mocks.getPlatform(),
    registerPlugin: (name: string) => mocks.registerPlugin(name),
  },
}));

function makePlugin() {
  return {
    startBackgroundCapture: vi.fn(
      async (_options?: { mode?: BackgroundCaptureMode }) => ({
        started: true as boolean,
      }),
    ),
    stopBackgroundCapture: vi.fn(async () => ({ stopped: true })),
    setMode: vi.fn(async (_options: { mode: BackgroundCaptureMode }) => ({
      ok: true,
    })),
    isCaptureSupported: vi.fn(async () => ({ granted: true })),
    requestMicPermission: vi.fn(async () => ({ granted: true })),
  };
}

async function loadModule() {
  return import("../voice-capture.js");
}

function installAndroidPlugin() {
  const plugin = makePlugin();
  mocks.getPlatform.mockReturnValue("android");
  mocks.registerPlugin.mockReturnValue(plugin);
  return plugin;
}

describe("startBackgroundVoiceCapture", () => {
  beforeEach(() => {
    mocks.getPlatform.mockReset();
    mocks.registerPlugin.mockReset();
    vi.resetModules();
  });

  it.each([
    "web",
    "ios",
    "electron",
    "Android",
    "ANDROID",
    "android ",
    " android",
    "",
  ])(
    "resolves false on platform %j without registering VoiceCapture",
    async (platform) => {
      const { startBackgroundVoiceCapture } = await loadModule();
      mocks.getPlatform.mockReturnValue(platform);

      await expect(startBackgroundVoiceCapture("always-on")).resolves.toBe(
        false,
      );
      expect(mocks.registerPlugin).not.toHaveBeenCalled();
    },
  );

  it("registers VoiceCapture once on Android and returns the native started flag", async () => {
    const { startBackgroundVoiceCapture } = await loadModule();
    const plugin = installAndroidPlugin();

    await expect(startBackgroundVoiceCapture("always-on")).resolves.toBe(true);
    await expect(startBackgroundVoiceCapture("off")).resolves.toBe(true);

    expect(mocks.registerPlugin).toHaveBeenCalledTimes(1);
    expect(mocks.registerPlugin).toHaveBeenCalledWith("VoiceCapture");
    expect(plugin.startBackgroundCapture).toHaveBeenCalledTimes(2);
    expect(plugin.startBackgroundCapture).toHaveBeenNthCalledWith(1, {
      mode: "always-on",
    });
    expect(plugin.startBackgroundCapture).toHaveBeenNthCalledWith(2, {
      mode: "off",
    });
    expect(plugin.requestMicPermission).not.toHaveBeenCalled();
  });

  it("defaults the capture mode to vad-gated when the caller omits it", async () => {
    const { startBackgroundVoiceCapture } = await loadModule();
    const plugin = installAndroidPlugin();

    await expect(startBackgroundVoiceCapture()).resolves.toBe(true);
    expect(plugin.startBackgroundCapture).toHaveBeenCalledWith({
      mode: "vad-gated",
    });
  });

  it.each(["off", "vad-gated", "always-on"] as const)(
    "forwards mode %s to startBackgroundCapture",
    async (mode) => {
      const { startBackgroundVoiceCapture } = await loadModule();
      const plugin = installAndroidPlugin();

      await expect(startBackgroundVoiceCapture(mode)).resolves.toBe(true);
      expect(plugin.startBackgroundCapture).toHaveBeenCalledWith({ mode });
    },
  );

  it("returns false when the native service reports started: false", async () => {
    const { startBackgroundVoiceCapture } = await loadModule();
    const plugin = installAndroidPlugin();
    plugin.startBackgroundCapture.mockResolvedValue({ started: false });

    await expect(startBackgroundVoiceCapture("vad-gated")).resolves.toBe(false);
    expect(plugin.startBackgroundCapture).toHaveBeenCalledTimes(1);
  });

  it("skips the mic prompt when isCaptureSupported already reports granted", async () => {
    const { startBackgroundVoiceCapture } = await loadModule();
    const plugin = installAndroidPlugin();
    plugin.isCaptureSupported.mockResolvedValue({ granted: true });

    await expect(startBackgroundVoiceCapture()).resolves.toBe(true);
    expect(plugin.isCaptureSupported).toHaveBeenCalledTimes(1);
    expect(plugin.requestMicPermission).not.toHaveBeenCalled();
    expect(plugin.startBackgroundCapture).toHaveBeenCalledTimes(1);
  });

  it("returns false after a denied recheck without starting capture", async () => {
    const { startBackgroundVoiceCapture } = await loadModule();
    const plugin = installAndroidPlugin();
    plugin.isCaptureSupported
      .mockResolvedValueOnce({ granted: false })
      .mockResolvedValueOnce({ granted: false });
    plugin.requestMicPermission.mockResolvedValue({ granted: true });

    await expect(startBackgroundVoiceCapture("always-on")).resolves.toBe(false);
    expect(plugin.requestMicPermission).toHaveBeenCalledTimes(1);
    expect(plugin.isCaptureSupported).toHaveBeenCalledTimes(2);
    expect(plugin.startBackgroundCapture).not.toHaveBeenCalled();
  });

  it("starts capture when the post-prompt recheck grants RECORD_AUDIO", async () => {
    const { startBackgroundVoiceCapture } = await loadModule();
    const plugin = installAndroidPlugin();
    plugin.isCaptureSupported
      .mockResolvedValueOnce({ granted: false })
      .mockResolvedValueOnce({ granted: true });
    plugin.requestMicPermission.mockResolvedValue({ granted: false });

    await expect(startBackgroundVoiceCapture("off")).resolves.toBe(true);
    expect(plugin.requestMicPermission).toHaveBeenCalledTimes(1);
    expect(plugin.startBackgroundCapture).toHaveBeenCalledWith({ mode: "off" });
  });

  it("treats a missing granted flag as unsupported and rechecks after the prompt", async () => {
    const { startBackgroundVoiceCapture } = await loadModule();
    const plugin = installAndroidPlugin();
    plugin.isCaptureSupported
      .mockResolvedValueOnce({ granted: undefined as unknown as boolean })
      .mockResolvedValueOnce({ granted: false });

    await expect(startBackgroundVoiceCapture()).resolves.toBe(false);
    expect(plugin.requestMicPermission).toHaveBeenCalledTimes(1);
    expect(plugin.startBackgroundCapture).not.toHaveBeenCalled();
  });

  it("propagates a native isCaptureSupported rejection", async () => {
    const { startBackgroundVoiceCapture } = await loadModule();
    const plugin = installAndroidPlugin();
    plugin.isCaptureSupported.mockRejectedValue(new Error("mic probe failed"));

    await expect(startBackgroundVoiceCapture()).rejects.toThrow(
      "mic probe failed",
    );
    expect(plugin.startBackgroundCapture).not.toHaveBeenCalled();
  });

  it("propagates a native startBackgroundCapture rejection after permission", async () => {
    const { startBackgroundVoiceCapture } = await loadModule();
    const plugin = installAndroidPlugin();
    plugin.startBackgroundCapture.mockRejectedValue(new Error("service down"));

    await expect(startBackgroundVoiceCapture()).rejects.toThrow("service down");
  });
});

describe("stopBackgroundVoiceCapture", () => {
  beforeEach(() => {
    mocks.getPlatform.mockReset();
    mocks.registerPlugin.mockReset();
    vi.resetModules();
  });

  it.each(["web", "ios", "electron", ""])(
    "is a no-op on platform %j",
    async (platform) => {
      const { stopBackgroundVoiceCapture } = await loadModule();
      mocks.getPlatform.mockReturnValue(platform);

      await expect(stopBackgroundVoiceCapture()).resolves.toBeUndefined();
      expect(mocks.registerPlugin).not.toHaveBeenCalled();
    },
  );

  it("awaits the native stop on Android and discards the plugin payload", async () => {
    const { stopBackgroundVoiceCapture } = await loadModule();
    const plugin = installAndroidPlugin();
    plugin.stopBackgroundCapture.mockResolvedValue({ stopped: false });

    await expect(stopBackgroundVoiceCapture()).resolves.toBeUndefined();
    expect(mocks.registerPlugin).toHaveBeenCalledWith("VoiceCapture");
    expect(plugin.stopBackgroundCapture).toHaveBeenCalledTimes(1);
    expect(plugin.stopBackgroundCapture).toHaveBeenCalledWith();
  });

  it("propagates a native stop rejection", async () => {
    const { stopBackgroundVoiceCapture } = await loadModule();
    const plugin = installAndroidPlugin();
    plugin.stopBackgroundCapture.mockRejectedValue(new Error("stop failed"));

    await expect(stopBackgroundVoiceCapture()).rejects.toThrow("stop failed");
  });
});

describe("setBackgroundVoiceCaptureMode", () => {
  beforeEach(() => {
    mocks.getPlatform.mockReset();
    mocks.registerPlugin.mockReset();
    vi.resetModules();
  });

  it.each(["web", "ios", "electron", ""])(
    "is a no-op on platform %j",
    async (platform) => {
      const { setBackgroundVoiceCaptureMode } = await loadModule();
      mocks.getPlatform.mockReturnValue(platform);

      await expect(
        setBackgroundVoiceCaptureMode("off"),
      ).resolves.toBeUndefined();
      expect(mocks.registerPlugin).not.toHaveBeenCalled();
    },
  );

  it.each(["off", "vad-gated", "always-on"] as const)(
    "forwards mode %s to the native setMode call",
    async (mode) => {
      const { setBackgroundVoiceCaptureMode } = await loadModule();
      const plugin = installAndroidPlugin();

      await expect(
        setBackgroundVoiceCaptureMode(mode),
      ).resolves.toBeUndefined();
      expect(plugin.setMode).toHaveBeenCalledWith({ mode });
    },
  );

  it("propagates a native setMode rejection", async () => {
    const { setBackgroundVoiceCaptureMode } = await loadModule();
    const plugin = installAndroidPlugin();
    plugin.setMode.mockRejectedValue(new Error("mode rejected"));

    await expect(setBackgroundVoiceCaptureMode("always-on")).rejects.toThrow(
      "mode rejected",
    );
  });
});

describe("VoiceCapture plugin cache", () => {
  beforeEach(() => {
    mocks.getPlatform.mockReset();
    mocks.registerPlugin.mockReset();
    vi.resetModules();
  });

  it("reuses one registered plugin across start, stop, and setMode", async () => {
    const {
      startBackgroundVoiceCapture,
      stopBackgroundVoiceCapture,
      setBackgroundVoiceCaptureMode,
    } = await loadModule();
    const plugin = installAndroidPlugin();

    await startBackgroundVoiceCapture("vad-gated");
    await setBackgroundVoiceCaptureMode("always-on");
    await stopBackgroundVoiceCapture();

    expect(mocks.registerPlugin).toHaveBeenCalledTimes(1);
    expect(plugin.startBackgroundCapture).toHaveBeenCalledTimes(1);
    expect(plugin.setMode).toHaveBeenCalledWith({ mode: "always-on" });
    expect(plugin.stopBackgroundCapture).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the cached plugin after a later non-Android probe", async () => {
    const {
      startBackgroundVoiceCapture,
      stopBackgroundVoiceCapture,
      setBackgroundVoiceCaptureMode,
    } = await loadModule();
    const plugin = installAndroidPlugin();

    await expect(startBackgroundVoiceCapture()).resolves.toBe(true);

    mocks.getPlatform.mockReturnValue("web");
    await expect(startBackgroundVoiceCapture()).resolves.toBe(false);
    await expect(stopBackgroundVoiceCapture()).resolves.toBeUndefined();
    await expect(setBackgroundVoiceCaptureMode("off")).resolves.toBeUndefined();

    expect(mocks.registerPlugin).toHaveBeenCalledTimes(1);
    expect(plugin.startBackgroundCapture).toHaveBeenCalledTimes(1);
    expect(plugin.stopBackgroundCapture).not.toHaveBeenCalled();
    expect(plugin.setMode).not.toHaveBeenCalled();
  });

  it("reuses the cached plugin when Android is selected again after a non-Android probe", async () => {
    const { startBackgroundVoiceCapture, setBackgroundVoiceCaptureMode } =
      await loadModule();
    const plugin = installAndroidPlugin();

    await startBackgroundVoiceCapture("off");
    mocks.getPlatform.mockReturnValue("ios");
    await expect(startBackgroundVoiceCapture()).resolves.toBe(false);

    mocks.getPlatform.mockReturnValue("android");
    await setBackgroundVoiceCaptureMode("vad-gated");

    expect(mocks.registerPlugin).toHaveBeenCalledTimes(1);
    expect(plugin.setMode).toHaveBeenCalledWith({ mode: "vad-gated" });
  });

  it("registers on the first Android call after earlier non-Android probes", async () => {
    const { startBackgroundVoiceCapture, stopBackgroundVoiceCapture } =
      await loadModule();
    mocks.getPlatform.mockReturnValue("web");

    await expect(startBackgroundVoiceCapture()).resolves.toBe(false);
    expect(mocks.registerPlugin).not.toHaveBeenCalled();

    const plugin = makePlugin();
    mocks.getPlatform.mockReturnValue("android");
    mocks.registerPlugin.mockReturnValue(plugin);
    await expect(startBackgroundVoiceCapture("always-on")).resolves.toBe(true);
    await stopBackgroundVoiceCapture();

    expect(mocks.registerPlugin).toHaveBeenCalledTimes(1);
    expect(mocks.registerPlugin).toHaveBeenCalledWith("VoiceCapture");
    expect(plugin.stopBackgroundCapture).toHaveBeenCalledTimes(1);
  });
});
