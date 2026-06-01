// @vitest-environment jsdom
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
  getUserMediaImpl: (constraints: MediaStreamConstraints) => Promise<MediaStream> =
    () => {
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
      Promise.resolve(makeMediaStream([makeVideoTrack({ width: 0, height: 0 })])),
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

describe("CameraWeb settings validation", () => {
  it("rejects malformed settings payloads without changing existing settings", async () => {
    const camera = new CameraWeb();
    const original = await camera.getSettings();

    await expect(
      camera.setSettings({ settings: undefined as never }),
    ).rejects.toThrow("settings object is required");
    await expect(camera.setSettings({ settings: { zoom: -1 } })).rejects.toThrow(
      "Invalid zoom value",
    );

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
