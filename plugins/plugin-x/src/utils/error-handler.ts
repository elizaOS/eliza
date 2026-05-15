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
  response?: { status?: unknown };
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
  const status = probed.response?.status;
  if (typeof status === "number") return status;
  return undefined;
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
