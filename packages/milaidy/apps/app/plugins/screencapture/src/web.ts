import { WebPlugin } from "@capacitor/core";

import type {
  ScreenCapturePlugin,
  ScreenshotOptions,
  ScreenshotResult,
  ScreenRecordingOptions,
  ScreenRecordingResult,
  ScreenRecordingState,
  ScreenCapturePermissionStatus,
  ScreenCaptureErrorEvent,
} from "./definitions";

type ScreenCaptureEventData = ScreenRecordingState | ScreenCaptureErrorEvent;

const VIDEO_MIME_TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
const getSupportedMimeType = (): string | null => VIDEO_MIME_TYPES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;

type DisplayMediaDevices = MediaDevices & { getDisplayMedia(constraints?: DisplayMediaStreamOptions): Promise<MediaStream> };
const hasDisplayMedia = (): boolean => !!(navigator.mediaDevices as Partial<DisplayMediaDevices>).getDisplayMedia;

/** ImageCapture is a newer web API not yet in all TS lib definitions */
declare class ImageCapture {
  constructor(track: MediaStreamTrack);
  grabFrame(): Promise<ImageBitmap>;
  takePhoto(photoSettings?: Record<string, unknown>): Promise<Blob>;
}
const getDisplayMedia = (opts: DisplayMediaStreamOptions) => (navigator.mediaDevices as DisplayMediaDevices).getDisplayMedia(opts);

export class ScreenCaptureWeb extends WebPlugin {
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private isRecording = false;
  private isPaused = false;
  private recordingStartTime = 0;
  private pausedDuration = 0;
  private pauseStartTime = 0;
  private recordingStateInterval: ReturnType<typeof setInterval> | null = null;
  private pluginListeners: Array<{ eventName: string; callback: (event: ScreenCaptureEventData) => void }> = [];

  async isSupported(): Promise<{ supported: boolean; features: string[] }> {
    const supported = hasDisplayMedia();
    const features: string[] = [];
    if (supported) features.push("screenshot", "recording");
    if (typeof MediaRecorder !== "undefined") features.push("video_encoding");
    if (typeof AudioContext !== "undefined") features.push("system_audio");
    return { supported, features };
  }

  async captureScreenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    const format = options?.format || "png";
    const quality = (options?.quality || 100) / 100;
    const scale = options?.scale || 1;

    const stream = await getDisplayMedia({ video: { displaySurface: "monitor" }, audio: false });

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const width = (settings.width || 1920) * scale;
    const height = (settings.height || 1080) * scale;

    const imageCapture = new ImageCapture(track);
    const bitmap = await imageCapture.grabFrame();

