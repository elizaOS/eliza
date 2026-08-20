/**
 * Retrieves short-lived X user credentials from an authenticated Eliza Cloud
 * broker so managed agents never persist the upstream OAuth tokens themselves.
 * The broker owns refresh and rotation: OAuth2 responses carry `expires_at`
 * (epoch seconds) and this provider re-fetches ahead of that deadline, while
 * every cached credential is additionally capped at a short TTL so a
 * broker-side rotation (owner reconnect, refresh-token rotate) propagates
 * without a restart. `invalidate()` drops the cache immediately on rejection.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { getSetting } from "../../utils/settings";
import type { BrokerAuthCredentials, TwitterBrokerProvider } from "./types";

interface BrokerOAuth2Token {
  auth_mode: "oauth2";
  access_token: string;
  expires_at?: number;
}

interface BrokerOAuth1Token {
  auth_mode: "oauth1";
  consumer_key: string;
  consumer_secret: string;
  access_token: string;
  access_token_secret: string;
}

type BrokerToken = BrokerOAuth1Token | BrokerOAuth2Token;

const BROKER_CACHE_MS = 5 * 60 * 1000;
const OAUTH2_REFRESH_MARGIN_MS = 60 * 1000;

function isBrokerToken(value: unknown): value is BrokerToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const token = value as Record<string, unknown>;
  if (token.auth_mode === "oauth2") {
    return (
      typeof token.access_token === "string" && token.access_token.length > 0
    );
  }
  if (token.auth_mode === "oauth1") {
    return (
      typeof token.consumer_key === "string" &&
      typeof token.consumer_secret === "string" &&
      typeof token.access_token === "string" &&
      typeof token.access_token_secret === "string"
    );
  }
  return false;
}

export class BrokerAuthProvider implements TwitterBrokerProvider {
  readonly mode = "broker" as const;
  private cached: { token: BrokerToken; expiresAt: number } | null = null;
  private inflight: Promise<BrokerToken> | null = null;

  constructor(private readonly runtime: IAgentRuntime) {}

  async getAccessToken(): Promise<string> {
    return (await this.fetchToken()).access_token;
  }

  async getBrokerCredentials(): Promise<BrokerAuthCredentials> {
    const token = await this.fetchToken();
    if (token.auth_mode === "oauth2") {
      return { mode: "oauth2", accessToken: token.access_token };
    }
    return {
      mode: "oauth1",
      appKey: token.consumer_key,
      appSecret: token.consumer_secret,
      accessToken: token.access_token,
      accessSecret: token.access_token_secret,
    };
  }

  invalidate(): void {
    this.cached = null;
  }

  private brokerUrl(): string {
    const explicit = getSetting(this.runtime, "TWITTER_BROKER_URL");
    if (explicit) return explicit.replace(/\/+$/, "");
    const cloudBase =
      getSetting(this.runtime, "ELIZAOS_CLOUD_BASE_URL") ??
      "https://cloud.eliza.app/api/v1";
    return `${cloudBase.replace(/\/+$/, "")}/twitter`;
  }

  private brokerToken(): string {
    const token =
      getSetting(this.runtime, "TWITTER_BROKER_TOKEN") ??
      getSetting(this.runtime, "ELIZAOS_CLOUD_API_KEY");
    if (!token) {
      throw new Error(
        "TWITTER_AUTH_MODE=broker requires TWITTER_BROKER_TOKEN or ELIZAOS_CLOUD_API_KEY",
      );
    }
    return token;
  }

  private connectionRole(): "agent" | "owner" {
    const configured =
      getSetting(this.runtime, "TWITTER_BROKER_CONNECTION_ROLE") ?? "agent";
    const normalized = configured.trim().toLowerCase();
    if (normalized !== "agent" && normalized !== "owner") {
      throw new Error(
        `Invalid TWITTER_BROKER_CONNECTION_ROLE=${configured}. Expected agent|owner.`,
      );
    }
    return normalized;
  }

  private async fetchToken(): Promise<BrokerToken> {
    if (this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.token;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchFromBroker().then((token) => {
      const cacheCap = Date.now() + BROKER_CACHE_MS;
      const expiresAt =
        token.auth_mode === "oauth2" && token.expires_at
          ? Math.min(
              token.expires_at * 1000 - OAUTH2_REFRESH_MARGIN_MS,
              cacheCap,
            )
          : cacheCap;
      this.cached = { token, expiresAt };
      return token;
    });

    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async fetchFromBroker(): Promise<BrokerToken> {
    const response = await fetch(
      `${this.brokerUrl()}/token?connectionRole=${this.connectionRole()}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.brokerToken()}`,
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.status === 401 || response.status === 403) {
      this.invalidate();
      throw new Error(
        `X broker rejected the agent credential (${response.status})`,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `X broker request failed (${response.status}): ${body.slice(0, 200)}`,
      );
    }
    const token: unknown = await response.json();
    if (!isBrokerToken(token)) {
      throw new Error("X broker returned an invalid credential response");
    }
    return token;
  }
}
