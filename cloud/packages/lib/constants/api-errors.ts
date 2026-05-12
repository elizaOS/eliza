/**
 * Standardized API error messages.
 *
 * Use these constants for consistent error responses across all API endpoints.
 * Each category includes both user-facing messages and internal error codes.
 */

// =============================================================================
// Common HTTP Error Messages
// =============================================================================

export const API_ERRORS = {
  // Authentication & Authorization
  UNAUTHORIZED: "Unauthorized",
  FORBIDDEN: "Access denied",
  SESSION_EXPIRED: "Session expired",
  INVALID_TOKEN: "Invalid authentication token",
  AUTHENTICATION_REQUIRED: "Authentication required",

  // Resource Errors
  NOT_FOUND: "Resource not found",
  ORGANIZATION_NOT_FOUND: "Organization not found",
  PAYMENT_NOT_FOUND: "Payment not found",
  AGENT_NOT_FOUND: "Agent not found",
  USER_NOT_FOUND: "User not found",
  CHAT_NOT_FOUND: "Chat not found",
  CONTAINER_NOT_FOUND: "Container not found",
  SESSION_NOT_FOUND: "Session not found",

  // Validation Errors
  VALIDATION_FAILED: "Validation failed",
  INVALID_REQUEST_FORMAT: "Invalid request format",
  MISSING_REQUIRED_FIELDS: "Missing required fields",
  INVALID_UUID: "Invalid UUID format",
  INVALID_AMOUNT: "Invalid amount",

  // Payment Specific
  PAYMENT_EXPIRED: "Payment has expired",
  PAYMENT_FAILED: "Payment has failed",
  PAYMENT_ALREADY_CONFIRMED: "Payment already confirmed",
  PAYMENT_AMOUNT_TOO_SMALL: "Payment amount is too small",
  PAYMENT_AMOUNT_TOO_LARGE: "Payment amount exceeds maximum",
  INVALID_TRANSACTION_HASH: "Invalid transaction hash format",
  TRANSACTION_ALREADY_USED: "Transaction already processed",
  INSUFFICIENT_CONFIRMATIONS: "Insufficient blockchain confirmations",

  // Service Errors
  SERVICE_UNAVAILABLE: "Service temporarily unavailable",
  SERVICE_NOT_CONFIGURED: "Service not configured",
  RATE_LIMITED: "Rate limit exceeded",
  INTERNAL_ERROR: "Internal server error",

  // Processing Errors
  PROCESSING_FAILED: "Failed to process request",
  CONFIRMATION_FAILED: "Failed to process confirmation",
  WEBHOOK_PROCESSING_FAILED: "Failed to process webhook",

  // Crypto Specific
  CRYPTO_SERVICE_UNAVAILABLE: "Crypto payments not available",
  CRYPTO_NETWORK_INVALID: "Invalid network configuration",

  // File/Resource Operations
  UPLOAD_FAILED: "Failed to upload file",
  DOWNLOAD_FAILED: "Failed to download resource",
  STORAGE_ERROR: "Storage operation failed",
} as const;

export type ApiErrorCode = keyof typeof API_ERRORS;
export type ApiErrorMessage = (typeof API_ERRORS)[ApiErrorCode];

// =============================================================================
// Error Response Helpers
// =============================================================================

export interface ApiErrorResponse {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}

/**
 * Create a standardized error response object.
 *
 * @param errorCode - The error code from API_ERRORS
 * @param details - Optional additional details
 * @returns Standardized error response object
 */
export function createErrorResponse(
  errorCode: ApiErrorCode,
  details?: Record<string, unknown>,
): ApiErrorResponse {
  const response: ApiErrorResponse = {
    error: API_ERRORS[errorCode],
    code: errorCode,
  };

  if (details) {
    response.details = details;
  }

  return response;
}

/**
 * Create an error response with a custom message while maintaining structure.
 *
 * @param message - Custom error message
 * @param code - Optional error code
 * @param details - Optional additional details
 * @returns Standardized error response object
 */
export function createCustomErrorResponse(
  message: string,
  code?: string,
  details?: Record<string, unknown>,
): ApiErrorResponse {
  const response: ApiErrorResponse = {
    error: message,
  };

  if (code) {
    response.code = code;
  }

  if (details) {
    response.details = details;
  }

  return response;
}

/**
 * Map common error patterns to standardized error codes.
 *
 * @param error - The error to analyze
 * @returns The appropriate API error code
 */
export function getErrorCodeFromException(error: unknown): ApiErrorCode {
  if (!(error instanceof Error)) {
    return "INTERNAL_ERROR";
  }

  const message = error.message.toLowerCase();

  // UUID validation errors
  if (message.includes("invalid") && message.includes("uuid")) {
    return "INVALID_UUID";
  }

  // Amount validation errors
  if (message.includes("amount must be at least")) {
    return "PAYMENT_AMOUNT_TOO_SMALL";
  }

  if (message.includes("amount must not exceed")) {
    return "PAYMENT_AMOUNT_TOO_LARGE";
  }

  // Service configuration errors
  if (message.includes("not configured") || message.includes("service not")) {
    return "SERVICE_NOT_CONFIGURED";
  }

  // Not found errors
  if (message.includes("not found")) {
    return "NOT_FOUND";
  }

  // Expired errors
  if (message.includes("expired")) {
    return "PAYMENT_EXPIRED";
  }

  // Default to internal error
  return "INTERNAL_ERROR";
}

/**
 * Get HTTP status code for an error code.
 *
 * @param errorCode - The API error code
 * @returns Appropriate HTTP status code
 */
export function getStatusCodeForError(errorCode: ApiErrorCode): number {
  switch (errorCode) {
    case "UNAUTHORIZED":
    case "INVALID_TOKEN":
    case "SESSION_EXPIRED":
      return 401;

    case "FORBIDDEN":
      return 403;

    case "NOT_FOUND":
    case "ORGANIZATION_NOT_FOUND":
    case "PAYMENT_NOT_FOUND":
    case "AGENT_NOT_FOUND":
    case "USER_NOT_FOUND":
    case "CHAT_NOT_FOUND":
    case "CONTAINER_NOT_FOUND":
    case "SESSION_NOT_FOUND":
      return 404;

    case "VALIDATION_FAILED":
    case "INVALID_REQUEST_FORMAT":
    case "MISSING_REQUIRED_FIELDS":
    case "INVALID_UUID":
    case "INVALID_AMOUNT":
    case "PAYMENT_EXPIRED":
    case "INVALID_TRANSACTION_HASH":
      return 400;

    case "RATE_LIMITED":
      return 429;

    case "SERVICE_UNAVAILABLE":
    case "SERVICE_NOT_CONFIGURED":
    case "CRYPTO_SERVICE_UNAVAILABLE":
      return 503;

    case "INTERNAL_ERROR":
    case "PROCESSING_FAILED":
    case "CONFIRMATION_FAILED":
    case "WEBHOOK_PROCESSING_FAILED":
    case "STORAGE_ERROR":
    default:
      return 500;
  }
}
