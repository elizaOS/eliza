/**
 * OAuth Provider Registry
 *
 * Config-driven OAuth provider system. Adding a new OAuth provider requires:
 * 1. Add provider config to OAUTH_PROVIDERS
 * 2. Set environment variables (CLIENT_ID, CLIENT_SECRET)
 * 3. Done - generic routes handle the rest
 *
 * Supports:
 * - OAuth 2.0 (most providers: Google, Linear, Notion, GitHub, etc.)
 * - OAuth 1.0a (Twitter/X)
 * - API Key (Twilio, Blooio - user provides credentials)
 */

import type { OAuthProviderType } from "./types";

/**
 * OAuth endpoint URLs for the authorization flow.
 */
export interface OAuthEndpoints {
  /** URL to redirect user for authorization (OAuth 2.0/1.0a) */
  authorization: string;
  /** URL to exchange code for tokens (OAuth 2.0) or request token (OAuth 1.0a) */
  token: string;
  /** URL to fetch user profile info after authorization (optional) */
  userInfo?: string;
  /** URL to revoke tokens (optional - some providers don't support) */
  revoke?: string;
  /** GraphQL query for userInfo endpoint (required if userInfo is a GraphQL endpoint) */
  userInfoGraphQLQuery?: string;
}

/**
 * Mapping configuration for extracting user info from provider responses.
 * Uses dot notation for nested paths (e.g., "data.viewer.id" for GraphQL).
 */
export interface UserInfoMapping {
  /** Path to user's unique ID on the platform */
  id: string;
  /** Path to user's email address */
  email?: string;
  /** Path to username/handle */
  username?: string;
  /** Path to display name */
  displayName?: string;
  /** Path to avatar/profile image URL */
  avatarUrl?: string;
}

/**
 * Mapping for non-standard token response fields.
 * Most OAuth2 providers use standard field names, but some differ.
 */
export interface TokenMapping {
  /** Field name for access token (default: "access_token") */
  accessToken?: string;
  /** Field name for refresh token (default: "refresh_token") */
  refreshToken?: string;
  /** Field name for expiry in seconds (default: "expires_in") */
  expiresIn?: string;
  /** Field name for token type (default: "token_type") */
  tokenType?: string;
  /** Field name for granted scopes (default: "scope") */
  scope?: string;
}

/**
 * Credential fields for API key providers.
 * Defines what information the user needs to provide.
 */
export interface CredentialField {
  /** Field identifier */
  key: string;
  /** Human-readable label */
  label: string;
  /** Help text for the field */
  description: string;
  /** Whether this field is required */
  required: boolean;
  /** Whether to mask the input (for secrets) */
  secret: boolean;
  /** Placeholder text */
  placeholder?: string;
}

/**
 * Full OAuth provider configuration.
 */
export interface OAuthProviderConfig {
  /** Unique provider identifier (lowercase, e.g., "google", "linear") */
  id: string;
  /** Human-readable provider name */
  name: string;
  /** Description of what this provider enables */
  description: string;
  /** OAuth type */
  type: OAuthProviderType;

  /** Environment variables required for this provider */
  envVars: string[];

  /**
   * OAuth endpoints for authorization flow.
   * Required for oauth2 and oauth1a types.
   */
  endpoints?: OAuthEndpoints;

  /** Default OAuth scopes to request */
  defaultScopes?: string[];

  /**
   * How to extract user info from the userInfo endpoint response.
   * If not provided, uses standard OAuth2 claims.
   */
  userInfoMapping?: UserInfoMapping;

  /**
   * How to map token response fields if non-standard.
   * Most providers use standard OAuth2 field names.
   */
  tokenMapping?: TokenMapping;

  /**
   * Additional authorization URL parameters.
   * e.g., { access_type: "offline", prompt: "consent" } for Google
   */
  authParams?: Record<string, string>;

  /**
   * Additional token exchange parameters.
   * Some providers require extra fields in token requests.
   */
  tokenParams?: Record<string, string>;

  /**
   * Headers to include in token exchange request.
   * Some providers require specific headers (e.g., Basic auth).
   */
  tokenHeaders?: Record<string, string>;

  /**
   * Content type for token exchange request.
   * Most use "application/x-www-form-urlencoded", some use "application/json".
   */
  tokenContentType?: "form" | "json";

  /** Storage type for credentials */
  storage: "platform_credentials" | "secrets";

  /**
   * For secrets-based storage, the secret name patterns.
   */
  secretPatterns?: {
    accessToken?: string;
    accessTokenSecret?: string;
    refreshToken?: string;
    username?: string;
    userId?: string;
    apiKey?: string;
    accountSid?: string;
    authToken?: string;
    phoneNumber?: string;
    webhookSecret?: string;
    fromNumber?: string;
  };

  /**
   * For API key providers, the credential fields to collect.
   */
  credentialFields?: CredentialField[];

