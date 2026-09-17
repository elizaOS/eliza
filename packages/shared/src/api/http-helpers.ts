import type {
  ReadJsonBodyOptions,
  ReadTextBodyOptions,
  RequestBodyOptions,
} from "./route-helpers";

export type {
  ReadJsonBodyOptions,
  ReadTextBodyOptions,
  RequestBodyOptions,
} from "./route-helpers";

/**
 * Shared HTTP request/response plumbing for the API and benchmark route layers:
 * bounded body reads (size-guarded, with optional size/error-to-null fallbacks)
 * and JSON responders in both awaitable and fire-and-forget forms. The raw body
 * buffer and its parsed JSON are memoized on the request via `Symbol.for` keys
 * so several handlers can read one body without re-consuming the stream.
 */
import type http from "node:http";
import { ElizaError, logger } from "@elizaos/core";

const CACHED_REQUEST_BODY = Symbol.for("eliza.http.cachedRequestBody");
const CACHED_JSON_BODY = Symbol.for("eliza.http.cachedJsonBody");

type CachedRequest = http.IncomingMessage & {
  [CACHED_REQUEST_BODY]?: Buffer;
  [CACHED_JSON_BODY]?: unknown;
  body?: unknown;
};

/**
 * Common request body size guard used across API/benchmark endpoints.
 */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

function defaultTooLargeMessage(maxBytes: number, explicit?: string): string {
  return explicit ?? `Request body exceeds maximum size (${maxBytes} bytes)`;
}

function requestBodyTooLargeError(
  maxBytes: number,
  observedBytes: number,
  explicitMessage?: string,
): ElizaError {
  return new ElizaError(defaultTooLargeMessage(maxBytes, explicitMessage), {
    code: "HTTP_REQUEST_BODY_TOO_LARGE",
    context: { maxBytes, observedBytes },
    severity: "ephemeral",
  });
}

export async function readRequestBodyBuffer(
  req: http.IncomingMessage,
  {
    maxBytes = DEFAULT_MAX_BODY_BYTES,
    returnNullOnError = false,
    returnNullOnTooLarge = false,
    destroyOnTooLarge = false,
    tooLargeMessage,
  }: RequestBodyOptions = {},
): Promise<Buffer | null> {
  const cached = (req as CachedRequest)[CACHED_REQUEST_BODY];
  if (cached) {
    if (cached.length > maxBytes) {
      if (returnNullOnTooLarge) return null;
      throw requestBodyTooLargeError(maxBytes, cached.length, tooLargeMessage);
    }
    return cached;
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let tooLarge = false;
    let settled = false;

    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };

    const settle = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        tooLarge = true;
        if (returnNullOnTooLarge) {
          if (destroyOnTooLarge) {
            req.destroy();
          }
          settle(null);
          return;
        }
        if (destroyOnTooLarge) {
          req.destroy();
          fail(requestBodyTooLargeError(maxBytes, totalBytes, tooLargeMessage));
          return;
        }
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      if (tooLarge) {
        if (returnNullOnTooLarge) {
          settle(null);
          return;
        }

        fail(requestBodyTooLargeError(maxBytes, totalBytes, tooLargeMessage));
        return;
      }

      const body = Buffer.concat(chunks);
      (req as CachedRequest)[CACHED_REQUEST_BODY] = body;
      settle(body);
    };

    const onError = (err: Error) => {
      if (returnNullOnError) {
        settle(null);
        return;
      }
      fail(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

export async function readRequestBody(
  req: http.IncomingMessage,
  options: ReadTextBodyOptions = {},
): Promise<string | null> {
  const { encoding = "utf-8", ...rawOptions } = options;
  const body = await readRequestBodyBuffer(req, rawOptions);
  if (body === null) return null;
  return body.toString(encoding);
}

export function isJsonObjectBody(
  value: unknown,
): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export async function writeJsonResponse(
  res: http.ServerResponse,
  body: unknown,
  status = 200,
): Promise<void> {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export async function writeJsonError(
  res: http.ServerResponse,
  message: string,
  status = 400,
): Promise<void> {
  await writeJsonResponse(res, { error: message }, status);
}

export function writeJsonResponseSafe(
  res: http.ServerResponse,
  body: unknown,
  status = 200,
): void {
  void writeJsonResponse(res, body, status).catch((err) => {
    // error-policy:J1 The response is already committed; logging is the only
    // remaining observable transport-boundary signal.
    logger.warn(`[http] JSON response write failed: ${err}`);
  });
}

/** Shorthand responder for successful JSON payloads with safe fire-and-forget write. */
export function sendJson(
  res: http.ServerResponse,
  body: unknown,
  status = 200,
): void {
  writeJsonResponseSafe(res, body, status);
}

/** Shorthand responder for JSON error payloads with safe fire-and-forget write. */
export function sendJsonError(
  res: http.ServerResponse,
  message: string,
  status = 400,
): void {
  writeJsonErrorSafe(res, message, status);
}

export function writeJsonErrorSafe(
  res: http.ServerResponse,
  message: string,
  status = 400,
): void {
  void writeJsonError(res, message, status).catch((err) => {
    // error-policy:J1 The response is already committed; logging is the only
    // remaining observable transport-boundary signal.
    logger.warn(`[http] JSON error response write failed: ${err}`);
  });
}

export async function readJsonBody<T = Record<string, unknown>>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  {
    readErrorStatus = 413,
    nonObjectStatus = 400,
    parseErrorStatus = 400,
    readErrorMessage = "Failed to read request body",
    nonObjectMessage = "Request body must be a JSON object",
    parseErrorMessage = "Invalid JSON in request body",
    requireObject = true,
    ...readOptions
  }: ReadJsonBodyOptions = {},
): Promise<T | null> {
  const cachedRequest = req as CachedRequest;
  let raw: string;
  try {
    const body = await readRequestBody(req, readOptions);
    if (body == null) {
      await writeJsonError(res, readErrorMessage, readErrorStatus);
      return null;
    }
    raw = body;
  } catch {
    // error-policy:J1 the HTTP boundary translates body-read failures into a
    // structured client response.
    await writeJsonError(res, readErrorMessage, readErrorStatus);
    return null;
  }

  if (CACHED_JSON_BODY in cachedRequest) {
    const parsed = cachedRequest[CACHED_JSON_BODY];
    if (
      requireObject &&
      (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    ) {
      await writeJsonError(res, nonObjectMessage, nonObjectStatus);
      return null;
    }
    return parsed as T;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      requireObject &&
      (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    ) {
      await writeJsonError(res, nonObjectMessage, nonObjectStatus);
      return null;
    }
    cachedRequest[CACHED_JSON_BODY] = parsed;
    cachedRequest.body = parsed;
    return parsed as T;
  } catch {
    // error-policy:J1 the HTTP boundary translates malformed JSON into a
    // structured client response.
    await writeJsonError(res, parseErrorMessage, parseErrorStatus);
    return null;
  }
}
