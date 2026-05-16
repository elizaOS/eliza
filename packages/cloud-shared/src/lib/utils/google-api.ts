/**
 * Google API Utilities
 *
 * Shared constants and helpers for Google OAuth and API interactions.
 * Supports Gmail, Calendar, and Contacts APIs.
 */

/** Default timeout for Google API requests (30 seconds) */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Create an AbortSignal with a timeout
 * @param timeoutMs - Timeout in milliseconds
 * @returns AbortSignal that will abort after the specified timeout
 */
function createTimeoutSignal(timeoutMs: number = DEFAULT_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export const GOOGLE_AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/**
 * Available Google OAuth scopes for the workflow builder
 */
export const GOOGLE_SCOPES = {
  // Gmail scopes
  GMAIL_READONLY: "https://www.googleapis.com/auth/gmail.readonly",
  GMAIL_SEND: "https://www.googleapis.com/auth/gmail.send",
  GMAIL_MODIFY: "https://www.googleapis.com/auth/gmail.modify",
  GMAIL_COMPOSE: "https://www.googleapis.com/auth/gmail.compose",

  // Calendar scopes
  CALENDAR: "https://www.googleapis.com/auth/calendar",
  CALENDAR_READONLY: "https://www.googleapis.com/auth/calendar.readonly",
  CALENDAR_EVENTS: "https://www.googleapis.com/auth/calendar.events",
  CALENDAR_EVENTS_READONLY: "https://www.googleapis.com/auth/calendar.events.readonly",
  CALENDAR_EVENTS_OWNED: "https://www.googleapis.com/auth/calendar.events.owned",
  CALENDAR_EVENTS_OWNED_READONLY: "https://www.googleapis.com/auth/calendar.events.owned.readonly",
  CALENDAR_CALENDARS_READONLY: "https://www.googleapis.com/auth/calendar.calendars.readonly",

  // Contacts scopes
  CONTACTS_READONLY: "https://www.googleapis.com/auth/contacts.readonly",
  CONTACTS: "https://www.googleapis.com/auth/contacts",

  // Profile scopes (always included)
  USERINFO_EMAIL: "https://www.googleapis.com/auth/userinfo.email",
  USERINFO_PROFILE: "https://www.googleapis.com/auth/userinfo.profile",
} as const;

/**
 * Default scopes for the workflow builder
 * Includes email read/send, calendar, and contacts read
 */
export const DEFAULT_GOOGLE_SCOPES = [
  GOOGLE_SCOPES.USERINFO_EMAIL,
  GOOGLE_SCOPES.USERINFO_PROFILE,
  GOOGLE_SCOPES.GMAIL_READONLY,
  GOOGLE_SCOPES.GMAIL_SEND,
  GOOGLE_SCOPES.GMAIL_MODIFY,
  GOOGLE_SCOPES.GMAIL_COMPOSE,
  GOOGLE_SCOPES.CALENDAR,
  GOOGLE_SCOPES.CALENDAR_READONLY,
  GOOGLE_SCOPES.CALENDAR_EVENTS,
  GOOGLE_SCOPES.CALENDAR_EVENTS_READONLY,
  GOOGLE_SCOPES.CALENDAR_EVENTS_OWNED,
  GOOGLE_SCOPES.CALENDAR_EVENTS_OWNED_READONLY,
  GOOGLE_SCOPES.CALENDAR_CALENDARS_READONLY,
  GOOGLE_SCOPES.CONTACTS_READONLY,
  GOOGLE_SCOPES.CONTACTS,
];

/**
 * Set of all allowed Google OAuth scopes
 * Used to validate user-requested scopes
 */
export const ALLOWED_GOOGLE_SCOPES = new Set<string>(Object.values(GOOGLE_SCOPES));

/**
 * Validate and filter requested scopes to only include allowed ones
 * Returns the filtered list of valid scopes
 */
export function validateGoogleScopes(requestedScopes: string[]): string[] {
  return requestedScopes.filter((scope) => ALLOWED_GOOGLE_SCOPES.has(scope));
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

/**
 * Generate Google OAuth authorization URL
 */
export function generateGoogleAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
  accessType?: "online" | "offline";
  prompt?: "none" | "consent" | "select_account";
}): string {
  const {
    clientId,
    redirectUri,
    state,
    scopes = DEFAULT_GOOGLE_SCOPES,
    accessType = "offline",
    prompt = "consent",
  } = params;

  const url = new URL(GOOGLE_AUTH_BASE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", accessType);
  url.searchParams.set("prompt", prompt);

  return url.toString();
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeGoogleCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse> {
  const { code, clientId, clientSecret, redirectUri } = params;

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    signal: createTimeoutSignal(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google token exchange failed: ${error}`);
  }

  return response.json();
}

/**
 * Refresh Google access token
 */
export async function refreshGoogleToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<GoogleTokenResponse> {
  const { refreshToken, clientId, clientSecret } = params;

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
    signal: createTimeoutSignal(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google token refresh failed: ${error}`);
  }

  return response.json();
}

/**
 * Get user info from Google
 */
export async function getGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal: createTimeoutSignal(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get Google user info: ${error}`);
  }

  return response.json();
}

/**
 * Make an authenticated Google API request
 */
export async function googleApiRequest<T>(
  accessToken: string,
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`,
    },
    // Use provided signal or create timeout signal
    signal: options.signal || createTimeoutSignal(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google API error (${response.status}): ${error}`);
  }

  return response.json();
}

/**
 * Revoke a Google OAuth token
 * This should be called when disconnecting to ensure the token is invalidated at Google's end
 * See: https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke
 */
export async function revokeGoogleToken(token: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const response = await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        token,
      }),
      signal: createTimeoutSignal(),
    });

    // Google returns 200 on success, even if the token was already invalid
    if (response.ok) {
      return { success: true };
    }

    const error = await response.text();
    return { success: false, error: `Token revocation failed: ${error}` };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
