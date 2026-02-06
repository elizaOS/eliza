/**
 * Tests for @milaidy/capacitor-camera — settings, state, direction inference, errors, events.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CameraWeb } from "../../plugins/camera/src/web";

type Internals = CameraWeb & {
  inferDirection: (label: string) => string;
  notifyListeners: (name: string, data: unknown) => void;
};

describe("@milaidy/capacitor-camera", () => {
  let cam: CameraWeb;
  let priv: Internals;

  beforeEach(() => {
    cam = new CameraWeb();
    priv = cam as unknown as Internals;
  });

  // -- Settings --

  describe("settings", () => {
    it("returns correct defaults", async () => {
      expect((await cam.getSettings()).settings).toEqual({
        flash: "off", zoom: 1, focusMode: "continuous",
        exposureMode: "continuous", exposureCompensation: 0, whiteBalance: "auto",
      });
    });

    it("partial update preserves other fields", async () => {
      await cam.setSettings({ settings: { flash: "torch" } });
      const { settings } = await cam.getSettings();
      expect(settings.flash).toBe("torch");
      expect(settings.zoom).toBe(1);
      expect(settings.focusMode).toBe("continuous");
    });

    it("chained updates accumulate", async () => {
      await cam.setSettings({ settings: { flash: "on" } });
      await cam.setSettings({ settings: { zoom: 3 } });
      await cam.setSettings({ settings: { whiteBalance: "daylight" } });
      const { settings } = await cam.getSettings();
      expect(settings.flash).toBe("on");
      expect(settings.zoom).toBe(3);
      expect(settings.whiteBalance).toBe("daylight");
    });

    it("getSettings returns a copy, not a reference", async () => {
      const a = (await cam.getSettings()).settings;
      const b = (await cam.getSettings()).settings;
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });

    it("setZoom updates zoom setting", async () => {
      await cam.setZoom({ zoom: 5 });
      expect((await cam.getSettings()).settings.zoom).toBe(5);
    });

    it.each([0, 0.01, 100])("setZoom handles boundary value %s", async (z) => {
      await cam.setZoom({ zoom: z });
      expect((await cam.getSettings()).settings.zoom).toBe(z);
    });

    it.each([-1, -Infinity, NaN, Infinity])("setZoom rejects invalid value %s", async (z) => {
      await expect(cam.setZoom({ zoom: z })).rejects.toThrow(/invalid zoom/i);
    });
  });

  // -- Direction inference --

  describe("inferDirection", () => {
    it.each([
      ["Front Camera", "front"],
      ["FaceTime HD Camera", "front"],
      ["User Camera", "front"],
      ["FRONT CAMERA", "front"],
    ])('"%s" → %s', (label, expected) => {
      expect(priv.inferDirection(label)).toBe(expected);
    });

    it.each([
      ["Back Camera", "back"],
      ["Rear Camera 1", "back"],
      ["Environment Camera", "back"],
    ])('"%s" → %s', (label, expected) => {
      expect(priv.inferDirection(label)).toBe(expected);
    });

    it.each(["USB Webcam", "Logitech C920", ""])(
      '"%s" → external',
      (label) => { expect(priv.inferDirection(label)).toBe("external"); },
    );
  });

  // -- Recording state --

  it("reports not recording by default", async () => {
    expect(await cam.getRecordingState()).toEqual({ isRecording: false, duration: 0, fileSize: 0 });
  });

  // -- Error paths (no preview) --

  describe("errors without preview", () => {
    it.each([
      ["capturePhoto", () => cam.capturePhoto()],
      ["capturePhoto with opts", () => cam.capturePhoto({ quality: 90, format: "png" })],
      ["switchCamera", () => cam.switchCamera({ direction: "front" })],
      ["startRecording", () => cam.startRecording()],
      ["setFocusPoint", () => cam.setFocusPoint({ x: 0.5, y: 0.5 })],
      ["setExposurePoint", () => cam.setExposurePoint({ x: 0.5, y: 0.5 })],
    ])("%s throws 'Preview not started'", async (_name, fn) => {
      await expect(fn()).rejects.toThrow("Preview not started");
    });

    it("stopRecording throws 'Not recording'", async () => {
      await expect(cam.stopRecording()).rejects.toThrow("Not recording");
    });
  });

  // -- Event listeners --

  describe("event listeners", () => {
    it("dispatches events to registered listener", async () => {
      const received: unknown[] = [];
      await cam.addListener("frame", (e) => received.push(e));

      priv.notifyListeners("frame", { timestamp: 1, width: 1920, height: 1080 });
      expect(received).toEqual([{ timestamp: 1, width: 1920, height: 1080 }]);
    });

    it("multiple listeners on same event all fire", async () => {
      let count = 0;
      await cam.addListener("frame", () => count++);
      await cam.addListener("frame", () => count++);
      priv.notifyListeners("frame", {});
      expect(count).toBe(2);
    });

    it("remove only removes the specific listener", async () => {
      let a = 0, b = 0;
      const h = await cam.addListener("frame", () => a++);
      await cam.addListener("frame", () => b++);
      await h.remove();

      priv.notifyListeners("frame", {});
      expect(a).toBe(0);
      expect(b).toBe(1);
    });

    it("events don't cross between event names", async () => {
      let frames = 0, errors = 0;
      await cam.addListener("frame", () => frames++);
      await cam.addListener("error", () => errors++);
      priv.notifyListeners("frame", {});
      expect(frames).toBe(1);
      expect(errors).toBe(0);
    });

    it("removeAllListeners clears everything", async () => {
      let count = 0;
      await cam.addListener("frame", () => count++);
      await cam.addListener("error", () => count++);
      await cam.removeAllListeners();
      priv.notifyListeners("frame", {});
      priv.notifyListeners("error", {});
      expect(count).toBe(0);
    });
  });
});
