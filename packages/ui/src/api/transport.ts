/**
 * The AgentRequestTransport interface and the default fetch-backed
 * implementation, plus the small helpers (body/header coercion, method rules)
 * the platform-specific transports share.
 */
export interface AgentRequestContext {
  /** Expected authenticated native owner, captured before asynchronous request work. */
  ownerId?: string;
  timeoutMs?: number;
  responseType?: "text" | "arraybuffer";
}

export interface AgentRequestTransport {
  request(
    url: string,
    init: RequestInit,
    context?: AgentRequestContext,
  ): Promise<Response>;
}

/** Per-call options accepted by `ElizaClient.fetch`. */
export interface ElizaClientFetchOptions<T> {
  allowNonOk?: boolean;
  timeoutMs?: number;
  /** Skip the 202 resume-retry loop (see `rawRequest.skipResume`). */
  skipResume?: boolean;
  /**
   * Called with the (bounded-read, best-effort-parsed) body when the FIRST
   * response is a 202 and `skipResume` is set — lets the status poll map the
   * cloud resume-progress body to a real value WITHOUT bypassing the shared
   * bounded body-read / timeout logic (#14040 sub-defect 2). Non-202
   * responses go through the normal strict-parse path unchanged.
   */
  on202?: (body: unknown) => T;
}

/**
 * The JSON request surface of `ElizaClient`. Plugin clients that only need a
 * session-bound fetch depend on this instead of the whole client class.
 */
export interface ElizaClientFetch {
  fetch<T>(
    path: string,
    init?: RequestInit,
    options?: ElizaClientFetchOptions<T>,
  ): Promise<T>;
}

export const fetchAgentTransport: AgentRequestTransport = {
  request(url, init) {
    return fetch(url, init);
  },
};

// ---------------------------------------------------------------------------
// Shared transport helpers — used by every native/desktop transport so the
// HTTP plumbing has a single definition each (no per-file copies that drift).
// ---------------------------------------------------------------------------

export function headersToRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) return {};
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

export function methodAllowsBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}

/**
 * Normalize a `BodyInit` into the scalar payload native bridges accept (they
 * cannot marshal streams/blobs). `null` is preserved distinct from `undefined`
 * so callers that care about an explicit empty body can tell them apart.
 */
export function bodyToString(
  body: BodyInit | null | undefined,
): string | null | undefined {
  if (body === null) return null;
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return undefined;
}

/**
 * An SSE / streaming request — the chat reply's token stream. Detected by the
 * `Accept: text/event-stream` header or a `…/stream` path. Parsing with a base
 * resolves relative URLs too; the substring check is the final fallback.
 */
export function isStreamingRequest(
  url: string,
  headers: HeadersInit | undefined,
): boolean {
  const accept = new Headers(headers ?? {}).get("accept") ?? "";
  if (accept.toLowerCase().includes("text/event-stream")) return true;
  try {
    return new URL(url, "http://localhost").pathname.endsWith("/stream");
  } catch {
    return url.includes("/stream");
  }
}

/** Reject unsupported bridge payloads rather than silently dropping their bytes. */
export function requireTextRequestBody(
  body: BodyInit | null | undefined,
): string | null | undefined {
  const text = bodyToString(body);
  if (text === undefined && body != null) {
    throw new TypeError(
      "This native bridge supports string and URLSearchParams request bodies only.",
    );
  }
  return text;
}

/** Bound a bridge wait without replaying a dispatched effect on cancellation. */
export async function awaitBridgeRequest<T>(
  request: () => Promise<T>,
  signal?: AbortSignal | null,
  timeoutMs?: number,
): Promise<T> {
  signal?.throwIfAborted();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    if (signal) {
      abortListener = () => reject(signal.reason);
      signal.addEventListener("abort", abortListener, { once: true });
    }
    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(
        () =>
          reject(
            new DOMException(
              "The native bridge request timed out",
              "TimeoutError",
            ),
          ),
        timeoutMs,
      );
    }
  });
  try {
    return await Promise.race([request(), interrupted]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (signal && abortListener)
      signal.removeEventListener("abort", abortListener);
  }
}

export function findSseEventBreak(chunkBuffer: string): {
  index: number;
  length: number;
} | null {
  const lfBreak = chunkBuffer.indexOf("\n\n");
  const crlfBreak = chunkBuffer.indexOf("\r\n\r\n");
  if (lfBreak === -1 && crlfBreak === -1) return null;
  if (lfBreak === -1) return { index: crlfBreak, length: 4 };
  if (crlfBreak === -1) return { index: lfBreak, length: 2 };
  return lfBreak < crlfBreak
    ? { index: lfBreak, length: 2 }
    : { index: crlfBreak, length: 4 };
}

/** Incremental SSE line framing. Decode bytes and validate event data in the
 * owning transport; this layer preserves lines without interpreting payloads.
 * Pending fragments are joined only once, when a line ends, so one large event
 * split across small network chunks does not repeatedly scan its old prefix. */
export class SseEventFramer {
  private lineParts: string[] = [];
  private lines: string[] = [];

  /** Returns true when the consumer stops at a terminal event. */
  push(chunk: string, onEvent: (lines: readonly string[]) => boolean): boolean {
    let start = 0;
    while (true) {
      const boundary = chunk.indexOf("\n", start);
      if (boundary === -1) break;
      this.lineParts.push(chunk.slice(start, boundary));
      const line = this.lineParts.join("").replace(/\r$/, "");
      this.lineParts = [];
      start = boundary + 1;
      if (line !== "") {
        this.lines.push(line);
        continue;
      }
      const event = this.lines;
      this.lines = [];
      if (onEvent(event) === true) return true;
    }
    if (start < chunk.length) this.lineParts.push(chunk.slice(start));
    return false;
  }

  /** A host may accept an unterminated final event; strict hosts reject EOF. */
  takePending(): readonly string[] {
    const lines = this.lines;
    if (this.lineParts.length) lines.push(this.lineParts.join(""));
    this.lines = [];
    this.lineParts = [];
    return lines;
  }
}
