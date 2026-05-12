import { logger } from "@elizaos/core";

export interface RetryConfig {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffFactor: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 4_000,
  backoffFactor: 2,
};

type RetryableError = {
  readonly cause?: unknown;
  readonly data?: unknown;
  readonly isRetryable?: boolean;
  readonly message?: string;
  readonly name?: string;
  readonly responseBody?: unknown;
  readonly status?: number;
  readonly statusCode?: number;
};

function getRetryableError(error: unknown): RetryableError | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  return error as RetryableError;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function readProviderErrorMessage(error: unknown): string | undefined {
  const retryableError = getRetryableError(error);
  const data = retryableError?.data;
  if (data && typeof data === "object") {
    const providerError = (data as { error?: { message?: unknown } }).error;
    if (typeof providerError?.message === "string" && providerError.message.trim()) {
      return providerError.message.trim();
    }
  }

  const responseBody = retryableError?.responseBody;
  if (typeof responseBody === "string" && responseBody.trim()) {
    try {
      const parsed = JSON.parse(responseBody) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string" && parsed.error.message.trim()) {
        return parsed.error.message.trim();
      }
    } catch {
      // Fall through to the SDK error message.
    }
  }

  const message = getErrorMessage(error).trim();
  return message.length > 0 ? message : undefined;
}

function getStatusCode(error: unknown): number | undefined {
  const retryableError = getRetryableError(error);
  return retryableError?.statusCode ?? retryableError?.status;
}

function hasTimeoutMessage(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("timed out") || message.includes("timeout");
}

function hasOverloadMessage(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("overload") ||
    message.includes("overloaded") ||
    message.includes("capacity") ||
    message.includes("temporarily unavailable")
  );
}

export function isRetryableModelError(error: unknown): boolean {
  const retryableError = getRetryableError(error);
  const statusCode = getStatusCode(error);

  return (
    retryableError?.isRetryable === true ||
    retryableError?.name === "AI_RetryError" ||
    retryableError?.name === "AbortError" ||
    statusCode === 408 ||
    statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    statusCode === 529 ||
    hasTimeoutMessage(error) ||
    hasOverloadMessage(error)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeWithRetry<T>(
  operationName: string,
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let delayMs = config.initialDelayMs;

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableModelError(error) || attempt === config.maxRetries) {
        throw error;
      }

      logger.warn(
        `[Anthropic] ${operationName} failed with retryable error ` +
          `(attempt ${attempt + 1} of ${config.maxRetries + 1} total): ${getErrorMessage(error)}`
      );

      await sleep(delayMs);
      delayMs = Math.min(Math.round(delayMs * config.backoffFactor), config.maxDelayMs);
    }
  }

  throw new Error(`[Anthropic] ${operationName} failed after exhausting retries.`);
}

export function formatModelError(operationName: string, error: unknown): Error {
  const statusCode = getStatusCode(error);
  const providerMessage = readProviderErrorMessage(error);
  let reason = "An unexpected error occurred while processing the request.";

  if (statusCode === 401) {
    reason = "Authentication failed. Check the configured Anthropic API key.";
  } else if (statusCode === 400 && providerMessage) {
    reason = providerMessage;
  } else if (statusCode === 403 && providerMessage) {
    reason = providerMessage;
  } else if (statusCode === 404 && providerMessage) {
    reason = providerMessage;
  } else if (statusCode === 413 && providerMessage) {
    reason = providerMessage;
  } else if (statusCode === 429) {
    reason = "Anthropic rate limited the request. Retry after a short delay.";
  } else if (statusCode === 504 || hasTimeoutMessage(error)) {
    reason = "The request timed out. Retry with a shorter prompt or a smaller max token limit.";
  } else if (statusCode === 529 || hasOverloadMessage(error)) {
    reason = "Anthropic is temporarily overloaded. Retry in a moment.";
  } else if (statusCode !== undefined && statusCode >= 500) {
    reason = "Anthropic is temporarily unavailable. Retry in a moment.";
  }

  const message = `[Anthropic] ${operationName} failed: ${reason}`;
  if (error instanceof Error) {
    return new Error(message, { cause: error });
  }
  return new Error(`${message} Original error: ${getErrorMessage(error)}`);
}

export function sanitizeUrlForLogs(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}
