// @vitest-environment jsdom

/**
 * Unit tests for `CameraWeb`, the browser fallback implementation of the
 * camera plugin API, against a jsdom DOM with `navigator.mediaDevices` and
 * `MediaRecorder` mocked — no real camera/microphone hardware involved.
 */
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  WebPlugin: class WebPlugin {},
}));

import { CameraWeb } from "./web.js";

const originalNavigator = globalThis.navigator;

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: originalNavigator,
  });
});

function makeVideoTrack(
  settings: Partial<MediaTrackSettings> = {
    deviceId: "camera-1",
    width: 1280,
    height: 720,
  },
) {
  return {
    stop: vi.fn(),
    getSettings: vi.fn(() => settings),
    getCapabilities: vi.fn(() => ({})),
    applyConstraints: vi.fn(() => Promise.resolve()),
  } as unknown as MediaStreamTrack;
}

function makeMediaStream(videoTracks = [makeVideoTrack()]) {
  return {
    getTracks: vi.fn(() => videoTracks),
    getVideoTracks: vi.fn(() => videoTracks),
    getAudioTracks: vi.fn(() => []),
  } as unknown as MediaStream;
}

function installMediaDevices(
  devices: MediaDeviceInfo[],
  getUserMediaImpl: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStream> = () => {
    throw new Error("getUserMedia should not be called during enumeration");
  },
) {
  const enumerateDevices = vi.fn(() => Promise.resolve(devices));
  const getUserMedia = vi.fn(getUserMediaImpl);

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices,
        getUserMedia,
      },
    },
  });

  return { enumerateDevices, getUserMedia };
}

describe("CameraWeb.getDevices", () => {
  it("enumerates video inputs without requesting camera access", async () => {
    const { enumerateDevices, getUserMedia } = installMediaDevices([
      {
        deviceId: "front",
        groupId: "group-1",
        kind: "videoinput",
        label: "FaceTime HD Camera",
        toJSON: () => ({}),
      } as MediaDeviceInfo,
      {
        deviceId: "mic",
        groupId: "group-2",
        kind: "audioinput",
        label: "Microphone",
        toJSON: () => ({}),
      } as MediaDeviceInfo,
      {
        deviceId: "back",
        groupId: "group-3",
        kind: "videoinput",
        label: "Rear Camera",
        toJSON: () => ({}),
      } as MediaDeviceInfo,
    ]);

    const result = await new CameraWeb().getDevices();

    expect(enumerateDevices).toHaveBeenCalledTimes(1);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.devices).toEqual([
      {
        deviceId: "front",
        label: "FaceTime HD Camera",
        direction: "front",
        hasFlash: false,
        hasZoom: false,
        maxZoom: 1,
        supportedResolutions: [],
        supportedFrameRates: [],
      },
      {
        deviceId: "back",
        label: "Rear Camera",
        direction: "back",
        hasFlash: false,
        hasZoom: false,
        maxZoom: 1,
        supportedResolutions: [],
        supportedFrameRates: [],
      },
    ]);
  });

  it("uses stable fallback labels and external direction when labels are hidden", async () => {
    installMediaDevices([
      {
        deviceId: "hidden",
        groupId: "group-1",
        kind: "videoinput",
        label: "",
        toJSON: () => ({}),
      } as MediaDeviceInfo,
    ]);

    await expect(new CameraWeb().getDevices()).resolves.toEqual({
      devices: [
        expect.objectContaining({
          deviceId: "hidden",
          label: "Camera 1",
          direction: "external",
        }),
      ],
    });
  });

  it("fails with an explicit error when browser media APIs are missing", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });

    await expect(new CameraWeb().getDevices()).rejects.toThrow(
      "Camera media devices API is not available",
    );
  });
});

