import type { PluginListenerHandle } from "@capacitor/core";

export interface ScreenshotOptions {
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  scale?: number;
  captureSystemUI?: boolean;
}

export interface ScreenshotResult {
  base64: string;
  format: string;
  width: number;
  height: number;
  timestamp: number;
}

export interface ScreenRecordingOptions {
  quality?: "low" | "medium" | "high" | "highest";
  maxDuration?: number;
  maxFileSize?: number;
  fps?: number;
  bitrate?: number;
  captureAudio?: boolean;
  captureSystemAudio?: boolean;
  captureMicrophone?: boolean;
  showTouches?: boolean;
}

export interface ScreenRecordingState {
  isRecording: boolean;
  duration: number;
  fileSize: number;
  fps?: number;
}

export interface ScreenRecordingResult {
  path: string;
  duration: number;
  width: number;
  height: number;
  fileSize: number;
  mimeType: string;
}

export interface ScreenCapturePermissionStatus {
  screenCapture: "granted" | "denied" | "prompt" | "not_supported";
  microphone: "granted" | "denied" | "prompt";
}

export interface ScreenCaptureErrorEvent {
  code: string;
  message: string;
}

export interface ScreenCapturePlugin {
  /**
   * Check if screen capture is supported on this device
   */
  isSupported(): Promise<{ supported: boolean; features: string[] }>;

  /**
   * Capture a screenshot of the current screen
   */
  captureScreenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>;

  /**
   * Start screen recording
   */
  startRecording(options?: ScreenRecordingOptions): Promise<void>;

  /**
   * Stop screen recording and return the video file
   */
  stopRecording(): Promise<ScreenRecordingResult>;

  /**
   * Pause the current recording
   */
  pauseRecording(): Promise<void>;

  /**
   * Resume a paused recording
   */
  resumeRecording(): Promise<void>;

  /**
   * Get current recording state
   */
  getRecordingState(): Promise<ScreenRecordingState>;

  /**
   * Check screen capture permissions
   */
  checkPermissions(): Promise<ScreenCapturePermissionStatus>;

  /**
   * Request screen capture permissions
   */
  requestPermissions(): Promise<ScreenCapturePermissionStatus>;

  /**
   * Add event listener for recording state changes
   */
  addListener(
    eventName: "recordingState",
    listenerFunc: (event: ScreenRecordingState) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Add event listener for errors
   */
  addListener(
    eventName: "error",
    listenerFunc: (event: ScreenCaptureErrorEvent) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Remove all event listeners
   */
  removeAllListeners(): Promise<void>;
}
