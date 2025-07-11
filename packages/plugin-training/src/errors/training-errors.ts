/**
 * Custom Error Types for Training Plugin
 *
 * Provides specific error types for different failure scenarios with proper categorization,
 * context information, and retry guidance.
 */

import { elizaLogger } from '@elizaos/core';

/**
 * Base error class for all training plugin errors
 */
export abstract class TrainingError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;

  public readonly timestamp: number;
  public readonly context: Record<string, any>;
  public readonly retryable: boolean;
  public readonly retryAfter?: number; // milliseconds

  constructor(
    message: string,
    context: Record<string, any> = {},
    retryable = false,
    retryAfter?: number
  ) {
    super(message);
    this.name = this.constructor.name;
    this.timestamp = Date.now();
    this.context = context;
    this.retryable = retryable;
    (this as any).retryAfter = retryAfter;

    // Ensure proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Get formatted error information for logging
   */
  toLogContext(): Record<string, any> {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      retryAfter: this.retryAfter,
      timestamp: new Date(this.timestamp).toISOString(),
      context: this.context,
    };
  }

  /**
   * Get user-friendly error message
   */
  getUserMessage(): string {
    return this.message;
  }
}

export enum ErrorCategory {
  CONFIGURATION = 'configuration',
  NETWORK = 'network',
  AUTHENTICATION = 'authentication',
  VALIDATION = 'validation',
  RESOURCE = 'resource',
  PROCESSING = 'processing',
  EXTERNAL_SERVICE = 'external_service',
  DATABASE = 'database',
  FILE_SYSTEM = 'file_system',
  RUNTIME = 'runtime',
}

/**
 * Configuration-related errors
 */
export class ConfigurationError extends TrainingError {
  readonly code = 'CONFIGURATION_ERROR';
  readonly category = ErrorCategory.CONFIGURATION;

  constructor(message: string, configKey?: string, context: Record<string, any> = {}) {
    super(message, { configKey, ...context }, false);
  }
}

export class MissingConfigurationError extends ConfigurationError {
  readonly code = 'CONFIGURATION_ERROR';

  constructor(configKey: string, context: Record<string, any> = {}) {
    super(`Required configuration missing: ${configKey}`, configKey, context);
  }

  getUserMessage(): string {
    return `Configuration error: Please set the required environment variable '${this.context.configKey}'`;
  }
}

export class InvalidConfigurationError extends ConfigurationError {
  readonly code = 'CONFIGURATION_ERROR';

  constructor(
    configKey: string,
    value: any,
    expectedFormat: string,
    context: Record<string, any> = {}
  ) {
    super(
      `Invalid configuration for ${configKey}: expected ${expectedFormat}, got ${typeof value}`,
      configKey,
      { value, expectedFormat, ...context }
    );
  }
}

/**
 * Network-related errors
 */
export class NetworkError extends TrainingError {
  readonly code = 'NETWORK_ERROR';
  readonly category = ErrorCategory.NETWORK;

  constructor(
    message: string,
    url?: string,
    statusCode?: number,
    context: Record<string, any> = {}
  ) {
    const retryable = statusCode ? statusCode >= 500 || statusCode === 429 : true;
    const retryAfter =
      statusCode === 429 ? 30000 : statusCode && statusCode >= 500 ? 5000 : undefined;

    super(message, { url, statusCode, ...context }, retryable, retryAfter);
  }
}

export class APIError extends NetworkError {
  readonly code = 'NETWORK_ERROR';

  constructor(
    service: string,
    message: string,
    statusCode?: number,
    context: Record<string, any> = {}
  ) {
    super(`${service} API error: ${message}`, undefined, statusCode, { service, ...context });
  }
}

export class RateLimitError extends NetworkError {
  readonly code = 'NETWORK_ERROR';

  constructor(service: string, resetTime?: number, context: Record<string, any> = {}) {
    const retryAfter = resetTime ? Math.max(resetTime - Date.now(), 1000) : 60000;
    super(`Rate limit exceeded for ${service}`, undefined, 429, { service, resetTime, ...context });
    (this as any).retryAfter = retryAfter;
  }

