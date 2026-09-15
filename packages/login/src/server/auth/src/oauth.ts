/**
 * oauth.ts — Generic OAuth2 authorization-code flow helper
 *
 * Supports any provider that follows the standard OAuth2 authorization-code flow.
 * Built-in configs for Google, Discord, Twitter/X, GitHub, LinkedIn, Spotify,
 * Twitch, Instagram, LINE, Apple, and TikTok.
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
import { APPLE_ISSUER, APPLE_JWKS_URI, verifyAppleIdToken } from "./apple";

const OAUTH_PROVIDER_TIMEOUT_MS = 10_000;
const MAX_OAUTH_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

async function discardProviderBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation errors are also provider-controlled stream failures. Never
    // let them replace the sanitized operation/status error below.
  }
}

async function readBoundedProviderJson(
  response: Response,
  operation: string,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const bytes = Number(declaredLength);
    if (
      !Number.isFinite(bytes) ||
      bytes < 0 ||
      bytes > MAX_OAUTH_PROVIDER_RESPONSE_BYTES
    ) {
      await discardProviderBody(response);
      throw new Error(`${operation} returned an oversized response`);
    }
  }

  if (!response.body)
    throw new Error(`${operation} returned an empty response`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OAUTH_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`${operation} returned an oversized response`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OAuthProvider {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  scopeDelimiter?: " " | ",";
  /** If true, PKCE (S256) is added to the auth URL and required in code exchange. */
  requiresPkce?: boolean;
  emailUrl?: string;
  profileMap?: OAuthProfileMap;
  /**
   * Overrides the OAuth `client_id` parameter name on the authorize and token
   * requests. TikTok, for example, names the parameter `client_key` rather than
   * `client_id`. The internal config field stays `clientId`; only the wire
   * parameter name changes. Defaults to "client_id".
   */
  clientIdParam?: string;
  /**
   * Asserts that this provider returns a confirmed/verified account email even
   * though its userinfo response carries no per-response verification flag.
   * Only set this when the provider's contract proves email verification.
   */
  assertsEmailVerified?: boolean;
  /**
   * Marks the provider as OIDC: the user's identity is derived from the
   * `id_token` returned by the token endpoint (verified against `oidcJwksUri`),
   * not from a userinfo endpoint. Used for "Sign in with Apple", which exposes
   * no userinfo endpoint. When set, getUserInfo() verifies the id_token from the
   * preceding exchangeCode() call instead of calling userInfoUrl.
   */
  oidc?: OAuthOidcConfig;
}

export interface OAuthOidcConfig {
  /** Expected issuer (`iss`) of the id_token. */
  issuer: string;
  /** JWKS endpoint used to verify the id_token signature. */
  jwksUri: string;
}

