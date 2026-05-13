/**
 * Conversation CRUD routes extracted from server.ts.
 *
 * Handles:
 *   POST   /api/conversations            – create
 *   GET    /api/conversations             – list
 *   GET    /api/conversations/:id/messages – get messages
 *   POST   /api/conversations/:id/messages/truncate – truncate
 *   POST   /api/conversations/:id/messages/stream   – stream message
 *   POST   /api/conversations/:id/messages           – send message
 *   POST   /api/conversations/:id/greeting            – get/store greeting
 *   PATCH  /api/conversations/:id         – update/rename
 *   DELETE /api/conversations/:id         – delete
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RouteRequestContext } from "@elizaos/core";
import {
  type AgentRuntime,
  ChannelType,
  type Content,
  createMessageMemory,
  logger,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  cacheDiscordAvatarForRuntime,
  isCanonicalDiscordSource,
  resolveDiscordMessageAuthorProfile,
  resolveDiscordUserProfile,
  resolveStoredDiscordEntityProfile,
} from "@elizaos/plugin-discord";
import {
  PatchConversationRequestSchema,
  PostConversationCleanupEmptyRequestSchema,
  PostConversationRequestSchema,
  PostConversationTruncateRequestSchema,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import { resolveStateDir } from "../config/paths.ts";
import type { ChatGenerationResult, LogEntry } from "./chat-routes.ts";
import {
  classifyChatFailure,
  generateChatResponse,
  generateConversationTitle,
  getChatFailureReply,
  hasRecentVisibleAssistantMemorySince,
  initSse,
  normalizeChatResponseText,
  persistAssistantConversationMemory,
  persistConversationMemory,
  readChatRequestPayload,
  resolveNoResponseFallback,
  writeChatTokenSse,
  writeSse,
  writeSseJson,
} from "./chat-routes.ts";
import { resolveClientChatAdminEntityId } from "./client-chat-admin.ts";
import {
  buildConversationRoomMetadata,
  sanitizeConversationMetadata,
} from "./conversation-metadata.ts";
import { evictOldestConversation } from "./memory-bounds.ts";
import {
  buildUserMessages,
  getErrorMessage,
  resolveAppUserName,
  resolveConversationGreetingText,
  resolveWalletModeGuidanceReply,
} from "./server-helpers.ts";
import type { ConversationMeta } from "./server-types.ts";

// ---------------------------------------------------------------------------
// Deleted-conversations state persistence
// ---------------------------------------------------------------------------

const DELETED_CONVERSATIONS_FILENAME = "deleted-conversations.v1.json";
const MAX_DELETED_CONVERSATION_IDS = 5000;

interface DeletedConversationsStateFile {
  version: 1;
  updatedAt: string;
  ids: string[];
}

function _readDeletedConversationIdsFromState(): Set<string> {
  const filePath = path.join(resolveStateDir(), DELETED_CONVERSATIONS_FILENAME);
  if (!fs.existsSync(filePath)) return new Set();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DeletedConversationsStateFile>;
    const ids = Array.isArray(parsed.ids) ? parsed.ids : [];
    return new Set(
      ids
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id) => id.length > 0),
    );
  } catch (err) {
    logger.warn(
      `[eliza-api] Failed to read deleted conversations state: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Set();
  }
}

function persistDeletedConversationIdsToState(ids: Set<string>): void {
  const dir = resolveStateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const normalized = Array.from(ids)
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(-MAX_DELETED_CONVERSATION_IDS);

  const payload: DeletedConversationsStateFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ids: normalized,
  };

  fs.writeFileSync(
    path.join(dir, DELETED_CONVERSATIONS_FILENAME),
    JSON.stringify(payload, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );
}

// ---------------------------------------------------------------------------
// State interface required by conversation routes
// ---------------------------------------------------------------------------

export interface ConversationRouteState {
  runtime: AgentRuntime | null;
  config: ElizaConfig;
  agentName: string;
  adminEntityId: UUID | null;
  chatUserId: UUID | null;
  logBuffer: LogEntry[];
  conversations: Map<string, ConversationMeta>;
  conversationRestorePromise: Promise<void> | null;
  deletedConversationIds: Set<string>;
  broadcastWs: ((data: object) => void) | null;
  /** Wallet trade permission mode for wallet-mode guidance replies. */
  tradePermissionMode?: string;
}

export interface ConversationRouteContext extends RouteRequestContext {
  state: ConversationRouteState;
}

// ---------------------------------------------------------------------------
// Closure-lifted helpers
// ---------------------------------------------------------------------------

export function resolveConversationAdminEntityId(
  state: ConversationRouteState,
): UUID {
  return resolveClientChatAdminEntityId(state);
}

function ensureAdminEntityId(state: ConversationRouteState): UUID {
  return resolveConversationAdminEntityId(state);
}

async function ensureWorldOwnershipAndRoles(
  runtime: AgentRuntime,
  worldId: UUID,
  ownerId: UUID,
): Promise<void> {
  const world = await runtime.getWorld(worldId);
  if (!world) return;
  let needsUpdate = false;
  if (!world.metadata) {
    world.metadata = {};
    needsUpdate = true;
  }
  if (
    !world.metadata.ownership ||
    typeof world.metadata.ownership !== "object" ||
    (world.metadata.ownership as { ownerId?: string }).ownerId !== ownerId
  ) {
    world.metadata.ownership = { ownerId };
    needsUpdate = true;
  }
  const metadataWithRoles = world.metadata as {
    roles?: Record<string, string>;
  };
  const roles = metadataWithRoles.roles ?? {};
  if (roles[ownerId] !== "OWNER") {
    roles[ownerId] = "OWNER";
    metadataWithRoles.roles = roles;
    needsUpdate = true;
  }
  if (needsUpdate) {
    await runtime.updateWorld(world);
  }
}

