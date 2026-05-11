/**
 * iMessage service implementation for elizaOS.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { promisify } from "node:util";
import {
  ChannelType,
  type Content,
  ContentType,
  createUniqueUuid,
  type Entity,
  type EventPayload,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  lifeOpsPassiveConnectorsEnabled,
  logger,
  type Memory,
  MemoryType,
  type MessageConnectorChatContext,
  type MessageConnectorQueryContext,
  type MessageConnectorRegistration,
  type MessageConnectorTarget,
  type MessageConnectorUserContext,
  Service,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import {
  DEFAULT_ACCOUNT_ID as IMESSAGE_LOCAL_ACCOUNT_ID,
  normalizeAccountId as normalizeIMessageAccountId,
} from "./accounts.js";
import {
  type ChatDbMessage,
  type ChatDbReader,
  DEFAULT_CHAT_DB_PATH,
  getLastChatDbAccessIssue,
  openChatDb,
} from "./chatdb-reader.js";
import {
  addContact,
  type ContactPatch,
  type ContactsMap,
  deleteContact,
  type FullContact,
  getLastContactsFailure,
  listAllContacts,
  loadContacts,
  type NewContactInput,
  normalizeContactHandle,
  updateContact,
} from "./contacts-reader.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  formatPhoneNumber,
  type IIMessageService,
  IMESSAGE_SERVICE_NAME,
  type IMessageChat,
  type IMessageChatType,
  IMessageCliError,
  IMessageConfigurationError,
  IMessageEventTypes,
  type IMessageListMessagesOptions,
  type IMessageMessage,
  IMessageNotSupportedError,
  type IMessageSendOptions,
  type IMessageSendResult,
  type IMessageServiceStatus,
  type IMessageSettings,
  isEmail,
  isPhoneNumber,
  isValidIMessageTarget,
  normalizeIMessageTarget,
  splitMessageForIMessage,
} from "./types.js";

const execFileAsync = promisify(execFile);

function appleScriptStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

type RuntimeWithOptionalConnectorRegistry = IAgentRuntime & {
  registerMessageConnector?: (registration: MessageConnectorRegistration) => void;
};
type RuntimeWithTaskLookup = IAgentRuntime & {
  getTasksByName(name: string): Promise<unknown[]>;
};
type AccountTargetInfo = TargetInfo & { accountId?: string };
type AccountQueryContext = MessageConnectorQueryContext & { accountId?: string };

type IMessageConnectorReadParams = {
  target?: TargetInfo;
  limit?: number;
  query?: string;
};

type AdditiveMessageConnectorHooks = {
  fetchMessages?: (
    context: MessageConnectorQueryContext,
    params?: IMessageConnectorReadParams
  ) => Promise<Memory[]>;
  searchMessages?: (
    context: MessageConnectorQueryContext,
    params: IMessageConnectorReadParams & { query: string }
  ) => Promise<Memory[]>;
  getUser?: (
    runtime: IAgentRuntime,
    params: { entityId?: UUID | string; userId?: string; username?: string; handle?: string }
  ) => Promise<Entity | null>;
};

type ExtendedMessageConnectorRegistration = MessageConnectorRegistration &
  AdditiveMessageConnectorHooks;

function registerMessageConnectorIfAvailable(
  runtime: IAgentRuntime,
  registration: MessageConnectorRegistration
): void {
  const withRegistry = runtime as RuntimeWithOptionalConnectorRegistry;
  if (typeof withRegistry.registerMessageConnector === "function") {
    withRegistry.registerMessageConnector(registration);
    return;
  }
  if (!registration.sendHandler) {
    throw new Error("iMessage connector registration requires a send handler");
  }
  runtime.registerSendHandler(registration.source, registration.sendHandler);
}

function hasTaskLookup(runtime: IAgentRuntime): runtime is RuntimeWithTaskLookup {
  return "getTasksByName" in runtime && typeof runtime.getTasksByName === "function";
}

function readTargetAccountId(target?: TargetInfo | null): string | undefined {
  return (target as AccountTargetInfo | undefined)?.accountId;
}

function readContextAccountId(context?: MessageConnectorQueryContext | null): string | undefined {
  return (context as AccountQueryContext | undefined)?.accountId;
}

function targetWithAccount(target: Partial<TargetInfo>, accountId: string): TargetInfo {
  return { ...target, accountId } as TargetInfo;
}

function normalizeIMessageConnectorHandle(value: string): string {
  const stripped = value
    .trim()
    .replace(/^(?:messages?|sms|text):/i, "")
    .trim();
  const normalizedTarget = normalizeIMessageTarget(stripped) ?? stripped;
  if (!normalizedTarget) return "";
  if (normalizedTarget.startsWith("chat_id:")) return normalizedTarget;
  if (/^(?:imessage|sms|rcs);/i.test(normalizedTarget)) {
    return `chat_id:${normalizedTarget}`;
  }
  if (isEmail(normalizedTarget)) return normalizedTarget.toLowerCase();
  if (isPhoneNumber(normalizedTarget)) return formatPhoneNumber(normalizedTarget);
  return normalizeContactHandle(normalizedTarget) || normalizedTarget;
}

function firstAttachmentUrl(content: Content): string | undefined {
  const attachment = content.attachments?.find(
    (item) => typeof item?.url === "string" && item.url.trim().length > 0
  );
  return attachment?.url?.trim();
}

function statusMetadata(status: IMessageServiceStatus): Record<string, string | boolean | null> {
  return {
    available: status.available,
    connected: status.connected,
    chatDbAvailable: status.chatDbAvailable,
    sendOnly: status.sendOnly,
    chatDbPath: status.chatDbPath,
    reason: status.reason,
    permissionAction: status.permissionAction?.label ?? null,
  };
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
  const normalizedHandleQuery = normalizedSearchText(normalizeIMessageConnectorHandle(query));
  return values.some((value) => {
    const normalizedValue = normalizedSearchText(value);
    return (
      normalizedValue.includes(normalizedQuery) ||
      (normalizedHandleQuery.length > 0 && normalizedValue.includes(normalizedHandleQuery))
    );
  });
}

function resolveLocalIMessageAccountId(accountId?: string | null): string {
  return normalizeIMessageAccountId(accountId ?? IMESSAGE_LOCAL_ACCOUNT_ID);
}

function assertLocalIMessageAccount(accountId?: string | null): string {
  const normalized = resolveLocalIMessageAccountId(accountId);
  if (normalized !== IMESSAGE_LOCAL_ACCOUNT_ID) {
    throw new Error(
      `iMessage uses the single local macOS Messages account; unsupported accountId: ${normalized}`
    );
  }
  return normalized;
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

function publicIMessageToMemory(
  runtime: IAgentRuntime,
  message: IMessageMessage,
  roomId: UUID,
  accountId = IMESSAGE_LOCAL_ACCOUNT_ID
): Memory {
  const normalizedAccountId = assertLocalIMessageAccount(accountId);
  const handle = normalizeIMessageConnectorHandle(message.handle ?? "");
  const entityId = message.isFromMe
    ? runtime.agentId
    : (createUniqueUuid(runtime, handle || message.chatId || message.id) as UUID);
  const channelType = message.chatId?.includes(";+;") ? ChannelType.GROUP : ChannelType.DM;

  return {
    id: createUniqueUuid(runtime, `imessage-public:${message.id}`) as UUID,
    entityId,
    agentId: runtime.agentId,
    roomId,
    createdAt: message.timestamp,
    content: {
      text: message.text,
      source: "imessage",
      channelType,
      ...(message.attachmentPaths?.length
        ? {
            attachments: message.attachmentPaths.map((path) => ({
              id: path,
              url: path,
              title: path.split("/").pop() ?? path,
              source: "imessage",
              description: "iMessage attachment",
            })),
          }
        : {}),
    },
    metadata: {
      type: MemoryType.MESSAGE,
      source: "imessage",
      provider: "imessage",
      accountId: normalizedAccountId,
      timestamp: message.timestamp,
      entityUserName: handle || undefined,
      fromBot: message.isFromMe,
      fromId: message.isFromMe ? runtime.agentId : handle,
      sourceId: entityId,
      chatType: channelType,
      messageIdFull: message.id,
      sender: {
        id: message.isFromMe ? runtime.agentId : handle,
        username: handle || undefined,
      },
      imessage: {
        accountId: normalizedAccountId,
        id: handle,
        userId: handle,
        username: handle,
        chatId: message.chatId,
        rowId: message.id,
      },
    },
  } as Memory;
}

function contactKind(handle: string): "phone" | "email" | "contact" {
  if (isEmail(handle)) return "email";
  if (isPhoneNumber(handle)) return "phone";
  return "contact";
}

function contactTarget(
  handle: string,
  label: string | undefined,
  score: number
): MessageConnectorTarget {
  const normalized = normalizeIMessageConnectorHandle(handle);
  const displayLabel = label ? `${label} (${normalized})` : normalized;
  return {
    target: targetWithAccount(
      {
        source: "imessage",
        channelId: normalized,
        entityId: normalized as UUID,
      },
      IMESSAGE_LOCAL_ACCOUNT_ID
    ),
    label: displayLabel,
    kind: contactKind(normalized),
    score,
    metadata: {
      accountId: IMESSAGE_LOCAL_ACCOUNT_ID,
      handle: normalized,
      contactName: label,
    },
  };
}

function chatTarget(chat: IMessageChat, contacts: ContactsMap): MessageConnectorTarget {
  const participants = chat.participants.map((participant) =>
    normalizeIMessageConnectorHandle(participant.handle)
  );
  const primaryHandle = participants[0];
  const isGroup = chat.chatType === "group";
  const contactName = primaryHandle
    ? contacts.get(normalizeContactHandle(primaryHandle))?.name
    : undefined;
  const label =
    chat.displayName ??
    contactName ??
    (isGroup ? participants.filter(Boolean).join(", ") : primaryHandle) ??
    chat.chatId;
  const target: TargetInfo = targetWithAccount(
    {
      source: "imessage",
      channelId: isGroup ? `chat_id:${chat.chatId}` : (primaryHandle ?? `chat_id:${chat.chatId}`),
    },
    IMESSAGE_LOCAL_ACCOUNT_ID
  );
  if (!isGroup && primaryHandle) {
    target.entityId = primaryHandle as UUID;
  }
  return {
    target,
    label,
    kind: isGroup ? "group" : contactKind(primaryHandle ?? chat.chatId),
    description: isGroup ? "iMessage group chat" : "iMessage direct chat",
    score: isGroup ? 0.76 : 0.72,
    metadata: {
      accountId: IMESSAGE_LOCAL_ACCOUNT_ID,
      chatId: chat.chatId,
      chatType: chat.chatType,
      participants: participants.filter(Boolean).join(", "),
    },
  };
}

async function resolveIMessageSendTarget(
  runtime: IAgentRuntime,
  target: TargetInfo
): Promise<string | null> {
  assertLocalIMessageAccount(readTargetAccountId(target));
  if (target.channelId?.trim()) {
    return normalizeIMessageConnectorHandle(target.channelId);
  }
  if (target.entityId?.trim()) {
    return normalizeIMessageConnectorHandle(target.entityId);
  }
  if (target.roomId) {
    const room = await runtime.getRoom(target.roomId);
    if (room?.channelId) {
      return normalizeIMessageConnectorHandle(room.channelId);
    }
  }
  return null;
}

async function resolveIMessageChatId(
  runtime: IAgentRuntime,
  target: TargetInfo
): Promise<string | null> {
  assertLocalIMessageAccount(readTargetAccountId(target));
  const channelId =
    target.channelId ??
    (target.roomId ? (await runtime.getRoom(target.roomId))?.channelId : undefined);
  if (!channelId) return null;
  return channelId.startsWith("chat_id:") ? channelId.slice("chat_id:".length) : channelId;
}

/**
 * iMessage service for Eliza agents.
 * Note: This only works on macOS.
 */
