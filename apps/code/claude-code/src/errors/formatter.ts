/**
 * Error Formatter
 * 
 * Utilities for formatting errors and creating user-friendly error messages.
 */

import { ErrorCategory, ErrorLevel, UserError, UserErrorOptions } from './types.js';
import { logger } from '../utils/logger.js';
import { formatErrorDetails } from '../utils/formatting.js';

/**
 * Create a user-friendly error from any error
 */
export function createUserError(
  message: string,
  options: UserErrorOptions = {}
): UserError {
  // Create UserError instance
  const userError = new UserError(message, options);
  
  // Log the error with appropriate level
  const level = userError.level === ErrorLevel.FATAL ? 'error' : 'warn';
  logger[level](`User error: ${message}`, {
    category: userError.category,
    details: userError.details,
    resolution: userError.resolution
  });
  
  return userError;
}

/**
 * Format an error for display to the user
 */
export function formatErrorForDisplay(error: unknown): string {
  if (error instanceof UserError) {
    return formatUserError(error);
  }
  
  if (error instanceof Error) {
    return formatSystemError(error);
  }
  
  return `Unknown error: ${String(error)}`;
}

/**
 * Format a UserError for display
 */
function formatUserError(error: UserError): string {
  let message = `Error: ${error.message}`;
  
  // Add resolution steps if available
  if (error.resolution) {
    const resolutionSteps = Array.isArray(error.resolution)
      ? error.resolution
      : [error.resolution];
    
    message += '\n\nTo resolve this:';
    resolutionSteps.forEach(step => {
      message += `\n• ${step}`;
    });
  }
  
  // Add details if available
  if (error.details && Object.keys(error.details).length > 0) {
    message += '\n\nDetails:';
    for (const [key, value] of Object.entries(error.details)) {
      const formattedValue = typeof value === 'object'
        ? JSON.stringify(value, null, 2)
        : String(value);
      message += `\n${key}: ${formattedValue}`;
    }
  }
  
  return message;
}

/**
 * Format a system Error for display
 */
function formatSystemError(error: Error): string {
  let message = `System error: ${error.message}`;
  
  // Add stack trace for certain categories of errors
  if (process.env.DEBUG === 'true') {
    message += `\n\nStack trace:\n${error.stack || 'No stack trace available'}`;
  }
  
  return message;
}

/**
 * Convert an error to a UserError if it isn't already
 */
export function ensureUserError(
  error: unknown,
  defaultMessage: string = 'An unexpected error occurred',
  options: UserErrorOptions = {}
): UserError {
  if (error instanceof UserError) {
    return error;
  }
  
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : defaultMessage;
  
  return createUserError(message, {
    ...options,
    cause: error
  });
}

/**
 * Get a category name for an error
 */
export function getErrorCategoryName(category: ErrorCategory): string {
  return ErrorCategory[category] || 'Unknown';
}

/**
 * Get an error level name
 */
export function getErrorLevelName(level: ErrorLevel): string {
  return ErrorLevel[level] || 'Unknown';
}

/**
 * Get detailed information about an error
 */
export function getErrorDetails(error: unknown): string {
  if (error instanceof UserError) {
    return formatUserError(error);
  }
  
  if (error instanceof Error) {
    return formatErrorDetails(error);
  }
  
  return String(error);
} 