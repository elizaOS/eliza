// Deprecated LifeOps fallback shim. Active LifeOps Telegram mixins no longer
// call this direct GramJS client; Telegram messaging should go through
// @elizaos/plugin-telegram runtime services. This remains only for legacy
// owner-session cleanup/tests until plugin-side read receipts cover the gap.
import {
  defaultTelegramAccountDeviceModel,
  defaultTelegramAccountSystemVersion,
  loadTelegramAccountSessionString,
} from "@elizaos/plugin-telegram/account-auth-service";
import type {
  LifeOpsTelegramDialogSummary,
  VerifyLifeOpsTelegramConnectorResponse,
} from "@elizaos/shared";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import type { StoredTelegramConnectorToken } from "./telegram-auth.js";
import { readStoredTelegramToken } from "./telegram-auth.js";

export interface TelegramLocalClientLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getDialogs(args: {
    limit: number;
  }): Promise<ReadonlyArray<TelegramDialogLike>>;
  getEntity(target: unknown): Promise<unknown>;
  sendMessage(
    entity: unknown,
    args: { message: string },
  ): Promise<{ id?: unknown } | null | undefined>;
  getMessages(
    entity: unknown,
    args: {
      search?: string;
      ids?: number | number[];
      limit?: number;
    },
  ): Promise<ReadonlyArray<TelegramMessageLike | null | undefined>>;
}

export interface TelegramMessageLike {
  id?: unknown;
  message?: string;
  date?: Date | number | string;
  out?: boolean;
  fromId?: { userId?: unknown } | null;
  peerId?: { userId?: unknown; chatId?: unknown; channelId?: unknown } | null;
  /** Whether the current account was mentioned in this message. */
  mentioned?: boolean;
  /** Optional group/channel read count when present on the returned message. */
  readCount?: number | null;
}

export type TelegramDeliveryStatus = "delivered_read" | "sent" | "unknown";

export interface TelegramMessageSearchResult {
  id: string | null;
  dialogId: string | null;
  threadId: string | null;
  dialogTitle: string | null;
  username: string | null;
  peerId: string | null;
  senderId: string | null;
  content: string;
  timestamp: string | null;
  outgoing: boolean;
}

export interface TelegramReadReceiptResult {
  messageId: string;
  status: TelegramDeliveryStatus;
  isRead: boolean | null;
  timestamp: string | null;
  content: string | null;
  outgoing: boolean | null;
}

export interface TelegramDialogLike {
  id?: unknown;
  name?: string;
  title?: string;
  unreadCount?: number;
  dialog?: {
    readOutboxMaxId?: unknown;
  } | null;
  message?: {
    message?: string;
    date?: Date | number | string;
  } | null;
  entity?: Record<string, unknown> | null;
  inputEntity?: unknown;
}

export interface TelegramLocalClientDeps {
  loadSessionString?: () => string;
  readStoredToken?: (tokenRef: string) => StoredTelegramConnectorToken | null;
  createClient?: (args: {
    sessionString: string;
    apiId: number;
    apiHash: string;
    deviceModel: string;
    systemVersion: string;
  }) => TelegramLocalClientLike;
  now?: () => Date;
}

const DEFAULT_RECENT_LIMIT = 5;
const MAX_RECENT_LIMIT = 10;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;
const MAX_TARGET_LOOKUP_DIALOGS = 100;
export const TELEGRAM_LOCAL_MOCK_SESSION_PREFIX = "mock-lifeops-simulator:";

function createGramJsClient(args: {
  sessionString: string;
  apiId: number;
  apiHash: string;
  deviceModel: string;
  systemVersion: string;
}): TelegramLocalClientLike {
  return new TelegramClient(
    new StringSession(args.sessionString),
    args.apiId,
    args.apiHash,
    {
      connectionRetries: 5,
      deviceModel: args.deviceModel,
      systemVersion: args.systemVersion,
    },
  ) as unknown as TelegramLocalClientLike;
}

