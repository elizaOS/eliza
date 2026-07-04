/**
 * Renderer-pulled routes for Android screen capture and OCR bridge traffic.
 *
 * The renderer polls for queued capture/OCR requests, performs native
 * Capacitor work, then posts results back to exact raw paths because the Android
 * JNI loopback forwards literal `/api/...` paths.
 */

import type { Route } from "@elizaos/core";
import {
  OCR_BRIDGE_SERVICE_TYPE,
  type OcrBridgeService,
  type OcrBridgeWord,
} from "./ocr-bridge";
import {
  SCREEN_CAPTURE_BRIDGE_SERVICE_TYPE,
  type ScreenCaptureBridgeService,
} from "./screen-capture-bridge";

interface ScreenFrameBody {
  requestId: string;
  base64: string;
  format: string;
  width: number;
  height: number;
}

function isScreenFrameBody(value: unknown): value is ScreenFrameBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.requestId === "string" &&
    typeof body.base64 === "string" &&
    typeof body.format === "string" &&
    typeof body.width === "number" &&
    typeof body.height === "number"
  );
}

function jsonResult(
  status: number,
  body: unknown,
): { status: number; headers: Record<string, string>; body: string } {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** GET — drain the queue of pending capture requests for the renderer poller. */
export const captureRequestsRoute: Route = {
  type: "GET",
  path: "/api/vision/capture-requests",
  rawPath: true,
  routeHandler: async (ctx) => {
    const bridge = ctx.runtime.getService<ScreenCaptureBridgeService>(
      SCREEN_CAPTURE_BRIDGE_SERVICE_TYPE,
    );
    if (!bridge) return jsonResult(200, { requests: [] });
    return jsonResult(200, { requests: bridge.takeRequests() });
  },
};

/** POST — accept a captured frame (or a skip) for a queued request. */
export const screenFrameRoute: Route = {
  type: "POST",
  path: "/api/vision/screen-frame",
  rawPath: true,
  routeHandler: async (ctx) => {
    const bridge = ctx.runtime.getService<ScreenCaptureBridgeService>(
      SCREEN_CAPTURE_BRIDGE_SERVICE_TYPE,
    );
    if (!bridge)
      return jsonResult(404, { ok: false, error: "bridge_unavailable" });

    const body = ctx.body;
    // Renderer signalled a capture failure/skip so the pending request settles
    // immediately rather than waiting out the bridge timeout.
    if (
      typeof body === "object" &&
      body !== null &&
      typeof (body as Record<string, unknown>).requestId === "string" &&
      (body as Record<string, unknown>).error !== undefined
    ) {
      const requestId = (body as Record<string, unknown>).requestId as string;
      const reason = String((body as Record<string, unknown>).error);
      const failed = bridge.failFrame(requestId, reason);
      return failed
        ? jsonResult(200, { ok: true })
        : jsonResult(404, { ok: false, error: "unknown_request" });
    }

    if (!isScreenFrameBody(body)) {
      return jsonResult(400, { ok: false, error: "invalid_body" });
    }

    const ok = bridge.submitFrame(
      body.requestId,
      body.base64,
      body.format,
      body.width,
      body.height,
    );
    return ok
      ? jsonResult(200, { ok: true })
      : jsonResult(404, { ok: false, error: "unknown_request" });
  },
};

function isOcrWord(value: unknown): value is OcrBridgeWord {
  if (typeof value !== "object" || value === null) return false;
  const word = value as Record<string, unknown>;
  return (
    typeof word.text === "string" &&
    typeof word.left === "number" &&
    typeof word.top === "number" &&
    typeof word.width === "number" &&
    typeof word.height === "number" &&
    typeof word.confidence === "number" &&
    typeof word.block === "number" &&
    typeof word.par === "number" &&
    typeof word.line === "number"
  );
}

export const ocrRequestsRoute: Route = {
  type: "GET",
  path: "/api/vision/ocr-requests",
  rawPath: true,
  routeHandler: async (ctx) => {
    const bridge = ctx.runtime.getService<OcrBridgeService>(
      OCR_BRIDGE_SERVICE_TYPE,
    );
    if (!bridge) return jsonResult(200, { requests: [] });
    return jsonResult(200, { requests: bridge.takeRequests() });
  },
};

export const ocrResultRoute: Route = {
  type: "POST",
  path: "/api/vision/ocr-result",
  rawPath: true,
  routeHandler: async (ctx) => {
    const bridge = ctx.runtime.getService<OcrBridgeService>(
      OCR_BRIDGE_SERVICE_TYPE,
    );
    if (!bridge)
      return jsonResult(404, { ok: false, error: "bridge_unavailable" });

    const body = ctx.body;
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as Record<string, unknown>).requestId !== "string"
    ) {
      return jsonResult(400, { ok: false, error: "invalid_body" });
    }
    const requestId = (body as Record<string, unknown>).requestId as string;

    if ((body as Record<string, unknown>).error !== undefined) {
      const failed = bridge.failRequest(
        requestId,
        String((body as Record<string, unknown>).error),
      );
      return failed
        ? jsonResult(200, { ok: true })
        : jsonResult(404, { ok: false, error: "unknown_request" });
    }

    const rawWords = (body as Record<string, unknown>).words;
    if (!Array.isArray(rawWords)) {
      return jsonResult(400, { ok: false, error: "invalid_body" });
    }
    const ok = bridge.submitResult(requestId, rawWords.filter(isOcrWord));
    return ok
      ? jsonResult(200, { ok: true })
      : jsonResult(404, { ok: false, error: "unknown_request" });
  },
};

export const visionRoutes: Route[] = [
  captureRequestsRoute,
  screenFrameRoute,
  ocrRequestsRoute,
  ocrResultRoute,
];
