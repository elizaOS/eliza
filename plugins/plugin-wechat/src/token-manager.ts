/**
 * Account-scoped access-token lifecycle for the direct WeChat platforms:
 * fetches tokens from the fixed first-party endpoint, caches them until just
 * before `expires_in`, refreshes single-flight (concurrent callers share one
 * in-flight request), forces one recovery refresh on a 40001/42001-class
 * invalid-token response, and transitions the owning account's transport
 * health to degraded/unavailable when the platform rejects credentials.
 * Clock and fetch are injectable for deterministic tests.
 */
import type { ResolvedWechatAccount, WechatTransportHealth } from "./types";
import { WechatError } from "./types";

const REFRESH_MARGIN_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type TokenFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface TokenManagerOptions {
  fetchFn: TokenFetch;
  now?: () => number;
  refreshMarginMs?: number;
  onHealthChange?: (accountId: string, health: WechatTransportHealth) => void;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export class TokenManager {
  private readonly fetchFn: TokenFetch;
  private readonly now: () => number;
  private readonly refreshMarginMs: number;
  private readonly onHealthChange?: TokenManagerOptions["onHealthChange"];
  private readonly cache = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(options: TokenManagerOptions) {
    this.fetchFn = options.fetchFn;
    this.now = options.now ?? Date.now;
    this.refreshMarginMs = options.refreshMarginMs ?? REFRESH_MARGIN_MS;
    this.onHealthChange = options.onHealthChange;
  }

  /**
   * Return a usable access token, refreshing when within the margin of
   * expiry. Single-flight per account: concurrent callers share one request.
   */
  async getAccessToken(account: ResolvedWechatAccount): Promise<string> {
    const cached = this.cache.get(account.id);
    if (cached && cached.expiresAt - this.refreshMarginMs > this.now()) {
      return cached.accessToken;
    }

    const existing = this.inFlight.get(account.id);
    if (existing) {
      return existing;
    }

    const promise = this.fetchToken(account).finally(() =>
      this.inFlight.delete(account.id),
    );
    this.inFlight.set(account.id, promise);
    return promise;
  }

  /**
   * Handle a platform "invalid/expired token" error: exactly one forced
   * refresh per account, guarded so a concurrent invalid-token storm cannot
   * loop. Returns a fresh token for the retry.
   */
  async recoverFromInvalidToken(
    account: ResolvedWechatAccount,
  ): Promise<string> {
    this.cache.delete(account.id);
    return this.getAccessToken(account);
  }

  /** Drop all state for an account (plugin dispose / account removal). */
  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }

  dispose(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  private async fetchToken(account: ResolvedWechatAccount): Promise<string> {
    let response: Awaited<ReturnType<TokenFetch>>;
    try {
      if (account.mode === "official-account") {
        response = await this.fetchFn(
          "https://api.weixin.qq.com/cgi-bin/stable_token",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              grant_type: "client_credential",
              appid: account.platformIdentity,
              secret: account.secret,
              force_refresh: false,
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        );
      } else {
        const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(
          account.platformIdentity,
        )}&corpsecret=${encodeURIComponent(account.secret)}`;
        response = await this.fetchFn(url, {
          method: "GET",
          headers: {},
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      }
    } catch (err) {
      // error-policy:J2 the transport failure is wrapped in the typed token
      // error with the original cause preserved; health records the degrade.
      this.reportHealth(account.id, {
        state: "unavailable",
        lastFailureAt: this.now(),
        lastFailureDetail: "token-network-error",
      });
      throw new WechatError(
        "WECHAT_TOKEN_UNAVAILABLE",
        "token request to the first-party endpoint failed",
        { accountId: account.id },
        { cause: err },
      );
    }

    // error-policy:J3 an unparseable token-endpoint body is untrusted input;
    // rendered as absent so credential rejection is classified, never faked.
    const payload = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
      errcode?: unknown;
    } | null;

    if (!response.ok || !payload?.access_token) {
      const errcode =
        typeof payload?.errcode === "number" ? payload.errcode : undefined;
      // WeCom answers 200 with errcode 40001/42001-style rejections; treat any
      // payload-level rejection identically to an HTTP failure.
      this.reportHealth(account.id, {
        state: "unavailable",
        lastFailureAt: this.now(),
        lastFailureDetail: errcode
          ? `errcode-${errcode}`
          : `http-${response.status}`,
      });
      throw new WechatError(
        "WECHAT_TOKEN_UNAVAILABLE",
        "first-party token endpoint rejected credentials",
        { accountId: account.id, errcode },
      );
    }

    const expiresIn =
      typeof payload.expires_in === "number" && payload.expires_in > 0
        ? payload.expires_in
        : 7200;
    this.cache.set(account.id, {
      accessToken: String(payload.access_token),
      expiresAt: this.now() + expiresIn * 1000,
    });
    this.reportHealth(account.id, {
      state: "connected",
      lastSuccessAt: this.now(),
      observedVia: "token-probe",
    });
    return String(payload.access_token);
  }

  private reportHealth(accountId: string, health: WechatTransportHealth): void {
    this.onHealthChange?.(accountId, health);
  }
}
