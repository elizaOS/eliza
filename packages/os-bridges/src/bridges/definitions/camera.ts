// spec/os/android/camera.md, "Story: See the live view I opened"; spec/os/android/camera.md, "Story: Capture with the camera only from the live view"; spec/os/android/camera.md, "A preview binds its photo stream only at an aspect ratio the device lists"; spec/os/android/camera.md, "While a recording runs, only one zoom or torch change runs at a time"
import type { PluginListenerHandle } from "@capacitor/core";
import type { AccessDenial, CameraView, GrantRead, PreviewPhase, RecordingResult, Work } from "../../../gen/os__android__camera.ts";

export type { AccessDenial, CameraView, GrantRead, PreviewPhase, RecordingResult, Work };

export type CameraDirection = "front" | "back" | "external";
export type CameraFlashMode = "auto" | "on" | "off" | "torch";
export type CameraFocusMode = "auto" | "continuous" | "manual";
export type CameraExposureMode = "auto" | "continuous" | "manual";
export type CameraWhiteBalance = "auto" | "daylight" | "cloudy" | "tungsten" | "fluorescent";
export type MediaType = "photo" | "video";
export type CameraGrant = "granted" | "denied" | "prompt";
export type CameraAccessKind = "camera" | "microphone";
export type CameraCaptureAspectRatio = "4:3" | "16:9";
export type CameraRecordingControl = "zoom" | "torch";

export interface CameraResolution {
  width: number;
  height: number;
}

export interface CameraDevice {
  deviceId: string;
  label: string;
  direction: CameraDirection;
  hasFlash: boolean;
  hasZoom: boolean;
  maxZoom: number;
  supportedResolutions: CameraResolution[];
  supportedFrameRates: number[];
  supportedCaptureAspectRatios?: CameraCaptureAspectRatio[];
}

export interface CameraPreviewOptions {
  deviceId?: string;
  direction?: CameraDirection;
  resolution?: CameraResolution;
  mirror?: boolean;
  captureAspectRatio?: CameraCaptureAspectRatio;
}

export interface CameraPreviewResult {
  width: number;
  height: number;
  deviceId: string;
  previewSize?: CameraResolution;
  captureSize?: CameraResolution;
  minZoom: number;
  maxZoom: number;
  zoom: number;
  hasFlash: boolean;
  flash: "on" | "off";
}

export interface PhotoCaptureOptions {
  quality?: number;
  format?: "jpeg" | "png" | "webp";
  width?: number;
  height?: number;
  saveToGallery?: boolean;
  thumbnailOnly?: boolean;
  exifOrientation?: boolean;
}

