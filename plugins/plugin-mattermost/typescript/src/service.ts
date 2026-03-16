import {
  ChannelType,
  type Content,
  createUniqueUuid,
  type EventPayload,
  EventType,
  type IAgentRuntime,
  logger,
  type Room,
  Service,
  type TargetInfo,
  type UUID,
  type World,
} from "@elizaos/core";
import WebSocket from "ws";
import {
  buildMattermostWsUrl,
  createMattermostClient,
  createMattermostDirectChannel,
  createMattermostPost,
  fetchMattermostChannel,
  fetchMattermostMe,
  fetchMattermostUser,
  type MattermostClient,
} from "./client";
import { MATTERMOST_SERVICE_NAME, WS_RECONNECT_DELAY_MS } from "./constants";
import {
  buildMattermostSettings,
  type MattermostSettings,
  validateMattermostConfig,
} from "./environment";
import {
  getChannelDisplayName,
  getChannelKind,
  getUserDisplayName,
  isSystemPost,
  type MattermostChannel,
  MattermostEventTypes,
  type MattermostPost,
  type MattermostUser,
  type MattermostWebSocketEvent,
} from "./types";

/**
 * Mattermost service for elizaOS.
 */
export class MattermostService extends Service {
  static serviceType = MATTERMOST_SERVICE_NAME;
  capabilityDescription = "The agent is able to send and receive messages on Mattermost";