export class IMessageService extends Service implements IIMessageService {
  static serviceType: string = IMESSAGE_SERVICE_NAME;

  capabilityDescription = "iMessage service for sending and receiving messages on macOS";

  private settings: IMessageSettings | null = null;
  private connected: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;
  /**
   * Highest `message.ROWID` we've already dispatched to the agent. The
   * polling loop asks chat.db for rows strictly greater than this value,
   * then advances the cursor to the largest row it actually processed.
   * Initialized to 0 on start; bumped on every successful dispatch so
   * we skip backlog on a fresh launch without ever double-delivering.
   */
  private lastRowId: number = 0;
  /**
   * Reentrancy gate for the polling loop. Dispatch calls
   * `messageService.handleMessage` which invokes the LLM and typically
   * takes several seconds per message. With a 2-second poll interval
   * that means multiple ticks can land on top of each other, each
   * seeing the same stale cursor and re-dispatching the same rows.
   * This flag ensures at most one poll is in flight at a time; ticks
   * that arrive while a poll is active are dropped (the next scheduled
   * tick will pick up where the current one left off).
   */
  private pollInFlight: boolean = false;
  /**
   * Room keys we've already emitted a WORLD_JOINED event for in this
   * service lifetime. Not persisted — on restart every room is
   * re-greeted, which is correct: a fresh Eliza process doesn't know
   * what previous processes already synced, and the bootstrap plugin's
   * WORLD_JOINED handler is idempotent (handleServerSync tolerates
   * already-known rooms via upsert semantics).
   */
  private seenWorlds: Set<string> = new Set();
  /**
   * Entity keys we've already emitted an ENTITY_JOINED event for.
   * Same lifetime + rationale as seenWorlds.
   */
  private seenEntities: Set<string> = new Set();
  /**
   * Live chat.db handle, bound to the lifetime of this service. Non-null
   * means inbound polling is active. Null means either (a) not running
   * under Bun, or (b) chat.db couldn't be opened — in both cases the
   * service remains send-only and logs a one-time warning on start.
   */
  private chatDb: ChatDbReader | null = null;
  private chatDbPath: string = DEFAULT_CHAT_DB_PATH;
  /**
   * Cached handle → display name map from the user's Apple Contacts.
   * Populated lazily on first inbound message through CNContactStore, NOT at
   * service start. Loading at boot would create a settings-level Contacts
   * dependency at app launch, even though the user may never receive an
   * inbound iMessage. We defer the read until the first message that actually
   * needs handle→name resolution. Empty map means either the user hasn't
   * authorized Contacts access yet, the address book is empty, or no inbound
   * message has triggered the lazy load yet.
   */
  private contacts: ContactsMap = new Map();
  /** Whether the lazy contact load has been attempted this session. */
  private contactsLoadAttempted = false;

  /**
   * Start the iMessage service.
   */
  static async start(runtime: IAgentRuntime): Promise<IMessageService> {
    logger.info("Starting iMessage service...");

    const service = new IMessageService(runtime);

    // Check if running on macOS
    if (!service.isMacOS()) {
      throw new IMessageNotSupportedError();
    }

    // Load settings
    service.settings = service.loadSettings();
    await service.validateSettings();

    // Open chat.db for inbound polling. A null return here is non-fatal —
    // the service degrades to send-only and logs its own warning. We seed
    // the polling cursor from the current tip of the database so a freshly
    // started agent doesn't re-process its entire message backlog.
    service.chatDbPath = service.settings.dbPath || DEFAULT_CHAT_DB_PATH;
    service.chatDb = await openChatDb(service.chatDbPath);
    if (service.chatDb) {
      const tip = service.chatDb.getLatestRowId();

      // Resolve IMESSAGE_BACKFILL from every plausible source — character
      // settings (runtime.getSetting), the raw process env, and the
      // character's settings object. Whichever arrives first wins.
      const settingFromRuntime =
        typeof service.runtime?.getSetting === "function"
          ? service.runtime.getSetting("IMESSAGE_BACKFILL")
          : undefined;
      const settingFromEnv = process.env.IMESSAGE_BACKFILL;
      const resolvedRaw =
        (typeof settingFromRuntime === "string" && settingFromRuntime) || settingFromEnv || "";
      const backfill = Math.max(0, Number(resolvedRaw) || 0);
      service.lastRowId = Math.max(0, tip - backfill);

      logger.debug(
        `[imessage][boot] dbPath=${service.chatDbPath} tip=${tip} backfillRaw=${JSON.stringify(resolvedRaw)} backfillResolved=${backfill} lastRowId=${service.lastRowId}`
      );

      logger.info(
        `[imessage] chat.db opened, inbound polling ready (cursor starts at ROWID ${service.lastRowId}, backfilled ${backfill} from tip ${tip})`
      );
    }

    // NOTE: We intentionally do NOT call loadContacts() here. App launch must
    // not create Contacts permission pressure implicitly; the read is deferred
    // to the first inbound message that actually needs name resolution (see
    // ensureContactsLoaded() below). Outbound-only users never hit this path.

    // Start polling only when chat.db is available. When the database cannot
    // be opened, the service is intentionally send-only until the next start.
    if (service.chatDb && service.settings.pollIntervalMs > 0) {
      service.startPolling();
    } else if (!service.chatDb && service.settings.pollIntervalMs > 0) {
      logger.debug("[imessage] inbound polling not started because chat.db is unavailable");
    }

    // Register the heartbeat task worker + create a recurring task.
    // See registerHeartbeat for what it actually does. We gate on the
    // existence of runtime.registerTaskWorker to stay compatible with
    // older cores that predate the task system.
    await service.registerHeartbeat();

    service.connected = true;
    logger.info("iMessage service started");

    // Emit connection ready event
    runtime.emitEvent(IMessageEventTypes.CONNECTION_READY, {
      runtime,
      service,
    } as EventPayload);

    return service;
  }

