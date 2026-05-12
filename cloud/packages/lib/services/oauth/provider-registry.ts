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

import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { Errors } from "./errors";
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
  /** HTTP method for userInfo endpoint (default: GET). Some providers (e.g. Dropbox) require POST. */
  userInfoMethod?: "GET" | "POST";
  /** URL to revoke tokens (optional - some providers don't support) */
  revoke?: string;
  /** GraphQL query for userInfo endpoint (required if userInfo is a GraphQL endpoint) */
  userInfoGraphQLQuery?: string;
  /**
   * Base URL to fetch token metadata (e.g. user, hub_id) after token exchange.
   * Used by providers like HubSpot that don't return user in the token response.
   * Request: GET {tokenInfo}/{access_token}
   */
  tokenInfo?: string;
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

  /** Superset of scopes this app will allow callers to request for the provider. */
  allowedScopes?: string[];

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
   * Provider-specific routes used when `useGenericRoutes` is false.
   * New providers should set `useGenericRoutes: true` and use the
   * generic routes at /api/v1/oauth/[platform]/... instead.
   */
  routes?: {
    initiate: string;
    callback: string;
    status: string;
    disconnect: string;
  };

  /**
   * Whether to use PKCE (Proof Key for Code Exchange) per RFC 7636.
   * Required by some providers (e.g., Salesforce, Airtable).
   */
  pkce?: boolean;

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
    description: "Gmail, Calendar, and Contacts",
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

  microsoft: {
    id: "microsoft",
    name: "Microsoft",
    description: "Outlook Mail, Calendar, and OneDrive",
    type: "oauth2",
    envVars: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
    endpoints: {
      // Using /consumers/ to support personal Microsoft accounts (@outlook.com, @hotmail.com, @live.com)
      // Use /common/ for multi-tenant apps that support both personal and work/school accounts
      // Use /organizations/ for work/school accounts only
      authorization: "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
      token: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
      userInfo: "https://graph.microsoft.com/v1.0/me",
    },
    defaultScopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Calendars.Read",
      "Calendars.ReadWrite",
      "Mail.Read",
      "Mail.ReadWrite",
      "Mail.Send",
    ],
    userInfoMapping: {
      id: "id",
      email: "mail",
      displayName: "displayName",
      username: "userPrincipalName",
    },
    authParams: {
      response_mode: "query",
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
    tokenContentType: "json",
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
      userInfo: "https://slack.com/api/users.identity",
      revoke: "https://slack.com/api/auth.revoke",
    },
    defaultScopes: ["identity.basic", "users:read", "chat:write", "channels:read"],
    userInfoMapping: {
      id: "user_id",
      displayName: "user",
      // Bot tokens don't return email from auth.test - email is optional for bot auth
    },
    storage: "platform_credentials",
    useGenericRoutes: true,
  },

  hubspot: {
    id: "hubspot",
    name: "HubSpot",
    description: "CRM - contacts, companies, deals, and marketing",
    type: "oauth2",
    envVars: ["HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET"],
    endpoints: {
      authorization: "https://app.hubspot.com/oauth/authorize",
      token: "https://api.hubapi.com/oauth/v1/token",
      // No remote revoke: HubSpot requires DELETE /oauth/v1/refresh-tokens/{token}
      // with the refresh token in the URL path. The generic adapter handles disconnect
      // locally (deletes stored secrets, marks credential revoked in DB).
      // Token exchange does not return user/hub_id; fetch from token metadata endpoint
      tokenInfo: "https://api.hubapi.com/oauth/v1/access-tokens",
    },
    defaultScopes: [
      "crm.objects.contacts.read",
      "crm.objects.contacts.write",
      "crm.objects.companies.read",
      "crm.objects.companies.write",
      "crm.objects.deals.read",
      "crm.objects.deals.write",
      "crm.objects.owners.read",
    ],
    // Mapping is applied to the tokenInfo response (GET /oauth/v1/access-tokens/{token})
    // which returns { hub_id, user, token_type, ... }. No userInfo endpoint needed;
    // the OAuth2 adapter's fetchTokenInfo() handles this via the tokenInfo endpoint above.
    userInfoMapping: {
      id: "hub_id",
      email: "user",
    },
    tokenContentType: "form",
    storage: "platform_credentials",
    useGenericRoutes: true,
  },

  asana: {
    id: "asana",
    name: "Asana",
    description: "Task management, projects, and team collaboration",
    type: "oauth2",
    envVars: ["ASANA_CLIENT_ID", "ASANA_CLIENT_SECRET"],
    endpoints: {
      authorization: "https://app.asana.com/-/oauth_authorize",
      token: "https://app.asana.com/-/oauth_token",
      userInfo: "https://app.asana.com/api/1.0/users/me",
      revoke: "https://app.asana.com/-/oauth_revoke",
    },
    defaultScopes: ["default"],
    userInfoMapping: {
      id: "data.gid",
      email: "data.email",
      displayName: "data.name",
      avatarUrl: "data.photo.image_128x128",
    },
    tokenContentType: "form",
    storage: "platform_credentials",
    useGenericRoutes: true,
  },

  dropbox: {
    id: "dropbox",
    name: "Dropbox",
    description: "File storage, sharing, and collaboration",
    type: "oauth2",
    envVars: ["DROPBOX_CLIENT_ID", "DROPBOX_CLIENT_SECRET"],
    endpoints: {
      authorization: "https://www.dropbox.com/oauth2/authorize",
      token: "https://api.dropboxapi.com/oauth2/token",
      userInfo: "https://api.dropboxapi.com/2/users/get_current_account",
      userInfoMethod: "POST",
      revoke: "https://api.dropboxapi.com/2/auth/token/revoke",
    },
    defaultScopes: [
      "account_info.read",
      "files.metadata.read",
      "files.metadata.write",
      "files.content.read",
      "files.content.write",
      "sharing.read",
      "sharing.write",
    ],
    userInfoMapping: {
      id: "account_id",
      email: "email",
      displayName: "name.display_name",
      avatarUrl: "profile_photo_url",
    },
    authParams: {
      token_access_type: "offline",
    },
    tokenContentType: "form",
    storage: "platform_credentials",
    useGenericRoutes: true,
  },

  salesforce: {
    id: "salesforce",
    name: "Salesforce",
    description: "CRM - accounts, contacts, opportunities, and leads",
    type: "oauth2",
    envVars: ["SALESFORCE_CLIENT_ID", "SALESFORCE_CLIENT_SECRET"],
    endpoints: {
      authorization: "https://login.salesforce.com/services/oauth2/authorize",
      token: "https://login.salesforce.com/services/oauth2/token",
      userInfo: "https://login.salesforce.com/services/oauth2/userinfo",
      revoke: "https://login.salesforce.com/services/oauth2/revoke",
    },
    defaultScopes: ["full", "api", "id", "refresh_token", "chatter_api"],
    userInfoMapping: {
      id: "user_id",
      email: "email",
      displayName: "name",
      avatarUrl: "picture",
    },
    authParams: {
      prompt: "login consent",
    },
    pkce: true,
    storage: "platform_credentials",
    useGenericRoutes: true,
  },

  airtable: {
    id: "airtable",
    name: "Airtable",
    description: "Databases, spreadsheets, and project tracking",
    type: "oauth2",
    envVars: ["AIRTABLE_CLIENT_ID", "AIRTABLE_CLIENT_SECRET"],
    endpoints: {
      authorization: "https://airtable.com/oauth2/v1/authorize",
      token: "https://airtable.com/oauth2/v1/token",
      userInfo: "https://api.airtable.com/v0/meta/whoami",
    },
    defaultScopes: [
      "data.records:read",
      "data.records:write",
      "data.recordComments:read",
      "data.recordComments:write",
      "schema.bases:read",
      "schema.bases:write",
      "user.email:read",
      "webhook:manage",
    ],
    userInfoMapping: {
      id: "id",
      email: "email",
    },
    tokenHeaders: {
      Authorization: "Basic ${base64(CLIENT_ID:CLIENT_SECRET)}",
    },
    tokenContentType: "form",
    pkce: true,
    storage: "platform_credentials",
    useGenericRoutes: true,
  },

  zoom: {
    id: "zoom",
    name: "Zoom",
    description: "Video meetings, webinars, and recordings",
    type: "oauth2",
    envVars: ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"],
    endpoints: {
      authorization: "https://zoom.us/oauth/authorize",
      token: "https://zoom.us/oauth/token",
      userInfo: "https://api.zoom.us/v2/users/me",
      revoke: "https://zoom.us/oauth/revoke",
    },
    defaultScopes: [],
    userInfoMapping: {
      id: "id",
      email: "email",
      displayName: "display_name",
      avatarUrl: "pic_url",
    },
    tokenHeaders: {
      Authorization: "Basic ${base64(CLIENT_ID:CLIENT_SECRET)}",
    },
    tokenContentType: "form",
    storage: "platform_credentials",
    useGenericRoutes: true,
  },

  jira: {
    id: "jira",
    name: "Jira",
    description: "Issue tracking, project management, and agile boards",
    type: "oauth2",
    envVars: ["JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET"],
    endpoints: {
      authorization: "https://auth.atlassian.com/authorize",
      token: "https://auth.atlassian.com/oauth/token",
      userInfo: "https://api.atlassian.com/me",
    },
    defaultScopes: [
      "read:jira-work",
      "read:jira-user",
      "write:jira-work",
      "read:me",
      "offline_access",
    ],
    userInfoMapping: {
      id: "account_id",
      email: "email",
      displayName: "name",
      avatarUrl: "picture",
      username: "nickname",
    },
    authParams: {
      audience: "api.atlassian.com",
      prompt: "consent",
    },
    tokenContentType: "json",
    storage: "platform_credentials",
    useGenericRoutes: true,
  },

  linkedin: {
    id: "linkedin",
    name: "LinkedIn",
    description: "Professional networking, posts, and profiles",
    type: "oauth2",
    envVars: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    endpoints: {
      authorization: "https://www.linkedin.com/oauth/v2/authorization",
      token: "https://www.linkedin.com/oauth/v2/accessToken",
      userInfo: "https://api.linkedin.com/v2/userinfo",
    },
    defaultScopes: ["openid", "profile", "email", "w_member_social"],
    userInfoMapping: {
      id: "sub",
      email: "email",
      displayName: "name",
      avatarUrl: "picture",
    },
    tokenContentType: "form",
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
  const env = getCloudAwareEnv();
  if (provider.id === "twitter") {
    return Boolean((env.TWITTER_API_KEY && env.TWITTER_API_SECRET_KEY) || env.TWITTER_CLIENT_ID);
  }
  return provider.envVars.length === 0 || provider.envVars.every((v) => !!env[v]);
}

