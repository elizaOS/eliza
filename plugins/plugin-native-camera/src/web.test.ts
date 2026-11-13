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

describe("CameraWeb recording stop", () => {
  class FakeRecorder {
    static isTypeSupported = (type: string) => type === "video/webm";
    mimeType = "video/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn(() => {
      queueMicrotask(() => this.onstop?.());
    });
  }

  function recordingCamera() {
    let urls = 0;
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    vi.stubGlobal("URL", {
      createObjectURL: () => `blob:video-${++urls}`,
      revokeObjectURL,
    });
    vi.stubGlobal("document", {
      createElement: () => {
        const video = {
          videoWidth: 640,
          videoHeight: 480,
          onloadedmetadata: null as (() => void) | null,
          set src(_url: string) {
            queueMicrotask(() => video.onloadedmetadata?.());
          },
        };
        return video;
      },
    });
    const camera = new CameraWeb();
    // A preview stream without tracks is enough for a video-only recording.
    (camera as unknown as { mediaStream: object }).mediaStream = {
      getTracks: () => [],
    };
    return { camera, revokeObjectURL };
  }

  afterEach(() => vi.useRealTimers());

  it("returns a recording that stopped at its limit to the next stop", async () => {
    vi.useFakeTimers();
    const { camera, revokeObjectURL } = recordingCamera();
    await camera.startRecording({ audio: false, maxDuration: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await camera.getRecordingState()).isRecording).toBe(false);
    const video = await camera.stopRecording();
    expect(video).toMatchObject({ path: "blob:video-1", width: 640 });
    await expect(camera.stopRecording()).rejects.toThrow("Not recording");
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("discards an unclaimed limit recording when the preview stops", async () => {
    vi.useFakeTimers();
    const { camera, revokeObjectURL } = recordingCamera();
    await camera.startRecording({ audio: false, maxDuration: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    await camera.stopPreview();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:video-1");
    await expect(camera.stopRecording()).rejects.toThrow("Not recording");
  });

  it("gives overlapping stops the same recording", async () => {
    const { camera } = recordingCamera();
    await camera.startRecording({ audio: false });
    const [first, second] = await Promise.all([
      camera.stopRecording(),
      camera.stopRecording(),
    ]);
    expect(first).toEqual(second);
    expect(first.path).toBe("blob:video-1");
    await expect(camera.stopRecording()).rejects.toThrow("Not recording");
  });
});
