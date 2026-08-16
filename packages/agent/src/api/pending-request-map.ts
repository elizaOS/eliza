/**
 * Correlates server-initiated requests with asynchronous frontend results.
 *
 * The server registers before broadcasting a WebSocket message so a fast
 * frontend response cannot outrun the waiter. Each request id owns one slot;
 * registering it again rejects the displaced waiter before replacing it.
 */

import { ElizaError } from "@elizaos/core";

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
      const existing = this.map.get(requestId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.reject(
          new ElizaError(
            `Pending request "${requestId}" was superseded by a newer waiter`,
            {
              code: "PENDING_REQUEST_SUPERSEDED",
              context: { requestId },
              severity: "ephemeral",
            },
          ),
        );
      }
      const timer = setTimeout(() => {
        if (this.map.get(requestId)?.timer !== timer) return;
        this.map.delete(requestId);
        reject(
          new ElizaError(
            `Pending request "${requestId}" timed out after ${timeoutMs}ms`,
            {
              code: "PENDING_REQUEST_TIMEOUT",
              context: { requestId, timeoutMs },
              severity: "ephemeral",
            },
          ),
        );
      }, timeoutMs);

      this.map.set(requestId, { resolve, reject, timer });
    });
  }

  /**
   * Resolve a pending request with the given result.
   * Ignored when the requestId is unknown (e.g. already timed out).
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
