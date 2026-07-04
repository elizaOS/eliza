/**
 * Unit tests for ScreenCaptureWeb using fake MediaRecorder, track, and
 * getDisplayMedia doubles — no real browser capture APIs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScreenCaptureWeb } from "./web";

type MediaRecorderEventHandler = ((event: Event) => void) | null;
type BlobEventHandler = ((event: BlobEvent) => void) | null;

class FakeTrack {
  stopped = false;
  private listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(
    readonly kind: "audio" | "video",
    private readonly settings: MediaTrackSettings = {},
  ) {}

  getSettings(): MediaTrackSettings {
    return this.settings;
  }

  stop(): void {
    this.stopped = true;
  }

  addEventListener(eventName: string, callback: (event: Event) => void): void {
    const listeners = this.listeners.get(eventName) ?? [];
    listeners.push(callback);
    this.listeners.set(eventName, listeners);
  }

  dispatchEnded(): void {
    this.listeners.get("ended")?.forEach((callback) => {
      callback(new Event("ended"));
    });
  }
}

class FakeStream {
  constructor(private readonly tracks: FakeTrack[]) {}

  getTracks(): MediaStreamTrack[] {
    return this.tracks as unknown as MediaStreamTrack[];
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "video") as unknown as
      | MediaStreamTrack[]
      | [];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "audio") as unknown as
      | MediaStreamTrack[]
      | [];
  }

  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track as unknown as FakeTrack);
  }
}

class FakeMediaRecorder {
  static supported = true;
  static instances: FakeMediaRecorder[] = [];

  static isTypeSupported(mimeType: string): boolean {
    return FakeMediaRecorder.supported && mimeType === "video/webm";
  }

  ondataavailable: BlobEventHandler = null;
  onerror: MediaRecorderEventHandler = null;
  onstop: MediaRecorderEventHandler = null;
  readonly mimeType: string;
  readonly start = vi.fn((_timeslice?: number) => {});
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  readonly stop = vi.fn(() => {
    queueMicrotask(() => {
      this.onstop?.(new Event("stop"));
    });
  });

  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions,
  ) {
    this.mimeType = options.mimeType ?? "";
    FakeMediaRecorder.instances.push(this);
  }
}

function setNavigator(value: Partial<Navigator>): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
}

function installDocument() {
  const context = { drawImage: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toDataURL: vi.fn(() => "data:image/webp;base64,c2NyZWVu"),
  };

  const createElement = vi.fn((tagName: string) => {
    if (tagName === "canvas") return canvas;
    if (tagName === "video") {
      return {
        videoWidth: 1280,
        videoHeight: 720,
        set src(_value: string) {},
        set onloadedmetadata(callback: () => void) {
          queueMicrotask(callback);
        },
        set onerror(_callback: () => void) {},
      };
    }
    throw new Error(`unexpected element: ${tagName}`);
  });

  vi.stubGlobal("document", { createElement });
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:screen-recording"),
  });

  return { canvas, context, createElement };
}

describe("ScreenCaptureWeb", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeMediaRecorder.supported = true;
    FakeMediaRecorder.instances = [];
  });

  it("reports unsupported cleanly when optional browser capture APIs are absent", async () => {
    setNavigator({});
    vi.stubGlobal("MediaRecorder", undefined);
    vi.stubGlobal("AudioContext", undefined);

    const plugin = new ScreenCaptureWeb();

    await expect(plugin.isSupported()).resolves.toEqual({
      supported: false,
      features: [],
    });
    await expect(plugin.checkPermissions()).resolves.toEqual({
      screenCapture: "not_supported",
      microphone: "prompt",
    });
    await expect(plugin.requestPermissions()).resolves.toEqual({
      screenCapture: "not_supported",
      microphone: "denied",
    });
  });

  it("maps screenshot options into display capture and canvas encoding", async () => {
    const track = new FakeTrack("video", { width: 320, height: 200 });
    const stream = new FakeStream([track]);
    const getDisplayMedia = vi.fn(async () => stream as unknown as MediaStream);
    const close = vi.fn();
    const grabFrame = vi.fn(async () => ({ close }) as unknown as ImageBitmap);
    const imageCapture = vi.fn(function ImageCapture(this: object) {
      Object.assign(this, { grabFrame });
    });
    const { canvas, context } = installDocument();

    setNavigator({
      mediaDevices: { getDisplayMedia } as unknown as MediaDevices,
    });
    vi.stubGlobal("ImageCapture", imageCapture);

    await expect(
      new ScreenCaptureWeb().captureScreenshot({
        format: "webp",
        quality: 25,
        scale: 2,
      }),
    ).resolves.toEqual({
      base64: "c2NyZWVu",
      format: "webp",
      width: 640,
      height: 400,
      timestamp: expect.any(Number),
    });

    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: { displaySurface: "monitor" },
      audio: false,
    });
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(400);
    expect(context.drawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      640,
      400,
    );
    expect(canvas.toDataURL).toHaveBeenCalledWith("image/webp", 0.25);
    expect(track.stopped).toBe(true);
    expect(close).toHaveBeenCalled();
  });

  it.each([
    { quality: -1 },
    { quality: 101 },
    { quality: Number.POSITIVE_INFINITY },
    { scale: 0 },
    { scale: Number.NaN },
  ])("rejects malformed screenshot options %# before requesting capture", async (options) => {
    const getDisplayMedia = vi.fn();
    setNavigator({
      mediaDevices: { getDisplayMedia } as unknown as MediaDevices,
    });

    await expect(
      new ScreenCaptureWeb().captureScreenshot(options),
    ).rejects.toThrow(/quality|scale/);
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("stops acquired display tracks when screenshot frame capture fails", async () => {
    const track = new FakeTrack("video", { width: 320, height: 200 });
    const stream = new FakeStream([track]);
    const getDisplayMedia = vi.fn(async () => stream as unknown as MediaStream);
    const grabFrame = vi.fn(async () => {
      throw new Error("frame unavailable");
    });
    const imageCapture = vi.fn(function ImageCapture(this: object) {
      Object.assign(this, { grabFrame });
    });
    installDocument();

    setNavigator({
      mediaDevices: { getDisplayMedia } as unknown as MediaDevices,
    });
    vi.stubGlobal("ImageCapture", imageCapture);

    await expect(new ScreenCaptureWeb().captureScreenshot()).rejects.toThrow(
      "frame unavailable",
    );
    expect(track.stopped).toBe(true);
  });

  it("stops acquired display tracks when recording cannot be encoded", async () => {
    const videoTrack = new FakeTrack("video");
    const audioTrack = new FakeTrack("audio");
    const stream = new FakeStream([videoTrack, audioTrack]);
    const getDisplayMedia = vi.fn(async () => stream as unknown as MediaStream);
    setNavigator({
      mediaDevices: { getDisplayMedia } as unknown as MediaDevices,
    });
    vi.stubGlobal("MediaRecorder", undefined);

    const plugin = new ScreenCaptureWeb();

    await expect(plugin.startRecording()).rejects.toThrow(
      "No supported video mime type found",
    );
    expect(videoTrack.stopped).toBe(true);
    expect(audioTrack.stopped).toBe(true);
    await expect(plugin.getRecordingState()).resolves.toEqual({
      isRecording: false,
      duration: 0,
      fileSize: 0,
    });
  });

  it.each([
    { fps: 0 },
    { fps: Number.NaN },
    { bitrate: -1 },
    { maxDuration: Number.POSITIVE_INFINITY },
    { maxFileSize: 0 },
  ])("rejects malformed recording options %# before requesting capture", async (options) => {
    const getDisplayMedia = vi.fn();
    setNavigator({
      mediaDevices: { getDisplayMedia } as unknown as MediaDevices,
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    await expect(
      new ScreenCaptureWeb().startRecording(options),
    ).rejects.toThrow(/fps|bitrate|maxDuration|maxFileSize/);
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("runs recording pause, resume, stop, and listener removal without leaking tracks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    installDocument();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    const videoTrack = new FakeTrack("video");
    const micTrack = new FakeTrack("audio");
    const displayStream = new FakeStream([videoTrack]);
    const micStream = new FakeStream([micTrack]);
    const getDisplayMedia = vi.fn(
      async () => displayStream as unknown as MediaStream,
    );
    const getUserMedia = vi.fn(async () => micStream as unknown as MediaStream);
    setNavigator({
      mediaDevices: {
        getDisplayMedia,
        getUserMedia,
      } as unknown as MediaDevices,
    });

    const plugin = new ScreenCaptureWeb();
    const states: unknown[] = [];
    const removedListener = vi.fn();
    plugin.addListener("recordingState", (event) => {
      states.push(event);
    });
    const handle = await plugin.addListener("recordingState", removedListener);
    await handle.remove();

    await plugin.startRecording({
      captureMicrophone: true,
      fps: 30,
      bitrate: 250_000,
    });

    const recorder = FakeMediaRecorder.instances[0];
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: { displaySurface: "monitor", frameRate: { ideal: 30 } },
      audio: true,
    });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(recorder.options).toEqual({
      mimeType: "video/webm",
      videoBitsPerSecond: 250_000,
    });
    expect(recorder.start).toHaveBeenCalledWith(1000);
    expect(states[0]).toEqual({
      isRecording: true,
      duration: 0,
      fileSize: 0,
    });
    expect(removedListener).not.toHaveBeenCalled();

    recorder.ondataavailable?.({
      data: new Blob(["chunk"]),
    } as BlobEvent);
    vi.setSystemTime(2_500);
    await plugin.pauseRecording();
    await plugin.pauseRecording();
    expect(recorder.pause).toHaveBeenCalledTimes(1);

    vi.setSystemTime(3_000);
    await plugin.resumeRecording();
    await plugin.resumeRecording();
    expect(recorder.resume).toHaveBeenCalledTimes(1);

    const stopPromise = plugin.stopRecording();
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    await expect(stopPromise).resolves.toEqual({
      path: "blob:screen-recording",
      duration: 1.5,
      width: 1280,
      height: 720,
      fileSize: 5,
      mimeType: "video/webm",
    });

    expect(videoTrack.stopped).toBe(true);
    expect(micTrack.stopped).toBe(true);
    expect(states[states.length - 1]).toEqual({
      isRecording: false,
      duration: 1.5,
      fileSize: 5,
    });
    await expect(plugin.getRecordingState()).resolves.toEqual({
      isRecording: false,
      duration: 0,
      fileSize: 5,
    });
  });
});
