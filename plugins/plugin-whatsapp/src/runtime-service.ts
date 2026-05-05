import {
  ChannelType,
  type Content,
  createUniqueUuid,
  type IAgentRuntime,
  lifeOpsPassiveConnectorsEnabled,
  type Memory,
  Service,
  type UUID,
} from "@elizaos/core";
import { checkWhatsAppUserAccess } from "./accounts";
import { WhatsAppClient } from "./client";
import { BaileysClient } from "./clients/baileys-client";
import {
  buildWhatsAppUserJid,
  chunkWhatsAppText,
  isWhatsAppGroupJid,
  isWhatsAppUserTarget,
  normalizeWhatsAppTarget,
  resolveWhatsAppSystemLocation,
} from "./normalize";
import type {
  BaileysConfig,
  CloudAPIConfig,
  ConnectionStatus,
  NormalizedMessage,
  WhatsAppIncomingMessage,
  WhatsAppMessageResponse,
  WhatsAppWebhookEvent,
} from "./types";

type RuntimeServiceConfig =
  | {
      transport: "baileys";
      authDir: string;
      dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
      groupPolicy?: "open" | "allowlist" | "disabled";
      allowFrom?: string[];
      groupAllowFrom?: string[];
    }
  | {
      transport: "cloudapi";
      accessToken: string;
      phoneNumberId: string;
      webhookVerifyToken?: string;
      apiVersion?: string;
      dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
      groupPolicy?: "open" | "allowlist" | "disabled";
      allowFrom?: string[];
      groupAllowFrom?: string[];
    };

function readStringSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  const envValue = process.env[key];
  if (typeof envValue === "string" && envValue.trim().length > 0) {
    return envValue.trim();
  }

  return undefined;
}

