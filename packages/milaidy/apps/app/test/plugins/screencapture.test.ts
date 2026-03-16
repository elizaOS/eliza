/**
 * Tests for @milaidy/capacitor-screencapture — feature detection, state, errors, events.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ScreenCaptureWeb } from "../../plugins/screencapture/src/web";

describe("@milaidy/capacitor-screencapture", () => {
  let sc: ScreenCaptureWeb;

  beforeEach(() => {
    vi.restoreAllMocks();
    sc = new ScreenCaptureWeb();
  });

  // -- Feature detection --

  describe("isSupported", () => {
    it("returns supported=true with features when getDisplayMedia exists", async () => {
      const r = await sc.isSupported();
      expect(r.supported).toBe(true);
      expect(r.features).toContain("screenshot");
      expect(r.features).toContain("recording");
      expect(r.features).toContain("system_audio");
    });
  });

  // -- Recording state --

  it("reports not recording by default", async () => {
    expect(await sc.getRecordingState()).toEqual({ isRecording: false, duration: 0, fileSize: 0 });
  });

  // -- Error paths --

  describe("errors when not recording", () => {
    it.each(["stopRecording", "pauseRecording", "resumeRecording"] as const)(
      "%s throws", async (method) => { await expect((sc as Record<string, () => Promise<unknown>>)[method]()).rejects.toThrow(); },
    );
  });

  // -- Event listeners --

  describe("event listeners", () => {
    it.each(["recordingState", "error"] as const)(
      "registers/removes %s listener", async (event) => {
        const h = await sc.addListener(event, vi.fn());
        await h.remove();
      },
    );

    it("removeAllListeners clears all", async () => {
      await sc.addListener("recordingState", vi.fn());
      await sc.addListener("error", vi.fn());
      await sc.removeAllListeners();
    });

    it("notifyListeners dispatches to correct event type", async () => {
      const rec = vi.fn(), err = vi.fn();
      await sc.addListener("recordingState", rec);
      await sc.addListener("error", err);

      (sc as unknown as { notifyListeners: (n: string, d: unknown) => void })
        .notifyListeners("recordingState", { isRecording: true, duration: 5, fileSize: 1000 });

      expect(rec).toHaveBeenCalledWith({ isRecording: true, duration: 5, fileSize: 1000 });
      expect(err).not.toHaveBeenCalled();
    });
  });
});
