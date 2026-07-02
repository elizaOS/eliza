/**
 * Shared HTTP fetch helper for direct OpenAI-compatible providers
 * (BitRouter, OpenAI direct, Anthropic direct).
 *
 * Each provider's `fetchWithTimeout` was a near-identical copy that:
 *   - merged its caller's AbortSignal with a per-call timeout signal,
 *   - parsed the upstream error JSON envelope into the shared
 *     `ProviderHttpError` shape, and
 *   - distinguished caller-abort (499) from timeout (504).
 *
 * The only differences were the provider label baked into error
 * `type`/`code` strings. This helper accepts a `ProviderLabel` to
 * preserve those provider-specific identifiers verbatim for callers
 * that switch on them.
 */
import type { ProviderHttpError } from "./types";

export interface ProviderLabel {
  /** Display name used in `message` strings, e.g. "BitRouter". */
  display: string;
  /** Snake-case slug used in `error.type` for upstream-shaped errors, e.g. "bitrouter_error". */
  errorType: string;
  /** Snake-case slug used in `error.code` for generic upstream failures, e.g. "bitrouter_request_failed". */
  requestFailedCode: string;
  /** Snake-case slug used in `error.code` for timeouts, e.g. "bitrouter_timeout". */
  timeoutCode: string;
}

interface UpstreamErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

/**
 * Transient upstream statuses worth a retry. These are recoverable hiccups in
 * the bitrouter -> openrouter -> upstream-provider path, NOT real request
 * errors:
 *   429 — upstream provider rate-limited (openrouter rotates providers; a
 *         retry frequently lands on a healthy one).
 *   502 — bitrouter's "chat completion returned neither content nor tool
 *         calls" (a provider momentarily returned an empty body).
 *   503/504 — upstream unavailable / gateway timeout.
 * Empirically (GLM 5.2 via bitrouter), identical requests bounce between
 * 429/502/200; ~62% raw success -> ~95% with 3 attempts, ~98% with 4.
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Exported (with {@link PROVIDER_MAX_BACKOFF_DELAY_MS}) so the stale-reservation
 * sweep can derive its grace window from the real worst-case in-flight time of
 * this retry ladder instead of hardcoding a number that drifts (#11683).
 */
export const PROVIDER_DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 400;
export const PROVIDER_MAX_BACKOFF_DELAY_MS = 8_000;

export interface ProviderRetryOptions {
  /** Max RETRY attempts after the first try (so total tries = maxRetries + 1). */
  maxRetries?: number;
  /** Base delay for exponential backoff (ms). */
  baseDelayMs?: number;
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Honor `Retry-After` (seconds or HTTP-date); fall back to capped exp backoff + jitter. */
function computeBackoffMs(attempt: number, baseDelayMs: number, retryAfter: string | null): number {
  if (retryAfter) {
    const asNumber = Number(retryAfter);
    if (Number.isFinite(asNumber) && asNumber >= 0) {
      return Math.min(asNumber * 1000, PROVIDER_MAX_BACKOFF_DELAY_MS);
    }
    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) {
      return Math.min(Math.max(asDate - Date.now(), 0), PROVIDER_MAX_BACKOFF_DELAY_MS);
    }
  }
  const exp = Math.min(baseDelayMs * 2 ** attempt, PROVIDER_MAX_BACKOFF_DELAY_MS);
  // Full jitter so concurrent callers don't synchronize their retries.
  return Math.floor(Math.random() * exp);
}

/**
 * A request can be safely replayed only if its body is NOT a one-shot stream
 * (a consumed ReadableStream cannot be re-sent) and the caller did not opt into
 * streaming the *response* (we must not retry mid-stream once bytes are read).
 */
function isReplayable(options: RequestInit): boolean {
  const body = options.body;
  if (body instanceof ReadableStream) return false;
  return true;
}

export async function providerFetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  label: ProviderLabel,
  retry?: ProviderRetryOptions,
): Promise<Response> {
  const maxRetries = isReplayable(options)
    ? (retry?.maxRetries ?? PROVIDER_DEFAULT_MAX_RETRIES)
    : 0;
  const baseDelayMs = retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const callerSignal = options.signal ?? null;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await providerFetchOnce(url, options, timeoutMs, label);
    } catch (error) {
      lastError = error;
      const status =
        error && typeof error === "object" && "status" in error
          ? (error as ProviderHttpError).status
          : undefined;
      const retryable =
        attempt < maxRetries && status !== undefined && RETRYABLE_STATUSES.has(status);
      if (!retryable) throw error;
      const retryAfter =
        error && typeof error === "object" && "retryAfter" in error
          ? ((error as { retryAfter?: string }).retryAfter ?? null)
          : null;
      const delayMs = computeBackoffMs(attempt, baseDelayMs, retryAfter);
      await sleep(delayMs, callerSignal);
    }
  }
  throw lastError;
}

async function providerFetchOnce(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  label: ProviderLabel,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  try {
    const response = await fetch(url, { ...options, signal });

    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after") ?? undefined;
      let errorData: UpstreamErrorBody | null = null;
      try {
        errorData = JSON.parse(await response.text()) as UpstreamErrorBody;
      } catch {
        // fall through to generic error below
      }

      if (errorData?.error) {
        const httpError: ProviderHttpError & { retryAfter?: string } = {
          status: response.status,
          error: {
            message:
              errorData.error.message ??
              `${label.display} request failed with status ${response.status}`,
            type: errorData.error.type,
            code: errorData.error.code,
          },
          ...(retryAfter ? { retryAfter } : {}),
        };
        throw httpError;
      }

      const httpError: ProviderHttpError & { retryAfter?: string } = {
        status: response.status,
        error: {
          message: `${label.display} request failed with status ${response.status}`,
          type: label.errorType,
          code: label.requestFailedCode,
        },
        ...(retryAfter ? { retryAfter } : {}),
      };
      throw httpError;
    }

    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      // Caller-initiated abort takes precedence over timeout; fetch surfaces
      // both as AbortError, so we disambiguate via signal state.
      if (options.signal?.aborted) {
        const httpError: ProviderHttpError = {
          status: 499,
          error: {
            message: `${label.display} request aborted`,
            type: "abort_error",
            code: "request_aborted",
          },
        };
        throw httpError;
      }
      const httpError: ProviderHttpError = {
        status: 504,
        error: {
          message: `${label.display} request timeout after ${Math.floor(timeoutMs / 1000)} seconds`,
          type: "timeout_error",
          code: label.timeoutCode,
        },
      };
      throw httpError;
    }

    // Re-throw structured ProviderHttpError or any other unexpected error.
    throw error;
  }
}
