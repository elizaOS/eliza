/**
 * One owned request to a native speech bridge (recognition, synthesis, status) bound to the
 * selection it was made for. The host names that binding: `check` throws (an AbortError) once it
 * no longer holds (owner, agent session, connection mode, a hidden app), and `watch` reports
 * changes that may break it. When the binding breaks, the caller's signal aborts, or the request
 * finishes against a changed binding, the bridge's `cancel(requestId)` runs, the owned signal
 * aborts and the result is never returned. No DOM, storage or platform imports.
 */
export interface NativeSpeechRequestBinding {
  /** Throws when the binding the request was made for changed. */
  check(): void;
  /** Calls `onChange` whenever the binding may have changed; returns the unsubscribe. */
  watch(onChange: () => void): () => void;
  /** Cancels the bridge request (errors are ignored). */
  cancel(requestId: string): Promise<unknown> | undefined;
  /** The reason an interrupted request reports; defaults to "Voice cancelled". */
  cancelledMessage?: string;
  newRequestId?: () => string;
}
/**
 * The work of one owned request: its bridge request id, a promise that rejects when the request
 * is interrupted (race the bridge call against it) and the owned signal.
 */
export type NativeSpeechRequestWork<T> = (
  requestId: string,
  interrupted: Promise<never>,
  owned: AbortSignal,
) => Promise<T>;
export type NativeSpeechRequestRunner = <T>(
  signal: AbortSignal,
  work: NativeSpeechRequestWork<T>,
) => Promise<T>;

const abortError = (message: string) =>
  typeof DOMException === "function"
    ? new DOMException(message, "AbortError")
    : Object.assign(Error(message), { name: "AbortError" });

export function createNativeSpeechRequests(
  binding: NativeSpeechRequestBinding,
): NativeSpeechRequestRunner {
  return async <T>(
    signal: AbortSignal,
    work: NativeSpeechRequestWork<T>,
  ): Promise<T> => {
    binding.check();
    signal.throwIfAborted();
    const owned = new AbortController();
    const requestId = binding.newRequestId?.() ?? crypto.randomUUID();
    let reject!: (reason: unknown) => void;
    const interrupted = new Promise<never>((_, fail) => {
      reject = fail;
    });
    void interrupted.catch(() => {});
    const cancel = () => {
      if (owned.signal.aborted) return;
      try {
        void binding.cancel(requestId)?.catch(() => {});
      } catch {
        /* The bridge is gone; the request is still fenced below. */
      }
      owned.abort(abortError(binding.cancelledMessage ?? "Voice cancelled"));
      reject(owned.signal.reason);
    };
    const unwatch = binding.watch(() => {
      try {
        binding.check();
      } catch {
        cancel();
      }
    });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await work(requestId, interrupted, owned.signal);
      binding.check();
      signal.throwIfAborted();
      return result;
    } finally {
      signal.removeEventListener("abort", cancel);
      unwatch();
    }
  };
}