function serializeTelegramId(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    const text = value.toString();
    if (text.length > 0 && text !== "[object Object]") {
      return text;
    }
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

function toIsoDate(value: Date | number | string | undefined): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(
      value < 1_000_000_000_000 ? value * 1000 : value,
    ).toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return null;
}

function normalizeDialogTitle(dialog: TelegramDialogLike): string {
  const title =
    (typeof dialog.title === "string" && dialog.title.trim()) ||
    (typeof dialog.name === "string" && dialog.name.trim()) ||
    (typeof dialog.entity?.username === "string" &&
    dialog.entity.username.trim().length > 0
      ? `@${dialog.entity.username.trim()}`
      : "");
  return title || "Untitled chat";
}

function dialogSummary(
  dialog: TelegramDialogLike,
): LifeOpsTelegramDialogSummary {
  return {
    id: serializeTelegramId(dialog.id) || normalizeDialogTitle(dialog),
    title: normalizeDialogTitle(dialog),
    username:
      typeof dialog.entity?.username === "string" &&
      dialog.entity.username.trim().length > 0
        ? dialog.entity.username.trim()
        : null,
    lastMessageText:
      typeof dialog.message?.message === "string" &&
      dialog.message.message.trim().length > 0
        ? dialog.message.message.trim()
        : null,
    lastMessageAt: toIsoDate(dialog.message?.date ?? undefined),
    unreadCount:
      typeof dialog.unreadCount === "number" &&
      Number.isFinite(dialog.unreadCount)
        ? dialog.unreadCount
        : 0,
  };
}

function resolveApiCredentials(token: StoredTelegramConnectorToken): {
  apiId: number;
  apiHash: string;
} {
  const apiId =
    token.apiId > 0
      ? token.apiId
      : Number.parseInt(token.connectorConfig?.appId ?? "", 10);
  const apiHash =
    token.apiHash.trim().length > 0
      ? token.apiHash.trim()
      : (token.connectorConfig?.appHash?.trim() ?? "");
  if (!Number.isInteger(apiId) || apiId <= 0 || apiHash.length === 0) {
    throw new Error("Telegram connector is missing MTProto credentials.");
  }
  return { apiId, apiHash };
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "");
}

function collectDialogAliases(dialog: TelegramDialogLike): string[] {
  const aliases = new Set<string>();
  const values = [
    dialog.title,
    dialog.name,
    dialog.entity?.username,
    dialog.entity?.phone,
    serializeTelegramId(dialog.id),
  ];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = normalizeLookup(value);
    if (normalized.length > 0) {
      aliases.add(normalized);
    }
  }
  return [...aliases];
}

function findMatchingDialog(
  target: string,
  dialogs: ReadonlyArray<TelegramDialogLike>,
): TelegramDialogLike | null {
  const lookup = normalizeLookup(target);
  if (lookup.length === 0) {
    return null;
  }

  const exact = dialogs.find((dialog) =>
    collectDialogAliases(dialog).includes(lookup),
  );
  if (exact) {
    return exact;
  }

  return (
    dialogs.find((dialog) =>
      collectDialogAliases(dialog).some((alias) => alias.includes(lookup)),
    ) ?? null
  );
}

interface TelegramLocalMockMessage extends TelegramMessageLike {
  dialogId: string;
}

interface TelegramLocalMockDialog extends TelegramDialogLike {
  id: string;
  inputEntity: { id: string };
  messages: TelegramLocalMockMessage[];
}

interface TelegramLocalMockSession {
  dialogs: Array<{
    id: string;
    title: string;
    username?: string;
    unreadCount?: number;
    readOutboxMaxId?: number;
    messages: Array<{
      id: number;
      message: string;
      date: string;
      out?: boolean;
      fromId?: string;
    }>;
  }>;
}

const telegramLocalMockStates = new Map<string, TelegramLocalMockDialog[]>();

