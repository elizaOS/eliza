/**
 * Pure correlation tests for the renderer-pulled screen-capture bridge.
 *
 * These cover the request, queue, and submit handshake without a device or
 * Capacitor host.
 */

import type { IAgentRuntime, RouteHandlerContext } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { screenFrameRoute } from "./routes.js";
import {
  ScreenCaptureBridgeService,
  type ScreenCaptureFrame,
} from "./screen-capture-bridge.js";

function makeBridge(timeoutMs = 30_000): ScreenCaptureBridgeService {
  // The base Service constructor only stashes runtime; undefined is fine for
  // these pure tests, which never touch it.
  return new ScreenCaptureBridgeService(undefined, timeoutMs);
}

/** base64 of the bytes [1, 2, 3, 4]. */
const SAMPLE_BASE64 = Buffer.from([1, 2, 3, 4]).toString("base64");

async function submitFrameRoute(
  bridge: ScreenCaptureBridgeService,
  body: unknown,
) {
  const routeHandler = screenFrameRoute.routeHandler;
  if (!routeHandler) throw new Error("screen frame route handler is missing");
  return routeHandler({
    body,
    params: {},
    query: {},
    headers: {},
    method: "POST",
    path: "/api/vision/screen-frame",
    runtime: {
      getService: () => bridge,
    } as unknown as IAgentRuntime,
    inProcess: false,
  } satisfies RouteHandlerContext);
}

describe("ScreenCaptureBridgeService", () => {
  it("enqueues a request via requestFrame and drains it via takeRequests", () => {
    const bridge = makeBridge();
    void bridge.requestFrame();

    const drained = bridge.takeRequests();
    expect(drained).toHaveLength(1);
    expect(typeof drained[0].requestId).toBe("string");
    expect(drained[0].requestId.length).toBeGreaterThan(0);
    expect(typeof drained[0].createdAt).toBe("number");

    // Second drain is empty — the queue was consumed.
    expect(bridge.takeRequests()).toHaveLength(0);
  });

  it("propagates displayId onto the queued request", () => {
    const bridge = makeBridge();
    void bridge.requestFrame(2);
    const [request] = bridge.takeRequests();
    expect(request.displayId).toBe(2);
  });

  it("submitFrame resolves the matching pending promise with decoded bytes", async () => {
    const bridge = makeBridge();
    const framePromise = bridge.requestFrame(3);
    const [request] = bridge.takeRequests();

    const accepted = bridge.submitFrame(
      request.requestId,
      SAMPLE_BASE64,
      "png",
      10,
      20,
    );
    expect(accepted).toBe(true);

    const frame = (await framePromise) as ScreenCaptureFrame;
    expect(frame).not.toBeNull();
    expect(Array.from(frame.imageBytes)).toEqual([1, 2, 3, 4]);
    expect(frame.format).toBe("png");
    expect(frame.width).toBe(10);
    expect(frame.height).toBe(20);
    expect(frame.displayId).toBe(3);
    expect(typeof frame.capturedAt).toBe("number");
  });

  it("accepts an old frame without capturedAt at the new vision route", async () => {
    const bridge = makeBridge();
    const framePromise = bridge.requestFrame();
    const [request] = bridge.takeRequests();
    const beforeSubmit = Date.now();

    const result = await submitFrameRoute(bridge, {
      requestId: request.requestId,
      base64: SAMPLE_BASE64,
      format: "jpeg",
      width: 10,
      height: 20,
    });

    expect(result.status).toBe(200);
    const frame = (await framePromise) as ScreenCaptureFrame;
    expect(frame.capturedAt).toBeGreaterThanOrEqual(beforeSubmit);
    expect(frame.format).toBe("jpeg");
  });

  it.each([
    { format: "webp", width: 10, height: 20 },
    { format: "jpeg", width: 0, height: 20 },
    { format: "png", width: 10.5, height: 20 },
    { format: "png", width: 10, height: Number.POSITIVE_INFINITY },
  ])("rejects invalid frame format or dimensions: %j", async (invalid) => {
    const bridge = makeBridge();
    void bridge.requestFrame();
    const [request] = bridge.takeRequests();

    const result = await submitFrameRoute(bridge, {
      requestId: request.requestId,
      base64: SAMPLE_BASE64,
      ...invalid,
    });

    expect(result.status).toBe(400);
    await bridge.stop();
  });

  it("submitFrame returns false for an unknown requestId", () => {
    const bridge = makeBridge();
    expect(
      bridge.submitFrame("does-not-exist", SAMPLE_BASE64, "png", 1, 1),
    ).toBe(false);
  });

  it("submitFrame returns false the second time (request already consumed)", async () => {
    const bridge = makeBridge();
    const framePromise = bridge.requestFrame();
    const [request] = bridge.takeRequests();

    expect(
      bridge.submitFrame(request.requestId, SAMPLE_BASE64, "png", 1, 1),
    ).toBe(true);
    await framePromise;
    expect(
      bridge.submitFrame(request.requestId, SAMPLE_BASE64, "png", 1, 1),
    ).toBe(false);
  });

  it("resolves null when the request times out before a frame arrives", async () => {
    const bridge = makeBridge(5);
    const frame = await bridge.requestFrame();
    expect(frame).toBeNull();
    // A timed-out request can no longer be fulfilled.
    expect(bridge.submitFrame("any", SAMPLE_BASE64, "png", 1, 1)).toBe(false);
  });

  it("failFrame resolves the pending promise as null", async () => {
    const bridge = makeBridge();
    const framePromise = bridge.requestFrame();
    const [request] = bridge.takeRequests();

    expect(bridge.failFrame(request.requestId, "capture_error")).toBe(true);
    expect(await framePromise).toBeNull();
    // Unknown after it has been failed.
    expect(bridge.failFrame(request.requestId, "again")).toBe(false);
  });

  it("accepts a legacy failure and rejects malformed failure payloads", async () => {
    const bridge = makeBridge();
    const framePromise = bridge.requestFrame();
    const [request] = bridge.takeRequests();

    const accepted = await submitFrameRoute(bridge, {
      requestId: request.requestId,
      error: "capture_error",
    });
    expect(accepted.status).toBe(200);
    expect(await framePromise).toBeNull();

    const malformed = await submitFrameRoute(bridge, {
      requestId: "another-request",
      error: { message: "not a wire string" },
    });
    expect(malformed.status).toBe(400);
  });

  it("stop() clears the queue and resolves all pending promises as null", async () => {
    const bridge = makeBridge();
    const first = bridge.requestFrame();
    const second = bridge.requestFrame();
    // Leave one request still queued (not drained) as well.
    void bridge.requestFrame();

    await bridge.stop();

    expect(await first).toBeNull();
    expect(await second).toBeNull();
    // Queue was cleared by stop().
    expect(bridge.takeRequests()).toHaveLength(0);
  });
});
