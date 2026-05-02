import { logger } from "@elizaos/core";

export enum XErrorType {
  AUTH = "AUTH",
  RATE_LIMIT = "RATE_LIMIT",
  API = "API",
  NETWORK = "NETWORK",
  MEDIA = "MEDIA",
  VALIDATION = "VALIDATION",
  UNKNOWN = "UNKNOWN",
}

export class XError extends Error {
  constructor(
    public type: XErrorType,
    message: string,
    public originalError?: unknown,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "XError";
  }
}

export function getErrorType(error: unknown): XErrorType {
  const errorObj = error as { message?: string; code?: number; response?: { status?: number } };
  const message = errorObj?.message?.toLowerCase() || "";
  const code = errorObj?.code || errorObj?.response?.status;

  if (code === 401 || message.includes("unauthorized") || message.includes("authentication")) {
    return XErrorType.AUTH;
  }

  if (code === 429 || message.includes("rate limit") || message.includes("too many requests")) {
    return XErrorType.RATE_LIMIT;
  }

  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("econnrefused")
  ) {
    return XErrorType.NETWORK;
  }

  if (message.includes("media") || message.includes("upload")) {
    return XErrorType.MEDIA;
  }

  if (message.includes("invalid") || message.includes("missing") || message.includes("required")) {
    return XErrorType.VALIDATION;
  }

  if (code !== undefined && code >= 400 && code < 500) {
    return XErrorType.API;
  }

  return XErrorType.UNKNOWN;
}

export function handleXError(context: string, error: unknown, throwError = false): XError | null {
  const errorType = getErrorType(error);
  const errorObj = error as { message?: string; response?: unknown };
  const errorMessage = errorObj?.message || String(error);

  const xError = new XError(errorType, `${context}: ${errorMessage}`, error, {
    context,
    timestamp: new Date().toISOString(),
    ...(errorObj?.response && typeof errorObj.response === "object" && errorObj.response !== null
      ? { response: errorObj.response }
      : {}),
  });

  switch (errorType) {
    case XErrorType.AUTH:
      logger.error(`[X Auth Error] ${context}:`, errorMessage);
      break;
    case XErrorType.RATE_LIMIT:
      logger.warn(`[X Rate Limit] ${context}:`, errorMessage);
      break;
    case XErrorType.NETWORK:
      logger.warn(`[X Network Error] ${context}:`, errorMessage);
      break;
    default:
      logger.error(`[X Error] ${context}:`, errorMessage);
  }

  if (throwError) {
    throw xError;
  }

  return xError;
}

export function isRetryableError(error: XError | unknown): boolean {
  if (error instanceof XError) {
    return [XErrorType.RATE_LIMIT, XErrorType.NETWORK].includes(error.type);
  }

  const errorType = getErrorType(error);
  return [XErrorType.RATE_LIMIT, XErrorType.NETWORK].includes(errorType);
}

export function getRetryDelay(error: XError | unknown, attempt: number): number {
  const baseDelay = 1000;
  const maxDelay = 60000;

  if (error instanceof XError || getErrorType(error) === XErrorType.RATE_LIMIT) {
    return Math.min(baseDelay * 2 ** attempt * 5, maxDelay);
  }

  return Math.min(baseDelay * 2 ** attempt, maxDelay);
}
