/**
 * Defines dependency-free retry timing primitives shared across Cloud HTTP
 * policies without prescribing which requests or statuses may be replayed.
 */

export interface BackoffOptions {
  attempt: number;
  baseDelayMs: number;
  capMs: number;
  retryAfter: string | null;
  nowMs?: number;
  random?: () => number;
}

export function parseRetryAfterMs(
  value: string | null,
  options: { nowMs?: number; capMs?: number } = {},
): number | null {
  if (value === null || value.trim() === "") return null;
  const nowMs = options.nowMs ?? Date.now();
  const capMs = options.capMs ?? Number.MAX_SAFE_INTEGER;
  const normalized = value.trim();
  if (/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    const seconds = Number(normalized);
    if (!Number.isFinite(seconds) || seconds > capMs / 1_000) return capMs;
    return Math.min(seconds * 1_000, capMs);
  }
  const dateMs = Date.parse(normalized);
  if (Number.isNaN(dateMs)) return null;
  return Math.min(Math.max(dateMs - nowMs, 0), capMs);
}

export function computeBackoffMs(options: BackoffOptions): number {
  const explicitDelay = parseRetryAfterMs(options.retryAfter, {
    nowMs: options.nowMs,
    capMs: options.capMs,
  });
  if (explicitDelay !== null) return explicitDelay;
  const exponential = Math.min(
    options.baseDelayMs * 2 ** Math.max(0, options.attempt),
    options.capMs,
  );
  const random = options.random ?? Math.random;
  return Math.floor(Math.max(0, Math.min(1, random())) * exponential);
}

export function sleepWithAbort(
  delayMs: number,
  signal?: AbortSignal | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
