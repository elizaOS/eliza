/**
 * Portable timeout signal for fetch bounds. `AbortSignal.timeout` is missing
 * on iOS 16.0-16.3 WKWebView (it shipped in Safari 16.4), so a bare
 * `AbortSignal.timeout(ms)` call throws TypeError *before* fetch is issued on
 * supported devices, turning an intended bound into a hard crash. When the
 * native factory is absent this falls back to `AbortController` plus
 * `setTimeout`, preserving the same abort contract through fetch's `signal`
 * option.
 *
 * Callers must invoke `dispose` only after both fetch *and* any body read
 * (`response.json()` / `response.text()`) settle — headers can arrive well
 * before `ms` while the body is still stalled, and disposing early would
 * unbound that stall on fallback runtimes. `dispose` clears the fallback
 * timer so success-before-timeout does not leak a pending timer.
 */
export function createTimeoutSignal(ms: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const nativeTimeout = (
    AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }
  ).timeout;
  if (typeof nativeTimeout === "function") {
    return { signal: nativeTimeout.call(AbortSignal, ms), dispose: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(`Timeout after ${ms} ms`, "TimeoutError"),
    );
  }, ms);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

/**
 * True when an error is the abort produced by a timeout signal — native
 * `AbortSignal.timeout` rejects with `TimeoutError`, plain aborts with
 * `AbortError`. Matched by `name` because `DOMException` does not extend
 * `Error` on every supported runtime (Node's does not).
 */
export function isTimeoutAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}
