/**
 * Batches streaming token updates via requestAnimationFrame to avoid
 * per-token re-renders. Flushes accumulated text on each animation frame
 * rather than on every chunk, keeping the UI smooth at 60fps during streaming.
 */
export class StreamingOptimizer {
  private buffer = "";
  private rafId: number | null = null;
  private onFlush: (text: string) => void;
  private lastFlushTime = 0;
  /** Max ms to wait before forcing a flush regardless of rAF timing */
  private readonly maxDelay: number;

  constructor(onFlush: (text: string) => void, maxDelay = 50) {
    this.onFlush = onFlush;
    this.maxDelay = maxDelay;
  }

  push(chunk: string): void {
    this.buffer += chunk;

    if (this.rafId !== null) return; // rAF already scheduled

    const now = performance.now();
    const timeSinceLast = now - this.lastFlushTime;

    if (timeSinceLast >= this.maxDelay) {
      // Flush is overdue — do it synchronously to avoid latency buildup
      this.flush();
    } else {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.flush();
      });
    }
  }

  flush(): void {
    if (!this.buffer) return;
    const text = this.buffer;
    this.buffer = "";
    this.lastFlushTime = performance.now();
    this.onFlush(text);
  }

  destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    // Flush any remaining buffered text
    this.flush();
  }
}

/**
 * Hook-friendly factory that returns a stable optimizer instance
 * tied to a callback ref so the callback can change without recreating
 * the optimizer (avoids stale closure issues).
 */
export function createStreamingOptimizer(
  onFlush: (accumulated: string) => void,
  maxDelay = 50
): StreamingOptimizer {
  return new StreamingOptimizer(onFlush, maxDelay);
}
