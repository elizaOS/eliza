import {
  type Content,
  type IAgentRuntime,
  type MessageConnectorChatContext,
  type MessageConnectorQueryContext,
  type MessageConnectorTarget,
  type MessageConnectorUserContext,
  Service,
  type TargetInfo,
} from "@elizaos/core";
import { INSTAGRAM_SERVICE_NAME, MAX_DM_LENGTH } from "./constants";
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

function normalizeInstagramQuery(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
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

  /**
   * Static factory method to create and start the service
   */
  static override async start(runtime: IAgentRuntime): Promise<InstagramService> {
    const service = new InstagramService(runtime);
    await service.initialize();
    await service.startService();
    return service;
  }

  static registerSendHandlers(runtime: IAgentRuntime, serviceInstance: InstagramService): void {
    if (!serviceInstance) {
      return;
    }

    const sendHandler = serviceInstance.handleSendMessage.bind(serviceInstance);
    if (typeof runtime.registerMessageConnector === "function") {
      runtime.registerMessageConnector({
        source: "instagram",
        label: "Instagram",
        description: "Instagram DM connector for sending private messages to existing DM threads.",
        capabilities: [...INSTAGRAM_CONNECTOR_CAPABILITIES],
        supportedTargetKinds: ["thread"],
        contexts: [...INSTAGRAM_CONNECTOR_CONTEXTS],
        metadata: {
          service: INSTAGRAM_SERVICE_NAME,
          maxMessageLength: MAX_DM_LENGTH,
        },
        resolveTargets: serviceInstance.resolveConnectorTargets.bind(serviceInstance),
        listRecentTargets: serviceInstance.listRecentConnectorTargets.bind(serviceInstance),
        listRooms: serviceInstance.listConnectorRooms.bind(serviceInstance),
        getChatContext: serviceInstance.getConnectorChatContext.bind(serviceInstance),
        getUserContext: serviceInstance.getConnectorUserContext.bind(serviceInstance),
        sendHandler,
      });
      runtime.logger.info(
        { src: "plugin:instagram", agentId: runtime.agentId },
        "Registered Instagram DM connector"
      );
      return;
    }

    runtime.registerSendHandler("instagram", sendHandler);
  }

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    // Load config from runtime settings
    const username = this.runtime.getSetting("INSTAGRAM_USERNAME");
    const password = this.runtime.getSetting("INSTAGRAM_PASSWORD");

    if (!username || !password) {
      console.warn("Instagram credentials not configured. Service will not be available.");
      return;
    }

    const verificationCode = this.runtime.getSetting("INSTAGRAM_VERIFICATION_CODE");
    const proxy = this.runtime.getSetting("INSTAGRAM_PROXY");
    const pollingIntervalStr = this.runtime.getSetting("INSTAGRAM_POLLING_INTERVAL");

    this.instagramConfig = {
      username: String(username),
      password: String(password),
      verificationCode: verificationCode != null ? String(verificationCode) : undefined,
      proxy: proxy != null ? String(proxy) : undefined,
      autoRespondToDms: this.runtime.getSetting("INSTAGRAM_AUTO_RESPOND_DMS") === "true",
      autoRespondToComments: this.runtime.getSetting("INSTAGRAM_AUTO_RESPOND_COMMENTS") === "true",
      pollingInterval: Number.parseInt(String(pollingIntervalStr ?? "60"), 10),
    };

    console.log(`Instagram service initialized for @${username}`);
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
    this.isRunning = false;
    this.loggedInUser = null;
    console.log("Instagram service stopped");
  }

  /**
   * Check if service is running
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get the logged-in user
   */
  getLoggedInUser(): InstagramUser | null {
    return this.loggedInUser;
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
          channelId: context.target.channelId ?? context.target.threadId,
          threadId: context.target.threadId ?? context.target.channelId,
        } as TargetInfo,
        kind: "thread",
        label: `Instagram thread ${context.target.channelId ?? context.target.threadId}`,
        score: 0.95,
      });
    }
    targets.push(...(await this.listConnectorRooms(context)));
    return targets.slice(0, 25);
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
        },
      })),
      metadata: {
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
        channelId: thread.id,
        threadId: thread.id,
      } as TargetInfo,
      label,
      kind: "thread",
      description: thread.isGroup ? "Instagram group DM thread" : "Instagram DM thread",
      score,
      contexts: [...INSTAGRAM_CONNECTOR_CONTEXTS],
      metadata: {
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
