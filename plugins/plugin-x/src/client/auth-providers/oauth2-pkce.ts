/**
 * OAuth 2.0 PKCE (`oauth` mode) auth provider: runs the authorization-code + PKCE
 * flow against X's authorize/token endpoints, persists the resulting token set
 * through a `TokenStore`, and returns a live Bearer access token on demand —
 * refreshing with the stored refresh token, or driving an interactive re-auth
 * (loopback-callback server, else paste-the-redirected-URL) when tokens are missing
 * or unrefreshable. Selected by the auth-provider factory when
 * `TWITTER_AUTH_MODE=oauth`; requires `TWITTER_CLIENT_ID` and `TWITTER_REDIRECT_URI`.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { TwitterClientState } from "../../types";
import { getSetting } from "../../utils/settings";
import { DEFAULT_X_ACCOUNT_ID, resolveRequestedXAccountId } from "../accounts";
import {
  assertOAuthState,
  promptForRedirectedUrl,
  waitForLoopbackCallback,
} from "./interactive";
import { createCodeChallenge, createCodeVerifier, createState } from "./pkce";
import type { StoredOAuth2Tokens, TokenStore } from "./token-store";
import { chooseDefaultTokenStore } from "./token-store";
import type { TwitterAuthProvider } from "./types";

const AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.twitter.com/2/oauth2/token";

const DEFAULT_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "dm.read",
  "dm.write",
  "offline.access",
].join(" ");

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

export class OAuth2PKCEAuthProvider implements TwitterAuthProvider {
  readonly mode = "oauth" as const;

  private tokens: StoredOAuth2Tokens | null = null;
  private readonly accountId: string;
  // Single-flight guard: collapses concurrent expiry-window (or missing-token)
  // callers onto one refresh/interactive-login so X's single-use, rotating
  // refresh token is only spent once. Without it, plugin-x's independent loops
  // (post, interactions, discovery) share this provider instance and can each
  // refresh the same R0, making the losing caller fail with invalid_grant.
  private authInFlight: Promise<StoredOAuth2Tokens> | null = null;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly state?: TwitterClientState,
    private readonly tokenStore: TokenStore = chooseDefaultTokenStore(
      runtime,
      resolveRequestedXAccountId(runtime, state, state?.accountId) ??
        DEFAULT_X_ACCOUNT_ID,
    ),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly interactiveLoginFn?: () => Promise<StoredOAuth2Tokens>,
  ) {
    this.accountId = resolveRequestedXAccountId(
      runtime,
      state,
      state?.accountId,
    );
  }

  private get clientId(): string {
    const v =
      this.state?.TWITTER_CLIENT_ID ??
      getSetting(this.runtime, "TWITTER_CLIENT_ID");
    if (!v)
      throw new Error(
        `TWITTER_CLIENT_ID is required for TWITTER_AUTH_MODE=oauth (accountId=${this.accountId})`,
      );
    return v;
  }

  private get redirectUri(): string {
    const v =
      this.state?.TWITTER_REDIRECT_URI ??
      getSetting(this.runtime, "TWITTER_REDIRECT_URI");
    if (!v)
      throw new Error(
        `TWITTER_REDIRECT_URI is required for TWITTER_AUTH_MODE=oauth (accountId=${this.accountId})`,
      );
    return v;
  }

  private get scopes(): string {
    return (
      this.state?.TWITTER_SCOPES ??
      getSetting(this.runtime, "TWITTER_SCOPES") ??
      DEFAULT_SCOPES
    );
  }

  private async loadTokens(): Promise<StoredOAuth2Tokens | null> {
    if (this.tokens) return this.tokens;
    const loaded = await this.tokenStore.load();
    // A concurrent single-flight may have refreshed and saved a newer token
    // while this store read was outstanding (real file/DB stores can have a
    // read in flight across another loop's write). Never let a pre-write
    // snapshot clobber the freshly rotated token, or that stale refresh token
    // gets spent a second time and fails with invalid_grant.
    if (this.tokens) return this.tokens;
    this.tokens = loaded;
    return this.tokens;
  }

  private async saveTokens(tokens: StoredOAuth2Tokens): Promise<void> {
    this.tokens = tokens;
    await this.tokenStore.save(tokens);
  }

  private buildAuthorizeUrl(opts: {
    state: string;
    codeChallenge: string;
  }): string {
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
      throw new Error(
        `Twitter token exchange failed (${res.status}): ${JSON.stringify(json)}`,
      );
    }

    const access = json.access_token as string | undefined;
    const refresh = json.refresh_token as string | undefined;
    const expiresIn = json.expires_in as number | undefined;

    if (!access || typeof access !== "string") {
      throw new Error("Twitter token exchange returned no access_token");
    }
    if (!expiresIn || typeof expiresIn !== "number") {
      throw new Error("Twitter token exchange returned no expires_in");
    }

    return {
      access_token: access,
      refresh_token: refresh,
      expires_at: nowMs() + expiresIn * 1000,
      scope: typeof json.scope === "string" ? json.scope : undefined,
      token_type:
        typeof json.token_type === "string" ? json.token_type : undefined,
    };
  }

  private async refreshAccessToken(
    refreshToken: string,
  ): Promise<StoredOAuth2Tokens> {
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
      throw new Error(
        `Twitter token refresh failed (${res.status}): ${JSON.stringify(json)}`,
      );
    }

    const access = json.access_token as string | undefined;
    const refresh = (json.refresh_token as string | undefined) ?? refreshToken;
    const expiresIn = json.expires_in as number | undefined;

    if (!access || typeof access !== "string") {
      throw new Error("Twitter token refresh returned no access_token");
    }
    if (!expiresIn || typeof expiresIn !== "number") {
      throw new Error("Twitter token refresh returned no expires_in");
    }

    return {
      access_token: access,
      refresh_token: refresh,
      expires_at: nowMs() + expiresIn * 1000,
      scope: typeof json.scope === "string" ? json.scope : undefined,
      token_type:
        typeof json.token_type === "string" ? json.token_type : undefined,
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

    logger.info("Twitter OAuth (PKCE) setup required.");
    logger.info(`Open this URL to authorize: ${authorizeUrl}`);

    let code: string | undefined;
    try {
      // Preferred UX: loopback callback if redirect URI is loopback.
      const cb = await waitForLoopbackCallback(this.redirectUri, state);
      code = cb.code;
    } catch (e) {
      logger.warn(
        `Could not start loopback callback server (will fall back to paste URL): ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (!code) {
      const redirected = await promptForRedirectedUrl(
        "Paste the FULL redirected URL here (it contains ?code=...&state=...): ",
      );
      const parsed = new URL(redirected);
      const parsedCode = parsed.searchParams.get("code");
      const parsedState = parsed.searchParams.get("state");
      if (!parsedCode) throw new Error("Pasted URL did not include ?code=");
      assertOAuthState(parsedState, state);
      code = parsedCode;
    }

    return await this.exchangeCodeForToken({ code, codeVerifier: verifier });
  }

  private runInteractiveLogin(): Promise<StoredOAuth2Tokens> {
    return this.interactiveLoginFn
      ? this.interactiveLoginFn()
      : this.interactiveLogin();
  }

  /**
   * Resolve a valid token set, serializing refresh/re-auth work through
   * `authInFlight`. Concurrent callers that observe an expired token join the
   * same in-flight operation instead of starting a competing refresh, then
   * re-check the resulting token before returning. `produce` computes fresh
   * tokens; it runs at most once per burst of contending callers.
   */
  private async obtainTokens(
    produce: () => Promise<StoredOAuth2Tokens>,
  ): Promise<StoredOAuth2Tokens> {
    if (this.authInFlight) {
      const shared = await this.authInFlight;
      if (!isExpired(shared)) return shared;
      // The joined operation produced a token that is already expired (or the
      // caller needed a distinct credential); fall through to start a new one.
    }
    if (!this.authInFlight) {
      this.authInFlight = (async () => {
        const produced = await produce();
        await this.saveTokens(produced);
        return produced;
      })().finally(() => {
        this.authInFlight = null;
      });
    }
    return this.authInFlight;
  }

  async getAccessToken(): Promise<string> {
    const tokens = await this.loadTokens();

    if (tokens && !isExpired(tokens)) {
      return tokens.access_token;
    }

    if (!tokens) {
      const newTokens = await this.obtainTokens(() =>
        this.runInteractiveLogin(),
      );
      return newTokens.access_token;
    }

    if (!tokens.refresh_token) {
      // No refresh token available; must re-auth interactively.
      const newTokens = await this.obtainTokens(async () => {
        await this.tokenStore.clear();
        this.tokens = null;
        return this.runInteractiveLogin();
      });
      return newTokens.access_token;
    }

    const refreshToken = tokens.refresh_token;
    const refreshed = await this.obtainTokens(() =>
      this.refreshAccessToken(refreshToken),
    );
    return refreshed.access_token;
  }
}

export const OAUTH2_DEFAULT_SCOPES = DEFAULT_SCOPES;
