/**
 * Byte and time budgets for the two bodies the MCP proxy buffers into the
 * isolate.
 *
 * `route.ts` used to `await request.text()` / `await mcpResponse.text()` with
 * no byte budget and no hop deadline. The response far end is a URL the MCP's
 * owner chose (`external_endpoint`, reached through `safeFetch`), so isolate
 * memory and Worker wall-clock were picked by whoever registered the MCP.
 *
 * Bytes are charged before they are retained: a declared `content-length` over
 * budget is refused without a read; otherwise chunks copy into one fixed-size
 * slab and decode once. Fragmentation is capped independently so one-byte
 * chunks cannot multiply object overhead. Overflow and hop-abort cancel the
 * reader without awaiting it, but they keep the lock until that cancel settles
 * so `releaseLock()` cannot race a live `cancel()`. A never-settling or
 * rejecting cancel must not delay or replace the budget result.
 *
 * The hop deadline is clearable, composed with caller cancellation, and races
 * both `fetch` (via the returned signal) and every `reader.read()`.
 */

/** The subset of `Request` / `Response` this reader needs. */
export interface BudgetedBodySource {
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type BudgetedText =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly bytes: number;
      readonly reason: "byte-budget" | "fragmentation-budget" | "deadline";
    };

export interface ReadBodyBudgetOptions {
  readonly signal?: AbortSignal;
  readonly onCancelFailure?: (label: string, error: unknown) => void;
}

/**
 * Limit pull/decoder churn independently from payload bytes. A standard
 * transport should coalesce far below this count; rejecting a deliberately
 * one-byte-at-a-time stream prevents millions of isolate allocations/callbacks.
 */
const MAX_BODY_STREAM_CHUNKS = 8_192;

/**
 * Wall-clock bound for one metered MCP hop (outbound fetch plus every body
 * read). Same 30s class as the credential broker, the other
 * proxy-to-a-caller-supplied-host service.
 */
const DEFAULT_MCP_PROXY_HOP_TIMEOUT_MS = 30_000;
let hopTimeoutOverrideMs: number | null = null;

export const MCP_PROXY_HOP_TIMEOUT_MS = DEFAULT_MCP_PROXY_HOP_TIMEOUT_MS;

/**
 * Test-only seam for the hop deadline. The `__` prefix + `TestHooks` suffix
 * mark it as non-public.
 */
export const __mcpProxyHopTestHooks = {
  setHopTimeoutMs(ms: number): void {
    hopTimeoutOverrideMs = ms;
  },
  resetHopTimeoutMs(): void {
    hopTimeoutOverrideMs = null;
  },
  get hopTimeoutMs(): number {
    return hopTimeoutOverrideMs ?? DEFAULT_MCP_PROXY_HOP_TIMEOUT_MS;
  },
} as const;

/** Typed hop-deadline abort reason the route maps to a 504 refund. */
export class McpProxyHopDeadlineError extends Error {
  override readonly name = "McpProxyHopDeadlineError";
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`MCP proxy hop exceeded the ${timeoutMs}-millisecond deadline`);
    this.timeoutMs = timeoutMs;
  }
}

export function isMcpProxyHopDeadline(
  signal: AbortSignal,
  error?: unknown,
): boolean {
  if (error instanceof McpProxyHopDeadlineError) return true;
  if (signal.reason instanceof McpProxyHopDeadlineError) return true;
  const named = error instanceof Error ? error : null;
  if (named?.name === "TimeoutError") return true;
  return (
    signal.aborted &&
    signal.reason instanceof Error &&
    signal.reason.name === "TimeoutError"
  );
}

export interface McpProxyHopDeadline {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  clear(): void;
}

/**
 * Clearable end-to-end hop deadline composed with any caller cancellation.
 * Callers pass `signal` to both `fetch`/`safeFetch` and
 * {@link readBodyTextWithinBudget}, then `clear()` once the hop settles.
 */
export function createMcpProxyHopDeadline(
  caller?: AbortSignal | null,
): McpProxyHopDeadline {
  const timeoutMs = __mcpProxyHopTestHooks.hopTimeoutMs;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new McpProxyHopDeadlineError(timeoutMs));
  }, timeoutMs);

  let cleared = false;
  const clear = (): void => {
    if (cleared) return;
    cleared = true;
    clearTimeout(timeoutId);
  };

  if (caller?.aborted) {
    clear();
    return { signal: caller, timeoutMs, clear };
  }

  const signal = caller
    ? AbortSignal.any([controller.signal, caller])
    : controller.signal;
  signal.addEventListener("abort", clear, { once: true });
  return { signal, timeoutMs, clear };
}

/**
 * The declared body length, or `null` when the header is absent or is not a
 * plain decimal integer that survives `Number.isSafeInteger`. A header that
 * cannot be trusted is not treated as a budget grant — such a body falls
 * through to the streamed charge below.
 */
export function parseTrustworthyContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function resolveReadOptions(
  options?: ReadBodyBudgetOptions | ((label: string, error: unknown) => void),
): ReadBodyBudgetOptions {
  if (typeof options === "function") {
    return { onCancelFailure: options };
  }
  return options ?? {};
}

