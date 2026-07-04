/**
 * Unit tests for the child-side screen-capture proxy service. Drives the real
 * `DesktopScreenCaptureService` against a stubbed `fetch`, verifying the bridge
 * request shape (URL, method, JSON body, bearer auth), the local active-state
 * cache, and the env-gated registration — the parts that must be correct for
 * `getService(SCREEN_CAPTURE)` to light up on desktop (#12249). The real host
 * bridge + native capture are covered by the electrobun-side test and manual
 * desktop verification.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesktopScreenCaptureService,
  registerDesktopScreenCaptureService,
  resolveScreenCaptureBridgeConfig,
} from "./desktop-screencapture-service.js";

const URL_KEY = "ELIZA_DESKTOP_SCREENCAPTURE_URL";
const TOKEN_KEY = "ELIZA_DESKTOP_SCREENCAPTURE_TOKEN";

function cleanEnv(): void {
  delete process.env[URL_KEY];
  delete process.env[TOKEN_KEY];
}

beforeEach(cleanEnv);
afterEach(() => {
  cleanEnv();
  vi.restoreAllMocks();
});

describe("resolveScreenCaptureBridgeConfig", () => {
  it("returns null when the bridge URL is unset or blank", () => {
    expect(resolveScreenCaptureBridgeConfig({})).toBeNull();
    expect(resolveScreenCaptureBridgeConfig({ [URL_KEY]: "   " })).toBeNull();
  });

  it("strips a trailing slash and reads the optional token", () => {
    expect(
      resolveScreenCaptureBridgeConfig({
        [URL_KEY]: "http://127.0.0.1:31342/",
        [TOKEN_KEY]: "secret",
      }),
    ).toEqual({ baseUrl: "http://127.0.0.1:31342", token: "secret" });
  });

  it("leaves the token undefined when only the URL is set", () => {
    expect(
      resolveScreenCaptureBridgeConfig({ [URL_KEY]: "http://127.0.0.1:31342" }),
    ).toEqual({ baseUrl: "http://127.0.0.1:31342", token: undefined });
  });
});

function makeService(): DesktopScreenCaptureService {
  return new DesktopScreenCaptureService(undefined, {
    baseUrl: "http://127.0.0.1:31342",
    token: "secret",
  });
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("DesktopScreenCaptureService.startFrameCapture", () => {
  it("POSTs options with bearer auth and marks capture active", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ available: true }));
    const service = makeService();

    expect(service.isFrameCaptureActive()).toBe(false);
    await service.startFrameCapture({
      fps: 15,
      quality: 70,
      endpoint: "/api/stream/frame",
    });

    expect(service.isFrameCaptureActive()).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:31342/frame-capture/start");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer secret",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      fps: 15,
      quality: 70,
      endpoint: "/api/stream/frame",
    });
  });

  it("throws and stays inactive when the host declines", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ available: false, reason: "permission denied" }),
    );
    const service = makeService();

    await expect(service.startFrameCapture({})).rejects.toThrow(
      /permission denied/,
    );
    expect(service.isFrameCaptureActive()).toBe(false);
  });

  it("throws on a non-2xx bridge response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "boom" }, false),
    );
    await expect(makeService().startFrameCapture({})).rejects.toThrow(
      /failed \(500\)/,
    );
  });
});

describe("DesktopScreenCaptureService.stopFrameCapture", () => {
  it("clears active immediately and fires a stop request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ available: true }));
    const service = makeService();
    await service.startFrameCapture({});
    expect(service.isFrameCaptureActive()).toBe(true);

    service.stopFrameCapture();
    expect(service.isFrameCaptureActive()).toBe(false);
    // Flush the fire-and-forget stop request.
    await Promise.resolve();
    expect((fetchMock.mock.calls.at(-1) as [string, RequestInit])[0]).toBe(
      "http://127.0.0.1:31342/frame-capture/stop",
    );
  });
});

describe("DesktopScreenCaptureService.start", () => {
  it("throws when no bridge is configured", async () => {
    await expect(
      DesktopScreenCaptureService.start({} as IAgentRuntime),
    ).rejects.toThrow(/no bridge configured/);
  });

  it("builds a service from env", async () => {
    process.env[URL_KEY] = "http://127.0.0.1:31342";
    const service = await DesktopScreenCaptureService.start(
      {} as IAgentRuntime,
    );
    expect(service).toBeInstanceOf(DesktopScreenCaptureService);
  });
});

describe("registerDesktopScreenCaptureService", () => {
  function fakeRuntime(existing: unknown = null) {
    return {
      getService: vi.fn().mockReturnValue(existing),
      registerService: vi.fn().mockResolvedValue(undefined),
    } as unknown as IAgentRuntime & {
      getService: ReturnType<typeof vi.fn>;
      registerService: ReturnType<typeof vi.fn>;
    };
  }

  it("is a no-op when the bridge env is absent", async () => {
    const runtime = fakeRuntime();
    expect(await registerDesktopScreenCaptureService(runtime, {})).toBe(false);
    expect(runtime.registerService).not.toHaveBeenCalled();
  });

  it("registers the service when the bridge env is present", async () => {
    const runtime = fakeRuntime();
    const registered = await registerDesktopScreenCaptureService(runtime, {
      [URL_KEY]: "http://127.0.0.1:31342",
    });
    expect(registered).toBe(true);
    expect(runtime.registerService).toHaveBeenCalledWith(
      DesktopScreenCaptureService,
    );
  });

  it("does not re-register when the service already exists", async () => {
    const runtime = fakeRuntime({ isFrameCaptureActive: () => false });
    expect(
      await registerDesktopScreenCaptureService(runtime, {
        [URL_KEY]: "http://127.0.0.1:31342",
      }),
    ).toBe(true);
    expect(runtime.registerService).not.toHaveBeenCalled();
  });
});
