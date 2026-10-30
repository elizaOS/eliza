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
