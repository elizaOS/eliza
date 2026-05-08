/**
 * LINE service implementation for ElizaOS.
 */

import type {
  Content,
  Entity,
  EventPayload,
  IAgentRuntime,
  Memory,
  MessageConnectorChatContext,
  MessageConnectorTarget,
  MessageConnectorUserContext,
  Metadata,
  MetadataValue,
  Room,
  TargetInfo,
  UUID,
} from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
import { type MiddlewareConfig, messagingApi, middleware, type webhook } from "@line/bot-sdk";

// @line/bot-sdk v11 moved message and event types under namespaces.
type FlexMessage = messagingApi.FlexMessage;
type LocationMessage = messagingApi.LocationMessage;
type Message = messagingApi.Message;
type TemplateMessage = messagingApi.TemplateMessage;
type WebhookEvent = webhook.Event;

import {
  getChatTypeFromId,
  type ILineService,
  LINE_SERVICE_NAME,
  LineApiError,
  LineConfigurationError,
  LineEventTypes,
  type LineFlexMessage,
  type LineGroup,
  type LineLocationMessage,
  type LineMessage,
  type LineMessageSendOptions,
  type LineQuickReplyItem,
  type LineSendResult,
  type LineSettings,
  type LineTemplateMessage,
  type LineUser,
  MAX_LINE_BATCH_SIZE,
  normalizeLineTarget,
  splitMessageForLine,
} from "./types.js";

function objectToMetadataValue(obj: object): MetadataValue {
  return JSON.parse(JSON.stringify(obj)) as MetadataValue;
}

function normalizeLineQuery(query: string): string {
  return query.trim().toLowerCase();
}

function scoreLineCandidate(values: Array<string | undefined>, query: string): number {
  const normalized = normalizeLineQuery(query);
  if (!normalized) {
    return 0.45;
  }
  const candidates = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  if (candidates.some((candidate) => candidate === normalized)) {
    return 1;
  }
  return candidates.some((candidate) => candidate.includes(normalized)) ? 0.8 : 0;
}

function lineRoomToConnectorTarget(room: Room, score = 0.55): MessageConnectorTarget {
  const channelId = String(room.channelId ?? "");
  const chatType = channelId ? getChatTypeFromId(channelId) : undefined;
  return {
    target: {
      source: LINE_SERVICE_NAME,
      roomId: room.id,
      channelId,
    },
    label: room.name || channelId || String(room.id),
    kind: chatType === "user" ? "contact" : chatType || "room",
    description: "LINE chat from stored room context",
    score,
    contexts: ["social", "connectors"],
    metadata: {
      chatType,
      channelId,
      roomType: room.type,
    },
  };
}

type ConnectorHookContext = {
  runtime: IAgentRuntime;
  roomId?: UUID;
  target?: TargetInfo;
};

type ConnectorReadParams = {
  target?: TargetInfo;
  limit?: number;
  query?: string;
};

type ConnectorUserLookupParams = {
  userId?: string;
  username?: string;
  handle?: string;
  target?: TargetInfo;
};

type AdditiveMessageConnectorHooks = {
  fetchMessages?: (
    context: ConnectorHookContext,
    params?: ConnectorReadParams
  ) => Promise<Memory[]>;
  searchMessages?: (
    context: ConnectorHookContext,
    params: ConnectorReadParams & { query: string }
  ) => Promise<Memory[]>;
  leaveHandler?: (
    runtime: IAgentRuntime,
    params: { channelId?: string; target?: TargetInfo }
  ) => Promise<void>;
  getUser?: (runtime: IAgentRuntime, params: ConnectorUserLookupParams) => Promise<Entity | null>;
};

type ExtendedMessageConnectorRegistration = Parameters<
  IAgentRuntime["registerMessageConnector"]
>[0] &
  AdditiveMessageConnectorHooks;

function normalizeConnectorLimit(limit: number | undefined, fallback = 50): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(limit), 200);
}