function decodeTelegramLocalMockSession(
  sessionString: string,
): TelegramLocalMockSession | null {
  if (!sessionString.startsWith(TELEGRAM_LOCAL_MOCK_SESSION_PREFIX)) {
    return null;
  }
  const encoded = sessionString.slice(
    TELEGRAM_LOCAL_MOCK_SESSION_PREFIX.length,
  );
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as TelegramLocalMockSession;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.dialogs)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function materializeTelegramLocalMockDialogs(
  fixture: TelegramLocalMockSession,
): TelegramLocalMockDialog[] {
  return fixture.dialogs.map((dialog) => {
    const entity = {
      id: dialog.id,
      username: dialog.username,
    };
    const messages = dialog.messages.map(
      (message): TelegramLocalMockMessage => ({
        id: message.id,
        message: message.message,
        date: message.date,
        out: message.out === true,
        fromId: { userId: message.fromId ?? dialog.id },
        peerId: { userId: dialog.id },
        dialogId: dialog.id,
      }),
    );
    return {
      id: dialog.id,
      name: dialog.title,
      title: dialog.title,
      unreadCount: dialog.unreadCount ?? 0,
      dialog: { readOutboxMaxId: dialog.readOutboxMaxId ?? 0 },
      message: messages[0]
        ? {
            message: messages[0].message,
            date: messages[0].date,
          }
        : null,
      entity,
      inputEntity: { id: dialog.id },
      messages,
    };
  });
}

function telegramLocalMockDialogsForSession(
  sessionString: string,
): TelegramLocalMockDialog[] | null {
  const existing = telegramLocalMockStates.get(sessionString);
  if (existing) {
    return existing;
  }
  const fixture = decodeTelegramLocalMockSession(sessionString);
  if (!fixture) {
    return null;
  }
  const dialogs = materializeTelegramLocalMockDialogs(fixture);
  telegramLocalMockStates.set(sessionString, dialogs);
  return dialogs;
}

function createTelegramLocalMockClient(
  dialogs: TelegramLocalMockDialog[],
): TelegramLocalClientLike {
  return {
    async connect() {},
    async disconnect() {},
    async getDialogs(args) {
      return dialogs.slice(0, args.limit);
    },
    async getEntity(target) {
      const dialog =
        typeof target === "string" ? findMatchingDialog(target, dialogs) : null;
      if (!dialog) {
        throw new Error(`Telegram mock target not found: ${String(target)}`);
      }
      return dialog.inputEntity;
    },
    async sendMessage(entity, args) {
      const entityId =
        entity && typeof entity === "object" && "id" in entity
          ? serializeTelegramId((entity as { id?: unknown }).id)
          : "";
      const dialog =
        dialogs.find((candidate) => candidate.id === entityId) ?? dialogs[0];
      if (!dialog) {
        throw new Error("Telegram mock has no dialogs to send to.");
      }
      const maxId = dialog.messages.reduce((max, message) => {
        const id = parseNumericId(message.id);
        return id && id > max ? id : max;
      }, 0);
      const sent: TelegramLocalMockMessage = {
        id: maxId + 1,
        message: args.message,
        date: new Date().toISOString(),
        out: true,
        fromId: { userId: "owner" },
        peerId: { userId: dialog.id },
        dialogId: dialog.id,
      };
      dialog.messages.unshift(sent);
      dialog.message = { message: sent.message, date: sent.date };
      return { id: sent.id };
    },
    async getMessages(entity, args) {
      const entityId =
        entity && typeof entity === "object" && "id" in entity
          ? serializeTelegramId((entity as { id?: unknown }).id)
          : "";
      const source = entityId
        ? (dialogs.find((dialog) => dialog.id === entityId)?.messages ?? [])
        : dialogs.flatMap((dialog) => dialog.messages);
      const ids = Array.isArray(args.ids)
        ? args.ids
        : args.ids !== undefined
          ? [args.ids]
          : null;
      const searched = source.filter((message) => {
        if (ids) {
          return ids.some(
            (id) => parseNumericId(id) === parseNumericId(message.id),
          );
        }
        if (args.search?.trim()) {
          return message.message
            ?.toLowerCase()
            .includes(args.search.trim().toLowerCase());
        }
        return true;
      });
      return searched.slice(0, args.limit ?? searched.length);
    },
  };
}