  /**
   * Legacy routes for backwards compatibility.
   * New providers should use generic routes: /api/v1/oauth/[platform]/...
   * @deprecated Use generic routes for new providers
   */
  routes?: {
    initiate: string;
    callback: string;
    status: string;
    disconnect: string;
  };

  /**
   * Whether this provider uses the generic OAuth routes.
   * Set to true for new providers. Legacy providers have this as false/undefined.
   */
  useGenericRoutes?: boolean;
}

/**
 * Registry of all supported OAuth providers.
 */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  google: {
    id: "google",
    name: "Google",
    description: "Gmail, Calendar, Drive, and Contacts",
    type: "oauth2",
    envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    endpoints: {
      authorization: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
      userInfo: "https://www.googleapis.com/oauth2/v2/userinfo",
      revoke: "https://oauth2.googleapis.com/revoke",
    },
    defaultScopes: [
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/contacts.readonly",
    ],
    userInfoMapping: {
      id: "id",
      email: "email",
      displayName: "name",
      avatarUrl: "picture",
    },
    authParams: {
      access_type: "offline",
      prompt: "consent",
    },
    storage: "platform_credentials",
    useGenericRoutes: true,
  },

  linear: {
    id: "linear",
    name: "Linear",
    description: "Issue tracking and project management",
    type: "oauth2",
    envVars: ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"],
    endpoints: {
      authorization: "https://linear.app/oauth/authorize",
      token: "https://api.linear.app/oauth/token",
      userInfo: "https://api.linear.app/graphql",
      userInfoGraphQLQuery: "query { viewer { id email name avatarUrl } }",
      revoke: "https://api.linear.app/oauth/revoke",
    },
    defaultScopes: ["read", "write", "issues:create"],
    userInfoMapping: {
      id: "data.viewer.id",
      email: "data.viewer.email",
      displayName: "data.viewer.name",
      avatarUrl: "data.viewer.avatarUrl",
    },
    authParams: {
      response_type: "code",
      actor: "user",
    },
    tokenContentType: "form", // Linear requires x-www-form-urlencoded
    storage: "platform_credentials",
    useGenericRoutes: true,
  },

  notion: {
    id: "notion",
    name: "Notion",
    description: "Notes, docs, wikis, and databases",
    type: "oauth2",
    envVars: ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"],
    endpoints: {
      authorization: "https://api.notion.com/v1/oauth/authorize",
      token: "https://api.notion.com/v1/oauth/token",
    },
    defaultScopes: [], // Notion uses workspace-level permissions, not scopes
    userInfoMapping: {
      id: "owner.user.id",
      email: "owner.user.person.email",
      displayName: "owner.user.name",
      avatarUrl: "owner.user.avatar_url",
    },
    tokenHeaders: {
      Authorization: "Basic ${base64(CLIENT_ID:CLIENT_SECRET)}",
    },
    tokenContentType: "json",
    storage: "platform_credentials",
    useGenericRoutes: true,
  },

  github: {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues, pull requests, and gists",
    type: "oauth2",
    envVars: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
    endpoints: {
      authorization: "https://github.com/login/oauth/authorize",
      token: "https://github.com/login/oauth/access_token",
      userInfo: "https://api.github.com/user",
    },
    defaultScopes: ["read:user", "user:email", "repo"],
    userInfoMapping: {
      id: "id",
      email: "email",
      username: "login",
      displayName: "name",
      avatarUrl: "avatar_url",
    },
    tokenHeaders: {
      Accept: "application/json",
    },
    storage: "platform_credentials",
    useGenericRoutes: true,
  },

  slack: {
    id: "slack",
    name: "Slack",
    description: "Team messaging, channels, and notifications",
    type: "oauth2",
    envVars: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
    endpoints: {
      authorization: "https://slack.com/oauth/v2/authorize",
      token: "https://slack.com/api/oauth.v2.access",
      userInfo: "https://slack.com/api/auth.test", // Use auth.test for bot tokens
      revoke: "https://slack.com/api/auth.revoke",
    },
    // Bot scopes only - these must also be added in Slack app's OAuth & Permissions
    defaultScopes: ["chat:write", "channels:read", "users:read"],
    userInfoMapping: {
      id: "user_id",
      displayName: "user",
      // Bot tokens don't return email from auth.test - email is optional for bot auth
    },
    storage: "platform_credentials",
    useGenericRoutes: true,
  },

  twitter: {
    id: "twitter",
    name: "Twitter/X",
    description: "Post tweets, read timeline",
    type: "oauth1a",
    envVars: ["TWITTER_API_KEY", "TWITTER_API_SECRET_KEY"],
    endpoints: {
      authorization: "https://api.twitter.com/oauth/authorize",
      token: "https://api.twitter.com/oauth/access_token",
    },
    storage: "secrets",
    secretPatterns: {
      accessToken: "TWITTER_ACCESS_TOKEN",
      accessTokenSecret: "TWITTER_ACCESS_TOKEN_SECRET",
      username: "TWITTER_USERNAME",
      userId: "TWITTER_USER_ID",
    },
    routes: {
      initiate: "/api/v1/twitter/connect",
      callback: "/api/v1/twitter/callback",
      status: "/api/v1/twitter/status",
      disconnect: "/api/v1/twitter/disconnect",
    },
    useGenericRoutes: false,
  },

  twilio: {
    id: "twilio",
    name: "Twilio",
    description: "SMS and voice messaging",
    type: "api_key",
    envVars: [],
    storage: "secrets",
    secretPatterns: {
      accountSid: "TWILIO_ACCOUNT_SID",
      authToken: "TWILIO_AUTH_TOKEN",
      phoneNumber: "TWILIO_PHONE_NUMBER",
    },
    credentialFields: [
      {
        key: "accountSid",
        label: "Account SID",
        description: "Your Twilio Account SID from the console",
        required: true,
        secret: false,
        placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      },
      {
        key: "authToken",
        label: "Auth Token",
        description: "Your Twilio Auth Token from the console",
        required: true,
        secret: true,
      },
      {
        key: "phoneNumber",
        label: "Phone Number",
        description: "Your Twilio phone number in E.164 format",
        required: true,
        secret: false,
        placeholder: "+1234567890",
      },
    ],
    routes: {
      initiate: "/api/v1/twilio/connect",
      callback: "",
      status: "/api/v1/twilio/status",
      disconnect: "/api/v1/twilio/disconnect",
    },
    useGenericRoutes: false,
  },

  blooio: {
    id: "blooio",
    name: "Blooio",
    description: "iMessage integration",
    type: "api_key",
    envVars: [],
    storage: "secrets",
    secretPatterns: {
      apiKey: "BLOOIO_API_KEY",
      webhookSecret: "BLOOIO_WEBHOOK_SECRET",
      fromNumber: "BLOOIO_FROM_NUMBER",
    },
    credentialFields: [
      {
        key: "apiKey",
        label: "API Key",
        description: "Your Blooio API key",
        required: true,
        secret: true,
      },
      {
        key: "webhookSecret",
        label: "Webhook Secret",
        description: "Secret for webhook signature verification",
        required: false,
        secret: true,
      },
      {
        key: "fromNumber",
        label: "From Number",
        description: "Your iMessage number",
        required: true,
        secret: false,
        placeholder: "+1234567890",
      },
    ],
    routes: {
      initiate: "/api/v1/blooio/connect",
      callback: "",
      status: "/api/v1/blooio/status",
      disconnect: "/api/v1/blooio/disconnect",
    },
    useGenericRoutes: false,
  },
};