  getUserMessage(): string {
    const waitMinutes = Math.ceil((this.retryAfter || 60000) / 60000);
    return `Rate limit exceeded for ${this.context.service}. Please wait ${waitMinutes} minute(s) before retrying.`;
  }
}

/**
 * Authentication errors
 */
export class AuthenticationError extends TrainingError {
  readonly code = 'AUTHENTICATION_ERROR';
  readonly category = ErrorCategory.AUTHENTICATION;

  constructor(service: string, message: string, context: Record<string, any> = {}) {
    super(`Authentication failed for ${service}: ${message}`, { service, ...context }, false);
  }

  getUserMessage(): string {
    return `Authentication failed for ${this.context.service}. Please check your API key or credentials.`;
  }
}

/**
 * Validation errors
 */
export class ValidationError extends TrainingError {
  readonly code = 'VALIDATION_ERROR';
  readonly category = ErrorCategory.VALIDATION;

  constructor(field: string, value: any, rule: string, context: Record<string, any> = {}) {
    super(
      `Validation failed for field '${field}': ${rule}`,
      { field, value, rule, ...context },
      false
    );
  }
}

export class DataValidationError extends ValidationError {
  readonly code = 'VALIDATION_ERROR';

  constructor(dataType: string, issues: string[], context: Record<string, any> = {}) {
    super('data', dataType, `${dataType} validation failed: ${issues.join(', ')}`, {
      dataType,
      issues,
      ...context,
    });
  }
}

/**
 * Resource errors
 */
export class ResourceError extends TrainingError {
  readonly code = 'RESOURCE_ERROR';
  readonly category = ErrorCategory.RESOURCE;

  constructor(
    resource: string,
    operation: string,
    message: string,
    context: Record<string, any> = {}
  ) {
    super(
      `Resource operation failed: ${operation} on ${resource} - ${message}`,
      { resource, operation, ...context },
      true,
      5000
    );
  }
}

export class ResourceNotFoundError extends ResourceError {
  readonly code = 'RESOURCE_ERROR';

  constructor(resourceType: string, identifier: string, context: Record<string, any> = {}) {
    super(resourceType, 'find', `${resourceType} not found: ${identifier}`, {
      resourceType,
      identifier,
      ...context,
    });
    (this as any).retryable = false;
  }
}

export class ResourceExhaustedError extends ResourceError {
  readonly code = 'RESOURCE_ERROR';

  constructor(resource: string, limit: number, current: number, context: Record<string, any> = {}) {
    super(resource, 'allocate', `${resource} exhausted: ${current}/${limit}`, {
      resource,
      limit,
      current,
      ...context,
    });
    (this as any).retryAfter = 60000; // 1 minute
  }
}

/**
 * Processing errors
 */
export class ProcessingError extends TrainingError {
  readonly code = 'PROCESSING_ERROR';
  readonly category = ErrorCategory.PROCESSING;

  constructor(operation: string, message: string, context: Record<string, any> = {}) {
    super(`Processing failed: ${operation} - ${message}`, { operation, ...context }, true, 2000);
  }
}

export class DataProcessingError extends ProcessingError {
  readonly code = 'PROCESSING_ERROR';

  constructor(stage: string, dataType: string, reason: string, context: Record<string, any> = {}) {
    super(`data processing (${stage})`, `Failed to process ${dataType}: ${reason}`, {
      stage,
      dataType,
      reason,
      ...context,
    });
  }
}

/**
 * External service errors
 */
export class ExternalServiceError extends TrainingError {
  readonly code = 'EXTERNAL_SERVICE_ERROR';
  readonly category = ErrorCategory.EXTERNAL_SERVICE;

  constructor(
    service: string,
    operation: string,
    message: string,
    context: Record<string, any> = {}
  ) {
    super(
      `External service error: ${service} ${operation} - ${message}`,
      { service, operation, ...context },
      true,
      10000
    );
  }
}

