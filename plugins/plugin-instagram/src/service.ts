import {
  ChannelType,
  type Content,
  createUniqueUuid,
  type Entity,
  type IAgentRuntime,
  type Memory,
  type MessageConnectorChatContext,
  type MessageConnectorQueryContext,
  type MessageConnectorTarget,
  type MessageConnectorUserContext,
  Service,
  stringToUuid,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import {
  DEFAULT_INSTAGRAM_ACCOUNT_ID,
  listInstagramAccountIds,
  normalizeInstagramAccountId,
  readInstagramAccountId,
  resolveDefaultInstagramAccountId,
  resolveInstagramAccountConfig,
} from "./accounts";
import { INSTAGRAM_SERVICE_NAME, MAX_COMMENT_LENGTH, MAX_DM_LENGTH } from "./constants";
import type {
  InstagramConfig,
  InstagramMedia,
  InstagramMessage,
  InstagramThread,
  InstagramUser,
} from "./types";

const INSTAGRAM_CONNECTOR_CONTEXTS = ["social", "connectors"];
const INSTAGRAM_CONNECTOR_CAPABILITIES = [
  "send_message",
  "resolve_targets",
  "list_rooms",
  "chat_context",
  "user_context",
];
const INSTAGRAM_POST_CONNECTOR_CONTEXTS = ["social_posting", "connectors"];

type InstagramConnectorReadParams = {
  target?: TargetInfo;
  limit?: number;
  query?: string;
};

type AdditiveMessageConnectorHooks = {
  fetchMessages?: (
    context: MessageConnectorQueryContext,
    params?: InstagramConnectorReadParams
  ) => Promise<Memory[]>;
  searchMessages?: (
    context: MessageConnectorQueryContext,
    params: InstagramConnectorReadParams & { query: string }
  ) => Promise<Memory[]>;
  getUser?: (
    runtime: IAgentRuntime,
    params: { entityId?: UUID | string; userId?: string; username?: string; handle?: string }
  ) => Promise<Entity | null>;
};

type ExtendedMessageConnectorRegistration = Parameters<
  IAgentRuntime["registerMessageConnector"]
>[0] &
  AdditiveMessageConnectorHooks;

function normalizeInstagramQuery(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function normalizeConnectorLimit(limit: number | undefined, fallback = 50): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(limit), 200);
}

function filterMemoriesByQuery(memories: Memory[], query: string, limit: number): Memory[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return memories.slice(0, limit);
  }
  return memories
    .filter((memory) => {
      const text = typeof memory.content?.text === "string" ? memory.content.text : "";
      return text.toLowerCase().includes(normalized);
    })
    .slice(0, limit);
}

function scoreInstagramMatch(
  query: string,
  id: string,
  labels: Array<string | null | undefined>
): number {
  if (!query) {
    return 0.45;
  }
  if (id.toLowerCase() === query) {
    return 1;
  }

  let bestScore = 0;
  for (const label of labels) {
    const normalized = label?.trim().replace(/^@/, "").toLowerCase();
    if (!normalized) {
      continue;
    }
    if (normalized === query) {
      bestScore = Math.max(bestScore, 0.95);
    } else if (normalized.startsWith(query)) {
      bestScore = Math.max(bestScore, 0.85);
    } else if (normalized.includes(query)) {
      bestScore = Math.max(bestScore, 0.7);
    }
  }
  return bestScore;
}

function getInstagramTargetMetadata(target: TargetInfo): Record<string, unknown> | undefined {
  const metadata = (target as { metadata?: unknown }).metadata;
  return metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>)
    : undefined;
}

function truncateInstagramComment(text: string): string {
  return text.length > MAX_COMMENT_LENGTH ? `${text.slice(0, MAX_COMMENT_LENGTH - 3)}...` : text;
}

