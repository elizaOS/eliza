/**
 * Tests for @milaidy/capacitor-camera plugin
 *
 * Verifies:
 * - Module exports (Camera instance + definition types)
 * - CameraWeb class instantiation and method signatures
 * - State management (settings, recording state)
 * - Listener registration and cleanup
 * - Error handling for operations without active preview
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CameraWeb } from "../../plugins/camera/src/web";

describe("@milaidy/capacitor-camera", () => {
  let camera: CameraWeb;

  beforeEach(() => {
    camera = new CameraWeb();
  });

  describe("module exports", () => {
    it("exports CameraWeb class", () => {
      expect(CameraWeb).toBeDefined();
      expect(typeof CameraWeb).toBe("function");
    });

    it("creates an instance with expected methods", () => {
      expect(typeof camera.getDevices).toBe("function");
      expect(typeof camera.startPreview).toBe("function");
      expect(typeof camera.stopPreview).toBe("function");
      expect(typeof camera.switchCamera).toBe("function");
      expect(typeof camera.capturePhoto).toBe("function");
      expect(typeof camera.startRecording).toBe("function");
      expect(typeof camera.stopRecording).toBe("function");
      expect(typeof camera.getRecordingState).toBe("function");
      expect(typeof camera.getSettings).toBe("function");
      expect(typeof camera.setSettings).toBe("function");
      expect(typeof camera.setZoom).toBe("function");
      expect(typeof camera.setFocusPoint).toBe("function");
      expect(typeof camera.setExposurePoint).toBe("function");
      expect(typeof camera.checkPermissions).toBe("function");
      expect(typeof camera.requestPermissions).toBe("function");
      expect(typeof camera.addListener).toBe("function");
      expect(typeof camera.removeAllListeners).toBe("function");
    });
  });

  describe("settings management", () => {
    it("returns default settings", async () => {
      const { settings } = await camera.getSettings();
      expect(settings).toEqual({
        flash: "off",
        zoom: 1,
        focusMode: "continuous",
        exposureMode: "continuous",
        exposureCompensation: 0,
        whiteBalance: "auto",
      });
    });

    it("updates settings partially", async () => {
      await camera.setSettings({ settings: { flash: "on", zoom: 2 } });
      const { settings } = await camera.getSettings();
      expect(settings.flash).toBe("on");
      expect(settings.zoom).toBe(2);
      expect(settings.focusMode).toBe("continuous"); // unchanged
    });
  });

  describe("recording state", () => {
    it("reports not recording by default", async () => {
      const state = await camera.getRecordingState();
      expect(state.isRecording).toBe(false);
      expect(state.duration).toBe(0);
      expect(state.fileSize).toBe(0);
    });
  });

  describe("error handling", () => {
    it("throws when capturing photo without preview", async () => {
      await expect(camera.capturePhoto()).rejects.toThrow("Preview not started");
    });

    it("throws when switching camera without preview", async () => {
      await expect(camera.switchCamera({ direction: "front" })).rejects.toThrow(
        "Preview not started"
      );
    });

    it("throws when starting recording without preview", async () => {
      await expect(camera.startRecording()).rejects.toThrow("Preview not started");
    });

    it("throws when stopping recording when not recording", async () => {
      await expect(camera.stopRecording()).rejects.toThrow("Not recording");
    });

    it("throws when setting focus without preview", async () => {
      await expect(camera.setFocusPoint({ x: 0.5, y: 0.5 })).rejects.toThrow(
        "Preview not started"
      );
    });

    it("throws when setting exposure without preview", async () => {
      await expect(camera.setExposurePoint({ x: 0.5, y: 0.5 })).rejects.toThrow(
        "Preview not started"
      );
    });
  });

  describe("event listeners", () => {
    it("registers and removes a listener", async () => {
      let called = false;
      const handle = await camera.addListener("frame", () => {
        called = true;
      });
      expect(handle).toBeDefined();
      expect(typeof handle.remove).toBe("function");

      // Notify should call the listener
      (camera as unknown as { notifyListeners: (name: string, data: unknown) => void }).notifyListeners(
        "frame",
        { timestamp: 1, width: 1920, height: 1080 }
      );
      expect(called).toBe(true);

      // After remove, should not be called again
      called = false;
      await handle.remove();
      (camera as unknown as { notifyListeners: (name: string, data: unknown) => void }).notifyListeners(
        "frame",
        { timestamp: 2, width: 1920, height: 1080 }
      );
      expect(called).toBe(false);
    });

    it("removes all listeners", async () => {
      let callCount = 0;
      await camera.addListener("frame", () => callCount++);
      await camera.addListener("error", () => callCount++);
      await camera.removeAllListeners();

      (camera as unknown as { notifyListeners: (name: string, data: unknown) => void }).notifyListeners("frame", {});
      (camera as unknown as { notifyListeners: (name: string, data: unknown) => void }).notifyListeners("error", {});
      expect(callCount).toBe(0);
    });
  });
});
