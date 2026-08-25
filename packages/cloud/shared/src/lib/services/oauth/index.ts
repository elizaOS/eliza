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
// Credential broker (opaque-connection provider calls; no raw token egress)
export {
  BROKER_PLATFORM_POLICIES,
  type BrokeredProviderCallParams,
  type BrokeredProviderRequest,
  type BrokeredProviderResponse,
  type BrokeredTokenRefreshParams,
  type BrokeredTokenRefreshResult,
  type BrokerPlatformPolicy,
  CredentialBroker,
  type CredentialBrokerDeps,
  createCredentialBroker,
  credentialBroker,
} from "./credential-broker";
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
  getProviderEnvDiagnostics,
  isProviderConfigured,
  isValidProvider,
  OAUTH_PROVIDERS,
  type OAuthProviderConfig,
  type ProviderEnvDiagnostic,
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
  OAuthConnectionRole,
  OAuthConnectionRoleOutput,
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