describe("CameraWeb.startPreview", () => {
  it("does not mutate preview DOM state when permission is denied", async () => {
    const denied = new DOMException("Permission denied", "NotAllowedError");
    const { getUserMedia } = installMediaDevices([], () =>
      Promise.reject(denied),
    );
    const element = document.createElement("div");

    await expect(
      new CameraWeb().startPreview({ element, direction: "front" }),
    ).rejects.toThrow(denied);

    expect(getUserMedia).toHaveBeenCalledWith({
      video: expect.objectContaining({ facingMode: "user" }),
      audio: false,
    });
    expect(element.childElementCount).toBe(0);
  });

  it("validates malformed preview payloads before requesting camera access", async () => {
    const { getUserMedia } = installMediaDevices([], () =>
      Promise.resolve(makeMediaStream()),
    );
    const camera = new CameraWeb();

    await expect(
      camera.startPreview({
        element: undefined as unknown as HTMLElement,
      }),
    ).rejects.toThrow("Preview element is required");

    await expect(
      camera.startPreview({
        element: document.createElement("div"),
        resolution: { width: Number.NaN, height: 480 },
      }),
    ).rejects.toThrow("resolution.width must be a positive finite number");

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("survives external preview element removal during back-forward UI cleanup", async () => {
    installMediaDevices([], () => Promise.resolve(makeMediaStream()));

    const camera = new CameraWeb();
    const element = document.createElement("div");
    await camera.startPreview({ element });

    expect(element.childElementCount).toBe(1);
    element.replaceChildren();

    await expect(camera.stopPreview()).resolves.toBeUndefined();
    await expect(camera.stopPreview()).resolves.toBeUndefined();
  });
});

describe("CameraWeb.capturePhoto", () => {
  it("rejects capture when media settings cannot provide positive dimensions", async () => {
    installMediaDevices([], () =>
      Promise.resolve(
        makeMediaStream([makeVideoTrack({ width: 0, height: 0 })]),
      ),
    );

    const camera = new CameraWeb();
    await camera.startPreview({ element: document.createElement("div") });

    await expect(camera.capturePhoto()).rejects.toThrow(
      "videoWidth must be a positive finite number",
    );
  });

  it("validates malformed capture dimensions and quality", async () => {
    installMediaDevices([], () => Promise.resolve(makeMediaStream()));

    const camera = new CameraWeb();
    await camera.startPreview({ element: document.createElement("div") });

    await expect(camera.capturePhoto({ width: -1 })).rejects.toThrow(
      "width must be a positive finite number",
    );
    await expect(camera.capturePhoto({ quality: 101 })).rejects.toThrow(
      "quality must be a finite number between 0 and 100",
    );
  });
});

describe("CameraWeb.startRecording", () => {
  it.each([
    [{ maxDuration: 0 }, "maxDuration must be a positive finite number"],
    [
      { maxFileSize: Number.NaN },
      "maxFileSize must be a positive finite number",
    ],
    [{ bitrate: -1 }, "bitrate must be a positive finite number"],
    [{ frameRate: Infinity }, "frameRate must be a positive finite number"],
    [
      { quality: "ultra" },
      "quality must be one of low, medium, high, or highest",
    ],
  ])(
    "rejects malformed recording options before requesting microphone access: %#",
    async (options, message) => {
      const { getUserMedia } = installMediaDevices([], () =>
        Promise.resolve(makeMediaStream()),
      );
      const camera = new CameraWeb();
      await camera.startPreview({ element: document.createElement("div") });

      await expect(camera.startRecording(options as never)).rejects.toThrow(
        message,
      );

      expect(getUserMedia).toHaveBeenCalledTimes(1);
    },
  );
});

describe("CameraWeb settings validation", () => {
  it("rejects malformed settings payloads without changing existing settings", async () => {
    const camera = new CameraWeb();
    const original = await camera.getSettings();

    await expect(
      camera.setSettings({ settings: undefined as never }),
    ).rejects.toThrow("settings object is required");
    await expect(
      camera.setSettings({ settings: { zoom: -1 } }),
    ).rejects.toThrow("Invalid zoom value");

    await expect(camera.getSettings()).resolves.toEqual(original);
  });

  it("rejects malformed focus and exposure points for all non-normalized values", async () => {
    const manualTrack = {
      ...makeVideoTrack(),
      getCapabilities: vi.fn(() => ({
        focusMode: ["manual"],
        exposureMode: ["manual"],
      })),
    } as unknown as MediaStreamTrack;
    const camera = new CameraWeb();
    (
      camera as unknown as {
        mediaStream: MediaStream;
      }
    ).mediaStream = makeMediaStream([manualTrack]);

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.double({ noNaN: true }).filter((n) => n < 0 || n > 1),
          fc.constant(Number.NaN),
          fc.constant(Number.POSITIVE_INFINITY),
          fc.constant(Number.NEGATIVE_INFINITY),
        ),
        fc.double({ min: 0, max: 1, noNaN: true }),
        async (badValue, goodValue) => {
          await expect(
            camera.setFocusPoint({ x: badValue, y: goodValue }),
          ).rejects.toThrow("focus point must use finite x/y values");
          await expect(
            camera.setExposurePoint({ x: goodValue, y: badValue }),
          ).rejects.toThrow("exposure point must use finite x/y values");
        },
      ),
      { numRuns: 25 },
    );
  });
});

