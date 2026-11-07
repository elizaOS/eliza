export type NativeRuntimePreparation = (
  baseUrl: string,
  signal: AbortSignal,
) => Promise<void>;

/** One admission per base in one startup generation; a failed admission is never replayed. */
export function createNativeRuntimePreparation(
  prepare: NativeRuntimePreparation | undefined,
  signal?: AbortSignal,
) {
  const attempts = new Map<string, Promise<void>>();
  return (baseUrl: string, remainingMs: number): Promise<void> => {
    if (!prepare) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (remainingMs <= 0)
      return Promise.reject(
        new Error("Native runtime admission exceeded the startup deadline"),
      );
    const existing = attempts.get(baseUrl);
    if (existing) return existing;
    const controller = new AbortController();
    const attempt = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (succeeded: boolean, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (succeeded) resolve();
        else reject(error);
      };
      const abort = () => {
        const reason =
          signal?.reason ?? new DOMException("Startup cancelled", "AbortError");
        controller.abort(reason);
        finish(false, reason);
      };
      const timer = setTimeout(
        () => {
          const error = new Error(
            "Native runtime admission exceeded the startup deadline",
          );
          controller.abort(error);
          finish(false, error);
        },
        Math.max(0, remainingMs),
      );
      signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return prepare(baseUrl, controller.signal);
        })
        .then(
          () => finish(true),
          (error) => finish(false, error),
        );
    });
    attempts.set(baseUrl, attempt);
    return attempt;
  };
}