function getInstagramPostMetadata(content: Content): Record<string, unknown> {
  const metadata = content.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

function normalizeInstagramMediaId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Instagram Service for elizaOS
 *
 * Provides Instagram integration including DMs, comments, and posts.
 */
export class InstagramService extends Service {
  static serviceType = INSTAGRAM_SERVICE_NAME;

  capabilityDescription = "Instagram messaging and social media integration";

  private instagramConfig: InstagramConfig | null = null;
  private isRunning = false;
  private loggedInUser: InstagramUser | null = null;
  private accountServices = new Map<string, InstagramService>();
  private defaultAccountId = DEFAULT_INSTAGRAM_ACCOUNT_ID;

  /**
   * Static factory method to create and start the service
   */
  static override async start(runtime: IAgentRuntime): Promise<InstagramService> {
    const service = new InstagramService(runtime);
    service.defaultAccountId = resolveDefaultInstagramAccountId(runtime);
    const accountIds = listInstagramAccountIds(runtime);
    for (const accountId of accountIds) {
      const normalizedAccountId = normalizeInstagramAccountId(accountId);
      const accountService =
        normalizedAccountId === service.defaultAccountId ? service : new InstagramService(runtime);
      accountService.defaultAccountId = normalizedAccountId;
      await accountService.initialize(normalizedAccountId);
      if (!accountService.validateConfig()) {
        continue;
      }
      await accountService.startService();
      service.accountServices.set(normalizedAccountId, accountService);
      InstagramService.registerSendHandlers(runtime, service, normalizedAccountId);
    }
    if (service.accountServices.size === 0) {
      await service.initialize(service.defaultAccountId);
    }
    return service;
  }

  static registerSendHandlers(
    runtime: IAgentRuntime,
    serviceInstance: InstagramService,
    requestedAccountId = serviceInstance.getAccountId(runtime)
  ): void {
    if (!serviceInstance) {
      return;
    }

    const accountId = normalizeInstagramAccountId(requestedAccountId);
    const accountService = serviceInstance.getAccountService(accountId);
    const sendHandler = async (
      handlerRuntime: IAgentRuntime,
      target: TargetInfo,
      content: Content
    ): Promise<Memory | undefined> => {
      await accountService.handleSendMessage(handlerRuntime, target, content);
      return undefined;
    };
    if (typeof runtime.registerMessageConnector === "function") {
      const registration = {
        source: "instagram",
        accountId,
        label: "Instagram",
        description: "Instagram DM connector for sending private messages to existing DM threads.",
        capabilities: [...INSTAGRAM_CONNECTOR_CAPABILITIES],
        supportedTargetKinds: ["thread"],
        contexts: [...INSTAGRAM_CONNECTOR_CONTEXTS],
        metadata: {
          accountId,
          service: INSTAGRAM_SERVICE_NAME,
          maxMessageLength: MAX_DM_LENGTH,
        },
        resolveTargets: serviceInstance.resolveConnectorTargets.bind(serviceInstance),
        listRecentTargets: serviceInstance.listRecentConnectorTargets.bind(serviceInstance),
        listRooms: serviceInstance.listConnectorRooms.bind(serviceInstance),
        fetchMessages: serviceInstance.fetchConnectorMessages.bind(serviceInstance),
        searchMessages: serviceInstance.searchConnectorMessages.bind(serviceInstance),
        getChatContext: serviceInstance.getConnectorChatContext.bind(serviceInstance),
        getUserContext: serviceInstance.getConnectorUserContext.bind(serviceInstance),
        getUser: async (handlerRuntime, params) => {
          if (params.username || params.handle) {
            const user = await accountService
              .getUserByUsername(String(params.username ?? params.handle))
              .catch(() => null);
            if (!user) {
              return null;
            }
            return {
              id: createUniqueUuid(handlerRuntime, `instagram:user:${user.pk}`) as UUID,
              names: [user.fullName, user.username].filter((value): value is string =>
                Boolean(value)
              ),
              agentId: handlerRuntime.agentId,
              metadata: {
                accountId,
                instagramUserId: user.pk,
                username: user.username,
                isPrivate: user.isPrivate,
                isVerified: user.isVerified,
              },
            } satisfies Entity;
          }
          const lookupParams = params as { entityId?: UUID | string; userId?: UUID | string };
          const entityId = String(lookupParams.entityId ?? lookupParams.userId ?? "").trim();
          if (!entityId) {
            return null;
          }
          const entity =
            typeof handlerRuntime.getEntityById === "function"
              ? await handlerRuntime.getEntityById(entityId as UUID).catch(() => null)
              : null;
          if (entity) {
            return entity;
          }
          const context = await accountService.getConnectorUserContext(entityId, {
            runtime: handlerRuntime,
          });
          return context
            ? ({
                id: createUniqueUuid(handlerRuntime, `instagram:user:${entityId}`) as UUID,
                names: context.aliases?.length ? context.aliases : [context.label ?? entityId],
                agentId: handlerRuntime.agentId,
                metadata: { accountId, ...context.metadata },
              } satisfies Entity)
            : null;
        },
        sendHandler,
      } as ExtendedMessageConnectorRegistration;
      runtime.registerMessageConnector(registration);
      if (typeof runtime.registerPostConnector === "function") {
        runtime.registerPostConnector({
          source: "instagram",
          accountId,
          label: "Instagram",
          description:
            "Instagram public comment connector. Use POST operation=send with mediaId, target, or replyTo to comment on media.",
          capabilities: ["post", "comment"],
          contexts: [...INSTAGRAM_POST_CONNECTOR_CONTEXTS],
          metadata: {
            accountId,
            service: INSTAGRAM_SERVICE_NAME,
            maxMessageLength: MAX_COMMENT_LENGTH,
            requiresMediaTarget: true,
          },
          postHandler: accountService.handleSendPost.bind(accountService),
          contentShaping: {
            constraints: {
              maxLength: MAX_COMMENT_LENGTH,
              supportsMarkdown: false,
            },
            postProcess: truncateInstagramComment,
          },
        });
      }
      runtime.logger.info(
        { src: "plugin:instagram", agentId: runtime.agentId },
        "Registered Instagram DM and comment connectors"
      );
      return;
    }

    runtime.registerSendHandler("instagram", sendHandler);
  }

  /**
   * Initialize the service
   */
  async initialize(accountId?: string): Promise<void> {
    this.defaultAccountId = normalizeInstagramAccountId(accountId ?? this.defaultAccountId);
    this.instagramConfig = resolveInstagramAccountConfig(this.runtime, this.defaultAccountId);

    if (!this.instagramConfig.username || !this.instagramConfig.password) {
      console.warn("Instagram credentials not configured. Service will not be available.");
      return;
    }

    console.log(`Instagram service initialized for @${this.instagramConfig.username}`);
  }

  /**
   * Start the Instagram service
   */
  async startService(): Promise<void> {
    if (!this.instagramConfig) {
      throw new Error("Instagram service not initialized. Call initialize() first.");
    }

    if (this.isRunning) {
      throw new Error("Instagram service is already running");
    }

    console.log("Starting Instagram service...");

    // Login would happen here in a real implementation
    // For now, we simulate the logged-in user
    this.loggedInUser = {
      pk: 0,
      username: this.instagramConfig.username,
      isPrivate: false,
      isVerified: false,
    };

    this.isRunning = true;
    console.log(`Instagram service started for @${this.instagramConfig.username}`);
  }

  /**
   * Stop the Instagram service
   */
  override async stop(): Promise<void> {
    console.log("Stopping Instagram service...");
    for (const [accountId, accountService] of this.accountServices) {
      if (accountService === this) {
        continue;
      }
      await accountService.stop();
      this.accountServices.delete(accountId);
    }
    this.isRunning = false;
    this.loggedInUser = null;
    console.log("Instagram service stopped");
  }

  /**
   * Check if service is running
   */
  getIsRunning(): boolean {
    return (
      this.isRunning ||
      Array.from(this.accountServices.values()).some((service) => service.getIsRunning())
    );
  }

  /**
   * Get the logged-in user
   */
  getLoggedInUser(): InstagramUser | null {
    return this.loggedInUser ?? this.getAccountService()?.loggedInUser ?? null;
  }

  getAccountId(runtime?: IAgentRuntime): string {
    return normalizeInstagramAccountId(
      this.instagramConfig?.accountId ??
        (this.defaultAccountId !== DEFAULT_INSTAGRAM_ACCOUNT_ID
          ? this.defaultAccountId
          : runtime
            ? resolveDefaultInstagramAccountId(runtime)
            : undefined)
    );
  }

  private getAccountService(accountId = this.defaultAccountId): InstagramService {
    const normalized = normalizeInstagramAccountId(accountId);
    const services = this.accountServices ?? new Map<string, InstagramService>();
    return (
      services.get(normalized) ?? (normalized === this.getAccountId() ? this : undefined) ?? this
    );
  }

  /**
   * Send a direct message
   */
  async sendDirectMessage(threadId: string, text: string): Promise<string> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    if (text.length > MAX_DM_LENGTH) {
      throw new Error(`Message too long: ${text.length} characters (max: ${MAX_DM_LENGTH})`);
    }

    // In a real implementation, this would use the Instagram API
    console.log(`Sending DM to thread ${threadId}: ${text.substring(0, 50)}...`);

    // Simulate message ID
    const messageId = `msg_${Date.now()}`;

    return messageId;
  }

  /**
   * Reply to a message in a thread
   */
  async replyToMessage(threadId: string, _messageId: string, text: string): Promise<string> {
    // Instagram DMs don't have a native "reply to specific message" like Telegram
    // Just send a new message to the thread
    return this.sendDirectMessage(threadId, text);
  }

  /**
   * Post a comment on media
   */
  async postComment(mediaId: number, text: string): Promise<number> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    console.log(`Posting comment on media ${mediaId}: ${text.substring(0, 50)}...`);

    // Simulate comment ID
    const commentId = Date.now();

    return commentId;
  }

  async handleSendPost(runtime: IAgentRuntime, content: Content): Promise<Memory> {
    const requestedAccountId = readInstagramAccountId(content);
    const accountService = requestedAccountId ? this.getAccountService(requestedAccountId) : this;
    if (accountService !== this) {
      return accountService.handleSendPost(runtime, content);
    }
    const text = truncateInstagramComment(
      typeof content.text === "string" ? content.text.trim() : ""
    );
    if (!text) {
      throw new Error("Instagram POST operation=send requires non-empty text.");
    }

    const metadata = getInstagramPostMetadata(content);
    const mediaId =
      normalizeInstagramMediaId(metadata.mediaId) ??
      normalizeInstagramMediaId(metadata.target) ??
      normalizeInstagramMediaId(metadata.replyTo) ??
      normalizeInstagramMediaId((content as Record<string, unknown>).mediaId);
    if (!mediaId) {
      throw new Error("Instagram POST operation=send requires mediaId, target, or replyTo.");
    }

    const commentId = await this.postComment(mediaId, text);
    const roomId = stringToUuid(`${runtime.agentId}:instagram:feed-room`) as UUID;
    const worldId = stringToUuid(`${runtime.agentId}:instagram:feed-world`) as UUID;
    return {
      id: createUniqueUuid(
        runtime,
        `instagram:comment:${this.getAccountId(runtime)}:${commentId}`
      ) as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId,
      worldId,
      content: {
        text,
        source: INSTAGRAM_SERVICE_NAME,
        channelType: ChannelType.FEED,
        metadata: {
          ...metadata,
          accountId: this.getAccountId(runtime),
          instagramMediaId: mediaId,
          instagramCommentId: commentId,
        },
      },
      metadata: {
        type: "message",
        source: INSTAGRAM_SERVICE_NAME,
        provider: INSTAGRAM_SERVICE_NAME,
        accountId: this.getAccountId(runtime),
        messageIdFull: `instagram:comment:${commentId}`,
        instagram: {
          mediaId,
          commentId,
        },
      },
      createdAt: Date.now(),
    } as Memory;
  }

  /**
   * Reply to a comment
   */
  async replyToComment(mediaId: number, _commentId: number, text: string): Promise<number> {
    // In a real implementation, this would tag the user and reply
    return this.postComment(mediaId, text);
  }

  /**
   * Like media
   */
  async likeMedia(mediaId: number): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    console.log(`Liking media ${mediaId}`);
  }

  /**
   * Unlike media
   */
  async unlikeMedia(mediaId: number): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    console.log(`Unliking media ${mediaId}`);
  }

  /**
   * Follow a user
   */
  async followUser(userId: number): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    console.log(`Following user ${userId}`);
  }

  /**
   * Unfollow a user
   */
  async unfollowUser(userId: number): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    console.log(`Unfollowing user ${userId}`);
  }

  /**
   * Get user info
   */
  async getUserInfo(userId: number): Promise<InstagramUser> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    // In a real implementation, this would fetch from Instagram API
    return {
      pk: userId,
      username: `user_${userId}`,
      isPrivate: false,
      isVerified: false,
    };
  }

  /**
   * Get user by username
   */
  async getUserByUsername(username: string): Promise<InstagramUser> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    // In a real implementation, this would fetch from Instagram API
    return {
      pk: 0,
      username,
      isPrivate: false,
      isVerified: false,
    };
  }

  /**
   * Get DM threads
   */
  async getThreads(): Promise<InstagramThread[]> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    // In a real implementation, this would fetch from Instagram API
    return [];
  }

  /**
   * Get messages in a thread
   */
  async getThreadMessages(_threadId: string): Promise<InstagramMessage[]> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    // In a real implementation, this would fetch from Instagram API
    return [];
  }

  async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content
  ): Promise<void> {
    const requestedAccountId = normalizeInstagramAccountId(
      target.accountId ?? readInstagramAccountId(content, target) ?? this.getAccountId()
    );
    const accountService = this.getAccountService(requestedAccountId);
    if (accountService !== this) {
      return accountService.handleSendMessage(runtime, target, content);
    }
    if (requestedAccountId !== this.getAccountId()) {
      throw new Error(
        `Instagram account '${requestedAccountId}' is not available in this service instance`
      );
    }

    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      throw new Error("Instagram DM connector requires non-empty text content.");
    }

    let threadId = target.threadId ?? target.channelId;
    const metadata = getInstagramTargetMetadata(target);
    threadId =
      threadId ??
      (typeof metadata?.instagramThreadId === "string" ? metadata.instagramThreadId : undefined);

    if (!threadId && target.roomId) {
      const room = await runtime.getRoom(target.roomId);
      const roomMetadata = room?.metadata as Record<string, unknown> | undefined;
      threadId =
        room?.channelId ??
        (typeof roomMetadata?.instagramThreadId === "string"
          ? roomMetadata.instagramThreadId
          : undefined);
    }

    if (!threadId) {
      throw new Error("Instagram DM connector requires a thread/channel target.");
    }

    await this.sendDirectMessage(threadId, text);
  }

  async resolveConnectorTargets(
    query: string,
    _context: MessageConnectorQueryContext
  ): Promise<MessageConnectorTarget[]> {
    const normalizedQuery = normalizeInstagramQuery(query);
    const threads = await this.getThreads();
    return threads
      .map((thread) => {
        const score = scoreInstagramMatch(normalizedQuery, thread.id, [
          thread.threadTitle,
          ...thread.users.flatMap((user) => [user.username, user.fullName]),
        ]);
        return score > 0 ? this.buildThreadTarget(thread, score) : null;
      })
      .filter((target): target is MessageConnectorTarget => Boolean(target))
      .slice(0, 25);
  }

  async listConnectorRooms(
    _context: MessageConnectorQueryContext
  ): Promise<MessageConnectorTarget[]> {
    const threads = await this.getThreads();
    return threads.map((thread) => this.buildThreadTarget(thread, 0.5)).slice(0, 50);
  }

  async listRecentConnectorTargets(
    context: MessageConnectorQueryContext
  ): Promise<MessageConnectorTarget[]> {
    const targets: MessageConnectorTarget[] = [];
    if (context.target?.channelId || context.target?.threadId) {
      targets.push({
        target: {
          source: "instagram",
          accountId: this.getAccountId(),
          channelId: context.target.channelId ?? context.target.threadId,
          threadId: context.target.threadId ?? context.target.channelId,
        } as TargetInfo,
        kind: "thread",
        label: `Instagram thread ${context.target.channelId ?? context.target.threadId}`,
        score: 0.95,
        contexts: [...INSTAGRAM_CONNECTOR_CONTEXTS],
        metadata: {
          accountId: this.getAccountId(),
          instagramThreadId: context.target.channelId ?? context.target.threadId,
        },
      });
    }
    targets.push(...(await this.listConnectorRooms(context)));
    return targets.slice(0, 25);
  }

  async fetchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: InstagramConnectorReadParams = {}
  ): Promise<Memory[]> {
    const limit = normalizeConnectorLimit(params.limit);
    const target = params.target ?? context.target;
    let threadId = target?.threadId ?? target?.channelId;
    if (!threadId && target?.roomId) {
      const room = await context.runtime.getRoom(target.roomId);
      threadId = room?.channelId;
    }

    if (!threadId) {
      const targets = (await this.listRecentConnectorTargets(context)).slice(0, 10);
      const roomIds = Array.from(
        new Set(
          targets
            .map((candidate) => candidate.target.roomId)
            .filter((roomId): roomId is UUID => Boolean(roomId))
        )
      );
      const chunks = await Promise.all(
        roomIds.map((roomId) =>
          context.runtime.getMemories({
            tableName: "messages",
            roomId,
            limit,
            orderBy: "createdAt",
            orderDirection: "desc",
          })
        )
      );
      return chunks
        .flat()
        .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
        .slice(0, limit);
    }

    const platformMessages = await this.getThreadMessages(threadId).catch(() => []);
    if (platformMessages.length > 0) {
      const roomId =
        target?.roomId ??
        (createUniqueUuid(context.runtime, `instagram:thread:${threadId}`) as UUID);
      return platformMessages
        .map((message) => this.instagramMessageToMemory(context.runtime, message, roomId))
        .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
        .slice(0, limit);
    }

    if (target?.roomId) {
      return context.runtime.getMemories({
        tableName: "messages",
        roomId: target.roomId,
        limit,
        orderBy: "createdAt",
        orderDirection: "desc",
      });
    }

    return [];
  }

  async searchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: InstagramConnectorReadParams & { query: string }
  ): Promise<Memory[]> {
    const limit = normalizeConnectorLimit(params.limit);
    const messages = await this.fetchConnectorMessages(context, {
      target: params.target ?? context.target,
      limit: Math.max(limit, 100),
    });
    return filterMemoriesByQuery(messages, params.query, limit);
  }

  async getConnectorChatContext(
    target: TargetInfo,
    context: MessageConnectorQueryContext
  ): Promise<MessageConnectorChatContext | null> {
    let threadId = target.threadId ?? target.channelId;
    if (!threadId && target.roomId) {
      const room = await context.runtime.getRoom(target.roomId);
      threadId = room?.channelId;
    }
    if (!threadId) {
      return null;
    }

    const messages = await this.getThreadMessages(threadId);
    return {
      target: {
        source: "instagram",
        accountId: this.getAccountId(),
        channelId: threadId,
        threadId,
      } as TargetInfo,
      label: `Instagram thread ${threadId}`,
      recentMessages: messages.slice(-20).map((message) => ({
        name: message.user.username,
        text: message.text ?? "",
        timestamp: message.timestamp.getTime(),
        metadata: {
          instagramMessageId: message.id,
          instagramUserId: message.user.pk,
          accountId: this.getAccountId(),
        },
      })),
      metadata: {
        accountId: this.getAccountId(),
        instagramThreadId: threadId,
      },
    };
  }

  async getConnectorUserContext(
    entityId: string,
    _context: MessageConnectorQueryContext
  ): Promise<MessageConnectorUserContext | null> {
    const numericId = Number.parseInt(entityId, 10);
    if (!Number.isFinite(numericId)) {
      return null;
    }
    const user = await this.getUserInfo(numericId);
    return {
      entityId,
      label: user.fullName || `@${user.username}`,
      aliases: [user.username, user.fullName].filter((value): value is string => Boolean(value)),
      handles: {
        instagram: user.username,
      },
      metadata: {
        accountId: this.getAccountId(),
        instagramUserId: user.pk,
        isPrivate: user.isPrivate,
        isVerified: user.isVerified,
      },
    };
  }

  private buildThreadTarget(thread: InstagramThread, score: number): MessageConnectorTarget {
    const label =
      thread.threadTitle ||
      thread.users.map((user) => `@${user.username}`).join(", ") ||
      `Instagram thread ${thread.id}`;
    return {
      target: {
        source: "instagram",
        accountId: this.getAccountId(),
        channelId: thread.id,
        threadId: thread.id,
      } as TargetInfo,
      label,
      kind: "thread",
      description: thread.isGroup ? "Instagram group DM thread" : "Instagram DM thread",
      score,
      contexts: [...INSTAGRAM_CONNECTOR_CONTEXTS],
      metadata: {
        accountId: this.getAccountId(),
        instagramThreadId: thread.id,
        isGroup: thread.isGroup,
        users: thread.users.map((user) => ({
          id: user.pk,
          username: user.username,
          fullName: user.fullName,
        })),
      },
    };
  }

  private instagramMessageToMemory(
    runtime: IAgentRuntime,
    message: InstagramMessage,
    roomId: UUID
  ): Memory {
    const entityId = createUniqueUuid(runtime, `instagram:user:${message.user.pk}`) as UUID;
    return {
      id: createUniqueUuid(runtime, `instagram:message:${message.id}`) as UUID,
      entityId,
      agentId: runtime.agentId,
      roomId,
      createdAt: message.timestamp.getTime(),
      content: {
        text: message.text ?? "",
        source: "instagram",
        channelType: ChannelType.DM,
        ...(message.media?.url
          ? {
              attachments: [
                {
                  id: String(message.media.pk),
                  url: message.media.url,
                  title: message.media.caption,
                  source: "instagram",
                  description: message.media.mediaType,
                },
              ],
            }
          : {}),
      },
      metadata: {
        type: "message",
        source: "instagram",
        accountId: this.getAccountId(runtime),
        provider: "instagram",
        timestamp: message.timestamp.getTime(),
        entityName: message.user.fullName ?? message.user.username,
        entityUserName: message.user.username,
        fromId: String(message.user.pk),
        sourceId: entityId,
        chatType: ChannelType.DM,
        messageIdFull: message.id,
        sender: {
          id: String(message.user.pk),
          name: message.user.fullName ?? message.user.username,
          username: message.user.username,
        },
        instagram: {
          accountId: this.getAccountId(runtime),
          messageId: message.id,
          threadId: message.threadId,
          userId: message.user.pk,
          username: message.user.username,
          isSeen: message.isSeen,
        },
      },
    } as Memory;
  }

  /**
   * Get user's media
   */
  async getUserMedia(_userId: number): Promise<InstagramMedia[]> {
    if (!this.isRunning) {
      throw new Error("Instagram service is not running");
    }

    // In a real implementation, this would fetch from Instagram API
    return [];
  }

  /**
   * Validate configuration
   */
  validateConfig(): boolean {
    if (!this.instagramConfig) {
      return false;
    }

    return !!(this.instagramConfig.username && this.instagramConfig.password);
  }
}

/**
 * Split a message into chunks
 */
export function splitMessage(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) {
    return [content];
  }

  const parts: string[] = [];
  let current = "";

  for (const line of content.split("\n")) {
    const lineWithNewline = current ? `\n${line}` : line;

    if (current.length + lineWithNewline.length > maxLength) {
      if (current) {
        parts.push(current);
        current = "";
      }

      if (line.length > maxLength) {
        // Split by words
        const words = line.split(/\s+/);
        for (const word of words) {
          const wordWithSpace = current ? ` ${word}` : word;

          if (current.length + wordWithSpace.length > maxLength) {
            if (current) {
              parts.push(current);
              current = "";
            }

            if (word.length > maxLength) {
              // Split by characters
              for (let i = 0; i < word.length; i += maxLength) {
                parts.push(word.slice(i, i + maxLength));
              }
            } else {
              current = word;
            }
          } else {
            current += wordWithSpace;
          }
        }
      } else {
        current = line;
      }
    } else {
      current += lineWithNewline;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}
