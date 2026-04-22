import {
  defaultTelegramAccountDeviceModel,
  defaultTelegramAccountSystemVersion,
  loadTelegramAccountSessionString,
} from "../../../../plugins/plugin-telegram/src/account-auth-service.ts";
import type {
  LifeOpsTelegramDialogSummary,
  VerifyLifeOpsTelegramConnectorResponse,
} from "@elizaos/shared/contracts/lifeops";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import type { StoredTelegramConnectorToken } from "./telegram-auth.js";
import { readStoredTelegramToken } from "./telegram-auth.js";

export interface TelegramLocalClientLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getDialogs(args: { limit: number }): Promise<ReadonlyArray<TelegramDialogLike>>;
  getEntity(target: unknown): Promise<unknown>;
  sendMessage(
    entity: unknown,
    args: { message: string },
  ): Promise<{ id?: unknown } | null | undefined>;
  getMessages(
    entity: unknown,
    args: { search: string; limit: number },
  ): Promise<ReadonlyArray<TelegramMessageLike>>;
}

export interface TelegramMessageLike {
  id?: unknown;
  message?: string;
  date?: Date | number | string;
  out?: boolean;
  fromId?: { userId?: unknown } | null;
  peerId?: { userId?: unknown; chatId?: unknown; channelId?: unknown } | null;
  /** Read receipt flag: for outbound messages, indicates the other side has read it */
  mentioned?: boolean;
  /** Number of reads (for group messages via `getMessageReadParticipants`) */
  readCount?: number | null;
}

export interface TelegramDialogLike {
  id?: unknown;
  name?: string;
  title?: string;
  unreadCount?: number;
  message?: {
    message?: string;
    date?: Date | number | string;
  } | null;
  entity?: Record<string, unknown> | null;
  inputEntity?: unknown;
}

export interface TelegramMessageSearchResult {
  id: string;
  chatId: string | null;
  target: string | null;
  text: string | null;
  sentAt: string | null;
  outbound: boolean;
}