  static registerSendHandlers(runtime: IAgentRuntime, service: IMessageService): void {
    const registration = {
      source: IMESSAGE_SERVICE_NAME,
      label: "iMessage",
      capabilities: ["send_message", "attachments", "contact_resolution", "chat_context"],
      supportedTargetKinds: ["phone", "email", "contact", "user", "group", "room"],
      contexts: ["phone", "social", "connectors"],
      description:
        "Send SMS/iMessage through macOS Messages using phone numbers, emails, contacts, or chat ids.",
      metadata: {
        aliases: ["imessage", "sms", "text", "messages"],
        accountId: IMESSAGE_LOCAL_ACCOUNT_ID,
        bridge: "macos-messages",
        accountSemantics: "local-macos-messages-single-account",
        status: statusMetadata(service.getStatus()),
      },
      sendHandler: async (_runtime: IAgentRuntime, target: TargetInfo, content: Content) => {
        const accountId = assertLocalIMessageAccount(readTargetAccountId(target));
        const text = typeof content.text === "string" ? content.text : "";
        const mediaUrl = firstAttachmentUrl(content);
        if (!text.trim() && !mediaUrl) {
          return;
        }

        const resolvedTarget = await resolveIMessageSendTarget(runtime, target);
        if (!resolvedTarget) {
          throw new Error("iMessage target is missing a phone, email, or chat id");
        }

        const result = await service.sendMessage(
          resolvedTarget,
          text,
          mediaUrl ? { mediaUrl, accountId } : { accountId }
        );
        if (!result.success) {
          throw new Error(result.error ?? "iMessage send failed");
        }
      },
      resolveTargets: async (query: string) => {
        const candidates: MessageConnectorTarget[] = [];
        const contacts = service.getContacts();
        for (const [handle, contact] of contacts) {
          if (matchesQuery(query, contact.name, handle)) {
            candidates.push(
              contactTarget(
                handle,
                contact.name,
                contact.name.toLowerCase() === query.toLowerCase() ? 0.9 : 0.82
              )
            );
          }
        }

        const normalized = normalizeIMessageConnectorHandle(query);
        if (normalized && (isValidIMessageTarget(normalized) || isEmail(normalized))) {
          candidates.push(
            contactTarget(normalized, contacts.get(normalizeContactHandle(normalized))?.name, 0.8)
          );
        }

        const chats = await service.getChats();
        for (const chat of chats) {
          const candidate = chatTarget(chat, contacts);
          if (
            matchesQuery(
              query,
              candidate.label,
              chat.chatId,
              chat.displayName,
              ...chat.participants.map((participant) => participant.handle)
            )
          ) {
            candidates.push({ ...candidate, score: Math.max(candidate.score ?? 0, 0.78) });
          }
        }

        return candidates;
      },
      listRecentTargets: async () => {
        const contacts = service.getContacts();
        const byKey = new Map<string, MessageConnectorTarget>();
        for (const message of await service.getRecentMessages(50)) {
          const handle = normalizeIMessageConnectorHandle(message.handle);
          const target = message.chatId
            ? {
                target: targetWithAccount(
                  {
                    source: "imessage",
                    channelId: message.chatId.startsWith("chat_id:")
                      ? message.chatId
                      : `chat_id:${message.chatId}`,
                    entityId: handle ? (handle as UUID) : undefined,
                  },
                  IMESSAGE_LOCAL_ACCOUNT_ID
                ),
                label:
                  contacts.get(normalizeContactHandle(handle))?.name ??
                  message.handle ??
                  message.chatId,
                kind: message.chatId?.includes(";+;") ? "group" : contactKind(handle),
                score: 0.68,
                metadata: {
                  accountId: IMESSAGE_LOCAL_ACCOUNT_ID,
                  handle,
                  chatId: message.chatId,
                  lastMessageAt: message.timestamp,
                },
              }
            : contactTarget(handle, contacts.get(normalizeContactHandle(handle))?.name, 0.66);
          byKey.set(
            `${target.target.channelId ?? ""}|${target.target.entityId ?? ""}`,
            target as MessageConnectorTarget
          );
        }
        return Array.from(byKey.values());
      },
      listRooms: async () => {
        const contacts = service.getContacts();
        return (await service.getChats()).map((chat) => chatTarget(chat, contacts));
      },
      fetchMessages: async (context, params) => {
        const limit = normalizeConnectorLimit(params?.limit);
        const target = params?.target ?? context.target;
        const accountId = assertLocalIMessageAccount(
          readTargetAccountId(target) ?? readContextAccountId(context)
        );
        const chatId = target ? await resolveIMessageChatId(context.runtime, target) : null;
        const platformMessages = await service
          .getMessages({ ...(chatId ? { chatId } : {}), limit })
          .catch(() => []);
        if (platformMessages.length > 0) {
          const roomId =
            target?.roomId ??
            (createUniqueUuid(context.runtime, `imessage-read:${chatId ?? "recent"}`) as UUID);
          return platformMessages
            .map((message) => publicIMessageToMemory(context.runtime, message, roomId, accountId))
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
      },
      searchMessages: async (context, params) => {
        const limit = normalizeConnectorLimit(params?.limit);
        const target = params?.target ?? context.target;
        const accountId = assertLocalIMessageAccount(
          readTargetAccountId(target) ?? readContextAccountId(context)
        );
        const chatId = target ? await resolveIMessageChatId(context.runtime, target) : null;
        const platformMessages = await service
          .getMessages({ ...(chatId ? { chatId } : {}), limit: Math.max(limit, 100) })
          .catch(() => []);
        const roomId =
          target?.roomId ??
          (createUniqueUuid(context.runtime, `imessage-read:${chatId ?? "recent"}`) as UUID);
        const memories =
          platformMessages.length > 0
            ? platformMessages.map((message) =>
                publicIMessageToMemory(context.runtime, message, roomId, accountId)
              )
            : target?.roomId
              ? await context.runtime.getMemories({
                  tableName: "messages",
                  roomId: target.roomId,
                  limit: Math.max(limit, 100),
                  orderBy: "createdAt",
                  orderDirection: "desc",
                })
              : [];
        return filterMemoriesByQuery(memories, params.query, limit);
      },
      getChatContext: async (
        target: TargetInfo,
        context: MessageConnectorQueryContext
      ): Promise<MessageConnectorChatContext | null> => {
        const accountId = assertLocalIMessageAccount(
          readTargetAccountId(target) ?? readContextAccountId(context)
        );
        const chatId = await resolveIMessageChatId(context.runtime, target);
        const messages = chatId ? await service.getMessages({ chatId, limit: 10 }) : [];
        return {
          target: targetWithAccount(target, accountId),
          label: chatId ?? target.channelId ?? target.entityId ?? "iMessage target",
          summary: service.getStatus().chatDbAvailable
            ? "iMessage chat context from local Messages database."
            : "iMessage is available in send-only mode; chat database context is unavailable.",
          recentMessages: messages.map((message) => ({
            name:
              service.getContacts().get(normalizeContactHandle(message.handle))?.name ??
              message.handle,
            text: message.text,
            timestamp: message.timestamp,
            metadata: {
              accountId,
              messageId: message.id,
              handle: normalizeIMessageConnectorHandle(message.handle),
              isFromMe: message.isFromMe,
            },
          })),
          metadata: {
            accountId,
            chatId,
            status: statusMetadata(service.getStatus()),
          },
        };
      },
      getUserContext: async (
        entityId: string | UUID
      ): Promise<MessageConnectorUserContext | null> => {
        const handle = normalizeIMessageConnectorHandle(String(entityId));
        if (!handle) return null;
        const contact = service.getContacts().get(normalizeContactHandle(handle));
        return {
          entityId,
          label: contact?.name ?? handle,
          aliases: contact?.name ? [contact.name, handle] : [handle],
          handles: {
            imessage: handle,
            ...(isEmail(handle) ? { email: handle } : { phone: handle }),
          },
          metadata: {
            accountId: IMESSAGE_LOCAL_ACCOUNT_ID,
            normalizedHandle: handle,
          },
        };
      },
      getUser: async (_handlerRuntime, params) => {
        const lookupParams = params as {
          entityId?: UUID | string;
          userId?: UUID | string;
          username?: string;
          handle?: string;
        };
        const handle = normalizeIMessageConnectorHandle(
          String(
            lookupParams.entityId ??
              lookupParams.userId ??
              lookupParams.username ??
              lookupParams.handle ??
              ""
          )
        );
        if (!handle) return null;
        const contact = service.getContacts().get(normalizeContactHandle(handle));
        return {
          id: createUniqueUuid(_handlerRuntime, `imessage:${handle}`) as UUID,
          names: contact?.name ? [contact.name, handle] : [handle],
          agentId: _handlerRuntime.agentId,
          metadata: {
            accountId: IMESSAGE_LOCAL_ACCOUNT_ID,
            normalizedHandle: handle,
            imessage: handle,
            ...(isEmail(handle) ? { email: handle } : { phone: handle }),
          },
        } satisfies Entity;
      },
    } as ExtendedMessageConnectorRegistration;
    registerMessageConnectorIfAvailable(runtime, registration);
  }

  /**
   * Stop the iMessage service.
   */
  async stop(): Promise<void> {
    logger.info("Stopping iMessage service...");
    this.connected = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.chatDb) {
      this.chatDb.close();
      this.chatDb = null;
    }

    this.settings = null;
    this.lastRowId = 0;
    logger.info("iMessage service stopped");
  }

