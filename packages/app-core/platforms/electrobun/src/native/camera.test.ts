/** Exercises camera behavior with deterministic app-core test fixtures. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraManager, getCameraManager } from "./camera";

const nativePermissions = vi.hoisted(() => ({
  checkPermission: vi.fn(),
  requestPermission: vi.fn(),
}));

vi.mock("./permissions", () => ({
  getPermissionManager: () => ({
    checkPermission: nativePermissions.checkPermission,
    requestPermission: nativePermissions.requestPermission,
  }),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

describe("CameraManager renderer-owned camera stubs", () => {
  it("reports an empty device list and stays available", async () => {
    await expect(new CameraManager().getDevices()).resolves.toEqual({
      devices: [],
      available: true,
    });
  });

  it("ignores preview device options and reports available", async () => {
    const manager = new CameraManager();

    await expect(manager.startPreview()).resolves.toEqual({ available: true });
    await expect(manager.startPreview({})).resolves.toEqual({
      available: true,
    });
    await expect(manager.startPreview({ deviceId: "front" })).resolves.toEqual({
      available: true,
    });
  });

  it("resolves stopPreview without a payload", async () => {
    await expect(new CameraManager().stopPreview()).resolves.toBeUndefined();
  });

  it("ignores switchCamera deviceId and reports available", async () => {
    await expect(
      new CameraManager().switchCamera({ deviceId: "rear" }),
    ).resolves.toEqual({ available: true });
  });

  it("reports capture, startRecording, and stopRecording as available", async () => {
    const manager = new CameraManager();

    await expect(manager.capturePhoto()).resolves.toEqual({ available: true });
    await expect(manager.startRecording()).resolves.toEqual({
      available: true,
    });
    await expect(manager.stopRecording()).resolves.toEqual({
      available: true,
    });
  });

  it("stays idle after startRecording because native recording is not tracked", async () => {
    const manager = new CameraManager();

    await manager.startRecording();
    await expect(manager.getRecordingState()).resolves.toEqual({
      recording: false,
      duration: 0,
    });

    await manager.stopRecording();
    await expect(manager.getRecordingState()).resolves.toEqual({
      recording: false,
      duration: 0,
    });
  });

  it("never invokes a registered webview callback from native camera operations", async () => {
    const manager = new CameraManager();
    const sendToWebview = vi.fn();
    manager.setSendToWebview(sendToWebview);

    await manager.getDevices();
    await manager.startPreview({ deviceId: "cam-1" });
    await manager.stopPreview();
    await manager.switchCamera({ deviceId: "cam-2" });
    await manager.capturePhoto();
    await manager.startRecording();
    await manager.stopRecording();
    await manager.getRecordingState();
    manager.dispose();

    expect(sendToWebview).not.toHaveBeenCalled();
  });
});

describe("getCameraManager", () => {
  it("returns one CameraManager instance on repeated calls", () => {
    const first = getCameraManager();
    const second = getCameraManager();

    expect(first).toBeInstanceOf(CameraManager);
    expect(second).toBe(first);
  });

  it("does not alias a directly constructed manager onto the singleton", async () => {
    const constructed = new CameraManager();
    const singleton = getCameraManager();

    expect(constructed).not.toBe(singleton);
    await expect(constructed.getDevices()).resolves.toEqual({
      devices: [],
      available: true,
    });
    await expect(singleton.getDevices()).resolves.toEqual({
      devices: [],
      available: true,
    });
  });
});

describe("CameraManager permission-status mapping", () => {
  beforeEach(() => {
    nativePermissions.checkPermission.mockReset();
    nativePermissions.requestPermission.mockReset();
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it.each(["linux", "win32"] as const)(
    "returns prompt on %s without consulting native permissions",
    async (platform) => {
      stubPlatform(platform);
      const manager = new CameraManager();

      await expect(manager.checkPermissions()).resolves.toEqual({
        status: "prompt",
      });
      await expect(manager.requestPermissions()).resolves.toEqual({
        status: "prompt",
      });
      expect(nativePermissions.checkPermission).not.toHaveBeenCalled();
      expect(nativePermissions.requestPermission).not.toHaveBeenCalled();
    },
  );

  it("on darwin maps only status from the native camera permission check", async () => {
    stubPlatform("darwin");
    nativePermissions.checkPermission.mockResolvedValue({
      id: "camera",
      status: "denied",
      canRequest: true,
      platform: "darwin",
      extra: "must-not-leak",
    });

    const result = await new CameraManager().checkPermissions();

    expect(result).toEqual({ status: "denied" });
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("extra");
    expect(nativePermissions.checkPermission).toHaveBeenCalledWith("camera");
    expect(nativePermissions.requestPermission).not.toHaveBeenCalled();
  });

  it("on darwin maps only status from the native camera permission request", async () => {
    stubPlatform("darwin");
    nativePermissions.requestPermission.mockResolvedValue({
      id: "camera",
      status: "granted",
      canRequest: false,
      platform: "darwin",
    });

    await expect(new CameraManager().requestPermissions()).resolves.toEqual({
      status: "granted",
    });
    expect(nativePermissions.requestPermission).toHaveBeenCalledWith("camera");
    expect(nativePermissions.checkPermission).not.toHaveBeenCalled();
  });

  it("propagates native permission check failures", async () => {
    stubPlatform("darwin");
    nativePermissions.checkPermission.mockRejectedValue(
      new Error("camera probe failed"),
    );

    await expect(new CameraManager().checkPermissions()).rejects.toThrow(
      "camera probe failed",
    );
  });

  it("propagates native permission request failures", async () => {
    stubPlatform("darwin");
    nativePermissions.requestPermission.mockRejectedValue(
      new Error("camera request failed"),
    );

    await expect(new CameraManager().requestPermissions()).rejects.toThrow(
      "camera request failed",
    );
  });
});
