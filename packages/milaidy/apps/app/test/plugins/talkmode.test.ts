/**
 * Tests for @milaidy/capacitor-talkmode — state machine, speak, config, permissions.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { TalkModeWeb } from "../../plugins/talkmode/src/web";

describe("@milaidy/capacitor-talkmode", () => {
  let tm: TalkModeWeb;

  beforeEach(() => {
    vi.restoreAllMocks();
    tm = new TalkModeWeb();
  });

  // -- Initial state --

  it("starts idle, disabled, not speaking", async () => {
    expect((await tm.isEnabled()).enabled).toBe(false);
    expect((await tm.getState())).toEqual({ state: "idle", statusText: "Off" });
    expect((await tm.isSpeaking()).speaking).toBe(false);
  });

  // -- Start --

  describe("start", () => {
    it("returns error when SpeechRecognition unavailable", async () => {
      const r = await tm.start();
      expect(r.started).toBe(false);
      expect(r.error).toContain("not supported");
    });

    it("stays disabled after failed start", async () => {
      await tm.start({ config: { silenceWindowMs: 500 } });
      expect((await tm.isEnabled()).enabled).toBe(false);
    });
  });

  // -- Stop --

  describe("stop", () => {
    it("resets to idle/Off/disabled", async () => {
      await tm.stop();
      expect(await tm.getState()).toEqual({ state: "idle", statusText: "Off" });
      expect((await tm.isEnabled()).enabled).toBe(false);
    });

    it("is idempotent", async () => {
      await tm.stop();
      await tm.stop();
      expect((await tm.isEnabled()).enabled).toBe(false);
    });
  });

  // -- Speak --

  describe("speak", () => {
    it("returns synthesis-unavailable error", async () => {
      const r = await tm.speak({ text: "Hello" });
      expect(r).toEqual({ completed: false, interrupted: false, usedSystemTts: false, error: "Speech synthesis not available" });
    });

    it.each(["", "   "])("empty/whitespace text ('%s') also returns synthesis error", async (text) => {
      expect((await tm.speak({ text })).completed).toBe(false);
    });
  });

  // -- Stop speaking --

  it("stopSpeaking returns empty when not speaking", async () => {
    expect(await tm.stopSpeaking()).toEqual({});
  });

  // -- Config --

  describe("config", () => {
    it("updateConfig merges without error", async () => {
      await tm.updateConfig({ config: { silenceWindowMs: 500 } });
      await tm.updateConfig({ config: { tts: { voiceId: "v1" }, stt: { engine: "web" } } });
    });

    it("updateConfig with empty config is safe", async () => {
      await expect(tm.updateConfig({ config: {} })).resolves.toBeUndefined();
    });
  });

  // -- Permissions --

  describe("permissions", () => {
    it("checkPermissions reports not_supported without SpeechRecognition", async () => {
      vi.spyOn(navigator.permissions, "query").mockResolvedValueOnce({ state: "granted" } as PermissionStatus);
      const r = await tm.checkPermissions();
      expect(r.microphone).toBe("granted");
      expect(r.speechRecognition).toBe("not_supported");
    });

    it("checkPermissions falls back to prompt on query failure", async () => {
      vi.spyOn(navigator.permissions, "query").mockRejectedValueOnce(new Error("nope"));
      expect((await tm.checkPermissions()).microphone).toBe("prompt");
    });

    it("requestPermissions calls getUserMedia for mic access", async () => {
      const stream = { getTracks: () => [{ stop: vi.fn() }] };
      const spy = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValueOnce(stream as unknown as MediaStream);
      vi.spyOn(navigator.permissions, "query").mockResolvedValue({ state: "granted" } as PermissionStatus);
      await tm.requestPermissions();
      expect(spy).toHaveBeenCalledWith({ audio: true });
    });
  });
});
