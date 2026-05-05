import type {
  LifeOpsConnectorSide,
  LifeOpsXCapability,
  LifeOpsXFeedType,
  StartLifeOpsXConnectorResponse,
} from "../contracts/index.js";
import { LIFEOPS_X_CAPABILITIES } from "../contracts/index.js";
import {
  type ResolvedManagedGoogleCloudConfig,
  resolveManagedGoogleCloudConfig,
} from "./google-managed-client.js";

const MANAGED_X_REQUEST_TIMEOUT_MS = 20_000;

export class ManagedXClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ManagedXClientError";
  }
}

export interface ManagedXConnectorStatusResponse {
  provider: "x";
  side: LifeOpsConnectorSide;
  mode: "cloud_managed";
  configured: boolean;
  connected: boolean;
  reason: "connected" | "disconnected" | "config_missing" | "needs_reauth";
  identity: Record<string, unknown> | null;
  grantedCapabilities: LifeOpsXCapability[];
  grantedScopes: string[];
  connectionId: string | null;
  linkedAt: string | null;
  lastUsedAt: string | null;
}

export interface ManagedXPostResponse {
  ok: boolean;
  status: number | null;
  postId?: string;
  error?: string;
  category:
    | "success"
    | "auth"
    | "rate_limit"
    | "network"
    | "invalid"
    | "unknown";
}

export interface ManagedXDirectMessage {
  id: string;
  text: string;
  createdAt: string | null;
  conversationId: string;
  participantIds: string[];
  senderId: string;
  recipientId: string;
  participantId: string;
  direction: "sent" | "received";
  entities: Record<string, unknown> | null;
  hasAttachment: boolean;
}

export interface ManagedXDmDigestResponse {
  operation: "dm.digest";
  digest: {
    totalMessages: number;
    receivedCount: number;
    sentCount: number;
    participantIds: string[];
    latestMessageAt: string | null;
  };
  messages: ManagedXDirectMessage[];
  syncedAt: string;
}

export interface ManagedXDmSendResponse {
  sent: boolean;
  operation: "dm.send";
  message: ManagedXDirectMessage;
}

export interface ManagedXFeedItem {
  id: string;
  text: string;
  createdAt: string | null;
  authorId: string;
  authorHandle: string;
  conversationId: string | null;
  referencedTweets: Array<{ type: string; id: string }>;
  publicMetrics: Record<string, unknown> | null;
  entities: Record<string, unknown> | null;
}

export interface ManagedXFeedResponse {
  operation: "feed.read";
  feedType: LifeOpsXFeedType;
  items: ManagedXFeedItem[];
  syncedAt: string;
}

interface TwitterConnectResponse {
  authUrl: string;
  oauthToken?: string;
  connectionRole?: LifeOpsConnectorSide;
}

function buildTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`.trim();
    const text = await response.text();
    const trimmed = text.trim();
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    if (trimmed.length > 0) {
      try {
        if (contentType.includes("text/html") && !/^[{[]/.test(trimmed)) {
          throw new Error("html response");
        }
        const parsed = JSON.parse(trimmed) as {
          error?: string;
          message?: string;
        };
        detail = parsed.message ?? parsed.error ?? trimmed;
      } catch {
        if (!contentType.includes("text/html")) {
          detail = trimmed.slice(0, 200);
        }
      }
    }
    throw new ManagedXClientError(response.status, detail);
  }

  return (await response.json()) as T;
}

function xCapabilitiesForSide(
  side: LifeOpsConnectorSide,
): LifeOpsXCapability[] {
  if (side === "agent") {
    return [...LIFEOPS_X_CAPABILITIES];
  }
  return ["x.read", "x.dm.read", "x.dm.write"];
}

function connectionIdForSide(side: LifeOpsConnectorSide): string {
  return `twitter:${side}`;
}

export class XManagedClient {
  constructor(
    private readonly configSource:
      | ResolvedManagedGoogleCloudConfig
      | (() => ResolvedManagedGoogleCloudConfig) = resolveManagedGoogleCloudConfig,
  ) {}

  private getConfig(): ResolvedManagedGoogleCloudConfig {
    return typeof this.configSource === "function"
      ? this.configSource()
      : this.configSource;
  }

  get configured(): boolean {
    return this.getConfig().configured;
  }

  private requireConfig(): ResolvedManagedGoogleCloudConfig & {
    apiKey: string;
  } {
    const config = this.getConfig();
    if (!config.apiKey) {
      throw new ManagedXClientError(409, "Eliza Cloud is not connected.");
    }
    return {
      ...config,
      apiKey: config.apiKey,
    };
  }

  private async request<T>(
    pathname: string,
    init: RequestInit = {},
  ): Promise<T> {
    const config = this.requireConfig();
    const url = new URL(
      pathname.replace(/^\/+/, ""),
      `${config.apiBaseUrl.replace(/\/+$/, "")}/`,
    );
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
        ...(init.headers ?? {}),
      },
      signal: init.signal ?? buildTimeoutSignal(MANAGED_X_REQUEST_TIMEOUT_MS),
    });
    return readJsonResponse<T>(response);
  }

  async getStatus(
    side: LifeOpsConnectorSide,
  ): Promise<ManagedXConnectorStatusResponse> {
    if (!this.configured) {
      return {
        provider: "x",
        side,
        mode: "cloud_managed",
        configured: false,
        connected: false,
        reason: "config_missing",
        identity: null,
        grantedCapabilities: [],
        grantedScopes: [],
        connectionId: null,
        linkedAt: null,
        lastUsedAt: null,
      };
    }
    const status = await this.request<{
      configured: boolean;
      connected: boolean;
      username?: string;
      userId?: string;
      avatarUrl?: string;
      error?: string;
      connectionRole?: LifeOpsConnectorSide;
      connectionId?: string | null;
    }>(`twitter/status?connectionRole=${encodeURIComponent(side)}`, {
      method: "GET",
    });

    return {
      provider: "x",
      side,
      mode: "cloud_managed",
      configured: status.configured,
      connected: status.connected,
      reason: !status.configured
        ? "config_missing"
        : status.connected
          ? "connected"
          : status.error
            ? "needs_reauth"
            : "disconnected",
      identity:
        status.connected || status.username || status.userId
          ? {
              username: status.username,
              userId: status.userId,
              avatarUrl: status.avatarUrl,
            }
          : null,
      grantedCapabilities: status.connected ? xCapabilitiesForSide(side) : [],
      grantedScopes: status.connected
        ? side === "agent"
          ? ["tweet.read", "tweet.write", "users.read", "dm.read", "dm.write"]
          : ["tweet.read", "users.read", "dm.read", "dm.write"]
        : [],
      connectionId: status.connected
        ? (status.connectionId ?? connectionIdForSide(side))
        : null,
      linkedAt: null,
      lastUsedAt: null,
    };
  }

  async startConnector(args: {
    side: LifeOpsConnectorSide;
    redirectUrl?: string;
  }): Promise<StartLifeOpsXConnectorResponse> {
    const redirectUri =
      args.redirectUrl ??
      new URL(
        `/auth/success?platform=twitter&connectionRole=${args.side}`,
        `${this.requireConfig().siteUrl.replace(/\/+$/, "")}/`,
      ).toString();
    const auth = await this.request<TwitterConnectResponse>("twitter/connect", {
      method: "POST",
      body: JSON.stringify({
        redirectUrl: redirectUri,
        connectionRole: args.side,
      }),
    });
    return {
      provider: "x",
      side: args.side,
      mode: "cloud_managed",
      requestedCapabilities: xCapabilitiesForSide(args.side),
      redirectUri,
      authUrl: auth.authUrl,
    };
  }

  async disconnectConnector(side: LifeOpsConnectorSide): Promise<void> {
    await this.request(
      `twitter/disconnect?connectionRole=${encodeURIComponent(side)}`,
      {
        method: "DELETE",
      },
    );
  }

  async createPost(args: {
    side: LifeOpsConnectorSide;
    text: string;
    confirmPost: true;
  }): Promise<ManagedXPostResponse> {
    const result = await this.request<{
      tweet: { id: string };
    }>("x/posts", {
      method: "POST",
      body: JSON.stringify({
        connectionRole: args.side,
        text: args.text,
        confirmPost: args.confirmPost,
      }),
    });
    return {
      ok: true,
      status: 201,
      postId: result.tweet.id,
      category: "success",
    };
  }

  async getDmDigest(args: {
    side: LifeOpsConnectorSide;
    maxResults?: number;
  }): Promise<ManagedXDmDigestResponse> {
    const query = new URLSearchParams({
      connectionRole: args.side,
    });
    if (args.maxResults) {
      query.set("maxResults", String(args.maxResults));
    }
    return this.request<ManagedXDmDigestResponse>(
      `x/dms/digest?${query.toString()}`,
      {
        method: "GET",
      },
    );
  }

  async getFeed(args: {
    side: LifeOpsConnectorSide;
    feedType: LifeOpsXFeedType;
    query?: string;
    maxResults?: number;
  }): Promise<ManagedXFeedResponse> {
    const query = new URLSearchParams({
      connectionRole: args.side,
      feedType: args.feedType,
    });
    if (args.query) {
      query.set("query", args.query);
    }
    if (args.maxResults) {
      query.set("maxResults", String(args.maxResults));
    }
    return this.request<ManagedXFeedResponse>(`x/feed?${query.toString()}`, {
      method: "GET",
    });
  }

  async sendDm(args: {
    side: LifeOpsConnectorSide;
    participantId: string;
    text: string;
  }): Promise<ManagedXDmSendResponse> {
    return this.request<ManagedXDmSendResponse>("x/dms/send", {
      method: "POST",
      body: JSON.stringify({
        confirmSend: true,
        connectionRole: args.side,
        participantId: args.participantId,
        text: args.text,
      }),
    });
  }

  async sendDmToConversation(args: {
    side: LifeOpsConnectorSide;
    conversationId: string;
    text: string;
  }): Promise<ManagedXDmSendResponse> {
    return this.request<ManagedXDmSendResponse>("x/dms/conversations/send", {
      method: "POST",
      body: JSON.stringify({
        confirmSend: true,
        connectionRole: args.side,
        conversationId: args.conversationId,
        text: args.text,
      }),
    });
  }

  async createDmGroup(args: {
    side: LifeOpsConnectorSide;
    participantIds: string[];
    text: string;
  }): Promise<ManagedXDmSendResponse & { conversationId: string }> {
    return this.request<ManagedXDmSendResponse & { conversationId: string }>(
      "x/dms/groups",
      {
        method: "POST",
        body: JSON.stringify({
          confirmSend: true,
          connectionRole: args.side,
          participantIds: args.participantIds,
          text: args.text,
        }),
      },
    );
  }
}
