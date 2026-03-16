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
  element: HTMLElement;
  deviceId?: string;
  direction?: CameraDirection;
  resolution?: CameraResolution;
  frameRate?: number;
  mirror?: boolean;
}

export interface CameraPreviewResult {
  width: number;
  height: number;
  deviceId: string;
}

export interface PhotoCaptureOptions {
  quality?: number;
  format?: "jpeg" | "png" | "webp";
  width?: number;
  height?: number;
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
  /**
   * Get list of available camera devices
   */
  getDevices(): Promise<{ devices: CameraDevice[] }>;

  /**
   * Start camera preview in the specified element
   */
  startPreview(options: CameraPreviewOptions): Promise<CameraPreviewResult>;

  /**
   * Stop camera preview
   */
  stopPreview(): Promise<void>;

  /**
   * Switch to a different camera
   */
  switchCamera(options: { deviceId?: string; direction?: CameraDirection }): Promise<CameraPreviewResult>;

  /**
   * Capture a photo from the current preview
   */
  capturePhoto(options?: PhotoCaptureOptions): Promise<PhotoResult>;

  /**
   * Start recording video
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
    listenerFunc: (event: CameraFrameEvent) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Add event listener for camera error
   */
  addListener(
    eventName: "error",
    listenerFunc: (event: CameraErrorEvent) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Add event listener for recording state changes
   */
  addListener(
    eventName: "recordingState",
    listenerFunc: (event: VideoRecordingState) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Remove all event listeners
   */
  removeAllListeners(): Promise<void>;
}
