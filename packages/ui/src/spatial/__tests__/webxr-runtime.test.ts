// @vitest-environment jsdom
//
// Availability / capability contract for the WebXR runtime packaging seam.
// The immersive XRWebGLLayer render loop is validated separately in a real
// browser against the IWER emulator (it needs WebGL + a live XR session).

import { afterEach, describe, expect, it, vi } from "vitest";
import { detectWebXRCapability, ensureWebXR } from "../webxr-runtime.ts";

type SupportMap = Partial<Record<XRSessionMode, boolean>>;

function fakeXR(support: SupportMap): XRSystem {
  return {
    isSessionSupported: vi.fn(
      async (mode: XRSessionMode) => support[mode] ?? false,
    ),
  } as unknown as XRSystem;
}

function setNavigatorXR(xr: XRSystem | undefined): void {
  Object.defineProperty(globalThis.navigator, "xr", {
    value: xr,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  setNavigatorXR(undefined);
  vi.restoreAllMocks();
});

describe("WebXR runtime — availability", () => {
  it("reports a native runtime and its supported modes without installing a polyfill", async () => {
    setNavigatorXR(
      fakeXR({ "immersive-vr": true, inline: true, "immersive-ar": false }),
    );
    const cap = await ensureWebXR();
    expect(cap).toMatchObject({
      present: true,
      native: true,
      polyfilled: false,
      immersiveVR: true,
      immersiveAR: false,
      inline: true,
    });
  });

  it("detectWebXRCapability reports absent when navigator.xr is missing", async () => {
    setNavigatorXR(undefined);
    const cap = await detectWebXRCapability();
    expect(cap.present).toBe(false);
    expect(cap.immersiveVR).toBe(false);
  });

  it("maps isSessionSupported per mode (AR-only headset)", async () => {
    setNavigatorXR(fakeXR({ "immersive-ar": true, inline: true }));
    const cap = await detectWebXRCapability();
    expect(cap).toMatchObject({
      immersiveVR: false,
      immersiveAR: true,
      inline: true,
    });
  });

  it("survives an isSessionSupported that throws (treats the mode as unsupported)", async () => {
    const xr = {
      isSessionSupported: vi.fn(async (mode: XRSessionMode) => {
        if (mode === "immersive-vr") throw new Error("not allowed");
        return mode === "inline";
      }),
    } as unknown as XRSystem;
    setNavigatorXR(xr);
    const cap = await detectWebXRCapability();
    expect(cap.present).toBe(true);
    expect(cap.immersiveVR).toBe(false);
    expect(cap.inline).toBe(true);
  });
});