  /**
   * Check if the service is connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  getStatus(): IMessageServiceStatus {
    const chatDbAvailable = this.chatDb !== null;
    const accessIssue = chatDbAvailable ? null : getLastChatDbAccessIssue(this.chatDbPath);

    return {
      available: true,
      connected: this.connected,
      chatDbAvailable,
      sendOnly: this.connected && !chatDbAvailable,
      chatDbPath: this.chatDbPath,
      reason: accessIssue?.reason ?? (chatDbAvailable ? null : "chat.db reader not available"),
      permissionAction: accessIssue?.permissionAction ?? null,
    };
  }

  /**
   * Check if running on macOS.
   */
  isMacOS(): boolean {
    return platform() === "darwin";
  }

  /**
   * Send a message via iMessage.
   */
  async sendMessage(
    to: string,
    text: string,
    options?: IMessageSendOptions
  ): Promise<IMessageSendResult> {
    const accountId = assertLocalIMessageAccount(options?.accountId);
    if (!this.settings) {
      return { success: false, error: "Service not initialized" };
    }

    // Format phone number if needed
    const target = isPhoneNumber(to) ? formatPhoneNumber(to) : to;

    // Split message if too long
    const chunks = splitMessageForIMessage(text);

    for (const chunk of chunks) {
      const result = await this.sendSingleMessage(target, chunk, options);
      if (!result.success) {
        return result;
      }
    }

    // Emit sent events — both the plugin-namespaced form (for iMessage-
    // specific listeners) and the generic core EventType.MESSAGE_SENT
    // so trajectory loggers, analytics, and any plugin hooking into
    // the standard event bus see outbound iMessage sends the same way
    // they see Telegram / Discord / Slack sends.
    if (this.runtime) {
      this.runtime.emitEvent(IMessageEventTypes.MESSAGE_SENT, {
        runtime: this.runtime,
        source: "imessage",
        accountId,
        to: target,
        text,
        hasMedia: Boolean(options?.mediaUrl),
      } as EventPayload);
      this.runtime.emitEvent(EventType.MESSAGE_SENT, {
        runtime: this.runtime,
        source: "imessage",
        message: {
          id: createUniqueUuid(this.runtime, `imessage-outbound-${Date.now()}`),
          entityId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          roomId: createUniqueUuid(this.runtime, target),
          content: { text, source: "imessage" },
          metadata: {
            accountId,
            source: "imessage",
            provider: "imessage",
            imessage: {
              accountId,
              chatId: target,
            },
          },
          createdAt: Date.now(),
        },
      } as EventPayload);
    }

    return {
      success: true,
      messageId: Date.now().toString(),
      chatId: target,
    };
  }

  /**
   * Get recent messages by reading chat.db. Returns the most recent
   * `limit` messages (any sender, any chat) in chronological order.
   *
   * Returns an empty array if the chat.db reader is unavailable (plugin
   * running under plain Node without bun:sqlite, or Full Disk Access not
   * granted, etc.).
   */
  async getRecentMessages(limit: number = 50): Promise<IMessageMessage[]> {
    return this.getMessages({ limit });
  }

  /**
   * Return the newest messages in chronological order, optionally scoped
   * to a single chat identifier. Returns an empty array if chat.db is not
   * available and the connector is currently running in send-only mode.
   */
  async getMessages(options: IMessageListMessagesOptions = {}): Promise<IMessageMessage[]> {
    if (!this.chatDb) {
      return [];
    }

    const rows = this.chatDb.listMessages(options);
    return rows.map(chatDbMessageToPublicShape);
  }

  /**
   * List every chat the Messages.app database knows about, joined with
   * participant handles. Returns an empty list if the chat.db reader is
   * unavailable (Node runtime, missing FDA, etc.).
   *
   * Previously this method used an AppleScript stub against
   * Messages.app's `chats` collection. That verb works but is slow and
   * returns a coarser view (no participant handles, no style field), so
   * the chat.db path is strictly better when it's available.
   */
  async getChats(): Promise<IMessageChat[]> {
    if (!this.chatDb) {
      return [];
    }
    // Convert the reader's richer ChatDbChatSummary into the plugin's
    // public IMessageChat shape for backwards-compat with consumers of
    // the existing IIMessageService interface. Callers that want the
    // richer fields (serviceName, last read timestamp) can go straight
    // to the reader via `chatDb.listChats()`.
    return this.chatDb.listChats().map((c) => ({
      chatId: c.chatId,
      chatType: c.chatType,
      displayName: c.displayName ?? undefined,
      participants: c.participants.map((handle) => ({
        handle,
        isPhoneNumber: /^\+?\d{7,}$/.test(handle),
      })),
    }));
  }

  /**
   * Get current settings.
   */
  getSettings(): IMessageSettings | null {
    return this.settings;
  }

  /**
   * Get the cached Apple Contacts map, if lazy loading has happened.
   *
   * Keys are normalized handles (phones in digits-only + optional leading `+`,
   * emails lowercased). Values carry the contact's display name.
   *
   * Exposed for providers that want to inject contact lookups into agent
   * state so the LLM can resolve a person's name ("text Shaw") to a handle
   * it can pass to `sendMessage`.
   *
   * Returns an empty map if Contacts access was denied, failed to load,
   * or the service hasn't finished starting.
   */
  getContacts(): ContactsMap {
    return this.contacts;
  }