function readCsvSetting(runtime: IAgentRuntime, key: string): string[] {
  const value = readStringSetting(runtime, key);
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function resolveRuntimeConfig(runtime: IAgentRuntime): RuntimeServiceConfig | null {
  const dmPolicy = readStringSetting(runtime, "WHATSAPP_DM_POLICY") as
    | "open"
    | "allowlist"
    | "pairing"
    | "disabled"
    | undefined;
  const groupPolicy = readStringSetting(runtime, "WHATSAPP_GROUP_POLICY") as
    | "open"
    | "allowlist"
    | "disabled"
    | undefined;
  const allowFrom = readCsvSetting(runtime, "WHATSAPP_ALLOW_FROM");
  const groupAllowFrom = readCsvSetting(runtime, "WHATSAPP_GROUP_ALLOW_FROM");

  const authDir =
    readStringSetting(runtime, "WHATSAPP_AUTH_DIR") ??
    readStringSetting(runtime, "WHATSAPP_SESSION_PATH");
  if (authDir) {
    return {
      transport: "baileys",
      authDir,
      dmPolicy,
      groupPolicy,
      allowFrom,
      groupAllowFrom,
    };
  }

  const accessToken = readStringSetting(runtime, "WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = readStringSetting(runtime, "WHATSAPP_PHONE_NUMBER_ID");
  if (accessToken && phoneNumberId) {
    return {
      transport: "cloudapi",
      accessToken,
      phoneNumberId,
      webhookVerifyToken: readStringSetting(runtime, "WHATSAPP_WEBHOOK_VERIFY_TOKEN"),
      apiVersion: readStringSetting(runtime, "WHATSAPP_API_VERSION"),
      dmPolicy,
      groupPolicy,
      allowFrom,
      groupAllowFrom,
    };
  }

  return null;
}

function toTimestampMs(value: number | string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Date.now();
  }

  return parsed >= 1_000_000_000_000 ? parsed : parsed * 1000;
}

function toMemoryId(runtime: IAgentRuntime, chatId: string, messageId: string): UUID {
  return createUniqueUuid(runtime, `whatsapp:${chatId}:${messageId}`) as UUID;
}

type RuntimeWithOptionalConnectorRegistry = IAgentRuntime & {
  registerMessageConnector?: (registration: MessageConnectorRegistration) => void;
};
type RuntimeSendHandler = Parameters<IAgentRuntime["registerSendHandler"]>[1];
type ConnectorTargetInfo = Parameters<RuntimeSendHandler>[1];
type ConnectorContent = Parameters<RuntimeSendHandler>[2];
type MessageConnectorRegistration = Parameters<IAgentRuntime["registerMessageConnector"]>[0];
type MessageConnectorTarget = Awaited<
  ReturnType<NonNullable<MessageConnectorRegistration["resolveTargets"]>>
>[number];
type MessageConnectorQueryContext = Parameters<
  NonNullable<MessageConnectorRegistration["resolveTargets"]>
>[1];
type MessageConnectorChatContext = NonNullable<
  Awaited<ReturnType<NonNullable<MessageConnectorRegistration["getChatContext"]>>>
>;
type MessageConnectorUserContext = NonNullable<
  Awaited<ReturnType<NonNullable<MessageConnectorRegistration["getUserContext"]>>>
>;

type KnownWhatsAppTarget = {
  chatId: string;
  senderId: string;
  label: string;
  isGroup: boolean;
  lastMessageAt: number;
  roomId?: UUID;
};

function registerMessageConnectorIfAvailable(
  runtime: IAgentRuntime,
  registration: MessageConnectorRegistration
): void {
  const withRegistry = runtime as RuntimeWithOptionalConnectorRegistry;
  if (typeof withRegistry.registerMessageConnector === "function") {
    withRegistry.registerMessageConnector(registration);
    return;
  }
  runtime.registerSendHandler(registration.source, registration.sendHandler);
}

function normalizeBaileysSendTarget(target: string): string {
  if (isWhatsAppGroupJid(target) || isWhatsAppUserTarget(target)) {
    return target;
  }
  const normalized = normalizeWhatsAppTarget(target);
  return normalized ? buildWhatsAppUserJid(normalized) : target;
}

function normalizeWhatsAppConnectorTarget(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^whatsapp:/i, "")
    .trim();
  if (!trimmed) return "";
  if (isWhatsAppGroupJid(trimmed) || isWhatsAppUserTarget(trimmed)) {
    return trimmed;
  }
  return normalizeWhatsAppTarget(trimmed) ?? trimmed;
}

function isWhatsAppAddress(value: string): boolean {
  return (
    isWhatsAppGroupJid(value) ||
    isWhatsAppUserTarget(value) ||
    normalizeWhatsAppTarget(value) !== null
  );
}

function normalizedSearchText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9@+._-]+/g, " ")
    .trim();
}

function matchesQuery(query: string, ...values: Array<string | undefined>): boolean {
  const normalizedQuery = normalizedSearchText(query);
  if (!normalizedQuery) return true;
  const normalizedTargetQuery = normalizedSearchText(normalizeWhatsAppConnectorTarget(query));
  return values.some((value) => {
    const normalizedValue = normalizedSearchText(value);
    return (
      normalizedValue.includes(normalizedQuery) ||
      (normalizedTargetQuery.length > 0 && normalizedValue.includes(normalizedTargetQuery))
    );
  });
}

function whatsappTargetKind(value: string): "phone" | "group" | "contact" {
  if (isWhatsAppGroupJid(value)) return "group";
  if (/^\+?\d{7,}$/.test(value) || isWhatsAppUserTarget(value)) return "phone";
  return "contact";
}

function knownWhatsAppTargetToConnectorTarget(
  known: KnownWhatsAppTarget,
  score = 0.72
): MessageConnectorTarget {
  return {
    target: {
      source: "whatsapp",
      channelId: known.chatId,
      entityId: known.senderId as unknown as UUID,
      roomId: known.roomId,
    },
    label: known.label,
    kind: known.isGroup ? "group" : whatsappTargetKind(known.senderId),
    description: known.isGroup ? "WhatsApp group chat" : "WhatsApp contact",
    score,
    metadata: {
      chatId: known.chatId,
      senderId: known.senderId,
      lastMessageAt: known.lastMessageAt,
    },
  };
}

