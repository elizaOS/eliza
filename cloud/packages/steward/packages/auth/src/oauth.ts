/**
 * oauth.ts — Generic OAuth2 authorization-code flow helper
 *
 * Supports any provider that follows the standard OAuth2 authorization-code flow.
 * Built-in configs for Google, Discord, and Twitter/X.
 *
 * Twitter specifics:
 *   - Requires PKCE (RFC 7636, S256 method) — Twitter OAuth2 mandates it for
 *     confidential clients.
 *   - Does NOT return an email address. provisionOAuthUser() in auth.ts must
 *     handle this by generating a synthetic internal email.
 *   - User info endpoint returns { data: { id, name, username } }, not a flat object.
 *
 * Usage:
 *   const client = new OAuthClient(config, 'google');
 *   const { url, codeVerifier } = client.generateAuthUrl(state, redirectUri);
 *   // store codeVerifier in challenge store alongside state
 *   const { access_token } = await client.exchangeCode(code, redirectUri, codeVerifier);
 *   const profile = await client.getUserInfo(access_token);
 */

import { createHash, randomBytes } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OAuthProvider {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  /** If true, PKCE (S256) is added to the auth URL and required in code exchange. */
  requiresPkce?: boolean;
  emailUrl?: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface OAuthUserInfo {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  verified_email?: boolean;
}

interface OAuthEmailAddress {
  email: string;
  primary?: boolean;
  verified?: boolean;
}

export interface AuthUrlResult {
  url: string;
  /** Present when requiresPkce=true. Must be stored and passed to exchangeCode(). */
  codeVerifier?: string;
}

// ─── Built-in Provider Configs ───────────────────────────────────────────────

const BUILT_IN_PROVIDERS = ["google", "discord", "twitter", "github"] as const;
type BuiltInProvider = (typeof BUILT_IN_PROVIDERS)[number];

/**
 * Returns true if the given provider name is a known built-in OAuth provider.
 */
export function isBuiltInProvider(provider: string): provider is BuiltInProvider {
  return (BUILT_IN_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Returns the list of OAuth providers that are currently enabled via environment variables.
 */
export function getEnabledProviders(): string[] {
  const enabled: string[] = [];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    enabled.push("google");
  }
  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
    enabled.push("discord");
  }
  if (process.env.TWITTER_CLIENT_ID && process.env.TWITTER_CLIENT_SECRET) {
    enabled.push("twitter");
  }
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    enabled.push("github");
  }
  return enabled;
}

/**
 * Returns the provider configuration for a built-in OAuth provider.
 * Reads credentials from environment variables.
 *
 * @throws Error if the required environment variables are not set.
 */
export function getProviderConfig(provider: string): OAuthProvider {
  switch (provider) {
    case "google": {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error(
          "Google OAuth not configured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required",
        );
      }
      return {
        clientId,
        clientSecret,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        userInfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
        scopes: ["openid", "email", "profile"],
      };
    }

    case "discord": {
      const clientId = process.env.DISCORD_CLIENT_ID;
      const clientSecret = process.env.DISCORD_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error(
          "Discord OAuth not configured: DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are required",
        );
      }
      return {
        clientId,
        clientSecret,
        authorizationUrl: "https://discord.com/api/oauth2/authorize",
        tokenUrl: "https://discord.com/api/oauth2/token",
        userInfoUrl: "https://discord.com/api/users/@me",
        scopes: ["identify", "email"],
      };
    }

    case "twitter": {
      const clientId = process.env.TWITTER_CLIENT_ID;
      const clientSecret = process.env.TWITTER_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error(
          "Twitter OAuth not configured: TWITTER_CLIENT_ID and TWITTER_CLIENT_SECRET are required",
        );
      }
      return {
        clientId,
        clientSecret,
        // X (formerly Twitter) finished migrating to x.com domain. The user-
        // facing authorize URL is the most visible, but all 3 endpoints work
        // identically on x.com today.
        authorizationUrl: "https://x.com/i/oauth2/authorize",
        tokenUrl: "https://api.x.com/2/oauth2/token",
        // id, name, username — X v2 does NOT expose email via this endpoint
        userInfoUrl: "https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url",
        scopes: ["tweet.read", "users.read", "offline.access"],
        requiresPkce: true,
      };
    }

    case "github": {
      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error(
          "GitHub OAuth not configured: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required",
        );
      }
      return {
        clientId,
        clientSecret,
        authorizationUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        userInfoUrl: "https://api.github.com/user",
        emailUrl: "https://api.github.com/user/emails",
        scopes: ["read:user", "user:email"],
      };
    }

    default:
      throw new Error(`Unknown OAuth provider: ${provider}`);
  }
}

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

function uint8ArrayToBase64url(arr: Uint8Array): string {
  const base64 = btoa(Array.from(arr, (byte) => String.fromCharCode(byte)).join(""));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  // RFC 7636 §4.1: 43-128 unreserved chars; 32 random bytes → 64 hex chars
  return randomBytes(32).toString("hex");
}