// Regression coverage for the microphone leak: startRecording({ audio: true })
// acquires a separate mic MediaStream whose tracks live in neither the camera
// stream nor the MediaRecorder, so teardown must stop them explicitly.
describe("CameraWeb recording lifecycle releases the microphone", () => {
  beforeEach(() => {
    // stopRecording() creates a probe <video> and resolves on its metadata/
    // error events, which jsdom never fires. Resolve deterministically by
    // firing onloadedmetadata whenever src is assigned.
    Object.defineProperty(HTMLVideoElement.prototype, "src", {
      configurable: true,
      set() {
        setTimeout(
          () =>
            (this as HTMLVideoElement).onloadedmetadata?.(
              new Event("loadedmetadata"),
            ),
          0,
        );
      },
      get() {
        return "";
      },
    });
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
      class {
        static isTypeSupported = () => true;
        mimeType = "video/webm";
        onstop: (() => void) | null = null;
        ondataavailable: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        start() {}
        stop() {
          this.onstop?.();
        }
      };
    (globalThis as unknown as { MediaStream: unknown }).MediaStream = class {
      private readonly tracks: unknown[];
      constructor(tracks: unknown[] = []) {
        this.tracks = tracks;
      }
      getTracks() {
        return this.tracks;
      }
    };
    globalThis.URL.createObjectURL = vi.fn(() => "blob:mock-recording");
  });

  afterEach(() => {
    delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
    delete (globalThis as unknown as { MediaStream?: unknown }).MediaStream;
  });

  function makeAudioTrack() {
    return { stop: vi.fn(), kind: "audio" } as unknown as MediaStreamTrack;
  }

  function installCameraAndMic(audioTracks: MediaStreamTrack[]) {
    let micIndex = 0;
    const getUserMedia = vi.fn((constraints: MediaStreamConstraints) => {
      if (constraints.audio === true && !constraints.video) {
        const track = audioTracks[micIndex++];
        return Promise.resolve({
          getTracks: () => [track],
          getVideoTracks: () => [],
          getAudioTracks: () => [track],
        } as unknown as MediaStream);
      }
      return Promise.resolve(makeMediaStream());
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia } },
    });
    return { getUserMedia };
  }

  it("stops the mic track after stopRecording and stopPreview teardown", async () => {
    const audioTrack = makeAudioTrack();
    installCameraAndMic([audioTrack]);

    const camera = new CameraWeb();
    await camera.startPreview({ element: document.createElement("div") });
    await camera.startRecording({ audio: true });

    expect(audioTrack.stop).not.toHaveBeenCalled();

    await camera.stopRecording();

    // stopRecording() must release the mic even though MediaRecorder.stop()
    // does not touch the underlying tracks.
    expect(audioTrack.stop).toHaveBeenCalledTimes(1);

    await camera.stopPreview();

    // The defensive stopPreview() release must not re-stop an already-cleared
    // stream, so the count stays at one.
    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("does not re-leak a fresh mic track across a second record cycle", async () => {
    const firstMic = makeAudioTrack();
    const secondMic = makeAudioTrack();
    installCameraAndMic([firstMic, secondMic]);

    const camera = new CameraWeb();
    await camera.startPreview({ element: document.createElement("div") });

    await camera.startRecording({ audio: true });
    await camera.stopRecording();
    expect(firstMic.stop).toHaveBeenCalledTimes(1);

    await camera.startRecording({ audio: true });
    await camera.stopRecording();

    // Each cycle acquires and releases exactly its own mic track; the first
    // track is never re-stopped and the second is fully released.
    expect(firstMic.stop).toHaveBeenCalledTimes(1);
    expect(secondMic.stop).toHaveBeenCalledTimes(1);
  });

  it("releases the mic when stopPreview interrupts an active recording", async () => {
    const audioTrack = makeAudioTrack();
    installCameraAndMic([audioTrack]);

    const camera = new CameraWeb();
    await camera.startPreview({ element: document.createElement("div") });
    await camera.startRecording({ audio: true });

    // stopPreview() detects the in-flight recording, drives stopRecording(),
    // and must leave no live microphone track behind.
    await camera.stopPreview();

    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("releases the mic when no supported mime type is available", async () => {
    const audioTrack = makeAudioTrack();
    installCameraAndMic([audioTrack]);
    // No codec in the probe list is supported, so getSupportedMimeType()
    // returns null and startRecording throws after the mic is acquired.
    (
      globalThis as unknown as { MediaRecorder: { isTypeSupported: unknown } }
    ).MediaRecorder.isTypeSupported = () => false;

    const camera = new CameraWeb();
    await camera.startPreview({ element: document.createElement("div") });

    await expect(camera.startRecording({ audio: true })).rejects.toThrow(
      "No supported video mime type found",
    );

    // The mic acquired before the mime-type check must not leak when the
    // recorder is never constructed.
    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("releases the mic when MediaRecorder construction throws", async () => {
    const audioTrack = makeAudioTrack();
    installCameraAndMic([audioTrack]);
    // Some browsers throw NotSupportedError from the MediaRecorder
    // constructor even when isTypeSupported reported the codec as usable.
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
      class {
        static isTypeSupported = () => true;
        constructor() {
          throw new DOMException("construction failed", "NotSupportedError");
        }
      };

    const camera = new CameraWeb();
    await camera.startPreview({ element: document.createElement("div") });

    await expect(camera.startRecording({ audio: true })).rejects.toThrow(
      "construction failed",
    );

    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("aborts and releases the mic when stopPreview races mic acquisition", async () => {
    const audioTrack = makeAudioTrack();
    let resolveMic!: (stream: MediaStream) => void;
    const micPromise = new Promise<MediaStream>((res) => {
      resolveMic = res;
    });
    const getUserMedia = vi.fn((constraints: MediaStreamConstraints) => {
      if (constraints.audio === true && !constraints.video) {
        return micPromise;
      }
      return Promise.resolve(makeMediaStream());
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia } },
    });

    const camera = new CameraWeb();
    await camera.startPreview({ element: document.createElement("div") });

    const recording = camera.startRecording({ audio: true });

    // Preview is torn down while the microphone prompt is still pending.
    await camera.stopPreview();

    // The mic only resolves after the camera stream is gone.
    resolveMic({
      getTracks: () => [audioTrack],
      getVideoTracks: () => [],
      getAudioTracks: () => [audioTrack],
    } as unknown as MediaStream);

    await expect(recording).rejects.toThrow(
      "Preview stopped before recording could start",
    );
    // The mic acquired after preview teardown must be stopped, not orphaned.
    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects a concurrent startRecording without acquiring a second mic", async () => {
    const firstMic = makeAudioTrack();
    const secondMic = makeAudioTrack();
    const { getUserMedia } = installCameraAndMic([firstMic, secondMic]);

    const camera = new CameraWeb();
    await camera.startPreview({ element: document.createElement("div") });

    const first = camera.startRecording({ audio: true });
    const second = camera.startRecording({ audio: true });

    // The synchronous starting guard rejects the second call before it can
    // request a microphone.
    await expect(second).rejects.toThrow("Recording already in progress");
    await expect(first).resolves.toBeUndefined();

    const micCalls = getUserMedia.mock.calls.filter(([constraints]) => {
      const c = constraints as MediaStreamConstraints;
      return c.audio === true && !c.video;
    });
    expect(micCalls).toHaveLength(1);
    expect(secondMic.stop).not.toHaveBeenCalled();

    await camera.stopRecording();
    expect(firstMic.stop).toHaveBeenCalledTimes(1);
  });

  it("releases the mic and clears state when recorder.start() throws", async () => {
    const audioTrack = makeAudioTrack();
    installCameraAndMic([audioTrack]);
    // Some browsers throw a synchronous DOMException from start() after the
    // recorder was constructed and the mic was already acquired.
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
      class {
        static isTypeSupported = () => true;
        mimeType = "video/webm";
        onstop: (() => void) | null = null;
        ondataavailable: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        start() {
          throw new DOMException("start failed", "InvalidStateError");
        }
        stop() {}
      };

    const camera = new CameraWeb();
    await camera.startPreview({ element: document.createElement("div") });

    await expect(camera.startRecording({ audio: true })).rejects.toThrow(
      "start failed",
    );

    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
    // The instance is not wedged: recording state is cleared for a retry.
    expect((await camera.getRecordingState()).isRecording).toBe(false);
  });

  it("releases the mic when recorder.stop() throws before onstop", async () => {
    const audioTrack = makeAudioTrack();
    installCameraAndMic([audioTrack]);
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
      class {
        static isTypeSupported = () => true;
        mimeType = "video/webm";
        onstop: (() => void) | null = null;
        ondataavailable: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        start() {}
        stop() {
          throw new DOMException("stop failed", "InvalidStateError");
        }
      };

    const camera = new CameraWeb();
    await camera.startPreview({ element: document.createElement("div") });
    await camera.startRecording({ audio: true });

    expect(audioTrack.stop).not.toHaveBeenCalled();

    await expect(camera.stopRecording()).rejects.toThrow("stop failed");
    // A failed stop still releases the mic and clears recording state.
    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
    expect((await camera.getRecordingState()).isRecording).toBe(false);
  });

  it("completes preview teardown when stop() throws mid-recording", async () => {
    const audioTrack = makeAudioTrack();
    installCameraAndMic([audioTrack]);
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
      class {
        static isTypeSupported = () => true;
        mimeType = "video/webm";
        onstop: (() => void) | null = null;
        ondataavailable: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        start() {}
        stop() {
          throw new DOMException("stop failed", "InvalidStateError");
        }
      };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const camera = new CameraWeb();
    await camera.startPreview({ element: document.createElement("div") });
    await camera.startRecording({ audio: true });

    // stopPreview() must not reject on a failed recording stop; it forces the
    // finalizer and continues releasing the camera and microphone.
    await expect(camera.stopPreview()).resolves.toBeUndefined();
    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
    expect((await camera.getRecordingState()).isRecording).toBe(false);

    errorSpy.mockRestore();
  });

  it("releases the mic when the recorder emits an error", async () => {
    const audioTrack = makeAudioTrack();
    installCameraAndMic([audioTrack]);
    // Expose the constructed recorder so the test can fire its onerror the way
    // the browser would when the underlying capture pipeline fails.
    let recorder: { onerror: ((event: unknown) => void) | null } | null = null;
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
      class {
        static isTypeSupported = () => true;
        mimeType = "video/webm";
        onstop: (() => void) | null = null;
        ondataavailable: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        constructor() {
          recorder = this;
        }
        start() {}
        stop() {
          this.onstop?.();
        }
      };

    const camera = new CameraWeb();
    await camera.startPreview({ element: document.createElement("div") });
    await camera.startRecording({ audio: true });

    expect(audioTrack.stop).not.toHaveBeenCalled();

    // A recorder error aborts the session without firing onstop; the handler
    // must still release the separately-acquired mic.
    recorder?.onerror?.(new ErrorEvent("error", { message: "pipeline lost" }));

    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
  });
});