  /**
   * Lazy-load the Apple Contacts map on first call. Subsequent calls
   * are no-ops. We split this out from `start()` so Contacts permission
   * pressure only appears when the runtime actually needs handle→name
   * resolution, instead of at app launch. Failure is non-fatal; the cached
   * map stays empty and the service falls back to raw handles.
   */
  private async ensureContactsLoaded(): Promise<void> {
    if (this.contactsLoadAttempted) {
      return;
    }
    this.contactsLoadAttempted = true;
    try {
      this.contacts = await loadContacts();
      this.recordContactsPermissionBlock("contacts.resolve");
    } catch (err) {
      logger.warn(
        `[imessage] Lazy contact load failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private recordContactsPermissionBlock(action: string): void {
    if (getLastContactsFailure() !== "permission") return;
    const registry = this.runtime?.getService?.("eliza_permissions_registry") as
      | {
          recordBlock?: (id: string, feature: { action: string; app: string }) => void;
        }
      | null
      | undefined;
    registry?.recordBlock?.("contacts", { app: "imessage", action });
  }

  /**
   * List every contact in the user's address book as a full record with
   * id, name, and all phones/emails. Delegates to contacts-reader's
   * `listAllContacts` which uses CNContactStore. Returns `[]` on failure
   * (permission denied, etc.).
   */
  async listAllContacts(): Promise<FullContact[]> {
    const contacts = await listAllContacts();
    if (contacts.length === 0) {
      this.recordContactsPermissionBlock("contacts.list");
    }
    return contacts;
  }

  /**
   * Create a new Apple Contacts record. Requires the Contacts privacy grant.
   * Returns the new person's id on success, or null on failure.
   *
   * After a successful create we refresh the cached handle→name map so
   * inbound messages from the new contact resolve to their name on the
   * very next poll, without requiring a service restart.
   */
  async addContact(input: NewContactInput): Promise<string | null> {
    const id = await addContact(input);
    if (id) {
      this.contacts = await loadContacts();
    } else {
      this.recordContactsPermissionBlock("contacts.create");
    }
    return id;
  }

  /**
   * Patch an existing contact (name fields, add/remove phones, add/remove
   * emails). Returns true on success, false on failure. Refreshes the
   * cached map on success so name resolution reflects the change.
   */
  async updateContact(personId: string, patch: ContactPatch): Promise<boolean> {
    const ok = await updateContact(personId, patch);
    if (ok) {
      this.contacts = await loadContacts();
    } else {
      this.recordContactsPermissionBlock("contacts.update");
    }
    return ok;
  }

  /**
   * Delete a contact by Apple Contacts id. Returns true on success, false on
   * failure. Refreshes the cached map on success.
   */
  async deleteContact(personId: string): Promise<boolean> {
    const ok = await deleteContact(personId);
    if (ok) {
      this.contacts = await loadContacts();
    } else {
      this.recordContactsPermissionBlock("contacts.delete");
    }
    return ok;
  }

  // Private methods

  private loadSettings(): IMessageSettings {
    if (!this.runtime) {
      throw new IMessageConfigurationError("Runtime not initialized");
    }

    const getStringSetting = (key: string, envKey: string, defaultValue = ""): string => {
      const value = this.runtime?.getSetting(key);
      if (typeof value === "string") return value;
      return process.env[envKey] || defaultValue;
    };

    const cliPath = getStringSetting("IMESSAGE_CLI_PATH", "IMESSAGE_CLI_PATH", "imsg");
    const dbPath = getStringSetting("IMESSAGE_DB_PATH", "IMESSAGE_DB_PATH") || undefined;

    const pollIntervalRaw = getStringSetting(
      "IMESSAGE_POLL_INTERVAL_MS",
      "IMESSAGE_POLL_INTERVAL_MS"
    );
    const parsedPollIntervalMs = Number(pollIntervalRaw);
    const pollIntervalMs =
      pollIntervalRaw.trim() === "" || !Number.isFinite(parsedPollIntervalMs)
        ? DEFAULT_POLL_INTERVAL_MS
        : Math.max(0, parsedPollIntervalMs);

    const dmPolicy = getStringSetting(
      "IMESSAGE_DM_POLICY",
      "IMESSAGE_DM_POLICY",
      "pairing"
    ) as IMessageSettings["dmPolicy"];

    const groupPolicy = getStringSetting(
      "IMESSAGE_GROUP_POLICY",
      "IMESSAGE_GROUP_POLICY",
      "allowlist"
    ) as IMessageSettings["groupPolicy"];

    const allowFromRaw = getStringSetting("IMESSAGE_ALLOW_FROM", "IMESSAGE_ALLOW_FROM");
    const allowFrom = allowFromRaw
      ? allowFromRaw
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : [];

    const enabledRaw = getStringSetting("IMESSAGE_ENABLED", "IMESSAGE_ENABLED", "true");
    const enabled = enabledRaw !== "false";

    return {
      cliPath,
      dbPath,
      pollIntervalMs,
      dmPolicy,
      groupPolicy,
      allowFrom,
      enabled,
    };
  }

  private async validateSettings(): Promise<void> {
    if (!this.settings) {
      throw new IMessageConfigurationError("Settings not loaded");
    }

    // Check if CLI tool exists (if specified and not default)
    if (this.settings.cliPath !== "imsg") {
      if (!existsSync(this.settings.cliPath)) {
        logger.warn(`iMessage CLI not found at ${this.settings.cliPath}, will use AppleScript`);
      }
    }

    // Check if Messages app is accessible
    try {
      await this.runAppleScript('tell application "Messages" to return 1');
    } catch (_error) {
      throw new IMessageConfigurationError(
        "Cannot access Messages app. Ensure Full Disk Access is granted."
      );
    }
  }

  private async sendSingleMessage(
    to: string,
    text: string,
    options?: IMessageSendOptions
  ): Promise<IMessageSendResult> {
    // Try CLI first if available
    if (this.settings?.cliPath && this.settings.cliPath !== "imsg") {
      try {
        return await this.sendViaCli(to, text, options);
      } catch (error) {
        logger.debug(`CLI send failed, falling back to AppleScript: ${error}`);
      }
    }

    // Fall back to AppleScript
    return await this.sendViaAppleScript(to, text, options);
  }

  private async sendViaCli(
    to: string,
    text: string,
    options?: IMessageSendOptions
  ): Promise<IMessageSendResult> {
    if (!this.settings) {
      return { success: false, error: "Service not initialized" };
    }

    const args = [to, text];
    if (options?.mediaUrl) {
      args.push("--attachment", options.mediaUrl);
    }

    try {
      await execFileAsync(this.settings.cliPath, args);
      return { success: true, messageId: Date.now().toString(), chatId: to };
    } catch (error) {
      const err = error as { code?: number; message?: string };
      throw new IMessageCliError(err.message || "CLI command failed", err.code);
    }
  }

  private async sendViaAppleScript(
    to: string,
    text: string,
    options?: IMessageSendOptions
  ): Promise<IMessageSendResult> {
    const isChatTarget = to.startsWith("chat_id:");
    const chatId = isChatTarget ? to.slice(8) : null;
    const targetLiteral = appleScriptStringLiteral(chatId ?? to);

    // Build the `set target...` clause once — used by both the text
    // send and the (optional) attachment send below.
    const targetBlock = isChatTarget
      ? `set targetRef to chat id ${targetLiteral}`
      : `
        set targetService to 1st account whose service type = iMessage
        set targetRef to participant ${targetLiteral} of targetService
      `;

    // Text body (possibly empty if caller is attachment-only).
    if (text && text.length > 0) {
      const textScript = `
        tell application "Messages"
          ${targetBlock}
          send ${appleScriptStringLiteral(text)} to targetRef
        end tell
      `;
      try {
        await this.runAppleScript(textScript);
      } catch (error) {
        return { success: false, error: `AppleScript error: ${error}` };
      }
    }

    // Attachment, if any. Messages.app's scripting dictionary accepts a
    // file as the direct-parameter of `send`, so we resolve the media
    // path to a POSIX file and hand it to the same `send` verb. Works
    // for images, video, audio, PDFs, anything Messages.app would let
    // you drag into the compose area.
    if (options?.mediaUrl) {
      const mediaPath = options.mediaUrl.startsWith("file://")
        ? options.mediaUrl.slice(7)
        : options.mediaUrl;
      const attachmentScript = `
        tell application "Messages"
          ${targetBlock}
          send (POSIX file ${appleScriptStringLiteral(mediaPath)}) to targetRef
        end tell
      `;
      try {
        await this.runAppleScript(attachmentScript);
      } catch (error) {
        return {
          success: false,
          error: `AppleScript attachment error: ${error}`,
        };
      }
    }

    return { success: true, messageId: Date.now().toString(), chatId: to };
  }

  private async runAppleScript(script: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script]);
      return stdout.trim();
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      throw new Error(err.stderr || err.message || "AppleScript execution failed");
    }
  }

  private startPolling(): void {
    if (!this.settings) {
      return;
    }

    this.pollInterval = setInterval(async () => {
      try {
        await this.pollForNewMessages();
      } catch (error) {
        logger.debug(`Polling error: ${error}`);
      }
    }, this.settings.pollIntervalMs);
  }

  /**
   * Poll chat.db for rows newer than the cursor and route each inbound
   * message through the agent's message pipeline.
   *
   * Flow per message:
   *   1. Read new rows from chat.db via the bun:sqlite reader.
   *   2. Skip outbound (is_from_me=1), already-seen, and policy-denied rows.
   *   3. Build a Memory object in the shape the bootstrap plugin expects.
   *   4. Ensure the entity + room + world exist via ensureConnection.
   *   5. Call runtime.messageService.handleMessage with a callback that
   *      sends the agent's reply back through sendViaAppleScript.
   *   6. Also emit the plugin-namespaced IMESSAGE_MESSAGE_RECEIVED event
   *      and the core EventType.MESSAGE_RECEIVED event for any listeners.
   *
   * Advances this.lastRowId unconditionally to the max rowId we saw in
   * this batch — even for skipped rows — so the cursor keeps moving
   * forward and we never get stuck re-reading the same row on every poll.
   */
  private async pollForNewMessages(): Promise<void> {
    if (!this.runtime || !this.chatDb) {
      return;
    }

    // Reentrancy gate — see field-level comment on pollInFlight.
    if (this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;

    try {
      await this.pollForNewMessagesInner();
    } finally {
      this.pollInFlight = false;
    }
  }

  private async pollForNewMessagesInner(): Promise<void> {
    if (!this.runtime || !this.chatDb) return;

    // Cap batch size to 50 to keep per-tick latency bounded on busy
    // inboxes. If traffic exceeds that, subsequent ticks catch up.
    const batch = this.chatDb.fetchNewMessages(this.lastRowId, 50);
    if (batch.length === 0) {
      return;
    }

    // CRITICAL: advance the cursor synchronously, BEFORE any async
    // dispatch work. If we advance after the for loop, a slow dispatch
    // gives setInterval time to fire the next tick, which would re-read
    // the stale cursor and re-dispatch the same rows. Since chat.db's
    // ROWID is monotonic, we know every row in `batch` is unique and
    // each has rowId > sinceRowId, so advancing to the max NOW is safe
    // even if individual dispatches fail later.
    const maxRowIdInBatch = batch.reduce(
      (max, row) => (row.rowId > max ? row.rowId : max),
      this.lastRowId
    );
    this.lastRowId = maxRowIdInBatch;

    logger.debug(
      `[imessage][poll-start] fetched=${batch.length} cursor advanced to ${this.lastRowId}`
    );

    for (const row of batch) {
      // Skip outbound messages — the agent sent these itself via AppleScript,
      // we don't want it reacting to its own output.
      if (row.isFromMe) {
        continue;
      }

      // Policy gate: DM allowlist, group allowlist, disabled, etc.
      if (!this.isAllowed(row.handle)) {
        continue;
      }

      // Skip non-text rows for the main dispatch path. Reactions and
      // system events still emit their own plugin-namespaced events
      // below so downstream listeners can react to them, but they
      // don't flow through messageService.handleMessage (which is
      // for conversational turns only).
      if (row.kind !== "text") {
        this.emitAuxiliaryEvent(row);
        continue;
      }

      // Undecodable text (attributedBody decode miss) would produce an
      // empty-string turn the agent has nothing to do with. Skip with a
      // debug log so the cursor still advances.
      if (row.text.trim().length === 0) {
        logger.debug(
          `[imessage] skipping ROWID=${row.rowId} — text column and attributedBody both empty after decode`
        );
        continue;
      }

      logger.debug(
        `[imessage][dispatch] ROWID=${row.rowId} handle=${row.handle} text="${row.text.slice(0, 40)}"`
      );
      try {
        await this.dispatchInboundMessage(row);
      } catch (error) {
        logger.error(
          `[imessage] Failed to dispatch inbound message ROWID=${row.rowId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    logger.debug(`[imessage][poll-end] done. lastRowId=${this.lastRowId}`);
  }

  /**
   * Turn a single chat.db row into a `Memory`, wire up a reply callback,
   * and hand the whole thing to `runtime.messageService.handleMessage`.
   *
   * Mirrors the shape used by @elizaos/plugin-telegram so the bootstrap
   * plugin's message pipeline picks up inbound iMessages the same way it
   * picks up Telegram messages — same entity/room/world creation, same
   * `source: "imessage"` tag on content, same HandlerCallback signature
   * for the reply path.
   */
  private async dispatchInboundMessage(row: ChatDbMessage): Promise<void> {
    if (!this.runtime) return;
    const accountId = IMESSAGE_LOCAL_ACCOUNT_ID;

    // chat_identifier is stable across messages in the same chat; use it
    // as the room key. Fall back to the handle for the edge case where
    // chat_message_join is empty (shouldn't happen on a healthy chat.db).
    const roomKey = row.chatId || row.handle || `imessage-room-${row.rowId}`;
    const entityKey = row.handle || roomKey;

    const entityId = createUniqueUuid(this.runtime, entityKey);
    const roomId = createUniqueUuid(this.runtime, roomKey);
    const worldId = createUniqueUuid(this.runtime, `imessage-world-${roomKey}`);
    // Key the Memory id by the chat.db message guid, not the ROWID —
    // guids are stable across restarts and CloudKit syncs, so reply
    // threading (which targets guids) can resolve via createUniqueUuid
    // against the same key.
    const messageId = createUniqueUuid(this.runtime, `imessage-guid-${row.guid}`);

    const channelType: ChannelType = row.chatType === "group" ? ChannelType.GROUP : ChannelType.DM;

    // Resolve the sender handle against the Apple Contacts map. The map
    // is loaded lazily on first inbound message — see ensureContactsLoaded
    // for the rationale (deferring the macOS Contacts TCC dialog away from
    // app launch). On a miss we fall back to the raw handle, so the
    // conversation still works — it just looks uglier in logs and state.
    await this.ensureContactsLoaded();
    const resolvedContact = this.contacts.get(normalizeContactHandle(row.handle)) ?? null;
    const resolvedName = resolvedContact?.name ?? null;

    // Make sure the agent's memory store knows about this entity + room +
    // world before we try to persist a Memory into it — otherwise FK
    // constraints fire downstream.
    await this.runtime.ensureConnection({
      entityId,
      roomId,
      worldId,
      source: "imessage",
      channelId: roomKey,
      type: channelType,
      metadata: {
        accountId,
        chatId: roomKey,
        chatType: row.chatType,
      },
      name: resolvedName ?? row.displayName ?? row.handle ?? undefined,
      ...(row.handle ? { userId: row.handle as UUID } : {}),
      worldName: row.displayName ? `imessage-chat-${row.displayName}` : `imessage-chat-${roomKey}`,
      userName: resolvedName ?? row.handle ?? undefined,
    });
    if (typeof this.runtime.ensureRoomExists === "function") {
      await this.runtime.ensureRoomExists({
        id: roomId,
        name: row.displayName ?? roomKey,
        agentId: this.runtime.agentId,
        source: "imessage",
        type: channelType,
        channelId: roomKey,
        worldId,
        metadata: {
          accountId,
          chatId: roomKey,
          chatType: row.chatType,
        },
      });
    }

    // Lifecycle events — WORLD_JOINED + ENTITY_JOINED fire ONCE per
    // room/entity per service lifetime. These are the architectural
    // signals that Eliza's bootstrap plugin and any other observer
    // (trajectory logger, analytics, onboarding flows) subscribe to in
    // order to sync data, update rosters, or trigger side effects.
    // Without them, a plugin that writes Memories directly via
    // createMemory leaves observers in the dark about new rooms.
    if (!this.seenWorlds.has(roomKey)) {
      this.seenWorlds.add(roomKey);
      this.runtime.emitEvent(EventType.WORLD_JOINED, {
        runtime: this.runtime,
        source: "imessage",
        world: {
          id: worldId,
          name: row.displayName ? `imessage-chat-${row.displayName}` : `imessage-chat-${roomKey}`,
          agentId: this.runtime.agentId,
          serverId: roomKey,
          metadata: {
            accountId,
            type: channelType,
            chatId: roomKey,
            displayName: row.displayName ?? undefined,
          },
        },
        rooms: [
          {
            id: roomId,
            name: row.displayName ?? roomKey,
            type: channelType,
            source: "imessage",
            worldId,
            channelId: roomKey,
            serverId: roomKey,
            agentId: this.runtime.agentId,
            metadata: { accountId, chatType: row.chatType },
          },
        ],
        entities: [],
      } as EventPayload);
      logger.debug(`[imessage][world-joined] roomKey=${roomKey}`);
    }

    if (!this.seenEntities.has(entityKey)) {
      this.seenEntities.add(entityKey);
      this.runtime.emitEvent(EventType.ENTITY_JOINED, {
        runtime: this.runtime,
        source: "imessage",
        entityId,
        worldId,
        roomId,
        metadata: {
          accountId,
          originalId: row.handle,
          username: row.handle,
          displayName: resolvedName ?? row.handle,
          type: channelType,
        },
      } as EventPayload);
      logger.debug(
        `[imessage][entity-joined] entityKey=${entityKey} name=${resolvedName ?? row.handle}`
      );
    }

    // Resolve the in-reply-to link. If this message is an inline reply to
    // an earlier one, we build the same UUID the earlier dispatch would
    // have used (same rule: `imessage-${rowId}` keyed off the reader's
    // stable guid), so the agent's threading actually resolves. We don't
    // know the target's ROWID from the guid alone without an extra query,
    // but createUniqueUuid is content-addressable — hashing the guid gives
    // the same UUID the original dispatch did if we key both on guid.
    const inReplyTo = row.replyToGuid
      ? createUniqueUuid(this.runtime, `imessage-guid-${row.replyToGuid}`)
      : undefined;

    const memoryContent: Content = {
      text: row.text,
      source: "imessage",
      channelType,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(row.attachments.length > 0
        ? {
            attachments: row.attachments.map((a) => ({
              id: a.guid,
              url: "",
              title: a.filename ?? a.guid,
              contentType: mimeToContentType(a.mimeType, a.uti),
              source: "imessage",
              description: a.isSticker ? "sticker" : (a.filename ?? a.mimeType ?? a.uti ?? ""),
              text: "",
            })),
          }
        : {}),
    };

    const memory: Memory = {
      id: messageId,
      entityId,
      agentId: this.runtime.agentId,
      roomId,
      content: memoryContent,
      // The core `MemoryMetadata` type constrains its keys to a fixed set
      // (`type`, `source`, etc.), so we stash plugin-specific fields by
      // widening via an unknown cast. Downstream providers read these
      // keys dynamically so the static shape doesn't matter at runtime.
      metadata: {
        type: MemoryType.MESSAGE,
        source: "imessage",
        provider: "imessage",
        accountId,
        timestamp: row.timestamp || Date.now(),
        entityName: resolvedName ?? row.displayName ?? row.handle ?? undefined,
        entityUserName: row.handle ?? undefined,
        fromBot: row.isFromMe,
        fromId: row.handle,
        sourceId: entityId,
        chatType: channelType,
        messageIdFull: row.guid,
        sender: {
          id: row.handle,
          name: resolvedName ?? row.displayName ?? row.handle ?? undefined,
          username: row.handle ?? undefined,
        },
        imessage: {
          accountId,
          id: row.handle,
          userId: row.handle,
          username: row.handle,
          userName: row.handle,
          name: resolvedName ?? row.displayName ?? row.handle ?? undefined,
          chatId: roomKey,
          guid: row.guid,
          rowId: row.rowId,
          service: row.service,
        },
        // Raw handle + resolved contact name for connector target context.
        ...(row.handle ? { imessageHandle: row.handle } : {}),
        ...(resolvedName ? { imessageContactName: resolvedName } : {}),
        // Delivery service: iMessage / SMS / RCS.
        ...(row.service ? { imessageService: row.service } : {}),
        // Stable correlation keys across restarts.
        imessageGuid: row.guid,
        imessageRowId: row.rowId,
        // Editing / retraction state for downstream filters.
        ...(row.dateEdited ? { imessageEditedAt: row.dateEdited } : {}),
        ...(row.dateRetracted ? { imessageRetractedAt: row.dateRetracted } : {}),
      } as Memory["metadata"],
      createdAt: row.timestamp || Date.now(),
    };

    // Reply callback: when the agent produces a response, send it back out
    // through the existing AppleScript send path. For groups we send to
    // `chat_id:<identifier>` so AppleScript targets the whole chat; for
    // DMs we target the sender's handle directly.
    const replyTarget = row.chatType === "group" ? `chat_id:${row.chatId}` : row.handle;

    const callback: HandlerCallback = async (content) => {
      const replyText = content.text?.trim();
      if (!replyText || !this.runtime) {
        return [];
      }

      const sendResult = await this.sendViaAppleScript(replyTarget, replyText);
      if (!sendResult.success) {
        logger.error(`[imessage] Reply send failed for ROWID=${row.rowId}: ${sendResult.error}`);
        return [];
      }

      const responseMemory: Memory = {
        id: createUniqueUuid(this.runtime, `imessage-reply-${row.rowId}-${Date.now()}`),
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          ...content,
          source: "imessage",
          channelType,
          inReplyTo: messageId,
        },
        metadata: {
          type: MemoryType.MESSAGE,
          source: "imessage",
          provider: "imessage",
          accountId,
          imessage: {
            accountId,
            chatId: roomKey,
          },
        },
        createdAt: Date.now(),
      };

      await this.runtime.createMemory(responseMemory, "messages");
      return [responseMemory];
    };

    // Emit the plugin-namespaced event for any iMessage-specific listeners
    // (kept for backwards compatibility with pre-fix code) and the generic
    // core event so anything subscribed to EventType.MESSAGE_RECEIVED sees it.
    this.runtime.emitEvent(IMessageEventTypes.MESSAGE_RECEIVED, {
      runtime: this.runtime,
      message: memory,
      source: "imessage",
      accountId,
      callback,
    } as EventPayload);
    this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime: this.runtime,
      message: memory,
      source: "imessage",
      accountId,
      callback,
    } as EventPayload);

    // Inbound messages are always ingested + emitted above. The agent only
    // auto-generates a reply when IMESSAGE_AUTO_REPLY is explicitly enabled —
    // default-off prevents the runtime from speaking on the user's behalf to
    // real iMessage contacts.
    const autoReplyRaw = this.runtime.getSetting("IMESSAGE_AUTO_REPLY");
    const autoReply =
      !lifeOpsPassiveConnectorsEnabled(this.runtime) &&
      (autoReplyRaw === true || autoReplyRaw === "true");

    if (!autoReply) {
      // Persist the inbound memory so LifeOps and history views still see it.
      try {
        await this.runtime.createMemory(memory, "messages");
      } catch (err) {
        logger.warn(
          `[imessage] Failed to persist inbound memory for ROWID=${row.rowId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      logger.debug(
        "[imessage] Auto-reply disabled (IMESSAGE_AUTO_REPLY=false); message ingested without response"
      );
      return;
    }

    // Route through the message service — this is what actually triggers
    // the agent's decision pipeline (shouldRespond → generate → callback).
    if (!this.runtime.messageService) {
      logger.error(
        "[imessage] runtime.messageService is null; cannot route inbound message. " +
          "Ensure the bootstrap plugin (or a custom IMessageService) is registered " +
          "before the iMessage plugin starts."
      );
      return;
    }

    await this.runtime.messageService.handleMessage(this.runtime, memory, callback);
  }

  /**
   * Handle non-conversational chat.db rows — reactions, group events,
   * anything that isn't a normal text turn. These shouldn't flow through
   * `messageService.handleMessage` (which would try to generate a reply)
   * but they're still useful to surface as plugin-namespaced events so
   * listeners can react, log, or update state.
   *
   * Emits two events:
   *   - A plugin-namespaced event on the existing `IMessageEventTypes`
   *     enum (e.g. `IMESSAGE_REACTION_RECEIVED`).
   *   - The generic `EventType.REACTION_RECEIVED` from core when the
   *     row is a reaction, so core-level handlers see it.
   */
  private emitAuxiliaryEvent(row: ChatDbMessage): void {
    if (!this.runtime) return;
    const accountId = IMESSAGE_LOCAL_ACCOUNT_ID;

    if (row.kind === "reaction" && row.reaction) {
      logger.debug(
        `[imessage] reaction ${row.reaction.add ? "+" : "-"}${row.reaction.kind} on guid=${row.reaction.targetGuid} by ${row.handle}`
      );
      this.runtime.emitEvent(IMessageEventTypes.REACTION_RECEIVED, {
        runtime: this.runtime,
        source: "imessage",
        accountId,
        chatId: row.chatId,
        handle: row.handle,
        targetGuid: row.reaction.targetGuid,
        reactionKind: row.reaction.kind,
        add: row.reaction.add,
        emoji: row.reaction.emoji,
        service: row.service,
      } as EventPayload);
      this.runtime.emitEvent(EventType.REACTION_RECEIVED, {
        runtime: this.runtime,
        source: "imessage",
        accountId,
        targetGuid: row.reaction.targetGuid,
        reactionKind: row.reaction.kind,
        add: row.reaction.add,
        emoji: row.reaction.emoji,
      } as EventPayload);
      return;
    }

    if (row.kind === "system") {
      logger.debug(
        `[imessage] system event ROWID=${row.rowId} handle=${row.handle} chat=${row.chatId}`
      );
      // No core equivalent — plugin-namespaced only.
      this.runtime.emitEvent(
        "IMESSAGE_SYSTEM_EVENT" as never,
        {
          runtime: this.runtime,
          source: "imessage",
          accountId,
          chatId: row.chatId,
          handle: row.handle,
          rowId: row.rowId,
          guid: row.guid,
        } as EventPayload
      );
    }
  }

  private isAllowed(handle: string): boolean {
    if (!this.settings) {
      return false;
    }

    if (this.settings.dmPolicy === "open") {
      return true;
    }

    if (this.settings.dmPolicy === "disabled") {
      return false;
    }

    if (this.settings.dmPolicy === "allowlist") {
      return this.settings.allowFrom.some(
        (allowed) => allowed.toLowerCase() === handle.toLowerCase()
      );
    }

    // pairing - allow and track
    return true;
  }

  /**
   * Register a recurring heartbeat task with Eliza's task system and
   * kick off one if it isn't already queued.
   *
   * The heartbeat runs once a minute (configurable via
   * `IMESSAGE_HEARTBEAT_INTERVAL_MS`) and does a lightweight health
   * probe: (a) chat.db reader is still open and responsive,
   * (b) Contacts map still populated, (c) polling cursor is advancing
   * when expected. On failure it logs + emits
   * `IMESSAGE_HEARTBEAT_UNHEALTHY`; on success it emits
   * `IMESSAGE_HEARTBEAT_OK`. Observers (Eliza's heartbeat UI, ops
   * dashboards, trajectory logger) subscribe to these events.
   *
   * The task is tagged `["queue", "repeat", "imessage"]` so Eliza's
   * built-in TaskService picks it up via its standard polling loop.
   * Without `updateInterval` being set in metadata, the task fires
   * once and then deletes; with it, the task service re-schedules.
   */
  private async registerHeartbeat(): Promise<void> {
    if (!this.runtime) return;

    if (typeof this.runtime.registerTaskWorker !== "function") {
      logger.debug("[imessage][heartbeat] runtime does not support registerTaskWorker — skipping");
      return;
    }

    const heartbeatIntervalMs = Number(process.env.IMESSAGE_HEARTBEAT_INTERVAL_MS) || 60_000;

    this.runtime.registerTaskWorker({
      name: "IMESSAGE_HEARTBEAT",
      execute: async (runtime, _options, _task) => {
        let ok = true;
        let reason = "";
        let tip = 0;
        let contactsCount = 0;
        try {
          if (!this.chatDb) {
            ok = false;
            reason = "chat.db reader not available (send-only mode)";
          } else {
            tip = this.chatDb.getLatestRowId();
            if (tip <= 0) {
              ok = false;
              reason = "chat.db getLatestRowId returned 0";
            }
          }
          contactsCount = this.contacts.size;
        } catch (err) {
          ok = false;
          reason = err instanceof Error ? err.message : String(err);
        }

        logger.debug(
          `[imessage][heartbeat] ok=${ok} tip=${tip} cursor=${this.lastRowId} contacts=${contactsCount}${reason ? ` reason=${reason}` : ""}`
        );

        runtime.emitEvent(
          ok ? "IMESSAGE_HEARTBEAT_OK" : ("IMESSAGE_HEARTBEAT_UNHEALTHY" as never),
          {
            runtime,
            source: "imessage",
            ok,
            reason,
            tip,
            cursor: this.lastRowId,
            contactsCount,
            connected: this.connected,
            timestamp: Date.now(),
          } as EventPayload
        );
        return { nextInterval: heartbeatIntervalMs };
      },
      shouldRun: async () => true,
    });

    // Only create the task if one doesn't already exist. This is safe
    // across restarts — on a cold boot no task exists yet, on a warm
    // restart the previous one is still in the queue and we skip.
    if (hasTaskLookup(this.runtime)) {
      try {
        const existing = await this.runtime.getTasksByName("IMESSAGE_HEARTBEAT");
        if (Array.isArray(existing) && existing.length > 0) {
          logger.debug(
            `[imessage][heartbeat] task already registered (${existing.length} existing) — skipping createTask`
          );
          return;
        }
      } catch {
        // If the query fails, fall through and try createTask anyway.
      }
    }

    if (typeof this.runtime.createTask === "function") {
      try {
        await this.runtime.createTask({
          name: "IMESSAGE_HEARTBEAT",
          description:
            "Periodic health probe for the iMessage connector (chat.db reader, contacts, polling cursor).",
          metadata: {
            updatedAt: Date.now(),
            updateInterval: heartbeatIntervalMs,
            blocking: true,
          },
          tags: ["queue", "repeat", "imessage"],
        });
        logger.debug(`[imessage][heartbeat] task registered, interval ${heartbeatIntervalMs}ms`);
      } catch (err) {
        logger.warn(
          `[imessage][heartbeat] createTask failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}

/**
 * Resolve a chat.db attachment's mime/UTI to one of the five ContentType
 * buckets the core Memory.content type accepts. Anything we can't bucket
 * falls back to `"document"` which is the catch-all.
 */
function mimeToContentType(mimeType: string | null, uti: string | null): ContentType {
  const m = (mimeType ?? "").toLowerCase();
  const u = (uti ?? "").toLowerCase();
  if (m.startsWith("image/") || u.includes("image")) return ContentType.IMAGE;
  if (m.startsWith("video/") || u.includes("movie") || u.includes("video")) {
    return ContentType.VIDEO;
  }
  if (m.startsWith("audio/") || u.includes("audio")) return ContentType.AUDIO;
  return ContentType.DOCUMENT;
}

/**
 * Convert a `ChatDbMessage` (the shape the bun:sqlite reader returns)
 * into the public `IMessageMessage` shape exposed by this plugin's API.
 * Exported so the test suite can exercise it in isolation without
 * spinning up a full runtime + service instance.
 */
export function chatDbMessageToPublicShape(row: ChatDbMessage): IMessageMessage {
  return {
    id: String(row.rowId),
    text: row.text,
    handle: row.handle,
    chatId: row.chatId,
    timestamp: row.timestamp,
    isFromMe: row.isFromMe,
    hasAttachments: row.attachments.length > 0,
    ...(row.attachments.length > 0
      ? {
          attachmentPaths: row.attachments
            .map((attachment) => attachment.filename)
            .filter((filename): filename is string => Boolean(filename)),
        }
      : {}),
  };
}

/**
 * Parse tab-delimited AppleScript messages output.
 * Expected format per line: "id\ttext\tdate_sent\tis_from_me\tchat_identifier\tsender"
 */
export function parseMessagesFromAppleScript(result: string): IMessageMessage[] {
  const messages: IMessageMessage[] = [];
  if (!result?.trim()) {
    return messages;
  }

  for (const line of result.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const fields = trimmed.split("\t");
    if (fields.length < 6) {
      continue;
    }

    const [id, text, dateSent, isFromMeStr, chatIdentifier, sender] = fields;

    const isFromMe = isFromMeStr === "1" || isFromMeStr.toLowerCase() === "true";

    let timestamp: number;
    const parsed = Number(dateSent);
    if (!Number.isNaN(parsed) && parsed > 0) {
      timestamp = parsed;
    } else {
      const dateObj = new Date(dateSent);
      timestamp = Number.isNaN(dateObj.getTime()) ? 0 : dateObj.getTime();
    }

    messages.push({
      id: id || "",
      text: text || "",
      handle: sender || "",
      chatId: chatIdentifier || "",
      timestamp,
      isFromMe,
      hasAttachments: false,
    });
  }

  return messages;
}

/**
 * Parse tab-delimited AppleScript chats output.
 * Expected format per line: "chat_identifier\tdisplay_name\tparticipant_count\tlast_message_date"
 */
export function parseChatsFromAppleScript(result: string): IMessageChat[] {
  const chats: IMessageChat[] = [];
  if (!result?.trim()) {
    return chats;
  }

  const listStyleEntryPattern = /\{\s*"([^"]*)"\s*,\s*(?:"([^"]*)"|(missing value))\s*\}/g;
  const listStyleMatches = Array.from(result.matchAll(listStyleEntryPattern));
  if (listStyleMatches.length > 0) {
    for (const match of listStyleMatches) {
      const chatIdentifier = match[1] ?? "";
      const displayName = match[2];
      chats.push({
        chatId: chatIdentifier,
        chatType: chatIdentifier.includes(";+;") ? "group" : "direct",
        displayName: displayName || undefined,
        participants: [],
      });
    }
    return chats;
  }

  for (const line of result.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const fields = trimmed.split("\t");
    if (fields.length < 4) {
      continue;
    }

    const [chatIdentifier, displayName, participantCountStr] = fields;

    const participantCount = Number(participantCountStr) || 0;
    const chatType: IMessageChatType = participantCount > 1 ? "group" : "direct";

    chats.push({
      chatId: chatIdentifier || "",
      chatType,
      displayName: displayName || undefined,
      participants: [],
    });
  }

  return chats;
}
