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
    public originalError?: any,
    public details?: Record<string, any>,
  ) {
    super(message);
    this.name = "TwitterError";
  }
}

export function getErrorType(error: any): TwitterErrorType {
  const message = error?.message?.toLowerCase() || "";
  const code = error?.code || error?.response?.status;

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

  if (code >= 400 && code < 500) {
    return TwitterErrorType.API;
  }

  return TwitterErrorType.UNKNOWN;
}

export function handleTwitterError(
  context: string,
  error: any,
  throwError = false,
): TwitterError | null {
  const errorType = getErrorType(error);
  const errorMessage = error?.message || String(error);

  const twitterError = new TwitterError(
    errorType,
    `${context}: ${errorMessage}`,
    error,
    {
      context,
      timestamp: new Date().toISOString(),
      ...(error?.response && { response: error.response }),
    },
  );

  // Log based on error type
  switch (errorType) {
    case TwitterErrorType.AUTH:
      logger.error(`[Twitter Auth Error] ${context}:`, errorMessage);
      break;
    case TwitterErrorType.RATE_LIMIT:
      logger.warn(`[Twitter Rate Limit] ${context}:`, errorMessage);
      break;
    case TwitterErrorType.NETWORK:
      logger.warn(`[Twitter Network Error] ${context}:`, errorMessage);
      break;
    default:
      logger.error(`[Twitter Error] ${context}:`, errorMessage);
  }

  if (throwError) {
    throw twitterError;
  }

  return twitterError;
}

export function isRetryableError(error: TwitterError | any): boolean {
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

export function getRetryDelay(
  error: TwitterError | any,
  attempt: number,
): number {
  const baseDelay = 1000; // 1 second
  const maxDelay = 60000; // 60 seconds

  if (
    error instanceof TwitterError ||
    getErrorType(error) === TwitterErrorType.RATE_LIMIT
  ) {
    // For rate limits, use longer delays
    return Math.min(baseDelay * Math.pow(2, attempt) * 5, maxDelay);
  }

  // Exponential backoff for other errors
  return Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
}