function deriveCodeChallenge(verifier: string): string {
  // RFC 7636 §4.2: BASE64URL(SHA256(ASCII(code_verifier)))
  return uint8ArrayToBase64url(createHash("sha256").update(verifier).digest());
}

// ─── OAuthClient ─────────────────────────────────────────────────────────────

/**
 * Generic OAuth2 authorization-code flow client.
 * Supports PKCE (S256) when the provider's requiresPkce flag is true.
 */
export class OAuthClient {
  private readonly provider: OAuthProvider;

  constructor(provider: OAuthProvider) {
    this.provider = provider;
  }

  /**
   * Generates the authorization URL to redirect the user to.
   *
   * @param state      - CSRF state token (random, stored server-side)
   * @param redirectUri - Where the provider should send the user after auth
   * @returns url and, when PKCE is required, a codeVerifier to store server-side
   */
  generateAuthUrl(state: string, redirectUri: string): AuthUrlResult {
    const params = new URLSearchParams({
      client_id: this.provider.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: this.provider.scopes.join(" "),
      state,
    });

    let codeVerifier: string | undefined;
    if (this.provider.requiresPkce) {
      codeVerifier = generateCodeVerifier();
      params.set("code_challenge_method", "S256");
      params.set("code_challenge", deriveCodeChallenge(codeVerifier));
    }

    return {
      url: `${this.provider.authorizationUrl}?${params.toString()}`,
      codeVerifier,
    };
  }

  /**
   * Exchanges an authorization code for an access token.
   *
   * @param code         - The authorization code from the provider callback
   * @param redirectUri  - Must match the one used in generateAuthUrl
   * @param codeVerifier - Required when PKCE was used in generateAuthUrl
   */
  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
  ): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.provider.clientId,
      client_secret: this.provider.clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    if (this.provider.requiresPkce) {
      if (!codeVerifier) {
        throw new Error("codeVerifier is required for PKCE providers");
      }
      body.set("code_verifier", codeVerifier);
    }

    const res = await fetch(this.provider.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token exchange failed (${res.status}): ${text}`);
    }

    return res.json() as Promise<OAuthTokenResponse>;
  }

  /**
   * Fetches the authenticated user's profile from the provider.
   *
   * Handles provider-specific response shapes:
   * - Google/Discord: flat object with standard fields
   * - Twitter: nested `{ data: { id, name, username } }` — no email field
   *
   * For Twitter, email will be empty string. Callers must handle this:
   * use `twitter.${id}@id.steward.internal` as a synthetic identity key.
   *
   * @param accessToken - The access token from exchangeCode
   */
  async getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const res = await fetch(this.provider.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`getUserInfo failed (${res.status}): ${text}`);
    }

    const raw = (await res.json()) as Record<string, unknown>;

    // Twitter v2 wraps user data in a `data` envelope
    const data: Record<string, unknown> =
      raw.data != null && typeof raw.data === "object"
        ? (raw.data as Record<string, unknown>)
        : raw;

    const userInfo = {
      id: String(data.id ?? data.sub ?? ""),
      // Twitter does not expose email — leave as empty string; caller must handle
      email: String(data.email ?? ""),
      name:
        data.name != null
          ? String(data.name)
          : data.username != null
            ? String(data.username)
            : undefined,
      picture:
        data.profile_image_url != null
          ? String(data.profile_image_url)
          : data.picture != null
            ? String(data.picture)
            : data.avatar_url != null
              ? String(data.avatar_url)
              : data.avatar != null
                ? String(data.avatar)
                : undefined,
      verified_email: Boolean(data.verified_email ?? data.email_verified ?? data.verified ?? false),
    } satisfies OAuthUserInfo;

    if (!userInfo.email && this.provider.emailUrl) {
      const emailInfo = await this.getPrimaryEmail(accessToken);
      if (emailInfo) {
        userInfo.email = emailInfo.email;
        userInfo.verified_email = emailInfo.verified ?? userInfo.verified_email;
      }
    }

    return userInfo;
  }

  private async getPrimaryEmail(accessToken: string): Promise<OAuthEmailAddress | null> {
    if (!this.provider.emailUrl) return null;

    const res = await fetch(this.provider.emailUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`getPrimaryEmail failed (${res.status}): ${text}`);
    }

    const raw = await res.json();
    if (!Array.isArray(raw)) return null;

    const emails = raw.filter(
      (entry): entry is OAuthEmailAddress =>
        entry != null && typeof entry === "object" && typeof entry.email === "string",
    );

    return (
      emails.find((entry) => entry.primary && entry.verified) ??
      emails.find((entry) => entry.primary) ??
      emails.find((entry) => entry.verified) ??
      emails[0] ??
      null
    );
  }
}
