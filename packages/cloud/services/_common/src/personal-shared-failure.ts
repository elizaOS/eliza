/**
 * Carries sanitized Personal Shared failure metadata across Worker and gateway
 * HTTP boundaries without exposing exception messages or provider payloads.
 */

export const ELIZA_FAILURE_STAGE_HEADER = "X-Eliza-Failure-Stage";
export const ELIZA_FAILURE_NAME_HEADER = "X-Eliza-Failure-Name";
export const ELIZA_FAILURE_CAUSE_NAME_HEADER = "X-Eliza-Failure-Cause-Name";
export const ELIZA_RETRYABLE_HEADER = "X-Eliza-Retryable";

/**
 * Stable across retries so the Telegram exact-once ledger always prepares the
 * same chunk plan even when the upstream failure classification changes.
 */
export const PERSONAL_SHARED_FAILURE_REPLY =
  "I couldn't complete that request just now. Please try again in a moment.";

const SAFE_FAILURE_STAGES = new Set([
  "account_claim",
  "account_resolution",
  "authentication",
  "connector_account",
  "consent",
  "dedicated_runtime",
  "media_description",
  "shared_runtime",
  "validation",
  "voice_transcription",
  "worker_context",
]);
const SAFE_FAILURE_NAMES = new Set([
  "AbortError",
  "ApiError",
  "Error",
  "HTTPException",
  "InsufficientCreditsError",
  "OtherError",
  "PersonalDeliveryAccountResolutionError",
  "RangeError",
  "RateLimitError",
  "SharedRuntimeCacheWarmingError",
  "SharedRuntimeTurnError",
  "SharedTurnConflictError",
  "TimeoutError",
  "TypeError",
]);
const SAFE_FAILURE_CAUSE_NAMES = new Set([
  "SharedRuntimeActionContractError",
  "SharedRuntimeNoReplyError",
  "SharedRuntimeProviderConfigurationError",
  "SharedRuntimeProviderRejectedError",
  "SharedRuntimeProviderUnavailableError",
  "SharedRuntimeTimeoutError",
  "SharedRuntimeUnknownError",
]);
const MAX_RETRY_AFTER_SECONDS = 300;

export interface PersonalSharedFailureMetadata {
  status: number;
  stage: string | null;
  name: string | null;
  causeName: string | null;
  retryable: boolean;
  retryAfterSeconds: number | null;
}

function safeClassification(
  value: string | null,
  allowed: ReadonlySet<string>,
): string | null {
  const normalized = value?.trim() ?? "";
  return allowed.has(normalized) ? normalized : null;
}

function retryableFromStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Read only bounded, allowlisted classification from an upstream response. */
export function readPersonalSharedFailureMetadata(
  response: Response,
): PersonalSharedFailureMetadata {
  const retryableHeader = response.headers.get(ELIZA_RETRYABLE_HEADER)?.trim();
  const retryAfterHeader = response.headers.get("Retry-After")?.trim() ?? "";
  const parsedRetryAfter = /^(?:0|[1-9]\d*)$/u.test(retryAfterHeader)
    ? Number(retryAfterHeader)
    : Number.NaN;
  return {
    status: response.status,
    stage: safeClassification(
      response.headers.get(ELIZA_FAILURE_STAGE_HEADER),
      SAFE_FAILURE_STAGES,
    ),
    name: safeClassification(
      response.headers.get(ELIZA_FAILURE_NAME_HEADER),
      SAFE_FAILURE_NAMES,
    ),
    causeName: safeClassification(
      response.headers.get(ELIZA_FAILURE_CAUSE_NAME_HEADER),
      SAFE_FAILURE_CAUSE_NAMES,
    ),
    retryable:
      retryableHeader === "true"
        ? true
        : retryableHeader === "false"
          ? false
          : retryableFromStatus(response.status),
    retryAfterSeconds:
      Number.isSafeInteger(parsedRetryAfter) && parsedRetryAfter >= 0
        ? Math.min(parsedRetryAfter, MAX_RETRY_AFTER_SECONDS)
        : null,
  };
}
