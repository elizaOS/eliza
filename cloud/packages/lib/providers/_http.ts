/**
 * Shared HTTP fetch helper for direct OpenAI-compatible providers
 * (OpenRouter, OpenAI direct, Anthropic direct).
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
  /** Display name used in `message` strings, e.g. "OpenRouter". */
  display: string;
  /** Snake-case slug used in `error.type` for upstream-shaped errors, e.g. "openrouter_error". */
  errorType: string;
  /** Snake-case slug used in `error.code` for generic upstream failures, e.g. "openrouter_request_failed". */
  requestFailedCode: string;
  /** Snake-case slug used in `error.code` for timeouts, e.g. "openrouter_timeout". */
  timeoutCode: string;
}

interface UpstreamErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

export async function providerFetchWithTimeout(
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
      let errorData: UpstreamErrorBody | null = null;
      try {
        errorData = JSON.parse(await response.text()) as UpstreamErrorBody;
      } catch {
        // fall through to generic error below
      }

      if (errorData?.error) {
        const httpError: ProviderHttpError = {
          status: response.status,
          error: {
            message:
              errorData.error.message ??
              `${label.display} request failed with status ${response.status}`,
            type: errorData.error.type,
            code: errorData.error.code,
          },
        };
        throw httpError;
      }

      const httpError: ProviderHttpError = {
        status: response.status,
        error: {
          message: `${label.display} request failed with status ${response.status}`,
          type: label.errorType,
          code: label.requestFailedCode,
        },
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
