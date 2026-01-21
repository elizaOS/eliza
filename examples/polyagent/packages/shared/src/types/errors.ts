/**
 * Error Type Definitions
 *
 * Error types and utilities for error handling.
 * Error classes are exported from ./errors/index.ts
 */

import {
  AuthenticationError,
  DatabaseError,
  LLMError,
  ValidationError,
} from "../errors";
import type { JsonValue } from "./common";

/**
 * Base error interface for all application errors
 */
export interface AppError {
  message: string;
  code?: string;
  details?: Record<string, string | number | boolean>;
}

/**
 * Network/HTTP error interface
 * Note: There's no NetworkError class, only this interface
 */
export interface NetworkError extends Error {
  status?: number;
  statusText?: string;
  url?: string;
}

/**
 * Type guard to check if error is AuthenticationError class
 */
export function isAuthenticationError(
  error: Error,
): error is AuthenticationError {
  return error instanceof AuthenticationError;
}

/**
 * Type guard to check if error is DatabaseError class
 */
export function isDatabaseError(error: Error): error is DatabaseError {
  return error instanceof DatabaseError;
}

/**
 * Type guard to check if error is LLMError class
 */
export function isLLMError(error: Error): error is LLMError {
  return error instanceof LLMError;
}

/**
 * Type guard to check if error is NetworkError interface
 */
export function isNetworkError(error: Error): error is NetworkError {
  return "status" in error || "url" in error;
}

/**
 * Type guard to check if error is ValidationError class
 */
export function isValidationError(error: Error): error is ValidationError {
  return error instanceof ValidationError;
}

/**
 * Extract error message from any error-like object
 */
export function extractErrorMessage(
  error: Error | AppError | string | JsonValue | { message?: string },
): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "An unknown error occurred";
}