export interface PhotoResult {
  base64?: string;
  thumbnail?: string;
  format: string;
  width: number;
  height: number;
  path?: string;
  libraryId?: string;
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

export interface CaptureModeOptions extends Pick<VideoCaptureOptions, "quality" | "bitrate" | "frameRate"> {
  mode: MediaType;
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
  whiteBalance: CameraWhiteBalance;
  iso?: number;
  shutterSpeed?: number;
}

export interface CameraPermissionStatus {
  camera: CameraGrant;
  microphone: CameraGrant;
  photos: CameraGrant | "limited";
}

export type CameraAccessPermissionStatus = Pick<CameraPermissionStatus, "camera">;

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
  checkCameraPermission(): Promise<CameraAccessPermissionStatus>;
  requestCameraPermission(): Promise<CameraAccessPermissionStatus>;
  getDevices(): Promise<{ devices: CameraDevice[] }>;
  startPreview(options: CameraPreviewOptions): Promise<CameraPreviewResult>;
  stopPreview(): Promise<void>;
  setCaptureMode(options: CaptureModeOptions): Promise<void>;
  switchCamera(options: { direction: Exclude<CameraDirection, "external"> }): Promise<CameraPreviewResult>;
  capturePhoto(options?: PhotoCaptureOptions): Promise<PhotoResult>;
  startRecording(options?: VideoCaptureOptions): Promise<void>;
  stopRecording(): Promise<VideoResult>;
  getRecordingState(): Promise<VideoRecordingState>;
  getSettings(): Promise<{ settings: CameraSettings }>;
  setSettings(options: { settings: Partial<CameraSettings> }): Promise<void>;
  setZoom(options: { zoom: number }): Promise<void>;
  setFocusPoint(options: { x: number; y: number }): Promise<void>;
  setExposurePoint(options: { x: number; y: number }): Promise<void>;
  checkPermissions(): Promise<CameraPermissionStatus>;
  requestPermissions(): Promise<CameraPermissionStatus>;
  addListener(eventName: "frame", listenerFunc: (event: CameraFrameEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "error", listenerFunc: (event: CameraErrorEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "recordingState", listenerFunc: (event: VideoRecordingState) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export type CameraClient = Omit<CameraPlugin, "addListener" | "removeAllListeners">;

export type CameraSessionPhase ="off" | "starting" | "ready" | "error";

export interface CameraRecordingReceipt {
  path: string;
  duration: number;
  fileSize: number;
}

export interface CameraSessionBridge<Preview = CameraPreviewOptions, Recording = VideoCaptureOptions, Video extends CameraRecordingReceipt = VideoResult> {
  startPreview(options: Preview): Promise<unknown>;
  stopPreview(): Promise<unknown>;
  startRecording(options: Recording): Promise<unknown>;
  stopRecording(): Promise<Video>;
  checkCameraPermission(): Promise<{ camera?: string }>;
}

export interface CameraSessionHooks<Video> {
  recordingSaved(video: Video): Promise<void> | void;
  recordingFinishing?(): void;
  recordingFailed?(): void;
  changed?(): void;
}

export interface CameraSessionOptions<Preview, Recording, Video extends CameraRecordingReceipt> {
  camera: CameraSessionBridge<Preview, Recording, Video>;
  registered?(): boolean;
  preview(): Preview;
  recording(): Recording;
  hooks: CameraSessionHooks<Video>;
}

export type CameraStartOutcome =
  | { status: "ready" }
  | { status: "denied" }
  | { status: "unavailable"; reason: "missing" | "failed"; error?: unknown }
  | { status: "skipped" }
  | { status: "stale" };

export type CameraControlOutcome = "done" | "failed" | "skipped" | "stale";

export type CameraRecordingStart = "recording" | "denied" | "failed" | "skipped" | "stale";

export type CameraRecordingOutcome = "saved" | "failed";

export type CameraExclusive<T> = { status: "done"; value: T } | { status: "busy" } | { status: "closed" };

export interface CameraSessionSnapshot {
  phase: CameraSessionPhase;
  denied?: CameraAccessKind;
  controlBusy: boolean;
  capturing: boolean;
  recording: boolean;
  recordingStarting: boolean;
  finalizing: boolean;
}

export type CameraKeepOutcome = { status: "saved"; id?: string; message?: string } | { status: "failed" | "unknown"; message: string };

export interface CameraCaptureAction {
  id: string;
  label: string;
  run(photo: PhotoResult): Promise<void> | void;
}

export interface CameraKeepPort<Item> {
  label: string;
  run(item: Item, operationId: string): Promise<CameraKeepOutcome>;
}

export interface CameraVideoPort {
  options?(): VideoCaptureOptions;
  keep: CameraKeepPort<VideoResult>;
  discard?(video: VideoResult): Promise<void> | void;
}

export interface CameraHostPorts {
  keep?: CameraKeepPort<PhotoResult>;
  video?: CameraVideoPort;
  actions?: readonly CameraCaptureAction[];
  checkAccess?(): Promise<{ camera?: string }>;
}

export type ScanSource = "captured" | "selected" | "unsaved";

export type ScanImageType = "image/jpeg" | "image/png" | "image/webp";

export interface ScanImage {
  readonly type: string;
  readonly size: number;
}

export interface ScanPage<Image extends ScanImage, Layer> {
  readonly id: number;
  readonly image: Image;
  readonly textLayer?: Layer | null;
}

export interface ScanDraftPort<Image extends ScanImage, Layer> {
  save(pages: Image[], revision: string | undefined, signal: AbortSignal, layers: (Layer | null)[]): Promise<{ revision: string }>;
  read(): Promise<{ revision: string; pages: Image[]; textLayers?: (Layer | null)[] } | undefined>;
  remove(revision: string, signal: AbortSignal): Promise<void>;
}

export interface ScanExportResult {
  status: string;
  message: string;
}

export type ScanRefusal = "unsupported-image" | "dimensions-too-large" | "too-many-pages" | "document-too-large";
