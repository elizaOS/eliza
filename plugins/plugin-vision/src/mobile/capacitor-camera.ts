/**
 * JavaScript contract and Capacitor adapter for native mobile camera sources.
 *
 * Android CameraX and iOS AVFoundation bridges expose matching methods through
 * `Capacitor.Plugins.ElizaVision`. Runtime camera consumers go through
 * `MobileCameraSource` instead of shelling out to desktop capture tools.
 */

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
 *   - plugin-capacitor-bridge (cross-platform Capacitor plugin) — planned bridge package
 */
export interface MobileCameraSource {
  /** Discover cameras visible to the OS. */
  listCameras(): Promise<CameraInfo[]>;
  /** Open a session when the native source supports continuous capture. */
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

interface CapacitorVisionPlugin {
  listCameras?: () => Promise<CameraInfo[]>;
  open?: (opts?: MobileCameraOpenOptions) => Promise<void>;
  captureJpeg?: () => Promise<Buffer | Uint8Array | string | { data?: string }>;
  captureRgbaFrame?: () => Promise<VisionFrame | { data: string }>;
  close?: () => Promise<void>;
  capabilities?: () => Promise<{
    supportsContinuousFrames: boolean;
    supportsExposureLock: boolean;
    supportsTorch: boolean;
  }>;
}

interface CapacitorHost {
  Capacitor?: {
    Plugins?: {
      ElizaVision?: CapacitorVisionPlugin;
    };
  };
}

function bufferFromNative(
  value: Buffer | Uint8Array | string | { data?: string },
): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "base64");
  if (typeof value.data === "string") return Buffer.from(value.data, "base64");
  throw new Error(
    "Native camera bridge returned image data in an unsupported shape",
  );
}

export class CapacitorCameraSource implements MobileCameraSource {
  constructor(private readonly plugin: CapacitorVisionPlugin) {}

  async listCameras(): Promise<CameraInfo[]> {
    return this.plugin.listCameras?.() ?? [];
  }

  async open(opts?: MobileCameraOpenOptions): Promise<void> {
    if (!this.plugin.open) {
      throw new Error("Native camera bridge does not expose open()");
    }
    await this.plugin.open(opts);
  }

  async captureJpeg(): Promise<Buffer> {
    if (!this.plugin.captureJpeg) {
      throw new Error("Native camera bridge does not expose captureJpeg()");
    }
    return bufferFromNative(await this.plugin.captureJpeg());
  }

  async captureRgbaFrame(): Promise<VisionFrame> {
    if (!this.plugin.captureRgbaFrame) {
      throw new Error(
        "Native camera bridge does not expose captureRgbaFrame()",
      );
    }
    const frame = await this.plugin.captureRgbaFrame();
    return {
      ...frame,
      data: bufferFromNative(frame.data),
    } as VisionFrame;
  }

  async close(): Promise<void> {
    await this.plugin.close?.();
  }

  capabilities(): {
    supportsContinuousFrames: boolean;
    supportsExposureLock: boolean;
    supportsTorch: boolean;
  } {
    return {
      supportsContinuousFrames: Boolean(this.plugin.captureRgbaFrame),
      supportsExposureLock: false,
      supportsTorch: false,
    };
  }
}

/**
 * Default unavailable implementation. Returns no cameras and refuses captures.
 * This keeps the plugin-vision JS surface buildable on Node platforms where no
 * native bridge is registered.
 */
export class UnavailableMobileCameraSource implements MobileCameraSource {
  async listCameras(): Promise<CameraInfo[]> {
    logger.debug(
      "[UnavailableMobileCameraSource] listCameras() — no native bridge registered",
    );
    return [];
  }
  async open(): Promise<void> {
    throw new Error("Mobile camera bridge unavailable");
  }
  async captureJpeg(): Promise<Buffer> {
    throw new Error("Mobile camera bridge unavailable");
  }
  async close(): Promise<void> {}
}

/** Compatibility alias for older imports. */
export const CapacitorCameraStub = UnavailableMobileCameraSource;

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
  const candidate = source as Partial<MobileCameraSource>;
  for (const method of [
    "listCameras",
    "open",
    "captureJpeg",
    "close",
  ] as const) {
    if (typeof candidate[method] !== "function") {
      throw new TypeError(`Invalid MobileCameraSource: missing ${method}()`);
    }
  }
  if (
    candidate.capabilities !== undefined &&
    typeof candidate.capabilities !== "function"
  ) {
    throw new TypeError(
      "Invalid MobileCameraSource: capabilities must be a function when present",
    );
  }
  (globalThis as RegistryHost)[REGISTRY_KEY] = source;
  logger.info(
    `[MobileCameraSource] registered (${source.constructor?.name ?? "anonymous"})`,
  );
}

export function getMobileCameraSource(): MobileCameraSource | null {
  const registered = (globalThis as RegistryHost)[REGISTRY_KEY];
  if (registered) return registered;

  const plugin = (globalThis as CapacitorHost).Capacitor?.Plugins?.ElizaVision;
  return plugin ? new CapacitorCameraSource(plugin) : null;
}

export function clearMobileCameraSource(): void {
  delete (globalThis as RegistryHost)[REGISTRY_KEY];
}