function directWhatsAppTarget(value: string, score = 0.68): MessageConnectorTarget | null {
  const normalized = normalizeWhatsAppConnectorTarget(value);
  if (!normalized || !isWhatsAppAddress(normalized)) return null;
  return {
    target: {
      source: "whatsapp",
      channelId: normalized,
      entityId: normalized as unknown as UUID,
    },
    label: normalized,
    kind: whatsappTargetKind(normalized),
    score,
    metadata: {
      normalizedTarget: normalized,
    },
  };
}

async function resolveWhatsAppSendTarget(
  runtime: IAgentRuntime,
  service: WhatsAppConnectorService,
  target: ConnectorTargetInfo
): Promise<string | null> {
  if (target.channelId?.trim()) {
    const normalized = normalizeWhatsAppConnectorTarget(target.channelId);
    const known =
      service.getKnownTarget(normalized) ?? service.findKnownChatByParticipant(normalized);
    return known?.chatId ?? (isWhatsAppAddress(normalized) ? normalized : null);
  }
  if (target.entityId?.trim()) {
    const normalized = normalizeWhatsAppConnectorTarget(target.entityId);
    const known = service.findKnownChatByParticipant(normalized);
    return known?.chatId ?? (isWhatsAppAddress(normalized) ? normalized : null);
  }
  if (target.roomId) {
    const room = await runtime.getRoom(target.roomId);
    if (room?.channelId) {
      const normalized = normalizeWhatsAppConnectorTarget(room.channelId);
      const known =
        service.getKnownTarget(normalized) ?? service.findKnownChatByParticipant(normalized);
      return known?.chatId ?? (isWhatsAppAddress(normalized) ? normalized : null);
    }
  }
  return null;
}

function extractWebhookText(message: WhatsAppIncomingMessage): string {
  if (typeof message.text?.body === "string" && message.text.body.trim()) {
    return message.text.body.trim();
  }

  if (
    typeof message.interactive?.button_reply?.title === "string" &&
    message.interactive.button_reply.title.trim()
  ) {
    return message.interactive.button_reply.title.trim();
  }

  if (
    typeof message.interactive?.list_reply?.title === "string" &&
    message.interactive.list_reply.title.trim()
  ) {
    return message.interactive.list_reply.title.trim();
  }

  if (
    typeof message.interactive?.nfm_reply?.body === "string" &&
    message.interactive.nfm_reply.body.trim()
  ) {
    return message.interactive.nfm_reply.body.trim();
  }

  if (typeof message.image?.caption === "string" && message.image.caption.trim()) {
    return message.image.caption.trim();
  }

  if (typeof message.video?.caption === "string" && message.video.caption.trim()) {
    return message.video.caption.trim();
  }

  if (typeof message.document?.caption === "string" && message.document.caption.trim()) {
    return message.document.caption.trim();
  }

  if (message.reaction?.emoji) {
    return `Reaction: ${message.reaction.emoji}`;
  }

  if (message.location) {
    const { latitude, longitude } = message.location;
    return `Location: ${latitude}, ${longitude}`;
  }

  return "";
}

export class WhatsAppConnectorService extends Service {
  static serviceType = "whatsapp";
  protected declare runtime: IAgentRuntime;

  capabilityDescription = "The agent is able to send and receive messages on whatsapp";

  public connected = false;
  public phoneNumber: string | null = null;

