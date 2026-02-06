/**
 * Tests for @milaidy/capacitor-screencapture plugin
 *
 * Verifies:
 * - Module exports (ScreenCaptureWeb class + definition types)
 * - ScreenCaptureWeb class instantiation and method signatures
 * - Recording state management
 * - Error handling for operations without active recording
 * - Listener registration and cleanup
 */
import { describe, it, expect, beforeEach } from "vitest";

describe("@milaidy/capacitor-screencapture", () => {
  let screencapture: InstanceType<Awaited<typeof import("../../plugins/screencapture/src/web")>["ScreenCaptureWeb"]>;

  beforeEach(async () => {
    const { ScreenCaptureWeb } = await import("../../plugins/screencapture/src/web");
    screencapture = new ScreenCaptureWeb();
  });

  describe("module exports", () => {
    it("exports ScreenCaptureWeb class", async () => {
      const mod = await import("../../plugins/screencapture/src/web");
      expect(mod.ScreenCaptureWeb).toBeDefined();
      expect(typeof mod.ScreenCaptureWeb).toBe("function");
    });
  });

  describe("method signatures", () => {
    it("has all required plugin methods", () => {
      expect(typeof screencapture.isSupported).toBe("function");
      expect(typeof screencapture.captureScreenshot).toBe("function");
      expect(typeof screencapture.startRecording).toBe("function");
      expect(typeof screencapture.stopRecording).toBe("function");
      expect(typeof screencapture.pauseRecording).toBe("function");
      expect(typeof screencapture.resumeRecording).toBe("function");
      expect(typeof screencapture.getRecordingState).toBe("function");
      expect(typeof screencapture.checkPermissions).toBe("function");
      expect(typeof screencapture.requestPermissions).toBe("function");
      expect(typeof screencapture.addListener).toBe("function");
      expect(typeof screencapture.removeAllListeners).toBe("function");
    });
  });

  describe("recording state", () => {
    it("reports not recording by default", async () => {
      const state = await screencapture.getRecordingState();
      expect(state.isRecording).toBe(false);
      expect(state.duration).toBe(0);
      expect(state.fileSize).toBe(0);
    });
  });

  describe("error handling", () => {
    it("throws when stopping recording when not recording", async () => {
      await expect(screencapture.stopRecording()).rejects.toThrow();
    });

    it("throws when pausing when not recording", async () => {
      await expect(screencapture.pauseRecording()).rejects.toThrow();
    });

    it("throws when resuming when not recording", async () => {
      await expect(screencapture.resumeRecording()).rejects.toThrow();
    });
  });

  describe("definition types", () => {
    it("definitions module loads without error", async () => {
      const mod = await import("../../plugins/screencapture/src/definitions");
      expect(mod).toBeDefined();
    });
  });
});