function cancelBestEffort(
  target: { cancel: () => Promise<unknown> },
  label: string,
  onCancelFailure?: (label: string, error: unknown) => void,
): void {
  const report = (error: unknown) => onCancelFailure?.(label, error);
  try {
    target.cancel().catch(report);
  } catch (error) {
    // error-policy:J6 best-effort teardown for a body already rejected.
    report(error);
  }
}

function releaseLockQuietly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    reader.releaseLock();
  } catch {
    // error-policy:J6 cancel() may already have released the lock.
  }
}

/**
 * Detached, no-throw cancellation that keeps reader ownership until `cancel()`
 * settles. The budget/deadline result must not await this promise: a
 * never-settling or rejecting cancel cannot delay or replace it.
 */
function cancelReaderRetainingOwnership(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  label: string,
  onCancelFailure?: (label: string, error: unknown) => void,
): void {
  let cancelPromise: Promise<unknown>;
  try {
    cancelPromise = reader.cancel();
  } catch (error) {
    // error-policy:J6 synchronous cancellation is best-effort teardown.
    onCancelFailure?.(label, error);
    releaseLockQuietly(reader);
    return;
  }
  void cancelPromise.then(
    () => {
      releaseLockQuietly(reader);
    },
    (error: unknown) => {
      onCancelFailure?.(label, error);
      releaseLockQuietly(reader);
    },
  );
}

function hopAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function deadlineFailure(bytes: number): BudgetedText {
  return { ok: false, bytes, reason: "deadline" };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new McpProxyHopDeadlineError(__mcpProxyHopTestHooks.hopTimeoutMs);
}

function isHopFailure(
  signal: AbortSignal | undefined,
  error?: unknown,
): boolean {
  if (!signal) return false;
  return hopAborted(signal) || isMcpProxyHopDeadline(signal, error);
}

/**
 * Race `promise` against `signal` without leaving an abort listener attached
 * after the read wins. Abort does not cancel the underlying promise; the
 * caller must cancel the reader so a hanging `read()` cannot retain the hop.
 */
function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Reads `source`'s body as text, refusing it as soon as `maxBytes` is exceeded
 * or the hop signal aborts.
 *
 * On refusal `bytes` is the size the refusal was made on: the declared
 * `content-length` when the pre-check fired, otherwise the running total at the
 * chunk that exceeded the byte or fragmentation budget, or the total received
 * when the hop deadline fired (a lower bound — the rest is never read).
 */
export async function readBodyTextWithinBudget(
  source: BudgetedBodySource,
  maxBytes: number,
  options?: ReadBodyBudgetOptions | ((label: string, error: unknown) => void),
): Promise<BudgetedText> {
  const { signal, onCancelFailure } = resolveReadOptions(options);
  const declaredLength = parseTrustworthyContentLength(source.headers);
  if (hopAborted(signal)) {
    if (source.body) {
      cancelBestEffort(source.body, "deadline-precheck", onCancelFailure);
    }
    return deadlineFailure(declaredLength ?? 0);
  }
  if (declaredLength !== null && declaredLength > maxBytes) {
    if (source.body) {
      cancelBestEffort(source.body, "content-length-precheck", onCancelFailure);
    }
    return { ok: false, bytes: declaredLength, reason: "byte-budget" };
  }

  if (!source.body) {
    try {
      const text = await raceWithAbort(source.text(), signal);
      return { ok: true, text };
    } catch (error) {
      // error-policy:J1 hop abort is a typed budget result, not an unhandled throw.
      if (isHopFailure(signal, error)) {
        return deadlineFailure(0);
      }
      throw error;
    }
  }

  const reader = source.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const retained = new Uint8Array(maxBytes);
  let received = 0;
  let chunkCount = 0;
  let cancelOwnsReader = false;

  const abortRead = (
    label: string,
    bytes: number,
    reason: "byte-budget" | "fragmentation-budget" | "deadline",
  ): BudgetedText => {
    cancelOwnsReader = true;
    cancelReaderRetainingOwnership(reader, label, onCancelFailure);
    if (reason === "deadline") return deadlineFailure(bytes);
    return { ok: false, bytes, reason };
  };

  try {
    while (true) {
      if (hopAborted(signal)) {
        return abortRead("deadline", received, "deadline");
      }
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      chunkCount += 1;
      received += value.byteLength;
      if (received > maxBytes) {
        return abortRead("streamed-budget", received, "byte-budget");
      }
      if (chunkCount > MAX_BODY_STREAM_CHUNKS) {
        return abortRead(
          "streamed-fragmentation",
          received,
          "fragmentation-budget",
        );
      }
      retained.set(value, received - value.byteLength);
    }
  } catch (error) {
    // error-policy:J1 hop abort is a typed budget result, not an unhandled throw.
    if (isHopFailure(signal, error)) {
      return abortRead("deadline", received, "deadline");
    }
    throw error;
  } finally {
    if (!cancelOwnsReader) {
      releaseLockQuietly(reader);
    }
  }

  return { ok: true, text: decoder.decode(retained.subarray(0, received)) };
}