async function readStoredMessageMemories(
  runtime: IAgentRuntime,
  roomId: UUID,
  limit: number
): Promise<Memory[]> {
  return runtime.getMemories({
    tableName: "messages",
    roomId,
    limit,
    orderBy: "createdAt",
    orderDirection: "desc",
  });
}

async function readStoredMessagesForTargets(
  runtime: IAgentRuntime,
  targets: MessageConnectorTarget[],
  limit: number
): Promise<Memory[]> {
  const roomIds = Array.from(
    new Set(targets.map((target) => target.target.roomId).filter((id): id is UUID => Boolean(id)))
  );
  const chunks = await Promise.all(
    roomIds.map((roomId) => readStoredMessageMemories(runtime, roomId, limit))
  );
  return chunks
    .flat()
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    .slice(0, limit);
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

function quickReplyItemsFromStrings(values: unknown): LineQuickReplyItem[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const items = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .slice(0, 13)
    .map((text) => ({
      type: "action" as const,
      action: {
        type: "message" as const,
        label: text.slice(0, 20),
        text,
      },
    }));
  return items.length > 0 ? items : undefined;
}

function lineDataFromContent(content: Content): Record<string, unknown> {
  const data = content.data as Record<string, unknown> | undefined;
  if (data?.line && typeof data.line === "object") {
    return data.line as Record<string, unknown>;
  }
  return data ?? {};
}

/**
 * LINE messaging service for ElizaOS agents.
 */
export class LineService extends Service implements ILineService {
  static serviceType: string = LINE_SERVICE_NAME;
  capabilityDescription = "The agent is able to send and receive messages via LINE";

  private settings: LineSettings | null = null;
  private client: messagingApi.MessagingApiClient | null = null;
  private connected: boolean = false;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) return;
    this.settings = this.loadSettings();
  }

  /**
   * Start the LINE service.
   */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new LineService(runtime);
    await service.initialize();
    return service;
  }

  static registerSendHandlers(runtime: IAgentRuntime, service: LineService): void {
    const sendHandler = async (
      handlerRuntime: IAgentRuntime,
      target: TargetInfo,
      content: Content
    ): Promise<Memory | undefined> => {
      await service.handleSendMessage(handlerRuntime, target, content);
      return undefined;
    };

    if (typeof runtime.registerMessageConnector === "function") {
      const registration = {
        source: LINE_SERVICE_NAME,
        label: "LINE",
        capabilities: [
          "send_message",
          "send_flex_message",
          "send_location",
          "send_template_message",
          "quick_reply",
        ],
        supportedTargetKinds: ["contact", "group", "room", "channel"],
        contexts: ["social", "connectors"],
        description:
          "Send LINE text, flex/card, template, quick reply, and location messages to known LINE chats.",
        sendHandler,
        resolveTargets: async (query, context) => {
          const normalizedTarget = normalizeLineTarget(query);
          const exactTarget = normalizedTarget
            ? [
                {
                  target: {
                    source: LINE_SERVICE_NAME,
                    channelId: normalizedTarget,
                  },
                  label: normalizedTarget,
                  kind:
                    getChatTypeFromId(normalizedTarget) === "user"
                      ? "contact"
                      : getChatTypeFromId(normalizedTarget),
                  score: 1,
                  contexts: ["social", "connectors"],
                  metadata: {
                    chatType: getChatTypeFromId(normalizedTarget),
                  },
                } satisfies MessageConnectorTarget,
              ]
            : [];

          const roomTargets = (await service.listConnectorRooms(context.runtime))
            .map((room) => ({
              room,
              score: scoreLineCandidate([room.name, room.channelId, String(room.id)], query),
            }))
            .filter(({ score }) => score > 0)
            .map(({ room, score }) => lineRoomToConnectorTarget(room, score));

          return [...exactTarget, ...roomTargets]
            .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
            .slice(0, 10);
        },
        listRecentTargets: async (context) =>
          (await service.listConnectorRooms(context.runtime))
            .slice(0, 10)
            .map((room) => lineRoomToConnectorTarget(room)),
        listRooms: async (context) =>
          (await service.listConnectorRooms(context.runtime)).map((room) =>
            lineRoomToConnectorTarget(room)
          ),
        fetchMessages: async (context, params) => {
          const limit = normalizeConnectorLimit(params?.limit);
          const target = params?.target ?? context.target;
          if (target?.roomId) {
            return readStoredMessageMemories(context.runtime, target.roomId, limit);
          }
          const targets = (await service.listConnectorRooms(context.runtime))
            .slice(0, 10)
            .map((room) => lineRoomToConnectorTarget(room));
          return readStoredMessagesForTargets(context.runtime, targets, limit);
        },
        searchMessages: async (context, params) => {
          const limit = normalizeConnectorLimit(params?.limit);
          const target = params?.target ?? context.target;
          const messages = target?.roomId
            ? await readStoredMessageMemories(context.runtime, target.roomId, Math.max(limit, 100))
            : await readStoredMessagesForTargets(
                context.runtime,
                (await service.listConnectorRooms(context.runtime))
                  .slice(0, 10)
                  .map((room) => lineRoomToConnectorTarget(room)),
                Math.max(limit, 100)
              );
          return filterMemoriesByQuery(messages, params.query, limit);
        },
        leaveHandler: async (handlerRuntime, params) => {
          const target = params.target ?? ({ source: LINE_SERVICE_NAME } as TargetInfo);
          const room = target.roomId ? await handlerRuntime.getRoom(target.roomId) : null;
          const channelId = String(params?.channelId ?? target.channelId ?? room?.channelId ?? "");
          const chatType = getChatTypeFromId(channelId);
          if (chatType !== "group" && chatType !== "room") {
            throw new Error("LINE leaveHandler requires a group or room target");
          }
          await service.leaveChat(channelId, chatType);
        },
        getUser: async (_handlerRuntime, params) => {
          const userId = String(
            params.userId ??
              params.username ??
              params.handle ??
              params.target?.entityId ??
              params.target?.channelId ??
              ""
          ).trim();
          if (!userId || getChatTypeFromId(userId) !== "user") {
            return null;
          }
          const user = await service.getUserProfile(userId).catch(() => null);
          if (!user) {
            return null;
          }
          return {
            id: user.userId as unknown as UUID,
            names: [user.displayName, user.userId].filter((value) => value.length > 0),
            agentId: _handlerRuntime.agentId,
            metadata: { line: objectToMetadataValue(user) },
          } satisfies Entity;
        },
        getChatContext: async (target, context) => {
          const room = target.roomId ? await context.runtime.getRoom(target.roomId) : null;
          const channelId = String(target.channelId ?? room?.channelId ?? "").trim();
          if (!channelId) {
            return null;
          }

          const chatType = getChatTypeFromId(channelId);
          let label = room?.name || channelId;
          let metadata: Metadata = { chatType, channelId };

          if (chatType === "group" || chatType === "room") {
            const group = await service.getGroupInfo(channelId).catch(() => null);
            if (group?.groupName) {
              label = group.groupName;
            }
            metadata = {
              ...metadata,
              ...(group ? { group: objectToMetadataValue(group) } : {}),
            };
          } else {
            const user = await service.getUserProfile(channelId).catch(() => null);
            if (user?.displayName) {
              label = user.displayName;
            }
            metadata = {
              ...metadata,
              ...(user ? { user: objectToMetadataValue(user) } : {}),
            };
          }

          return {
            target: {
              source: LINE_SERVICE_NAME,
              roomId: target.roomId,
              channelId,
            },
            label,
            summary: `LINE ${chatType} chat`,
            metadata,
          } satisfies MessageConnectorChatContext;
        },
        getUserContext: async (entityId, context) => {
          const entity =
            typeof context.runtime.getEntityById === "function"
              ? await context.runtime.getEntityById(String(entityId) as UUID)
              : null;
          if (!entity) {
            return null;
          }
          return {
            entityId,
            label: entity.names?.[0],
            aliases: entity.names,
            handles: {},
            metadata: entity.metadata,
          } satisfies MessageConnectorUserContext;
        },
      } as ExtendedMessageConnectorRegistration;
      runtime.registerMessageConnector(registration);
      return;
    }

    runtime.registerSendHandler(LINE_SERVICE_NAME, sendHandler);
  }

  /**
   * Initialize the service.
   */
  private async initialize(): Promise<void> {
    if (!this.runtime) return;
    logger.info("Starting LINE service...");

    // Load settings
    if (!this.settings) {
      this.settings = this.loadSettings();
    }
    this.validateSettings();

    // Initialize LINE client
    this.client = new messagingApi.MessagingApiClient({
      channelAccessToken: this.settings.channelAccessToken,
    });

    this.connected = true;
    logger.info("LINE service started");

    // Emit connection ready event
    if (this.runtime) {
      this.runtime.emitEvent([LineEventTypes.CONNECTION_READY], {
        runtime: this.runtime,
        source: "line",
        service: this,
      } as unknown as EventPayload);
    }
  }

  /**
   * Stop the LINE service.
   */
  async stop(): Promise<void> {
    logger.info("Stopping LINE service...");
    this.connected = false;
    this.client = null;
    this.settings = null;
    logger.info("LINE service stopped");
  }

  /**
   * Check if the service is connected.
   */
  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  /**
   * Get bot info.
   */
  async getBotInfo(): Promise<LineUser | null> {
    if (!this.client) {
      return null;
    }

    const info = await this.client.getBotInfo();
    return {
      userId: info.userId,
      displayName: info.displayName,
      pictureUrl: info.pictureUrl,
    };
  }

  /**
   * Send a text message.
   */
  async sendMessage(
    to: string,
    text: string,
    options?: LineMessageSendOptions
  ): Promise<LineSendResult> {
    if (!this.client) {
      return { success: false, error: "Service not connected" };
    }

    const chunks = splitMessageForLine(text);
    const messages: Message[] = chunks.map((chunk) => ({
      type: "text" as const,
      text: chunk,
    }));

    // Add quick replies to last message if provided
    if (options?.quickReplyItems && messages.length > 0) {
      const lastIdx = messages.length - 1;
      // Cast to unknown first to avoid strict type checking with LINE SDK types
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (messages[lastIdx] as { quickReply?: unknown }).quickReply = {
        items: options.quickReplyItems,
      } as unknown;
    }

    return this.pushMessages(to, messages);
  }

  /**
   * Send multiple messages.
   */
  async sendMessages(
    to: string,
    messages: Array<{ type: string; [key: string]: unknown }>
  ): Promise<LineSendResult> {
    return this.pushMessages(to, messages as Message[]);
  }

  /**
   * Send a flex message.
   */
  async sendFlexMessage(to: string, flex: LineFlexMessage): Promise<LineSendResult> {
    if (!this.client) {
      return { success: false, error: "Service not connected" };
    }

    const message: FlexMessage = {
      type: "flex",
      altText: flex.altText.slice(0, 400),
      contents: flex.contents as FlexMessage["contents"],
    };

    return this.pushMessages(to, [message]);
  }

  /**
   * Send a template message.
   */
  async sendTemplateMessage(to: string, template: LineTemplateMessage): Promise<LineSendResult> {
    if (!this.client) {
      return { success: false, error: "Service not connected" };
    }

    const message: TemplateMessage = {
      type: "template",
      altText: template.altText.slice(0, 400),
      template: template.template as TemplateMessage["template"],
    };

    return this.pushMessages(to, [message]);
  }

  /**
   * Send a location message.
   */
  async sendLocationMessage(to: string, location: LineLocationMessage): Promise<LineSendResult> {
    if (!this.client) {
      return { success: false, error: "Service not connected" };
    }

    const message: LocationMessage = {
      type: "location",
      title: location.title.slice(0, 100),
      address: location.address.slice(0, 100),
      latitude: location.latitude,
      longitude: location.longitude,
    };

    return this.pushMessages(to, [message]);
  }

  /**
   * Reply to a message using reply token.
   */
  async replyMessage(
    replyToken: string,
    messages: Array<{ type: string; [key: string]: unknown }>
  ): Promise<LineSendResult> {
    if (!this.client) {
      return { success: false, error: "Service not connected" };
    }

    await this.client.replyMessage({
      replyToken,
      messages: messages.slice(0, MAX_LINE_BATCH_SIZE) as unknown as messagingApi.Message[],
    });

    return {
      success: true,
      messageId: "reply",
      chatId: "reply",
    };
  }

  /**
   * Get user profile.
   */
  async getUserProfile(userId: string): Promise<LineUser | null> {
    if (!this.client) {
      return null;
    }

    const profile = await this.client.getProfile(userId);
    return {
      userId: profile.userId,
      displayName: profile.displayName,
      pictureUrl: profile.pictureUrl,
      statusMessage: profile.statusMessage,
      language: profile.language,
    };
  }

  /**
   * Get group info.
   */
  async getGroupInfo(groupId: string): Promise<LineGroup | null> {
    if (!this.client) {
      return null;
    }

    const chatType = getChatTypeFromId(groupId);
    if (chatType === "group") {
      const summary = await this.client.getGroupSummary(groupId);
      return {
        groupId: summary.groupId,
        groupName: summary.groupName,
        pictureUrl: summary.pictureUrl,
        type: "group",
      };
    } else if (chatType === "room") {
      // Rooms don't have summary, just return ID
      return {
        groupId,
        type: "room",
      };
    }

    return null;
  }

  /**
   * Leave a group or room.
   */
  async leaveChat(chatId: string, chatType: "group" | "room"): Promise<void> {
    if (!this.client) {
      throw new LineApiError("Service not connected");
    }

    if (chatType === "group") {
      await this.client.leaveGroup(chatId);
    } else {
      await this.client.leaveRoom(chatId);
    }
  }

  /**
   * Get the middleware config for webhook verification.
   */
  getMiddlewareConfig(): MiddlewareConfig {
    if (!this.settings) {
      throw new LineConfigurationError("Service not configured");
    }

    return {
      channelSecret: this.settings.channelSecret,
    };
  }

  /**
   * Create Express middleware for webhook handling.
   */
  createMiddleware(): ReturnType<typeof middleware> {
    return middleware(this.getMiddlewareConfig());
  }

  /**
   * Handle webhook events.
   */
  async handleWebhookEvents(events: WebhookEvent[]): Promise<void> {
    if (!this.runtime) {
      return;
    }

    for (const event of events) {
      await this.handleWebhookEvent(event);
    }
  }

  /**
   * Get current settings.
   */
  getSettings(): LineSettings | null {
    return this.settings;
  }

  async sendDirectMessage(target: string, content: Content): Promise<void> {
    await this.sendConnectorContent(target, content);
  }

  async sendRoomMessage(target: string, content: Content): Promise<void> {
    await this.sendConnectorContent(target, content);
  }

  // Private methods

  private async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content
  ): Promise<void> {
    const room = target.roomId ? await runtime.getRoom(target.roomId) : null;
    const chatId = String(target.channelId ?? room?.channelId ?? "").trim();
    if (!chatId) {
      throw new Error("LINE target is missing a user, group, or room ID");
    }
    await this.sendConnectorContent(chatId, content);
  }

  private async sendConnectorContent(to: string, content: Content): Promise<void> {
    const data = lineDataFromContent(content);
    const flexMessage = data.flexMessage as LineFlexMessage | undefined;
    if (flexMessage) {
      const result = await this.sendFlexMessage(to, flexMessage);
      if (!result.success) {
        throw new Error(result.error || "LINE flex message send failed");
      }
      return;
    }

    const location = data.location as LineLocationMessage | undefined;
    if (location) {
      const result = await this.sendLocationMessage(to, location);
      if (!result.success) {
        throw new Error(result.error || "LINE location send failed");
      }
      return;
    }

    const templateMessage = data.templateMessage as LineTemplateMessage | undefined;
    if (templateMessage) {
      const result = await this.sendTemplateMessage(to, templateMessage);
      if (!result.success) {
        throw new Error(result.error || "LINE template message send failed");
      }
      return;
    }

    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      return;
    }

    const result = await this.sendMessage(to, text, {
      quickReplyItems: quickReplyItemsFromStrings(data.quickReplies),
    });
    if (!result.success) {
      throw new Error(result.error || "LINE message send failed");
    }
  }

  private async listConnectorRooms(runtime: IAgentRuntime): Promise<Room[]> {
    if (typeof runtime.getRoomsForParticipant !== "function") {
      return [];
    }
    const roomIds = await runtime.getRoomsForParticipant(runtime.agentId).catch(() => []);
    const rooms: Room[] = [];
    for (const roomId of roomIds) {
      const room = await runtime.getRoom(roomId).catch(() => null);
      if (room?.source === LINE_SERVICE_NAME && room.channelId) {
        rooms.push(room);
      }
    }
    return rooms;
  }

  private loadSettings(): LineSettings {
    if (!this.runtime) {
      throw new LineConfigurationError("Runtime not initialized");
    }

    const getStringSetting = (key: string): string => {
      const value = this.runtime?.getSetting(key);
      return typeof value === "string" ? value : "";
    };

    const channelAccessToken =
      getStringSetting("LINE_CHANNEL_ACCESS_TOKEN") || process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

    const channelSecret =
      getStringSetting("LINE_CHANNEL_SECRET") || process.env.LINE_CHANNEL_SECRET || "";

    const webhookPath =
      getStringSetting("LINE_WEBHOOK_PATH") || process.env.LINE_WEBHOOK_PATH || "/webhooks/line";

    const dmPolicyRaw =
      getStringSetting("LINE_DM_POLICY") || process.env.LINE_DM_POLICY || "pairing";
    const dmPolicy = dmPolicyRaw as LineSettings["dmPolicy"];

    const groupPolicyRaw =
      getStringSetting("LINE_GROUP_POLICY") || process.env.LINE_GROUP_POLICY || "allowlist";
    const groupPolicy = groupPolicyRaw as LineSettings["groupPolicy"];

    const allowFromRaw = getStringSetting("LINE_ALLOW_FROM") || process.env.LINE_ALLOW_FROM || "";
    const allowFrom = allowFromRaw
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);

    const enabledRaw = getStringSetting("LINE_ENABLED") || process.env.LINE_ENABLED || "true";
    const enabled = enabledRaw !== "false";

    return {
      channelAccessToken,
      channelSecret,
      webhookPath,
      dmPolicy,
      groupPolicy,
      allowFrom,
      enabled,
    };
  }

  private validateSettings(): void {
    if (!this.settings) {
      throw new LineConfigurationError("Settings not loaded");
    }

    if (!this.settings.channelAccessToken) {
      throw new LineConfigurationError(
        "LINE_CHANNEL_ACCESS_TOKEN is required",
        "LINE_CHANNEL_ACCESS_TOKEN"
      );
    }

    if (!this.settings.channelSecret) {
      throw new LineConfigurationError("LINE_CHANNEL_SECRET is required", "LINE_CHANNEL_SECRET");
    }
  }

  private async pushMessages(to: string, messages: Message[]): Promise<LineSendResult> {
    if (!this.client) {
      return { success: false, error: "Service not connected" };
    }

    // Send in batches of 5
    for (let i = 0; i < messages.length; i += MAX_LINE_BATCH_SIZE) {
      const batch = messages.slice(i, i + MAX_LINE_BATCH_SIZE);

      await this.client.pushMessage({
        to,
        messages: batch as unknown as messagingApi.Message[],
      });
    }

    // Emit sent event
    if (this.runtime) {
      this.runtime.emitEvent(LineEventTypes.MESSAGE_SENT, {
        runtime: this.runtime,
        source: "line",
        to,
        messageCount: messages.length,
      } as unknown as EventPayload);
    }

    return {
      success: true,
      messageId: Date.now().toString(),
      chatId: to,
    };
  }

  private async handleWebhookEvent(event: WebhookEvent): Promise<void> {
    if (!this.runtime) {
      return;
    }

    switch (event.type) {
      case "message":
        await this.handleMessageEvent(event);
        break;
      case "follow":
        this.runtime.emitEvent([LineEventTypes.FOLLOW], {
          runtime: this.runtime,
          source: "line",
          userId: event.source?.userId,
          timestamp: event.timestamp,
        } as unknown as EventPayload);
        break;
      case "unfollow":
        this.runtime.emitEvent([LineEventTypes.UNFOLLOW], {
          runtime: this.runtime,
          source: "line",
          userId: event.source?.userId,
          timestamp: event.timestamp,
        } as unknown as EventPayload);
        break;
      case "join":
        this.runtime.emitEvent([LineEventTypes.JOIN_GROUP], {
          runtime: this.runtime,
          source: "line",
          groupId:
            event.source?.type === "group"
              ? (event.source as webhook.GroupSource).groupId
              : event.source?.type === "room"
                ? (event.source as webhook.RoomSource).roomId
                : undefined,
          type: event.source?.type,
          timestamp: event.timestamp,
        } as unknown as EventPayload);
        break;
      case "leave":
        this.runtime.emitEvent([LineEventTypes.LEAVE_GROUP], {
          runtime: this.runtime,
          source: "line",
          groupId:
            event.source?.type === "group"
              ? (event.source as webhook.GroupSource).groupId
              : event.source?.type === "room"
                ? (event.source as webhook.RoomSource).roomId
                : undefined,
          type: event.source?.type,
          timestamp: event.timestamp,
        } as unknown as EventPayload);
        break;
      case "postback":
        this.runtime.emitEvent([LineEventTypes.POSTBACK], {
          runtime: this.runtime,
          source: "line",
          userId: event.source?.userId,
          data: event.postback.data,
          params: event.postback.params,
          timestamp: event.timestamp,
        } as unknown as EventPayload);
        break;
    }
  }

  private async handleMessageEvent(event: WebhookEvent & { type: "message" }): Promise<void> {
    if (!this.runtime) {
      return;
    }

    const message: LineMessage = {
      id: event.message.id,
      type: event.message.type,
      userId: event.source?.userId || "",
      timestamp: event.timestamp,
      replyToken: event.replyToken,
    };

    // Add text for text messages
    if (event.message.type === "text") {
      message.text = event.message.text;
      message.mention = event.message.mention;
    }

    // Add group/room ID if applicable
    if (event.source?.type === "group") {
      message.groupId = (event.source as webhook.GroupSource).groupId;
    } else if (event.source?.type === "room") {
      message.roomId = (event.source as webhook.RoomSource).roomId;
    }

    // Emit message received event
    this.runtime.emitEvent([LineEventTypes.MESSAGE_RECEIVED], {
      runtime: this.runtime,
      source: "line",
      message,
      lineSource: event.source,
      replyToken: event.replyToken,
    } as unknown as EventPayload);
  }
}
