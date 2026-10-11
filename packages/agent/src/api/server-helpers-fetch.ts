/**
 * HTTP fetch/streaming helpers extracted from server.ts.
 */

import type http from "node:http";

type StreamableServerResponse = Pick<
  http.ServerResponse,
  "write" | "once" | "off" | "removeListener" | "writableEnded" | "destroyed"
>;

function removeResponseListener(
  res: StreamableServerResponse,
  event: "drain" | "error",
  handler: (...args: unknown[]) => void,
): void {
  if (typeof res.off === "function") {
    res.off(event, handler);
    return;
  }
  if (typeof res.removeListener === "function") {
    res.removeListener(event, handler);
  }
}

export function responseContentLength(
  headers: Pick<Headers, "get">,
): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  // Number.parseInt stops at the first non-digit, so "123junk" parsed to a
  // finite 123 and was accepted as a declared length instead of being
  // treated as unknown. Require the whole trimmed value to be decimal,
  // mirroring resolveGenerationTimeoutMs in the discord plugin.
  const text = raw.trim();
  const parsed = /^\+?\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError" || error.name === "TimeoutError"
    : error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");
}

function createTimeoutError(message: string): Error {
  const timeoutError = new Error(message);
  timeoutError.name = "TimeoutError";
  return timeoutError;
}

export async function fetchWithTimeoutGuard(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const upstreamSignal = init.signal;
  // Use the platform timeout signal so the deadline stays active while the
  // caller consumes the response body. A manual timer cleared when fetch
  // resolves would end the deadline at the response headers, and a stalled
  // body could then keep the caller waiting without bound — the same defect
  // fixed for the Google MCP fetch in #35403.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = upstreamSignal
    ? AbortSignal.any([upstreamSignal, timeoutSignal])
    : timeoutSignal;

  try {
    return await fetch(input, {
      ...init,
      signal,
    });
  } catch (err) {
    if (
      timeoutSignal.aborted &&
      !upstreamSignal?.aborted &&
      isAbortError(err)
    ) {
      throw createTimeoutError(
        `Upstream request timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  }
}

async function waitForDrain(res: StreamableServerResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const cleanup = () => {
      removeResponseListener(
        res,
        "drain",
        onDrain as (...args: unknown[]) => void,
      );
      removeResponseListener(
        res,
        "error",
        onError as (...args: unknown[]) => void,
      );
    };

    res.once("drain", onDrain);
    res.once("error", onError);
  });
}

/**
 * Stream a web Response body to an HTTP response while enforcing a strict byte cap.
 * Returns the number of bytes forwarded.
 */
export async function streamResponseBodyWithByteLimit(
  upstream: Response,
  res: StreamableServerResponse,
  maxBytes: number,
  timeoutMs?: number,
): Promise<number> {
  const declaredLength = responseContentLength(upstream.headers);
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new Error(
      `Upstream response exceeds maximum size of ${maxBytes} bytes`,
    );
  }

  if (!upstream.body) {
    throw new Error("Upstream response did not include a body stream");
  }

  const reader = upstream.body.getReader();
  let totalBytes = 0;
  let streamTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const streamTimeoutPromise =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? new Promise<never>((_resolve, reject) => {
          streamTimeoutHandle = setTimeout(() => {
            reject(
              createTimeoutError(
                `Upstream response body timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        })
      : null;

  try {
    while (true) {
      const { done, value } = streamTimeoutPromise
        ? await Promise.race([reader.read(), streamTimeoutPromise])
        : await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(
          `Upstream response exceeds maximum size of ${maxBytes} bytes`,
        );
      }

      if (res.writableEnded || res.destroyed) {
        throw new Error("Client connection closed while streaming response");
      }

      const canContinue = res.write(Buffer.from(value));
      if (!canContinue) {
        await waitForDrain(res);
      }
    }
  } catch (err) {
    try {
      await reader.cancel(err);
    } catch {
      // Best effort cleanup; keep original error.
    }
    throw err;
  } finally {
    if (streamTimeoutHandle !== null) {
      clearTimeout(streamTimeoutHandle);
    }
    reader.releaseLock();
  }

  return totalBytes;
}
