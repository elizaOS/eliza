import type http from "node:http";

/**
 * Common request body size guard used across API/benchmark endpoints.
 */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export interface RequestBodyOptions {
  /** Maximum accepted body size in bytes. */
  maxBytes?: number;
  /** String conversion encoding for body text helpers. */
  encoding?: BufferEncoding;
  /** Error message returned when the request body exceeds `maxBytes`. */
  tooLargeMessage?: string;
  /** When true, resolves to `null` instead of rejecting on body read failure. */
  returnNullOnError?: boolean;
  /** When true, resolves to `null` instead of rejecting on size limit exceed. */
  returnNullOnTooLarge?: boolean;
  /** Whether to destroy the request stream as soon as the body limit is exceeded. */
  destroyOnTooLarge?: boolean;
}

function defaultTooLargeMessage(maxBytes: number, explicit?: string): string {
  return explicit ?? `Request body exceeds maximum size (${maxBytes} bytes)`;
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
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let tooLarge = false;
    let settled = false;

    const message = defaultTooLargeMessage(maxBytes, tooLargeMessage);

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
          fail(new Error(message));
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

        fail(new Error(message));
        return;
      }

      settle(Buffer.concat(chunks));
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

export interface ReadTextBodyOptions extends RequestBodyOptions {
  /** Optional response-timeout behavior handled by caller; kept for parity with legacy wrappers. */
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

export interface ReadJsonBodyOptions extends ReadTextBodyOptions {
  /** Whether to require JSON object shape (not arrays/null). */
  requireObject?: boolean;
  /** Response status used for parse/read failures. */
  readErrorStatus?: number;
  /** Response status used for non-object body when `requireObject` is true. */
  nonObjectStatus?: number;
  /** Response status used for invalid JSON syntax. */
  parseErrorStatus?: number;
  /** Override for read errors (including size / stream errors). */
  readErrorMessage?: string;
  /** Override when JSON is valid but not an object. */
  nonObjectMessage?: string;
  /** Override for malformed JSON parse errors. */
  parseErrorMessage?: string;
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
  void writeJsonResponse(res, body, status).catch(() => {
    /* ignore response write errors */
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
  void writeJsonError(res, message, status).catch(() => {
    /* ignore response write errors */
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
  let raw: string;
  try {
    const body = await readRequestBody(req, readOptions);
    if (body == null) {
      await writeJsonError(res, readErrorMessage, readErrorStatus);
      return null;
    }
    raw = body;
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "Failed to read request body";
    await writeJsonError(res, msg, readErrorStatus);
    return null;
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
    return parsed as T;
  } catch {
    await writeJsonError(res, parseErrorMessage, parseErrorStatus);
    return null;
  }
}
