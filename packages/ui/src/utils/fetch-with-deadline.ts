/**
 * Runs a browser fetch and consumes its response under one deadline while
 * preserving a caller-owned cancellation signal. The deadline remains active
 * until the response body has been consumed, not merely until headers arrive.
 */

export interface FetchDeadlineOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The request was aborted", "AbortError")
  );
}

/** Fetch and consume a response under a composed caller/deadline signal. */
export async function fetchWithDeadline<T>(
  input: RequestInfo | URL,
  init: Omit<RequestInit, "signal">,
  consume: (response: Response) => Promise<T>,
  options: FetchDeadlineOptions,
): Promise<T> {
  const controller = new AbortController();
  const callerSignal = options.signal;
  const abortFromCaller = () => {
    if (callerSignal) controller.abort(abortReason(callerSignal));
  };

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timeoutId = globalThis.setTimeout(() => {
    controller.abort(new DOMException("The request timed out", "TimeoutError"));
  }, options.timeoutMs);

  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectWithReason = () => reject(abortReason(controller.signal));
    if (controller.signal.aborted) rejectWithReason();
    else
      controller.signal.addEventListener("abort", rejectWithReason, {
        once: true,
      });
  });

  try {
    const response = await Promise.race([
      (options.fetchImpl ?? globalThis.fetch)(input, {
        ...init,
        signal: controller.signal,
      }),
      aborted,
    ]);
    return await Promise.race([consume(response), aborted]);
  } finally {
    globalThis.clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