export class ServiceUnavailableError extends ExternalServiceError {
  readonly code = 'EXTERNAL_SERVICE_ERROR';

  constructor(service: string, context: Record<string, any> = {}) {
    super(service, 'connect', `${service} is currently unavailable`, context);
    (this as any).retryAfter = 30000; // 30 seconds
  }
}

/**
 * Database errors
 */
export class DatabaseError extends TrainingError {
  readonly code = 'DATABASE_ERROR';
  readonly category = ErrorCategory.DATABASE;

  constructor(operation: string, message: string, context: Record<string, any> = {}) {
    super(`Database error: ${operation} - ${message}`, { operation, ...context }, true, 1000);
  }
}

export class DatabaseConnectionError extends DatabaseError {
  readonly code = 'DATABASE_ERROR';

  constructor(database: string, context: Record<string, any> = {}) {
    super('connect', `Failed to connect to ${database} database`, { database, ...context });
    (this as any).retryAfter = 5000; // 5 seconds
  }
}

/**
 * File system errors
 */
export class FileSystemError extends TrainingError {
  readonly code = 'FILE_SYSTEM_ERROR';
  readonly category = ErrorCategory.FILE_SYSTEM;

  constructor(operation: string, path: string, message: string, context: Record<string, any> = {}) {
    super(
      `File system error: ${operation} '${path}' - ${message}`,
      { operation, path, ...context },
      true,
      1000
    );
  }
}

export class FileNotFoundError extends FileSystemError {
  readonly code = 'FILE_SYSTEM_ERROR';

  constructor(path: string, context: Record<string, any> = {}) {
    super('read', path, `File not found: ${path}`, context);
    (this as any).retryable = false;
  }
}

export class PermissionError extends FileSystemError {
  readonly code = 'FILE_SYSTEM_ERROR';

  constructor(operation: string, path: string, context: Record<string, any> = {}) {
    super(operation, path, `Permission denied for ${operation} operation`, context);
    (this as any).retryable = false;
  }
}

/**
 * Runtime errors
 */
export class RuntimeError extends TrainingError {
  readonly code = 'RUNTIME_ERROR';
  readonly category = ErrorCategory.RUNTIME;

  constructor(component: string, message: string, context: Record<string, any> = {}) {
    super(`Runtime error in ${component}: ${message}`, { component, ...context }, false);
  }
}

/**
 * Error Handler with Retry Logic
 */
export class ErrorHandler {
  private static maxRetries = 3;
  private static retryHistory = new Map<string, number>();

  /**
   * Handle an error with appropriate logging and retry logic
   */
  static async handleError<T>(
    error: unknown,
    operation: string,
    context: Record<string, any> = {},
    retryCallback?: () => Promise<T>
  ): Promise<T | null> {
    const trainingError = this.normalizeError(error, operation, context);

    // Log the error with full context
    elizaLogger.error(`Training plugin error: ${operation}`, trainingError.toLogContext());

    // Check if we should retry
    if (trainingError.retryable && retryCallback) {
      const retryKey = `${operation}:${JSON.stringify(context)}`;
      const currentRetries = this.retryHistory.get(retryKey) || 0;

      if (currentRetries < this.maxRetries) {
        this.retryHistory.set(retryKey, currentRetries + 1);

        // Wait before retrying
        if (trainingError.retryAfter) {
          elizaLogger.info(
            `Retrying ${operation} in ${trainingError.retryAfter}ms (attempt ${currentRetries + 1}/${this.maxRetries})`
          );
          await new Promise((resolve) => setTimeout(resolve, trainingError.retryAfter));
        }

        try {
          const result = await retryCallback();
          this.retryHistory.delete(retryKey); // Clear retry count on success
          return result;
        } catch (retryError) {
          return this.handleError(retryError, operation, context, retryCallback);
        }
      } else {
        this.retryHistory.delete(retryKey);
        elizaLogger.error(`Max retries (${this.maxRetries}) exceeded for ${operation}`);
      }
    }

    // For non-retryable errors or max retries exceeded, re-throw
    throw trainingError;
  }

