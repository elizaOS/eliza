/**
 * Browser fallback implementation of the camera plugin, backed by the
 * `MediaDevices`/`MediaRecorder` Web APIs instead of native camera hardware.
 * Loaded lazily by `index.ts` when Capacitor has no native binding (e.g. in a
 * desktop browser or Electron shell). Several capabilities the native
 * implementations expose — torch/flash control, precise device-capability
 * probing — have no Web API equivalent and are approximated or reported
 * unsupported here; see the plugin's CLAUDE.md for the specific gaps.
 */
import { WebPlugin } from "@capacitor/core";

import type {
  CameraDevice,
  CameraDirection,
  CameraErrorEvent,
  CameraFrameEvent,
  CameraPermissionStatus,
  CameraPreviewOptions,
  CameraPreviewResult,
  CameraSettings,
  PhotoCaptureOptions,
  PhotoResult,
  VideoCaptureOptions,
  VideoRecordingState,
  VideoResult,
} from "./definitions";

type CameraEventData =
  | CameraFrameEvent
  | CameraErrorEvent
  | VideoRecordingState;

const VIDEO_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

const getSupportedMimeType = (): string | null =>
  VIDEO_MIME_TYPES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;

const getMediaDevices = (): MediaDevices => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera media devices API is not available");
  }
  return navigator.mediaDevices;
};

const assertPositiveFinite = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
};

const assertRecordingOptions = (options?: VideoCaptureOptions): void => {
  if (!options) return;

  if (
    options.quality !== undefined &&
    !["low", "medium", "high", "highest"].includes(options.quality)
  ) {
    throw new Error("quality must be one of low, medium, high, or highest");
  }

  if (options.maxDuration !== undefined) {
    assertPositiveFinite(options.maxDuration, "maxDuration");
  }
  if (options.maxFileSize !== undefined) {
    assertPositiveFinite(options.maxFileSize, "maxFileSize");
  }
  if (options.bitrate !== undefined) {
    assertPositiveFinite(options.bitrate, "bitrate");
  }
  if (options.frameRate !== undefined) {
    assertPositiveFinite(options.frameRate, "frameRate");
  }
};

export class CameraWeb extends WebPlugin {
  private mediaStream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private previewElement: HTMLElement | null = null;
  private currentDeviceId: string | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recordingStartTime = 0;
  private recordingStateInterval: ReturnType<typeof setInterval> | null = null;
  private isRecording = false;
  private currentSettings: CameraSettings = {
    flash: "off",
    zoom: 1,
    focusMode: "continuous",
    exposureMode: "continuous",
    exposureCompensation: 0,
    whiteBalance: "auto",
  };
  private pluginListeners: Array<{
    eventName: string;
    callback: (event: CameraEventData) => void;
  }> = [];

  async getDevices(): Promise<{ devices: CameraDevice[] }> {
    // enumerateDevices() returns unlabeled device records unless the user has
    // already granted camera permission via a prior getUserMedia() call.
    // We intentionally do NOT call getUserMedia() here because it requires a
    // user gesture and would throw NotAllowedError if called programmatically.
    const mediaDevices = getMediaDevices();
    if (!mediaDevices.enumerateDevices) {
      throw new Error("Camera device enumeration is not available");
    }

    const allDevices = await mediaDevices.enumerateDevices();
    const videoDevices = allDevices.filter((d) => d.kind === "videoinput");

    const devices: CameraDevice[] = await Promise.all(
      videoDevices.map(async (device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
        direction: this.inferDirection(device.label),
        // Capability probing requires getUserMedia(), which can prompt for
        // camera permission. Enumeration stays prompt-free and reports
        // unknown capabilities until preview/capture has explicit access.
        hasFlash: false,
        hasZoom: false,
        maxZoom: 1,
        supportedResolutions: [],
        supportedFrameRates: [],
      })),
    );

