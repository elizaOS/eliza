/**
 * Integration test for the host-side screen-capture bridge. Starts the real
 * loopback HTTP server with the native `ScreenCaptureManager` mocked out (so no
 * electrobun/OS capture is touched) and drives it over the wire, asserting the
 * token auth gate and the route → manager-method mapping the child service
 * depends on (#12249).
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const manager = {
  startFrameCapture: vi.fn(async () => ({ available: true as const })),
  stopFrameCapture: vi.fn(async () => ({ available: true as const })),
  isFrameCaptureActive: vi.fn(async () => ({ active: false })),
};

vi.mock("./native/screencapture", () => ({
  getScreenCaptureManager: () => manager,
}));

const { startScreenCaptureBridgeServer } = await import(
  "./screencapture-bridge-server.js"
);

let stop: (() => void) | undefined;
let baseUrl = "";
let token = "";

// One server for the suite: restarting on the same loopback port per test makes
// undici reuse a stale keep-alive socket and ECONNRESET the next request.
beforeAll(async () => {
  delete process.env.ELIZA_DESKTOP_SCREENCAPTURE_URL;
  delete process.env.ELIZA_DESKTOP_SCREENCAPTURE_TOKEN;
  stop = await startScreenCaptureBridgeServer();
  baseUrl = process.env.ELIZA_DESKTOP_SCREENCAPTURE_URL ?? "";
  token = process.env.ELIZA_DESKTOP_SCREENCAPTURE_TOKEN ?? "";
});

afterAll(() => {
  stop?.();
  stop = undefined;
  delete process.env.ELIZA_DESKTOP_SCREENCAPTURE_URL;
  delete process.env.ELIZA_DESKTOP_SCREENCAPTURE_TOKEN;
});

beforeEach(() => {
  manager.startFrameCapture.mockClear();
  manager.stopFrameCapture.mockClear();
  manager.isFrameCaptureActive.mockClear();
});

function authed(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
}

describe("startScreenCaptureBridgeServer", () => {
  it("publishes a loopback URL and a token to the child env", () => {
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(token).toHaveLength(36);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(401);
  });

  it("answers health when authorized", async () => {
    const res = await authed("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("maps POST /frame-capture/start to the native manager", async () => {
    const res = await authed("/frame-capture/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fps: 15,
        quality: 70,
        endpoint: "/api/stream/frame",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true });
    expect(manager.startFrameCapture).toHaveBeenCalledWith({
      fps: 15,
      quality: 70,
      endpoint: "/api/stream/frame",
      gameUrl: undefined,
    });
  });

  it("maps POST /frame-capture/stop and GET /frame-capture/active", async () => {
    expect(
      (await authed("/frame-capture/stop", { method: "POST" })).status,
    ).toBe(200);
    expect(manager.stopFrameCapture).toHaveBeenCalledOnce();

    const active = await authed("/frame-capture/active");
    expect(await active.json()).toEqual({ active: false });
    expect(manager.isFrameCaptureActive).toHaveBeenCalledOnce();
  });

  it("404s an unknown path", async () => {
    expect((await authed("/nope")).status).toBe(404);
  });
});
