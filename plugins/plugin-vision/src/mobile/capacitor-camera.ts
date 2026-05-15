// MobileCameraSource — JS contract for native Capacitor / AOSP camera bridges.
//
// This file defines the **interface only**. The native sides (Android
// CameraX via plugin-aosp, iOS AVFoundation via plugin-ios) wire up matching
// implementations. Once those native plugins land, swap the
// `CapacitorCameraStub` for a real `CapacitorCamera` impl that calls into
// the registered Capacitor plugin via `Capacitor.Plugins.MiladyVision` or
// equivalent.
//
// Why we ship the stub now: the JS surface needs to be stable before the
// native teams can call into it. Anything in plugin-vision that needs a
// mobile camera goes through `MobileCameraSource`, never directly through
// `imagesnap` / `fswebcam` / `ffmpeg`.

import { logger } from "@elizaos/core";
import type { CameraInfo, VisionFrame } from "../types";

interface MobileCameraOpenOptions {
  /** Stable camera id (typically `back` / `front` / a per-device id). */
  cameraId?: string;
  /** Desired frame width in pixels — the native side may snap to nearest. */
  width?: number;
  /** Desired frame height in pixels. */
  height?: number;
  /** Desired frame rate. */
  fps?: number;
}

/**
 * Minimal interface every mobile camera implementation must satisfy.
 *
 * Implementations live in:
 *   - plugin-aosp (Android NNAPI / CameraX) — WS8
 *   - plugin-ios (Core ML / AVFoundation) — WS9
 *   - plugin-capacitor-bridge (cross-platform Capacitor plugin) — TBD
 */
export interface MobileCameraSource {
  /** Discover cameras visible to the OS. */
  listCameras(): Promise<CameraInfo[]>;
  /** Open a session — may be a no-op if continuous capture isn't supported. */
  open(opts?: MobileCameraOpenOptions): Promise<void>;
  /** Capture a single frame as a JPEG buffer. */
  captureJpeg(): Promise<Buffer>;
  /** Capture and return a fully-decoded RGBA frame. */
  captureRgbaFrame?(): Promise<VisionFrame>;
  /** Tear down the session. */
  close(): Promise<void>;
  /** Optional capability declaration — UIs use this to gate buttons. */
  capabilities?(): {
    supportsContinuousFrames: boolean;
    supportsExposureLock: boolean;
    supportsTorch: boolean;
  };
}

/**
 * Default stub implementation. Returns no cameras and refuses captures. This
 * keeps the plugin-vision JS surface buildable on Node platforms where no
 * native bridge is registered.
 */
export class CapacitorCameraStub implements MobileCameraSource {
  async listCameras(): Promise<CameraInfo[]> {
    logger.debug(
      "[CapacitorCameraStub] listCameras() — no native bridge registered",
    );
    return [];
  }
  async open(): Promise<void> {
    throw new Error(
      "MobileCameraSource not implemented — native bridge missing (see WS8/WS9).",
    );
  }
  async captureJpeg(): Promise<Buffer> {
    throw new Error("MobileCameraSource not implemented");
  }
  async close(): Promise<void> {}
}

/**
 * Registry hook: native plugins call this on boot to register their
 * implementation. plugin-vision's runtime camera picker queries the registry
 * and prefers the registered implementation over the Node `imagesnap` /
 * `fswebcam` / `ffmpeg` paths.
 *
 * Single global slot — last registration wins. The registry deliberately
 * isn't a multi-source priority list because mobile devices have one
 * camera bridge at a time.
 */
const REGISTRY_KEY = Symbol.for("elizaos.plugin-vision.mobile-camera-source");
interface RegistryHost {
  [REGISTRY_KEY]?: MobileCameraSource;
}

export function registerMobileCameraSource(source: MobileCameraSource): void {
  (globalThis as unknown as RegistryHost)[REGISTRY_KEY] = source;
  logger.info(`[MobileCameraSource] registered (${source.constructor.name})`);
}

export function getMobileCameraSource(): MobileCameraSource | null {
  return (globalThis as unknown as RegistryHost)[REGISTRY_KEY] ?? null;
}

export function clearMobileCameraSource(): void {
  delete (globalThis as unknown as RegistryHost)[REGISTRY_KEY];
}
