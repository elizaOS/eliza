/**
 * Stub for thread-stream that provides synchronous logging.
 * This is needed because pino's thread-stream creates dynamic module names
 * at runtime (like pino-28069d5257187539) that cannot be resolved in
 * serverless environments like Vercel.
 *
 * This stub provides a synchronous write stream that writes directly
 * to stdout, bypassing the worker thread entirely.
 */

import { EventEmitter } from "events";

interface ThreadStreamOptions {
  filename?: string;
  workerData?: unknown;
  sync?: boolean;
  minLength?: number;
  bufferSize?: number;
}

/**
 * A synchronous writable stream that mimics thread-stream's API
 * but writes directly to stdout without worker threads.
 */
class SyncThreadStream extends EventEmitter {
  private closed = false;
  private destroyed = false;
  writable = true;
  writableEnded = false;
  writableFinished = false;
  writableNeedDrain = false;
  writableObjectMode = false;
  writableHighWaterMark = 16384;

  constructor(_options?: ThreadStreamOptions) {
    super();
    // Emit 'ready' event asynchronously to match thread-stream behavior
    setImmediate(() => {
      if (!this.destroyed) {
        this.emit("ready");
      }
    });
  }

  write(data: string | Buffer): boolean {
    if (this.closed || this.destroyed) {
      return false;
    }

    try {
      const str = typeof data === "string" ? data : data.toString();
      process.stdout.write(str);
      return true;
    } catch (err) {
      this.emit("error", err);
      return false;
    }
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.writable = false;
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit("close");
  }

  flush(callback?: (err?: Error | null) => void): void {
    // Sync stream doesn't need flushing
    if (callback) {
      setImmediate(callback);
    }
  }

  flushSync(): void {
    // No-op for sync stream - already synchronous
  }

  unref(): void {
    // No-op - no worker to unref
  }

  ref(): void {
    // No-op - no worker to ref
  }

  destroy(err?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closed = true;
    this.writable = false;

    if (err) {
      this.emit("error", err);
    }
    this.emit("close");
  }
}

/**
 * Creates a synchronous writable stream that mimics thread-stream.
 * This bypasses the worker thread mechanism entirely.
 */
function ThreadStream(options?: ThreadStreamOptions): SyncThreadStream {
  return new SyncThreadStream(options);
}

// Support both default and named exports for compatibility
ThreadStream.default = ThreadStream;

// CommonJS export
module.exports = ThreadStream;

// ES Module export
export default ThreadStream;
export { ThreadStream, SyncThreadStream };