  /**
   * Convert any error to a TrainingError
   */
  static normalizeError(
    error: unknown,
    operation: string,
    context: Record<string, any> = {}
  ): TrainingError {
    if (error instanceof TrainingError) {
      return error;
    }

    if (error instanceof Error) {
      // Try to categorize based on error message and type
      const message = error.message.toLowerCase();

      if (
        message.includes('fetch') ||
        message.includes('network') ||
        message.includes('timeout') ||
        message.includes('connection')
      ) {
        return new NetworkError(error.message, context.url, context.statusCode, context);
      }

      if (
        message.includes('unauthorized') ||
        message.includes('forbidden') ||
        message.includes('api key') ||
        message.includes('credentials') ||
        message.includes('authentication')
      ) {
        return new AuthenticationError(context.service || 'unknown', error.message, context);
      }

      if (message.includes('not found') || message.includes('enoent')) {
        return new ResourceNotFoundError(
          context.resourceType || 'resource',
          context.identifier || 'unknown',
          context
        );
      }

      if (message.includes('permission') || message.includes('access denied')) {
        return new PermissionError(
          context.operation || 'unknown',
          context.path || 'unknown',
          context
        );
      }

      if (message.includes('rate limit') || message.includes('too many requests')) {
        return new RateLimitError(context.service || 'unknown', context.resetTime, context);
      }

      if (message.includes('database') || message.includes('sql')) {
        return new DatabaseError(context.operation || 'unknown', error.message, context);
      }
    }

    // Default to generic processing error
    return new ProcessingError(
      operation,
      error instanceof Error ? error.message : String(error),
      context
    );
  }

  /**
   * Validate configuration and throw appropriate errors
   */
  static validateConfiguration(config: Record<string, any>, required: string[]): void {
    for (const key of required) {
      if (!config[key]) {
        throw new MissingConfigurationError(key);
      }
    }
  }

  /**
   * Validate URL format
   */
  static validateURL(url: string, configKey: string): void {
    try {
      new URL(url);
    } catch {
      throw new InvalidConfigurationError(configKey, url, 'valid URL');
    }
  }

  /**
   * Validate numeric range
   */
  static validateNumericRange(value: number, min: number, max: number, configKey: string): void {
    if (value < min || value > max) {
      throw new InvalidConfigurationError(configKey, value, `number between ${min} and ${max}`);
    }
  }

  /**
   * Reset retry history (useful for testing)
   */
  static resetRetryHistory(): void {
    this.retryHistory.clear();
  }

  /**
   * Set max retries
   */
  static setMaxRetries(maxRetries: number): void {
    this.maxRetries = maxRetries;
  }
}

/**
 * Decorator for automatic error handling
 */
export function withErrorHandling(operation: string) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      try {
        return await originalMethod.apply(this, args);
      } catch (error) {
        return ErrorHandler.handleError(error, `${target.constructor.name}.${propertyKey}`, {
          operation,
          args: args.length > 0 ? args.slice(0, 2) : [], // Limit args to avoid circular refs
        });
      }
    };

    return descriptor;
  };
}

/**
 * Async wrapper with automatic retry
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  context: Record<string, any> = {},
  maxRetries = 3
): Promise<T> {
  const originalMaxRetries = ErrorHandler['maxRetries'];
  ErrorHandler.setMaxRetries(maxRetries);

  try {
    // Try the operation first
    try {
      return await operation();
    } catch (error) {
      // If it fails, use error handler with retry logic
      return (await ErrorHandler.handleError(error, operationName, context, operation)) as T;
    }
  } finally {
    ErrorHandler.setMaxRetries(originalMaxRetries);
  }
}

/**
 * Safe wrapper that catches all errors and returns null instead of throwing
 */
export async function safely<T>(
  operation: () => Promise<T>,
  operationName: string,
  context: Record<string, any> = {}
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    const trainingError = ErrorHandler.normalizeError(error, operationName, context);
    elizaLogger.warn(`Safe operation failed: ${operationName}`, trainingError.toLogContext());
    return null;
  }
}
