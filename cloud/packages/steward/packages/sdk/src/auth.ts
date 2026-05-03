/**
 * auth.ts — StewardAuth: complete authentication module for the Steward SDK
 *
 * Supports:
 *   - Passkey (WebAuthn) — browser only, via @simplewebauthn/browser peer dep
 *   - Email magic link — browser + Node
 *   - SIWE (Sign-In With Ethereum) — browser + Node
 *
 * Usage:
 *   const auth = new StewardAuth({ baseUrl: "https://api.steward.fi" });
 *   const { token, user } = await auth.signInWithPasskey("me@example.com");
 *   const client = new StewardClient({ baseUrl, bearerToken: auth.getToken() });
 */

import bs58 from "bs58";
import type {
  SessionStorage,
  StewardAuthConfig,
  StewardAuthExchangeResponse,
  StewardAuthResult,
  StewardEmailResult,
  StewardOAuthConfig,
  StewardOAuthResult,
  StewardProviders,
  StewardRefreshResult,
  StewardSession,
  StewardTenantMembership,
  StewardUser,
} from "./auth-types.ts";
import { StewardApiError } from "./client.ts";

// ─── Storage key ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "steward_session_token";
const REFRESH_TOKEN_KEY = "steward_refresh_token";
const OAUTH_STATE_KEY = "steward_oauth_state";
const OAUTH_VERIFIER_KEY = "steward_oauth_verifier";

/** Kick off a token refresh when fewer than this many seconds remain on the access token */
const REFRESH_THRESHOLD_SECS = 120;

// ─── Minimal JWT decode (no verification — server already verified) ───────────

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // base64url → base64 → decode
    // atob is available globally in browsers and Node.js >= 18
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const json = atob(padded);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sessionFromToken(token: string, user?: StewardUser): StewardSession | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  return {
    token,
    address: (payload.address as string) ?? "",
    tenantId: (payload.tenantId as string) ?? "",
    userId: payload.userId as string | undefined,
    email: payload.email as string | undefined,
    expiresAt: payload.exp as number | undefined,
    user,
  };
}

// ─── In-memory fallback storage ───────────────────────────────────────────────

class MemoryStorage implements SessionStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

// ─── Detect browser environment ───────────────────────────────────────────────

function isBrowser(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.document !== "undefined" &&
    typeof navigator !== "undefined"
  );
}

function getSignInOrigin(): { domain: string; origin: string } {
  return isBrowser()
    ? { domain: window.location.host, origin: window.location.origin }
    : { domain: "steward.fi", origin: "https://steward.fi" };
}

function buildSiweMessage(address: string, nonce: string, issuedAt: string): string {
  const { domain, origin } = getSignInOrigin();
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to Steward",
    "",
    `URI: ${origin}`,
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

function buildSiwsMessage(publicKey: string, nonce: string, issuedAt: string): string {
  const { domain, origin } = getSignInOrigin();
  return [
    `${domain} wants you to sign in with your Solana account:`,
    publicKey,
    "",
    "Sign in to Steward",
    "",
    `URI: ${origin}`,
    "Version: 1",
    "Chain ID: mainnet",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

// ─── Fetch helpers — same pattern as StewardClient ───────────────────────────

type AuthApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

// Narrow view of @simplewebauthn/browser — a peer dep we import dynamically.
type SimpleWebAuthnBrowser = Pick<
  typeof import("@simplewebauthn/browser"),
  "startAuthentication" | "startRegistration"
>;

async function authRequest<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  token?: string | null,
): Promise<AuthApiResult<T>> {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });

  // Merge caller headers without clobbering defaults
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers,
    });
  } catch (err) {
    throw new StewardApiError(err instanceof Error ? err.message : "Network request failed", 0);
  }

  const text = await response.text();
  let payload: Record<string, unknown> = { ok: response.ok };

  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new StewardApiError("Received invalid JSON from Steward API", response.status);
    }
  }

  if (!response.ok || payload.ok === false) {
    const errMsg =
      typeof payload.error === "string"
        ? payload.error
        : `Request failed with status ${response.status}`;
    return { ok: false, status: response.status, error: errMsg };
  }

  return { ok: true, status: response.status, data: payload as unknown as T };
}

