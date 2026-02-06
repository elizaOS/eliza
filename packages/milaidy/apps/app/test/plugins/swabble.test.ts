/**
 * Tests for @milaidy/capacitor-swabble — wake word, speech, audio devices, permissions.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SwabbleWeb } from "../../plugins/swabble/src/web";

describe("@milaidy/capacitor-swabble", () => {
  let sw: SwabbleWeb;

  beforeEach(() => {
    vi.restoreAllMocks();
    sw = new SwabbleWeb();
  });

  // -- State machine --

  describe("state", () => {
    it("starts idle with null config", async () => {
      expect((await sw.isListening()).listening).toBe(false);
      expect((await sw.getConfig()).config).toBeNull();
    });

    it("stop is idempotent", async () => {
      await sw.stop();
      await sw.stop();
      expect((await sw.isListening()).listening).toBe(false);
    });
  });

  // -- Start without SpeechRecognition --

  describe("start without SpeechRecognition", () => {
    it("returns error and stays idle", async () => {
      const r = await sw.start({ config: { triggers: ["hey claude"] } });
      expect(r.started).toBe(false);
      expect(r.error).toContain("not supported");
      expect((await sw.isListening()).listening).toBe(false);
    });
  });

  // -- Config --

  it("updateConfig is a no-op when not started", async () => {
    await sw.updateConfig({ config: { triggers: ["new"], locale: "fr-FR" } });
    expect((await sw.getConfig()).config).toBeNull();
  });

  // -- Audio devices --

  describe("audio devices", () => {
    it("returns empty on enumerateDevices failure", async () => {
      vi.spyOn(navigator.mediaDevices, "enumerateDevices").mockRejectedValueOnce(new Error("denied"));
      expect((await sw.getAudioDevices()).devices).toEqual([]);
    });

    it("filters to audioinput and labels correctly", async () => {
      vi.spyOn(navigator.mediaDevices, "enumerateDevices").mockResolvedValueOnce([
        { kind: "audioinput", deviceId: "default", label: "Default Mic", groupId: "g", toJSON: () => ({}) },
        { kind: "videoinput", deviceId: "cam", label: "Camera", groupId: "g", toJSON: () => ({}) },
        { kind: "audioinput", deviceId: "usb", label: "", groupId: "g", toJSON: () => ({}) },
      ] as MediaDeviceInfo[]);

      const { devices } = await sw.getAudioDevices();
      expect(devices).toHaveLength(2);
      expect(devices[0]).toEqual({ id: "default", name: "Default Mic", isDefault: true });
      expect(devices[1]).toEqual({ id: "usb", name: "Microphone 2", isDefault: false });
    });
  });

  // -- setAudioDevice --

  it("setAudioDevice throws on web", async () => {
    await expect(sw.setAudioDevice({ deviceId: "x" })).rejects.toThrow(/not supported on web/i);
  });

  // -- Permissions --

  describe("permissions", () => {
    it("checkPermissions reports not_supported for speechRecognition", async () => {
      vi.spyOn(navigator.permissions, "query").mockResolvedValueOnce({ state: "granted" } as PermissionStatus);
      const r = await sw.checkPermissions();
      expect(r.microphone).toBe("granted");
      expect(r.speechRecognition).toBe("not_supported");
    });

    it("checkPermissions falls back to prompt on query failure", async () => {
      vi.spyOn(navigator.permissions, "query").mockRejectedValueOnce(new Error("nope"));
      expect((await sw.checkPermissions()).microphone).toBe("prompt");
    });

    it("requestPermissions returns denied when getUserMedia fails", async () => {
      vi.spyOn(navigator.mediaDevices, "getUserMedia").mockRejectedValueOnce(new Error("denied"));
      const r = await sw.requestPermissions();
      expect(r.microphone).toBe("denied");
      expect(r.speechRecognition).toBe("denied");
    });
  });
});
