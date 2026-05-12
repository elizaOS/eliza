/**
 * OAuth Types
 *
 * Core type definitions for the OAuth service that provides
 * a consistent interface across multiple OAuth providers (Google, Twitter, Twilio, Blooio).
 */

export type OAuthProviderType = "oauth2" | "oauth1a" | "api_key";

export type OAuthConnectionStatus = "pending" | "active" | "expired" | "revoked" | "error";

export type OAuthConnectionSource = "platform_credentials" | "secrets";

export const OAUTH_CONNECTION_ROLES = ["OWNER", "AGENT", "TEAM"] as const;

export type OAuthStandardConnectionRole = (typeof OAUTH_CONNECTION_ROLES)[number];
export type OAuthLegacyConnectionRole = "owner" | "agent";
export type OAuthConnectionRoleOutput = OAuthLegacyConnectionRole | "team";
export type OAuthConnectionRole = OAuthStandardConnectionRole | OAuthLegacyConnectionRole | "team";

export function parseOAuthConnectionRole(value: unknown): OAuthStandardConnectionRole | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  switch (normalized) {
    case "OWNER":
      return "OWNER";
    case "AGENT":
      return "AGENT";
    case "TEAM":
      return "TEAM";
    default:
      return null;
  }
}

export function normalizeOAuthConnectionRole(
  value: unknown,
  fallback: OAuthStandardConnectionRole = "OWNER",
): OAuthStandardConnectionRole {
  return parseOAuthConnectionRole(value) ?? fallback;
}

export function formatOAuthConnectionRole(value: unknown): OAuthConnectionRoleOutput {
  switch (normalizeOAuthConnectionRole(value)) {
    case "AGENT":
      return "agent";
    case "TEAM":
      return "team";
    case "OWNER":
      return "owner";
  }
}

export function isOAuthConnectionRole(value: unknown): value is OAuthConnectionRole {
  return parseOAuthConnectionRole(value) !== null;
}

/**
 * Provider information returned by the list providers endpoint.
 */
export interface OAuthProviderInfo {
  /** Unique provider identifier (e.g., 'google', 'twitter') */
  id: string;
  /** Human-readable provider name */
  name: string;
  /** Description of what this provider enables */
  description: string;
  /** OAuth type used by this provider */
  type: OAuthProviderType;
  /** Whether required environment variables are configured */
  configured: boolean;
  /** Default OAuth scopes for this provider */
  defaultScopes?: string[];
}

/**
 * Represents a connected OAuth account.
 */
export interface OAuthConnection {
  /** Unique connection identifier */
  id: string;
  /** Cloud user that owns the connection when user-scoped */
  userId?: string;
  /** Logical role Agent uses for the connection */
  connectionRole?: OAuthConnectionRoleOutput;
  /** Platform identifier (e.g., 'google', 'twitter') */
  platform: string;
  /** User ID on the platform */
  platformUserId: string;
  /** Email associated with the platform account */
  email?: string;
  /** Username on the platform */
  username?: string;
  /** Display name on the platform */
  displayName?: string;
  /** Avatar/profile image URL */
  avatarUrl?: string;
  /** Current status of the connection */
  status: OAuthConnectionStatus;
  /** OAuth scopes granted */
  scopes: string[];
  /** When the connection was established */
  linkedAt: Date;
  /** When the connection was last used */
  lastUsedAt?: Date;
  /** Whether the access token has expired */
  tokenExpired: boolean;
  /** Storage source for this connection */
  source: OAuthConnectionSource;
}

/**
 * Result of retrieving a valid access token.
 */
export interface TokenResult {
  /** The access token */
  accessToken: string;
  /** Access token secret (for OAuth 1.0a like Twitter) */
  accessTokenSecret?: string;
  /** When the token expires */
  expiresAt?: Date;
  /** Scopes associated with this token */
  scopes?: string[];
  /** Whether the token was refreshed on this call */
  refreshed: boolean;
  /** Whether this result came from cache */
  fromCache: boolean;
}

/**
 * Parameters for initiating an OAuth flow.
 */
export interface InitiateAuthParams {
  /** Organization requesting the connection */
  organizationId: string;
  /** User ID initiating the connection (required for callback to link credentials) */
  userId: string;
  /** Platform to connect (e.g., 'google', 'twitter') */
  platform: string;
  /** URL to redirect to after OAuth completes */
  redirectUrl?: string;
  /** Specific scopes to request (overrides defaults) */
  scopes?: string[];
  /** Logical Agent-side role for the connection */
  connectionRole?: OAuthConnectionRole;
}

/**
 * Result of initiating an OAuth flow.
 */
export interface InitiateAuthResult {
  /** URL to redirect the user to for authorization */
  authUrl: string;
  /** State parameter for CSRF protection */
  state?: string;
  /** For API key platforms - indicates credentials form should be shown */
  requiresCredentials?: boolean;
}

/**
 * Parameters for listing OAuth connections.
 */
export interface ListConnectionsParams {
  /** Organization to list connections for */
  organizationId: string;
  /** Optional user scope within the organization */
  userId?: string;
  /** Optional platform filter */
  platform?: string;
  /** Optional logical role filter */
  connectionRole?: OAuthConnectionRole;
}

/**
 * Parameters for getting a token by connection ID.
 */
export interface GetTokenParams {
  /** Organization owning the connection */
  organizationId: string;
  /** Connection ID */
  connectionId: string;
}

/**
 * Parameters for getting a token by platform.
 */
export interface GetTokenByPlatformParams {
  /** Organization owning the connection */
  organizationId: string;
  /** Optional user scope within the organization */
  userId?: string;
  /** Platform identifier */
  platform: string;
  /** Optional logical role filter */
  connectionRole?: OAuthConnectionRole;
}

/**
 * Cached token data structure.
 */
export interface CachedToken {
  /** The token result */
  token: TokenResult;
  /** When the token was cached (timestamp) */
  cachedAt: number;
}