// ─── StewardAuth ──────────────────────────────────────────────────────────────

export class StewardAuth {
  private readonly baseUrl: string;
  private readonly storage: SessionStorage;
  private readonly tenantId: string | undefined;
  private readonly listeners: Array<(session: StewardSession | null) => void> = [];

  constructor({ baseUrl, storage, onSessionChange, tenantId }: StewardAuthConfig) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.tenantId = tenantId;

    // Use provided storage, else localStorage when in browser, else in-memory
    if (storage) {
      this.storage = storage;
    } else if (isBrowser() && typeof localStorage !== "undefined") {
      this.storage = localStorage;
    } else {
      this.storage = new MemoryStorage();
    }

    if (onSessionChange) {
      this.listeners.push(onSessionChange);
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Returns the configured default tenantId, if any. */
  getTenantId(): string | undefined {
    return this.tenantId;
  }

  // ─── Session management ─────────────────────────────────────────────────────

  /**
   * Returns the current session decoded from the stored JWT, or null if not signed in.
   */
  getSession(): StewardSession | null {
    const token = this.storage.getItem(STORAGE_KEY);
    if (!token) return null;

    const session = sessionFromToken(token);
    if (!session) return null;

    // Treat expired tokens as signed out
    if (session.expiresAt && session.expiresAt * 1000 < Date.now()) {
      this.clearToken();
      return null;
    }

    return session;
  }

  /**
   * Returns true if the access token is within REFRESH_THRESHOLD_SECS of expiry.
   * Call `refreshSession()` proactively when this returns true.
   */
  isNearExpiry(): boolean {
    const session = this.getSession();
    if (!session?.expiresAt) return false;
    const secsRemaining = session.expiresAt - Date.now() / 1000;
    return secsRemaining < REFRESH_THRESHOLD_SECS;
  }

  /**
   * Returns the raw access JWT string, or null if not signed in.
   * Automatically triggers a background refresh if the token is near expiry.
   */
  getToken(): string | null {
    const session = this.getSession();
    if (!session) return null;
    // Kick off a background refresh if near expiry (non-blocking)
    if (this.isNearExpiry()) {
      void this.refreshSession().catch(() => {
        /* swallow — caller still gets old token */
      });
    }
    return session.token;
  }

  /** Returns the stored refresh token, or null if not available. */
  getRefreshToken(): string | null {
    return this.storage.getItem(REFRESH_TOKEN_KEY);
  }

  /**
   * Returns true if there is a valid (non-expired) session.
   */
  isAuthenticated(): boolean {
    return this.getSession() !== null;
  }

  /**
   * Clears the stored session (both tokens) and notifies listeners.
   */
  signOut(): void {
    this.clearToken();
    this.notifyListeners(null);
  }

  /**
   * Exchange the stored refresh token for a new access token + rotated refresh token.
   * Stores both tokens and notifies session listeners.
   * Returns the new session, or null if the refresh token is missing or invalid.
   */
  async refreshSession(): Promise<StewardSession | null> {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) return null;

    let res: Awaited<ReturnType<typeof authRequest<StewardRefreshResult>>>;
    try {
      res = await authRequest<StewardRefreshResult>(this.baseUrl, "/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      return null;
    }

    if (!res.ok) {
      if (res.status === 401) {
        this.signOut();
      }
      return null;
    }

    this.storage.setItem(STORAGE_KEY, res.data.token);
    this.storage.setItem(REFRESH_TOKEN_KEY, res.data.refreshToken);
    const session = sessionFromToken(res.data.token);
    this.notifyListeners(session);
    return session;
  }

  /**
   * Revoke the stored refresh token on the server (single-device sign out).
   * Also clears local session state.
   */
  async revokeSession(): Promise<void> {
    const refreshToken = this.getRefreshToken();
    if (refreshToken) {
      await authRequest(this.baseUrl, "/auth/revoke", {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      }).catch(() => {
        /* best-effort */
      });
    }
    this.clearToken();
    this.notifyListeners(null);
  }

  /**
   * Register a listener that fires whenever the session changes.
   * Returns a cleanup function that removes the listener.
   */
  onSessionChange(callback: (session: StewardSession | null) => void): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  // ─── Passkey (WebAuthn) ─────────────────────────────────────────────────────

  /**
   * Sign in with a passkey. Smart flow: tries login first, falls back to registration.
   *
   * Requires a browser environment and `@simplewebauthn/browser` installed.
   * Throws `StewardApiError` in Node or when the dependency is missing.
   */
  async signInWithPasskey(email: string): Promise<StewardAuthResult> {
    if (!isBrowser()) {
      throw new StewardApiError(
        "Passkeys require a browser environment. Use signInWithEmail or signInWithSIWE in Node.",
        0,
      );
    }

    // Dynamically import @simplewebauthn/browser — peer dep, may not be installed
    let browserLib: SimpleWebAuthnBrowser;
    try {
      browserLib = await import("@simplewebauthn/browser");
    } catch {
      throw new StewardApiError(
        "Missing peer dependency: @simplewebauthn/browser. Install it to use passkeys.",
        0,
      );
    }

    // 1. Try login options. If user has no passkeys (404), fall back to register.
    const loginOptsRes = await authRequest<Record<string, unknown>>(
      this.baseUrl,
      "/auth/passkey/login/options",
      {
        method: "POST",
        body: JSON.stringify({
          email,
          ...(this.tenantId ? { tenantId: this.tenantId } : {}),
        }),
      },
    );

    if (loginOptsRes.ok) {
      // User exists with passkeys — run authentication flow
      return this.completePasskeyLogin(email, loginOptsRes.data, browserLib);
    }

    if (loginOptsRes.status === 404) {
      // No account or no passkeys — run registration flow
      return this.completePasskeyRegister(email, browserLib);
    }

    throw new StewardApiError(loginOptsRes.error, loginOptsRes.status);
  }

  private async completePasskeyLogin(
    email: string,
    options: unknown,
    lib: Pick<SimpleWebAuthnBrowser, "startAuthentication">,
  ): Promise<StewardAuthResult> {
    let authResponse: unknown;
    try {
      // Server-provided options; types are validated by the WebAuthn browser library.
      authResponse = await lib.startAuthentication(
        options as Parameters<SimpleWebAuthnBrowser["startAuthentication"]>[0],
      );
    } catch (err) {
      throw new StewardApiError(
        `WebAuthn authentication cancelled or failed: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }

    const verifyRes = await authRequest<StewardAuthExchangeResponse>(
      this.baseUrl,
      "/auth/passkey/login/verify",
      {
        method: "POST",
        body: JSON.stringify({
          email,
          response: authResponse,
          ...(this.tenantId ? { tenantId: this.tenantId } : {}),
        }),
      },
    );

    if (!verifyRes.ok) {
      throw new StewardApiError(verifyRes.error, verifyRes.status);
    }

    return this.storeAndReturn(
      verifyRes.data.token,
      (verifyRes.data as { refreshToken?: string }).refreshToken ?? "",
      verifyRes.data.user,
      (verifyRes.data as { expiresIn?: number }).expiresIn,
    );
  }

  private async completePasskeyRegister(
    email: string,
    lib: Pick<SimpleWebAuthnBrowser, "startRegistration">,
  ): Promise<StewardAuthResult> {
    // Fetch registration options
    const regOptsRes = await authRequest<Record<string, unknown>>(
      this.baseUrl,
      "/auth/passkey/register/options",
      {
        method: "POST",
        body: JSON.stringify({
          email,
          ...(this.tenantId ? { tenantId: this.tenantId } : {}),
        }),
      },
    );

    if (!regOptsRes.ok) {
      throw new StewardApiError(regOptsRes.error, regOptsRes.status);
    }

    let regResponse: unknown;
    try {
      // Server-provided options; types are validated by the WebAuthn browser library.
      regResponse = await lib.startRegistration(
        regOptsRes.data as Parameters<SimpleWebAuthnBrowser["startRegistration"]>[0],
      );
    } catch (err) {
      throw new StewardApiError(
        `WebAuthn registration cancelled or failed: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }

    const verifyRes = await authRequest<StewardAuthExchangeResponse>(
      this.baseUrl,
      "/auth/passkey/register/verify",
      {
        method: "POST",
        body: JSON.stringify({
          email,
          response: regResponse,
          ...(this.tenantId ? { tenantId: this.tenantId } : {}),
        }),
      },
    );

    if (!verifyRes.ok) {
      throw new StewardApiError(verifyRes.error, verifyRes.status);
    }

    return this.storeAndReturn(
      verifyRes.data.token,
      (verifyRes.data as { refreshToken?: string }).refreshToken ?? "",
      verifyRes.data.user,
      (verifyRes.data as { expiresIn?: number }).expiresIn,
    );
  }

  // ─── Email magic link ───────────────────────────────────────────────────────

  /**
   * Send a magic link to the given email address.
   * Returns `{ ok: true, expiresAt }` — the actual sign-in happens in `verifyEmailCallback`.
   */
  async signInWithEmail(email: string): Promise<StewardEmailResult> {
    // API shape: { ok: true, data: { expiresAt: string } }
    const res = await authRequest<Record<string, unknown>>(this.baseUrl, "/auth/email/send", {
      method: "POST",
      body: JSON.stringify({
        email,
        ...(this.tenantId ? { tenantId: this.tenantId } : {}),
      }),
    });

    if (!res.ok) {
      throw new StewardApiError(res.error, res.status);
    }

    // Unwrap the expiresAt — may sit directly on the response or inside `data`
    const expiresAt =
      typeof res.data.expiresAt === "string"
        ? res.data.expiresAt
        : ((res.data.data as { expiresAt?: string } | undefined)?.expiresAt ?? "");

    return { ok: true, expiresAt };
  }

  /**
   * Exchange a magic link token for a session JWT.
   * Call this from the callback URL handler with the `token` and `email` query params.
   */
  async verifyEmailCallback(token: string, email: string): Promise<StewardAuthResult> {
    const res = await authRequest<StewardAuthExchangeResponse>(this.baseUrl, "/auth/email/verify", {
      method: "POST",
      body: JSON.stringify({
        token,
        email,
        ...(this.tenantId ? { tenantId: this.tenantId } : {}),
      }),
    });

    if (!res.ok) {
      throw new StewardApiError(res.error, res.status);
    }

    return this.storeAndReturn(
      res.data.token,
      (res.data as { refreshToken?: string }).refreshToken ?? "",
      res.data.user,
      (res.data as { expiresIn?: number }).expiresIn,
    );
  }

  // ─── SIWE ───────────────────────────────────────────────────────────────────

  /**
   * Sign in with an Ethereum wallet via SIWE (EIP-4361).
   *
   * @param address  - The signer's EVM address (checksummed or lowercase).
   * @param signMessage - Async function that signs an arbitrary string with the wallet.
   *                      Compatible with ethers.js `signer.signMessage`, viem's `walletClient.signMessage`,
   *                      or any custom implementation.
   *
   * Flow: GET /auth/nonce → build SIWE message → caller signs → POST /auth/verify → store JWT.
   */
  async signInWithSIWE(
    address: string,
    signMessage: (msg: string) => Promise<string>,
  ): Promise<StewardAuthResult> {
    // 1. Fetch a fresh nonce
    const nonceRes = await authRequest<{ nonce: string }>(this.baseUrl, "/auth/nonce");

    if (!nonceRes.ok) {
      throw new StewardApiError(nonceRes.error, nonceRes.status);
    }

    const { nonce } = nonceRes.data;

    // 2. Build a minimal SIWE message string (EIP-4361)
    const issuedAt = new Date().toISOString();
    const siweMessage = buildSiweMessage(address, nonce, issuedAt);

    // 3. Have the caller sign the message
    let signature: string;
    try {
      signature = await signMessage(siweMessage);
    } catch (err) {
      throw new StewardApiError(
        `Wallet signing failed: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }

    // 4. Verify with the API
    const verifyRes = await authRequest<StewardAuthExchangeResponse>(this.baseUrl, "/auth/verify", {
      method: "POST",
      body: JSON.stringify({ message: siweMessage, signature }),
      ...(this.tenantId ? { headers: { "X-Steward-Tenant": this.tenantId } } : {}),
    });

    if (!verifyRes.ok) {
      throw new StewardApiError(verifyRes.error, verifyRes.status);
    }

    // SIWE response has no `user` object — synthesise one from address
    const user: StewardUser = {
      id: verifyRes.data.userId ?? verifyRes.data.tenant?.id ?? "",
      email: "",
      walletAddress: verifyRes.data.address,
      walletChain: verifyRes.data.walletChain ?? "ethereum",
    };

    return this.storeAndReturn(
      verifyRes.data.token,
      (verifyRes.data as { refreshToken?: string }).refreshToken ?? "",
      user,
      (verifyRes.data as { expiresIn?: number }).expiresIn,
    );
  }

  /**
   * Sign in with a Solana wallet via Sign-In With Solana.
   */
  async signInWithSolana(
    publicKey: string,
    signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  ): Promise<StewardAuthResult> {
    const nonceRes = await authRequest<{ nonce: string }>(this.baseUrl, "/auth/nonce");
    if (!nonceRes.ok) {
      throw new StewardApiError(nonceRes.error, nonceRes.status);
    }

    const issuedAt = new Date().toISOString();
    const message = buildSiwsMessage(publicKey, nonceRes.data.nonce, issuedAt);

    let signatureBytes: Uint8Array;
    try {
      signatureBytes = await signMessage(new TextEncoder().encode(message));
    } catch (err) {
      throw new StewardApiError(
        `Wallet signing failed: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }

    const verifyRes = await authRequest<StewardAuthExchangeResponse>(
      this.baseUrl,
      "/auth/verify/solana",
      {
        method: "POST",
        body: JSON.stringify({
          message,
          signature: bs58.encode(signatureBytes),
          publicKey,
        }),
        ...(this.tenantId ? { headers: { "X-Steward-Tenant": this.tenantId } } : {}),
      },
    );

    if (!verifyRes.ok) {
      throw new StewardApiError(verifyRes.error, verifyRes.status);
    }

    const user: StewardUser = {
      id: verifyRes.data.userId ?? verifyRes.data.tenant?.id ?? "",
      email: "",
      walletAddress: verifyRes.data.publicKey ?? verifyRes.data.address,
      walletChain: verifyRes.data.walletChain ?? "solana",
    };

    return this.storeAndReturn(
      verifyRes.data.token,
      (verifyRes.data as { refreshToken?: string }).refreshToken ?? "",
      user,
      (verifyRes.data as { expiresIn?: number }).expiresIn,
    );
  }

  // ─── OAuth / Provider Discovery ───────────────────────────────────────────

  private providersCache: { data: StewardProviders; fetchedAt: number } | null = null;
  private static readonly PROVIDERS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Fetch the list of enabled authentication providers from the server.
   * Results are cached for 5 minutes to avoid hammering the endpoint on every render.
   */
  async getProviders(forceRefresh = false): Promise<StewardProviders> {
    if (
      !forceRefresh &&
      this.providersCache &&
      Date.now() - this.providersCache.fetchedAt < StewardAuth.PROVIDERS_CACHE_TTL_MS
    ) {
      return this.providersCache.data;
    }

    const res = await authRequest<StewardProviders>(this.baseUrl, "/auth/providers");

    if (!res.ok) {
      throw new StewardApiError(res.error, res.status);
    }

    this.providersCache = { data: res.data, fetchedAt: Date.now() };
    return res.data;
  }

  /**
   * Sign in with an OAuth provider using a popup-based PKCE flow.
   *
   * In a browser environment, opens a popup to the provider's authorization page,
   * listens for the callback, and exchanges the code for a session.
   *
   * In non-browser environments (Node), throws with the authorization URL.
   * Use `handleOAuthCallback` to complete the flow after redirect.
   *
   * @param provider - OAuth provider name (e.g. "google", "discord")
   * @param config   - Optional configuration overrides
   */
  async signInWithOAuth(
    provider: string,
    config?: Partial<Omit<StewardOAuthConfig, "provider">>,
  ): Promise<StewardOAuthResult> {
    // Generate PKCE pair
    const codeVerifier = await generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Generate random state
    const stateBytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(stateBytes);
    const state = Array.from(stateBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Store state + verifier for later verification
    this.storage.setItem(OAUTH_STATE_KEY, state);
    this.storage.setItem(OAUTH_VERIFIER_KEY, codeVerifier);

    // Build the redirect URI
    const redirectUri =
      config?.redirectUri ??
      (isBrowser() ? `${window.location.origin}/auth/callback` : "http://localhost/auth/callback");

    // Build the authorization URL
    const params = new URLSearchParams({
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });
    if (config?.tenantId) {
      params.set("tenant_id", config.tenantId);
    }
    const authorizeUrl = `${this.baseUrl}/auth/oauth/${encodeURIComponent(provider)}/authorize?${params.toString()}`;

    if (!isBrowser()) {
      throw new StewardApiError(
        `OAuth popup flow requires a browser. Redirect to: ${authorizeUrl}`,
        0,
      );
    }

    // Open popup
    const popupWidth = config?.popupWidth ?? 500;
    const popupHeight = config?.popupHeight ?? 600;
    const left = Math.round(window.screenX + (window.outerWidth - popupWidth) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - popupHeight) / 2);

    const popup = window.open(
      authorizeUrl,
      "steward-oauth",
      `width=${popupWidth},height=${popupHeight},left=${left},top=${top},popup=yes`,
    );

    if (!popup) {
      throw new StewardApiError(
        "Failed to open OAuth popup. Check that popups are not blocked.",
        0,
      );
    }

    // Wait for the popup to redirect back with the code
    const callbackParams = await this.waitForPopupCallback(popup, redirectUri);

    // Validate state
    if (callbackParams.state !== state) {
      throw new StewardApiError("OAuth state mismatch, possible CSRF attack", 0);
    }

    if (callbackParams.error) {
      throw new StewardApiError(`OAuth error: ${callbackParams.error}`, 0);
    }

    if (!callbackParams.code) {
      throw new StewardApiError("No authorization code received from OAuth provider", 0);
    }

    // Exchange code for tokens via PKCE
    return this.exchangeOAuthCode(provider, callbackParams.code, redirectUri, state, codeVerifier);
  }

  /**
   * Complete an OAuth flow from a redirect callback (non-popup flow).
   *
   * Call this from your callback route handler after the OAuth provider
   * redirects back with `code` and `state` query parameters.
   *
   * @param provider - OAuth provider name (e.g. "google", "discord")
   * @param params   - The URL search params from the callback (code, state, error)
   */
  async handleOAuthCallback(
    provider: string,
    params: { code?: string; state?: string; error?: string },
  ): Promise<StewardOAuthResult> {
    if (params.error) {
      throw new StewardApiError(`OAuth error: ${params.error}`, 0);
    }

    if (!params.code || !params.state) {
      throw new StewardApiError("Missing code or state in OAuth callback", 0);
    }

    // Retrieve stored state + verifier
    const storedState = this.storage.getItem(OAUTH_STATE_KEY);
    const storedVerifier = this.storage.getItem(OAUTH_VERIFIER_KEY);

    if (!storedState || !storedVerifier) {
      throw new StewardApiError(
        "No OAuth state found in storage. Did you call signInWithOAuth first?",
        0,
      );
    }

    if (params.state !== storedState) {
      throw new StewardApiError("OAuth state mismatch, possible CSRF attack", 0);
    }

    // Build redirect URI from current location (or fallback)
    const redirectUri = isBrowser()
      ? `${window.location.origin}${window.location.pathname}`
      : "http://localhost/auth/callback";

    return this.exchangeOAuthCode(provider, params.code, redirectUri, params.state, storedVerifier);
  }

  /**
   * Exchange an OAuth authorization code for session tokens via PKCE.
   */
  private async exchangeOAuthCode(
    provider: string,
    code: string,
    redirectUri: string,
    state: string,
    codeVerifier: string,
  ): Promise<StewardOAuthResult> {
    const res = await authRequest<StewardAuthExchangeResponse>(
      this.baseUrl,
      `/auth/oauth/${encodeURIComponent(provider)}/token`,
      {
        method: "POST",
        body: JSON.stringify({ code, redirectUri, state, codeVerifier }),
      },
    );

    if (!res.ok) {
      throw new StewardApiError(res.error, res.status);
    }

    // Clean up stored PKCE state
    this.storage.removeItem(OAUTH_STATE_KEY);
    this.storage.removeItem(OAUTH_VERIFIER_KEY);

    const result = this.storeAndReturn(
      res.data.token,
      res.data.refreshToken ?? "",
      res.data.user,
      res.data.expiresIn,
    );

    return { ...result, provider };
  }

  /**
   * Wait for the OAuth popup to redirect back to the callback URL.
   * Polls the popup location and listens for postMessage as a fallback.
   */
  private waitForPopupCallback(
    popup: Window,
    expectedOrigin: string,
  ): Promise<{ code?: string; state?: string; error?: string }> {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const pollInterval = 200; // ms
      const timeout = 5 * 60 * 1000; // 5 min max
      const startTime = Date.now();

      // Parse the expected origin from the redirect URI
      let origin: string;
      try {
        origin = new URL(expectedOrigin).origin;
      } catch {
        origin = isBrowser() ? window.location.origin : "http://localhost";
      }

      // Listen for postMessage from the popup (if the callback page sends one)
      const messageHandler = (event: MessageEvent): void => {
        if (resolved) return;
        if (event.origin !== origin) return;
        const data = event.data as
          | { type?: string; code?: string; state?: string; error?: string }
          | undefined;
        if (data?.type === "steward-oauth-callback") {
          resolved = true;
          window.removeEventListener("message", messageHandler);
          resolve({ code: data.code, state: data.state, error: data.error });
        }
      };
      window.addEventListener("message", messageHandler);

      // Poll the popup location
      const poll = setInterval(() => {
        if (resolved) {
          clearInterval(poll);
          return;
        }

        // Check timeout
        if (Date.now() - startTime > timeout) {
          resolved = true;
          clearInterval(poll);
          window.removeEventListener("message", messageHandler);
          reject(new StewardApiError("OAuth popup timed out after 5 minutes", 0));
          return;
        }

        // Check if popup was closed by user
        if (popup.closed) {
          resolved = true;
          clearInterval(poll);
          window.removeEventListener("message", messageHandler);
          reject(new StewardApiError("OAuth popup was closed before completing sign-in", 0));
          return;
        }

        // Try to read the popup URL (cross-origin will throw)
        try {
          const popupUrl = popup.location.href;
          if (popupUrl?.startsWith(origin)) {
            resolved = true;
            clearInterval(poll);
            window.removeEventListener("message", messageHandler);
            popup.close();

            const url = new URL(popupUrl);
            resolve({
              code: url.searchParams.get("code") ?? undefined,
              state: url.searchParams.get("state") ?? undefined,
              error: url.searchParams.get("error") ?? undefined,
            });
          }
        } catch {
          // Cross-origin: popup still on provider's domain, keep polling
        }
      }, pollInterval);
    });
  }

  // ─── Multi-tenant ───────────────────────────────────────────────────────────

  /**
   * List all tenants/apps the current user belongs to.
   * Requires an active session.
   */
  async listTenants(): Promise<StewardTenantMembership[]> {
    const token = this.getToken();
    if (!token) {
      throw new StewardApiError("Not authenticated. Sign in first.", 0);
    }

    const res = await authRequest<StewardTenantMembership[] | { data: StewardTenantMembership[] }>(
      this.baseUrl,
      "/user/me/tenants",
      {},
      token,
    );

    if (!res.ok) {
      throw new StewardApiError(res.error, res.status);
    }

    return Array.isArray(res.data) ? res.data : res.data.data;
  }

  /**
   * Join an open tenant/app.
   * Requires an active session.
   */
  async joinTenant(tenantId: string): Promise<StewardTenantMembership> {
    const token = this.getToken();
    if (!token) {
      throw new StewardApiError("Not authenticated. Sign in first.", 0);
    }

    const res = await authRequest<StewardTenantMembership & { ok?: boolean }>(
      this.baseUrl,
      `/user/me/tenants/${encodeURIComponent(tenantId)}/join`,
      { method: "POST" },
      token,
    );

    if (!res.ok) {
      throw new StewardApiError(res.error, res.status);
    }

    return res.data;
  }

  /**
   * Leave a tenant/app. Cannot leave your personal tenant.
   * Requires an active session.
   */
  async leaveTenant(tenantId: string): Promise<void> {
    const token = this.getToken();
    if (!token) {
      throw new StewardApiError("Not authenticated. Sign in first.", 0);
    }

    const res = await authRequest<{ ok: boolean }>(
      this.baseUrl,
      `/user/me/tenants/${encodeURIComponent(tenantId)}/leave`,
      { method: "DELETE" },
      token,
    );

    if (!res.ok) {
      throw new StewardApiError(res.error, res.status);
    }
  }

  /**
   * Switch the active tenant context by refreshing the session with a new tenantId.
   * Returns the new session, or null if the switch failed (user may need to re-auth).
   */
  async switchTenant(tenantId: string): Promise<StewardSession | null> {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) {
      return null;
    }

    const res = await authRequest<StewardRefreshResult>(this.baseUrl, "/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken, tenantId }),
    });

