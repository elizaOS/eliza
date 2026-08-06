import { ApiError } from "./types";
import type { StreamEvent, StreamProgress } from "./types";

// ---------------------------------------------------------------------------
// Parse a fetch streaming response body as SSE events
// ---------------------------------------------------------------------------

export interface ParseStreamOptions {
  signal?: AbortSignal;
  onProgress?: (progress: StreamProgress) => void;
}

/**
 * Parses a streaming HTTP response body formatted as server-sent events.
 * Yields typed StreamEvent objects as they arrive. Handles burst buffering —
 * events are never dropped regardless of how fast they arrive.
 */
export async function* parseStream(
  response: Response,
  opts?: ParseStreamOptions
): AsyncGenerator<StreamEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(0, "No response body", "network");

  const decoder = new TextDecoder();
  let buffer = "";
  const startTime = Date.now();
  let tokensReceived = 0;

  try {
    while (true) {
      if (opts?.signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process all complete lines. The last (potentially incomplete) line
      // stays in the buffer.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue; // blank line = SSE event separator
        if (!line.startsWith("data: ")) continue;

        const data = line.slice(6).trim();
        if (data === "[DONE]") return;

        try {
          const event = JSON.parse(data) as StreamEvent;

          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            tokensReceived += event.delta.text.length;
          }

          opts?.onProgress?.({
            tokensReceived,
            elapsedMs: Date.now() - startTime,
            isComplete: false,
          });

          yield event;
        } catch {
          // skip malformed JSON — keep going
        }
      }
    }
  } finally {
    reader.releaseLock();
    opts?.onProgress?.({
      tokensReceived,
      elapsedMs: Date.now() - startTime,
      isComplete: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Long-lived SSE connection with automatic reconnection
// ---------------------------------------------------------------------------

export interface SSEConnectionOptions {
  onEvent: (event: StreamEvent) => void;
  onError: (error: ApiError) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  /** Max reconnect attempts before giving up (default: 5) */
  maxReconnects?: number;
  /** Extra request headers (not supported by EventSource — use fetchSSE instead) */
  headers?: Record<string, string>;
}

/**
 * Manages a long-lived SSE connection to a URL with automatic exponential
 * backoff reconnection. Uses the native EventSource API.
 *
 * For endpoints that require custom headers, use FetchSSEConnection instead.
 */
export class SSEConnection {
  private eventSource: EventSource | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnects: number;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly url: string,
    private readonly opts: SSEConnectionOptions
  ) {
    this.maxReconnects = opts.maxReconnects ?? 5;
  }

  connect(): void {
    if (this.closed) return;

    this.eventSource = new EventSource(this.url);

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0;
      this.opts.onConnect?.();
    };

    this.eventSource.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      if (e.data === "[DONE]") return;
      try {
        const event = JSON.parse(e.data as string) as StreamEvent;
        this.opts.onEvent(event);
      } catch {
        // skip malformed events
      }
    };

    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = null;
      this.opts.onDisconnect?.();
      this.scheduleReconnect();
    };
  }

  disconnect(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.eventSource?.close();
    this.eventSource = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectAttempts >= this.maxReconnects) {
      if (!this.closed) {
        this.opts.onError(
          new ApiError(0, "SSE connection permanently lost", "network")
        );
      }
      return;
    }
    const delay = Math.min(1_000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

/**
 * SSE connection backed by fetch (supports custom headers and auth).
 * Streams an async generator of StreamEvents with reconnection.
 */
export async function* fetchSSE(
  url: string,
  opts?: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    maxReconnects?: number;
    onProgress?: (progress: StreamProgress) => void;
  }
): AsyncGenerator<StreamEvent> {
  const maxReconnects = opts?.maxReconnects ?? 5;
  let attempt = 0;

  while (true) {
    if (opts?.signal?.aborted) break;

    try {
      const res = await fetch(url, {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          ...opts?.headers,
        },
        signal: opts?.signal,
      });

      if (!res.ok) {
        throw new ApiError(res.status, `SSE connection failed: ${res.status}`);
      }

      // Reset attempt counter on successful connection
      attempt = 0;
      yield* parseStream(res, { signal: opts?.signal, onProgress: opts?.onProgress });

      // Clean disconnect — don't reconnect
      break;
    } catch (err) {
      if (err instanceof ApiError && err.type === "abort") break;
      if (opts?.signal?.aborted) break;
      if (attempt >= maxReconnects) throw err;

      const delay = Math.min(1_000 * Math.pow(2, attempt), 30_000);
      attempt++;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        opts?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new ApiError(0, "Cancelled", "abort"));
          },
          { once: true }
        );
      });
    }
  }
}