/** Get all providers with required env vars configured. */
export function getConfiguredProviders(): OAuthProviderConfig[] {
  return Object.values(OAUTH_PROVIDERS).filter(isProviderConfigured);
}

/** Get configured OAuth providers (oauth2 or oauth1a, not api_key). */
export function getConfiguredOAuthProviders(): OAuthProviderConfig[] {
  return getConfiguredProviders().filter((p) => p.type === "oauth2" || p.type === "oauth1a");
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  if (!scopes) {
    return [];
  }

  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
}

export function getAllowedScopes(provider: OAuthProviderConfig): string[] {
  return normalizeScopes(provider.allowedScopes ?? provider.defaultScopes ?? []);
}

export function resolveRequestedScopes(
  provider: OAuthProviderConfig,
  requestedScopes?: string[],
): string[] {
  const normalizedRequested = normalizeScopes(requestedScopes);
  if (normalizedRequested.length === 0) {
    return normalizeScopes(provider.defaultScopes);
  }

  const allowedScopes = getAllowedScopes(provider);
  const invalidScopes = normalizedRequested.filter((scope) => !allowedScopes.includes(scope));
  if (invalidScopes.length > 0) {
    throw Errors.invalidScopeRequest(provider.id, invalidScopes);
  }

  return normalizedRequested;
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
  const env = getCloudAwareEnv();
  const v = provider.envVars.find((e) => e.includes("CLIENT_ID") || e.includes("API_KEY"));
  return v ? env[v] : undefined;
}

/** Get client secret from provider's env vars. */
export function getClientSecret(provider: OAuthProviderConfig): string | undefined {
  const env = getCloudAwareEnv();
  const v = provider.envVars.find((e) => e.includes("CLIENT_SECRET") || e.includes("SECRET_KEY"));
  return v ? env[v] : undefined;
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