  private client: MattermostClient | null = null;
  private ws: WebSocket | null = null;
  private settings: MattermostSettings | null = null;
  private botUser: MattermostUser | null = null;
  private running = false;
  private wsSeq = 1;
  private knownChannels: Map<string, MattermostChannel> = new Map();
  private syncedEntityIds: Set<string> = new Set();
  private abortController: AbortController | null = null;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<MattermostService> {
    const service = new MattermostService(runtime);
    const config = await validateMattermostConfig(runtime);

    if (!config) {
      logger.warn("Mattermost service started without bot functionality - configuration invalid");
      return service;
    }

    service.settings = buildMattermostSettings(config);

    if (!service.settings.enabled) {
      logger.info("Mattermost service is disabled");
      return service;
    }

    const maxRetries = 5;
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < maxRetries) {
      try {
        logger.info(`Starting Mattermost client for character ${runtime.character.name}`);
        await service.initializeClient();
        return service;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error(
          `Mattermost initialization attempt ${retryCount + 1} failed: ${lastError.message}`
        );
        retryCount++;

        if (retryCount < maxRetries) {
          const delay = 2 ** retryCount * 1000;
          logger.info(`Retrying Mattermost initialization in ${delay / 1000} seconds...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    logger.error(
      `Mattermost initialization failed after ${maxRetries} attempts. Last error: ${lastError?.message}. Service will continue without Mattermost functionality.`
    );
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(MATTERMOST_SERVICE_NAME) as MattermostService | undefined;
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    this.ws?.close();
    this.ws = null;
    this.client = null;
    logger.info("Mattermost service stopped");
  }

  private async initializeClient(): Promise<void> {
    if (!this.settings) {
      throw new Error("Mattermost settings not configured");
    }

    this.client = createMattermostClient({
      baseUrl: this.settings.serverUrl,
      botToken: this.settings.botToken,
    });

    this.botUser = await fetchMattermostMe(this.client);
    logger.info(`Mattermost connected as @${this.botUser.username || this.botUser.id}`);

    this.running = true;
    this.abortController = new AbortController();

    // Emit world connected event
    this.runtime.emitEvent(
      MattermostEventTypes.WORLD_CONNECTED as string,
      {
        runtime: this.runtime,
        source: "mattermost",
        botUsername: this.botUser.username,
      } as EventPayload
    );

    // Start WebSocket connection
    this.startWebSocket();
  }

  private startWebSocket(): void {
    if (!this.settings || !this.client) {
      return;
    }

    const wsUrl = buildMattermostWsUrl(this.settings.serverUrl);
    this.connectWebSocket(wsUrl);
  }

  private connectWebSocket(wsUrl: string): void {
    if (!this.running || !this.settings) {
      return;
    }

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      logger.info("Mattermost WebSocket connected");
      // Authenticate
      ws.send(
        JSON.stringify({
          seq: this.wsSeq++,
          action: "authentication_challenge",
          data: { token: this.settings!.botToken },
        })
      );
    });

    ws.on("message", async (data) => {
      try {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        const event = JSON.parse(raw) as MattermostWebSocketEvent;
        await this.handleWebSocketEvent(event);
      } catch (error) {
        logger.error(`Error processing WebSocket message: ${error}`);
      }
    });

    ws.on("close", (code, reason) => {
      const message = reason?.toString("utf8") || "";
      logger.info(`Mattermost WebSocket closed: ${code} ${message}`);

      if (this.running) {
        setTimeout(() => {
          this.connectWebSocket(wsUrl);
        }, WS_RECONNECT_DELAY_MS);
      }
    });

    ws.on("error", (error) => {
      logger.error(`Mattermost WebSocket error: ${error}`);
    });
  }

  private async handleWebSocketEvent(event: MattermostWebSocketEvent): Promise<void> {
    if (event.event !== "posted") {
      return;
    }

    const postData = event.data?.post;
    if (!postData) {
      return;
    }

    let post: MattermostPost;
    try {
      post = typeof postData === "string" ? JSON.parse(postData) : postData;
    } catch {
      return;
    }

    await this.handlePost(post, event);
  }

  private async handlePost(post: MattermostPost, event: MattermostWebSocketEvent): Promise<void> {
    if (!this.client || !this.settings || !this.botUser) {
      return;
    }

    const channelId = post.channel_id ?? event.data?.channel_id ?? event.broadcast?.channel_id;
    if (!channelId) {
      return;
    }

    const senderId = post.user_id ?? event.broadcast?.user_id;
    if (!senderId) {
      return;
    }

    // Ignore own messages
    if (senderId === this.botUser.id) {
      return;
    }

    // Ignore system posts
    if (isSystemPost(post)) {
      return;
    }

    // Fetch channel info
    let channel: MattermostChannel;
    try {
      channel =
        this.knownChannels.get(channelId) ?? (await fetchMattermostChannel(this.client, channelId));
      this.knownChannels.set(channelId, channel);
    } catch {
      logger.warn(`Failed to fetch channel info for ${channelId}`);
      return;
    }

    const channelType = event.data?.channel_type ?? channel.type;
    const kind = getChannelKind(channelType);

    // Fetch sender info
    let sender: MattermostUser | null = null;
    try {
      sender = await fetchMattermostUser(this.client, senderId);
    } catch {
      logger.debug(`Failed to fetch user info for ${senderId}`);
    }

    // Apply policies
    if (!this.shouldProcessMessage(kind, senderId, sender)) {
      return;
    }

    // Check mention requirement for channels
    const rawText = post.message?.trim() || "";
    if (kind !== "dm" && this.settings.requireMention) {
      const botMention = `@${this.botUser.username}`;
      if (!rawText.toLowerCase().includes(botMention.toLowerCase())) {
        return;
      }
    }

    // Ignore bot messages if configured
    if (this.settings.ignoreBotMessages && sender?.is_bot) {
      return;
    }

    // Process the message
    await this.processIncomingMessage(post, channel, sender, event);
  }

  private shouldProcessMessage(
    kind: "dm" | "group" | "channel",
    senderId: string,
    sender: MattermostUser | null
  ): boolean {
    if (!this.settings) {
      return false;
    }

    const { dmPolicy, groupPolicy } = this.settings;

    // Check DM policy
    if (kind === "dm") {
      if (dmPolicy === "disabled") {
        return false;
      }
      if (dmPolicy === "allowlist" && !this.isUserAllowed(senderId, sender?.username)) {
        return false;
      }
      return true;
    }

    // Check group/channel policy
    if (groupPolicy === "disabled") {
      return false;
    }
    if (groupPolicy === "allowlist" && !this.isUserAllowed(senderId, sender?.username)) {
      return false;
    }

    return true;
  }

  private isUserAllowed(userId: string, username?: string | null): boolean {
    if (!this.settings?.allowedUsers.length) {
      return true;
    }

    const allowedLower = this.settings.allowedUsers.map((u) => u.toLowerCase());
    if (allowedLower.includes("*")) {
      return true;
    }
    if (allowedLower.includes(userId.toLowerCase())) {
      return true;
    }
    if (username && allowedLower.includes(username.toLowerCase())) {
      return true;
    }

    return false;
  }

  private async processIncomingMessage(
    post: MattermostPost,
    channel: MattermostChannel,
    sender: MattermostUser | null,
    _event: MattermostWebSocketEvent
  ): Promise<void> {
    const channelId = post.channel_id!;
    const kind = getChannelKind(channel.type);
    const worldId = createUniqueUuid(this.runtime, channelId) as UUID;
    const roomId = post.root_id
      ? (createUniqueUuid(this.runtime, `${channelId}-${post.root_id}`) as UUID)
      : (createUniqueUuid(this.runtime, channelId) as UUID);

    // Ensure world exists
    const existingWorld = await this.runtime.getWorld(worldId);
    if (!existingWorld) {
      const world: World = {
        id: worldId,
        name: getChannelDisplayName(channel),
        agentId: this.runtime.agentId,
        messageServerId: createUniqueUuid(this.runtime, channelId) as UUID,
        metadata: {
          extra: {
            channelType: channel.type,
            teamId: channel.team_id,
          },
        },
      };
      await this.runtime.ensureWorldExists(world);
    }

    // Ensure room exists
    const channelType =
      kind === "dm" ? ChannelType.DM : kind === "group" ? ChannelType.GROUP : ChannelType.GROUP;

    const room: Room = {
      id: roomId,
      name: getChannelDisplayName(channel),
      source: "mattermost",
      type: channelType,
      channelId,
      messageServerId: createUniqueUuid(this.runtime, channelId) as UUID,
      worldId,
      metadata: post.root_id
        ? {
            threadId: post.root_id,
            isThread: true,
            parentChannelId: channelId,
          }
        : undefined,
    };
    await this.runtime.ensureRoomExists(room);

    // Ensure sender entity exists
    if (sender) {
      const entityId = createUniqueUuid(this.runtime, sender.id) as UUID;
      if (!this.syncedEntityIds.has(entityId)) {
        await this.runtime.ensureConnection({
          entityId,
          roomId,
          userName: sender.username || undefined,
          userId: sender.id as UUID,
          name: getUserDisplayName(sender),
          source: "mattermost",
          channelId,
          messageServerId: createUniqueUuid(this.runtime, channelId) as UUID,
          type: channelType,
          worldId,
        });
        this.syncedEntityIds.add(entityId);
      }
    }

    // Clean up mention from text
    let text = post.message?.trim() || "";
    if (this.botUser?.username) {
      const mentionRegex = new RegExp(`@${this.botUser.username}\\b`, "gi");
      text = text.replace(mentionRegex, "").replace(/\s+/g, " ").trim();
    }

    // Emit message received event
    const entityId = sender ? (createUniqueUuid(this.runtime, sender.id) as UUID) : undefined;

    const content: Content = {
      text,
      source: "mattermost",
      channelId,
      metadata: {
        postId: post.id,
        rootId: post.root_id,
        fileIds: post.file_ids,
      },
    };

    this.runtime.emitEvent(
      MattermostEventTypes.MESSAGE_RECEIVED as string,
      {
        runtime: this.runtime,
        message: {
          id: createUniqueUuid(this.runtime, post.id) as UUID,
          content,
          entityId,
          roomId,
          createdAt: post.create_at ?? Date.now(),
        },
        source: "mattermost",
        originalPost: post,
        channel,
        user: sender,
      } as EventPayload
    );

    // Also emit standard message event
    this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime: this.runtime,
      message: {
        id: createUniqueUuid(this.runtime, post.id) as UUID,
        content,
        entityId,
        roomId,
        createdAt: post.create_at ?? Date.now(),
      },
      source: "mattermost",
    } as EventPayload);
  }

  /**
   * Send a message to a channel or user.
   */
  async sendMessage(target: string, content: Content): Promise<MattermostPost | null> {
    if (!this.client || !this.botUser) {
      throw new Error("Mattermost client not initialized");
    }

    const channelId = await this.resolveTargetChannelId(target);
    const text = content.text || "";
    const metadata = content.metadata as Record<string, unknown> | undefined;
    const rootId = metadata?.rootId as string | undefined;
    const fileIds = metadata?.fileIds as string[] | undefined;

    const post = await createMattermostPost(this.client, {
      channelId,
      message: text,
      rootId,
      fileIds,
    });

    // Emit message sent event
    this.runtime.emitEvent(
      MattermostEventTypes.MESSAGE_SENT as string,
      {
        runtime: this.runtime,
        source: "mattermost",
        originalPost: post,
        channelId,
      } as EventPayload
    );

    return post;
  }

  private async resolveTargetChannelId(target: string): Promise<string> {
    if (!this.client || !this.botUser) {
      throw new Error("Mattermost client not initialized");
    }

    const trimmed = target.trim();

    // Handle channel: prefix
    if (trimmed.toLowerCase().startsWith("channel:")) {
      return trimmed.slice("channel:".length).trim();
    }

    // Handle user: prefix for DM
    if (trimmed.toLowerCase().startsWith("user:")) {
      const userId = trimmed.slice("user:".length).trim();
      const channel = await createMattermostDirectChannel(this.client, [this.botUser.id, userId]);
      return channel.id;
    }

    // Handle @username for DM
    if (trimmed.startsWith("@")) {
      const username = trimmed.slice(1).trim();
      const user = await this.client.request<MattermostUser>(
        `/users/username/${encodeURIComponent(username)}`
      );
      const channel = await createMattermostDirectChannel(this.client, [this.botUser.id, user.id]);
      return channel.id;
    }

    // Assume it's a channel ID
    return trimmed;
  }

  static registerSendHandlers(runtime: IAgentRuntime, serviceInstance: MattermostService): void {
    if (serviceInstance?.client) {
      runtime.registerSendHandler(
        "mattermost",
        serviceInstance.handleSendMessage.bind(serviceInstance)
      );
      logger.info("[Mattermost] Registered send handler.");
    } else {
      logger.warn("[Mattermost] Cannot register send handler - client not initialized.");
    }
  }

  async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Mattermost client is not initialized.");
    }

    let channelId: string | undefined;

    if (target.channelId) {
      channelId = target.channelId;
    } else if (target.roomId) {
      const room = await runtime.getRoom(target.roomId);
      channelId = room?.channelId;
      if (!channelId) {
        throw new Error(`Could not resolve Mattermost channel ID from roomId ${target.roomId}`);
      }
    } else if (target.entityId) {
      // For entity, we need to create/get a DM channel
      throw new Error(
        "Sending DMs via entityId is not yet supported for Mattermost. Use channelId or roomId instead."
      );
    } else {
      throw new Error("Mattermost SendHandler requires channelId, roomId, or entityId.");
    }

    await this.sendMessage(`channel:${channelId}`, content);
    logger.info(`[Mattermost SendHandler] Message sent to channel ID: ${channelId}`);
  }
}
