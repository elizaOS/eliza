import { PythError, ErrorSeverity, type PythErrorCode, type ErrorDetails } from './base';

// Data Error Codes
export enum DataErrorCode {
  // Validation Errors
  VALIDATION_FAILED = 'DATA_VALIDATION_FAILED',
  INVALID_SUBSCRIPTION = 'DATA_INVALID_SUBSCRIPTION',
  SUBSCRIPTION_LIMIT = 'DATA_SUBSCRIPTION_LIMIT',
  SCHEMA_ERROR = 'DATA_SCHEMA_ERROR',

  // Processing Errors
  SEQUENCE_ERROR = 'DATA_SEQUENCE_ERROR',
  TRANSFORM_ERROR = 'DATA_TRANSFORM_ERROR',
  PARSE_ERROR = 'DATA_PARSE_ERROR',

  // Price Feed Errors
  PRICE_UNAVAILABLE = 'DATA_PRICE_UNAVAILABLE',
  CONFIDENCE_TOO_LOW = 'DATA_CONFIDENCE_TOO_LOW',
  STALE_PRICE = 'DATA_STALE_PRICE',

  // Chain-Specific Errors
  CHAIN_DATA_ERROR = 'DATA_CHAIN_ERROR',
  CONTRACT_ERROR = 'DATA_CONTRACT_ERROR',

  // Network and Connection Errors
  NETWORK_ERROR = 'NETWORK_ERROR',
  WEBSOCKET_ERROR = 'WEBSOCKET_ERROR',
  MESSAGE_PROCESSING_ERROR = 'MESSAGE_PROCESSING_ERROR',
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  HANDLER_FAILED = 'HANDLER_FAILED',
  SUBSCRIPTION_LIMIT_EXCEEDED = 'SUBSCRIPTION_LIMIT_EXCEEDED',
  PRICE_FEEDS_FETCH_FAILED = 'PRICE_FEEDS_FETCH_FAILED'
}

// Validation error type
type ValidationError = string | {
  field: string;
  message: string;
  value?: unknown;
};

export class DataError extends PythError {
  public readonly name: string = 'DataError';

  constructor(
    code: PythErrorCode | DataErrorCode,
    message: string,
    severity: ErrorSeverity = ErrorSeverity.MEDIUM,
    details?: ErrorDetails,
    originalError?: Error
  ) {
    super(code as PythErrorCode, message, severity, details, originalError);
    Object.setPrototypeOf(this, new.target.prototype);
  }

  // Factory methods
  static invalidSubscription(subscription: unknown, reason: string): DataError {
    return new DataError(
      DataErrorCode.INVALID_SUBSCRIPTION,
      'Invalid subscription parameters',
      ErrorSeverity.MEDIUM,
      { subscription, reason }
    );
  }

  static subscriptionLimitExceeded(
    currentCount: number,
    maxLimit: number
  ): DataError {
    return new DataError(
      DataErrorCode.SUBSCRIPTION_LIMIT,
      `Subscription limit exceeded (${currentCount}/${maxLimit})`,
      ErrorSeverity.HIGH,
      { currentCount, maxLimit }
    );
  }

  static validationFailed(
    data: unknown,
    validationErrors: ValidationError[]
  ): DataError {
    return new DataError(
      DataErrorCode.VALIDATION_FAILED,
      'Data validation failed',
      ErrorSeverity.MEDIUM,
      { data, validationErrors }
    );
  }

  static sequenceError(
    expected: number,
    received: number,
    details?: ErrorDetails
  ): DataError {
    return new DataError(
      DataErrorCode.SEQUENCE_ERROR,
      `Message sequence error: expected ${expected}, received ${received}`,
      ErrorSeverity.MEDIUM,
      { expected, received, ...details }
    );
  }

  static transformError(data: unknown, targetFormat: string, error?: Error): DataError {
    return new DataError(
      DataErrorCode.TRANSFORM_ERROR,
      'Failed to transform data',
      ErrorSeverity.MEDIUM,
      { data, targetFormat },
      error
    );
  }

  static schemaError(data: unknown, schema: Record<string, unknown>, error?: Error): DataError {
    return new DataError(
      DataErrorCode.SCHEMA_ERROR,
      'Data does not match schema',
      ErrorSeverity.HIGH,
      { data, schema },
      error
    );
  }

  static stalePriceError(
    symbol: string,
    lastUpdateTime: number,
    maxAge: number
  ): DataError {
    return new DataError(
      DataErrorCode.STALE_PRICE,
      `Price data for ${symbol} is stale`,
      ErrorSeverity.HIGH,
      {
        symbol,
        lastUpdateTime,
        maxAge,
        currentTime: Date.now()
      }
    );
  }

  static chainError(
    chain: string,
    operation: string,
    error?: Error
  ): DataError {
    return new DataError(
      DataErrorCode.CHAIN_DATA_ERROR,
      `Chain-specific error on ${chain} during ${operation}`,
      ErrorSeverity.HIGH,
      { chain, operation },
      error
    );
  }
}

// Type guard
export const isDataError = (error: unknown): error is DataError => {
  return error instanceof DataError;
};