    if (!res.ok) {
      // Refresh failed, user needs to re-authenticate
      return null;
    }

    this.storage.setItem(STORAGE_KEY, res.data.token);
    this.storage.setItem(REFRESH_TOKEN_KEY, res.data.refreshToken);
    const session = sessionFromToken(res.data.token);
    this.notifyListeners(session);
    return session;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private storeAndReturn(
    token: string,
    refreshToken: string,
    user: StewardUser,
    expiresIn = 900,
  ): StewardAuthResult {
    this.storage.setItem(STORAGE_KEY, token);
    // Only persist the refresh token when it's a non-empty string.
    // An empty string means the API didn't issue one (e.g. SIWE flow).
    if (refreshToken) {
      this.storage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    }
    const session = sessionFromToken(token, user);
    this.notifyListeners(session);
    return { token, refreshToken, expiresIn, user };
  }

  private clearToken(): void {
    this.storage.removeItem(STORAGE_KEY);
    this.storage.removeItem(REFRESH_TOKEN_KEY);
  }

  private notifyListeners(session: StewardSession | null): void {
    for (const listener of this.listeners) {
      try {
        listener(session);
      } catch {
        // listeners must not crash the auth flow
      }
    }
  }
}

// ─── PKCE Helpers (module-private) ──────────────────────────────────────────

/**
 * Generate a cryptographically random PKCE code_verifier.
 * Returns a 43-128 character base64url string (RFC 7636 Section 4.1).
 * Uses Web Crypto API for browser + Node 18+ compatibility.
 */
async function generateCodeVerifier(): Promise<string> {
  const bytes = new Uint8Array(32); // 32 bytes → 43 base64url chars
  globalThis.crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

/**
 * Generate a PKCE code_challenge from a code_verifier using SHA-256.
 * Uses Web Crypto API (globalThis.crypto.subtle) for cross-platform support.
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return base64urlEncode(new Uint8Array(digest));
}

/**
 * Encode a Uint8Array as a base64url string (no padding).
 */
function base64urlEncode(bytes: Uint8Array): string {
  // btoa is available in all browsers and Node 18+
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Export PKCE helpers for testing
export {
  generateCodeChallenge as _generateCodeChallenge,
  generateCodeVerifier as _generateCodeVerifier,
};
