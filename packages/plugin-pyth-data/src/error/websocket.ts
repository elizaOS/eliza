import { PythError, ErrorSeverity, PythErrorCode, type ErrorDetails } from './base';

// WebSocket States
export enum WebSocketState {
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  DISCONNECTED = 'DISCONNECTED',
  ERROR = 'ERROR'
}

// WebSocket specific error class
export class WebSocketError extends PythError {
  public readonly name: string = 'WebSocketError';

  constructor(
    code: PythErrorCode,
    message: string,
    severity: ErrorSeverity = ErrorSeverity.HIGH,
    details?: ErrorDetails,
    originalError?: Error
  ) {
    super(code, message, severity, details, originalError);
    Object.setPrototypeOf(this, new.target.prototype);
  }

  // Factory methods
  static connectionTimeout(details?: ErrorDetails): WebSocketError {
    return new WebSocketError(
      PythErrorCode.WS_CONNECTION_TIMEOUT,
      'WebSocket connection timed out',
      ErrorSeverity.HIGH,
      details
    );
  }

  static connectionRefused(details?: ErrorDetails): WebSocketError {
    return new WebSocketError(
      PythErrorCode.WS_CONNECTION_REFUSED,
      'WebSocket connection refused',
      ErrorSeverity.HIGH,
      details
    );
  }

  static invalidUrl(url: string): WebSocketError {
    return new WebSocketError(
      PythErrorCode.WS_INVALID_URL,
      `Invalid WebSocket URL: ${url}`,
      ErrorSeverity.HIGH,
      { url }
    );
  }

  static sslError(details?: ErrorDetails): WebSocketError {
    return new WebSocketError(
      PythErrorCode.WS_SSL_ERROR,
      'SSL/TLS connection error',
      ErrorSeverity.HIGH,
      details
    );
  }

  static heartbeatFailure(details?: ErrorDetails): WebSocketError {
    return new WebSocketError(
      PythErrorCode.WS_HEARTBEAT_FAILED,
      'WebSocket heartbeat check failed',
      ErrorSeverity.HIGH,
      details
    );
  }

  static invalidStateTransition(
    fromState: WebSocketState,
    toState: WebSocketState,
    details?: ErrorDetails
  ): WebSocketError {
    return new WebSocketError(
      PythErrorCode.WS_INVALID_STATE_TRANSITION,
      `Invalid state transition from ${fromState} to ${toState}`,
      ErrorSeverity.HIGH,
      { fromState, toState, ...details }
    );
  }
}

// Type guard
export const isWebSocketError = (error: unknown): error is WebSocketError => {
  return error instanceof WebSocketError;
}; 