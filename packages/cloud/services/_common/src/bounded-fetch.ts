/**
 * Owns a cloud REST hop through its deadline, bounded body read and cleanup.
 * Only arrived bytes are retained; adapters supply limits and error factories
 * so Worker and sidecar callers share transport behavior without sharing policy.
 */

export interface BoundedFetchOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  maxResponseChunks?: number;
  fetchImpl?: typeof fetch;
  invalidBoundsError(): Error;
  responseTooLargeError(context: Record<string, unknown>): Error;
  timeoutMessage: string;
  cancellationMessage: string;
}

function releaseNoThrow(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // error-policy:J6 Releasing a terminal response stream is teardown-only.
  }
}

function cancelBodyDetached(
  body: ReadableStream<Uint8Array> | null,
  reason: unknown,
): void {
  if (!body) return;
  try {
    void body
      .cancel(reason)
      // error-policy:J6 The selected boundary failure is already observed by the caller.
      .catch(() => undefined);
  } catch {
    // error-policy:J6 A synchronous cancellation failure is teardown-only.
  }
}

function cancelReaderDetached(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): void {
  try {
    // Hostile cancellation must not delay the selected error. Keep reader
    // ownership until cancellation finishes before releasing its lock.
    void reader
      .cancel(reason)
      // error-policy:J6 The selected boundary failure is already observed by the caller.
      .catch(() => undefined)
      .finally(() => releaseNoThrow(reader));
  } catch {
    // error-policy:J6 A synchronous cancellation failure is teardown-only.
    releaseNoThrow(reader);
  }
}

/** Returns a fully buffered response detached from the transport deadline. */
export async function boundedFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: BoundedFetchOptions,
): Promise<Response> {
  const { timeoutMs, maxResponseBytes, maxResponseChunks } = options;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 0 ||
    (maxResponseChunks !== undefined &&
      (!Number.isSafeInteger(maxResponseChunks) || maxResponseChunks < 1))
  ) {
    throw options.invalidBoundsError();
  }
  const callerSignal =
    init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const cancellationReason = (): unknown =>
    callerSignal?.reason ??
    new DOMException(options.cancellationMessage, "AbortError");
  if (callerSignal?.aborted) throw cancellationReason();
  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (reason: unknown): void => {
    if (controller.signal.aborted) return;
    // Select provenance before the transport rejects with its own AbortError.
    rejectAbort(reason);
    controller.abort(reason);
  };
  const onCallerAbort = (): void => abort(cancellationReason());
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(
    () => abort(new DOMException(options.timeoutMessage, "TimeoutError")),
    timeoutMs,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  try {
    const pending = (options.fetchImpl ?? fetch)(input, {
      ...init,
      signal: controller.signal,
    });
    void pending.then(
      (lateResponse) => {
        if (controller.signal.aborted)
          cancelBodyDetached(lateResponse.body, controller.signal.reason);
      },
      () => {
        // error-policy:J5 The same fetch rejection is observed by the race below.
      },
    );
    response = await Promise.race([pending, aborted]);
    controller.signal.throwIfAborted();
    const rawLength = response.headers.get("content-length");
    if (
      rawLength !== null &&
      (!/^\d+$/.test(rawLength) || Number(rawLength) > maxResponseBytes)
    ) {
      throw options.responseTooLargeError({
        contentLength: rawLength,
        maxResponseBytes,
      });
    }
    if (!response.body) return response;
    reader = response.body.getReader();
    const retainedChunks: Uint8Array[] = [];
    let receivedBytes = 0;
    let chunks = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      controller.signal.throwIfAborted();
      if (next.done) break;
      chunks += 1;
      receivedBytes += next.value.byteLength;
      if (
        receivedBytes > maxResponseBytes ||
        (maxResponseChunks !== undefined && chunks > maxResponseChunks)
      ) {
        throw options.responseTooLargeError({
          receivedBytes,
          maxResponseBytes,
          ...(maxResponseChunks !== undefined
            ? { chunks, maxResponseChunks }
            : {}),
        });
      }
      if (next.value.byteLength > 0) retainedChunks.push(next.value);
    }
    releaseNoThrow(reader);
    reader = undefined;
    const retained = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of retainedChunks) {
      retained.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const headers = new Headers(response.headers);
    // Fetch body reads yield decoded bytes. Rebuilt responses describe those
    // bytes, independent of the origin's compression and transfer framing.
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    headers.set("content-length", String(receivedBytes));
    const bodyless =
      response.status === 204 ||
      response.status === 205 ||
      response.status === 304;
    return new Response(bodyless ? null : retained, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch (error) {
    // error-policy:J2 Preserve the selected transport or boundary error through teardown.
    if (reader) cancelReaderDetached(reader, error);
    else if (response) cancelBodyDetached(response.body, error);
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
