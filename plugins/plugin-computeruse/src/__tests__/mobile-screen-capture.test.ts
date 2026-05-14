/**
 * WS8 — MobileScreenCaptureSource tests.
 *
 * Exercises the adapter that drains `bridge.captureFrame()` (JPEG base64
 * envelope) into the WS5-shape `DisplayCapture` the WS7 cascade expects.
 *
 * Pure-JS — the Kotlin `ScreenCaptureService` is not exercised here.
 */

import { describe, expect, it } from "vitest";
import {
  ANDROID_LOGICAL_DISPLAY_ID,
  MobileScreenCaptureSource,
} from "../mobile/mobile-screen-capture.js";
import type {
  AndroidComputerUseBridge,
  CapturedScreenFrame,
} from "../mobile/android-bridge.js";

function fakeFrame(overrides: Partial<CapturedScreenFrame> = {}): CapturedScreenFrame {
  return {
    jpegBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xaa, 0xbb]).toString("base64"),
    width: 1080,
    height: 1920,
    timestampMs: 1700000000000,
    ...overrides,
  };
}

function fakeBridge(
  frame: CapturedScreenFrame | { ok: false; code: "capture_unavailable"; message: string },
): AndroidComputerUseBridge {
  const stub = <T,>(): Promise<{ ok: false; code: "internal_error"; message: string } & { data?: T }> =>
    Promise.resolve({ ok: false as const, code: "internal_error" as const, message: "stub" });
  return {
    startMediaProjection: () => stub(),
    stopMediaProjection: () => stub(),
    captureFrame: async () => {
      if ("ok" in frame) return frame;
      return { ok: true, data: frame };
    },
    getAccessibilityTree: () => stub(),
    dispatchGesture: () => stub(),
    performGlobalAction: () => stub(),
    enumerateApps: () => stub(),
    getMemoryPressureSnapshot: () => stub(),
    dispatchMemoryPressure: () => stub(),
    startCamera: () => stub(),
    stopCamera: () => Promise.resolve({ ok: true, data: { ok: true } }),
    captureFrameCamera: () => stub(),
  } as AndroidComputerUseBridge;
}

describe("MobileScreenCaptureSource — happy path", () => {
  it("captureDisplay returns DisplayCapture with decoded JPEG bytes", async () => {
    const frame = fakeFrame();
    const src = new MobileScreenCaptureSource({ getBridge: () => fakeBridge(frame) });
    const cap = await src.captureDisplay();
    expect(cap.display.id).toBe(ANDROID_LOGICAL_DISPLAY_ID);
    expect(cap.display.bounds).toEqual([0, 0, 1080, 1920]);
    expect(cap.display.primary).toBe(true);
    // Frame is base64-decoded JPEG bytes — first 4 bytes are JPEG SOI + APP0.
    expect(cap.frame.subarray(0, 4)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  });

  it("captureAllDisplays returns a single-element array", async () => {
    const src = new MobileScreenCaptureSource({ getBridge: () => fakeBridge(fakeFrame()) });
    const caps = await src.captureAllDisplays();
    expect(caps).toHaveLength(1);
    expect(caps[0]?.display.id).toBe(ANDROID_LOGICAL_DISPLAY_ID);
  });

  it("getDisplay override is honored", async () => {
    const customDisplay = {
      id: 0,
      bounds: [0, 0, 2000, 3000] as [number, number, number, number],
      scaleFactor: 2,
      primary: true,
      name: "custom",
    };
    const src = new MobileScreenCaptureSource({
      getBridge: () => fakeBridge(fakeFrame()),
      getDisplay: () => customDisplay,
    });
    const cap = await src.captureDisplay();
    expect(cap.display).toBe(customDisplay);
  });

  it("decodeJpeg override is honored", async () => {
    const tag = Buffer.from("decoded-by-stub");
    const src = new MobileScreenCaptureSource({
      getBridge: () => fakeBridge(fakeFrame()),
      decodeJpeg: () => tag,
    });
    const cap = await src.captureDisplay();
    expect(cap.frame).toBe(tag);
  });
});

describe("MobileScreenCaptureSource — error paths", () => {
  it("rejects when no bridge is registered (off-platform)", async () => {
    const src = new MobileScreenCaptureSource({ getBridge: () => null });
    await expect(src.captureDisplay()).rejects.toThrow(/bridge is not registered/);
  });

  it("rejects on unknown displayId", async () => {
    const src = new MobileScreenCaptureSource({ getBridge: () => fakeBridge(fakeFrame()) });
    await expect(src.captureDisplay(99)).rejects.toThrow(/unknown Android displayId/);
  });

  it("propagates bridge ok:false as a thrown Error", async () => {
    const src = new MobileScreenCaptureSource({
      getBridge: () =>
        fakeBridge({
          ok: false,
          code: "capture_unavailable",
          message: "no frame yet",
        }),
    });
    await expect(src.captureDisplay()).rejects.toThrow(/capture_unavailable/);
  });
});
