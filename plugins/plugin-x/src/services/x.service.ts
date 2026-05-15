import {
  ChannelType,
  type Content,
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Memory,
  type MessageConnectorQueryContext,
  type MessageConnectorTarget,
  type MessageConnectorUserContext,
  parseBooleanFromText,
  Service,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import { ClientBase } from "../base";
import {
  normalizeXAccountId,
  resolveDefaultXAccountId,
  resolveRequestedXAccountId,
  resolveTwitterAccountConfig,
} from "../client/accounts.js";
import { SearchMode } from "../client/index.js";
import { TwitterDiscoveryClient } from "../discovery";
import { validateTwitterConfig } from "../environment";
import { TwitterInteractionClient } from "../interactions";
import { TwitterPostClient } from "../post";
import { TwitterTimelineClient } from "../timeline";
import type { ITwitterClient, TwitterClientState } from "../types";
import { getSetting } from "../utils/settings";
import { TwitterPostService } from "./PostService";

const X_CONNECTOR_CONTEXTS = ["social", "connectors"];
const X_CONNECTOR_CAPABILITIES = [
  "send_message",
  "fetch_messages",
  "resolve_targets",
  "user_context",
];

const X_USER_ID_PATTERN = /^\d+$/;
const X_MAX_POST_LENGTH = 280;

export type XAccountCapability =
  | "x.read"
  | "x.write"
  | "x.dm.read"
  | "x.dm.write";

export interface XAccountCapabilityStatus {
  accountId: string;
  configured: boolean;
  connected: boolean;
  reason: "connected" | "disconnected" | "config_missing" | "needs_reauth";
  identity: Record<string, unknown> | null;
  grantedCapabilities: XAccountCapability[];
  grantedScopes: string[];
  authMode: "env" | "oauth";
}

type XMessageConnectorRegistration = Parameters<
  IAgentRuntime["registerMessageConnector"]
>[0] & {
  fetchMessages?: (
    context: MessageConnectorQueryContext,
    params?: {
      target?: TargetInfo;
      limit?: number;
      before?: string;
      after?: string;
    },
  ) => Promise<Memory[]>;
  contentShaping?: {
    systemPromptFragment?: string;
    constraints?: Record<string, unknown>;
  };
};

interface PostConnectorQueryContext {
  runtime: IAgentRuntime;
  roomId?: UUID;
  source?: string;
  target?: TargetInfo;
  metadata?: Record<string, unknown>;
}

interface PostConnectorRegistration {
  source: string;
  label?: string;
  description?: string;
  capabilities?: string[];
  contexts?: string[];
  metadata?: Record<string, unknown>;
  postHandler: (
    runtime: IAgentRuntime,
    content: Content,
    context?: PostConnectorQueryContext,
  ) => Promise<Memory>;
  fetchFeed?: (
    context: PostConnectorQueryContext,
    params?: {
      feed?: string;
      target?: TargetInfo;
      userId?: string;
      limit?: number;
      cursor?: string;
    },
  ) => Promise<Memory[]>;
  searchPosts?: (
    context: PostConnectorQueryContext,
    params: { query: string; limit?: number; cursor?: string },
  ) => Promise<Memory[]>;
  contentShaping?: {
    systemPromptFragment?: string;
    constraints?: Record<string, unknown>;
  };
}

type RuntimeWithPostConnector = IAgentRuntime & {
  registerPostConnector?: (registration: PostConnectorRegistration) => void;
};

function normalizeXConnectorQuery(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function clampLimit(
  value: number | undefined,
  defaultValue: number,
  max: number,
): number {
  if (!Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.min(Math.max(1, Math.floor(value as number)), max);
}

function readContentString(
  content: Content,
  keys: string[],
): string | undefined {
  const record = content as Content & Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readAccountIdFromRecord(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const source = record as Record<string, unknown>;
  const direct = source.accountId;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const metadata =
    source.metadata && typeof source.metadata === "object"
      ? (source.metadata as Record<string, unknown>)
      : undefined;
  const fromMetadata = metadata?.accountId;
  return typeof fromMetadata === "string" && fromMetadata.trim()
    ? fromMetadata.trim()
    : undefined;
}

function capabilitiesForXAuthState(state: TwitterClientState): {
  capabilities: XAccountCapability[];
  scopes: string[];
} {
  const mode = state.TWITTER_AUTH_MODE === "oauth" ? "oauth" : "env";
  if (mode === "env") {
    return {
      capabilities: ["x.read", "x.write", "x.dm.read", "x.dm.write"],
      scopes: [
        "tweet.read",
        "tweet.write",
        "users.read",
        "dm.read",
        "dm.write",
      ],
    };
  }

  const scopes = (state.TWITTER_SCOPES ?? "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const scopeSet = new Set(scopes);
  const capabilities: XAccountCapability[] = [];
  if (scopeSet.has("tweet.read")) capabilities.push("x.read");
  if (scopeSet.has("tweet.write")) capabilities.push("x.write");
  if (scopeSet.has("dm.read")) capabilities.push("x.dm.read");
  if (scopeSet.has("dm.write")) capabilities.push("x.dm.write");
  return { capabilities, scopes };
}

/**
 * A manager that orchestrates all specialized Twitter logic:
 * - client: base operations (login, timeline caching, etc.)
 * - post: autonomous posting logic
 * - interaction: handling mentions, replies, and autonomous targeting
 * - timeline: processing timeline for actions (likes, retweets, replies)
 * - discovery: autonomous content discovery and engagement
 */
export class TwitterClientInstance implements ITwitterClient {
  client: ClientBase;
  post?: TwitterPostClient;
  interaction?: TwitterInteractionClient;
  timeline?: TwitterTimelineClient;
  discovery?: TwitterDiscoveryClient;
  readonly accountId: string;

  constructor(runtime: IAgentRuntime, state: TwitterClientState) {
    this.accountId = resolveRequestedXAccountId(
      runtime,
      state,
      state.accountId,
    );
    // Pass twitterConfig to the base client
    this.client = new ClientBase(runtime, state);

    // Posting logic
    const postEnabled = parseBooleanFromText(
      getSetting(runtime, "TWITTER_ENABLE_POST"),
    );
    logger.debug(
      `TWITTER_ENABLE_POST setting value: ${JSON.stringify(postEnabled)}, type: ${typeof postEnabled}`,
    );

    if (postEnabled) {
      logger.info("Twitter posting is ENABLED - creating post client");
      this.post = new TwitterPostClient(this.client, runtime, state);
    } else {
      logger.info(
        "Twitter posting is DISABLED - set TWITTER_ENABLE_POST=true to enable automatic posting",
      );
    }

    // Mentions and interactions
    const repliesEnabled =
      (getSetting(runtime, "TWITTER_ENABLE_REPLIES") ??
        process.env.TWITTER_ENABLE_REPLIES) !== "false";

    if (repliesEnabled) {
      logger.info("Twitter replies/interactions are ENABLED");
      this.interaction = new TwitterInteractionClient(
        this.client,
        runtime,
        state,
      );
    } else {
      logger.info("Twitter replies/interactions are DISABLED");
    }

    // Timeline actions (likes, retweets, replies)
    const actionsEnabled =
      (getSetting(runtime, "TWITTER_ENABLE_ACTIONS") ??
        process.env.TWITTER_ENABLE_ACTIONS) === "true";

    if (actionsEnabled) {
      logger.info("Twitter timeline actions are ENABLED");
      this.timeline = new TwitterTimelineClient(this.client, runtime, state);
    } else {
      logger.info("Twitter timeline actions are DISABLED");
    }

    // Discovery service for autonomous content discovery
    const discoveryEnabled =
      (getSetting(runtime, "TWITTER_ENABLE_DISCOVERY") ??
        process.env.TWITTER_ENABLE_DISCOVERY) === "true" ||
      (actionsEnabled &&
        (getSetting(runtime, "TWITTER_ENABLE_DISCOVERY") ??
          process.env.TWITTER_ENABLE_DISCOVERY) !== "false");

    if (discoveryEnabled) {
      logger.info("Twitter discovery service is ENABLED");
      this.discovery = new TwitterDiscoveryClient(this.client, runtime, state);
    } else {
      logger.info(
        "Twitter discovery service is DISABLED - set TWITTER_ENABLE_DISCOVERY=true to enable",
      );
    }
  }
}

export class XService extends Service {
  static serviceType = "x";

  // Add the required abstract property
  capabilityDescription = "The agent is able to send and receive messages on X";

  public twitterClient?: TwitterClientInstance;
  private defaultAccountId = "default";
  private accountClients = new Map<string, TwitterClientInstance>();
  private accountClientStarts = new Map<
    string,
    Promise<TwitterClientInstance>
  >();

  static async start(runtime: IAgentRuntime): Promise<XService> {
    const service = new XService();
    service.runtime = runtime;

    try {
      const defaultState = await resolveTwitterAccountConfig(runtime);
      await validateTwitterConfig(runtime, defaultState);
      service.defaultAccountId = resolveDefaultXAccountId(
        runtime,
        defaultState,
      );
      logger.log("✅ Twitter configuration validated successfully");

      service.twitterClient = await service.getTwitterClientForAccount(
        service.defaultAccountId,
        { startAutonomousClients: true, state: defaultState },
      );

      logger.log("✅ Twitter service started successfully");
    } catch (error) {
      logger.error(
        `🚨 Failed to start Twitter service: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    return service;
  }

  private resolveAccountId(...sources: unknown[]): string {
    for (const source of sources) {
      const accountId = readAccountIdFromRecord(source);
      if (accountId) return normalizeXAccountId(accountId);
      if (typeof source === "string" && source.trim()) {
        return normalizeXAccountId(source);
      }
    }
    return normalizeXAccountId(this.defaultAccountId);
  }

  private async getTwitterClientForAccount(
    accountIdInput?: unknown,
    options: {
      startAutonomousClients?: boolean;
      state?: TwitterClientState;
    } = {},
  ): Promise<TwitterClientInstance> {
    const runtime = this.runtime;
    if (!runtime) {
      throw new Error("X service runtime is not initialized.");
    }

    const state = await resolveTwitterAccountConfig(runtime, {
      accountId: accountIdInput,
      state: options.state,
    });
    const accountId = resolveRequestedXAccountId(
      runtime,
      state,
      accountIdInput ?? state.accountId,
    );

    const cached = this.accountClients.get(accountId);
    if (cached) {
      return cached;
    }

    const starting = this.accountClientStarts.get(accountId);
    if (starting) {
      return starting;
    }

    const startPromise = (async () => {
      await validateTwitterConfig(runtime, state);
      const instance = new TwitterClientInstance(runtime, state);
      await instance.client.init();

      if (options.startAutonomousClients) {
        await this.startAutonomousClients(instance);
      }

      this.accountClients.set(accountId, instance);
      if (accountId === this.defaultAccountId) {
        this.twitterClient = instance;
      }
      return instance;
    })();

    this.accountClientStarts.set(accountId, startPromise);
    try {
      return await startPromise;
    } finally {
      this.accountClientStarts.delete(accountId);
    }
  }

  async getAccountStatus(
    accountIdInput: string = this.defaultAccountId,
  ): Promise<XAccountCapabilityStatus> {
    const runtime = this.runtime;
    if (!runtime) {
      throw new Error("X service runtime is not initialized.");
    }

    const state = await resolveTwitterAccountConfig(runtime, {
      accountId: accountIdInput,
    });
    const accountId = resolveRequestedXAccountId(
      runtime,
      state,
      accountIdInput,
    );
    const authMode = state.TWITTER_AUTH_MODE === "oauth" ? "oauth" : "env";
    const missing =
      authMode === "env"
        ? [
            ["TWITTER_API_KEY", state.TWITTER_API_KEY],
            ["TWITTER_API_SECRET_KEY", state.TWITTER_API_SECRET_KEY],
            ["TWITTER_ACCESS_TOKEN", state.TWITTER_ACCESS_TOKEN],
            ["TWITTER_ACCESS_TOKEN_SECRET", state.TWITTER_ACCESS_TOKEN_SECRET],
          ].filter(([, value]) => typeof value !== "string" || !value.trim())
        : [
            ["TWITTER_CLIENT_ID", state.TWITTER_CLIENT_ID],
            ["TWITTER_REDIRECT_URI", state.TWITTER_REDIRECT_URI],
          ].filter(([, value]) => typeof value !== "string" || !value.trim());

    if (missing.length > 0) {
      return {
        accountId,
        configured: false,
        connected: false,
        reason: "config_missing",
        identity: null,
        grantedCapabilities: [],
        grantedScopes: [],
        authMode,
      };
    }

    const loadedClient =
      this.accountClients.get(accountId) ??
      (this.twitterClient?.accountId === accountId ? this.twitterClient : null);
    const profile = loadedClient?.client.profile;
    const { capabilities, scopes } = capabilitiesForXAuthState(state);
    return {
      accountId,
      configured: true,
      connected: true,
      reason: "connected",
      identity: profile
        ? {
            userId: profile.id,
            username: profile.username,
            name: profile.screenName,
          }
        : null,
      grantedCapabilities: capabilities,
      grantedScopes: scopes,
      authMode,
    };
  }

  private async startAutonomousClients(
    instance: TwitterClientInstance,
  ): Promise<void> {
    if (instance.post) {
      logger.log(
        `📮 Starting Twitter post client for accountId=${instance.accountId}...`,
      );
      await instance.post.start();
    }

    if (instance.interaction) {
      logger.log(
        `💬 Starting Twitter interaction client for accountId=${instance.accountId}...`,
      );
      await instance.interaction.start();
    }

    if (instance.timeline) {
      logger.log(
        `📊 Starting Twitter timeline client for accountId=${instance.accountId}...`,
      );
      await instance.timeline.start();
    }

    if (instance.discovery) {
      logger.log(
        `🔍 Starting Twitter discovery client for accountId=${instance.accountId}...`,
      );
      await instance.discovery.start();
    }
  }

  static registerSendHandlers(
    runtime: IAgentRuntime,
    serviceInstance: XService,
  ): void {
    if (!serviceInstance) {
      return;
    }

    serviceInstance.registerPostConnector(runtime);

    const sendHandler = serviceInstance.handleSendMessage.bind(serviceInstance);
    if (typeof runtime.registerMessageConnector === "function") {
      const registration: XMessageConnectorRegistration = {
        source: "x",
        label: "X DMs",
        description:
          "X/Twitter direct-message connector. Public tweets remain under X post actions.",
        capabilities: [...X_CONNECTOR_CAPABILITIES],
        supportedTargetKinds: ["user", "contact"],
        contexts: [...X_CONNECTOR_CONTEXTS],
        metadata: {
          service: XService.serviceType,
        },
        resolveTargets:
          serviceInstance.resolveConnectorTargets.bind(serviceInstance),
        listRecentTargets:
          serviceInstance.listRecentConnectorTargets.bind(serviceInstance),
        getUserContext:
          serviceInstance.getConnectorUserContext.bind(serviceInstance),
        fetchMessages:
          serviceInstance.fetchConnectorMessages.bind(serviceInstance),
        contentShaping: {
          systemPromptFragment:
            "For X direct messages, keep the reply concise and conversational. Do not add hashtags unless the user asked for them.",
          constraints: {
            supportsMarkdown: false,
            channelType: ChannelType.DM,
          },
        },
        sendHandler,
      };
      runtime.registerMessageConnector(registration);
      runtime.logger.info(
        { src: "plugin:x", agentId: runtime.agentId },
        "Registered X DM connector",
      );
      return;
    }

    runtime.registerSendHandler("x", sendHandler);
  }

  private registerPostConnector(runtime: IAgentRuntime): void {
    const withPostConnector = runtime as RuntimeWithPostConnector;
    if (typeof withPostConnector.registerPostConnector !== "function") {
      return;
    }

    withPostConnector.registerPostConnector({
      source: "x",
      label: "X",
      description:
        "X/Twitter public feed connector for publishing tweets, reading the home/user feed, and searching recent public posts.",
      capabilities: ["post", "fetch_feed", "search_posts"],
      contexts: ["social", "social_posting", "connectors"],
      metadata: {
        service: XService.serviceType,
      },
      postHandler: this.handleSendPost.bind(this),
      fetchFeed: this.fetchConnectorFeed.bind(this),
      searchPosts: this.searchConnectorPosts.bind(this),
      contentShaping: {
        systemPromptFragment:
          "For X posts, write one public tweet under 280 characters. Preserve the user's requested wording when provided; avoid thread-style numbering unless asked.",
        constraints: {
          maxLength: X_MAX_POST_LENGTH,
          supportsMarkdown: false,
          channelType: ChannelType.FEED,
        },
      },
    });

    runtime.logger.info(
      { src: "plugin:x", agentId: runtime.agentId },
      "Registered X post connector",
    );
  }

  async handleSendMessage(
    _runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ): Promise<void> {
    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      throw new Error("X DM connector requires non-empty text content.");
    }

    const metadata = (target as { metadata?: unknown }).metadata;
    const metadataRecord =
      metadata && typeof metadata === "object"
        ? (metadata as Record<string, unknown>)
        : undefined;
    const accountId = this.resolveAccountId(target, content);
    const client = await this.getTwitterClientForAccount(accountId);
    const recipient = await this.resolveDmRecipient(
      (typeof metadataRecord?.xUserId === "string"
        ? metadataRecord.xUserId
        : undefined) ??
        (typeof metadataRecord?.twitterUserId === "string"
          ? metadataRecord.twitterUserId
          : undefined) ??
        (typeof metadataRecord?.xUsername === "string"
          ? metadataRecord.xUsername
          : undefined) ??
        (typeof metadataRecord?.twitterUsername === "string"
          ? metadataRecord.twitterUsername
          : undefined) ??
        (typeof target.entityId === "string" ? target.entityId : undefined) ??
        target.channelId ??
        target.threadId,
      client.client,
    );

    if (!recipient) {
      throw new Error(
        "X DM connector requires a resolvable recipient user id.",
      );
    }

    await this.sendXDirectMessage(accountId, recipient, text);
  }

  async sendDirectMessageForAccount(
    accountId: string,
    params: { participantId: string; text: string },
  ): Promise<{ ok: true; status: number; messageId: string | null }> {
    const text = params.text.trim();
    if (!text) {
      throw new Error("X DM connector requires non-empty text content.");
    }

    const client = await this.getTwitterClientForAccount(accountId);
    const recipient = await this.resolveDmRecipient(
      params.participantId,
      client.client,
    );
    if (!recipient) {
      throw new Error(
        "X DM connector requires a resolvable recipient user id.",
      );
    }

    const sent = await this.sendXDirectMessage(accountId, recipient, text);
    return {
      ok: true,
      status: 201,
      messageId: sent.messageId,
    };
  }

  async fetchDirectMessagesForAccount(
    accountId: string,
    params: { participantId?: string; limit?: number } = {},
  ): Promise<Memory[]> {
    const runtime = this.runtime;
    if (!runtime) {
      throw new Error("X service runtime is not initialized.");
    }

    const target = params.participantId
      ? ({
          source: "x",
          accountId,
          channelId: params.participantId,
          entityId: params.participantId,
          metadata: { accountId, xUserId: params.participantId },
        } as TargetInfo)
      : undefined;
    return this.fetchConnectorMessages(
      {
        runtime,
        source: "x",
        target,
      } as MessageConnectorQueryContext,
      {
        target,
        limit: params.limit,
      },
    );
  }

  async handleSendPost(
    runtime: IAgentRuntime,
    content: Content,
    context?: PostConnectorQueryContext,
  ): Promise<Memory> {
    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      throw new Error("X post connector requires non-empty text content.");
    }
    if (text.length > X_MAX_POST_LENGTH) {
      throw new Error(
        `X post connector requires text <= ${X_MAX_POST_LENGTH} characters; received ${text.length}.`,
      );
    }

    const accountId = this.resolveAccountId(
      context?.target,
      context?.metadata,
      content,
    );
    const base = (await this.getTwitterClientForAccount(accountId)).client;

    const replyToTweetId = readContentString(content, [
      "replyToTweetId",
      "replyTo",
      "inReplyToTweetId",
    ]);
    const postService = new TwitterPostService(base);
    const post = await postService.createPost({
      agentId: runtime.agentId,
      roomId: createUniqueUuid(
        runtime,
        `x:${accountId}:feed:${base.profile?.id ?? runtime.agentId}`,
      ),
      text,
      ...(replyToTweetId ? { inReplyTo: replyToTweetId } : {}),
    });

    return this.buildXPostMemory(runtime, {
      id: post.id,
      userId: post.userId || runtime.agentId,
      username: post.username || base.profile?.username || "agent",
      text: post.text,
      timestamp: post.timestamp,
      inReplyTo: post.inReplyTo,
      roomId: post.roomId,
      metadata: post.metadata,
      metrics: post.metrics,
      accountId,
    });
  }

  async createPostForAccount(
    accountId: string,
    params: { text: string; replyToTweetId?: string },
  ): Promise<Memory> {
    const runtime = this.runtime;
    if (!runtime) {
      throw new Error("X service runtime is not initialized.");
    }
    return this.handleSendPost(
      runtime,
      {
        text: params.text,
        ...(params.replyToTweetId
          ? { replyToTweetId: params.replyToTweetId }
          : {}),
        metadata: { accountId },
      } as Content,
      {
        runtime,
        source: "x",
        metadata: { accountId },
        target: { source: "x", accountId } as TargetInfo,
      },
    );
  }

  async fetchFeedForAccount(
    accountId: string,
    params: {
      feedType?: string;
      userId?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<Memory[]> {
    const runtime = this.runtime;
    if (!runtime) {
      throw new Error("X service runtime is not initialized.");
    }
    return this.fetchConnectorFeed(
      {
        runtime,
        source: "x",
        metadata: { accountId },
        target: { source: "x", accountId } as TargetInfo,
      },
      {
        feed: params.feedType,
        userId: params.userId,
        limit: params.limit,
        cursor: params.cursor,
      },
    );
  }

  async searchPostsForAccount(
    accountId: string,
    params: { query: string; limit?: number; cursor?: string },
  ): Promise<Memory[]> {
    const runtime = this.runtime;
    if (!runtime) {
      throw new Error("X service runtime is not initialized.");
    }
    return this.searchConnectorPosts(
      {
        runtime,
        source: "x",
        metadata: { accountId },
        target: { source: "x", accountId } as TargetInfo,
      },
      params,
    );
  }

  async sendDirectMessageToConversationForAccount(
    accountId: string,
    params: { conversationId: string; text: string },
  ): Promise<{ ok: true; status: number; messageId: string | null }> {
    const client = await this.getV2DmClient(accountId);
    const sender = client.v2 as typeof client.v2 & {
      sendDmToConversation?: (
        conversationId: string,
        body: { text: string },
      ) => Promise<{ data?: { dm_event_id?: string } }>;
    };
    if (typeof sender.sendDmToConversation !== "function") {
      throw new Error(
        "X v2 client does not expose sendDmToConversation; conversation DM send requires plugin-x DM conversation support.",
      );
    }
    const result = await sender.sendDmToConversation(params.conversationId, {
      text: params.text,
    });
    return {
      ok: true,
      status: 201,
      messageId: result.data?.dm_event_id ?? null,
    };
  }

  async createDirectMessageGroupForAccount(
    _accountId: string,
    _params: { participantIds: string[]; text: string },
  ): Promise<{
    ok: true;
    status: number;
    conversationId: string | null;
    messageId: string | null;
  }> {
    throw new Error("X group DM creation is not exposed by plugin-x yet.");
  }

  async fetchConnectorFeed(
    context: PostConnectorQueryContext,
    params: {
      feed?: string;
      target?: TargetInfo;
      userId?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<Memory[]> {
    const runtime = context.runtime ?? this.runtime;
    const accountId = this.resolveAccountId(
      params.target,
      context.target,
      context.metadata,
    );
    const base = (await this.getTwitterClientForAccount(accountId)).client;

    const limit = clampLimit(params.limit, 20, 100);
    const postService = new TwitterPostService(base);
    const targetUserId =
      params.userId ??
      (typeof params.target?.entityId === "string"
        ? params.target.entityId
        : undefined) ??
      (typeof context.target?.entityId === "string"
        ? context.target.entityId
        : undefined);

    const posts =
      params.feed === "mentions"
        ? await postService.getMentions(runtime.agentId, {
            limit,
            before: params.cursor,
          })
        : await postService.getPosts({
            agentId: runtime.agentId,
            ...(targetUserId ? { userId: targetUserId } : {}),
            limit,
            before: params.cursor,
          });

    return posts.map((post) =>
      this.buildXPostMemory(runtime, {
        id: post.id,
        userId: post.userId,
        username: post.username,
        text: post.text,
        timestamp: post.timestamp,
        inReplyTo: post.inReplyTo,
        roomId: post.roomId,
        metadata: post.metadata,
        metrics: post.metrics,
        accountId,
      }),
    );
  }

  async searchConnectorPosts(
    context: PostConnectorQueryContext,
    params: { query: string; limit?: number; cursor?: string },
  ): Promise<Memory[]> {
    const query = params.query?.trim();
    if (!query) {
      throw new Error("X searchPosts connector requires a query.");
    }

    const runtime = context.runtime ?? this.runtime;
    const accountId = this.resolveAccountId(context.target, context.metadata);
    const base = (await this.getTwitterClientForAccount(accountId)).client;
    const result = await base.fetchSearchTweets(
      query,
      clampLimit(params.limit, 20, 100),
      SearchMode.Latest,
      params.cursor,
    );
    return result.tweets.map((tweet) =>
      this.buildXPostMemory(runtime, {
        id: tweet.id ?? "unknown",
        userId: tweet.userId ?? "unknown",
        username: tweet.username ?? undefined,
        text: tweet.text ?? "",
        timestamp: tweet.timestamp,
        inReplyTo: tweet.inReplyToStatusId,
        metrics: {
          likes: tweet.likes,
          reposts: tweet.retweets,
          replies: tweet.replies,
          quotes: tweet.quotes,
        },
        accountId,
      }),
    );
  }

  async fetchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: {
      target?: TargetInfo;
      limit?: number;
      before?: string;
      after?: string;
    } = {},
  ): Promise<Memory[]> {
    const runtime = context.runtime ?? this.runtime;
    const target = params.target ?? context.target;
    const accountId = this.resolveAccountId(target, context.target, context);
    const targetUserId =
      (typeof target?.entityId === "string" ? target.entityId : undefined) ??
      target?.channelId ??
      target?.threadId;
    const messages = await this.listRecentDirectMessages(
      accountId,
      clampLimit(params.limit, 25, 50),
    ).catch(() => []);

    return messages
      .filter((message) => !targetUserId || message.senderId === targetUserId)
      .map((message) =>
        this.buildXDirectMessageMemory(
          runtime,
          message,
          target ?? undefined,
          accountId,
        ),
      );
  }

  async resolveConnectorTargets(
    query: string,
    _context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    const normalizedQuery = normalizeXConnectorQuery(query);
    const accountId = this.resolveAccountId(_context.target, _context);
    if (!normalizedQuery) {
      return this.listRecentConnectorTargets(_context);
    }

    if (X_USER_ID_PATTERN.test(normalizedQuery)) {
      return [this.buildUserTarget(normalizedQuery, undefined, 1, accountId)];
    }

    const base = (await this.getTwitterClientForAccount(accountId)).client;

    try {
      const profile = await base.fetchProfile(normalizedQuery);
      return [
        this.buildUserTarget(profile.id, profile.username, 0.95, accountId),
      ];
    } catch (error) {
      logger.debug(
        {
          src: "plugin:x",
          query,
          error: error instanceof Error ? error.message : String(error),
        },
        "X connector profile resolution failed",
      );
      return [];
    }
  }

  async listRecentConnectorTargets(
    _context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorTarget[]> {
    const accountId = this.resolveAccountId(_context.target, _context);
    const messages = await this.listRecentDirectMessages(accountId, 25).catch(
      () => [],
    );
    const seen = new Set<string>();
    const targets: MessageConnectorTarget[] = [];
    for (const message of messages) {
      if (!message.senderId || seen.has(message.senderId)) {
        continue;
      }
      seen.add(message.senderId);
      targets.push(
        this.buildUserTarget(
          message.senderId,
          message.senderUsername ?? undefined,
          0.8,
          accountId,
        ),
      );
    }
    return targets;
  }

  async getConnectorUserContext(
    entityId: string,
    _context: MessageConnectorQueryContext,
  ): Promise<MessageConnectorUserContext | null> {
    const accountId = this.resolveAccountId(_context.target, _context);
    const base = (await this.getTwitterClientForAccount(accountId)).client;

    try {
      if (X_USER_ID_PATTERN.test(entityId)) {
        const username =
          await base.twitterClient.getScreenNameByUserId(entityId);
        return {
          entityId,
          label: `@${username}`,
          aliases: [username, entityId],
          handles: { x: username },
          metadata: { xUserId: entityId, accountId },
        };
      }

      const username = normalizeXConnectorQuery(entityId);
      const profile = await base.fetchProfile(username);
      return {
        entityId,
        label: `@${profile.username}`,
        aliases: [profile.username, profile.screenName, profile.id].filter(
          Boolean,
        ),
        handles: { x: profile.username },
        metadata: { xUserId: profile.id, bio: profile.bio, accountId },
      };
    } catch {
      return null;
    }
  }

  private buildUserTarget(
    userId: string,
    username: string | undefined,
    score: number,
    accountId: string = this.defaultAccountId,
  ): MessageConnectorTarget {
    return {
      target: {
        source: "x",
        entityId: userId,
        accountId,
      } as TargetInfo,
      label: username ? `@${username}` : `X user ${userId}`,
      kind: "user",
      description: "X/Twitter direct-message recipient",
      score,
      contexts: [...X_CONNECTOR_CONTEXTS],
      metadata: {
        accountId,
        xUserId: userId,
        ...(username ? { xUsername: username } : {}),
      },
    };
  }

  private async getV2DmClient(accountId?: string): Promise<{
    v2: {
      sendDmToParticipant?: (
        participantId: string,
        body: { text: string },
      ) => Promise<{ data?: { dm_event_id?: string } }>;
      listDmEvents?: (opts: Record<string, unknown>) => AsyncIterable<{
        id?: string;
        sender_id?: string;
        dm_conversation_id?: string;
        recipient_id?: string;
        participant_ids?: string[];
        text?: string;
        created_at?: string;
        event_type?: string;
      }> & {
        includes?: { users?: Array<{ id: string; username?: string }> };
      };
    };
  }> {
    const base = (await this.getTwitterClientForAccount(accountId)).client;
    const auth = (base as { auth?: { getV2Client: () => Promise<unknown> } })
      ?.auth;
    if (!auth) {
      throw new Error("X auth client not initialized");
    }
    return (await auth.getV2Client()) as {
      v2: {
        sendDmToParticipant?: (
          participantId: string,
          body: { text: string },
        ) => Promise<{ data?: { dm_event_id?: string } }>;
        listDmEvents?: (opts: Record<string, unknown>) => AsyncIterable<{
          id?: string;
          sender_id?: string;
          dm_conversation_id?: string;
          recipient_id?: string;
          participant_ids?: string[];
          text?: string;
          created_at?: string;
          event_type?: string;
        }> & {
          includes?: { users?: Array<{ id: string; username?: string }> };
        };
      };
    };
  }

  private async sendXDirectMessage(
    accountId: string,
    recipient: string,
    text: string,
  ): Promise<{ messageId: string | null }> {
    const client = await this.getV2DmClient(accountId);
    if (!client.v2.sendDmToParticipant) {
      throw new Error(
        "X v2 client does not expose sendDmToParticipant; DM send requires DM API scopes.",
      );
    }
    const result = await client.v2.sendDmToParticipant(recipient, { text });
    return { messageId: result.data?.dm_event_id ?? null };
  }

  private async resolveDmRecipient(
    value: string | undefined,
    base?: ClientBase,
  ): Promise<string | null> {
    if (!value) {
      return null;
    }

    const normalized = normalizeXConnectorQuery(value);
    if (!normalized) {
      return null;
    }

    if (X_USER_ID_PATTERN.test(normalized)) {
      return normalized;
    }

    if (!base) {
      return null;
    }

    const profile = await base.fetchProfile(normalized);
    return profile.id;
  }

  private async listRecentDirectMessages(
    accountId: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      conversationId: string;
      senderId: string;
      senderUsername: string | null;
      text: string;
      createdAt: string | null;
      isInbound: boolean;
      participantIds: string[];
    }>
  > {
    const base = (await this.getTwitterClientForAccount(accountId)).client;
    const client = await this.getV2DmClient(accountId);
    const ownUserId = base.profile?.id ?? null;
    const iterator = client.v2.listDmEvents?.({
      max_results: Math.min(Math.max(1, limit), 50),
      "dm_event.fields": [
        "id",
        "created_at",
        "dm_conversation_id",
        "sender_id",
        "text",
        "event_type",
        "participant_ids",
      ],
      "user.fields": ["id", "username"],
      expansions: ["sender_id"],
      event_types: ["MessageCreate"],
    });
    if (!iterator) {
      return [];
    }

    const usernameMap = new Map<string, string>();
    for (const user of iterator.includes?.users ?? []) {
      if (user.id && user.username) {
        usernameMap.set(user.id, user.username);
      }
    }

    const messages: Array<{
      id: string;
      conversationId: string;
      senderId: string;
      senderUsername: string | null;
      text: string;
      createdAt: string | null;
      isInbound: boolean;
      participantIds: string[];
    }> = [];
    for await (const event of iterator) {
      if (event.event_type && event.event_type !== "MessageCreate") {
        continue;
      }
      messages.push({
        id: event.id ?? "",
        conversationId: event.dm_conversation_id ?? event.id ?? "",
        senderId: event.sender_id ?? "",
        senderUsername: event.sender_id
          ? (usernameMap.get(event.sender_id) ?? null)
          : null,
        text: event.text ?? "",
        createdAt: event.created_at ?? null,
        isInbound:
          ownUserId && event.sender_id ? event.sender_id !== ownUserId : true,
        participantIds: Array.isArray(event.participant_ids)
          ? event.participant_ids
          : [],
      });
      if (messages.length >= limit) {
        break;
      }
    }
    return messages;
  }

  private buildXPostMemory(
    runtime: IAgentRuntime,
    post: {
      id: string;
      userId?: string;
      username?: string;
      text: string;
      timestamp?: number;
      inReplyTo?: string;
      roomId?: UUID;
      metrics?: unknown;
      metadata?: Record<string, unknown>;
      accountId?: string;
    },
  ): Memory {
    const accountId = normalizeXAccountId(
      post.accountId ?? this.defaultAccountId,
    );
    const authorId = post.userId || "unknown";
    const createdAt = Number.isFinite(post.timestamp)
      ? post.timestamp
      : Date.now();
    const entityId =
      authorId === runtime.agentId
        ? runtime.agentId
        : createUniqueUuid(runtime, `x:user:${authorId}`);
    const roomId =
      post.roomId ??
      createUniqueUuid(runtime, `x:${accountId}:feed:${authorId}`);
    const url = post.username
      ? `https://x.com/${post.username}/status/${post.id}`
      : `https://x.com/i/web/status/${post.id}`;

    return {
      id: createUniqueUuid(runtime, `x:post:${post.id}`),
      agentId: runtime.agentId,
      entityId,
      roomId,
      createdAt,
      content: {
        text: post.text,
        source: "x",
        url,
        channelType: ChannelType.FEED,
        ...(post.inReplyTo
          ? { inReplyTo: createUniqueUuid(runtime, `x:post:${post.inReplyTo}`) }
          : {}),
      },
      metadata: {
        type: "message",
        source: "x",
        accountId,
        provider: "x",
        timestamp: createdAt,
        fromBot: entityId === runtime.agentId,
        messageIdFull: post.id,
        chatType: ChannelType.FEED,
        sender: {
          id: authorId,
          username: post.username,
        },
        x: {
          accountId,
          tweetId: post.id,
          userId: authorId,
          username: post.username,
          inReplyTo: post.inReplyTo,
          metrics: post.metrics,
          ...(post.metadata ?? {}),
        },
      } satisfies Memory["metadata"],
    };
  }

  private buildXDirectMessageMemory(
    runtime: IAgentRuntime,
    message: {
      id: string;
      conversationId?: string;
      senderId: string;
      senderUsername: string | null;
      text: string;
      createdAt: string | null;
      isInbound?: boolean;
      participantIds?: string[];
    },
    target?: TargetInfo,
    accountId: string = this.defaultAccountId,
  ): Memory {
    const normalizedAccountId = normalizeXAccountId(accountId);
    const senderId = message.senderId || "unknown";
    const createdAt = message.createdAt
      ? Date.parse(message.createdAt)
      : Date.now();
    const roomId =
      target?.roomId ??
      createUniqueUuid(runtime, `x:${normalizedAccountId}:dm:${senderId}`);
    const entityId =
      senderId === runtime.agentId
        ? runtime.agentId
        : createUniqueUuid(runtime, `x:user:${senderId}`);

    return {
      id: createUniqueUuid(runtime, `x:dm:${message.id}`),
      agentId: runtime.agentId,
      entityId,
      roomId,
      createdAt,
      content: {
        text: message.text,
        source: "x",
        channelType: ChannelType.DM,
      },
      metadata: {
        type: "message",
        source: "x",
        accountId: normalizedAccountId,
        provider: "x",
        timestamp: createdAt,
        fromBot: entityId === runtime.agentId,
        messageIdFull: message.id,
        chatType: ChannelType.DM,
        sender: {
          id: senderId,
          username: message.senderUsername ?? undefined,
        },
        x: {
          accountId: normalizedAccountId,
          dmEventId: message.id,
          conversationId: message.conversationId,
          senderId,
          senderUsername: message.senderUsername,
          isInbound: message.isInbound ?? true,
          participantIds: message.participantIds ?? [],
        },
      } satisfies Memory["metadata"],
    };
  }

  async stop(): Promise<void> {
    for (const client of this.accountClients.values()) {
      if (client.post) {
        await client.post.stop();
      }

      if (client.interaction) {
        await client.interaction.stop();
      }

      if (client.timeline) {
        await client.timeline.stop();
      }

      if (client.discovery) {
        await client.discovery.stop();
      }
    }

    logger.log("X service stopped");
  }
}