  private client: BaileysClient | WhatsAppClient | null = null;
  config: RuntimeServiceConfig | null = null;
  private knownTargets: Map<string, KnownWhatsAppTarget> = new Map();

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (runtime) {
      this.runtime = runtime;
    }
  }

  static async start(runtime: IAgentRuntime): Promise<WhatsAppConnectorService> {
    const service = new WhatsAppConnectorService(runtime);
    await service.initialize();
    return service;
  }

  static registerSendHandlers(runtime: IAgentRuntime, service: WhatsAppConnectorService): void {
    registerMessageConnectorIfAvailable(runtime, {
      source: "whatsapp",
      label: "WhatsApp",
      capabilities: ["send_message", "contact_resolution", "chat_context"],
      supportedTargetKinds: ["phone", "contact", "user", "group", "room"],
      contexts: ["phone", "social", "connectors"],
      description:
        "Send WhatsApp text messages through Cloud API or Baileys using phone numbers, JIDs, known contacts, or group ids.",
      metadata: {
        aliases: ["whatsapp", "wa"],
        transport: service.config?.transport ?? "unconfigured",
        connected: service.connected,
      },
      sendHandler: async (
        _runtime: IAgentRuntime,
        target: ConnectorTargetInfo,
        content: ConnectorContent
      ) => {
        const text = typeof content.text === "string" ? content.text.trim() : "";
        if (!text) {
          return;
        }

        const chatId = await resolveWhatsAppSendTarget(runtime, service, target);
        if (!chatId) {
          throw new Error("WhatsApp target is missing a phone number, JID, or chat id");
        }

        let replyToMessageId: string | undefined;
        if (typeof content.inReplyTo === "string" && content.inReplyTo.trim()) {
          const repliedToMemory = await runtime.getMemoryById(content.inReplyTo as UUID);
          const metadata = repliedToMemory?.metadata as Record<string, unknown> | undefined;
          const externalMessageId =
            metadata?.messageIdFull ?? metadata?.externalMessageId ?? metadata?.whatsappMessageId;
          if (typeof externalMessageId === "string" && externalMessageId.trim()) {
            replyToMessageId = externalMessageId.trim();
          }
        }

        for (const chunk of chunkWhatsAppText(text)) {
          await service.sendMessage({
            type: "text",
            to: chatId,
            content: chunk,
            replyToMessageId,
          });
        }
      },
      resolveTargets: async (query: string) => {
        const candidates: MessageConnectorTarget[] = [];
        for (const known of service.listKnownTargets()) {
          if (matchesQuery(query, known.label, known.chatId, known.senderId)) {
            candidates.push(knownWhatsAppTargetToConnectorTarget(known, 0.82));
          }
        }
        const direct = directWhatsAppTarget(query, 0.74);
        if (direct) candidates.push(direct);
        return candidates;
      },
      listRecentTargets: () =>
        service
          .listKnownTargets()
          .map((known) => knownWhatsAppTargetToConnectorTarget(known, 0.66)),
      listRooms: () =>
        service
          .listKnownTargets()
          .filter((known) => known.isGroup)
          .map((known) => knownWhatsAppTargetToConnectorTarget(known, 0.7)),
      getChatContext: async (
        target: ConnectorTargetInfo,
        context: MessageConnectorQueryContext
      ): Promise<MessageConnectorChatContext | null> => {
        const chatId = await resolveWhatsAppSendTarget(context.runtime, service, target);
        if (!chatId) return null;
        const known = service.getKnownTarget(chatId) ?? service.findKnownChatByParticipant(chatId);
        return {
          target,
          label: known?.label ?? chatId,
          summary: known?.isGroup ? "WhatsApp group chat." : "WhatsApp direct chat.",
          metadata: {
            chatId,
            senderId: known?.senderId,
            lastMessageAt: known?.lastMessageAt,
            connected: service.connected,
            transport: service.config?.transport,
          },
        };
      },
      getUserContext: async (
        entityId: string | UUID
      ): Promise<MessageConnectorUserContext | null> => {
        const handle = normalizeWhatsAppConnectorTarget(String(entityId));
        if (!handle) return null;
        const known = service.findKnownChatByParticipant(handle);
        return {
          entityId,
          label: known?.label ?? handle,
          aliases: known ? [known.label, known.senderId, known.chatId] : [handle],
          handles: {
            whatsapp: known?.chatId ?? handle,
            phone: normalizeWhatsAppTarget(handle) ?? handle,
          },
          metadata: {
            normalizedHandle: handle,
            chatId: known?.chatId,
          },
        };
      },
    });
  }

  async initialize(): Promise<void> {
    this.config = resolveRuntimeConfig(this.runtime);
    if (!this.config) {
      this.runtime.logger.warn(
        { src: "plugin:whatsapp", agentId: this.runtime.agentId },
        "WhatsApp connector is not configured"
      );
      return;
    }

    this.client =
      this.config.transport === "baileys"
        ? new BaileysClient({
            authMethod: "baileys",
            authDir: this.config.authDir,
            printQRInTerminal: false,
          } satisfies BaileysConfig)
        : new WhatsAppClient({
            accessToken: this.config.accessToken,
            phoneNumberId: this.config.phoneNumberId,
            webhookVerifyToken: this.config.webhookVerifyToken,
            apiVersion: this.config.apiVersion,
          } satisfies CloudAPIConfig);

    this.bindClientEvents(this.client);
    await this.client.start();

    if (this.config.transport === "cloudapi") {
      this.connected = true;
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.stop();
    }
    this.connected = false;
    this.phoneNumber = null;
  }

  async handleWebhook(event: WhatsAppWebhookEvent): Promise<void> {
    for (const entry of event.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (typeof value?.metadata?.display_phone_number === "string") {
          this.phoneNumber = value.metadata.display_phone_number;
        }

        for (const message of value?.messages ?? []) {
          await this.handleIncomingWebhookMessage(message);
        }
      }
    }
  }

  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    const expectedToken =
      this.config?.transport === "cloudapi"
        ? this.config.webhookVerifyToken
        : readStringSetting(this.runtime, "WHATSAPP_WEBHOOK_VERIFY_TOKEN");

    if (mode === "subscribe" && expectedToken && token === expectedToken && challenge) {
      return challenge;
    }

    return null;
  }

  private bindClientEvents(client: BaileysClient | WhatsAppClient): void {
    client.on("connection", (status: ConnectionStatus) => {
      this.connected = status === "open";
      if (status === "open" && client instanceof BaileysClient) {
        const nextPhone = client.getPhoneNumber();
        this.phoneNumber = (nextPhone && normalizeWhatsAppTarget(nextPhone)) ?? nextPhone;
      }
      if (status === "close") {
        this.phoneNumber = null;
      }
    });

    client.on("ready", () => {
      this.connected = true;
      if (client instanceof BaileysClient) {
        const nextPhone = client.getPhoneNumber();
        this.phoneNumber = (nextPhone && normalizeWhatsAppTarget(nextPhone)) ?? nextPhone;
      }
    });

    client.on("message", (message: NormalizedMessage) => {
      void this.handleNormalizedMessage(message).catch((error: unknown) => {
        this.runtime.logger.error(
          {
            src: "plugin:whatsapp",
            agentId: this.runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to process inbound WhatsApp message"
        );
      });
    });

    client.on("error", (error: unknown) => {
      this.runtime.logger.error(
        {
          src: "plugin:whatsapp",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "WhatsApp client error"
      );
    });
  }

  private async handleNormalizedMessage(message: NormalizedMessage): Promise<void> {
    const chatId = message.chatId ?? message.from;
    const senderId = message.senderId ?? message.from;
    const text = typeof message.content === "string" ? message.content.trim() : "";

    if (!chatId || !senderId || !text) {
      return;
    }

    await this.processIncomingMessage({
      chatId,
      senderId,
      text,
      externalMessageId: message.id,
      replyToExternalMessageId: message.replyToId,
      createdAt: toTimestampMs(message.timestamp),
    });
  }

  private async handleIncomingWebhookMessage(message: WhatsAppIncomingMessage): Promise<void> {
    const text = extractWebhookText(message);
    if (!text) {
      return;
    }

    const normalizedSender = normalizeWhatsAppTarget(message.from) ?? message.from;

    await this.processIncomingMessage({
      chatId: normalizedSender,
      senderId: normalizedSender,
      text,
      externalMessageId: message.id,
      replyToExternalMessageId: message.context?.id,
      createdAt: toTimestampMs(message.timestamp),
    });
  }

  private async processIncomingMessage(params: {
    chatId: string;
    senderId: string;
    text: string;
    externalMessageId: string;
    replyToExternalMessageId?: string;
    createdAt: number;
  }): Promise<void> {
    if (!this.runtime.messageService) {
      throw new Error("WhatsApp connector requires runtime.messageService");
    }

    const isGroup = isWhatsAppGroupJid(params.chatId);
    const normalizedSender = normalizeWhatsAppTarget(params.senderId) ?? params.senderId;

    const accountConfig = {
      dmPolicy: this.config?.dmPolicy,
      groupPolicy: this.config?.groupPolicy,
      allowFrom: this.config?.allowFrom,
      groupAllowFrom: this.config?.groupAllowFrom,
    };

    const access = await checkWhatsAppUserAccess({
      runtime: this.runtime,
      identifier: normalizedSender,
      accountConfig,
      isGroup,
      ...(isGroup ? { groupId: params.chatId } : {}),
      metadata: { senderId: normalizedSender },
    });

    if (!access.allowed) {
      if (access.replyMessage) {
        await this.sendTextMessage(params.chatId, access.replyMessage);
      }
      return;
    }

    const channelType = isGroup ? ChannelType.GROUP : ChannelType.DM;
    const roomId = createUniqueUuid(this.runtime, `whatsapp-room:${params.chatId}`) as UUID;
    const worldId = createUniqueUuid(this.runtime, `whatsapp-world:${params.chatId}`) as UUID;
    const entityId = createUniqueUuid(this.runtime, `whatsapp-entity:${normalizedSender}`) as UUID;
    const inboundMemoryId = toMemoryId(this.runtime, params.chatId, params.externalMessageId);

    await this.runtime.ensureConnection({
      entityId,
      roomId,
      userId: normalizedSender as unknown as UUID,
      userName: normalizedSender,
      name: normalizedSender,
      source: "whatsapp",
      channelId: params.chatId,
      type: channelType,
      worldId,
      worldName: resolveWhatsAppSystemLocation({
        chatType: isGroup ? "group" : "user",
        chatId: params.chatId,
      }),
    });

    this.rememberTarget({
      chatId: params.chatId,
      senderId: normalizedSender,
      label: resolveWhatsAppSystemLocation({
        chatType: isGroup ? "group" : "user",
        chatId: params.chatId,
      }),
      isGroup,
      lastMessageAt: params.createdAt,
      roomId,
    });

    const inboundMemory: Memory = {
      id: inboundMemoryId,
      entityId,
      agentId: this.runtime.agentId,
      roomId,
      content: {
        text: params.text,
        source: "whatsapp",
        channelType,
        from: normalizedSender,
        messageId: params.externalMessageId,
        ...(params.replyToExternalMessageId
          ? {
              inReplyTo: toMemoryId(this.runtime, params.chatId, params.replyToExternalMessageId),
            }
          : {}),
      },
      metadata: {
        type: "message",
        source: "whatsapp",
        provider: "whatsapp",
        timestamp: params.createdAt,
        entityName: normalizedSender,
        entityUserName: normalizedSender,
        fromBot: false,
        fromId: normalizedSender,
        sourceId: entityId,
        chatType: channelType,
        messageIdFull: params.externalMessageId,
        sender: {
          id: normalizedSender,
          name: normalizedSender,
          username: normalizedSender,
        },
        whatsapp: {
          id: normalizedSender,
          userId: normalizedSender,
          username: normalizedSender,
          userName: normalizedSender,
          name: normalizedSender,
          chatId: params.chatId,
          messageId: params.externalMessageId,
        },
        rawChatId: params.chatId,
        rawSenderId: params.senderId,
      } as unknown as Memory["metadata"],
      createdAt: params.createdAt,
    };

    const callback = async (content: Content): Promise<Memory[]> => {
      const text = typeof content.text === "string" ? content.text.trim() : "";
      if (!text) {
        return [];
      }

      const chunks = chunkWhatsAppText(text);
      const responseMemories: Memory[] = [];

      for (const [index, chunk] of chunks.entries()) {
        const response = await this.sendTextMessage(params.chatId, chunk, params.externalMessageId);
        const externalResponseId =
          response.messages?.[0]?.id ??
          `${params.externalMessageId}:response:${index}:${Date.now()}`;

        responseMemories.push({
          id: toMemoryId(this.runtime, params.chatId, externalResponseId),
          entityId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          roomId,
          content: {
            ...content,
            text: chunk,
            source: "whatsapp",
            channelType,
            inReplyTo: inboundMemoryId,
          },
          metadata: {
            type: "message",
            source: "whatsapp",
            provider: "whatsapp",
            timestamp: Date.now(),
            fromBot: true,
            fromId: this.runtime.agentId,
            sourceId: this.runtime.agentId,
            chatType: channelType,
            messageIdFull: externalResponseId,
            whatsapp: {
              chatId: params.chatId,
              messageId: externalResponseId,
            },
            rawChatId: params.chatId,
            externalMessageId: externalResponseId,
          } as unknown as Memory["metadata"],
          createdAt: Date.now(),
        });
      }

      return responseMemories;
    };

    // Inbound messages are always ingested into memory. The agent only
    // auto-generates a reply when WHATSAPP_AUTO_REPLY is explicitly enabled —
    // default-off prevents the runtime from speaking on the user's behalf to
    // real WhatsApp contacts.
    const autoReplyRaw = this.runtime.getSetting("WHATSAPP_AUTO_REPLY");
    const autoReply =
      !lifeOpsPassiveConnectorsEnabled(this.runtime) &&
      (autoReplyRaw === true || autoReplyRaw === "true");

    if (!autoReply) {
      await this.runtime.createMemory(inboundMemory, "messages");
      return;
    }

    await this.runtime.messageService.handleMessage(this.runtime, inboundMemory, callback);
  }

  private async sendTextMessage(
    chatId: string,
    text: string,
    replyToMessageId?: string
  ): Promise<WhatsAppMessageResponse> {
    if (!this.client || !this.config) {
      throw new Error("WhatsApp client is not initialized");
    }

    const response = await this.client.sendMessage({
      type: "text",
      to:
        this.config.transport === "baileys"
          ? normalizeBaileysSendTarget(chatId)
          : (normalizeWhatsAppTarget(chatId) ?? chatId),
      content: text,
      replyToMessageId,
    });

    return "data" in response
      ? (response.data as WhatsAppMessageResponse)
      : (response as WhatsAppMessageResponse);
  }

  async sendMessage(message: {
    type: "text";
    to: string;
    content: string;
    replyToMessageId?: string;
  }): Promise<WhatsAppMessageResponse> {
    return this.sendTextMessage(message.to, message.content, message.replyToMessageId);
  }

  listKnownTargets(): KnownWhatsAppTarget[] {
    return Array.from(this.knownTargets.values()).sort(
      (left, right) => right.lastMessageAt - left.lastMessageAt
    );
  }

  getKnownTarget(chatId: string): KnownWhatsAppTarget | null {
    return this.knownTargets.get(normalizeWhatsAppConnectorTarget(chatId)) ?? null;
  }

  findKnownChatByParticipant(participant: string): KnownWhatsAppTarget | null {
    const normalized = normalizeWhatsAppConnectorTarget(participant);
    for (const target of this.knownTargets.values()) {
      if (
        normalizeWhatsAppConnectorTarget(target.senderId) === normalized ||
        normalizeWhatsAppConnectorTarget(target.chatId) === normalized
      ) {
        return target;
      }
    }
    return null;
  }

  private rememberTarget(target: KnownWhatsAppTarget): void {
    this.knownTargets.set(normalizeWhatsAppConnectorTarget(target.chatId), target);
  }
}
