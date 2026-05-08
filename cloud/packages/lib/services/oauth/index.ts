/**
 * OAuth Service
 *
 * Provides consistent OAuth credential management across platforms:
 * Google, Twitter, Twilio, Blooio.
 *
 * @example
 * const token = await oauthService.getValidToken({ organizationId, connectionId });
 * const connections = await oauthService.listConnections({ organizationId });
 */

export {
  type ConnectionAdapter,
  getAdapter,
  getAllAdapters,
} from "./connection-adapters";
// Errors
export {
  ERROR_STATUS_MAP,
  Errors,
  internalErrorResponse,
  OAuthError,
  OAuthErrorCode,
  type OAuthErrorResponse,
  validationErrorResponse,
} from "./errors";
// Main service
export { oauthService } from "./oauth-service";

// Provider registry
export {
  getAllProviderIds,
  getConfiguredProviders,
  getProvider,
  isProviderConfigured,
  isValidProvider,
  OAUTH_PROVIDERS,
  type OAuthProviderConfig,
} from "./provider-registry";

// Advanced use cases
export { tokenCache } from "./token-cache";
// Types
export type {
  CachedToken,
  GetTokenByPlatformParams,
  GetTokenParams,
  InitiateAuthParams,
  InitiateAuthResult,
  ListConnectionsParams,
  OAuthConnection,
  OAuthConnectionRoleOutput,
  OAuthConnectionRole,
  OAuthConnectionSource,
  OAuthConnectionStatus,
  OAuthProviderInfo,
  OAuthProviderType,
  OAuthStandardConnectionRole,
  TokenResult,
} from "./types";
export {
  formatOAuthConnectionRole,
  isOAuthConnectionRole,
  normalizeOAuthConnectionRole,
  OAUTH_CONNECTION_ROLES,
  parseOAuthConnectionRole,
} from "./types";
