import { Response } from 'node-fetch';

// Define specific error types for different scenarios
export enum CoinbaseErrorType {
  AUTHENTICATION = 'AUTHENTICATION',
  PERMISSION = 'PERMISSION',
  VALIDATION = 'VALIDATION',
  RATE_LIMIT = 'RATE_LIMIT',
  SERVER_ERROR = 'SERVER_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  UNKNOWN = 'UNKNOWN'
}

export interface CoinbaseErrorDetails {
  type: CoinbaseErrorType;
  message: string;
  details?: Record<string, any>;
  suggestion?: string;
}

export class CoinbaseError extends Error {
  readonly statusCode: number;
  readonly response: Response;
  readonly type: CoinbaseErrorType;
  readonly details?: Record<string, any>;
  readonly suggestion?: string;

  constructor(errorDetails: CoinbaseErrorDetails, statusCode: number, response: Response) {
    super(errorDetails.message);
    this.name = 'CoinbaseError';
    this.statusCode = statusCode;
    this.response = response;
    this.type = errorDetails.type;
    this.details = errorDetails.details;
    this.suggestion = errorDetails.suggestion;
  }
}

function parseErrorResponse(responseText: string): Record<string, any> {
  try {
    return JSON.parse(responseText);
  } catch {
    return {};
  }
}

function getErrorDetails(response: Response, responseText: string): CoinbaseErrorDetails {
  const parsedError = parseErrorResponse(responseText);
  const status = response.status;

  // Authentication errors
  if (status === 401) {
    return {
      type: CoinbaseErrorType.AUTHENTICATION,
      message: 'Invalid API credentials',
      suggestion: 'Please verify your API key and secret are correct and not expired.'
    };
  }

  // Permission errors
  if (status === 403) {
    if (responseText.includes('"error_details":"Missing required scopes"')) {
      return {
        type: CoinbaseErrorType.PERMISSION,
        message: 'Missing required API permissions',
        suggestion: 'Please verify your API key has the necessary permissions enabled in your Coinbase account settings.'
      };
    }
    return {
      type: CoinbaseErrorType.PERMISSION,
      message: 'Access denied',
      suggestion: 'Please check if you have the necessary permissions to perform this action.'
    };
  }

  // Validation errors
  if (status === 400) {
    return {
      type: CoinbaseErrorType.VALIDATION,
      message: parsedError.message || 'Invalid request parameters',
      details: parsedError,
      suggestion: 'Please verify all required parameters are provided and have valid values.'
    };
  }

  // Rate limit errors
  if (status === 429) {
    return {
      type: CoinbaseErrorType.RATE_LIMIT,
      message: 'Rate limit exceeded',
      suggestion: 'Please reduce your request frequency or wait before trying again.'
    };
  }

  // Server errors
  if (status >= 500) {
    return {
      type: CoinbaseErrorType.SERVER_ERROR,
      message: 'Coinbase service error',
      suggestion: 'This is a temporary issue with Coinbase. Please try again later.'
    };
  }

  // Default unknown error
  return {
    type: CoinbaseErrorType.UNKNOWN,
    message: `Unexpected error: ${response.statusText}`,
    details: parsedError,
    suggestion: 'If this persists, please contact team with the error details.'
  };
}

export function handleException(
  response: Response,
  responseText: string,
  reason: string
) {
  if ((400 <= response.status && response.status <= 499) ||
      (500 <= response.status && response.status <= 599)) {
    const errorDetails = getErrorDetails(response, responseText);
    throw new CoinbaseError(errorDetails, response.status, response);
  }
}
