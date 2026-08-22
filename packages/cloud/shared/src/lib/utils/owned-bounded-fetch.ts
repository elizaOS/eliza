/**
 * Owns one REST hop through transport, bounded response buffering, and cleanup.
 */

import { ElizaError } from "@elizaos/core/errors";

const MAX_TIMER_MS = 2_147_483_647;
export const DEFAULT_REST_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_REST_RESPONSE_MAX_CHUNKS = 8_192;

export interface OwnedBoundedFetchOptions {
  timeoutMs: number;
  maxResponseBytes?: number;
  maxResponseChunks?: number;
}

function releaseNoThrow(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // error-policy:J6 Releasing a terminal response stream is teardown-only.
  }
}

function cancelBodyDetached(body: ReadableStream<Uint8Array> | null, reason: unknown): void {
  if (!body) return;
  try {
    // error-policy:J6 The primary boundary failure already belongs to the caller.
    void body.cancel(reason).catch(() => undefined);
  } catch {
    // error-policy:J6 A synchronous cancellation failure is teardown-only.
  }
}

function cancelReaderDetached(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): void {
  try {
    // Retain ownership until cancellation settles, but never let a hostile
    // cancellation promise delay or replace the selected boundary failure.
    void reader
      .cancel(reason)
      // error-policy:J6 The primary boundary failure already belongs to the caller.
      .catch(() => undefined)
      .finally(() => releaseNoThrow(reader));
  } catch {
    // error-policy:J6 A synchronous cancellation failure is teardown-only.
    releaseNoThrow(reader);
  }
}

function sizeError(context: Record<string, unknown>): ElizaError {
  return new ElizaError("REST response exceeds its bounded-body contract", {
    code: "CLOUD_REST_RESPONSE_TOO_LARGE",
    context,
    severity: "ephemeral",
  });
}

/**
 * Fetch and fully buffer a response under one clearable deadline.
 *
 * The returned Response is detached from the network stream, so callers may
 * parse it after this function has cleared its timer and caller listener.
 */
export async function ownedBoundedFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: OwnedBoundedFetchOptions,
): Promise<Response> {
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_REST_RESPONSE_MAX_BYTES;
  const maxResponseChunks = options.maxResponseChunks ?? DEFAULT_REST_RESPONSE_MAX_CHUNKS;
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > MAX_TIMER_MS ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 0 ||
    !Number.isSafeInteger(maxResponseChunks) ||
    maxResponseChunks < 1
  ) {
    throw new ElizaError("REST hop bounds must be timer-safe integers", {
      code: "INVALID_CLOUD_REST_BOUNDS",
      context: {
        timeoutMs: options.timeoutMs,
        maxResponseBytes,
        maxResponseChunks,
      },
    });
  }

  if (init?.signal?.aborted) {
    throw init.signal.reason ?? new DOMException("REST request cancelled", "AbortError");
  }

  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (reason: unknown): void => {
    if (controller.signal.aborted) return;
    // Select provenance before aborting the transport: a stream may reject its
    // pending read synchronously with a generic AbortError.
    rejectAbort(reason);
    controller.abort(reason);
  };
  const onCallerAbort = (): void =>
    abort(init?.signal?.reason ?? new DOMException("REST request cancelled", "AbortError"));
  init?.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(
    () => abort(new DOMException("REST request deadline expired", "TimeoutError")),
    options.timeoutMs,
  );

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      abortPromise,
    ]);
    const rawLength = response.headers.get("content-length");
    if (rawLength !== null && (!/^\d+$/.test(rawLength) || Number(rawLength) > maxResponseBytes)) {
      const error = sizeError({
        contentLength: rawLength,
        maxResponseBytes,
      });
      cancelBodyDetached(response.body, error);
      throw error;
    }
    if (!response.body) return response;

    reader = response.body.getReader();
    const retained = new Uint8Array(maxResponseBytes);
    let receivedBytes = 0;
    let chunks = 0;
    while (true) {
      const next = await Promise.race([reader.read(), abortPromise]);
      if (next.done) break;
      chunks += 1;
      if (chunks > maxResponseChunks) {
        const error = sizeError({
          chunks,
          maxResponseBytes,
          maxResponseChunks,
          receivedBytes,
        });
        cancelReaderDetached(reader, error);
        reader = undefined;
        throw error;
      }
      if (next.value.byteLength === 0) continue;
      receivedBytes += next.value.byteLength;
      if (receivedBytes > maxResponseBytes) {
        const error = sizeError({
          chunks,
          maxResponseBytes,
          maxResponseChunks,
          receivedBytes,
        });
        cancelReaderDetached(reader, error);
        reader = undefined;
        throw error;
      }
      retained.set(next.value, receivedBytes - next.value.byteLength);
    }

    releaseNoThrow(reader);
    reader = undefined;
    const headers = new Headers(response.headers);
    // Fetch exposes decoded body bytes; the detached response must not retain
    // transport framing that describes the encoded network representation.
    headers.delete("content-encoding");
    headers.set("content-length", String(receivedBytes));
    return new Response(retained.slice(0, receivedBytes), {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener("abort", onCallerAbort);
    if (controller.signal.aborted && reader) {
      cancelReaderDetached(reader, controller.signal.reason);
      reader = undefined;
    }
    if (reader) releaseNoThrow(reader);
  }
}
