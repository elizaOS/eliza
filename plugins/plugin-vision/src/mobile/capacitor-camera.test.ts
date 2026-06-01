import { describe, expect, it } from "vitest";
import type { MobileCameraSource } from "./capacitor-camera";
import {
  CapacitorCameraStub,
  clearMobileCameraSource,
  getMobileCameraSource,
  registerMobileCameraSource,
} from "./capacitor-camera";

describe("MobileCameraSource registry", () => {
  it("returns null when no source is registered", () => {
    clearMobileCameraSource();
    expect(getMobileCameraSource()).toBeNull();
  });

  it("retains the most recent registration", () => {
    clearMobileCameraSource();
    const first = new CapacitorCameraStub();
    const second: MobileCameraSource = {
      listCameras: async () => [
        { id: "back", name: "Back camera", connected: true },
      ],
      open: async () => {},
      captureJpeg: async () => Buffer.alloc(0),
      close: async () => {},
    };
    registerMobileCameraSource(first);
    expect(getMobileCameraSource()).toBe(first);
    registerMobileCameraSource(second);
    expect(getMobileCameraSource()).toBe(second);
    clearMobileCameraSource();
  });

  it("rejects malformed native bridge registrations", () => {
    clearMobileCameraSource();
    expect(() =>
      registerMobileCameraSource({
        listCameras: async () => [],
        open: async () => {},
        close: async () => {},
      } as unknown as MobileCameraSource),
    ).toThrow(/captureJpeg/);
    expect(getMobileCameraSource()).toBeNull();
  });

  it("rejects invalid capability declarations from native bridges", () => {
    clearMobileCameraSource();
    expect(() =>
      registerMobileCameraSource({
        listCameras: async () => [],
        open: async () => {},
        captureJpeg: async () => Buffer.alloc(1),
        close: async () => {},
        capabilities: {
          supportsContinuousFrames: true,
          supportsExposureLock: false,
          supportsTorch: false,
        },
      } as unknown as MobileCameraSource),
    ).toThrow(/capabilities/);
    expect(getMobileCameraSource()).toBeNull();
  });

  it("stub refuses captures cleanly", async () => {
    const stub = new CapacitorCameraStub();
    await expect(stub.listCameras()).resolves.toEqual([]);
    await expect(stub.open()).rejects.toBeInstanceOf(Error);
    await expect(stub.captureJpeg()).rejects.toBeInstanceOf(Error);
    await expect(stub.close()).resolves.toBeUndefined();
  });
});
