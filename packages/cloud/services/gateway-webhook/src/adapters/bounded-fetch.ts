/**
 * Owns gateway provider deadlines across transport and bounded response-body consumption.
 */

const MAX_TIMER_MS = 2_147_483_647;

export class GatewayProviderFetchError extends Error {
  override readonly name = "GatewayProviderFetchError";

  constructor(
    readonly code: "INVALID_GATEWAY_TIMEOUT" | "GATEWAY_RESPONSE_TOO_LARGE",
    message: string,
    readonly context: Record<string, unknown>,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function cancelBodyDetached(
  body: ReadableStream<Uint8Array> | null,
  reason: unknown,
): void {
  if (!body) return;
  try {
    // error-policy:J6 The request has already failed; cancellation is detached
    // so a hostile stream cannot replace or delay the boundary error.
    void body.cancel(reason).catch(() => undefined);
  } catch {
    // error-policy:J6 A synchronous cancellation failure cannot replace the
    // already-selected request failure.
  }
}

function cancelReaderDetached(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): void {
  const release = (): void => {
    try {
      reader.releaseLock();
    } catch {
      // error-policy:J6 Releasing a failed response stream is teardown-only.
    }
  };
  try {
    // Keep ownership until cancellation settles. Releasing first can race an
    // in-flight cancel, while awaiting it would let a hostile stream defeat the
    // request deadline.
    void reader
      .cancel(reason)
      // error-policy:J6 The request failure is already observed by the caller.
      .catch(() => undefined)
      .finally(release);
  } catch {
    // error-policy:J6 A synchronous cancellation failure is teardown-only.
    release();
  }
}

export async function boundedGatewayFetch(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<Response> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMER_MS ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 0
  ) {
    throw new GatewayProviderFetchError(
      "INVALID_GATEWAY_TIMEOUT",
      "Gateway provider bounds must be timer-safe positive integers",
      { timeoutMs, maxResponseBytes },
    );
  }

  if (init?.signal?.aborted) {
    throw (
      init.signal.reason ??
      new DOMException("Provider request cancelled", "AbortError")
    );
  }

  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (reason: unknown): void => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    rejectAbort(reason);
  };
  const onCallerAbort = (): void =>
    abort(
      init?.signal?.reason ??
        new DOMException("Provider request cancelled", "AbortError"),
    );
  init?.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(
    () =>
      abort(
        new DOMException("Provider request deadline expired", "TimeoutError"),
      ),
    timeoutMs,
  );

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await Promise.race([
      fetchImpl(input, { ...init, signal: controller.signal }),
      abortPromise,
    ]);
    const rawLength = response.headers.get("content-length");
    if (rawLength !== null) {
      if (!/^\d+$/.test(rawLength) || Number(rawLength) > maxResponseBytes) {
        const error = new GatewayProviderFetchError(
          "GATEWAY_RESPONSE_TOO_LARGE",
          "Gateway provider response exceeds the byte limit",
          { maxResponseBytes, contentLength: rawLength },
        );
        cancelBodyDetached(response.body, error);
        throw error;
      }
    }
    if (!response.body) return response;

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    while (true) {
      const next = await Promise.race([reader.read(), abortPromise]);
      if (next.done) break;
      receivedBytes += next.value.byteLength;
      if (receivedBytes > maxResponseBytes) {
        const error = new GatewayProviderFetchError(
          "GATEWAY_RESPONSE_TOO_LARGE",
          "Gateway provider response exceeds the byte limit",
          { maxResponseBytes, receivedBytes },
        );
        cancelReaderDetached(reader, error);
        reader = undefined;
        throw error;
      }
      chunks.push(next.value);
    }
    const body = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(body.buffer, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener("abort", onCallerAbort);
    if (controller.signal.aborted && reader) {
      cancelReaderDetached(reader, controller.signal.reason);
      reader = undefined;
    }
    reader?.releaseLock();
  }
}