async function resolveTelegramTarget(
  client: TelegramLocalClientLike,
  target: string,
  dialogs: ReadonlyArray<TelegramDialogLike>,
): Promise<unknown> {
  const trimmed = target.trim();
  if (trimmed.length === 0) {
    throw new Error("Telegram target is required.");
  }

  try {
    return await client.getEntity(trimmed);
  } catch {
    const dialog = findMatchingDialog(trimmed, dialogs);
    if (dialog) {
      return dialog.inputEntity ?? dialog.entity ?? dialog;
    }
  }

  throw new Error(`Telegram target "${target}" was not found.`);
}

async function withTelegramLocalClient<T>(
  tokenRef: string,
  deps: TelegramLocalClientDeps,
  work: (client: TelegramLocalClientLike) => Promise<T>,
): Promise<T> {
  const readStoredToken = deps.readStoredToken ?? readStoredTelegramToken;
  const loadSessionString =
    deps.loadSessionString ?? loadTelegramAccountSessionString;
  const token = readStoredToken(tokenRef);
  if (!token) {
    throw new Error("Telegram connector token is missing.");
  }

  const sessionString = loadSessionString().trim();
  if (sessionString.length === 0) {
    throw new Error("Telegram account session is missing. Reconnect Telegram.");
  }

  const mockDialogs = telegramLocalMockDialogsForSession(sessionString);
  if (mockDialogs) {
    return work(createTelegramLocalMockClient(mockDialogs));
  }

  const { apiId, apiHash } = resolveApiCredentials(token);
  const createClient = deps.createClient ?? createGramJsClient;
  const client = createClient({
    sessionString,
    apiId,
    apiHash,
    deviceModel:
      token.connectorConfig?.deviceModel ?? defaultTelegramAccountDeviceModel(),
    systemVersion:
      token.connectorConfig?.systemVersion ??
      defaultTelegramAccountSystemVersion(),
  });

  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.disconnect();
  }
}

function normalizeRecentLimit(limit?: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_RECENT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_RECENT_LIMIT, Math.trunc(limit as number)));
}

function normalizeSearchLimit(limit?: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(limit as number)));
}

function normalizeMessageContent(message: TelegramMessageLike): string {
  return typeof message.message === "string" ? message.message.trim() : "";
}

function parseNumericId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "bigint" && value > 0n) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function readOutboxMaxId(dialog: TelegramDialogLike | null): number | null {
  return parseNumericId(dialog?.dialog?.readOutboxMaxId);
}

function firstNonEmptyTelegramId(values: unknown[]): string | null {
  for (const value of values) {
    const serialized = serializeTelegramId(value);
    if (serialized.length > 0) {
      return serialized;
    }
  }
  return null;
}

function messagePeerId(message: TelegramMessageLike): string | null {
  const peer = message.peerId;
  return firstNonEmptyTelegramId([peer?.userId, peer?.chatId, peer?.channelId]);
}

function messageSenderId(message: TelegramMessageLike): string | null {
  return firstNonEmptyTelegramId([message.fromId?.userId]);
}

function findDialogForMessage(
  message: TelegramMessageLike,
  dialogs: ReadonlyArray<TelegramDialogLike>,
): TelegramDialogLike | null {
  const peerId = messagePeerId(message);
  if (!peerId) {
    return null;
  }
  return (
    dialogs.find((dialog) => serializeTelegramId(dialog.id) === peerId) ?? null
  );
}

function isGlobalSearchScope(scope?: string): boolean {
  const normalized = scope?.trim().toLowerCase();
  return (
    !normalized ||
    normalized === "*" ||
    normalized === "all" ||
    normalized === "global"
  );
}

