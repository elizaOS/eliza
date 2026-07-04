import { afterEach, describe, expect, it } from "vitest";
import { startScreenCaptureBridgeServer } from "./screen-capture-bridge-server";

const cleanupFns: Array<() => void> = [];

afterEach(() => {
  while (cleanupFns.length > 0) {
    cleanupFns.pop()?.();
  }
});

describe("screen capture bridge server", () => {
  it("requires a bearer token and proxies frame-capture calls", async () => {
    const calls: unknown[] = [];
    let active = false;
    const env: Record<string, string | undefined> = {
      ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_PORT: "31342",
      ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_TOKEN: "test-token",
    };
    const stop = await startScreenCaptureBridgeServer({
      env,
      manager: {
        isFrameCaptureActive: () => ({ active }),
        startFrameCapture: (options) => {
          calls.push(options);
          active = true;
          return { available: true };
        },
        stopFrameCapture: () => {
          active = false;
          return { available: true };
        },
      },
    });
    cleanupFns.push(stop);

    const baseUrl = env.ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_URL;
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const unauthorized = await fetch(`${baseUrl}/health`);
    expect(unauthorized.status).toBe(401);

    const headers = {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    };
    const start = await fetch(`${baseUrl}/frame-capture/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        fps: 15,
        quality: 70,
        apiBase: "http://127.0.0.1:4567",
        endpoint: "/api/stream/frame",
      }),
    });
    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({ available: true });
    expect(calls).toEqual([
      {
        fps: 15,
        quality: 70,
        apiBase: "http://127.0.0.1:4567",
        endpoint: "/api/stream/frame",
      },
    ]);

    const activeResponse = await fetch(`${baseUrl}/frame-capture`, {
      headers,
    });
    expect(await activeResponse.json()).toEqual({ active: true });

    const stopResponse = await fetch(`${baseUrl}/frame-capture/stop`, {
      method: "POST",
      headers,
    });
    expect(stopResponse.status).toBe(200);
    expect(await stopResponse.json()).toEqual({ available: true });
    expect(active).toBe(false);
  });

  it("rejects non-loopback API bases before reaching the manager", async () => {
    let called = false;
    const env: Record<string, string | undefined> = {
      ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_PORT: "31442",
      ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_TOKEN: "test-token",
    };
    const stop = await startScreenCaptureBridgeServer({
      env,
      manager: {
        isFrameCaptureActive: () => ({ active: false }),
        startFrameCapture: () => {
          called = true;
          return { available: true };
        },
        stopFrameCapture: () => ({ available: true }),
      },
    });
    cleanupFns.push(stop);

    const response = await fetch(
      `${env.ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_URL}/frame-capture/start`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          apiBase: "https://example.com",
          endpoint: "/api/stream/frame",
        }),
      },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "apiBase must be a loopback http URL",
    });
    expect(called).toBe(false);
  });
});