export interface OAuthProfileMap {
  id?: string;
  email?: string;
  name?: string;
  picture?: string;
  emailVerified?: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  /** Present for OIDC providers (e.g. Apple). A JWT carrying the user identity. */
  id_token?: string;
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

const BUILT_IN_PROVIDERS = [
  "google",
  "discord",
  "twitter",
  "github",
  "linkedin",
  "spotify",
  "twitch",
  "instagram",
  "line",
  "apple",
  "tiktok",
] as const;
type BuiltInProvider = (typeof BUILT_IN_PROVIDERS)[number];
const CUSTOM_PROVIDER_PREFIX = "custom:";

function normalizeCustomProviderId(id: string): string {
  return id.startsWith(CUSTOM_PROVIDER_PREFIX)
    ? id.slice(CUSTOM_PROVIDER_PREFIX.length)
    : id;
}

function customProviderName(id: string): string {
  return `${CUSTOM_PROVIDER_PREFIX}${normalizeCustomProviderId(id)}`;
}

/**
 * Returns true if the given provider name is a known built-in OAuth provider.
 */
export function isBuiltInProvider(
  provider: string,
): provider is BuiltInProvider | string {
  return (
    (BUILT_IN_PROVIDERS as readonly string[]).includes(provider) ||
    Boolean(getCustomProviderConfig(provider))
  );
}

/**
 * Returns the list of OAuth providers that are currently enabled via environment variables.
 */
export function getEnabledProviders(): string[] {
  const enabled: string[] = [];
  for (const provider of BUILT_IN_PROVIDERS) {
    if (hasProviderCredentials(provider)) enabled.push(provider);
  }
  enabled.push(
    ...getCustomProviderConfigs().map((provider) =>
      customProviderName(provider.id),
    ),
  );
  return enabled;
}

/**
 * Returns the provider configuration for a built-in OAuth provider.
 * Reads credentials from environment variables.
 *
 * @throws Error if the required environment variables are not set.
 */
// Per-provider URL overrides — used to point OAuth flows at a local fake
// provider in non-production environments. Reading these from env (rather
// than threading config through every call site) keeps the production path
// unchanged when the overrides are unset.
function overrideUrl(
  provider: string,
  kind: "AUTHORIZATION" | "TOKEN" | "USERINFO",
): string | undefined {
  const key = `${provider.toUpperCase()}_${kind}_URL`;
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function envPrefix(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function envCredential(
  provider: string,
  kind: "CLIENT_ID" | "CLIENT_SECRET",
): string | undefined {
  const value = process.env[`${envPrefix(provider)}_${kind}`];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function hasProviderCredentials(provider: string): boolean {
  return Boolean(
    envCredential(provider, "CLIENT_ID") &&
      envCredential(provider, "CLIENT_SECRET"),
  );
}

function requireCredentials(
  provider: string,
  label: string,
): { clientId: string; clientSecret: string } {
  const clientId = envCredential(provider, "CLIENT_ID");
  const clientSecret = envCredential(provider, "CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error(
      `${label} OAuth not configured: ${envPrefix(provider)}_CLIENT_ID and ${envPrefix(provider)}_CLIENT_SECRET are required`,
    );
  }
  return { clientId, clientSecret };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function allowInsecureProviderUrls(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.STEWARD_ALLOW_INSECURE_OAUTH_PROVIDER_URLS === "true"
  );
}

function assertProviderUrl(name: string, value: string): void {
  if (isHttpsUrl(value)) return;
  if (allowInsecureProviderUrls()) {
    try {
      new URL(value);
      return;
    } catch {
      // Fall through to the uniform error below.
    }
  }
  throw new Error(`${name} must be an https URL`);
}

function readMappedValue(
  source: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0 || parts.length > 10) return undefined;

  let current: unknown = source;
  for (const part of parts) {
    if (
      part === "__proto__" ||
      part === "prototype" ||
      part === "constructor"
    ) {
      return undefined;
    }
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
      continue;
    }
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

type CustomOAuthProviderInput = OAuthProvider & { id: string };

function getCustomProviderConfigs(): CustomOAuthProviderInput[] {
  const raw = process.env.STEWARD_CUSTOM_OAUTH_PROVIDERS?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("STEWARD_CUSTOM_OAUTH_PROVIDERS must be a JSON array");
  }
  return parsed.map((entry, index): CustomOAuthProviderInput => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(
        `Custom OAuth provider at index ${index} must be an object`,
      );
    }
    const candidate = entry as Record<string, unknown>;
    const id =
      typeof candidate.id === "string"
        ? normalizeCustomProviderId(candidate.id.trim())
        : "";
    const clientId =
      typeof candidate.clientId === "string" ? candidate.clientId.trim() : "";
    const clientSecret =
      typeof candidate.clientSecret === "string"
        ? candidate.clientSecret.trim()
        : "";
    const authorizationUrl =
      typeof candidate.authorizationUrl === "string"
        ? candidate.authorizationUrl.trim()
        : "";
    const tokenUrl =
      typeof candidate.tokenUrl === "string" ? candidate.tokenUrl.trim() : "";
    const userInfoUrl =
      typeof candidate.userInfoUrl === "string"
        ? candidate.userInfoUrl.trim()
        : "";
    const scopes = Array.isArray(candidate.scopes)
      ? candidate.scopes.filter(
          (scope): scope is string =>
            typeof scope === "string" && scope.trim().length > 0,
        )
      : [];
    if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(id)) {
      throw new Error(
        `Custom OAuth provider at index ${index} has an invalid id`,
      );
    }
    // SEC-137: custom providers win over built-ins in getProviderConfig, so an
    // id matching a built-in would silently shadow it. Reject the collision —
    // built-in endpoint overrides already have a supported mechanism
    // (<PROVIDER>_AUTHORIZATION_URL / _TOKEN_URL / _USERINFO_URL env vars).
    if ((BUILT_IN_PROVIDERS as readonly string[]).includes(id)) {
      throw new Error(
        `Custom OAuth provider "${id}" shadows a built-in provider; use a distinct id or the ${envPrefix(id)}_*_URL overrides`,
      );
    }
    for (const [name, url] of [
      ["authorizationUrl", authorizationUrl],
      ["tokenUrl", tokenUrl],
      ["userInfoUrl", userInfoUrl],
    ] as const) {
      if (!isHttpsUrl(url)) {
        throw new Error(
          `Custom OAuth provider ${id} ${name} must be an https URL`,
        );
      }
    }
    const emailUrl =
      typeof candidate.emailUrl === "string" && candidate.emailUrl.trim()
        ? candidate.emailUrl.trim()
        : undefined;
    if (emailUrl && !isHttpsUrl(emailUrl)) {
      throw new Error(
        `Custom OAuth provider ${id} emailUrl must be an https URL`,
      );
    }
    if (!clientId || !clientSecret) {
      throw new Error(
        `Custom OAuth provider ${id} requires clientId and clientSecret`,
      );
    }
    return {
      id,
      clientId,
      clientSecret,
      authorizationUrl,
      tokenUrl,
      userInfoUrl,
      scopes,
      scopeDelimiter: candidate.scopeDelimiter === "," ? "," : " ",
      requiresPkce: candidate.requiresPkce === true,
      emailUrl,
      profileMap:
        typeof candidate.profileMap === "object" &&
        candidate.profileMap !== null &&
        !Array.isArray(candidate.profileMap)
          ? (candidate.profileMap as OAuthProfileMap)
          : undefined,
    };
  });
}