export function telegramLocalSessionAvailable(
  deps: Pick<TelegramLocalClientDeps, "loadSessionString"> = {},
): boolean {
  const loadSessionString =
    deps.loadSessionString ?? loadTelegramAccountSessionString;
  return loadSessionString().trim().length > 0;
}

export async function listRecentTelegramDialogs(args: {
  tokenRef: string;
  limit?: number;
  deps?: TelegramLocalClientDeps;
}): Promise<LifeOpsTelegramDialogSummary[]> {
  const deps = args.deps ?? {};
  const limit = normalizeRecentLimit(args.limit);
  return withTelegramLocalClient(args.tokenRef, deps, async (client) => {
    const dialogs = await client.getDialogs({ limit });
    return Array.from(dialogs)
      .slice(0, limit)
      .map((dialog) => dialogSummary(dialog));
  });
}

export async function sendTelegramAccountMessage(args: {
  tokenRef: string;
  target: string;
  message: string;
  deps?: TelegramLocalClientDeps;
}): Promise<{ messageId: string | null }> {
  const deps = args.deps ?? {};
  return withTelegramLocalClient(args.tokenRef, deps, async (client) => {
    const dialogs = Array.from(
      await client.getDialogs({ limit: MAX_TARGET_LOOKUP_DIALOGS }),
    );
    const entity = await resolveTelegramTarget(client, args.target, dialogs);
    const sent = await client.sendMessage(entity, { message: args.message });
    const messageId =
      sent?.id !== undefined ? serializeTelegramId(sent.id) : "";
    if (messageId.length === 0) {
      throw new Error("Telegram send did not return a message id.");
    }
    return {
      messageId,
    };
  });
}

export async function searchTelegramMessages(args: {
  tokenRef: string;
  query: string;
  scope?: string;
  limit?: number;
  deps?: TelegramLocalClientDeps;
}): Promise<TelegramMessageSearchResult[]> {
  const deps = args.deps ?? {};
  const query = args.query.trim();
  if (query.length === 0) {
    throw new Error("Telegram search query is required.");
  }

  const limit = normalizeSearchLimit(args.limit);
  return withTelegramLocalClient(args.tokenRef, deps, async (client) => {
    const dialogs = Array.from(
      await client.getDialogs({ limit: MAX_TARGET_LOOKUP_DIALOGS }),
    );
    const scoped = !isGlobalSearchScope(args.scope);
    const scope = args.scope?.trim() ?? "";
    const dialog = scoped ? findMatchingDialog(scope, dialogs) : null;
    const entity = scoped
      ? await resolveTelegramTarget(client, scope, dialogs)
      : undefined;
    const messages = Array.from(
      await client.getMessages(entity, { search: query, limit }),
    );

    return messages
      .filter((message): message is TelegramMessageLike => Boolean(message))
      .slice(0, limit)
      .map((message) => {
        const messageDialog = dialog ?? findDialogForMessage(message, dialogs);
        const dialogId =
          messageDialog?.id !== undefined
            ? serializeTelegramId(messageDialog.id) || null
            : null;
        const username =
          typeof messageDialog?.entity?.username === "string" &&
          messageDialog.entity.username.trim().length > 0
            ? messageDialog.entity.username.trim()
            : null;
        return {
          id:
            message.id !== undefined
              ? serializeTelegramId(message.id) || null
              : null,
          dialogId,
          threadId: dialogId,
          dialogTitle: messageDialog
            ? normalizeDialogTitle(messageDialog)
            : null,
          username,
          peerId: messagePeerId(message),
          senderId: messageSenderId(message),
          content: normalizeMessageContent(message),
          timestamp: toIsoDate(message.date),
          outgoing: message.out === true,
        };
      });
  });
}

