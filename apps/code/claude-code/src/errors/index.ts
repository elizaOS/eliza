/**
 * Error Handling Module
 * 
 * Provides centralized error handling, tracking, and reporting.
 */

import { logger } from '../utils/logger.js';
import { ErrorLevel, ErrorCategory, ErrorManager, ErrorOptions } from './types.js';
import { formatErrorForDisplay } from './formatter.js';
import { setupSentryReporting } from './sentry.js';
import { setupConsoleErrorHandling } from './console.js';

/**
 * Initialize error handling system
 */
export function initErrorHandling(): ErrorManager {
  logger.debug('Initializing error handling system');
  
  // Create error manager instance
  const errorManager = new ErrorHandlerImpl();
  
  try {
    // Set up Sentry error reporting if enabled
    // We're skipping Sentry SDK as requested
    
    // Set up console error handling
    setupConsoleErrorHandling(errorManager);
    
    return errorManager;
  } catch (error) {
    logger.error('Failed to initialize error handling system', error);
    
    // Return a basic error manager even if initialization failed
    return errorManager;
  }
}

/**
 * Implementation of the ErrorManager interface
 */
class ErrorHandlerImpl implements ErrorManager {
  private errorCount: Map<string, number> = new Map();
  private readonly MAX_ERRORS = 100;
  
  /**
   * Handle a fatal error that should terminate the application
   */
  handleFatalError(error: unknown): never {
    const formattedError = this.formatError(error, {
      level: ErrorLevel.CRITICAL,
      category: ErrorCategory.APPLICATION
    });
    
    logger.error('FATAL ERROR:', formattedError);
    
    // Exit with error code
    process.exit(1);
  }
  
  /**
   * Handle an unhandled promise rejection
   */
  handleUnhandledRejection(reason: unknown, promise: Promise<unknown>): void {
    const formattedError = this.formatError(reason, {
      level: ErrorLevel.MAJOR,
      category: ErrorCategory.APPLICATION,
      context: { promise }
    });
    
    logger.error('Unhandled Promise Rejection:', formattedError);
  }
  
  /**
   * Handle an uncaught exception
   */
  handleUncaughtException(error: unknown): void {
    const formattedError = this.formatError(error, {
      level: ErrorLevel.CRITICAL,
      category: ErrorCategory.APPLICATION
    });
    
    logger.error('Uncaught Exception:', formattedError);
  }
  
  /**
   * Handle a general error
   */
  handleError(error: unknown, options: ErrorOptions = {}): void {
    const category = options.category || ErrorCategory.APPLICATION;
    const level = options.level || ErrorLevel.MINOR;
    
    // Track error count for rate limiting
    const errorKey = `${category}:${level}:${this.getErrorMessage(error)}`;
    const count = (this.errorCount.get(errorKey) || 0) + 1;
    this.errorCount.set(errorKey, count);
    
    // Format the error
    const formattedError = this.formatError(error, options);
    
    // Log the error based on level
    switch (level) {
      case ErrorLevel.CRITICAL:
      case ErrorLevel.MAJOR:
        logger.error(`[${ErrorCategory[category]}] ${formattedError.message}`, formattedError);
        break;
      case ErrorLevel.MINOR:
        logger.warn(`[${ErrorCategory[category]}] ${formattedError.message}`, formattedError);
        break;
      case ErrorLevel.INFORMATIONAL:
        logger.info(`[${ErrorCategory[category]}] ${formattedError.message}`, formattedError);
        break;
    }
    
    // Report to telemetry/monitoring if appropriate
    if (level === ErrorLevel.CRITICAL || level === ErrorLevel.MAJOR) {
      this.reportError(formattedError, options);
    }
  }
  
  /**
   * Format an error object for consistent handling
   */
  private formatError(error: unknown, options: ErrorOptions = {}): any {
    try {
      return formatErrorForDisplay(error, options);
    } catch (formattingError) {
      // If formatting fails, return a basic error object
      return {
        message: this.getErrorMessage(error),
        originalError: error,
        formattingError
      };
    }
  }
  
  /**
   * Get an error message from any error type
   */
  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    } else if (typeof error === 'string') {
      return error;
    } else {
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    }
  }
  
  /**
   * Report an error to monitoring/telemetry systems
   */
  private reportError(error: any, options: ErrorOptions = {}): void {
    // We're skipping Sentry SDK as requested
    // In a real implementation, this would send the error to Sentry
    
    // Instead, just log that we would report it
    logger.debug('Would report error to monitoring system:', {
      error: error.message,
      level: options.level,
      category: options.category
    });
  }
}

// Export error types
export * from './types.js'; 