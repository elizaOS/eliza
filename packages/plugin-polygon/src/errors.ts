/**
 * Custom error classes for the Polygon plugin
 * These provide more specific error handling and better error messages for users
 */

/**
 * Base error class for RPC-related errors
 * Used for errors communicating with Ethereum or Polygon RPC endpoints
 */
export class PolygonRpcError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'PolygonRpcError';
  }
}

/**
 * Error class for input validation failures
 * Used when user inputs or configuration are invalid
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Error class for transaction failures
 * Used when a blockchain transaction fails or reverts
 */
export class TransactionError extends Error {
  constructor(
    message: string,
    public readonly txHash?: string
  ) {
    super(message);
    this.name = 'TransactionError';
  }
}

/**
 * Error class for contract-related errors
 * Used for errors interacting with smart contracts
 */
export class ContractError extends Error {
  constructor(
    message: string,
    public readonly contractAddress?: string,
    public readonly functionName?: string
  ) {
    super(message);
    this.name = 'ContractError';
  }
}

/**
 * Error class for provider initialization errors
 * Used when providers fail to initialize
 */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Error class for service initialization errors
 * Used when services fail to initialize
 */
export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly serviceName?: string
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/**
 * Helper function to format error messages consistently
 */
export function formatErrorMessage(action: string, message: string, details?: string): string {
  let formattedMessage = `${action} failed: ${message}`;
  if (details) {
    formattedMessage += `. Details: ${details}`;
  }
  return formattedMessage;
}

interface ParsedError {
  message: string;
  details?: string;
}

/**
 * Helper function to parse error objects from different sources
 * Attempts to extract the most useful error message and details from various error formats.
 * Always returns an object with a message and optional details.
 */
export function parseErrorMessage(error: unknown): ParsedError {
  if (error instanceof Error) {
    // For standard Error objects, message is primary, stack could be details
    return { message: error.message, details: error.stack };
  }

  if (typeof error === 'string') {
    return { message: error }; // Simple string error
  }

  if (typeof error === 'object' && error !== null) {
    let message = 'Unknown object error';
    let details: string | undefined;

    // Try to handle common error shapes from RPC calls or other libraries
    if ('message' in error && typeof error.message === 'string') {
      message = error.message;
    }

    if ('reason' in error && typeof error.reason === 'string') {
      message = error.reason; // Often used in ethers.js errors
    }

    if ('data' in error && typeof error.data === 'string') {
      details = error.data; // E.g., revert reason from ethers
    } else if ('stack' in error && typeof error.stack === 'string') {
      details = error.stack;
    }

    // Check for nested error objects (common in some RPC error wrappers)
    if (
      message === 'Unknown object error' &&
      'error' in error &&
      typeof error.error === 'object' &&
      error.error !== null
    ) {
      const nestedError = error.error as Record<string, unknown>; // Type assertion
      if ('message' in nestedError && typeof nestedError.message === 'string') {
        message = nestedError.message;
      }
      if ('data' in nestedError && typeof nestedError.data === 'string') {
        details = `${details ? `${details}; ` : ''}${nestedError.data}`;
      }
    }

    // If still default message, try to stringify the object as a last resort for details
    if (message === 'Unknown object error') {
      try {
        details = JSON.stringify(error);
      } catch (e) {
        details = 'Unserializable error object';
      }
    }

    return { message, details };
  }

  return { message: 'Unknown error' }; // Fallback for truly unknown types
}