async function shouldPersistFinalAssistantTurn(
  runtime: AgentRuntime,
  roomId: UUID,
  turnStartedAt: number,
  result: ChatGenerationResult,
): Promise<boolean> {
  if (!result.usedActionCallbacks) {
    return true;
  }

  const alreadyPersistedVisibleAssistantTurn =
    await hasRecentVisibleAssistantMemorySince(runtime, roomId, turnStartedAt);

  return !alreadyPersistedVisibleAssistantTurn;
}

function markConversationDeleted(
  state: ConversationRouteState,
  conversationId: string,
): void {
  const normalizedId = conversationId.trim();
  if (!normalizedId) return;
  if (state.deletedConversationIds.has(normalizedId)) return;

  state.deletedConversationIds.add(normalizedId);
  while (state.deletedConversationIds.size > MAX_DELETED_CONVERSATION_IDS) {
    const oldest = state.deletedConversationIds.values().next().value;
    if (!oldest) break;
    state.deletedConversationIds.delete(oldest);
  }

  try {
    persistDeletedConversationIdsToState(state.deletedConversationIds);
  } catch (err) {
    logger.warn(
      `[conversations] Failed to persist deleted conversation tombstones: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function deleteConversationRoomData(
  runtime: AgentRuntime,
  roomId: UUID,
): Promise<void> {
  const runtimeWithDelete = runtime as AgentRuntime & {
    deleteRoom?: (id: UUID) => Promise<unknown>;
    adapter?: {
      db?: {
        deleteRoom?: (id: UUID) => Promise<unknown>;
      };
    };
  };

  if (typeof runtimeWithDelete.deleteRoom === "function") {
    await runtimeWithDelete.deleteRoom(roomId);
    return;
  }

  const dbDeleteRoom = runtimeWithDelete.adapter?.db?.deleteRoom;
  if (typeof dbDeleteRoom === "function") {
    await dbDeleteRoom.call(runtimeWithDelete.adapter?.db, roomId);
  }
}

async function deleteConversationMemories(
  runtime: AgentRuntime,
  memoryIds: UUID[],
): Promise<number> {
  if (memoryIds.length === 0) return 0;

  const runtimeWithDelete = runtime as AgentRuntime & {
    deleteManyMemories?: (memoryIds: UUID[]) => Promise<unknown>;
    deleteMemory?: (memoryId: UUID) => Promise<unknown>;
    removeMemory?: (memoryId: UUID) => Promise<unknown>;
    adapter?: {
      db?: {
        deleteManyMemories?: (memoryIds: UUID[]) => Promise<unknown>;
        deleteMemory?: (memoryId: UUID) => Promise<unknown>;
        removeMemory?: (memoryId: UUID) => Promise<unknown>;
      };
    };
  };

  if (typeof runtimeWithDelete.deleteManyMemories === "function") {
    await runtimeWithDelete.deleteManyMemories(memoryIds);
    return memoryIds.length;
  }

  const dbDeleteMany = runtimeWithDelete.adapter?.db?.deleteManyMemories;
  if (typeof dbDeleteMany === "function") {
    await dbDeleteMany.call(runtimeWithDelete.adapter?.db, memoryIds);
    return memoryIds.length;
  }

  let deletedCount = 0;
  for (const memoryId of memoryIds) {
    if (typeof runtimeWithDelete.deleteMemory === "function") {
      await runtimeWithDelete.deleteMemory(memoryId);
    } else if (typeof runtimeWithDelete.removeMemory === "function") {
      await runtimeWithDelete.removeMemory(memoryId);
    } else if (
      typeof runtimeWithDelete.adapter?.db?.deleteMemory === "function"
    ) {
      await runtimeWithDelete.adapter.db.deleteMemory.call(
        runtimeWithDelete.adapter.db,
        memoryId,
      );
    } else if (
      typeof runtimeWithDelete.adapter?.db?.removeMemory === "function"
    ) {
      await runtimeWithDelete.adapter.db.removeMemory.call(
        runtimeWithDelete.adapter.db,
        memoryId,
      );
    } else {
      const unsupportedError = new Error(
        "Conversation message deletion is not supported by this runtime",
      ) as Error & { status?: number };
      unsupportedError.status = 501;
      throw unsupportedError;
    }
    deletedCount += 1;
  }

  return deletedCount;
}

async function ensureConversationRoom(
  state: ConversationRouteState,
  conv: ConversationMeta,
): Promise<void> {
  if (!state.runtime) return;
  const runtime = state.runtime;
  const agentName = runtime.character.name ?? "Eliza";
  const userId = ensureAdminEntityId(state);
  const worldId = stringToUuid(`${agentName}-web-chat-world`);
  const messageServerId = stringToUuid(`${agentName}-web-server`) as UUID;
  await runtime.ensureConnection({
    entityId: userId,
    roomId: conv.roomId,
    worldId,
    userName: resolveAppUserName(state.config),
    source: "client_chat",
    channelId: `web-conv-${conv.id}`,
    type: ChannelType.DM,
    messageServerId,
    metadata: { ownership: { ownerId: userId } },
  });
  await ensureWorldOwnershipAndRoles(runtime, worldId as UUID, userId);
}

async function syncConversationRoomState(
  state: ConversationRouteState,
  conv: ConversationMeta,
): Promise<void> {
  if (!state.runtime) return;
  const runtime = state.runtime;
  const room = await runtime.getRoom(conv.roomId);
  if (!room) return;

  const ownerId = ensureAdminEntityId(state);
  const nextMetadata = buildConversationRoomMetadata(
    conv,
    ownerId,
    room.metadata,
  );
  const nextName = conv.title;
  const metadataChanged =
    JSON.stringify(room.metadata ?? null) !== JSON.stringify(nextMetadata);

  if (room.name === nextName && !metadataChanged) {
    return;
  }

  const adapter = runtime.adapter as {
    updateRoom?: (nextRoom: typeof room) => Promise<void>;
  };
  if (typeof adapter.updateRoom !== "function") {
    return;
  }

  await adapter.updateRoom({
    ...room,
    name: nextName,
    metadata: nextMetadata,
  });
}

async function waitForConversationRestore(
  state: ConversationRouteState,
): Promise<void> {
  const pending = state.conversationRestorePromise;
  if (!pending) return;
  try {
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error("Conversation restore timed out after 5000ms")),
        5000,
      ),
    );
    await Promise.race([pending, timeout]);
  } catch {
    // Restore failures are logged at the source.
  }
}

export function normalizeActionCallbackHistory(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const history: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }
    if (history.at(-1) === normalized) {
      continue;
    }
    history.push(normalized);
  }

  return history;
}

function mergeActionCallbackHistory(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  return normalizeActionCallbackHistory([...existing, ...incoming]);
}

export function formatConversationMessageText(
  text: string,
  actionCallbackHistory: readonly string[] = [],
): string {
  const history = normalizeActionCallbackHistory(actionCallbackHistory);
  if (history.length === 0) {
    return text;
  }

  const trimmedText = text.trim();
  if (trimmedText.length > 0) {
    return text;
  }

  return history.join("\n");
}

export function buildPersistedAssistantContent(
  text: string,
  result:
    | Pick<
        ChatGenerationResult,
        "actionCallbackHistory" | "responseContent" | "responseMessages"
      >
    | null
    | undefined,
): Content {
  const responseContent =
    result?.responseContent && typeof result.responseContent === "object"
      ? result.responseContent
      : null;
  const responseMessageContent = Array.isArray(result?.responseMessages)
    ? (result.responseMessages
        .map((entry) =>
          entry?.content && typeof entry.content === "object"
            ? entry.content
            : null,
        )
        .filter((content): content is Content => content !== null)
        .at(-1) ?? null)
    : null;
  const actionCallbackHistory = normalizeActionCallbackHistory(
    result?.actionCallbackHistory,
  );

  return responseContent || responseMessageContent
    ? {
        ...(responseMessageContent ?? {}),
        ...(responseContent ?? {}),
        text,
        ...(actionCallbackHistory.length > 0 ? { actionCallbackHistory } : {}),
      }
    : {
        text,
        ...(actionCallbackHistory.length > 0 ? { actionCallbackHistory } : {}),
      };
}

export async function persistRecentAssistantActionCallbackHistory(
  runtime: AgentRuntime,
  roomId: UUID,
  actionCallbackHistory: readonly string[],
  sinceMs: number,
): Promise<boolean> {
  const normalizedHistory = normalizeActionCallbackHistory(
    actionCallbackHistory,
  );
  if (normalizedHistory.length === 0) {
    return false;
  }

  try {
    const recent = await runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: 12,
    });

    const target = recent
      .filter((memory) => memory.entityId === runtime.agentId)
      .filter((memory) => {
        const content = memory.content as { text?: unknown } | undefined;
        const createdAt = memory.createdAt ?? 0;
        return (
          typeof memory.id === "string" &&
          typeof content?.text === "string" &&
          content.text.trim().length > 0 &&
          createdAt >= sinceMs - 2000
        );
      })
      .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
      .at(-1);

    if (!target || typeof target.id !== "string") {
      return false;
    }

    const content =
      target.content && typeof target.content === "object"
        ? (target.content as Content)
        : ({ text: "" } satisfies Content);
    const existingHistory = normalizeActionCallbackHistory(
      (content as Record<string, unknown>).actionCallbackHistory,
    );
    const mergedHistory = mergeActionCallbackHistory(
      existingHistory,
      normalizedHistory,
    );

    if (
      mergedHistory.length === existingHistory.length &&
      mergedHistory.every((entry, index) => entry === existingHistory[index])
    ) {
      return true;
    }

    await runtime.updateMemory({
      id: target.id as UUID,
      content: {
        ...content,
        actionCallbackHistory: mergedHistory,
      } as Content,
    });

    return true;
  } catch (err) {
    logger.debug(
      `[conversations] Failed to persist action callback history: ${getErrorMessage(err)}`,
    );
    return false;
  }
}

async function getConversationWithRestore(
  state: ConversationRouteState,
  convId: string,
): Promise<ConversationMeta | undefined> {
  const existing = state.conversations.get(convId);
  if (existing) return existing;
  await waitForConversationRestore(state);
  return state.conversations.get(convId);
}

function extractConversationMetaString(
  memory: { metadata?: unknown },
  key: string,
): string | undefined {
  const meta =
    memory.metadata && typeof memory.metadata === "object"
      ? (memory.metadata as Record<string, unknown>)
      : undefined;
  const value = meta?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type ConversationRouteMessageRecord = {
  id: string;
  role: "assistant" | "user";
  text: string;
  timestamp: number;
  source?: string;
  actionName?: string;
  actionCallbackHistory?: string[];
  from?: string;
  fromUserName?: string;
  avatarUrl?: string;
  replyToMessageId?: string;
  replyToSenderName?: string;
  replyToSenderUserName?: string;
  rawDiscordChannelId?: string;
  rawDiscordMessageId?: string;
  rawSenderId?: string;
  senderEntityId?: string;
};

async function ensureConversationGreetingStored(
  state: ConversationRouteState,
  conv: ConversationMeta,
  lang: string,
): Promise<{
  text: string;
  agentName: string;
  generated: boolean;
  persisted: boolean;
}> {
  const runtime = state.runtime;
  const agentName = runtime?.character.name ?? state.agentName ?? "Eliza";
  if (!runtime) {
    return {
      text: "",
      agentName,
      generated: false,
      persisted: false,
    };
  }

  let memories: Awaited<ReturnType<AgentRuntime["getMemories"]>>;
  try {
    memories = await runtime.getMemories({
      roomId: conv.roomId,
      tableName: "messages",
      limit: 12,
    });
  } catch (err) {
    throw new Error(
      `Failed to inspect existing conversation messages: ${getErrorMessage(err)}`,
    );
  }

  memories.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const existingGreeting = memories.find((memory) => {
    const content = memory.content as Record<string, unknown> | undefined;
    return (
      memory.entityId === runtime.agentId &&
      content?.source === "agent_greeting" &&
      typeof content.text === "string" &&
      content.text.trim().length > 0
    );
  });
  if (existingGreeting) {
    return {
      text: String(
        (existingGreeting.content as Record<string, unknown> | undefined)
          ?.text ?? "",
      ),
      agentName,
      generated: true,
      persisted: false,
    };
  }

  if (memories.length > 0) {
    return {
      text: "",
      agentName,
      generated: false,
      persisted: false,
    };
  }

  const greeting = resolveConversationGreetingText(
    runtime,
    lang,
    state.config.ui,
  ).trim();
  if (!greeting) {
    return {
      text: "",
      agentName,
      generated: false,
      persisted: false,
    };
  }

  try {
    await persistConversationMemory(
      runtime,
      createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: runtime.agentId,
        roomId: conv.roomId,
        content: {
          text: greeting,
          source: "agent_greeting",
          channelType: ChannelType.DM,
        },
      }),
    );
  } catch (err) {
    throw new Error(
      `Failed to store greeting message: ${getErrorMessage(err)}`,
    );
  }

  conv.updatedAt = new Date().toISOString();
  return {
    text: greeting,
    agentName,
    generated: true,
    persisted: true,
  };
}

async function truncateConversationMessages(
  runtime: AgentRuntime,
  conv: ConversationMeta,
  messageId: string,
  options?: { inclusive?: boolean },
): Promise<{ deletedCount: number }> {
  const memories = await runtime.getMemories({
    roomId: conv.roomId,
    tableName: "messages",
    limit: 1000,
  });

  memories.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const targetIndex = memories.findIndex((memory) => memory.id === messageId);
  if (targetIndex < 0) {
    const notFoundError = new Error(
      "Conversation message not found",
    ) as Error & {
      status?: number;
    };
    notFoundError.status = 404;
    throw notFoundError;
  }

  const deleteStartIndex =
    options?.inclusive === true ? targetIndex : targetIndex + 1;
  const memoryIds = memories
    .slice(deleteStartIndex)
    .map((memory) => memory.id)
    .filter(
      (memoryId): memoryId is UUID =>
        typeof memoryId === "string" && memoryId.trim().length > 0,
    );

  const deletedCount = await deleteConversationMemories(runtime, memoryIds);
  return { deletedCount };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleConversationRoutes(
  ctx: ConversationRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, readJsonBody, json, error, state } = ctx;

  if (
    !pathname.startsWith("/api/conversations") ||
    pathname.startsWith("/api/conversations/")
      ? !/^\/api\/conversations\/[^/]/.test(pathname)
      : pathname !== "/api/conversations"
  ) {
    // Quick exit: not a conversation route
    if (!pathname.startsWith("/api/conversations")) return false;
  }

  // ── GET /api/conversations ──────────────────────────────────────────
  if (method === "GET" && pathname === "/api/conversations") {
    await waitForConversationRestore(state);
    const convos = Array.from(state.conversations.values())
      .filter((c) => !state.deletedConversationIds.has(c.id))
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    json(res, { conversations: convos });
    return true;
  }

  // ── POST /api/conversations ─────────────────────────────────────────
  if (method === "POST" && pathname === "/api/conversations") {
    const rawConv = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawConv === null) return true;
    const parsedConv = PostConversationRequestSchema.safeParse(rawConv);
    if (!parsedConv.success) {
      error(
        res,
        parsedConv.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedConv.data;
    await waitForConversationRestore(state);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const roomId = stringToUuid(`web-conv-${id}`);
    const conv: ConversationMeta = {
      id,
      title: body.title?.trim() || "New Chat",
      roomId,
      ...(sanitizeConversationMetadata(body.metadata)
        ? { metadata: sanitizeConversationMetadata(body.metadata) }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    state.conversations.set(id, conv);
    let greeting:
      | {
          text: string;
          agentName: string;
          generated: boolean;
          persisted: boolean;
        }
      | undefined;

    // Soft cap: evict the oldest conversation when the map exceeds 500
    evictOldestConversation(state.conversations, 500);

    if (state.runtime) {
      try {
        await ensureConversationRoom(state, conv);
        await syncConversationRoomState(state, conv);
        if (body.includeGreeting === true) {
          const storedGreeting = await ensureConversationGreetingStored(
            state,
            conv,
            typeof body.lang === "string" ? body.lang : "en",
          );
          if (storedGreeting.text.trim()) {
            greeting = {
              text: storedGreeting.text,
              agentName: storedGreeting.agentName,
              generated: storedGreeting.generated,
              persisted: storedGreeting.persisted,
            };
          }
        }
      } catch (err) {
        error(
          res,
          `Failed to initialize conversation: ${getErrorMessage(err)}`,
          500,
        );
        return true;
      }
    }
    json(res, { conversation: conv, ...(greeting ? { greeting } : {}) });
    return true;
  }

  // ── GET /api/conversations/:id/messages ─────────────────────────────
  if (
    method === "GET" &&
    /^\/api\/conversations\/[^/]+\/messages$/.test(pathname)
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const conv = await getConversationWithRestore(state, convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }
    if (!state.runtime) {
      json(res, { messages: [] });
      return true;
    }
    const runtime = state.runtime;
    try {
      const memories = await runtime.getMemories({
        roomId: conv.roomId,
        tableName: "messages",
        limit: 200,
      });
      // Sort by createdAt ascending
      memories.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      const agentId = runtime.agentId;
      const messages = memories
        .map((m) => {
          const contentSource = (m.content as Record<string, unknown>)?.source;
          const content = m.content as Record<string, unknown>;
          const meta = m.metadata as Record<string, unknown> | undefined;
          const entityName = meta?.entityName;
          const replyToAuthor =
            meta?.replyToAuthor && typeof meta.replyToAuthor === "object"
              ? (meta.replyToAuthor as Record<string, unknown>)
              : null;
          const normalizedSource =
            typeof contentSource === "string" &&
            contentSource.length > 0 &&
            contentSource !== "client_chat"
              ? contentSource
              : undefined;
          const actionName =
            typeof content.action === "string" && content.action.length > 0
              ? content.action
              : undefined;
          const actionCallbackHistory = normalizeActionCallbackHistory(
            content.actionCallbackHistory,
          );
          return {
            id: m.id ?? "",
            role: m.entityId === agentId ? "assistant" : "user",
            text: formatConversationMessageText(
              (m.content as { text?: string })?.text ?? "",
              actionCallbackHistory,
            ),
            timestamp: m.createdAt ?? 0,
            source: normalizedSource,
            actionName,
            actionCallbackHistory:
              actionCallbackHistory.length > 0
                ? [...actionCallbackHistory]
                : undefined,
            from:
              typeof entityName === "string" && entityName.length > 0
                ? entityName
                : undefined,
            fromUserName:
              typeof meta?.entityUserName === "string" &&
              meta.entityUserName.length > 0
                ? meta.entityUserName
                : undefined,
            avatarUrl:
              typeof meta?.entityAvatarUrl === "string" &&
              meta.entityAvatarUrl.length > 0
                ? meta.entityAvatarUrl
                : undefined,
            replyToMessageId:
              typeof content.inReplyTo === "string" &&
              content.inReplyTo.length > 0
                ? content.inReplyTo
                : typeof meta?.replyToMessageId === "string" &&
                    meta.replyToMessageId.length > 0
                  ? meta.replyToMessageId
                  : undefined,
            replyToSenderName:
              typeof meta?.replyToSenderName === "string" &&
              meta.replyToSenderName.length > 0
                ? meta.replyToSenderName
                : typeof replyToAuthor?.displayName === "string" &&
                    replyToAuthor.displayName.length > 0
                  ? replyToAuthor.displayName
                  : typeof replyToAuthor?.username === "string" &&
                      replyToAuthor.username.length > 0
                    ? replyToAuthor.username
                    : undefined,
            replyToSenderUserName:
              typeof meta?.replyToSenderUserName === "string" &&
              meta.replyToSenderUserName.length > 0
                ? meta.replyToSenderUserName
                : typeof replyToAuthor?.username === "string" &&
                    replyToAuthor.username.length > 0
                  ? replyToAuthor.username
                  : undefined,
            rawDiscordChannelId: extractConversationMetaString(
              m,
              "discordChannelId",
            ),
            rawDiscordMessageId: extractConversationMetaString(
              m,
              "discordMessageId",
            ),
            rawSenderId: extractConversationMetaString(m, "fromId"),
            senderEntityId:
              typeof m.entityId === "string" ? m.entityId : undefined,
          } satisfies ConversationRouteMessageRecord;
        })
        // Drop action-log memories that have no visible text (e.g.
        // plugin action logs with only `thought` / `actions` fields).
        // Without this filter they appear as blank chat bubbles.
        .filter((m) => m.text.trim().length > 0);
      await Promise.all(
        messages.map(async (message) => {
          if (!isCanonicalDiscordSource(message.source)) {
            return;
          }

          try {
            const storedSenderProfile = await resolveStoredDiscordEntityProfile(
              runtime,
              message.senderEntityId,
            );
            if (!message.from && storedSenderProfile?.displayName) {
              message.from = storedSenderProfile.displayName;
            }
            if (!message.fromUserName && storedSenderProfile?.username) {
              message.fromUserName = storedSenderProfile.username;
            }
            if (!message.avatarUrl && storedSenderProfile?.avatarUrl) {
              message.avatarUrl = storedSenderProfile.avatarUrl;
            }

            const messageAuthorProfile =
              message.rawDiscordChannelId && message.rawDiscordMessageId
                ? await resolveDiscordMessageAuthorProfile(
                    runtime,
                    message.rawDiscordChannelId,
                    message.rawDiscordMessageId,
                  )
                : null;
            if (!message.from && messageAuthorProfile?.displayName) {
              message.from = messageAuthorProfile.displayName;
            }
            if (!message.fromUserName && messageAuthorProfile?.username) {
              message.fromUserName = messageAuthorProfile.username;
            }
            if (!message.avatarUrl && messageAuthorProfile?.avatarUrl) {
              message.avatarUrl = messageAuthorProfile.avatarUrl;
            }

            const rawSenderId =
              message.rawSenderId ??
              storedSenderProfile?.rawUserId ??
              messageAuthorProfile?.rawUserId;
            if (rawSenderId) {
              const profile = await resolveDiscordUserProfile(
                runtime,
                rawSenderId,
              );
              if (profile) {
                if (profile.displayName) {
                  message.from = profile.displayName;
                }
                if (profile.username) {
                  message.fromUserName = profile.username;
                }
                if (profile.avatarUrl) {
                  message.avatarUrl = profile.avatarUrl;
                }
              }
            }

            message.avatarUrl = await cacheDiscordAvatarForRuntime(
              runtime,
              message.avatarUrl,
              rawSenderId,
            );
          } catch (err) {
            logger.debug(
              `[conversations] Failed to enrich Discord message metadata: ${getErrorMessage(err)}`,
            );
          }
        }),
      );
      json(res, {
        messages: messages.map(
          ({
            rawDiscordChannelId: _rawDiscordChannelId,
            rawDiscordMessageId: _rawDiscordMessageId,
            rawSenderId: _rawSenderId,
            senderEntityId: _senderEntityId,
            ...message
          }) => message,
        ),
      });
    } catch (err) {
      logger.warn(
        `[conversations] Failed to fetch messages: ${err instanceof Error ? err.message : String(err)}`,
      );
      json(res, { messages: [], error: "Failed to fetch messages" }, 500);
    }
    return true;
  }

  // ── POST /api/conversations/:id/messages/truncate ──────────────────
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/messages\/truncate$/.test(pathname)
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const conv = await getConversationWithRestore(state, convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }

    const rawTrunc = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawTrunc === null) return true;
    const parsedTrunc =
      PostConversationTruncateRequestSchema.safeParse(rawTrunc);
    if (!parsedTrunc.success) {
      error(
        res,
        parsedTrunc.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const { messageId, inclusive } = parsedTrunc.data;

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return true;
    }

    try {
      const result = await truncateConversationMessages(
        runtime,
        conv,
        messageId,
        {
          inclusive: inclusive === true,
        },
      );
      conv.updatedAt = new Date().toISOString();
      state.broadcastWs?.({
        type: "conversation-updated",
        conversation: conv,
      });
      json(res, { ok: true, deletedCount: result.deletedCount });
    } catch (err) {
      const status =
        typeof (err as { status?: number }).status === "number"
          ? (err as { status: number }).status
          : 500;
      error(res, getErrorMessage(err), status);
    }
    return true;
  }

  // ── POST /api/conversations/:id/messages/stream ─────────────────────
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/messages\/stream$/.test(pathname)
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const conv = await getConversationWithRestore(state, convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }

    const chatPayload = await readChatRequestPayload(req, res, {
      readJsonBody,
      error,
    });
    if (!chatPayload) return true;
    const {
      prompt,
      channelType,
      images,
      conversationMode,
      preferredLanguage,
      source,
      metadata: chatMetadata,
    } = chatPayload;

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return true;
    }

    const userId = ensureAdminEntityId(state);
    const turnStartedAt = Date.now();

    try {
      await ensureConversationRoom(state, conv);
    } catch (err) {
      error(
        res,
        `Failed to initialize conversation room: ${getErrorMessage(err)}`,
        500,
      );
      return true;
    }

    const { userMessage, messageToStore } = buildUserMessages({
      images,
      prompt,
      userId,
      agentId: runtime.agentId,
      roomId: conv.roomId,
      channelType,
      conversationMode,
      messageSource: source,
      metadata: chatMetadata,
    });

    try {
      await persistConversationMemory(runtime, messageToStore);
    } catch (err) {
      error(res, `Failed to store user message: ${getErrorMessage(err)}`, 500);
      return true;
    }

    const walletModeGuidance = resolveWalletModeGuidanceReply(state, prompt);
    if (walletModeGuidance) {
      initSse(res);
      let aborted = false;
      req.on("close", () => {
        aborted = true;
      });
      if (!aborted) {
        writeChatTokenSse(res, walletModeGuidance, walletModeGuidance);
        try {
          await persistAssistantConversationMemory(
            runtime,
            conv.roomId,
            walletModeGuidance,
            channelType,
            turnStartedAt,
          );
          conv.updatedAt = new Date().toISOString();
        } catch (persistErr) {
          writeSse(res, {
            type: "error",
            message: getErrorMessage(persistErr),
          });
          res.end();
          return true;
        }
        writeSseJson(res, {
          type: "done",
          fullText: walletModeGuidance,
          agentName: state.agentName,
        });
      }
      res.end();
      return true;
    }

    // ── Local runtime path (streaming) ───────────────────────

    initSse(res);
    let aborted = false;
    req.on("close", () => {
      aborted = true;
    });

    // SSE heartbeat to keep connection alive during long generation
    const heartbeatInterval = setInterval(() => {
      if (!aborted && !res.writableEnded) {
        res.write(": heartbeat\n\n");
      }
    }, 5000);

    let streamedText = "";
    // When the success path emits `done` BEFORE running persistence (latency
    // optimization), we hand off the persistence work as a detached promise so
    // the `finally` block can `res.end()` immediately and still observe failures.
    let deferredPersistence: Promise<void> | null = null;

    try {
      const result = await generateChatResponse(
        runtime,
        userMessage,
        state.agentName,
        {
          isAborted: () => aborted,
          onChunk: (chunk) => {
            if (!chunk) return;
            streamedText += chunk;
            writeChatTokenSse(res, chunk, streamedText);
          },
          onSnapshot: (text) => {
            if (!text) return;
            streamedText = text;
            writeChatTokenSse(res, text, streamedText);
          },
          resolveNoResponseText: () =>
            resolveNoResponseFallback(state.logBuffer, runtime),
          preferredLanguage,
        },
      );

      if (!aborted) {
        conv.updatedAt = new Date().toISOString();
        if (result.noResponseReason !== "ignored") {
          const resolvedText = normalizeChatResponseText(
            result.text,
            state.logBuffer,
            runtime,
          );
          // Emit `done` BEFORE persistence so user-perceived end-of-turn
          // latency excludes the ~100-500ms memory write. Persistence runs
          // after res.end() in the `finally` block as a detached promise.
          writeSseJson(res, {
            type: "done",
            fullText: resolvedText,
            agentName: result.agentName,
            ...(result.usage ? { usage: result.usage } : {}),
          });
          deferredPersistence = (async () => {
            if (result.actionCallbackHistory?.length) {
              await persistRecentAssistantActionCallbackHistory(
                runtime,
                conv.roomId,
                result.actionCallbackHistory,
                turnStartedAt,
              );
            }
            if (
              await shouldPersistFinalAssistantTurn(
                runtime,
                conv.roomId,
                turnStartedAt,
                result,
              )
            ) {
              await persistAssistantConversationMemory(
                runtime,
                conv.roomId,
                buildPersistedAssistantContent(resolvedText, result),
                channelType,
                turnStartedAt,
              );
            }
          })();
        } else {
          writeSseJson(res, {
            type: "done",
            fullText: "",
            agentName: result.agentName,
            noResponseReason: "ignored",
            ...(result.usage ? { usage: result.usage } : {}),
          });
        }
      }
    } catch (err) {
      if (!aborted) {
        // If text was already streamed to the client (e.g. the initial
        // response succeeded but planner follow-up failed), use the
        // streamed text as the final reply instead of replacing it with a
        // generic fallback.
        if (streamedText) {
          logger.warn(
            {
              err: getErrorMessage(err),
              streamedTextLength: streamedText.length,
            },
            "Post-generation error after text was already streamed — using streamed text",
          );
          try {
            await persistAssistantConversationMemory(
              runtime,
              conv.roomId,
              streamedText,
              channelType,
              turnStartedAt,
            );
            conv.updatedAt = new Date().toISOString();
            writeSseJson(res, {
              type: "done",
              fullText: streamedText,
              agentName: state.agentName,
            });
          } catch (persistErr) {
            writeSse(res, {
              type: "error",
              message: getErrorMessage(persistErr),
            });
          }
        } else {
          logger.warn(
            { err: getErrorMessage(err) },
            "Chat generation failed with no streamed text",
          );
          const providerIssueReply = getChatFailureReply(err, state.logBuffer);
          const failureKind = classifyChatFailure(err, state.logBuffer);
          try {
            await persistAssistantConversationMemory(
              runtime,
              conv.roomId,
              providerIssueReply,
              channelType,
            );
            conv.updatedAt = new Date().toISOString();
            writeSse(res, {
              type: "done",
              fullText: providerIssueReply,
              agentName: state.agentName,
              // See non-streaming branch — renderer gates chat input on
              // failureKind === "no_provider".
              failureKind,
            });
          } catch (persistErr) {
            writeSse(res, {
              type: "error",
              message: getErrorMessage(persistErr),
            });
          }
        }
      }
    } finally {
      clearInterval(heartbeatInterval);
      res.end();
      // Persistence runs after the client has already received `done` + the
      // socket is closed. Failures must still be observable — never swallow.
      if (deferredPersistence !== null) {
        deferredPersistence.catch((persistErr: unknown) => {
          logger.error(
            {
              roomId: conv.roomId,
              err: getErrorMessage(persistErr),
            },
            "[ConversationStream] persistence failed",
          );
        });
      }
    }
    return true;
  }

  // ── POST /api/conversations/:id/messages ────────────────────────────
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/messages$/.test(pathname)
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const conv = await getConversationWithRestore(state, convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }
    const chatPayload = await readChatRequestPayload(req, res, {
      readJsonBody,
      error,
    });
    if (!chatPayload) return true;
    const {
      prompt,
      channelType,
      images,
      conversationMode,
      preferredLanguage,
      source,
      metadata: restMetadata,
    } = chatPayload;
    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return true;
    }
    const userId = ensureAdminEntityId(state);
    const turnStartedAt = Date.now();

    try {
      await ensureConversationRoom(state, conv);
    } catch (err) {
      error(
        res,
        `Failed to initialize conversation room: ${getErrorMessage(err)}`,
        500,
      );
      return true;
    }

    const { userMessage, messageToStore } = buildUserMessages({
      images,
      prompt,
      userId,
      agentId: runtime.agentId,
      roomId: conv.roomId,
      channelType,
      conversationMode,
      messageSource: source,
      metadata: restMetadata,
    });

    try {
      await persistConversationMemory(runtime, messageToStore);
    } catch (err) {
      error(res, `Failed to store user message: ${getErrorMessage(err)}`, 500);
      return true;
    }

    const walletModeGuidance = resolveWalletModeGuidanceReply(state, prompt);
    if (walletModeGuidance) {
      try {
        await persistAssistantConversationMemory(
          runtime,
          conv.roomId,
          walletModeGuidance,
          channelType,
          turnStartedAt,
        );
        conv.updatedAt = new Date().toISOString();
        json(res, {
          text: walletModeGuidance,
          agentName: state.agentName,
        });
      } catch (persistErr) {
        error(res, getErrorMessage(persistErr), 500);
      }
      return true;
    }

    try {
      const result = await generateChatResponse(
        runtime,
        userMessage,
        state.agentName,
        {
          resolveNoResponseText: () =>
            resolveNoResponseFallback(state.logBuffer, runtime),
          preferredLanguage,
        },
      );

      conv.updatedAt = new Date().toISOString();
      if (result.noResponseReason !== "ignored") {
        const resolvedText = normalizeChatResponseText(
          result.text,
          state.logBuffer,
          runtime,
        );
        if (result.actionCallbackHistory?.length) {
          await persistRecentAssistantActionCallbackHistory(
            runtime,
            conv.roomId,
            result.actionCallbackHistory,
            turnStartedAt,
          );
        }
        if (
          await shouldPersistFinalAssistantTurn(
            runtime,
            conv.roomId,
            turnStartedAt,
            result,
          )
        ) {
          await persistAssistantConversationMemory(
            runtime,
            conv.roomId,
            buildPersistedAssistantContent(resolvedText, result),
            channelType,
            turnStartedAt,
          );
        }
        json(res, {
          text: resolvedText,
          agentName: result.agentName,
        });
      } else {
        json(res, {
          text: "",
          agentName: result.agentName,
          noResponseReason: "ignored",
        });
      }
    } catch (err) {
      logger.warn(
        `[conversations] POST /messages failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const providerIssueReply = getChatFailureReply(err, state.logBuffer);
      const failureKind = classifyChatFailure(err, state.logBuffer);
      try {
        await persistAssistantConversationMemory(
          runtime,
          conv.roomId,
          providerIssueReply,
          channelType,
        );
        conv.updatedAt = new Date().toISOString();
        json(res, {
          text: providerIssueReply,
          agentName: state.agentName,
          // Renderer keys off this discriminator. "no_provider" means the
          // chat input should be gated with a "Connect a provider" CTA
          // instead of treating the message text as a normal assistant
          // reply (the user can't make progress without taking action).
          failureKind,
        });
      } catch (persistErr) {
        error(res, getErrorMessage(persistErr), 500);
      }
    }
    return true;
  }

  // ── POST /api/conversations/:id/greeting ───────────────────────────
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/greeting$/.test(pathname)
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const conv = await getConversationWithRestore(state, convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return true;
    }
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const lang = url.searchParams.get("lang") ?? "en";

    try {
      await ensureConversationRoom(state, conv);
    } catch (err) {
      error(
        res,
        `Failed to initialize conversation room: ${getErrorMessage(err)}`,
        500,
      );
      return true;
    }

    try {
      const greeting = await ensureConversationGreetingStored(
        state,
        conv,
        lang,
      );
      json(res, {
        text: greeting.text,
        agentName: greeting.agentName,
        generated: greeting.generated,
        persisted: greeting.persisted,
      });
    } catch (err) {
      error(res, getErrorMessage(err), 500);
    }
    return true;
  }

  // ── PATCH /api/conversations/:id ────────────────────────────────────
  if (
    method === "PATCH" &&
    /^\/api\/conversations\/[^/]+$/.test(pathname) &&
    !pathname.endsWith("/messages")
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const conv = await getConversationWithRestore(state, convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }
    const rawPatch = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawPatch === null) return true;
    const parsedPatch = PatchConversationRequestSchema.safeParse(rawPatch);
    if (!parsedPatch.success) {
      error(
        res,
        parsedPatch.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedPatch.data;

    if (body.generate) {
      if (!state.runtime) {
        error(res, "Agent is not running", 503);
        return true;
      }
      // Get the last user message to use as the prompt for generation
      let prompt = "A generic conversation";
      try {
        const memories = await state.runtime.getMemories({
          roomId: conv.roomId,
          tableName: "messages",
          limit: 5,
        });
        const lastUserMemory = memories.find(
          (m) => m.entityId !== state.runtime?.agentId,
        );
        if (lastUserMemory?.content?.text) {
          prompt = String(lastUserMemory.content.text);
        }
      } catch (err) {
        logger.warn(
          `[conversations] Failed to fetch context for title generation: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const newTitle = await generateConversationTitle(
        state.runtime,
        prompt,
        state.agentName,
      );

      const fallbackTitle = prompt
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .slice(0, 5)
        .join(" ")
        .trim();
      const resolvedTitle = newTitle ?? fallbackTitle;

      if (resolvedTitle) {
        conv.title = resolvedTitle;
        conv.updatedAt = new Date().toISOString();
        await syncConversationRoomState(state, conv);
      }
    } else if (body.title?.trim()) {
      conv.title = body.title.trim();
      conv.updatedAt = new Date().toISOString();
      await syncConversationRoomState(state, conv);
    }

    if (body.metadata !== undefined) {
      const nextMetadata = sanitizeConversationMetadata(body.metadata);
      if (nextMetadata) {
        conv.metadata = nextMetadata;
      } else {
        delete conv.metadata;
      }
      conv.updatedAt = new Date().toISOString();
      await syncConversationRoomState(state, conv);
    }
    json(res, { conversation: conv });
    return true;
  }

  // ── POST /api/conversations/cleanup-empty ───────────────────────────
  if (method === "POST" && pathname === "/api/conversations/cleanup-empty") {
    const rawCleanup = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawCleanup === null) return true;
    const parsedCleanup =
      PostConversationCleanupEmptyRequestSchema.safeParse(rawCleanup);
    if (!parsedCleanup.success) {
      error(
        res,
        parsedCleanup.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    await waitForConversationRestore(state);
    const runtime = state.runtime;
    if (!runtime) {
      json(res, { deleted: [] });
      return true;
    }
    const keepId = parsedCleanup.data.keepId;
    const agentId = runtime.agentId;
    const deleted: string[] = [];
    for (const conv of Array.from(state.conversations.values())) {
      if (keepId && conv.id === keepId) continue;
      if (state.deletedConversationIds.has(conv.id)) continue;
      const memories = await runtime.getMemories({
        roomId: conv.roomId,
        tableName: "messages",
        limit: 10,
      });
      const hasUserMessage = memories.some((m) => m.entityId !== agentId);
      if (hasUserMessage) continue;
      const memoryIds = memories
        .map((memory) => memory.id)
        .filter(
          (memoryId): memoryId is UUID =>
            typeof memoryId === "string" && memoryId.trim().length > 0,
        );
      if (memoryIds.length > 0) {
        await deleteConversationMemories(runtime, memoryIds);
      }
      await deleteConversationRoomData(runtime, conv.roomId);
      state.conversations.delete(conv.id);
      markConversationDeleted(state, conv.id);
      deleted.push(conv.id);
    }
    json(res, { deleted });
    return true;
  }

  // ── DELETE /api/conversations/:id ───────────────────────────────────
  if (
    method === "DELETE" &&
    /^\/api\/conversations\/[^/]+$/.test(pathname) &&
    !pathname.endsWith("/messages")
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const conv = await getConversationWithRestore(state, convId);
    if (conv?.roomId && state.runtime) {
      try {
        const memories = await state.runtime.getMemories({
          roomId: conv.roomId,
          tableName: "messages",
          limit: 1000,
        });
        const memoryIds = memories
          .map((memory) => memory.id)
          .filter(
            (memoryId): memoryId is UUID =>
              typeof memoryId === "string" && memoryId.trim().length > 0,
          );
        if (memoryIds.length > 0) {
          await deleteConversationMemories(state.runtime, memoryIds);
        }
      } catch (err) {
        logger.debug(
          `[conversations] Failed to delete messages for ${convId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        await deleteConversationRoomData(state.runtime, conv.roomId);
      } catch (err) {
        logger.debug(
          `[conversations] Failed to delete room data for ${convId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    state.conversations.delete(convId);
    markConversationDeleted(state, convId);
    json(res, { ok: true });
    return true;
  }

  return false;
}
