/**
 * Portable timeout signal helper. `AbortSignal.timeout` is missing on
 * iOS 16.0-16.3 WkWebView (available only from Safari 16.4). On those
 * runtimes the bare `AbortSignal.timeout(ms)` call throws TypeError
 * *before* fetch is issued, turning the intended 30 s / 60 s bound into a
 * hard crash on paired Cloud bridge and Eliza-1 manifest paths. This helper
 * falls back to `AbortController` plus `setTimeout`, preserving the same
 * timeout contract via the `signal` option fetch already accepts.
 *
 * The returned `dispose` must be called after `fetch` *and* any streaming
 * body (`response.json()` / `response.text()`) settle — headers may arrive
 * well before `ms`, while the body is still stalled. Keeping the timer
 * alive through the body read mirrors `AbortSignal.timeout` semantics and is
 * what the fake-timer tests exercise (headers-received plus stalled body).
 * `dispose` also clears the timer when the timeout fires, so success-before-
 * timeout does not leak a pending timer under `vi.useFakeTimers()`.
 */
export function createTimeoutSignal(ms: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const nativeTimeout = (
    AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }
  ).timeout;
  if (typeof nativeTimeout === "function") {
    try {
      const signal = nativeTimeout.call(AbortSignal, ms);
      return { signal, dispose: () => {} };
    } catch {
      // fall through to AbortController fallback
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort(
        new DOMException(`Timeout after ${ms} ms`, "TimeoutError"),
      );
    } catch {
      try {
        controller.abort();
      } catch {}
    }
  }, ms);
  const dispose = () => clearTimeout(timer);
  // If the controller aborts (timeout fires), clear the timer listener is
  // already via dispose, but also ensure timer cleared on abort.
  controller.signal.addEventListener("abort", dispose, { once: true });
  return { signal: controller.signal, dispose };
}

export function getTimeoutSignal(ms: number): AbortSignal {
  return createTimeoutSignal(ms).signal;
}
