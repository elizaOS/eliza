/**
 * Contract tests for the `CameraWeb` fallback's preview options.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CameraPreviewOptions } from "./definitions";
import { CameraWeb } from "./web";

afterEach(() => vi.unstubAllGlobals());

describe("camera-only access", () => {
  it("checks only camera and requests a video-only stream that it releases", async () => {
    const stop = vi.fn();
    const query = vi.fn(async () => ({ state: "prompt" }));
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    vi.stubGlobal("navigator", {
      permissions: { query },
      mediaDevices: { getUserMedia },
    });
    const camera = new CameraWeb();
    expect(await camera.checkCameraPermission()).toEqual({ camera: "prompt" });
    expect(query).toHaveBeenCalledExactlyOnceWith({ name: "camera" });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(await camera.requestCameraPermission()).toEqual({
      camera: "granted",
    });
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({
      video: true,
      audio: false,
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("reports an explicit denial without retrying audio and preserves other failures", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const camera = new CameraWeb();
    expect(await camera.requestCameraPermission()).toEqual({
      camera: "denied",
    });
    const unavailable = new DOMException("No camera", "NotFoundError");
    getUserMedia.mockRejectedValueOnce(unavailable);
    await expect(camera.requestCameraPermission()).rejects.toBe(unavailable);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });
});

describe("combined camera and microphone access", () => {
  const release = () => ({ getTracks: () => [{ stop: vi.fn() }] });

  it("reports a camera denial only for an explicit denial", async () => {
    const denied = new DOMException("denied", "NotAllowedError");
    const getUserMedia = vi.fn(async () => {
      throw denied;
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    expect(await new CameraWeb().requestPermissions()).toEqual({
      camera: "denied",
      microphone: "denied",
      photos: "denied",
    });
  });

  it.each([
    [
      "no camera",
      new DOMException("Requested device not found", "NotFoundError"),
    ],
    [
      "a camera busy in another app",
      new DOMException("Could not start video source", "NotReadableError"),
    ],
  ])("preserves %s instead of reporting a denial", async (_label, failure) => {
    const getUserMedia = vi.fn(async () => {
      throw failure;
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    await expect(new CameraWeb().requestPermissions()).rejects.toBe(failure);
  });

  it("preserves a missing MediaDevices API instead of reporting a denial", async () => {
    vi.stubGlobal("navigator", {});
    await expect(new CameraWeb().requestPermissions()).rejects.toThrow(
      "Camera media devices API is not available",
    );
  });

  it("keeps a granted camera when only the microphone fails", async () => {
    const noMicrophone = new DOMException("No microphone", "NotFoundError");
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      if (constraints.audio) throw noMicrophone;
      return release();
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    expect(await new CameraWeb().requestPermissions()).toMatchObject({
      camera: "granted",
      photos: "granted",
    });
  });
});

describe("CameraWeb startPreview", () => {
  it("rejects a preview without a host element", async () => {
    // Native callers omit `element`, so the shared options type allows it;
    // the web fallback still needs one to attach its <video>.
    const options: CameraPreviewOptions = { direction: "back", mirror: false };

    await expect(new CameraWeb().startPreview(options)).rejects.toThrow(
      "Preview element is required",
    );
  });
});