    stream.getTracks().forEach((t) => t.stop());

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get canvas context");
    }

    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const mimeType = format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
    const dataUrl = canvas.toDataURL(mimeType, quality);
    const base64 = dataUrl.split(",")[1];

    return {
      base64,
      format,
      width,
      height,
      timestamp: Date.now(),
    };
  }

  async startRecording(options?: ScreenRecordingOptions): Promise<void> {
    if (this.isRecording) throw new Error("Recording already in progress");

    const videoConstraints: MediaTrackConstraints = { displaySurface: "monitor" };
    if (options?.fps) videoConstraints.frameRate = { ideal: options.fps };

    this.mediaStream = await getDisplayMedia({ video: videoConstraints, audio: options?.captureSystemAudio !== false });

    if (options?.captureMicrophone) {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStream.getAudioTracks().forEach((t) => this.mediaStream?.addTrack(t));
    }

    const mimeType = getSupportedMimeType();
    if (!mimeType) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      throw new Error("No supported video mime type found");
    }

    const recorderOptions: MediaRecorderOptions = { mimeType };
    if (options?.bitrate) recorderOptions.videoBitsPerSecond = options.bitrate;

    this.recordedChunks = [];
    this.mediaRecorder = new MediaRecorder(this.mediaStream, recorderOptions);

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

    this.mediaStream.getVideoTracks()[0].addEventListener("ended", () => {
      if (this.isRecording) {
        this.stopRecording().catch((err) => {
          console.error("[ScreenCapture] Auto-stop on track end failed:", err);
        });
      }
    });

    this.recordingStartTime = Date.now();
    this.pausedDuration = 0;
    this.isRecording = true;
    this.isPaused = false;
    this.mediaRecorder.start(1000);

    this.notifyListeners("recordingState", { isRecording: true, duration: 0, fileSize: 0 });

    let autoStopping = false;
    this.recordingStateInterval = setInterval(() => {
      if (!this.isRecording || this.isPaused || autoStopping) return;

      const duration = (Date.now() - this.recordingStartTime - this.pausedDuration) / 1000;
      const fileSize = this.recordedChunks.reduce((acc, chunk) => acc + chunk.size, 0);

      this.notifyListeners("recordingState", { isRecording: true, duration, fileSize });

      const overLimit = (options?.maxDuration && duration >= options.maxDuration)
        || (options?.maxFileSize && fileSize >= options.maxFileSize);

      if (overLimit) {
        autoStopping = true;
        this.stopRecording().catch((err) => {
          console.error("[ScreenCapture] Auto-stop recording failed:", err);
        });
      }
    }, 500);
  }

  async stopRecording(): Promise<ScreenRecordingResult> {
    if (!this.isRecording || !this.mediaRecorder) {
      throw new Error("Not recording");
    }

    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error("MediaRecorder not initialized"));
        return;
      }

      const duration = (Date.now() - this.recordingStartTime - this.pausedDuration) / 1000;

      this.mediaRecorder.onstop = () => {
        if (this.recordingStateInterval) {
          clearInterval(this.recordingStateInterval);
          this.recordingStateInterval = null;
        }

        this.isRecording = false;
        this.isPaused = false;

        if (this.mediaStream) {
          this.mediaStream.getTracks().forEach((track) => track.stop());
          this.mediaStream = null;
        }

        const blob = new Blob(this.recordedChunks, { type: this.mediaRecorder?.mimeType || "video/webm" });
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

  async pauseRecording(): Promise<void> {
    if (!this.isRecording || !this.mediaRecorder) {
      throw new Error("Not recording");
    }

    if (this.isPaused) {
      return;
    }

    this.mediaRecorder.pause();
    this.isPaused = true;
    this.pauseStartTime = Date.now();

    const duration = (Date.now() - this.recordingStartTime - this.pausedDuration) / 1000;
    const fileSize = this.recordedChunks.reduce((acc, chunk) => acc + chunk.size, 0);

    this.notifyListeners("recordingState", {
      isRecording: true,
      duration,
      fileSize,
    });
  }

  async resumeRecording(): Promise<void> {
    if (!this.isRecording || !this.mediaRecorder) {
      throw new Error("Not recording");
    }

    if (!this.isPaused) {
      return;
    }

    this.pausedDuration += Date.now() - this.pauseStartTime;
    this.mediaRecorder.resume();
    this.isPaused = false;
  }

  async getRecordingState(): Promise<ScreenRecordingState> {
    const duration = this.isRecording
      ? (Date.now() - this.recordingStartTime - this.pausedDuration) / 1000
      : 0;
    const fileSize = this.recordedChunks.reduce((acc, chunk) => acc + chunk.size, 0);

    return {
      isRecording: this.isRecording,
      duration,
      fileSize,
    };
  }

  /**
   * Check screen capture permissions.
   * 
   * LIMITATION: The Screen Capture API (getDisplayMedia) does not support permission queries.
   * Unlike camera/microphone, there's no way to check if permission was previously granted.
   * Each call to getDisplayMedia always prompts the user.
   * 
   * `screenCapture` will be:
   * - "not_supported": getDisplayMedia API not available
   * - "prompt": API available, but actual permission state is unknown (always requires prompt)
   */
  async checkPermissions(): Promise<ScreenCapturePermissionStatus> {
    let microphone: "granted" | "denied" | "prompt" = "prompt";
    try {
      const result = await navigator.permissions.query({ name: "microphone" as PermissionName });
      microphone = result.state as "granted" | "denied" | "prompt";
    } catch {
      // Permissions API may not support microphone query in this browser
    }

    // Screen capture permission cannot be queried - getDisplayMedia always prompts
    const screenCaptureStatus = hasDisplayMedia() ? "prompt" : "not_supported";

    return { screenCapture: screenCaptureStatus, microphone };
  }

  /**
   * Request screen capture permissions.
   * 
   * LIMITATION: Screen capture (getDisplayMedia) cannot be pre-requested.
   * The user is prompted only when an actual capture is initiated.
   * This method only requests microphone permission for audio capture during recording.
   * 
   * `screenCapture` will be:
   * - "not_supported": getDisplayMedia API not available  
   * - "prompt": API available (permission prompt happens during actual capture)
   */
  async requestPermissions(): Promise<ScreenCapturePermissionStatus> {
    let microphone: "granted" | "denied" | "prompt" = "denied";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      microphone = "granted";
    } catch {
      microphone = "denied";
    }

    // Cannot pre-request screen capture permission - it requires user gesture + actual capture
    const screenCaptureStatus = hasDisplayMedia() ? "prompt" : "not_supported";

    return { screenCapture: screenCaptureStatus, microphone };
  }

  async addListener(
    eventName: string,
    listenerFunc: (event: ScreenCaptureEventData) => void
  ): Promise<{ remove: () => Promise<void> }> {
    const entry = { eventName, callback: listenerFunc };
    this.pluginListeners.push(entry);
    return { remove: async () => { const i = this.pluginListeners.indexOf(entry); if (i >= 0) this.pluginListeners.splice(i, 1); } };
  }

  async removeAllListeners(): Promise<void> { this.pluginListeners = []; }

  protected notifyListeners(eventName: string, data: ScreenCaptureEventData): void {
    this.pluginListeners.filter((l) => l.eventName === eventName).forEach((l) => l.callback(data));
  }
}
