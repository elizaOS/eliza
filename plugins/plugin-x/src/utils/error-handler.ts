/**
 * Classifies raw twitter-api-v2 errors into a `TwitterErrorType` (auth, rate-limit,
 * API, network, media) so callers can react — back off on rate limits, surface auth
 * failures — instead of treating every failure the same. Shared across the client
 * layer and the autonomous loops.
 */
import { logger } from "@elizaos/core";

export enum TwitterErrorType {
  AUTH = "AUTH",
  RATE_LIMIT = "RATE_LIMIT",
  API = "API",
  NETWORK = "NETWORK",
  MEDIA = "MEDIA",
  VALIDATION = "VALIDATION",
  UNKNOWN = "UNKNOWN",
}

export class TwitterError extends Error {
  constructor(
    public type: TwitterErrorType,
    message: string,
    public originalError?: unknown,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TwitterError";
  }
}

/**
 * Shape we optimistically probe on unknown error values. Twitter API + network
 * libraries emit errors with a mix of `message`, `code`, and `response.status`.
 */
interface ProbableErrorShape {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  data?: { status?: unknown };
  response?: { status?: unknown };
}

const RETRYABLE_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function nestedProviderError(error: unknown): unknown {
  if (error instanceof TwitterError && error.originalError !== undefined) {
    return error.originalError;
  }
  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return undefined;
  }
  return (error as { cause?: unknown }).cause;
}

function directProviderStatus(error: unknown): number | undefined {
  const probed = probeError(error);
  const candidate =
    probed.data?.status ??
    probed.response?.status ??
    probed.status ??
    probed.code;
  if (typeof candidate === "number" && Number.isInteger(candidate)) {
    return candidate;
  }
  if (typeof candidate === "string" && /^(?:[1-5]\d\d)$/.test(candidate)) {
    return Number(candidate);
  }
  return undefined;
}

/** Returns the first structured HTTP status retained by an error/cause chain. */
export function getTwitterProviderStatus(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const status = directProviderStatus(current);
    if (status !== undefined) return status;
    current = nestedProviderError(current);
  }
  return undefined;
}

function structuredProviderErrorType(
  error: unknown,
): TwitterErrorType | undefined {
  const status = directProviderStatus(error);
  if (status === 401 || status === 403) return TwitterErrorType.AUTH;
  if (status === 429) return TwitterErrorType.RATE_LIMIT;
  if (status === 400 || status === 422) return TwitterErrorType.VALIDATION;
  if (status !== undefined && status >= 400 && status < 500) {
    return TwitterErrorType.API;
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return TwitterErrorType.NETWORK;
  }

  const code = probeError(error).code;
  if (
    typeof code === "string" &&
    RETRYABLE_NETWORK_CODES.has(code.toUpperCase())
  ) {
    return TwitterErrorType.NETWORK;
  }
  return undefined;
}

/**
 * Converts only structured provider evidence into a typed X error.
 *
 * Arbitrary prose is deliberately not classified: a message containing
 * "rate limit" is not proof that a request was rejected before acceptance.
 */
export function normalizeTwitterProviderError(
  error: unknown,
): TwitterError | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (
      current instanceof TwitterError &&
      current.type !== TwitterErrorType.UNKNOWN
    ) {
      return current;
    }

    const type = structuredProviderErrorType(current);
    if (type !== undefined) {
      const message =
        current instanceof Error && current.message.trim().length > 0
          ? current.message
          : `X provider request failed (${type})`;
      return new TwitterError(type, message, current);
    }
    current = nestedProviderError(current);
  }
  return null;
}

function probeError(error: unknown): ProbableErrorShape {
  if (typeof error === "object" && error !== null) {
    return error as ProbableErrorShape;
  }
  return {};
}

function errorMessage(error: unknown): string {
  const probed = probeError(error);
  return typeof probed.message === "string" ? probed.message.toLowerCase() : "";
}

function errorCode(error: unknown): number | undefined {
  const probed = probeError(error);
  if (typeof probed.code === "number") return probed.code;
  const status =
    probed.data?.status ?? probed.response?.status ?? probed.status;
  if (typeof status === "number") return status;
  return undefined;
}

/** A concrete 4xx response proves the provider rejected the write pre-acceptance. */
export function isExplicitTwitterRejection(error: unknown): boolean {
  const status = errorCode(error);
  return status !== undefined && status >= 400 && status < 500;
}

export function getErrorType(error: unknown): TwitterErrorType {
  const message = errorMessage(error);
  const code = errorCode(error);

  if (
    code === 401 ||
    message.includes("unauthorized") ||
    message.includes("authentication")
  ) {
    return TwitterErrorType.AUTH;
  }

  if (
    code === 429 ||
    message.includes("rate limit") ||
    message.includes("too many requests")
  ) {
    return TwitterErrorType.RATE_LIMIT;
  }

  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("econnrefused")
  ) {
    return TwitterErrorType.NETWORK;
  }

  if (message.includes("media") || message.includes("upload")) {
    return TwitterErrorType.MEDIA;
  }

  if (
    message.includes("invalid") ||
    message.includes("missing") ||
    message.includes("required")
  ) {
    return TwitterErrorType.VALIDATION;
  }

  if (code !== undefined && code >= 400 && code < 500) {
    return TwitterErrorType.API;
  }

  return TwitterErrorType.UNKNOWN;
}

export function handleTwitterError(
  context: string,
  error: unknown,
  throwError = false,
): TwitterError | null {
  const errorType = getErrorType(error);
  const probed = probeError(error);
  const errorMessageStr =
    typeof probed.message === "string" ? probed.message : String(error);

  const details: Record<string, unknown> = {
    context,
    timestamp: new Date().toISOString(),
  };
  if (probed.response !== undefined) {
    details.response = probed.response;
  }

  const twitterError = new TwitterError(
    errorType,
    `${context}: ${errorMessageStr}`,
    error,
    details,
  );

  switch (errorType) {
    case TwitterErrorType.AUTH:
      logger.error(`[Twitter Auth Error] ${context}:`, errorMessageStr);
      break;
    case TwitterErrorType.RATE_LIMIT:
      logger.warn(`[Twitter Rate Limit] ${context}:`, errorMessageStr);
      break;
    case TwitterErrorType.NETWORK:
      logger.warn(`[Twitter Network Error] ${context}:`, errorMessageStr);
      break;
    default:
      logger.error(`[Twitter Error] ${context}:`, errorMessageStr);
  }

  if (throwError) {
    throw twitterError;
  }

  return twitterError;
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof TwitterError) {
    return [TwitterErrorType.RATE_LIMIT, TwitterErrorType.NETWORK].includes(
      error.type,
    );
  }

  const errorType = getErrorType(error);
  return [TwitterErrorType.RATE_LIMIT, TwitterErrorType.NETWORK].includes(
    errorType,
  );
}

export function getRetryDelay(error: unknown, attempt: number): number {
  const baseDelay = 1000;
  const maxDelay = 60000;

  if (
    error instanceof TwitterError ||
    getErrorType(error) === TwitterErrorType.RATE_LIMIT
  ) {
    return Math.min(baseDelay * 2 ** attempt * 5, maxDelay);
  }

  return Math.min(baseDelay * 2 ** attempt, maxDelay);
}
