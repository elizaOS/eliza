/**
 * Shared TypeScript contract for the camera plugin: the `CameraPlugin`
 * interface plus every options/result/event type it uses. Implemented by
 * `CameraWeb` (web.ts) and the native Swift/Kotlin bridges; kept
 * dependency-free so it can be imported from either side.
 */
import type { PluginListenerHandle } from "@capacitor/core";

export type CameraDirection = "front" | "back" | "external";
export type CameraFlashMode = "auto" | "on" | "off" | "torch";
export type CameraFocusMode = "auto" | "continuous" | "manual";
export type CameraExposureMode = "auto" | "continuous" | "manual";
export type MediaType = "photo" | "video";

export interface CameraDevice {
  deviceId: string;
  label: string;
  direction: CameraDirection;
  hasFlash: boolean;
  hasZoom: boolean;
  maxZoom: number;
  supportedResolutions: CameraResolution[];
  supportedFrameRates: number[];
}

export interface CameraResolution {
  width: number;
  height: number;
}

export interface CameraPreviewOptions {
  /**
   * Host element for the web preview's `<video>`. Required on web, where
   * `startPreview` rejects without it; the native bridges render their own
   * preview and ignore it.
   */
  element?: HTMLElement;
  /**
   * A `deviceId` from `getDevices`; it wins over `direction`. Android rejects
   * an unknown id with `INVALID_OPTIONS`.
   */
  deviceId?: string;
  direction?: CameraDirection;
  resolution?: CameraResolution;
  /**
   * Preview frame rate. Android rejects it with `INVALID_OPTIONS`; set
   * `frameRate` on the recording options instead.
   */
  frameRate?: number;
  mirror?: boolean;
}

export interface CameraPreviewResult {
  /** Requested preview size. */
  width: number;
  height: number;
  deviceId: string;
  /** Preview size the camera actually bound, upright. Android only. */
  previewSize?: CameraResolution;
  /**
   * Photo size the camera actually bound, upright. Android picks the largest
   * size the bound stream combination allows, which can be below the sensor
   * maximum on LIMITED hardware while video capture is bound. Android only.
   */
  captureSize?: CameraResolution;
}

export interface PhotoCaptureOptions {
  quality?: number;
  format?: "jpeg" | "png" | "webp";
  /**
   * Output size. Omitted dimensions keep the captured size. Photos are
   * captured at full resolution and returned as base64 over the bridge, so
   * a full-size photo costs several megabytes of memory per call; set these
   * to downscale when that matters.
   */
  width?: number;
  height?: number;
  /**
   * Also save the photo to the gallery. On Android an unscaled JPEG saves the
   * camera's own file with its EXIF; other saves carry the camera's tags
   * (never GPS) on the re-encoded image.
   */
  saveToGallery?: boolean;
  exifOrientation?: boolean;
}

export interface PhotoResult {
  base64: string;
  format: string;
  width: number;
  height: number;
  path?: string;
  exif?: Record<string, string | number>;
}

export interface VideoCaptureOptions {
  quality?: "low" | "medium" | "high" | "highest";
  maxDuration?: number;
  maxFileSize?: number;
  saveToGallery?: boolean;
  audio?: boolean;
  bitrate?: number;
  frameRate?: number;
}

export interface VideoRecordingState {
  isRecording: boolean;
  duration: number;
  fileSize: number;
}

export interface VideoResult {
  path: string;
  duration: number;
  width: number;
  height: number;
  fileSize: number;
  mimeType: string;
}

export interface CameraSettings {
  flash: CameraFlashMode;
  zoom: number;
  focusMode: CameraFocusMode;
  exposureMode: CameraExposureMode;
  exposureCompensation: number;
  whiteBalance: "auto" | "daylight" | "cloudy" | "tungsten" | "fluorescent";
  iso?: number;
  shutterSpeed?: number;
}

export interface CameraPermissionStatus {
  camera: "granted" | "denied" | "prompt";
  microphone: "granted" | "denied" | "prompt";
  photos: "granted" | "denied" | "prompt" | "limited";
}

/** Camera-only permission; this never establishes microphone or photo-library access. */
export type CameraAccessPermissionStatus = Pick<
  CameraPermissionStatus,
  "camera"
>;

export interface CameraErrorEvent {
  code: string;
  message: string;
}

export interface CameraFrameEvent {
  timestamp: number;
  width: number;
  height: number;
}

export interface CameraPlugin {
  /** Read camera permission without opening a stream or requesting other access. */
  checkCameraPermission(): Promise<CameraAccessPermissionStatus>;

  /** Request only camera access. Does not start preview, microphone or library access. */
  requestCameraPermission(): Promise<CameraAccessPermissionStatus>;

  /**
   * Get list of available camera devices
   */
  getDevices(): Promise<{ devices: CameraDevice[] }>;

  /**
   * Start camera preview (in `options.element` on web)
   */
  startPreview(options: CameraPreviewOptions): Promise<CameraPreviewResult>;

  /**
   * Stop camera preview
   */
  stopPreview(): Promise<void>;

  /**
   * Switch to a different camera
   */
  switchCamera(options: {
    /** Android switches by direction only and rejects this with `INVALID_OPTIONS`. */
    deviceId?: string;
    direction?: CameraDirection;
  }): Promise<CameraPreviewResult>;

  /**
   * Capture a photo from the current preview
   */
  capturePhoto(options?: PhotoCaptureOptions): Promise<PhotoResult>;

  /**
   * Start recording video. On Android a failed start keeps the preview live;
   * when the preview could not be restored it rejects `PREVIEW_STOPPED` and
   * the host must start the preview again.
   */
  startRecording(options?: VideoCaptureOptions): Promise<void>;

  /**
   * Stop recording and return the video file
   */
  stopRecording(): Promise<VideoResult>;

  /**
   * Get current recording state
   */
  getRecordingState(): Promise<VideoRecordingState>;

  /**
   * Get current camera settings
   */
  getSettings(): Promise<{ settings: CameraSettings }>;

  /**
   * Update camera settings
   */
  setSettings(options: { settings: Partial<CameraSettings> }): Promise<void>;

  /**
   * Set zoom level (1.0 = no zoom)
   */
  setZoom(options: { zoom: number }): Promise<void>;

  /**
   * Set focus point (x, y are normalized 0-1)
   */
  setFocusPoint(options: { x: number; y: number }): Promise<void>;

  /**
   * Set exposure point (x, y are normalized 0-1)
   */
  setExposurePoint(options: { x: number; y: number }): Promise<void>;

  /**
   * Check camera permissions
   */
  checkPermissions(): Promise<CameraPermissionStatus>;

  /**
   * Request camera permissions
   */
  requestPermissions(): Promise<CameraPermissionStatus>;

  /**
   * Add event listener for camera frame
   */
  addListener(
    eventName: "frame",
    listenerFunc: (event: CameraFrameEvent) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Add event listener for camera error
   */
  addListener(
    eventName: "error",
    listenerFunc: (event: CameraErrorEvent) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Add event listener for recording state changes
   */
  addListener(
    eventName: "recordingState",
    listenerFunc: (event: VideoRecordingState) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Remove all event listeners
   */
  removeAllListeners(): Promise<void>;
}
