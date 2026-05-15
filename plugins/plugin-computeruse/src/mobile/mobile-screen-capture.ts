/**
 * WS8 — `MobileScreenCaptureSource` adapts the Android `captureFrame()`
 * bridge call into a WS5-shape `DisplayCapture` so the WS7 cascade can run
 * unmodified on Android. iOS uses ReplayKit and is treated separately; this
 * module focuses on Android because that's where the consumer-build cascade
 * actually runs.
 *
 * Contract:
 *   - `captureDisplay(displayId?)` returns the latest screen frame as
 *     `{ display, frame }` — the frame is the decoded JPEG byte buffer
 *     exactly as the Kotlin ImageReader pipeline emits it. The Brain encodes
 *     it as a `data:image/jpeg;base64,...` URL; downstream model adapters
 *     do not require PNG specifically, only "image".
 *   - `captureAllDisplays()` returns a single-element array since mobile
 *     devices report one logical display. Multi-display Android (DeX,
 *     foldables in two-pane mode) is out of scope for v1.
 *   - On bridge `ok:false`, the call rejects with an `Error` whose message
 *     carries the bridge's `code` and `message`. The cascade surfaces this
 *     through `safeCapture` so the agent loop reports it as
 *     `reason: "error"`.
 *
 * The capture path is intentionally pull-based — Kotlin keeps the latest
 * frame in a ring-buffer, and this module just drains it. The fps knob is
 * set when MediaProjection was started; this module doesn't manage it.
 */

import type { DisplayCapture } from "../platform/capture.js";
import type { DisplayDescriptor } from "../types.js";
import type {
  AndroidComputerUseBridge,
  CapturedScreenFrame,
} from "./android-bridge.js";

export const ANDROID_LOGICAL_DISPLAY_ID = 0 as const;

export interface MobileScreenCaptureSourceDeps {
  /** Returns the Capacitor `ComputerUse` plugin handle, or null when off-platform. */
  getBridge: () => AndroidComputerUseBridge | null;
  /**
   * Override the display descriptor — primarily for tests. In production,
   * the descriptor is derived from the captured frame's width/height (the
   * device only knows its own size).
   */
  getDisplay?: (frame: CapturedScreenFrame | null) => DisplayDescriptor;
  /**
   * Override how raw JPEG bytes are produced from the base64 payload. The
   * default uses Node's `Buffer.from(..., "base64")`; tests can inject a
   * stub when running in a browser-only context.
   */
  decodeJpeg?: (jpegBase64: string) => Buffer;
}

/**
 * Pull-based capture source for Android MediaProjection. Mirrors the public
 * surface of `captureAllDisplays` / `captureDisplay` from
 * `platform/capture.ts` so the WS7 cascade can substitute it via DI.
 */
export class MobileScreenCaptureSource {
  constructor(private readonly deps: MobileScreenCaptureSourceDeps) {}

  /**
   * Drain the latest frame for the (single) logical Android display.
   * `displayId` is honored only when it equals `ANDROID_LOGICAL_DISPLAY_ID`;
   * any other id throws — mirrors `captureDisplay`'s unknown-display
   * behavior on desktop.
   */
  async captureDisplay(
    displayId: number = ANDROID_LOGICAL_DISPLAY_ID,
  ): Promise<DisplayCapture> {
    if (displayId !== ANDROID_LOGICAL_DISPLAY_ID) {
      throw new Error(
        `[computeruse/mobile-capture] unknown Android displayId ${displayId}; only ${ANDROID_LOGICAL_DISPLAY_ID} is supported`,
      );
    }
    const bridge = this.deps.getBridge();
    if (!bridge) {
      throw new Error(
        "[computeruse/mobile-capture] Capacitor ComputerUse bridge is not registered",
      );
    }
    const result = await bridge.captureFrame();
    if (!result.ok) {
      const err = result as { ok: false; code: string; message: string };
      throw new Error(
        `[computeruse/mobile-capture] captureFrame failed: ${err.code} — ${err.message}`,
      );
    }
    const frame = result.data;
    const display = this.deps.getDisplay
      ? this.deps.getDisplay(frame)
      : deriveDisplay(frame);
    const bytes = (this.deps.decodeJpeg ?? defaultDecodeJpeg)(frame.jpegBase64);
    return { display, frame: bytes };
  }

  /** Single-element array — mobile devices have one logical display. */
  async captureAllDisplays(): Promise<DisplayCapture[]> {
    return [await this.captureDisplay()];
  }
}

function deriveDisplay(frame: CapturedScreenFrame): DisplayDescriptor {
  return {
    id: ANDROID_LOGICAL_DISPLAY_ID,
    bounds: [0, 0, frame.width, frame.height],
    scaleFactor: 1,
    primary: true,
    name: "android-screen",
  };
}

function defaultDecodeJpeg(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}
