/**
 * Unit tests for the child-runtime desktop screen-capture service.
 *
 * These tests stub only the loopback fetch boundary while exercising the real
 * service class that the app-core runtime registers under `screen_capture`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesktopScreenCaptureService,
  resolveDesktopScreenCaptureApiBase,
  resolveDesktopScreenCaptureBridgeConfig,
} from "./desktop-screencapture-service";

describe("desktop screen-capture service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ELIZA_API_PORT;
  });

  it("resolves bridge config only when URL and token are both present", () => {
    expect(resolveDesktopScreenCaptureBridgeConfig({})).toBeNull();
    expect(
      resolveDesktopScreenCaptureBridgeConfig({
        ELIZA_DESKTOP_SCREENCAPTURE_URL: " http://127.0.0.1:31342/ ",
      }),
    ).toBeNull();
    expect(
      resolveDesktopScreenCaptureBridgeConfig({
        ELIZA_DESKTOP_SCREENCAPTURE_URL: " http://127.0.0.1:31342/ ",
        ELIZA_DESKTOP_SCREENCAPTURE_TOKEN: " token ",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:31342",
      token: "token",
    });
  });

  it("posts authenticated start requests with the current child API base", async () => {
    process.env.ELIZA_API_PORT = "32123";
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new DesktopScreenCaptureService(undefined, {
      baseUrl: "http://127.0.0.1:31342",
      token: "bridge-token",
    });

    await service.startFrameCapture({
      fps: 15,
      quality: 70,
      endpoint: "/api/stream/frame",
    });

    expect(service.isFrameCaptureActive()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:31342/frame-capture/start");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer bridge-token");
    expect(JSON.parse(String(init.body))).toEqual({
      fps: 15,
      quality: 70,
      endpoint: "/api/stream/frame",
      apiBase: "http://127.0.0.1:32123",
    });
  });

  it("uses the desktop API base resolver default when the port env is absent", () => {
    expect(resolveDesktopScreenCaptureApiBase()).toBe("http://127.0.0.1:31337");
  });
});
