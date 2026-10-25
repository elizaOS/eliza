/**
 * Bounded HTTP transport primitives for the Google Maps adapter. Owns request
 * deadlines, non-blocking response-stream teardown, retry-after parsing, and
 * byte-limited UTF-8 reads of untrusted upstream bytes. The generic JSON
 * adapter uses core's managed-provider SDK instead; this module exists because
 * Google authenticates with `X-Goog-Api-Key`, which the SDK's bearer-token
 * credential contract cannot carry.
 */

import { logger } from "@elizaos/core";
import { MapsError } from "./errors.js";

export interface RequestDeadline {
  signal: AbortSignal;
  dispose(): void;
}

export function requestDeadline(timeoutMs: number): RequestDeadline {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException("Maps deadline elapsed", "TimeoutError"),
      ),
    timeoutMs,
  );
  timeout.unref?.();
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timeout),
  };
}

export function observeTeardown(
  operation: Promise<unknown>,
  surface: string,
): void {
  // error-policy:J6 Teardown is intentionally non-blocking; a redacted debug
  // observation keeps cancellation failures visible without delaying results.
  void operation.catch((error) => {
    logger.debug(
      {
        errorName: error instanceof Error ? error.name : typeof error,
        surface,
      },
      "[MapsHttpTransport] Response-stream teardown did not complete cleanly",
    );
  });
}

export function cancelBody(response: Response, reason: string): void {
  // error-policy:J6 Cancellation is teardown only and must never delay the
  // typed terminal result from an untrusted response stream.
  if (response.body) observeTeardown(response.body.cancel(reason), reason);
}

export function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * Reads an untrusted response body as UTF-8 under a byte limit and deadline.
 * Declared-length and streamed overruns, deadline expiry, and undecodable
 * bytes each surface as their typed `MapsError` without retaining content.
 */
export async function readBoundedBody(
  response: Response,
  deadline: RequestDeadline,
  responseByteLimit: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared &&
    /^\d+$/.test(declared) &&
    Number(declared) > responseByteLimit
  ) {
    cancelBody(response, "maps declared response exceeded byte limit");
    throw new MapsError("The maps provider response exceeded the byte limit.", {
      code: "MAPS_RESPONSE_TOO_LARGE",
      context: { status: response.status, limit: responseByteLimit },
    });
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>(
        (resolve, reject) => {
          const onAbort = () =>
            reject(
              deadline.signal.reason ??
                new DOMException("Maps deadline elapsed", "TimeoutError"),
            );
          if (deadline.signal.aborted) return onAbort();
          deadline.signal.addEventListener("abort", onAbort, { once: true });
          void reader
            .read()
            .then(resolve, reject)
            .finally(() =>
              deadline.signal.removeEventListener("abort", onAbort),
            );
        },
      );
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > responseByteLimit) {
        observeTeardown(
          reader.cancel("maps response exceeded byte limit"),
          "response-too-large",
        );
        throw new MapsError(
          "The maps provider response exceeded the byte limit.",
          {
            code: "MAPS_RESPONSE_TOO_LARGE",
            context: { status: response.status, limit: responseByteLimit },
          },
        );
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } catch (error) {
    if (error instanceof MapsError) throw error;
    if (
      deadline.signal.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      observeTeardown(
        reader.cancel("maps response deadline elapsed"),
        "response-deadline",
      );
      throw new MapsError("The maps provider timed out.", {
        code: "MAPS_PROVIDER_TIMEOUT",
        cause: error,
        context: { status: response.status },
      });
    }
    // error-policy:J2 Provider bytes are untrusted; preserve bounded read and
    // UTF-8 failures without retaining or exposing response content.
    throw new MapsError("The maps provider response body could not be read.", {
      code: "MAPS_MALFORMED_RESPONSE",
      cause: error,
      context: { status: response.status },
    });
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      // error-policy:J6 A pending untrusted read owns the lock until its
      // non-blocking cancellation settles; terminal classification is fixed.
      logger.debug(
        {
          errorName: error instanceof Error ? error.name : typeof error,
          surface: "reader-release-lock",
        },
        "[MapsHttpTransport] Response reader lock remained pending during teardown",
      );
    }
  }
}