export interface TelegramReadReceiptResult {
  messageId: string;
  read: boolean;
  readCount: number | null;
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
    return new Date(value < 1_000_000_000_000 ? value * 1000 : value)
      .toISOString();
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

function dialogSummary(dialog: TelegramDialogLike): LifeOpsTelegramDialogSummary {
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
      typeof dialog.unreadCount === "number" && Number.isFinite(dialog.unreadCount)
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
      : token.connectorConfig?.appHash?.trim() ?? "";
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
    const lookup = normalizeLookup(trimmed);
    const exact = dialogs.find((dialog) =>
      collectDialogAliases(dialog).includes(lookup),
    );
    if (exact) {
      return exact.inputEntity ?? exact.entity ?? exact;
    }

    const partial = dialogs.find((dialog) =>
      collectDialogAliases(dialog).some((alias) => alias.includes(lookup)),
    );
    if (partial) {
      return partial.inputEntity ?? partial.entity ?? partial;
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
  const loadSessionString = deps.loadSessionString ?? loadTelegramAccountSessionString;
  const token = readStoredToken(tokenRef);
  if (!token) {
    throw new Error("Telegram connector token is missing.");
  }

  const sessionString = loadSessionString().trim();
  if (sessionString.length === 0) {
    throw new Error("Telegram account session is missing. Reconnect Telegram.");
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

export function telegramLocalSessionAvailable(
  deps: Pick<TelegramLocalClientDeps, "loadSessionString"> = {},
): boolean {
  const loadSessionString = deps.loadSessionString ?? loadTelegramAccountSessionString;
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
    const dialogs = Array.from(await client.getDialogs({ limit: MAX_RECENT_LIMIT }));
    const entity = await resolveTelegramTarget(client, args.target, dialogs);
    const sent = await client.sendMessage(entity, { message: args.message });
    return {
      messageId: sent?.id !== undefined ? serializeTelegramId(sent.id) : null,
    };
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
    args.sendMessage?.trim() || `LifeOps Telegram verification ${now().toISOString()}`;

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
      messageId = sent?.id !== undefined ? serializeTelegramId(sent.id) : null;
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
    return [];
  }

  const limit = normalizeRecentLimit(args.limit);
  return withTelegramLocalClient(args.tokenRef, deps, async (client) => {
    const dialogs = Array.from(await client.getDialogs({ limit: MAX_RECENT_LIMIT }));
    const hasScope = typeof args.scope === "string" && args.scope.trim().length > 0;
    const scopedDialogs = hasScope
      ? dialogs.filter((dialog) =>
          collectDialogAliases(dialog).some(
            (alias) => alias === normalizeLookup(args.scope ?? ""),
          ),
        )
      : dialogs;

    // If scope was provided but no matching dialog found, attempt entity resolution or throw
    if (hasScope && scopedDialogs.length === 0) {
      try {
        const entity = await client.getEntity(args.scope!.trim());
        const messages = await client.getMessages(entity, { search: query, limit });
        return messages.map((message, idx) => ({
          id: serializeTelegramId(message.id) || `${args.scope}:${idx}`,
          chatId: null,
          target: args.scope!.trim(),
          text:
            typeof message.message === "string" && message.message.trim().length > 0
              ? message.message.trim()
              : null,
          sentAt: toIsoDate(message.date),
          outbound: message.out === true,
        })).slice(0, limit);
      } catch {
        throw new Error(`Telegram scope "${args.scope}" was not found.`);
      }
    }

    const results: TelegramMessageSearchResult[] = [];
    // Calculate per-dialog budget to avoid over-fetching
    const perDialogLimit = scopedDialogs.length > 0
      ? Math.max(1, Math.ceil(limit / scopedDialogs.length))
      : limit;

    for (const dialog of scopedDialogs) {
      if (results.length >= limit) break;
      const entity = dialog.inputEntity ?? dialog.entity ?? dialog;
      const messages = await client.getMessages(entity, { search: query, limit: perDialogLimit });
      const title = normalizeDialogTitle(dialog);
      let dialogMsgIdx = 0;
      for (const message of messages) {
        if (results.length >= limit) break;
        results.push({
          // Scope fallback ID counter per-dialog to avoid collisions
          id: serializeTelegramId(message.id) || `${title}:${dialogMsgIdx++}`,
          chatId: serializeTelegramId(dialog.id) || null,
          target: title,
          text:
            typeof message.message === "string" && message.message.trim().length > 0
              ? message.message.trim()
              : null,
          sentAt: toIsoDate(message.date),
          outbound: message.out === true,
        });
      }
    }

    return results.slice(0, limit);
  });
}

export async function getTelegramReadReceipts(args: {
  tokenRef: string;
  target: string;
  messageIds: string[];
  deps?: TelegramLocalClientDeps;
}): Promise<TelegramReadReceiptResult[]> {
  const deps = args.deps ?? {};
  const requested = new Set(
    args.messageIds
      .map((messageId) => messageId.trim())
      .filter((messageId) => messageId.length > 0),
  );
  if (requested.size === 0) {
    return [];
  }

  return withTelegramLocalClient(args.tokenRef, deps, async (client) => {
    const dialogs = Array.from(await client.getDialogs({ limit: MAX_RECENT_LIMIT }));
    const entity = await resolveTelegramTarget(client, args.target, dialogs);
    const messages = await client.getMessages(entity, {
      search: "",
      limit: Math.max(requested.size * 2, MAX_RECENT_LIMIT),
    });

    const receipts: TelegramReadReceiptResult[] = [];
    for (const message of messages) {
      const messageId = serializeTelegramId(message.id);
      if (!requested.has(messageId)) {
        continue;
      }

      receipts.push({
        messageId,
        read:
          message.mentioned === true ||
          (typeof message.readCount === "number" && message.readCount > 0),
        readCount:
          typeof message.readCount === "number" && Number.isFinite(message.readCount)
            ? message.readCount
            : null,
      });
    }

    return args.messageIds.map((messageId) => {
      const found = receipts.find((receipt) => receipt.messageId === messageId);
      return (
        found ?? {
          messageId,
          read: false,
          readCount: null,
        }
      );
    });
  });
}