export async function getTelegramReadReceipts(args: {
  tokenRef: string;
  target: string;
  messageIds: string[];
  deps?: TelegramLocalClientDeps;
}): Promise<TelegramReadReceiptResult[]> {
  const deps = args.deps ?? {};
  const target = args.target.trim();
  if (target.length === 0) {
    throw new Error("Telegram receipt lookup target is required.");
  }

  const requestedIds = args.messageIds
    .map((messageId) => ({
      raw: messageId,
      parsed: parseNumericId(messageId),
    }))
    .filter((entry) => entry.raw.trim().length > 0);
  if (requestedIds.length === 0) {
    return [];
  }

  return withTelegramLocalClient(args.tokenRef, deps, async (client) => {
    const dialogs = Array.from(
      await client.getDialogs({ limit: MAX_TARGET_LOOKUP_DIALOGS }),
    );
    const dialog = findMatchingDialog(target, dialogs);
    const entity = await resolveTelegramTarget(client, target, dialogs);
    const ids = requestedIds
      .map((entry) => entry.parsed)
      .filter((value): value is number => value !== null);
    const readMaxId = readOutboxMaxId(dialog);
    const messageMap = new Map<number, TelegramMessageLike>();

    if (ids.length > 0) {
      const messages = Array.from(await client.getMessages(entity, { ids }));
      for (const message of messages) {
        if (!message) {
          continue;
        }
        const messageId = parseNumericId(message.id);
        if (messageId !== null) {
          messageMap.set(messageId, message);
        }
      }
    }

    return requestedIds.map(({ raw, parsed }) => {
      if (parsed === null) {
        return {
          messageId: raw,
          status: "unknown",
          isRead: null,
          timestamp: null,
          content: null,
          outgoing: null,
        };
      }

      const message = messageMap.get(parsed);
      if (!message) {
        return {
          messageId: raw,
          status: "unknown",
          isRead: null,
          timestamp: null,
          content: null,
          outgoing: null,
        };
      }

      const outgoing = message.out === true;
      const isRead =
        outgoing && readMaxId !== null ? parsed <= readMaxId : null;
      return {
        messageId: raw,
        status:
          isRead === true ? "delivered_read" : outgoing ? "sent" : "unknown",
        isRead,
        timestamp: toIsoDate(message.date),
        content: normalizeMessageContent(message) || null,
        outgoing,
      };
    });
  });
}

export async function verifyTelegramLocalConnector(args: {
  tokenRef: string;
  recentLimit?: number;
  sendTarget?: string;
  sendMessage?: string;
  deps?: TelegramLocalClientDeps;
}): Promise<Omit<VerifyLifeOpsTelegramConnectorResponse, "provider" | "side">> {
  const deps = args.deps ?? {};
  const limit = normalizeRecentLimit(args.recentLimit);
  const now = deps.now ?? (() => new Date());
  const target = args.sendTarget?.trim() || "me";
  const message =
    args.sendMessage?.trim() ||
    `LifeOps Telegram verification ${now().toISOString()}`;

  return withTelegramLocalClient(args.tokenRef, deps, async (client) => {
    let dialogs: ReadonlyArray<TelegramDialogLike> = [];
    let readError: string | null = null;
    try {
      dialogs = Array.from(await client.getDialogs({ limit }));
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }

    let messageId: string | null = null;
    let sendError: string | null = null;
    try {
      const entity = await resolveTelegramTarget(client, target, dialogs);
      const sent = await client.sendMessage(entity, { message });
      const sentMessageId =
        sent?.id !== undefined ? serializeTelegramId(sent.id) : "";
      if (sentMessageId.length === 0) {
        throw new Error("Telegram send did not return a message id.");
      }
      messageId = sentMessageId;
    } catch (error) {
      sendError = error instanceof Error ? error.message : String(error);
    }

    return {
      verifiedAt: now().toISOString(),
      read: {
        ok: readError === null,
        error: readError,
        dialogCount: dialogs.length,
        dialogs: dialogs.slice(0, limit).map((dialog) => dialogSummary(dialog)),
      },
      send: {
        ok: sendError === null,
        error: sendError,
        target,
        message,
        messageId,
      },
    };
  });
}