/** Get provider config by ID (case-insensitive). */
export function getProvider(platformId: string): OAuthProviderConfig | null {
  return OAUTH_PROVIDERS[platformId.toLowerCase()] || null;
}

/** Check if provider has required env vars (API key providers always return true). */
export function isProviderConfigured(provider: OAuthProviderConfig): boolean {
  return provider.envVars.length === 0 || provider.envVars.every((v) => !!process.env[v]);
}

/** Get all providers with required env vars configured. */
export function getConfiguredProviders(): OAuthProviderConfig[] {
  return Object.values(OAUTH_PROVIDERS).filter(isProviderConfigured);
}

/** Get configured OAuth providers (oauth2 or oauth1a, not api_key). */
export function getConfiguredOAuthProviders(): OAuthProviderConfig[] {
  return getConfiguredProviders().filter((p) => p.type === "oauth2" || p.type === "oauth1a");
}

/** Get all provider IDs. */
export function getAllProviderIds(): string[] {
  return Object.keys(OAUTH_PROVIDERS);
}

/** Check if platform ID is a valid provider. */
export function isValidProvider(platformId: string): boolean {
  return platformId.toLowerCase() in OAUTH_PROVIDERS;
}

/** Get client ID from provider's env vars. */
export function getClientId(provider: OAuthProviderConfig): string | undefined {
  const v = provider.envVars.find((e) => e.includes("CLIENT_ID") || e.includes("API_KEY"));
  return v ? process.env[v] : undefined;
}

/** Get client secret from provider's env vars. */
export function getClientSecret(provider: OAuthProviderConfig): string | undefined {
  const v = provider.envVars.find((e) => e.includes("CLIENT_SECRET") || e.includes("SECRET_KEY"));
  return v ? process.env[v] : undefined;
}

/** Build callback URL for provider. */
export function getCallbackUrl(provider: OAuthProviderConfig, baseUrl: string): string {
  if (provider.useGenericRoutes) return `${baseUrl}/api/v1/oauth/${provider.id}/callback`;
  return provider.routes?.callback ? `${baseUrl}${provider.routes.callback}` : "";
}

/** Extract nested value using dot notation (e.g., "data.viewer.id"). */
export function getNestedValue(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