    return { devices };
  }

  private inferDirection(label: string): CameraDirection {
    const lowerLabel = label.toLowerCase();
    if (
      lowerLabel.includes("front") ||
      lowerLabel.includes("facetime") ||
      lowerLabel.includes("user")
    ) {
      return "front";
    }
    if (
      lowerLabel.includes("back") ||
      lowerLabel.includes("rear") ||
      lowerLabel.includes("environment")
    ) {
      return "back";
    }
    return "external";
  }

  async startPreview(
    options: CameraPreviewOptions,
  ): Promise<CameraPreviewResult> {
    if (!options?.element?.appendChild) {
      throw new Error("Preview element is required");
    }
    if (options.resolution) {
      assertPositiveFinite(options.resolution.width, "resolution.width");
      assertPositiveFinite(options.resolution.height, "resolution.height");
    }
    if (options.frameRate !== undefined) {
      assertPositiveFinite(options.frameRate, "frameRate");
    }

    await this.stopPreview();

    const constraints: MediaStreamConstraints = {
      video: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
        facingMode:
          options.direction === "front"
            ? "user"
            : options.direction === "back"
              ? "environment"
              : undefined,
        width: options.resolution?.width
          ? { ideal: options.resolution.width }
          : { ideal: 1920 },
        height: options.resolution?.height
          ? { ideal: options.resolution.height }
          : { ideal: 1080 },
        frameRate: options.frameRate
          ? { ideal: options.frameRate }
          : { ideal: 30 },
      },
      audio: false,
    };

    // Browser camera permission is requested by opening the stream. Native
    // permission probing is handled outside this Capacitor web fallback.
    this.mediaStream = await getMediaDevices().getUserMedia(constraints);
    this.previewElement = options.element;

    this.videoElement = document.createElement("video");
    this.videoElement.srcObject = this.mediaStream;
    this.videoElement.autoplay = true;
    this.videoElement.playsInline = true;
    this.videoElement.muted = true;
    this.videoElement.style.width = "100%";
    this.videoElement.style.height = "100%";
    this.videoElement.style.objectFit = "cover";

    if (options.mirror) {
      this.videoElement.style.transform = "scaleX(-1)";
    }

    this.previewElement.appendChild(this.videoElement);
    await this.videoElement.play();

    const track = this.mediaStream.getVideoTracks()[0];
    const settings = track.getSettings();
    this.currentDeviceId = settings.deviceId || options.deviceId || "";

    return {
      width: settings.width || options.resolution?.width || 1920,
      height: settings.height || options.resolution?.height || 1080,
      deviceId: this.currentDeviceId,
    };
  }

  async stopPreview(): Promise<void> {
    if (this.isRecording) {
      await this.stopRecording();
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => {
        track.stop();
      });
      this.mediaStream = null;
    }

    if (this.videoElement) {
      if (this.previewElement?.contains(this.videoElement)) {
        this.previewElement.removeChild(this.videoElement);
      }
      this.videoElement = null;
    }

    this.previewElement = null;
    this.currentDeviceId = null;
  }

  async switchCamera(options: {
    deviceId?: string;
    direction?: CameraDirection;
  }): Promise<CameraPreviewResult> {
    if (!this.previewElement) {
      throw new Error("Preview not started");
    }

    const mirror = options.direction === "front";

    return this.startPreview({
      element: this.previewElement,
      deviceId: options.deviceId,
      direction: options.direction,
      mirror,
    });
  }

  async capturePhoto(options?: PhotoCaptureOptions): Promise<PhotoResult> {
    if (!this.videoElement || !this.mediaStream) {
      throw new Error("Preview not started");
    }

    const track = this.mediaStream.getVideoTracks()[0];
    const settings = track.getSettings();
    const videoWidth = settings.width || this.videoElement.videoWidth;
    const videoHeight = settings.height || this.videoElement.videoHeight;

    assertPositiveFinite(videoWidth, "videoWidth");
    assertPositiveFinite(videoHeight, "videoHeight");

    const targetWidth = options?.width || videoWidth;
    const targetHeight = options?.height || videoHeight;
    assertPositiveFinite(targetWidth, "width");
    assertPositiveFinite(targetHeight, "height");

    if (
      options?.quality !== undefined &&
      (!Number.isFinite(options.quality) ||
        options.quality < 0 ||
        options.quality > 100)
    ) {
      throw new Error("quality must be a finite number between 0 and 100");
    }

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get canvas context");
    }

    const scaleX = targetWidth / videoWidth;
    const scaleY = targetHeight / videoHeight;
    const scale = Math.max(scaleX, scaleY);

    const drawWidth = videoWidth * scale;
    const drawHeight = videoHeight * scale;
    const drawX = (targetWidth - drawWidth) / 2;
    const drawY = (targetHeight - drawHeight) / 2;

    ctx.drawImage(this.videoElement, drawX, drawY, drawWidth, drawHeight);

    const quality = (options?.quality ?? 90) / 100;
    const format = options?.format || "jpeg";
    const mimeType =
      format === "png"
        ? "image/png"
        : format === "webp"
          ? "image/webp"
          : "image/jpeg";

    const dataUrl = canvas.toDataURL(mimeType, quality);
    const base64 = dataUrl.split(",")[1];
    if (!base64) {
      throw new Error("Failed to encode captured photo");
    }

    return {
      base64,
      format,
      width: targetWidth,
      height: targetHeight,
    };
  }

  async startRecording(options?: VideoCaptureOptions): Promise<void> {
    if (!this.mediaStream) {
      throw new Error("Preview not started");
    }

    if (this.isRecording) {
      throw new Error("Recording already in progress");
    }

    assertRecordingOptions(options);

    let streamToRecord = this.mediaStream;

    if (options?.audio !== false) {
      const audioStream = await getMediaDevices().getUserMedia({
        audio: true,
      });
      streamToRecord = new MediaStream([
        ...this.mediaStream.getVideoTracks(),
        ...audioStream.getAudioTracks(),
      ]);
    }

    const mimeType = getSupportedMimeType();
    if (!mimeType) throw new Error("No supported video mime type found");

    const recorderOptions: MediaRecorderOptions = { mimeType };
    if (options?.bitrate) recorderOptions.videoBitsPerSecond = options.bitrate;

    this.recordedChunks = [];
    this.mediaRecorder = new MediaRecorder(streamToRecord, recorderOptions);

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.recordedChunks.push(event.data);
      }
    };

    this.mediaRecorder.onerror = (event) => {
      this.notifyListeners("error", {
        code: "RECORDING_ERROR",
        message: `Recording error: ${(event as ErrorEvent).message || "Unknown error"}`,
      });
    };

    this.recordingStartTime = Date.now();
    this.isRecording = true;
    this.mediaRecorder.start(1000);

    this.notifyListeners("recordingState", {
      isRecording: true,
      duration: 0,
      fileSize: 0,
    });

    let autoStopping = false;
    this.recordingStateInterval = setInterval(() => {
      if (!this.isRecording || autoStopping) return;

      const duration = (Date.now() - this.recordingStartTime) / 1000;
      const fileSize = this.recordedChunks.reduce(
        (acc, chunk) => acc + chunk.size,
        0,
      );

      this.notifyListeners("recordingState", {
        isRecording: true,
        duration,
        fileSize,
      });

      const overLimit =
        (options?.maxDuration && duration >= options.maxDuration) ||
        (options?.maxFileSize && fileSize >= options.maxFileSize);

      if (overLimit) {
        autoStopping = true;
        this.stopRecording().catch((err) => {
          // error-policy:J6 best-effort auto-stop teardown; the rejection is logged here
          console.error("[Camera] Auto-stop recording failed:", err);
        });
      }
    }, 500);
  }

  async stopRecording(): Promise<VideoResult> {
    if (!this.isRecording || !this.mediaRecorder) {
      throw new Error("Not recording");
    }

    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error("MediaRecorder not initialized"));
        return;
      }

      const duration = (Date.now() - this.recordingStartTime) / 1000;

      this.mediaRecorder.onstop = () => {
        if (this.recordingStateInterval) {
          clearInterval(this.recordingStateInterval);
          this.recordingStateInterval = null;
        }

        this.isRecording = false;

        const blob = new Blob(this.recordedChunks, {
          type: this.mediaRecorder?.mimeType || "video/webm",
        });
        const url = URL.createObjectURL(blob);

        const video = document.createElement("video");
        video.src = url;

        video.onloadedmetadata = () => {
          resolve({
            path: url,
            duration,
            width: video.videoWidth,
            height: video.videoHeight,
            fileSize: blob.size,
            mimeType: this.mediaRecorder?.mimeType || "video/webm",
          });
        };

        video.onerror = () => {
          resolve({
            path: url,
            duration,
            width: 0,
            height: 0,
            fileSize: blob.size,
            mimeType: this.mediaRecorder?.mimeType || "video/webm",
          });
        };

        this.notifyListeners("recordingState", {
          isRecording: false,
          duration,
          fileSize: blob.size,
        });
      };

      this.mediaRecorder.stop();
    });
  }

  async getRecordingState(): Promise<VideoRecordingState> {
    const duration = this.isRecording
      ? (Date.now() - this.recordingStartTime) / 1000
      : 0;
    const fileSize = this.recordedChunks.reduce(
      (acc, chunk) => acc + chunk.size,
      0,
    );

    return {
      isRecording: this.isRecording,
      duration,
      fileSize,
    };
  }

  async getSettings(): Promise<{ settings: CameraSettings }> {
    return { settings: { ...this.currentSettings } };
  }

  async setSettings(options: {
    settings: Partial<CameraSettings>;
  }): Promise<void> {
    if (!options?.settings || typeof options.settings !== "object") {
      throw new Error("settings object is required");
    }
    if (options.settings.zoom !== undefined) {
      const zoom = options.settings.zoom;
      this.assertValidZoom(zoom);
    }

    this.currentSettings = { ...this.currentSettings, ...options.settings };

    if (this.mediaStream && options.settings.zoom !== undefined) {
      await this.applyZoom(options.settings.zoom);
    }
  }

  async setZoom(options: { zoom: number }): Promise<void> {
    const zoom = options?.zoom;
    this.assertValidZoom(zoom);
    await this.applyZoom(zoom);
    this.currentSettings.zoom = zoom;
  }

  private assertValidZoom(zoom: unknown): asserts zoom is number {
    if (typeof zoom !== "number" || !Number.isFinite(zoom) || zoom < 0) {
      throw new Error(
        `Invalid zoom value: ${zoom}. Must be a non-negative finite number.`,
      );
    }
  }

  private async applyZoom(zoom: number): Promise<void> {
    if (!this.mediaStream) return;

    const track = this.mediaStream.getVideoTracks()[0];
    if (!track) return;

    const capabilities = track.getCapabilities ? track.getCapabilities() : {};

    type MediaTrackCapabilitiesExtended = MediaTrackCapabilities & {
      zoom?: { min: number; max: number };
    };
    const caps = capabilities as MediaTrackCapabilitiesExtended;

    if (caps.zoom) {
      const clampedZoom = Math.max(
        caps.zoom.min,
        Math.min(caps.zoom.max, zoom),
      );
      await track.applyConstraints({
        advanced: [{ zoom: clampedZoom } as MediaTrackConstraintSet],
      });
    }
  }

  async setFocusPoint(options: { x: number; y: number }): Promise<void> {
    if (!this.mediaStream) throw new Error("Preview not started");
    this.assertNormalizedPoint(options, "focus point");

    const track = this.mediaStream.getVideoTracks()[0];
    if (!track) throw new Error("No video track available");

    const caps = track.getCapabilities ? track.getCapabilities() : {};
    type ExtendedCaps = MediaTrackCapabilities & { focusMode?: string[] };
    if (!(caps as ExtendedCaps).focusMode?.includes("manual")) {
      throw new Error("Manual focus not supported by this camera");
    }

    try {
      await track.applyConstraints({
        advanced: [
          {
            focusMode: "manual",
            pointsOfInterest: [{ x: options.x, y: options.y }],
          } as MediaTrackConstraintSet,
        ],
      });
    } catch (e) {
      // error-policy:J2 add focus-point context to the applyConstraints failure and rethrow
      throw new Error(
        `Failed to set focus point: ${e instanceof Error ? e.message : "unknown error"}`,
      );
    }
  }

  async setExposurePoint(options: { x: number; y: number }): Promise<void> {
    if (!this.mediaStream) throw new Error("Preview not started");
    this.assertNormalizedPoint(options, "exposure point");

    const track = this.mediaStream.getVideoTracks()[0];
    if (!track) throw new Error("No video track available");

    const caps = track.getCapabilities ? track.getCapabilities() : {};
    type ExtendedCaps = MediaTrackCapabilities & { exposureMode?: string[] };
    if (!(caps as ExtendedCaps).exposureMode?.includes("manual")) {
      throw new Error("Manual exposure not supported by this camera");
    }

    try {
      await track.applyConstraints({
        advanced: [
          {
            exposureMode: "manual",
            pointsOfInterest: [{ x: options.x, y: options.y }],
          } as MediaTrackConstraintSet,
        ],
      });
    } catch (e) {
      // error-policy:J2 add exposure-point context to the applyConstraints failure and rethrow
      throw new Error(
        `Failed to set exposure point: ${e instanceof Error ? e.message : "unknown error"}`,
      );
    }
  }

  private assertNormalizedPoint(
    options: { x: number; y: number },
    name: string,
  ): void {
    if (
      !Number.isFinite(options?.x) ||
      !Number.isFinite(options?.y) ||
      options.x < 0 ||
      options.x > 1 ||
      options.y < 0 ||
      options.y > 1
    ) {
      throw new Error(`${name} must use finite x/y values between 0 and 1`);
    }
  }

  async checkPermissions(): Promise<CameraPermissionStatus> {
    let cameraStatus: "granted" | "denied" | "prompt" = "prompt";
    let microphoneStatus: "granted" | "denied" | "prompt" = "prompt";

    try {
      const cameraResult = await navigator.permissions.query({
        name: "camera" as PermissionName,
      });
      cameraStatus = cameraResult.state as "granted" | "denied" | "prompt";
    } catch (err) {
      // error-policy:J4 Permissions API cannot query camera in this browser; keep the "prompt" default
      console.debug("[Camera] permissions.query('camera') not supported:", err);
    }

    try {
      const micResult = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      microphoneStatus = micResult.state as "granted" | "denied" | "prompt";
    } catch (err) {
      // error-policy:J4 Permissions API cannot query microphone in this browser; keep the "prompt" default
      console.debug(
        "[Camera] permissions.query('microphone') not supported:",
        err,
      );
    }

    // Note: Web platform doesn't have a "photos" permission concept.
    // Photos are captured from camera stream, so camera permission covers this.
    return {
      camera: cameraStatus,
      microphone: microphoneStatus,
      photos: cameraStatus, // Photos access follows camera permission on web
    };
  }

  async requestPermissions(): Promise<CameraPermissionStatus> {
    let cameraStatus: "granted" | "denied" | "prompt" = "denied";
    let microphoneStatus: "granted" | "denied" | "prompt" = "denied";

    try {
      const stream = await getMediaDevices().getUserMedia({
        video: true,
        audio: true,
      });
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      cameraStatus = "granted";
      microphoneStatus = "granted";
    } catch {
      // error-policy:J4 combined camera+mic prompt was denied; retry each capability separately
      try {
        const videoStream = await getMediaDevices().getUserMedia({
          video: true,
        });
        videoStream.getTracks().forEach((track) => {
          track.stop();
        });
        cameraStatus = "granted";
      } catch {
        // error-policy:J4 camera permission denied
        cameraStatus = "denied";
      }

      try {
        const audioStream = await getMediaDevices().getUserMedia({
          audio: true,
        });
        audioStream.getTracks().forEach((track) => {
          track.stop();
        });
        microphoneStatus = "granted";
      } catch {
        // error-policy:J4 microphone permission denied
        microphoneStatus = "denied";
      }
    }

    return {
      camera: cameraStatus,
      microphone: microphoneStatus,
      photos: cameraStatus, // Photos access follows camera permission on web
    };
  }

  async addListener(
    eventName: string,
    listenerFunc: (event: CameraEventData) => void,
  ): Promise<{ remove: () => Promise<void> }> {
    const entry = { eventName, callback: listenerFunc };
    this.pluginListeners.push(entry);
    return {
      remove: async () => {
        const i = this.pluginListeners.indexOf(entry);
        if (i >= 0) this.pluginListeners.splice(i, 1);
      },
    };
  }

  async removeAllListeners(): Promise<void> {
    this.pluginListeners = [];
  }

  protected notifyListeners(eventName: string, data: CameraEventData): void {
    this.pluginListeners
      .filter((l) => l.eventName === eventName)
      .forEach((l) => {
        l.callback(data);
      });
  }
}
