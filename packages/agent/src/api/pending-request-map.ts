/**
 * PendingRequestMap — correlates async agent→view interact requests with their results.
 *
 * The server registers a pending request before broadcasting the WS message to
 * the frontend.  When the frontend sends back a `view:interact:result` message
 * the server calls `resolve()` which fulfils the waiting promise.  A timer
 * fires automatically after `timeoutMs` ms to avoid hanging the HTTP handler.
 */

export interface ViewInteractResult {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export class PendingRequestMap {
  private readonly map = new Map<
    string,
    {
      resolve: (result: ViewInteractResult) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * Register a pending request and return a Promise that resolves when the
   * frontend sends the result back (or rejects on timeout).
   */
  waitFor(requestId: string, timeoutMs: number): Promise<ViewInteractResult> {
    return new Promise<ViewInteractResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.map.delete(requestId);
        reject(
          new Error(
            `View interact request "${requestId}" timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.map.set(requestId, { resolve, reject, timer });
    });
  }

  /**
   * Resolve a pending request with the given result.
   * No-op when the requestId is unknown (e.g. already timed out).
   */
  resolve(requestId: string, result: ViewInteractResult): void {
    const pending = this.map.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.map.delete(requestId);
    pending.resolve(result);
  }

  /** Number of in-flight requests. Useful for diagnostics. */
  get size(): number {
    return this.map.size;
  }
}
