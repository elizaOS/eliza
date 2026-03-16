/**
 * Unified OAuth Service
 *
 * Provides consistent OAuth credential management across platforms:
 * Google, Twitter, Twilio, Blooio.
 *
 * @example
 * const token = await oauthService.getValidToken({ organizationId, connectionId });
 * const connections = await oauthService.listConnections({ organizationId });
 */

// Main service
export { oauthService } from "./oauth-service";

// Types
export type {
  OAuthProviderType,
  OAuthConnectionStatus,
  OAuthConnectionSource,
  OAuthProviderInfo,
  OAuthConnection,
  TokenResult,
  InitiateAuthParams,
  InitiateAuthResult,
  ListConnectionsParams,
  GetTokenParams,
  GetTokenByPlatformParams,
  CachedToken,
} from "./types";

// Errors
export {
  OAuthError,
  OAuthErrorCode,
  ERROR_STATUS_MAP,
  Errors,
  internalErrorResponse,
  validationErrorResponse,
  type OAuthErrorResponse,
} from "./errors";

// Provider registry
export {
  OAUTH_PROVIDERS,
  getProvider,
  isProviderConfigured,
  getConfiguredProviders,
  getAllProviderIds,
  isValidProvider,
  type OAuthProviderConfig,
} from "./provider-registry";

// Advanced use cases
export { tokenCache } from "./token-cache";
export { getAdapter, getAllAdapters, type ConnectionAdapter } from "./connection-adapters";