function getCustomProviderConfig(provider: string): OAuthProvider | undefined {
  const id = normalizeCustomProviderId(provider);
  const found = getCustomProviderConfigs().find(
    (candidate) => candidate.id === id,
  );
  if (!found) return undefined;
  const { id: _id, ...config } = found;
  return config;
}

export function getProviderConfig(provider: string): OAuthProvider {
  const customProvider = getCustomProviderConfig(provider);
  if (customProvider) return customProvider;

  switch (provider) {
    case "google": {
      const { clientId, clientSecret } = requireCredentials("google", "Google");
      return {
        clientId,
        clientSecret,
        authorizationUrl:
          overrideUrl("google", "AUTHORIZATION") ??
          "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl:
          overrideUrl("google", "TOKEN") ??
          "https://oauth2.googleapis.com/token",
        userInfoUrl:
          overrideUrl("google", "USERINFO") ??
          "https://www.googleapis.com/oauth2/v3/userinfo",
        scopes: ["openid", "email", "profile"],
      };
    }

    case "discord": {
      const { clientId, clientSecret } = requireCredentials(
        "discord",
        "Discord",
      );
      return {
        clientId,
        clientSecret,
        authorizationUrl:
          overrideUrl("discord", "AUTHORIZATION") ??
          "https://discord.com/api/oauth2/authorize",
        tokenUrl:
          overrideUrl("discord", "TOKEN") ??
          "https://discord.com/api/oauth2/token",
        userInfoUrl:
          overrideUrl("discord", "USERINFO") ??
          "https://discord.com/api/users/@me",
        scopes: ["identify", "email"],
      };
    }

    case "twitter": {
      const { clientId, clientSecret } = requireCredentials(
        "twitter",
        "Twitter",
      );
      return {
        clientId,
        clientSecret,
        // X (formerly Twitter) finished migrating to x.com domain. The user-
        // facing authorize URL is the most visible, but all 3 endpoints work
        // identically on x.com today.
        authorizationUrl: "https://x.com/i/oauth2/authorize",
        tokenUrl: "https://api.x.com/2/oauth2/token",
        // id, name, username — X v2 does NOT expose email via this endpoint
        userInfoUrl:
          "https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url",
        scopes: ["tweet.read", "users.read", "offline.access"],
        requiresPkce: true,
      };
    }

    case "github": {
      const { clientId, clientSecret } = requireCredentials("github", "GitHub");
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

    case "linkedin": {
      const { clientId, clientSecret } = requireCredentials(
        "linkedin",
        "LinkedIn",
      );
      return {
        clientId,
        clientSecret,
        authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization",
        tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
        userInfoUrl: "https://api.linkedin.com/v2/userinfo",
        scopes: ["openid", "profile", "email"],
      };
    }

    case "spotify": {
      const { clientId, clientSecret } = requireCredentials(
        "spotify",
        "Spotify",
      );
      return {
        clientId,
        clientSecret,
        authorizationUrl: "https://accounts.spotify.com/authorize",
        tokenUrl: "https://accounts.spotify.com/api/token",
        userInfoUrl: "https://api.spotify.com/v1/me",
        scopes: ["user-read-email"],
        // Spotify /v1/me returns an email but no per-response verification flag.
        // Do not assert verification, so the takeover gate remains fail-closed.
        assertsEmailVerified: false,
        profileMap: {
          id: "id",
          email: "email",
          name: "display_name",
          picture: "images.0.url",
        },
      };
    }

    case "twitch": {
      const { clientId, clientSecret } = requireCredentials("twitch", "Twitch");
      return {
        clientId,
        clientSecret,
        authorizationUrl: "https://id.twitch.tv/oauth2/authorize",
        tokenUrl: "https://id.twitch.tv/oauth2/token",
        userInfoUrl: "https://id.twitch.tv/oauth2/userinfo",
        scopes: ["openid", "user:read:email"],
      };
    }

    case "instagram": {
      const { clientId, clientSecret } = requireCredentials(
        "instagram",
        "Instagram",
      );
      return {
        clientId,
        clientSecret,
        authorizationUrl: "https://api.instagram.com/oauth/authorize",
        tokenUrl: "https://api.instagram.com/oauth/access_token",
        userInfoUrl:
          "https://graph.instagram.com/me?fields=id,username,account_type,media_count",
        scopes: ["user_profile"],
        profileMap: { id: "id", name: "username" },
      };
    }

    case "line": {
      const { clientId, clientSecret } = requireCredentials("line", "LINE");
      return {
        clientId,
        clientSecret,
        authorizationUrl: "https://access.line.me/oauth2/v2.1/authorize",
        tokenUrl: "https://api.line.me/oauth2/v2.1/token",
        userInfoUrl: "https://api.line.me/v2/profile",
        scopes: ["profile", "openid", "email"],
        profileMap: {
          id: "userId",
          name: "displayName",
          picture: "pictureUrl",
        },
      };
    }

    case "apple": {
      // "Sign in with Apple" is OIDC: the token endpoint returns an id_token
      // (JWT) and there is NO userinfo endpoint — the identity lives in the
      // verified id_token. APPLE_CLIENT_ID is the Services ID (the `aud`).
      // APPLE_CLIENT_SECRET is itself a short-lived ES256 JWT the developer
      // pre-generates with their private key; this OSS adapter takes it from
      // config rather than performing Apple key management. See verifyAppleIdToken.
      const { clientId, clientSecret } = requireCredentials("apple", "Apple");
      return {
        clientId,
        clientSecret,
        authorizationUrl: "https://appleid.apple.com/auth/authorize",
        tokenUrl: "https://appleid.apple.com/auth/token",
        // No userinfo endpoint exists; getUserInfo() verifies the id_token
        // instead. Point this at the JWKS URL only to satisfy the https check.
        userInfoUrl: APPLE_JWKS_URI,
        scopes: ["name", "email"],
        oidc: { issuer: APPLE_ISSUER, jwksUri: APPLE_JWKS_URI },
      };
    }

    case "tiktok": {
      // TikTok is a standard OAuth2 authorization-code provider, but it names
      // the client-id parameter `client_key` (not `client_id`) on both the
      // authorize and token requests. The userinfo response wraps the profile
      // in { data: { user: {...} } }; the stable id is open_id (union_id is an
      // app-group-stable alternative). Display name and avatar are optional.
      const { clientId, clientSecret } = requireCredentials("tiktok", "TikTok");
      return {
        clientId,
        clientSecret,
        authorizationUrl:
          overrideUrl("tiktok", "AUTHORIZATION") ??
          "https://www.tiktok.com/v2/auth/authorize/",
        tokenUrl:
          overrideUrl("tiktok", "TOKEN") ??
          "https://open.tiktokapis.com/v2/oauth/token/",
        userInfoUrl:
          overrideUrl("tiktok", "USERINFO") ??
          "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,display_name,avatar_url",
        scopes: ["user.info.basic"],
        clientIdParam: "client_key",
        profileMap: {
          id: "user.open_id",
          name: "user.display_name",
          picture: "user.avatar_url",
        },
      };
    }

    default:
      throw new Error(`Unknown OAuth provider: ${provider}`);
  }
}

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

function uint8ArrayToBase64url(arr: Uint8Array): string {
  const base64 = btoa(
    Array.from(arr, (byte) => String.fromCharCode(byte)).join(""),
  );
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
  /**
   * For OIDC providers (e.g. Apple), the id_token captured from the most recent
   * exchangeCode() call. getUserInfo() verifies this rather than fetching a
   * userinfo endpoint. A fresh OAuthClient is constructed per request, so this
   * per-instance state never leaks across login attempts.
   */
  private lastIdToken: string | undefined;
  /**
   * Optional login-request nonce that an OIDC id_token must echo back. When the
   * caller issued a nonce for the authorize request, it sets this before
   * getUserInfo() so verification binds the token to this login attempt.
   */
  private expectedNonce: string | undefined;

  constructor(provider: OAuthProvider) {
    assertProviderUrl("authorizationUrl", provider.authorizationUrl);
    assertProviderUrl("tokenUrl", provider.tokenUrl);
    assertProviderUrl("userInfoUrl", provider.userInfoUrl);
    if (provider.emailUrl) assertProviderUrl("emailUrl", provider.emailUrl);
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
    // Most providers use `client_id`; some (e.g. TikTok) name it `client_key`.
    const clientIdParam = this.provider.clientIdParam ?? "client_id";
    const params = new URLSearchParams({
      [clientIdParam]: this.provider.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: this.provider.scopes.join(this.provider.scopeDelimiter ?? " "),
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
    // Most providers use `client_id`; some (e.g. TikTok) name it `client_key`.
    const clientIdParam = this.provider.clientIdParam ?? "client_id";
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      [clientIdParam]: this.provider.clientId,
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
      signal: AbortSignal.timeout(OAUTH_PROVIDER_TIMEOUT_MS),
    });

    if (!res.ok) {
      // Provider bodies are untrusted and can reflect codes, tokens, or verbose
      // diagnostics. API callers surface this message, so retain only status.
      await discardProviderBody(res);
      throw new Error(`Token exchange failed (${res.status})`);
    }

    const tokenResponse = (await readBoundedProviderJson(
      res,
      "Token exchange",
    )) as OAuthTokenResponse;
    if (
      !tokenResponse ||
      typeof tokenResponse !== "object" ||
      typeof tokenResponse.access_token !== "string" ||
      tokenResponse.access_token.trim().length === 0 ||
      typeof tokenResponse.token_type !== "string" ||
      tokenResponse.token_type.trim().length === 0
    ) {
      throw new Error("Token exchange returned an invalid token response");
    }

    // For OIDC providers the identity is carried by the id_token, which has no
    // userinfo equivalent. Capture it here so getUserInfo() can verify it. Fail
    // closed: a missing id_token from an OIDC provider is an error.
    if (this.provider.oidc) {
      const idToken = tokenResponse.id_token;
      if (typeof idToken !== "string" || idToken.trim().length === 0) {
        throw new Error("OIDC provider token response is missing an id_token");
      }
      this.lastIdToken = idToken;
    }

    return tokenResponse;
  }

  /**
   * Binds the next getUserInfo() call (OIDC providers only) to a login-request
   * nonce. Apple echoes the authorize-request `nonce` back into the id_token;
   * setting it here makes verification reject a token minted for a different
   * login attempt. No-op for non-OIDC providers.
   */
  setExpectedNonce(nonce: string | undefined): void {
    this.expectedNonce = nonce;
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
    // OIDC providers (e.g. Apple) have no userinfo endpoint: the identity is the
    // verified id_token captured during exchangeCode(). Verify it and return the
    // normalized profile. Fail closed — any verification failure throws and no
    // identity is established.
    if (this.provider.oidc) {
      return this.getOidcUserInfo();
    }

    const res = await fetch(this.provider.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(OAUTH_PROVIDER_TIMEOUT_MS),
    });

    if (!res.ok) {
      await discardProviderBody(res);
      throw new Error(`getUserInfo failed (${res.status})`);
    }

    const parsed = await readBoundedProviderJson(res, "getUserInfo");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("getUserInfo returned an invalid response");
    }
    const raw = parsed as Record<string, unknown>;

    // Twitter v2 wraps user data in a `data` envelope
    const data: Record<string, unknown> =
      raw.data != null && typeof raw.data === "object"
        ? (raw.data as Record<string, unknown>)
        : raw;

    const mapped = this.provider.profileMap;
    const id = mapped?.id
      ? readMappedValue(data, mapped.id)
      : (data.id ?? data.sub);
    const email = mapped?.email
      ? readMappedValue(data, mapped.email)
      : data.email;
    const name = mapped?.name
      ? readMappedValue(data, mapped.name)
      : (data.name ?? data.username);
    const picture = mapped?.picture
      ? readMappedValue(data, mapped.picture)
      : (data.profile_image_url ??
        data.picture ??
        data.avatar_url ??
        data.avatar);
    const verifiedEmail = mapped?.emailVerified
      ? readMappedValue(data, mapped.emailVerified)
      : (data.verified_email ?? data.email_verified ?? data.verified);

    const userInfo = {
      id: String(id ?? ""),
      // Twitter does not expose email — leave as empty string; caller must handle
      email: String(email ?? ""),
      name: name != null ? String(name) : undefined,
      picture: picture != null ? String(picture) : undefined,
      verified_email: Boolean(verifiedEmail ?? false),
    } satisfies OAuthUserInfo;

    // GitHub's /user profile may include a public email but never includes a
    // verification bit. Resolve both the address and its verification status
    // through /user/emails in that case. An explicit false from a provider is
    // authoritative and must remain fail-closed.
    if (
      this.provider.emailUrl &&
      (!userInfo.email || verifiedEmail === undefined)
    ) {
      const emailInfo = await this.getPrimaryEmail(
        accessToken,
        userInfo.email || undefined,
      );
      if (emailInfo) {
        userInfo.email = emailInfo.email;
        userInfo.verified_email = emailInfo.verified ?? userInfo.verified_email;
      }
    }

    // Providers that only ever return a confirmed account email can opt in to
    // treating a non-empty email as verified.
    if (this.provider.assertsEmailVerified && userInfo.email) {
      userInfo.verified_email = true;
    }

    return userInfo;
  }

  /**
   * Verifies the OIDC id_token captured during exchangeCode() and normalizes it
   * into the common profile shape. Currently the only built-in OIDC provider is
   * Apple, whose issuer/JWKS are pinned; the verifier checks signature, issuer,
   * audience (=clientId), expiry, and — when set — the login-request nonce.
   */
  private async getOidcUserInfo(): Promise<OAuthUserInfo> {
    const oidc = this.provider.oidc;
    if (!oidc)
      throw new Error("getOidcUserInfo called for a non-OIDC provider");
    const idToken = this.lastIdToken;
    if (!idToken) {
      throw new Error(
        "OIDC id_token unavailable; exchangeCode() must run first",
      );
    }

    if (oidc.issuer === APPLE_ISSUER && oidc.jwksUri === APPLE_JWKS_URI) {
      const verified = await verifyAppleIdToken(idToken, {
        clientId: this.provider.clientId,
        expectedNonce: this.expectedNonce,
      });
      return {
        id: verified.subject,
        // Apple may return a @privaterelay.appleid.com address; store as-is.
        email: verified.email ?? "",
        // Only trust an explicit `true`; undefined/false ⇒ not verified.
        verified_email: verified.emailVerified === true,
      } satisfies OAuthUserInfo;
    }

    // No other OIDC provider is wired; refuse rather than guess (fail closed).
    throw new Error("Unsupported OIDC provider configuration");
  }

  private async getPrimaryEmail(
    accessToken: string,
    preferredEmail?: string,
  ): Promise<OAuthEmailAddress | null> {
    if (!this.provider.emailUrl) return null;

    const res = await fetch(this.provider.emailUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(OAUTH_PROVIDER_TIMEOUT_MS),
    });

    if (!res.ok) {
      await discardProviderBody(res);
      throw new Error(`getPrimaryEmail failed (${res.status})`);
    }

    const raw = await readBoundedProviderJson(res, "getPrimaryEmail");
    if (!Array.isArray(raw)) return null;

    const emails = raw.filter(
      (entry): entry is OAuthEmailAddress =>
        entry != null &&
        typeof entry === "object" &&
        typeof entry.email === "string",
    );

    const normalizedPreferredEmail = preferredEmail?.trim().toLowerCase();
    if (normalizedPreferredEmail) {
      const matchingEmail = emails.find(
        (entry) =>
          entry.email.trim().toLowerCase() === normalizedPreferredEmail,
      );
      if (matchingEmail) return matchingEmail;
    }

    return (
      emails.find((entry) => entry.primary && entry.verified) ??
      emails.find((entry) => entry.primary) ??
      emails.find((entry) => entry.verified) ??
      emails[0] ??
      null
    );
  }
}
