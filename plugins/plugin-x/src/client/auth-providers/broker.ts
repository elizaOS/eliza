import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getSetting } from "../../utils/settings";
import type {
  OAuth1Credentials,
  TwitterAuthProvider,
  TwitterOAuth1Provider,
} from "./types";

/**
 * Broker auth: delegates X (Twitter) credential storage to a remote OAuth
 * broker (typically Eliza Cloud).
 *
 * Wire contract — `GET <TWITTER_BROKER_URL>/token` with header
 * `Authorization: Bearer <TWITTER_BROKER_TOKEN>` returns one of:
 *
 *   OAuth 2.0 user-context (preferred, X API v2):
 *     {
 *       "auth_mode": "oauth2",
 *       "access_token": "AAAA...",
 *       "expires_at": 1735689600,         // unix seconds; optional
 *       "scopes": "tweet.read tweet.write users.read offline.access",
 *       "username": "elizaagent"          // optional metadata
 *     }
 *
 *   OAuth 1.0a user-context (legacy, also supported by twitter-api-v2):
 *     {
 *       "auth_mode": "oauth1",
 *       "consumer_key": "...",
 *       "consumer_secret": "...",
 *       "access_token": "...",
 *       "access_token_secret": "...",
 *       "username": "elizaagent"          // optional
 *     }
 *
 * The broker endpoint is responsible for (a) authenticating the agent via the
 * bearer token, (b) looking up the X connection associated with the agent's
 * org/user, and (c) refreshing tokens server-side as needed.
 *
 * The plugin caches tokens until 60s before `expires_at` (OAuth 2.0) or for a
 * 5-minute window (OAuth 1.0a). On 401 the cache is invalidated immediately.
 */

interface BrokerTokenResponseOAuth2 {
  auth_mode: "oauth2";
  access_token: string;
  expires_at?: number;
  scopes?: string;
  username?: string;
}

interface BrokerTokenResponseOAuth1 {
  auth_mode: "oauth1";
  consumer_key: string;
  consumer_secret: string;
  access_token: string;
  access_token_secret: string;
  username?: string;
}

type BrokerTokenResponse =
  | BrokerTokenResponseOAuth2
  | BrokerTokenResponseOAuth1;

interface CachedToken {
  token: BrokerTokenResponse;
  fetchedAt: number;
  expiresAt: number;
}

const OAUTH1_CACHE_MS = 5 * 60 * 1000;
const OAUTH2_REFRESH_MARGIN_MS = 60 * 1000;

export class BrokerAuthProvider
  implements TwitterAuthProvider, TwitterOAuth1Provider
{
  readonly mode = "broker" as const;

  private cached: CachedToken | null = null;
  private inflight: Promise<BrokerTokenResponse> | null = null;

  constructor(private readonly runtime: IAgentRuntime) {}

  async getAccessToken(): Promise<string> {
    const token = await this.fetchToken();
    return token.access_token;
  }

  async getOAuth1Credentials(): Promise<OAuth1Credentials> {
    const token = await this.fetchToken();
    if (token.auth_mode !== "oauth1") {
      throw new Error(
        `X broker is configured for ${token.auth_mode} but OAuth1 credentials were requested.`,
      );
    }
    return {
      appKey: token.consumer_key,
      appSecret: token.consumer_secret,
      accessToken: token.access_token,
      accessSecret: token.access_token_secret,
    };
  }

  /** Force a refresh on next call (e.g. after an upstream 401). */
  invalidate(): void {
    this.cached = null;
  }

  private resolveBrokerUrl(): string {
    const explicit = getSetting(this.runtime, "TWITTER_BROKER_URL");
    if (explicit) return explicit;
    const cloudBase =
      getSetting(this.runtime, "ELIZAOS_CLOUD_BASE_URL") ||
      "https://www.elizacloud.ai/api/v1";
    return `${cloudBase.replace(/\/+$/, "")}/twitter`;
  }

  private resolveBrokerToken(): string | null {
    return (
      getSetting(this.runtime, "TWITTER_BROKER_TOKEN") ||
      getSetting(this.runtime, "ELIZAOS_CLOUD_API_KEY") ||
      null
    );
  }

  private async fetchToken(): Promise<BrokerTokenResponse> {
    if (this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.token;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchTokenFromBroker()
      .then((token) => {
        this.cached = {
          token,
          fetchedAt: Date.now(),
          expiresAt: this.computeCacheUntil(token),
        };
        return token;
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.inflight;
  }

  private computeCacheUntil(token: BrokerTokenResponse): number {
    if (token.auth_mode === "oauth2" && token.expires_at) {
      return token.expires_at * 1000 - OAUTH2_REFRESH_MARGIN_MS;
    }
    return Date.now() + OAUTH1_CACHE_MS;
  }

  private async fetchTokenFromBroker(): Promise<BrokerTokenResponse> {
    const baseUrl = this.resolveBrokerUrl();
    const brokerToken = this.resolveBrokerToken();
    if (!brokerToken) {
      throw new Error(
        "TWITTER_AUTH_MODE=broker requires either TWITTER_BROKER_TOKEN or ELIZAOS_CLOUD_API_KEY. Connect your X account through Eliza Cloud to authorize the agent.",
      );
    }

    const url = baseUrl.replace(/\/+$/, "") + "/token";
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${brokerToken}`,
        Accept: "application/json",
      },
    });

    if (response.status === 401 || response.status === 403) {
      this.invalidate();
      throw new Error(
        `X broker rejected the agent's broker token (${response.status}). Reconnect via the connectors page.`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `X broker request failed (${response.status}): ${body.slice(0, 200)}`,
      );
    }

    const json = (await response.json()) as Partial<BrokerTokenResponse>;
    if (!isBrokerTokenResponse(json)) {
      logger.warn("[X broker] Unexpected response shape", { json });
      throw new Error(
        "X broker returned an unrecognised token response. Expected { auth_mode: 'oauth1' | 'oauth2', ... }.",
      );
    }
    return json;
  }
}

function isBrokerTokenResponse(
  v: Partial<BrokerTokenResponse>,
): v is BrokerTokenResponse {
  if (!v || typeof v !== "object") return false;
  if (v.auth_mode === "oauth2") {
    return typeof v.access_token === "string" && v.access_token.length > 0;
  }
  if (v.auth_mode === "oauth1") {
    return (
      typeof v.consumer_key === "string" &&
      typeof v.consumer_secret === "string" &&
      typeof v.access_token === "string" &&
      typeof v.access_token_secret === "string"
    );
  }
  return false;
}
