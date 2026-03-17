import {
  ChannelType,
  type Content,
  type EventPayload,
  type IAgentRuntime,
  logger,
  Service,
  type TargetInfo,
} from "@elizaos/core";
import { createTlonClient, type TlonClient } from "./client";
import { TLON_SERVICE_NAME } from "./constants";
import {
  buildTlonSettings,
  formatShip,
  normalizeShip,
  parseChannelNest,
  type TlonSettings,
  validateTlonConfig,
} from "./environment";
import {
  TlonChannelType,
  type TlonChat,
  TlonEventTypes,
  type TlonShip,
} from "./types";
import { extractMessageText, sendDm, sendGroupMessage } from "./utils";

/**
 * Internal message payload for emitting events (without MessagePayload inheritance requirements)
 */
interface InternalMessagePayload {
  messageId: string;
  chat: TlonChat;
  fromShip: TlonShip;
  text: string;
  timestamp: number;
  replyToId?: string;
  rawContent?: unknown;
}

/**
 * Tlon/Urbit service for elizaOS
 */
export class TlonService extends Service {
  static serviceType = TLON_SERVICE_NAME;
  capabilityDescription =
    "The agent is able to send and receive messages on Tlon/Urbit";

  private client: TlonClient | null = null;
  private settings: TlonSettings | null = null;
  private subscribedChannels = new Set<string>();
  private subscribedDMs = new Set<string>();
  private processedMessages = new Map<string, number>();
  private maxProcessedMessages = 2000;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  /**
   * Start the Tlon service
   */
  static async start(runtime: IAgentRuntime): Promise<TlonService> {
    const service = new TlonService(runtime);

    const config = await validateTlonConfig(runtime);
    if (!config) {
      logger.warn(
        "Tlon configuration not provided - Tlon functionality will be unavailable",
      );
      return service;
    }

    const settings = buildTlonSettings(config);
    if (!settings.enabled) {
      logger.info("Tlon plugin is disabled");
      return service;
    }

    service.settings = settings;

    const maxRetries = 5;
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < maxRetries) {
      try {
        logger.info(`Tlon client starting for ship ~${settings.ship}`);

        service.client = await createTlonClient(settings.url, settings.code, {
          ship: settings.ship,
          logger: {
            log: (msg) => logger.debug(`[Tlon] ${msg}`),
            error: (msg) => logger.error(`[Tlon] ${msg}`),
          },
          onReconnect: async () => {
            logger.info("[Tlon] Reconnecting...");
            runtime.emitEvent(
              TlonEventTypes.RECONNECTED as string,
              {
                runtime,
                source: "tlon",
                attempt: service.client?.isConnected ? 0 : 1,
              } as EventPayload,
            );
          },
        });

        await service.initializeSubscriptions();
        await service.client.connect();

        logger.success(`Tlon client connected for ~${settings.ship}`);
        return service;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error(
          `Tlon initialization attempt ${retryCount + 1} failed: ${lastError.message}`,
        );
        retryCount++;

        if (retryCount < maxRetries) {
          const delay = 2 ** retryCount * 1000;
          logger.info(
            `Retrying Tlon initialization in ${delay / 1000} seconds...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    logger.error(
      `Tlon initialization failed after ${maxRetries} attempts. Last error: ${lastError?.message}`,
    );
    return service;
  }

  /**
   * Stop the Tlon service
   */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = (await runtime.getService(TLON_SERVICE_NAME)) as
      | TlonService
      | undefined;
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.subscribedChannels.clear();
    this.subscribedDMs.clear();
    this.processedMessages.clear();
  }

  private async initializeSubscriptions(): Promise<void> {
    if (!this.client || !this.settings) return;

    // Discover DM conversations
    try {
      const dmList = await this.client.scry<string[]>("/chat/dm.json");
      if (Array.isArray(dmList)) {
        logger.info(`[Tlon] Found ${dmList.length} DM conversation(s)`);
        for (const dmShip of dmList) {
          await this.subscribeToDM(dmShip);
        }
      }
    } catch (error) {
      logger.error(`[Tlon] Failed to fetch DM list: ${error}`);
    }

    // Subscribe to group channels
    let groupChannels = this.settings.groupChannels;

    if (this.settings.autoDiscoverChannels) {
      try {
        const discovered = await this.discoverChannels();
        if (discovered.length > 0) {
          groupChannels = discovered;
        }
      } catch (error) {
        logger.error(`[Tlon] Auto-discovery failed: ${error}`);
      }
    }

    for (const channelNest of groupChannels) {
      await this.subscribeToChannel(channelNest);
    }

    logger.info(
      `[Tlon] Subscribed to ${this.subscribedDMs.size} DMs and ${this.subscribedChannels.size} channels`,
    );
  }

  private async discoverChannels(): Promise<string[]> {
    if (!this.client) return [];

    try {
      const channels = await this.client.scry<Record<string, unknown>>(
        "/channels/channels.json",
      );
      if (channels && typeof channels === "object") {
        return Object.keys(channels);
      }
    } catch (error) {
      logger.debug(`[Tlon] Could not discover channels: ${error}`);
    }
    return [];
  }

  private async subscribeToDM(dmShip: string): Promise<void> {
    if (!this.client || this.subscribedDMs.has(dmShip)) return;

    try {
      await this.client.subscribe({
        app: "chat",
        path: `/dm/${dmShip}`,
        event: (data) => this.handleDMEvent(dmShip, data),
        err: (error) =>
          logger.error(`[Tlon] DM subscription error for ${dmShip}: ${error}`),
        quit: () => {
          logger.debug(`[Tlon] DM subscription ended for ${dmShip}`);
          this.subscribedDMs.delete(dmShip);
        },
      });
      this.subscribedDMs.add(dmShip);
      logger.debug(`[Tlon] Subscribed to DM with ${dmShip}`);
    } catch (error) {
      logger.error(`[Tlon] Failed to subscribe to DM with ${dmShip}: ${error}`);
    }
  }

  private async subscribeToChannel(channelNest: string): Promise<void> {
    if (!this.client || this.subscribedChannels.has(channelNest)) return;

    const parsed = parseChannelNest(channelNest);
    if (!parsed) {
      logger.error(`[Tlon] Invalid channel format: ${channelNest}`);
      return;
    }

    try {
      await this.client.subscribe({
        app: "channels",
        path: `/${channelNest}`,
        event: (data) => this.handleChannelEvent(channelNest, data),
        err: (error) =>
          logger.error(
            `[Tlon] Channel subscription error for ${channelNest}: ${error}`,
          ),
        quit: () => {
          logger.debug(`[Tlon] Channel subscription ended for ${channelNest}`);
          this.subscribedChannels.delete(channelNest);
        },
      });
      this.subscribedChannels.add(channelNest);
      logger.debug(`[Tlon] Subscribed to channel: ${channelNest}`);
    } catch (error) {
      logger.error(
        `[Tlon] Failed to subscribe to channel ${channelNest}: ${error}`,
      );
    }
  }

  private markMessageProcessed(messageId: string | undefined): boolean {
    if (!messageId) return true; // Process messages without IDs
    if (this.processedMessages.has(messageId)) return false;

    this.processedMessages.set(messageId, Date.now());

    // Cleanup old messages
    if (this.processedMessages.size > this.maxProcessedMessages) {
      const entries = Array.from(this.processedMessages.entries());
      entries.sort((a, b) => a[1] - b[1]);
      const toDelete = entries.slice(
        0,
        entries.length - this.maxProcessedMessages + 100,
      );
      for (const [id] of toDelete) {
        this.processedMessages.delete(id);
      }
    }

    return true;
  }

  private handleDMEvent(_dmShip: string, update: unknown): void {
    try {
      const data = update as {
        response?: { add?: { memo?: unknown } };
        id?: string;
      };
      const memo = data?.response?.add?.memo as {
        content?: unknown;
        author?: string;
        sent?: number;
      } | null;

      if (!memo) return;

      const messageId = data.id;
      if (!this.markMessageProcessed(messageId)) return;

      const senderShip = normalizeShip(memo.author ?? "");
      if (!senderShip || senderShip === this.settings?.ship) return;

      const messageText = extractMessageText(memo.content);
      if (!messageText) return;

      // Check DM allowlist
      if (
        this.settings?.dmAllowlist.length &&
        !this.settings.dmAllowlist.includes(senderShip)
      ) {
        logger.debug(`[Tlon] Blocked DM from ${senderShip}: not in allowlist`);
        return;
      }

      this.emitMessageEvent({
        messageId: messageId ?? `dm-${Date.now()}`,
        chat: {
          id: senderShip,
          type: TlonChannelType.DM,
          name: `DM with ${formatShip(senderShip)}`,
        },
        fromShip: { name: senderShip },
        text: messageText,
        timestamp: memo.sent || Date.now(),
        rawContent: memo.content,
      });
    } catch (error) {
      logger.error(`[Tlon] Error handling DM event: ${error}`);
    }
  }

  private handleChannelEvent(channelNest: string, update: unknown): void {
    try {
      const data = update as {
        response?: {
          post?: {
            id?: string;
            "r-post"?: {
              set?: { essay?: unknown; seal?: unknown };
              reply?: {
                id?: string;
                "r-reply"?: { set?: { memo?: unknown; seal?: unknown } };
              };
            };
          };
        };
      };

      const essay = data?.response?.post?.["r-post"]?.set?.essay as {
        content?: unknown;
        author?: string;
        sent?: number;
      } | null;
      const memo = data?.response?.post?.["r-post"]?.reply?.["r-reply"]?.set
        ?.memo as {
        content?: unknown;
        author?: string;
        sent?: number;
      } | null;

      if (!essay && !memo) return;

      const content = memo || essay;
      const isThreadReply = Boolean(memo);
      const messageId = isThreadReply
        ? data?.response?.post?.["r-post"]?.reply?.id
        : data?.response?.post?.id;

      if (!this.markMessageProcessed(messageId)) return;

      const senderShip = normalizeShip(content?.author ?? "");
      if (!senderShip || senderShip === this.settings?.ship) return;

      const messageText = extractMessageText(content?.content);
      if (!messageText) return;

      const parsed = parseChannelNest(channelNest);
      if (!parsed) return;

      // Get parent ID for thread replies
      const seal = isThreadReply
        ? (
            data?.response?.post?.["r-post"]?.reply?.["r-reply"]?.set as {
              seal?: unknown;
            }
          )?.seal
        : (data?.response?.post?.["r-post"]?.set as { seal?: unknown })?.seal;
      const parentId =
        (seal as { "parent-id"?: string; parent?: string } | undefined)?.[
          "parent-id"
        ] || (seal as { parent?: string } | undefined)?.parent;

      this.emitMessageEvent({
        messageId: messageId ?? `channel-${Date.now()}`,
        chat: {
          id: channelNest,
          type: isThreadReply ? TlonChannelType.THREAD : TlonChannelType.GROUP,
          name: parsed.channelName,
          hostShip: parsed.hostShip,
        },
        fromShip: { name: senderShip },
        text: messageText,
        timestamp: content?.sent || Date.now(),
        replyToId: parentId ?? undefined,
        rawContent: content?.content,
      });
    } catch (error) {
      logger.error(`[Tlon] Error handling channel event: ${error}`);
    }
  }

  private emitMessageEvent(payload: InternalMessagePayload): void {
    const eventType =
      payload.chat.type === TlonChannelType.DM
        ? TlonEventTypes.DM_RECEIVED
        : TlonEventTypes.GROUP_MESSAGE_RECEIVED;

    this.runtime.emitEvent(
      eventType as string,
      {
        runtime: this.runtime,
        source: "tlon",
        ...payload,
      } as EventPayload,
    );

    this.runtime.emitEvent(
      TlonEventTypes.MESSAGE_RECEIVED as string,
      {
        runtime: this.runtime,
        source: "tlon",
        ...payload,
      } as EventPayload,
    );
  }

  /**
   * Send a direct message to a ship
   */
  async sendDirectMessage(
    toShip: string,
    text: string,
  ): Promise<{ messageId: string }> {
    if (!this.client || !this.settings) {
      throw new Error("Tlon client not initialized");
    }

    return sendDm({
      api: this.client,
      fromShip: this.settings.ship,
      toShip: normalizeShip(toShip),
      text,
    });
  }

  /**
   * Send a message to a group channel
   */
  async sendChannelMessage(
    channelNest: string,
    text: string,
    replyToId?: string,
  ): Promise<{ messageId: string }> {
    if (!this.client || !this.settings) {
      throw new Error("Tlon client not initialized");
    }

    const parsed = parseChannelNest(channelNest);
    if (!parsed) {
      throw new Error(`Invalid channel nest format: ${channelNest}`);
    }

    return sendGroupMessage({
      api: this.client,
      fromShip: this.settings.ship,
      hostShip: parsed.hostShip,
      channelName: parsed.channelName,
      text,
      replyToId,
    });
  }

  /**
   * Register the send handler with the runtime
   */
  static registerSendHandlers(
    runtime: IAgentRuntime,
    serviceInstance: TlonService,
  ): void {
    if (serviceInstance?.client) {
      runtime.registerSendHandler(
        "tlon",
        serviceInstance.handleSendMessage.bind(serviceInstance),
      );
      logger.info("[Tlon] Registered send handler.");
    } else {
      logger.warn(
        "[Tlon] Cannot register send handler - client not initialized.",
      );
    }
  }

  /**
   * Handle outgoing messages from the runtime
   */
  async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ): Promise<void> {
    if (!this.client || !this.settings) {
      logger.error(
        "[Tlon SendHandler] Client not initialized - cannot send messages.",
      );
      throw new Error("Tlon client is not initialized");
    }

    const text =
      typeof content.text === "string"
        ? content.text
        : String(content.text ?? "");
    if (!text) {
      throw new Error("No message text provided");
    }

    // Determine target from channelId or roomId
    let targetId: string | undefined;
    let isDm = false;

    if (target.channelId) {
      targetId = target.channelId;
      // Check if it looks like a ship name (DM) or channel nest (group)
      isDm = !targetId.includes("/");
    } else if (target.roomId) {
      const room = await runtime.getRoom(target.roomId);
      targetId = room?.channelId;
      isDm = room?.type === ChannelType.DM;
    }

    if (!targetId) {
      throw new Error("Could not determine target for Tlon message");
    }

    if (isDm) {
      await this.sendDirectMessage(targetId, text);
    } else {
      const replyToId = (content as { replyToId?: string }).replyToId;
      await this.sendChannelMessage(targetId, text, replyToId);
    }

    logger.info(`[Tlon SendHandler] Message sent to ${targetId}`);
  }

  /** Get the underlying client */
  getClient(): TlonClient | null {
    return this.client;
  }

  /** Get the current settings */
  getSettings(): TlonSettings | null {
    return this.settings;
  }

  /** Check if service is connected */
  isConnected(): boolean {
    return this.client?.isConnected ?? false;
  }
}
