import {
  ChannelType,
  type Content,
  createUniqueUuid,
  type IAgentRuntime,
  lifeOpsPassiveConnectorsEnabled,
  type Memory,
  type Room,
  Service,
  type UUID,
} from "@elizaos/core";
import {
  checkWhatsAppUserAccess,
  DEFAULT_ACCOUNT_ID,
  getMultiAccountConfig,
  listWhatsAppAccountIds,
  normalizeAccountId as normalizeWhatsAppAccountId,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  type WhatsAppAccountRuntimeConfig,
} from "./accounts";
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
      accountId: string;
      name?: string;
      transport: "baileys";
      authDir: string;
      dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
      groupPolicy?: "open" | "allowlist" | "disabled";
      allowFrom?: string[];
      groupAllowFrom?: string[];
    }
  | {
      accountId: string;
      name?: string;
      transport: "cloudapi";
      accessToken: string;
      phoneNumberId: string;
      businessAccountId?: string;
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
      accountId: DEFAULT_ACCOUNT_ID,
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
      accountId: DEFAULT_ACCOUNT_ID,
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

function configuredAccountForId(
  config: ReturnType<typeof getMultiAccountConfig>,
  accountId: string
): WhatsAppAccountRuntimeConfig {
  const normalized = normalizeWhatsAppAccountId(accountId);
  const accountConfig =
    config.accounts?.[accountId] ??
    Object.entries(config.accounts ?? {}).find(
      ([key]) => normalizeWhatsAppAccountId(key) === normalized
    )?.[1] ??
    {};
  return {
    ...config,
    accounts: undefined,
    groups: undefined,
    ...accountConfig,
  } as WhatsAppAccountRuntimeConfig;
}

function resolveRuntimeConfigs(runtime: IAgentRuntime): RuntimeServiceConfig[] {
  const multiConfig = getMultiAccountConfig(runtime);
  const accountIds = listWhatsAppAccountIds(runtime);
  const configs: RuntimeServiceConfig[] = [];

  for (const accountId of accountIds) {
    const normalizedAccountId = normalizeWhatsAppAccountId(accountId);
    const accountConfig = configuredAccountForId(multiConfig, normalizedAccountId);
    const authDir = accountConfig.authDir?.trim();
    const transport = accountConfig.transport ?? (authDir ? "baileys" : "cloudapi");

    if (transport === "baileys" && authDir) {
      configs.push({
        accountId: normalizedAccountId,
        name: accountConfig.name?.trim() || undefined,
        transport: "baileys",
        authDir,
        dmPolicy: accountConfig.dmPolicy,
        groupPolicy: accountConfig.groupPolicy,
        allowFrom: accountConfig.allowFrom?.map(String),
        groupAllowFrom: accountConfig.groupAllowFrom?.map(String),
      });
      continue;
    }

    const cloud = resolveWhatsAppAccount(runtime, normalizedAccountId);
    if (cloud.enabled && cloud.configured) {
      configs.push({
        accountId: normalizedAccountId,
        name: cloud.name,
        transport: "cloudapi",
        accessToken: cloud.accessToken,
        phoneNumberId: cloud.phoneNumberId,
        businessAccountId: cloud.businessAccountId,
        webhookVerifyToken: cloud.config.webhookVerifyToken,
        apiVersion: cloud.config.apiVersion,
        dmPolicy: cloud.config.dmPolicy,
        groupPolicy: cloud.config.groupPolicy,
        allowFrom: cloud.config.allowFrom?.map(String),
        groupAllowFrom: cloud.config.groupAllowFrom?.map(String),
      });
    }
  }

  if (configs.length > 0) {
    return configs;
  }

  const legacy = resolveRuntimeConfig(runtime);
  return legacy ? [legacy] : [];
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
type AccountTargetInfo = ConnectorTargetInfo & { accountId?: string };
type AccountQueryContext = MessageConnectorQueryContext & { accountId?: string };

function readTargetAccountId(target?: ConnectorTargetInfo | null): string | undefined {
  return (target as AccountTargetInfo | undefined)?.accountId;
}

function readContextAccountId(context?: MessageConnectorQueryContext | null): string | undefined {
  return (context as AccountQueryContext | undefined)?.accountId;
}

function targetWithAccount(
  target: Partial<ConnectorTargetInfo>,
  accountId: string
): ConnectorTargetInfo {
  return { ...target, accountId } as ConnectorTargetInfo;
}

type ConnectorFetchMessagesParams = {
  target?: ConnectorTargetInfo;
  limit?: number;
  before?: string;
  after?: string;
  channelId?: string;
  roomId?: UUID;
};

type ConnectorSearchMessagesParams = ConnectorFetchMessagesParams & {
  query?: string;
};

type ConnectorReactionParams = {
  target?: ConnectorTargetInfo;
  channelId?: string;
  roomId?: UUID;
  messageId?: string;
  emoji?: string;
  remove?: boolean;
};

type ConnectorUserLookupParams = {
  userId?: string;
  username?: string;
  handle?: string;
  query?: string;
};

type ExtendedMessageConnectorRegistration = MessageConnectorRegistration & {
  fetchMessages?: (
    context: MessageConnectorQueryContext,
    params: ConnectorFetchMessagesParams
  ) => Promise<Memory[]>;
  searchMessages?: (
    context: MessageConnectorQueryContext,
    params: ConnectorSearchMessagesParams
  ) => Promise<Memory[]>;
  reactHandler?: (runtime: IAgentRuntime, params: ConnectorReactionParams) => Promise<void>;
  getUser?: (runtime: IAgentRuntime, params: ConnectorUserLookupParams) => Promise<unknown>;
};

type KnownWhatsAppTarget = {
  accountId: string;
  chatId: string;
  senderId: string;
  label: string;
  isGroup: boolean;
  lastMessageAt: number;
  roomId?: UUID;
};

function registerMessageConnectorIfAvailable(
  runtime: IAgentRuntime,
  registration: ExtendedMessageConnectorRegistration
): void {
  const withRegistry = runtime as RuntimeWithOptionalConnectorRegistry;
  if (typeof withRegistry.registerMessageConnector === "function") {
    withRegistry.registerMessageConnector(registration);
    return;
  }
  if (registration.sendHandler) {
    runtime.registerSendHandler(registration.source, registration.sendHandler);
  }
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
  const accountId = known.accountId ?? DEFAULT_ACCOUNT_ID;
  return {
    target: targetWithAccount(
      {
        source: "whatsapp",
        channelId: known.chatId,
        entityId: known.senderId,
        roomId: known.roomId,
      },
      accountId
    ),
    label: known.label,
    kind: known.isGroup ? "group" : whatsappTargetKind(known.senderId),
    description: known.isGroup ? "WhatsApp group chat" : "WhatsApp contact",
    score,
    metadata: {
      accountId,
      chatId: known.chatId,
      senderId: known.senderId,
      lastMessageAt: known.lastMessageAt,
    },
  };
}

function directWhatsAppTarget(
  value: string,
  accountId = DEFAULT_ACCOUNT_ID,
  score = 0.68
): MessageConnectorTarget | null {
  const normalized = normalizeWhatsAppConnectorTarget(value);
  if (!normalized || !isWhatsAppAddress(normalized)) return null;
  return {
    target: targetWithAccount(
      {
        source: "whatsapp",
        channelId: normalized,
        entityId: normalized,
      },
      accountId
    ),
    label: normalized,
    kind: whatsappTargetKind(normalized),
    score,
    metadata: {
      accountId,
      normalizedTarget: normalized,
    },
  };
}

type ResolvedWhatsAppSendTarget = {
  accountId: string;
  chatId: string;
};

async function resolveWhatsAppSendTarget(
  runtime: IAgentRuntime,
  service: WhatsAppConnectorService,
  target: ConnectorTargetInfo,
  fallbackAccountId?: string
): Promise<ResolvedWhatsAppSendTarget | null> {
  const targetAccountId =
    typeof service.resolveAccountId === "function"
      ? service.resolveAccountId(readTargetAccountId(target) ?? fallbackAccountId)
      : normalizeWhatsAppAccountId(readTargetAccountId(target) ?? fallbackAccountId);
  if (target.channelId?.trim()) {
    const normalized = normalizeWhatsAppConnectorTarget(target.channelId);
    const known =
      service.getKnownTarget(normalized, targetAccountId) ??
      service.findKnownChatByParticipant(normalized, targetAccountId);
    if (known) {
      return { accountId: known.accountId ?? targetAccountId, chatId: known.chatId };
    }
    return isWhatsAppAddress(normalized)
      ? { accountId: targetAccountId, chatId: normalized }
      : null;
  }
  if (target.entityId?.trim()) {
    const normalized = normalizeWhatsAppConnectorTarget(target.entityId);
    const known = service.findKnownChatByParticipant(normalized, targetAccountId);
    if (known) {
      return { accountId: known.accountId ?? targetAccountId, chatId: known.chatId };
    }
    return isWhatsAppAddress(normalized)
      ? { accountId: targetAccountId, chatId: normalized }
      : null;
  }
  if (target.roomId) {
    const room = await runtime.getRoom(target.roomId);
    if (room?.channelId) {
      const normalized = normalizeWhatsAppConnectorTarget(room.channelId);
      const known =
        service.getKnownTarget(normalized, targetAccountId) ??
        service.findKnownChatByParticipant(normalized, targetAccountId);
      if (known) {
        return { accountId: known.accountId ?? targetAccountId, chatId: known.chatId };
      }
      return isWhatsAppAddress(normalized)
        ? { accountId: targetAccountId, chatId: normalized }
        : null;
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

  private defaultAccountId = DEFAULT_ACCOUNT_ID;
  private clients: Map<string, BaileysClient | WhatsAppClient> = new Map();
  private configs: Map<string, RuntimeServiceConfig> = new Map();
  private phoneNumbers: Map<string, string> = new Map();
  private client: BaileysClient | WhatsAppClient | null = null;
  config: RuntimeServiceConfig | undefined = undefined;
  private knownTargets: Map<string, KnownWhatsAppTarget> = new Map();

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (runtime) {
      this.runtime = runtime;
    }
  }

  resolveAccountId(accountId?: string | null): string {
    return normalizeWhatsAppAccountId(accountId ?? this.defaultAccountId);
  }

  private getClientForAccount(accountId?: string | null): BaileysClient | WhatsAppClient | null {
    const normalizedAccountId = this.resolveAccountId(accountId);
    return (
      this.clients.get(normalizedAccountId) ??
      (normalizedAccountId === this.defaultAccountId ? this.client : null)
    );
  }

  private getConfigForAccount(accountId?: string | null): RuntimeServiceConfig | null {
    const normalizedAccountId = this.resolveAccountId(accountId);
    return (
      this.configs.get(normalizedAccountId) ??
      (normalizedAccountId === this.defaultAccountId ? (this.config ?? null) : null)
    );
  }

  private getConnectorAccountIds(): string[] {
    const ids = Array.from(this.configs.keys());
    return ids.length > 0 ? ids : [this.defaultAccountId];
  }

  private targetKey(chatId: string, accountId?: string | null): string {
    return `${this.resolveAccountId(accountId)}:${normalizeWhatsAppConnectorTarget(chatId)}`;
  }

  private roomIdFor(chatId: string, accountId?: string | null): UUID {
    const normalizedAccountId = this.resolveAccountId(accountId);
    return createUniqueUuid(
      this.runtime,
      normalizedAccountId === DEFAULT_ACCOUNT_ID
        ? `whatsapp-room:${chatId}`
        : `whatsapp-room:${normalizedAccountId}:${chatId}`
    ) as UUID;
  }

  private entityIdFor(senderId: string, accountId?: string | null): UUID {
    const normalizedAccountId = this.resolveAccountId(accountId);
    return createUniqueUuid(
      this.runtime,
      normalizedAccountId === DEFAULT_ACCOUNT_ID
        ? `whatsapp-entity:${senderId}`
        : `whatsapp-entity:${normalizedAccountId}:${senderId}`
    ) as UUID;
  }

  private worldIdFor(chatId: string, accountId?: string | null): UUID {
    const normalizedAccountId = this.resolveAccountId(accountId);
    return createUniqueUuid(
      this.runtime,
      normalizedAccountId === DEFAULT_ACCOUNT_ID
        ? `whatsapp-world:${chatId}`
        : `whatsapp-world:${normalizedAccountId}:${chatId}`
    ) as UUID;
  }

  private metadataMatchesAccount(memory: Memory, accountId: string): boolean {
    const metadata = memory.metadata as Record<string, unknown> | undefined;
    const memoryAccountId =
      typeof metadata?.accountId === "string" && metadata.accountId.trim()
        ? this.resolveAccountId(metadata.accountId)
        : undefined;
    return memoryAccountId ? memoryAccountId === accountId : accountId === DEFAULT_ACCOUNT_ID;
  }

  static async start(runtime: IAgentRuntime): Promise<WhatsAppConnectorService> {
    const service = new WhatsAppConnectorService(runtime);
    await service.initialize();
    return service;
  }

  static registerSendHandlers(runtime: IAgentRuntime, service: WhatsAppConnectorService): void {
    const resolveServiceAccountId = (accountId?: string | null): string =>
      typeof service.resolveAccountId === "function"
        ? service.resolveAccountId(accountId)
        : normalizeWhatsAppAccountId(accountId);
    const getServiceConfigForAccount = (accountId?: string | null): RuntimeServiceConfig | null =>
      typeof service.getConfigForAccount === "function"
        ? service.getConfigForAccount(accountId)
        : (service.config ?? null);
    const accountIds =
      typeof service.getConnectorAccountIds === "function"
        ? service.getConnectorAccountIds()
        : [DEFAULT_ACCOUNT_ID];
    const registrationAccountIds =
      accountIds.length > 1 ? accountIds : [undefined as string | undefined];

    for (const registrationAccountId of registrationAccountIds) {
      const connectorAccountId = resolveServiceAccountId(registrationAccountId);
      const config = getServiceConfigForAccount(connectorAccountId);
      registerMessageConnectorIfAvailable(runtime, {
        source: "whatsapp",
        ...(registrationAccountId ? { accountId: connectorAccountId } : {}),
        label:
          registrationAccountId && connectorAccountId !== DEFAULT_ACCOUNT_ID
            ? `WhatsApp (${connectorAccountId})`
            : "WhatsApp",
        capabilities: [
          "send_message",
          "read_messages",
          "search_messages",
          "send_reaction",
          "contact_resolution",
          "chat_context",
          "get_user",
        ],
        supportedTargetKinds: ["phone", "contact", "user", "group", "room"],
        contexts: ["phone", "social", "connectors"],
        description:
          "Send, read, search, and react in WhatsApp conversations through Cloud API or Baileys using phone numbers, JIDs, known contacts, or group ids.",
        metadata: {
          aliases: ["whatsapp", "wa"],
          accountId: connectorAccountId,
          transport: config?.transport ?? service.config?.transport ?? "unconfigured",
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

          const resolved = await resolveWhatsAppSendTarget(
            runtime,
            service,
            target,
            connectorAccountId
          );
          if (!resolved) {
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
              accountId: resolved.accountId,
              type: "text",
              to: resolved.chatId,
              content: chunk,
              replyToMessageId,
            });
          }
        },
        resolveTargets: async (query: string) => {
          const candidates: MessageConnectorTarget[] = [];
          for (const known of service.listKnownTargets(connectorAccountId)) {
            if (matchesQuery(query, known.label, known.chatId, known.senderId)) {
              candidates.push(knownWhatsAppTargetToConnectorTarget(known, 0.82));
            }
          }
          const direct = directWhatsAppTarget(query, connectorAccountId, 0.74);
          if (direct) candidates.push(direct);
          return candidates;
        },
        listRecentTargets: () =>
          service
            .listKnownTargets(connectorAccountId)
            .map((known) => knownWhatsAppTargetToConnectorTarget(known, 0.66)),
        listRooms: () =>
          service
            .listKnownTargets(connectorAccountId)
            .filter((known) => known.isGroup)
            .map((known) => knownWhatsAppTargetToConnectorTarget(known, 0.7)),
        fetchMessages: service.fetchConnectorMessages.bind(service),
        searchMessages: service.searchConnectorMessages.bind(service),
        reactHandler: service.reactConnectorMessage.bind(service),
        getUser: service.getConnectorUser.bind(service),
        getChatContext: async (
          target: ConnectorTargetInfo,
          context: MessageConnectorQueryContext
        ): Promise<MessageConnectorChatContext | null> => {
          const resolved = await resolveWhatsAppSendTarget(
            context.runtime,
            service,
            target,
            readContextAccountId(context) ?? connectorAccountId
          );
          if (!resolved) return null;
          const known =
            service.getKnownTarget(resolved.chatId, resolved.accountId) ??
            service.findKnownChatByParticipant(resolved.chatId, resolved.accountId);
          const resolvedConfig = getServiceConfigForAccount(resolved.accountId);
          return {
            target: targetWithAccount(
              { ...target, channelId: resolved.chatId },
              resolved.accountId
            ),
            label: known?.label ?? resolved.chatId,
            summary: known?.isGroup ? "WhatsApp group chat." : "WhatsApp direct chat.",
            metadata: {
              accountId: resolved.accountId,
              chatId: resolved.chatId,
              senderId: known?.senderId,
              lastMessageAt: known?.lastMessageAt,
              connected: service.connected,
              transport: resolvedConfig?.transport,
            },
          };
        },
        getUserContext: async (
          entityId: string | UUID
        ): Promise<MessageConnectorUserContext | null> => {
          const handle = normalizeWhatsAppConnectorTarget(String(entityId));
          if (!handle) return null;
          const known = service.findKnownChatByParticipant(handle, connectorAccountId);
          return {
            entityId,
            label: known?.label ?? handle,
            aliases: known ? [known.label, known.senderId, known.chatId] : [handle],
            handles: {
              whatsapp: known?.chatId ?? handle,
              phone: normalizeWhatsAppTarget(handle) ?? handle,
            },
            metadata: {
              accountId: known?.accountId ?? connectorAccountId,
              normalizedHandle: handle,
              chatId: known?.chatId,
            },
          };
        },
      });
    }
  }

  async initialize(): Promise<void> {
    this.defaultAccountId = resolveDefaultWhatsAppAccountId(this.runtime);
    const configs = resolveRuntimeConfigs(this.runtime);
    if (configs.length === 0) {
      this.runtime.logger.warn(
        { src: "plugin:whatsapp", agentId: this.runtime.agentId },
        "WhatsApp connector is not configured"
      );
      return;
    }

    for (const config of configs) {
      const client =
        config.transport === "baileys"
          ? new BaileysClient({
              authMethod: "baileys",
              authDir: config.authDir,
              printQRInTerminal: false,
            } satisfies BaileysConfig)
          : new WhatsAppClient({
              accessToken: config.accessToken,
              phoneNumberId: config.phoneNumberId,
              webhookVerifyToken: config.webhookVerifyToken,
              apiVersion: config.apiVersion,
            } satisfies CloudAPIConfig);

      this.configs.set(config.accountId, config);
      this.clients.set(config.accountId, client);
      if (config.accountId === this.defaultAccountId || !this.client) {
        this.config = config;
        this.client = client;
      }

      this.bindClientEvents(client, config.accountId);
      await client.start();

      if (config.transport === "cloudapi") {
        this.connected = true;
      }
    }
  }

  async stop(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.stop();
    }
    this.clients.clear();
    this.configs.clear();
    this.phoneNumbers.clear();
    this.client = null;
    this.config = undefined;
    this.connected = false;
    this.phoneNumber = null;
  }

  async handleWebhook(event: WhatsAppWebhookEvent): Promise<void> {
    for (const entry of event.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const accountId = this.resolveWebhookAccountId(value?.metadata?.phone_number_id);
        if (typeof value?.metadata?.display_phone_number === "string") {
          this.phoneNumbers.set(accountId, value.metadata.display_phone_number);
          if (accountId === this.defaultAccountId) {
            this.phoneNumber = value.metadata.display_phone_number;
          }
        }

        for (const message of value?.messages ?? []) {
          await this.handleIncomingWebhookMessage(message, accountId);
        }
      }
    }
  }

  verifyWebhook(mode: string, token: string, challenge: string, accountId?: string): string | null {
    const configs = accountId
      ? [this.getConfigForAccount(accountId)].filter((config): config is RuntimeServiceConfig =>
          Boolean(config)
        )
      : Array.from(this.configs.values());
    const expectedTokens =
      configs.length > 0
        ? configs
            .filter((config) => config.transport === "cloudapi")
            .map((config) => config.webhookVerifyToken)
        : [
            this.config?.transport === "cloudapi"
              ? this.config.webhookVerifyToken
              : readStringSetting(this.runtime, "WHATSAPP_WEBHOOK_VERIFY_TOKEN"),
          ];

    if (
      mode === "subscribe" &&
      challenge &&
      expectedTokens.some((expectedToken) => expectedToken && token === expectedToken)
    ) {
      return challenge;
    }

    return null;
  }

  private resolveWebhookAccountId(phoneNumberId?: string | null): string {
    const normalizedPhoneNumberId =
      typeof phoneNumberId === "string" && phoneNumberId.trim() ? phoneNumberId.trim() : undefined;
    if (normalizedPhoneNumberId) {
      for (const [accountId, config] of this.configs) {
        if (config.transport === "cloudapi" && config.phoneNumberId === normalizedPhoneNumberId) {
          return accountId;
        }
      }
    }
    return this.defaultAccountId;
  }

  private bindClientEvents(client: BaileysClient | WhatsAppClient, accountId: string): void {
    client.on("connection", (status: ConnectionStatus) => {
      if (status === "open") {
        this.connected = true;
      }
      if (status === "open" && client instanceof BaileysClient) {
        const nextPhone = client.getPhoneNumber();
        const normalizedPhone = (nextPhone && normalizeWhatsAppTarget(nextPhone)) ?? nextPhone;
        if (normalizedPhone) {
          this.phoneNumbers.set(accountId, normalizedPhone);
        }
        if (accountId === this.defaultAccountId) {
          this.phoneNumber = normalizedPhone;
        }
      }
      if (status === "close") {
        this.phoneNumbers.delete(accountId);
        this.connected =
          this.phoneNumbers.size > 0 ||
          Array.from(this.configs.values()).some((config) => config.transport === "cloudapi");
        if (accountId === this.defaultAccountId) {
          this.phoneNumber = null;
        }
      }
    });

    client.on("ready", () => {
      this.connected = true;
      if (client instanceof BaileysClient) {
        const nextPhone = client.getPhoneNumber();
        const normalizedPhone = (nextPhone && normalizeWhatsAppTarget(nextPhone)) ?? nextPhone;
        if (normalizedPhone) {
          this.phoneNumbers.set(accountId, normalizedPhone);
        }
        if (accountId === this.defaultAccountId) {
          this.phoneNumber = normalizedPhone;
        }
      }
    });

    client.on("message", (message: NormalizedMessage) => {
      void this.handleNormalizedMessage(message, accountId).catch((error: unknown) => {
        this.runtime.logger.error(
          {
            src: "plugin:whatsapp",
            agentId: this.runtime.agentId,
            accountId,
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
          accountId,
          error: error instanceof Error ? error.message : String(error),
        },
        "WhatsApp client error"
      );
    });
  }

  private async handleNormalizedMessage(
    message: NormalizedMessage,
    accountId = this.defaultAccountId
  ): Promise<void> {
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
      accountId,
    });
  }

  private async handleIncomingWebhookMessage(
    message: WhatsAppIncomingMessage,
    accountId = this.defaultAccountId
  ): Promise<void> {
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
      accountId,
    });
  }

  private async processIncomingMessage(params: {
    accountId: string;
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

    const accountId = this.resolveAccountId(params.accountId);
    const config = this.getConfigForAccount(accountId);
    const isGroup = isWhatsAppGroupJid(params.chatId);
    const normalizedSender = normalizeWhatsAppTarget(params.senderId) ?? params.senderId;

    const accountConfig = {
      dmPolicy: config?.dmPolicy,
      groupPolicy: config?.groupPolicy,
      allowFrom: config?.allowFrom,
      groupAllowFrom: config?.groupAllowFrom,
    };

    const access = await checkWhatsAppUserAccess({
      runtime: this.runtime,
      identifier: normalizedSender,
      accountConfig,
      isGroup,
      ...(isGroup ? { groupId: params.chatId } : {}),
      metadata: { accountId, senderId: normalizedSender },
    });

    if (!access.allowed) {
      if (access.replyMessage) {
        await this.sendTextMessage(params.chatId, access.replyMessage, undefined, accountId);
      }
      return;
    }

    const channelType = isGroup ? ChannelType.GROUP : ChannelType.DM;
    const roomId = this.roomIdFor(params.chatId, accountId);
    const worldId = this.worldIdFor(params.chatId, accountId);
    const entityId = this.entityIdFor(normalizedSender, accountId);
    const inboundMemoryId = toMemoryId(
      this.runtime,
      accountId === DEFAULT_ACCOUNT_ID ? params.chatId : `${accountId}:${params.chatId}`,
      params.externalMessageId
    );

    await this.runtime.ensureConnection({
      entityId,
      roomId,
      userId: normalizedSender,
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
      metadata: {
        accountId,
        chatId: params.chatId,
        isGroup,
      },
    });
    if (typeof this.runtime.ensureRoomExists === "function") {
      await this.runtime.ensureRoomExists({
        id: roomId,
        name: resolveWhatsAppSystemLocation({
          chatType: isGroup ? "group" : "user",
          chatId: params.chatId,
        }),
        agentId: this.runtime.agentId,
        source: "whatsapp",
        type: channelType,
        channelId: params.chatId,
        worldId,
        metadata: {
          accountId,
          chatId: params.chatId,
          isGroup,
        },
      } as Room);
    }

    this.rememberTarget({
      accountId,
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
              inReplyTo: toMemoryId(
                this.runtime,
                accountId === DEFAULT_ACCOUNT_ID ? params.chatId : `${accountId}:${params.chatId}`,
                params.replyToExternalMessageId
              ),
            }
          : {}),
      },
      metadata: {
        type: "message",
        source: "whatsapp",
        provider: "whatsapp",
        accountId,
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
          contactId: normalizedSender,
          messageId: params.externalMessageId,
        },
        rawChatId: params.chatId,
        rawSenderId: params.senderId,
      } satisfies Memory["metadata"],
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
        const response = await this.sendTextMessage(
          params.chatId,
          chunk,
          params.externalMessageId,
          accountId
        );
        const externalResponseId =
          response.messages?.[0]?.id ??
          `${params.externalMessageId}:response:${index}:${Date.now()}`;

        responseMemories.push({
          id: toMemoryId(
            this.runtime,
            accountId === DEFAULT_ACCOUNT_ID ? params.chatId : `${accountId}:${params.chatId}`,
            externalResponseId
          ),
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
            accountId,
            timestamp: Date.now(),
            fromBot: true,
            fromId: this.runtime.agentId,
            sourceId: this.runtime.agentId,
            chatType: channelType,
            messageIdFull: externalResponseId,
            whatsapp: {
              contactId: params.chatId,
              messageId: externalResponseId,
            },
            rawChatId: params.chatId,
            externalMessageId: externalResponseId,
          } satisfies Memory["metadata"],
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
    replyToMessageId?: string,
    accountId?: string
  ): Promise<WhatsAppMessageResponse> {
    const normalizedAccountId = this.resolveAccountId(accountId);
    const client = this.getClientForAccount(normalizedAccountId);
    const config = this.getConfigForAccount(normalizedAccountId);
    if (!client || !config) {
      throw new Error("WhatsApp client is not initialized");
    }

    const response = await client.sendMessage({
      type: "text",
      to:
        config.transport === "baileys"
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
    accountId?: string;
    type: "text";
    to: string;
    content: string;
    replyToMessageId?: string;
  }): Promise<WhatsAppMessageResponse> {
    return this.sendTextMessage(
      message.to,
      message.content,
      message.replyToMessageId,
      message.accountId
    );
  }

  async fetchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: ConnectorFetchMessagesParams
  ): Promise<Memory[]> {
    if (typeof this.runtime.getMemoriesByRoomIds !== "function") {
      return [];
    }

    const target = params.target ?? (context.target as ConnectorTargetInfo | undefined);
    let accountId = this.resolveAccountId(
      readTargetAccountId(target) ?? readContextAccountId(context)
    );
    let chatId = params.channelId;
    if (!chatId && target) {
      const resolved = await resolveWhatsAppSendTarget(context.runtime, this, target, accountId);
      if (resolved) {
        accountId = resolved.accountId;
        chatId = resolved.chatId;
      }
    }
    if (!chatId && params.roomId) {
      const room = await context.runtime.getRoom(params.roomId);
      chatId = room?.channelId;
      const metadata = room?.metadata as Record<string, unknown> | undefined;
      if (typeof metadata?.accountId === "string") {
        accountId = this.resolveAccountId(metadata.accountId);
      }
    }

    const knownTargets = chatId
      ? [
          this.getKnownTarget(chatId, accountId) ??
            this.findKnownChatByParticipant(chatId, accountId) ?? {
              accountId,
              chatId,
              senderId: chatId,
              label: chatId,
              isGroup: isWhatsAppGroupJid(chatId),
              lastMessageAt: 0,
              roomId: this.roomIdFor(chatId, accountId),
            },
        ]
      : this.listKnownTargets(accountId);

    const roomIds = knownTargets
      .map((known) => known.roomId ?? this.roomIdFor(known.chatId, known.accountId))
      .filter((roomId): roomId is UUID => Boolean(roomId));
    if (roomIds.length === 0) {
      return [];
    }

    const limit = Number.isFinite(params.limit)
      ? Math.max(1, Math.min(Number(params.limit), 100))
      : 25;
    const memories = await this.runtime.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds,
      limit: limit * Math.max(roomIds.length, 1),
    });
    const chatIds = new Set(
      knownTargets.map((known) => normalizeWhatsAppConnectorTarget(known.chatId))
    );
    const before = params.before ? Number(params.before) : undefined;
    const after = params.after ? Number(params.after) : undefined;

    return memories
      .filter((memory) => memory.content?.source === "whatsapp")
      .filter((memory) => this.metadataMatchesAccount(memory, accountId))
      .filter((memory) => {
        const metadata = memory.metadata as Record<string, unknown> | undefined;
        const rawChatId =
          typeof metadata?.rawChatId === "string"
            ? normalizeWhatsAppConnectorTarget(metadata.rawChatId)
            : undefined;
        if (chatId && rawChatId && !chatIds.has(rawChatId)) {
          return false;
        }
        const createdAt = Number(memory.createdAt ?? 0);
        if (before !== undefined && Number.isFinite(before) && createdAt >= before) {
          return false;
        }
        if (after !== undefined && Number.isFinite(after) && createdAt <= after) {
          return false;
        }
        return true;
      })
      .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0))
      .slice(0, limit);
  }

  async searchConnectorMessages(
    context: MessageConnectorQueryContext,
    params: ConnectorSearchMessagesParams
  ): Promise<Memory[]> {
    const query = params.query?.trim().toLowerCase();
    if (!query) {
      return [];
    }
    const memories = await this.fetchConnectorMessages(context, {
      ...params,
      limit: Math.max(params.limit ?? 100, 100),
    });
    return memories
      .filter((memory) => {
        const text = String(memory.content?.text ?? "").toLowerCase();
        const from = String(memory.content?.from ?? "").toLowerCase();
        return text.includes(query) || from.includes(query);
      })
      .slice(0, params.limit ?? 25);
  }

  async reactConnectorMessage(
    runtime: IAgentRuntime,
    params: ConnectorReactionParams
  ): Promise<void> {
    const target = params.target;
    const resolved = target
      ? await resolveWhatsAppSendTarget(runtime, this, target)
      : params.channelId
        ? { accountId: this.defaultAccountId, chatId: params.channelId }
        : null;
    const accountId = this.resolveAccountId(resolved?.accountId ?? readTargetAccountId(target));
    const client = this.getClientForAccount(accountId);
    const config = this.getConfigForAccount(accountId);
    if (!client || !config) {
      throw new Error("WhatsApp client is not initialized");
    }
    const chatId =
      params.channelId ??
      resolved?.chatId ??
      (params.roomId ? (await runtime.getRoom(params.roomId))?.channelId : undefined);
    if (!chatId) {
      throw new Error("WhatsApp reaction requires a target chat.");
    }
    if (!params.messageId) {
      throw new Error("WhatsApp reaction requires messageId.");
    }

    await client.sendMessage({
      type: "reaction",
      to:
        config.transport === "baileys"
          ? normalizeBaileysSendTarget(chatId)
          : (normalizeWhatsAppTarget(chatId) ?? chatId),
      content: {
        messageId: params.messageId,
        emoji: params.remove ? "" : params.emoji || "👍",
      },
    });
  }

  async getConnectorUser(
    _runtime: IAgentRuntime,
    params: ConnectorUserLookupParams
  ): Promise<unknown> {
    const lookup = params.userId ?? params.handle ?? params.username ?? params.query;
    if (!lookup) {
      return null;
    }
    const normalized = normalizeWhatsAppConnectorTarget(lookup);
    const known = this.findKnownChatByParticipant(normalized) ?? this.getKnownTarget(normalized);
    if (!known) {
      return null;
    }
    return {
      id: this.entityIdFor(known.senderId, known.accountId),
      agentId: this.runtime.agentId,
      names: [known.label, known.senderId, known.chatId].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      ),
      metadata: {
        accountId: known.accountId,
        source: "whatsapp",
        whatsapp: {
          accountId: known.accountId,
          chatId: known.chatId,
          senderId: known.senderId,
          isGroup: known.isGroup,
        },
      },
    };
  }

  listKnownTargets(accountId?: string | null): KnownWhatsAppTarget[] {
    const normalizedAccountId = accountId ? this.resolveAccountId(accountId) : null;
    return Array.from(this.knownTargets.values())
      .filter((target) => !normalizedAccountId || target.accountId === normalizedAccountId)
      .sort((left, right) => right.lastMessageAt - left.lastMessageAt);
  }

  getKnownTarget(chatId: string, accountId?: string | null): KnownWhatsAppTarget | null {
    const normalized = normalizeWhatsAppConnectorTarget(chatId);
    if (accountId) {
      return this.knownTargets.get(this.targetKey(normalized, accountId)) ?? null;
    }
    return (
      this.knownTargets.get(this.targetKey(normalized, this.defaultAccountId)) ??
      Array.from(this.knownTargets.values()).find(
        (target) => normalizeWhatsAppConnectorTarget(target.chatId) === normalized
      ) ??
      null
    );
  }

  findKnownChatByParticipant(
    participant: string,
    accountId?: string | null
  ): KnownWhatsAppTarget | null {
    const normalized = normalizeWhatsAppConnectorTarget(participant);
    const normalizedAccountId = accountId ? this.resolveAccountId(accountId) : null;
    for (const target of this.knownTargets.values()) {
      if (normalizedAccountId && target.accountId !== normalizedAccountId) {
        continue;
      }
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
    this.knownTargets.set(this.targetKey(target.chatId, target.accountId), {
      ...target,
      accountId: this.resolveAccountId(target.accountId),
    });
  }
}
