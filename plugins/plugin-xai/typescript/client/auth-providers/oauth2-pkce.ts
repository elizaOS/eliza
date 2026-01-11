import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getSetting } from "../../utils/settings";
import { promptForRedirectedUrl, waitForLoopbackCallback } from "./interactive";
import { createCodeChallenge, createCodeVerifier, createState } from "./pkce";
import type { StoredOAuth2Tokens, TokenStore } from "./token-store";
import { chooseDefaultTokenStore } from "./token-store";
import type { XAuthProvider } from "./types";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";

const DEFAULT_SCOPES = ["post.read", "post.write", "users.read", "offline.access"].join(" ");

function nowMs(): number {
  return Date.now();
}

function isExpired(tokens: StoredOAuth2Tokens, skewMs = 30_000): boolean {
  return nowMs() >= tokens.expires_at - skewMs;
}

function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export class OAuth2PKCEAuthProvider implements XAuthProvider {
  readonly mode = "oauth" as const;

  private tokens: StoredOAuth2Tokens | null = null;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly tokenStore: TokenStore = chooseDefaultTokenStore(runtime),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly interactiveLoginFn?: () => Promise<StoredOAuth2Tokens>
  ) {}

  private get clientId(): string {
    const v = getSetting(this.runtime, "X_CLIENT_ID");
    if (!v) throw new Error("X_CLIENT_ID is required for X_AUTH_MODE=oauth");
    return v;
  }

  private get redirectUri(): string {
    const v = getSetting(this.runtime, "X_REDIRECT_URI");
    if (!v) throw new Error("X_REDIRECT_URI is required for X_AUTH_MODE=oauth");
    return v;
  }

  private get scopes(): string {
    return getSetting(this.runtime, "X_SCOPES") || DEFAULT_SCOPES;
  }

  private async loadTokens(): Promise<StoredOAuth2Tokens | null> {
    if (this.tokens) return this.tokens;
    this.tokens = await this.tokenStore.load();
    return this.tokens;
  }

  private async saveTokens(tokens: StoredOAuth2Tokens): Promise<void> {
    this.tokens = tokens;
    await this.tokenStore.save(tokens);
  }

  private buildAuthorizeUrl(opts: { state: string; codeChallenge: string }): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", this.scopes);
    url.searchParams.set("state", opts.state);
    url.searchParams.set("code_challenge", opts.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  private async exchangeCodeForToken(params: {
    code: string;
    codeVerifier: string;
  }): Promise<StoredOAuth2Tokens> {
    const body = formEncode({
      grant_type: "authorization_code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      code: params.code,
      code_verifier: params.codeVerifier,
    });

    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`X token exchange failed (${res.status}): ${JSON.stringify(json)}`);
    }

    const access = json.access_token as string | undefined;
    const refresh = json.refresh_token as string | undefined;
    const expiresIn = json.expires_in as number | undefined;

    if (!access || typeof access !== "string") {
      throw new Error("X token exchange returned no access_token");
    }
    if (!expiresIn || typeof expiresIn !== "number") {
      throw new Error("X token exchange returned no expires_in");
    }

    return {
      access_token: access,
      refresh_token: refresh,
      expires_at: nowMs() + expiresIn * 1000,
      scope: typeof json.scope === "string" ? json.scope : undefined,
      token_type: typeof json.token_type === "string" ? json.token_type : undefined,
    };
  }

  private async refreshAccessToken(refreshToken: string): Promise<StoredOAuth2Tokens> {
    const body = formEncode({
      grant_type: "refresh_token",
      client_id: this.clientId,
      refresh_token: refreshToken,
    });

    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`X token refresh failed (${res.status}): ${JSON.stringify(json)}`);
    }

    const access = json.access_token as string | undefined;
    const refresh = (json.refresh_token as string | undefined) ?? refreshToken;
    const expiresIn = json.expires_in as number | undefined;

    if (!access || typeof access !== "string") {
      throw new Error("X token refresh returned no access_token");
    }
    if (!expiresIn || typeof expiresIn !== "number") {
      throw new Error("X token refresh returned no expires_in");
    }

    return {
      access_token: access,
      refresh_token: refresh,
      expires_at: nowMs() + expiresIn * 1000,
      scope: typeof json.scope === "string" ? json.scope : undefined,
      token_type: typeof json.token_type === "string" ? json.token_type : undefined,
    };
  }

  private async interactiveLogin(): Promise<StoredOAuth2Tokens> {
    const verifier = createCodeVerifier();
    const challenge = createCodeChallenge(verifier);
    const state = createState();
    const authorizeUrl = this.buildAuthorizeUrl({
      state,
      codeChallenge: challenge,
    });

    logger.info("X OAuth (PKCE) setup required.");
    logger.info(`Open this URL to authorize: ${authorizeUrl}`);

    let code: string | undefined;
    try {
      // Preferred UX: loopback callback if redirect URI is loopback.
      const cb = await waitForLoopbackCallback(this.redirectUri, state);
      code = cb.code;
    } catch (e) {
      logger.warn(
        `Could not start loopback callback server (will fall back to paste URL): ${e instanceof Error ? e.message : String(e)}`
      );
    }

    if (!code) {
      const redirected = await promptForRedirectedUrl(
        "Paste the FULL redirected URL here (it contains ?code=...&state=...): "
      );
      const parsed = new URL(redirected);
      const parsedCode = parsed.searchParams.get("code");
      const parsedState = parsed.searchParams.get("state");
      if (!parsedCode) throw new Error("Pasted URL did not include ?code=");
      if (parsedState && parsedState !== state) {
        throw new Error("OAuth state mismatch");
      }
      code = parsedCode;
    }

    return await this.exchangeCodeForToken({ code, codeVerifier: verifier });
  }

  async getAccessToken(): Promise<string> {
    const tokens = await this.loadTokens();
    if (!tokens) {
      const newTokens = this.interactiveLoginFn
        ? await this.interactiveLoginFn()
        : await this.interactiveLogin();
      await this.saveTokens(newTokens);
      return newTokens.access_token;
    }

    if (!isExpired(tokens)) {
      return tokens.access_token;
    }

    if (!tokens.refresh_token) {
      // No refresh token available; must re-auth.
      await this.tokenStore.clear();
      this.tokens = null;
      const newTokens = this.interactiveLoginFn
        ? await this.interactiveLoginFn()
        : await this.interactiveLogin();
      await this.saveTokens(newTokens);
      return newTokens.access_token;
    }

    const refreshed = await this.refreshAccessToken(tokens.refresh_token);
    await this.saveTokens(refreshed);
    return refreshed.access_token;
  }
}

export const OAUTH2_DEFAULT_SCOPES = DEFAULT_SCOPES;
