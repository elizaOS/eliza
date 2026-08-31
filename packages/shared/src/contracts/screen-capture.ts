/**
 * Lossless wire contract for renderer-pulled screen capture, shared by the
 * agent queue and native renderer poller.
 */

export type ScreenCaptureImageFormat = "jpeg" | "png";

export interface ScreenCaptureRequestContract {
  requestId: string;
  createdAt: number;
  displayId?: number;
  format: ScreenCaptureImageFormat;
  scale: number;
  quality?: number;
}

export interface ScreenCaptureFrameContract {
  requestId: string;
  base64: string;
  format: ScreenCaptureImageFormat;
  width: number;
  height: number;
  capturedAt: number;
}

export interface ScreenCaptureFailureContract {
  requestId: string;
  error: string;
  capturedAt: number;
}

export type ScreenCaptureResultContract =
  | ScreenCaptureFrameContract
  | ScreenCaptureFailureContract;

export const SCREEN_CAPTURE_REQUEST_DEFAULTS = {
  format: "jpeg",
  scale: 0.5,
  quality: 70,
} as const satisfies Pick<
  ScreenCaptureRequestContract,
  "format" | "scale" | "quality"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isImageFormat(value: unknown): value is ScreenCaptureImageFormat {
  return value === "jpeg" || value === "png";
}

function isPositiveDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isScreenCaptureRequestContract(
  value: unknown,
): value is ScreenCaptureRequestContract {
  if (!isRecord(value)) return false;
  const request = value;
  return (
    typeof request.requestId === "string" &&
    typeof request.createdAt === "number" &&
    Number.isFinite(request.createdAt) &&
    isImageFormat(request.format) &&
    typeof request.scale === "number" &&
    Number.isFinite(request.scale) &&
    request.scale >= 0.1 &&
    request.scale <= 1 &&
    (request.quality === undefined ||
      (typeof request.quality === "number" &&
        request.quality >= 1 &&
        request.quality <= 100 &&
        Number.isFinite(request.quality)))
  );
}

/**
 * Upgrades requests emitted before format/scale/quality became required. An
 * explicitly malformed value is rejected rather than replaced by a default.
 */
export function normalizeScreenCaptureRequestContract(
  value: unknown,
): ScreenCaptureRequestContract | null {
  if (!isRecord(value)) return null;
  const candidate = {
    ...value,
    format:
      value.format === undefined
        ? SCREEN_CAPTURE_REQUEST_DEFAULTS.format
        : value.format,
    scale:
      value.scale === undefined
        ? SCREEN_CAPTURE_REQUEST_DEFAULTS.scale
        : value.scale,
    quality:
      value.quality === undefined
        ? SCREEN_CAPTURE_REQUEST_DEFAULTS.quality
        : value.quality,
  };
  return isScreenCaptureRequestContract(candidate) ? candidate : null;
}

export function isScreenCaptureFrameContract(
  value: unknown,
): value is ScreenCaptureFrameContract {
  if (!isRecord(value)) return false;
  const frame = value;
  return (
    typeof frame.requestId === "string" &&
    typeof frame.base64 === "string" &&
    isImageFormat(frame.format) &&
    isPositiveDimension(frame.width) &&
    isPositiveDimension(frame.height) &&
    typeof frame.capturedAt === "number" &&
    Number.isFinite(frame.capturedAt)
  );
}

/** Upgrade frames emitted before capturedAt became required by the route. */
export function normalizeScreenCaptureFrameContract(
  value: unknown,
  now: () => number = Date.now,
): ScreenCaptureFrameContract | null {
  if (!isRecord(value)) return null;
  const candidate = {
    ...value,
    capturedAt: value.capturedAt === undefined ? now() : value.capturedAt,
  };
  return isScreenCaptureFrameContract(candidate) ? candidate : null;
}
