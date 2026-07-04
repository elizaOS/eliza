import { ServiceType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetDesktopScreenCaptureBridgeServiceConfig,
  DesktopScreenCaptureBridgeService,
  registerDesktopScreenCaptureBridgeService,
  resolveDesktopScreenCaptureBridgeConfig,
} from "./desktop-screen-capture-bridge-service.ts";

afterEach(() => {
  _resetDesktopScreenCaptureBridgeServiceConfig();
});

describe("desktop screen capture bridge service", () => {
  it("resolves only authenticated loopback bridge config", () => {
    expect(resolveDesktopScreenCaptureBridgeConfig({})).toBeNull();
    expect(
      resolveDesktopScreenCaptureBridgeConfig({
        ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_URL: "https://example.com",
        ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_TOKEN: "token",
      }),
    ).toBeNull();
    expect(
      resolveDesktopScreenCaptureBridgeConfig({
        ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_URL: "http://127.0.0.1:31342/",
        ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_TOKEN: "token",
        ELIZA_API_PORT: "4567",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:31342",
      token: "token",
      apiBase: "http://127.0.0.1:4567",
    });
  });

  it("adds the child API base when starting host frame capture", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
      });
    });
    const service = new DesktopScreenCaptureBridgeService(
      undefined,
      {
        baseUrl: "http://127.0.0.1:31342",
        token: "token",
        apiBase: "http://127.0.0.1:4567",
      },
      fetchImpl as unknown as typeof fetch,
    );

    await service.startFrameCapture({
      fps: 15,
      quality: 70,
      endpoint: "/api/stream/frame",
    });

    expect(service.isFrameCaptureActive()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:31342/frame-capture/start",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          fps: 15,
          quality: 70,
          endpoint: "/api/stream/frame",
          apiBase: "http://127.0.0.1:4567",
        }),
      }),
    );
  });

  it("registers and force-starts the runtime service when configured", async () => {
    const calls: string[] = [];
    const runtime = {
      getService: vi.fn(() => null),
      registerService: vi.fn(async (serviceClass) => {
        calls.push(serviceClass.serviceType);
      }),
      getServiceLoadPromise: vi.fn(async (serviceType) => {
        calls.push(`load:${serviceType}`);
        return {} as never;
      }),
    };

    await expect(
      registerDesktopScreenCaptureBridgeService(runtime, {
        ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_URL: "http://127.0.0.1:31342",
        ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_TOKEN: "token",
        ELIZA_API_PORT: "4567",
      }),
    ).resolves.toBe(true);

    expect(runtime.registerService).toHaveBeenCalledWith(
      DesktopScreenCaptureBridgeService,
    );
    expect(runtime.getServiceLoadPromise).toHaveBeenCalledWith(
      ServiceType.SCREEN_CAPTURE,
    );
    expect(calls).toEqual(["screen_capture", "load:screen_capture"]);
  });
});
