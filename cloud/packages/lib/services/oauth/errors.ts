/**
 * OAuth Error Codes for Agent Actions
 *
 * Machine-readable codes for programmatic error handling.
 */

export enum OAuthErrorCode {
  // Connection errors
  PLATFORM_NOT_CONNECTED = "PLATFORM_NOT_CONNECTED",
  CONNECTION_NOT_FOUND = "CONNECTION_NOT_FOUND",
  CONNECTION_REVOKED = "CONNECTION_REVOKED",
  CONNECTION_EXPIRED = "CONNECTION_EXPIRED",

  // Configuration errors
  PLATFORM_NOT_CONFIGURED = "PLATFORM_NOT_CONFIGURED",
  PLATFORM_NOT_SUPPORTED = "PLATFORM_NOT_SUPPORTED",
  INVALID_SCOPE_REQUEST = "INVALID_SCOPE_REQUEST",

  // Token errors
  TOKEN_REFRESH_FAILED = "TOKEN_REFRESH_FAILED",
  TOKEN_DECRYPTION_FAILED = "TOKEN_DECRYPTION_FAILED",
  TOKEN_INVALID = "TOKEN_INVALID",

  // Auth errors
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",

  // Rate limiting
  RATE_LIMITED = "RATE_LIMITED",

  // Internal errors
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

/** HTTP status code mapping for each error code */
export const ERROR_STATUS_MAP: Record<OAuthErrorCode, number> = {
  [OAuthErrorCode.CONNECTION_NOT_FOUND]: 404,
  [OAuthErrorCode.PLATFORM_NOT_CONNECTED]: 401,
  [OAuthErrorCode.CONNECTION_REVOKED]: 401,
  [OAuthErrorCode.CONNECTION_EXPIRED]: 401,
  [OAuthErrorCode.TOKEN_REFRESH_FAILED]: 401,
  [OAuthErrorCode.TOKEN_DECRYPTION_FAILED]: 401,
  [OAuthErrorCode.TOKEN_INVALID]: 401,
  [OAuthErrorCode.PLATFORM_NOT_CONFIGURED]: 400,
  [OAuthErrorCode.PLATFORM_NOT_SUPPORTED]: 400,
  [OAuthErrorCode.INVALID_SCOPE_REQUEST]: 400,
  [OAuthErrorCode.UNAUTHORIZED]: 401,
  [OAuthErrorCode.FORBIDDEN]: 403,
  [OAuthErrorCode.RATE_LIMITED]: 429,
  [OAuthErrorCode.INTERNAL_ERROR]: 500,
};

export interface OAuthErrorResponse {
  error: string;
  code: OAuthErrorCode;
  message: string;
  reconnectRequired: boolean;
  authUrl?: string;
  retryAfter?: number;
}

/**
 * Custom error class for OAuth operations.
 */
export class OAuthError extends Error {
  public readonly code: OAuthErrorCode;
  public readonly reconnectRequired: boolean;
  public readonly retryAfter?: number;
  public readonly authUrl?: string;

  constructor(
    code: OAuthErrorCode,
    message: string,
    reconnectRequired = false,
    retryAfter?: number,
    authUrl?: string,
  ) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    this.reconnectRequired = reconnectRequired;
    this.retryAfter = retryAfter;
    this.authUrl = authUrl;
  }

  toResponse(): OAuthErrorResponse {
    return {
      error: this.code,
      code: this.code,
      message: this.message,
      reconnectRequired: this.reconnectRequired,
      retryAfter: this.retryAfter,
      authUrl: this.authUrl,
    };
  }

  /** Get HTTP status code for this error */
  get httpStatus(): number {
    return ERROR_STATUS_MAP[this.code];
  }
}

/** Factory functions for common OAuth errors */
export const Errors = {
  platformNotConnected: (platform: string) =>
    new OAuthError(
      OAuthErrorCode.PLATFORM_NOT_CONNECTED,
      `No active ${platform} connection found. User must connect their ${platform} account.`,
      true,
    ),

  connectionNotFound: (connectionId: string) =>
    new OAuthError(
      OAuthErrorCode.CONNECTION_NOT_FOUND,
      `Connection ${connectionId} not found or not accessible.`,
      false,
    ),

  connectionRevoked: (platform: string) =>
    new OAuthError(
      OAuthErrorCode.CONNECTION_REVOKED,
      `${platform} connection was revoked. User must reconnect.`,
      true,
    ),

  connectionExpired: (platform: string) =>
    new OAuthError(
      OAuthErrorCode.CONNECTION_EXPIRED,
      `${platform} connection has expired. User must reconnect.`,
      true,
    ),

  tokenRefreshFailed: (platform: string, reason?: string) =>
    new OAuthError(
      OAuthErrorCode.TOKEN_REFRESH_FAILED,
      `Failed to refresh ${platform} token${reason ? `: ${reason}` : ""}. User may need to reconnect.`,
      true,
    ),

  tokenDecryptionFailed: (platform: string) =>
    new OAuthError(
      OAuthErrorCode.TOKEN_DECRYPTION_FAILED,
      `Failed to decrypt ${platform} token. Please reconnect your account.`,
      true,
    ),

  tokenInvalid: (platform: string) =>
    new OAuthError(
      OAuthErrorCode.TOKEN_INVALID,
      `${platform} token is invalid. Please reconnect your account.`,
      true,
    ),

  platformNotConfigured: (platform: string) =>
    new OAuthError(
      OAuthErrorCode.PLATFORM_NOT_CONFIGURED,
      `${platform} OAuth is not configured on this platform. Missing environment variables.`,
      false,
    ),

  platformNotSupported: (platform: string) =>
    new OAuthError(
      OAuthErrorCode.PLATFORM_NOT_SUPPORTED,
      `Platform ${platform} is not supported by the OAuth API.`,
      false,
    ),

  invalidScopeRequest: (platform: string, invalidScopes: string[]) =>
    new OAuthError(
      OAuthErrorCode.INVALID_SCOPE_REQUEST,
      `Requested scopes are not allowed for ${platform}: ${invalidScopes.join(", ")}`,
      false,
    ),

  unauthorized: () =>
    new OAuthError(
      OAuthErrorCode.UNAUTHORIZED,
      "Authentication required to access this resource.",
      false,
    ),

  forbidden: () =>
    new OAuthError(
      OAuthErrorCode.FORBIDDEN,
      "You do not have permission to access this resource.",
      false,
    ),

  rateLimited: (retryAfter: number) =>
    new OAuthError(
      OAuthErrorCode.RATE_LIMITED,
      `Rate limited. Retry after ${retryAfter} seconds.`,
      false,
      retryAfter,
    ),

  internalError: (message: string) => new OAuthError(OAuthErrorCode.INTERNAL_ERROR, message, false),
};

/** Create a standard internal error response */
export function internalErrorResponse(
  message = "An unexpected error occurred",
): OAuthErrorResponse {
  return {
    error: "INTERNAL_ERROR",
    code: OAuthErrorCode.INTERNAL_ERROR,
    message,
    reconnectRequired: false,
  };
}

/** Create a validation error response */
export function validationErrorResponse(message: string): OAuthErrorResponse {
  return {
    error: "VALIDATION_ERROR",
    code: OAuthErrorCode.INTERNAL_ERROR,
    message,
    reconnectRequired: false,
  };
}
