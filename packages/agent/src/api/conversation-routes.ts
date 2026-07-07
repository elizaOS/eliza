/**
 * Conversation CRUD routes extracted from server.ts.
 *
 * Handles:
 *   POST   /api/conversations            – create
 *   GET    /api/conversations             – list
 *   GET    /api/conversations/messages/search – corpus-wide message search
 *   POST   /api/conversations/dev/seed-messages – dev-only backdated corpus seed
 *   GET    /api/conversations/:id/messages – get messages
 *   POST   /api/conversations/:id/messages/truncate – truncate
 *   DELETE /api/conversations/:id/messages/:messageId – delete one message
 *   POST   /api/conversations/:id/messages/stream   – stream message
 *   POST   /api/conversations/:id/messages           – send message
 *   POST   /api/conversations/:id/greeting            – get/store greeting
 *   PATCH  /api/conversations/:id         – update/rename
 *   DELETE /api/conversations/:id         – delete
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { RouteRequestContext } from "@elizaos/core";
import {
  type AgentRuntime,
  ChannelType,
  type Content,
  createMessageMemory,
  logger,
  MESSAGE_SOURCE_AGENT_GREETING,
  MESSAGE_SOURCE_CLIENT_CHAT,
  type Memory,
  type RolesWorldMetadata,
  recordOwnerGrant,
  recordRoleGrant,
  stringToUuid,
  type UUID,
  validateUuid,
} from "@elizaos/core";
import type { ChatFailureKind } from "@elizaos/shared";
import {
  PatchConversationRequestSchema,
  PostConversationCleanupEmptyRequestSchema,
  PostConversationRequestSchema,
  PostConversationTruncateRequestSchema,
  PostSeedMessagesRequestSchema,
  parsePositiveInteger,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import { resolveStateDir } from "../config/paths.ts";
import type {
  AccountConnectRequest,
  ChatGenerationResult,
  LogEntry,
} from "./chat-routes.ts";
import {
  classifyChatFailure,
  generateChatResponse,
  generateConversationTitle,
  getChatFailureReply,
  hasRecentVisibleAssistantMemorySince,
  initSse,
  normalizeAccountConnectRequest,
  normalizeChatResponseText,
  persistAssistantConversationMemory,
  persistConversationMemory,
  readChatRequestPayload,
  resolveNoResponseFallback,
  writeChatStatusSse,
  writeChatTokenSse,
  writeChatToolSse,
  writeSse,
  writeSseJson,
} from "./chat-routes.ts";
import { resolveClientChatAdminEntityId } from "./client-chat-admin.ts";
import {
  buildConversationRoomMetadata,
  sanitizeConversationMetadata,
} from "./conversation-metadata.ts";
import { evictOldestConversation } from "./memory-bounds.ts";
import { generateMessageCorpus, seedMessageCorpus } from "./message-corpus.ts";
import {
  buildUserMessages,
  getErrorMessage,
  resolveAppUserName,
  resolveConversationGreetingText,
  resolveWalletModeGuidanceReply,
} from "./server-helpers.ts";
import type { ConversationMeta } from "./server-types.ts";
import {
  resolveWaifuChatAccess,
  type WaifuChatAccess,
  type WaifuChatWorldRole,
  waifuChatRoleToWorldRole,
} from "./waifu-chat-role-resolver.ts";

interface DiscordProfileLike {
  avatarUrl?: string;
  displayName?: string;
  rawUserId?: string;
  username?: string;
}

// Lazy memoized loader: @elizaos/plugin-discord (and its transitive deps) loads
// only when a conversation actually contains Discord-sourced messages. A
// module-scope `await import` would load it on every agent boot.
type DiscordConversationModule = {
  cacheDiscordAvatarForRuntime: (
    runtime: AgentRuntime,
    avatarUrl: string | undefined,
    userId?: string,
  ) => Promise<string | undefined>;
  isCanonicalDiscordSource: (source: unknown) => boolean;
  resolveDiscordMessageAuthorProfile: (
    runtime: AgentRuntime,
    channelId: string,
    messageId: string,
  ) => Promise<DiscordProfileLike | null>;
  resolveDiscordUserProfile: (
    runtime: AgentRuntime,
    userId: string,
  ) => Promise<DiscordProfileLike | null>;
  resolveStoredDiscordEntityProfile: (
    runtime: AgentRuntime,
    entityId: string | undefined,
  ) => Promise<DiscordProfileLike | null>;
};

let discordConversationPromise: Promise<DiscordConversationModule> | null =
  null;
function getDiscordConversationApi(): Promise<DiscordConversationModule> {
  discordConversationPromise ??= import(
    "@elizaos/plugin-discord"
  ) as Promise<unknown> as Promise<DiscordConversationModule>;
  return discordConversationPromise;
}

function mayNeedDiscordMessageEnrichment(source: unknown): boolean {
  return typeof source === "string" && source.toLowerCase().includes("discord");
}

function chunkVisibleTextForSse(text: string): string[] {
  const chunks: string[] = [];
  let cursor = 0;
  const targetSize = 48;
  while (cursor < text.length) {
    const limit = Math.min(text.length, cursor + targetSize);
    let end = limit;
    if (limit < text.length) {
      const boundary = text.lastIndexOf(" ", limit);
      if (boundary > cursor + 12) {
        end = boundary + 1;
      }
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

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
  /** Current agent lifecycle state (mirrors ServerState.agentState). */
  agentState?: string;
  /**
   * Hold a chat turn through the warming window (early API bind → runtime ready)
   * instead of 503-dropping it; resolves with the live runtime or null on
   * timeout. Provided by the coerced ServerState; see ServerState.awaitRuntimeReady.
   */
  awaitRuntimeReady?:
    | ((timeoutMs: number) => Promise<AgentRuntime | null>)
    | null;
  config: ElizaConfig;
  agentName: string;
  adminEntityId: UUID | null;
  chatUserId: UUID | null;
  logBuffer: LogEntry[];
  conversations: Map<string, ConversationMeta>;
  activeChatTurnCount: number;
  conversationRestorePromise: Promise<void> | null;
  deletedConversationIds: Set<string>;
  broadcastWs: ((data: object) => void) | null;
  /** Wallet trade permission mode for wallet-mode guidance replies. */
  tradePermissionMode?: string;
}

export interface ConversationRouteContext extends RouteRequestContext {
  state: ConversationRouteState;
}

/**
 * How long a chat turn may HOLD waiting for first-turn capability during the
 * warming window (early API bind → runtime ready). Normal boots resolve in ~2s;
 * the cap bounds the hold so a genuinely-stuck boot still fails fast.
 */
const WARMING_TURN_HOLD_MS = 30_000;

/**
 * Resolve the runtime for a chat turn, HOLDING through the warming window
 * instead of 503-dropping. Returns the live runtime immediately if present;
 * otherwise, only while the agent is actively warming up (`starting`/
 * `restarting`), waits up to WARMING_TURN_HOLD_MS for capability to come online.
 * A genuinely stopped/errored agent (or one with no gate wired) returns null so
 * the caller fails fast with the usual 503.
 */
async function resolveRuntimeForChatTurn(
  state: ConversationRouteState,
): Promise<AgentRuntime | null> {
  if (state.runtime) {
    return state.runtime;
  }
  const warming =
    state.agentState === "starting" || state.agentState === "restarting";
  if (!warming || !state.awaitRuntimeReady) {
    return state.runtime ?? null;
  }
  return state.awaitRuntimeReady(WARMING_TURN_HOLD_MS);
}

function beginActiveChatTurn(state: ConversationRouteState): () => void {
  state.activeChatTurnCount = Math.max(0, state.activeChatTurnCount) + 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    state.activeChatTurnCount = Math.max(0, state.activeChatTurnCount - 1);
  };
}

// ---------------------------------------------------------------------------
// Closure-lifted helpers
// ---------------------------------------------------------------------------

export function resolveConversationAdminEntityId(
  state: ConversationRouteState,
): UUID {
  return resolveClientChatAdminEntityId(state);
}

type StreamEventListener = (...args: unknown[]) => void;

interface StreamEventSource {
  on?: (event: string, listener: StreamEventListener) => unknown;
  off?: (event: string, listener: StreamEventListener) => unknown;
}

type StreamSocketLike = StreamEventSource & {
  destroyed?: boolean;
  writable?: boolean;
};

interface ConversationStreamDisconnectTracker {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  checkConnectionClosed: () => boolean;
  dispose: () => void;
  isAborted: () => boolean;
  markCompleted: () => void;
}

interface RequestDisconnectAbortTracker {
  signal: AbortSignal;
  dispose: () => void;
  isAborted: () => boolean;
  markCompleted: () => void;
}

function isStreamEventSource(value: unknown): value is StreamEventSource {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StreamEventSource).on === "function"
  );
}

function isStreamSocketLike(value: unknown): value is StreamSocketLike {
  return typeof value === "object" && value !== null;
}

function createRequestDisconnectAbortTracker({
  req,
  res,
  operation,
}: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  operation: string;
}): RequestDisconnectAbortTracker {
  const abortController = new AbortController();
  const registrations: Array<{
    source: StreamEventSource;
    event: string;
    listener: StreamEventListener;
  }> = [];
  let aborted = false;
  let completed = false;

  const abort = (reason?: unknown) => {
    if (completed || aborted) return;
    aborted = true;
    abortController.abort(
      reason instanceof Error ? reason : new Error(`${operation} aborted`),
    );
  };

  const register = (
    source: unknown,
    event: string,
    listener: StreamEventListener,
  ) => {
    if (!isStreamEventSource(source)) return;
    source.on?.(event, listener);
    registrations.push({ source, event, listener });
  };

  const onClientGone = () =>
    abort(new Error(`${operation} client disconnected`));
  const onResponseClose = () => {
    const ended = Boolean(
      (res as http.ServerResponse & { writableEnded?: boolean }).writableEnded,
    );
    if (!ended) onClientGone();
  };

  register(req, "aborted", onClientGone);
  register(req, "error", onClientGone);
  register(res, "close", onResponseClose);
  register(res, "error", onClientGone);

  return {
    signal: abortController.signal,
    dispose: () => {
      for (const { source, event, listener } of registrations) {
        source.off?.(event, listener);
      }
      registrations.length = 0;
    },
    isAborted: () => aborted,
    markCompleted: () => {
      completed = true;
    },
  };
}

function createConversationStreamDisconnectTracker({
  req,
  res,
  conversationId,
  roomId,
}: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  conversationId: string;
  roomId: UUID;
}): ConversationStreamDisconnectTracker {
  const abortController = new AbortController();
  const registrations: Array<{
    source: StreamEventSource;
    event: string;
    listener: StreamEventListener;
  }> = [];
  let aborted = false;
  let completed = false;

  const requestSocket = isStreamSocketLike(
    (req as http.IncomingMessage & { socket?: unknown }).socket,
  )
    ? ((req as http.IncomingMessage & { socket?: StreamSocketLike }).socket ??
      null)
    : null;
  const responseSocket = isStreamSocketLike(
    (res as http.ServerResponse & { socket?: unknown }).socket,
  )
    ? ((res as http.ServerResponse & { socket?: StreamSocketLike }).socket ??
      null)
    : null;

  const responseEnded = () =>
    Boolean(
      (res as http.ServerResponse & { writableEnded?: boolean }).writableEnded,
    );

  const abort = (reason?: unknown) => {
    if (completed || aborted) return;
    aborted = true;
    logger.info(
      { conversationId, roomId },
      "[ConversationStream] client disconnected; aborting generation",
    );
    abortController.abort(reason ?? new Error("Client disconnected"));
  };

  const checkConnectionClosed = () => {
    const socketClosed =
      requestSocket?.destroyed === true ||
      responseSocket?.destroyed === true ||
      (requestSocket?.writable === false && !responseEnded()) ||
      (responseSocket?.writable === false && !responseEnded());
    const responseClosed =
      (res as http.ServerResponse & { destroyed?: boolean }).destroyed ===
        true && !responseEnded();
    if (socketClosed || responseClosed) {
      abort(new Error("Client disconnected"));
      return true;
    }
    return false;
  };

  const register = (
    source: unknown,
    event: string,
    listener: StreamEventListener,
  ) => {
    if (!isStreamEventSource(source)) return;
    source.on?.(event, listener);
    registrations.push({ source, event, listener });
  };

  const onRequestClose = () => {
    checkConnectionClosed();
  };
  const onClientGone = () => {
    abort(new Error("Client disconnected"));
  };

  // Bun's node:http shim emits req.close when the POST body finishes, before
  // the SSE response is complete. Socket events must be attached before that
  // point; listeners added after body parsing can miss later client exits.
  register(req, "aborted", onClientGone);
  register(req, "close", onRequestClose);
  register(req, "error", onClientGone);
  register(res, "close", onClientGone);
  register(res, "error", onClientGone);
  register(requestSocket, "close", onClientGone);
  register(requestSocket, "error", onClientGone);
  if (responseSocket && responseSocket !== requestSocket) {
    register(responseSocket, "close", onClientGone);
    register(responseSocket, "error", onClientGone);
  }

  return {
    signal: abortController.signal,
    abort,
    checkConnectionClosed,
    dispose: () => {
      for (const { source, event, listener } of registrations) {
        source.off?.(event, listener);
      }
      registrations.length = 0;
    },
    isAborted: () => aborted,
    markCompleted: () => {
      completed = true;
    },
  };
}

function writeConversationStreamHeartbeat(
  res: http.ServerResponse,
  disconnectTracker: ConversationStreamDisconnectTracker,
): void {
  if (disconnectTracker.isAborted() || res.writableEnded) return;
  try {
    res.write(": heartbeat\n\n");
  } catch {
    disconnectTracker.abort(new Error("Client disconnected"));
  }
}

function isTurnAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  return (
    code === "TURN_ABORTED" ||
    err.name === "TurnAbortedError" ||
    err.message.startsWith("Turn aborted:")
  );
}

function ensureAdminEntityId(state: ConversationRouteState): UUID {
  return resolveConversationAdminEntityId(state);
}

function resolveConversationCaller(
  req: http.IncomingMessage,
  state: ConversationRouteState,
): { entityId: UUID; role: WaifuChatWorldRole; userName: string } {
  const access = resolveWaifuChatAccess(req);
  if (!access) {
    return {
      entityId: ensureAdminEntityId(state),
      role: "OWNER",
      userName: resolveAppUserName(state.config),
    };
  }

  return {
    entityId: stringToUuid(
      `waifu-wallet:${access.walletAddress.toLowerCase()}`,
    ),
    role: waifuChatRoleToWorldRole(access.role),
    userName: access.walletAddress,
  };
}

function normalizeWaifuWallet(address: string | undefined): string | null {
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  return address.toLowerCase();
}

function getWaifuChatOwnerWallet(conv: ConversationMeta): string | null {
  return normalizeWaifuWallet(conv.metadata?.waifuChatOwnerWallet);
}

function addWaifuConversationOwnerMetadata(
  req: http.IncomingMessage,
  metadata: ConversationMeta["metadata"],
): ConversationMeta["metadata"] {
  const access = resolveWaifuChatAccess(req);
  if (!access) return metadata;
  return {
    ...(metadata ?? {}),
    waifuChatOwnerWallet: access.walletAddress.toLowerCase(),
    waifuChatRole: access.role,
  };
}

function canWaifuAccessConversation(
  access: WaifuChatAccess | null,
  conv: ConversationMeta,
): boolean {
  if (!access || access.role === "admin") return true;
  return getWaifuChatOwnerWallet(conv) === access.walletAddress.toLowerCase();
}

function rejectWaifuConversationAccessIfNeeded(
  req: http.IncomingMessage,
  conv: ConversationMeta,
  error: ConversationRouteContext["error"],
  res: http.ServerResponse,
): boolean {
  const access = resolveWaifuChatAccess(req);
  if (canWaifuAccessConversation(access, conv)) return false;
  error(res, "Conversation not found", 404);
  return true;
}

function rejectWaifuNonAdminMutationIfNeeded(
  req: http.IncomingMessage,
  error: ConversationRouteContext["error"],
  res: http.ServerResponse,
): boolean {
  const access = resolveWaifuChatAccess(req);
  if (!access || access.role === "admin") return false;
  error(res, "Forbidden", 403);
  return true;
}

async function ensureWorldOwnershipAndRoles(
  runtime: AgentRuntime,
  worldId: UUID,
  ownerId: UUID,
  callerId: UUID,
  callerRole: WaifuChatWorldRole,
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
  // #12087 Item 11: route role writes through the auditable grant helpers so each
  // grant pairs roles[id] with a roleSources[id] entry (the #9948 invariant),
  // instead of mutating metadata.roles directly with raw literals. The owner grant
  // is recorded as source "owner"; the caller's connector-derived role is recorded
  // as "connector_admin" (revocable/demotable), and never overwrites the owner's
  // grant when the caller IS the owner.
  const metadata = world.metadata as RolesWorldMetadata;
  if (recordOwnerGrant(metadata, ownerId)) {
    needsUpdate = true;
  }
  if (
    callerId !== ownerId &&
    recordRoleGrant(metadata, callerId, callerRole, "connector_admin")
  ) {
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

  const dbDeleteRoom = runtimeWithDelete.adapter.db.deleteRoom;
  if (typeof dbDeleteRoom === "function") {
    await dbDeleteRoom.call(runtimeWithDelete.adapter.db, roomId);
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

  const dbDeleteMany = runtimeWithDelete.adapter.db.deleteManyMemories;
  if (typeof dbDeleteMany === "function") {
    await dbDeleteMany.call(runtimeWithDelete.adapter.db, memoryIds);
    return memoryIds.length;
  }

  let deletedCount = 0;
  for (const memoryId of memoryIds) {
    if (typeof runtimeWithDelete.deleteMemory === "function") {
      await runtimeWithDelete.deleteMemory(memoryId);
    } else if (typeof runtimeWithDelete.removeMemory === "function") {
      await runtimeWithDelete.removeMemory(memoryId);
    } else if (
      typeof runtimeWithDelete.adapter.db.deleteMemory === "function"
    ) {
      await runtimeWithDelete.adapter.db.deleteMemory.call(
        runtimeWithDelete.adapter.db,
        memoryId,
      );
    } else if (
      typeof runtimeWithDelete.adapter.db.removeMemory === "function"
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
  caller: {
    entityId: UUID;
    role: WaifuChatWorldRole;
    userName: string;
  },
): Promise<void> {
  if (!state.runtime) return;
  const runtime = state.runtime;
  const agentName = runtime.character.name ?? "Eliza";
  const ownerId = ensureAdminEntityId(state);
  const worldId = stringToUuid(`${agentName}-web-chat-world`);
  const messageServerId = stringToUuid(`${agentName}-web-server`) as UUID;
  await runtime.ensureConnection({
    entityId: caller.entityId,
    roomId: conv.roomId,
    worldId,
    userName: caller.userName,
    source: MESSAGE_SOURCE_CLIENT_CHAT,
    channelId: `web-conv-${conv.id}`,
    type: ChannelType.DM,
    messageServerId,
    metadata: { ownership: { ownerId }, waifuRole: caller.role },
  });
  await ensureWorldOwnershipAndRoles(
    runtime,
    worldId as UUID,
    ownerId,
    caller.entityId,
    caller.role,
  );
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
          entry.content && typeof entry.content === "object"
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

/** Default recent-window size for GET /messages (the newest N turns). */
const CONVERSATION_MESSAGE_WINDOW = 200;

/**
 * Default page size for the `?before=<cursor>` load-older path (infinite
 * upward scroll, #13532). Smaller than the initial recent window: each
 * scroll-up prepends one page, so a page that is quick to fetch and paint
 * keeps the prefetch ahead of the reader without a large single reflow.
 */
const CONVERSATION_OLDER_PAGE_SIZE = 50;

/**
 * How many messages on EACH side of an `?around=<id>` pivot to load. The
 * centered window is roughly 2× this plus the pivot itself.
 */
const CONVERSATION_AROUND_RADIUS = 100;

/**
 * Load a window of messages CENTERED on `aroundMessageId` for the jump-to-message
 * flow (#9955). The default GET /messages window is the most-recent
 * CONVERSATION_MESSAGE_WINDOW turns, so a keyword-search hit older than that is
 * never in the loaded thread and can't be scrolled to. Given the pivot's id this
 * returns the pivot's own turn plus up to CONVERSATION_AROUND_RADIUS older and
 * newer turns, ordered chronologically by the caller.
 *
 * Bounds are pushed into the store as getMemories `start`/`end` (createdAt
 * range) so there is NO in-process scan. Returns the recent window unchanged
 * when the pivot is missing or lives in another room — the latter prevents a
 * cross-room leak via a forged `around` id.
 */
async function loadConversationMessagesAround(
  runtime: AgentRuntime,
  roomId: UUID,
  aroundMessageId: UUID,
): Promise<Memory[]> {
  const [pivot] = await runtime.getMemoriesByIds([aroundMessageId], "messages");
  if (!pivot || pivot.roomId !== roomId) {
    logger.warn(
      `[conversations] around=${aroundMessageId} is not in room ${roomId}; serving the recent window instead`,
    );
    return runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: CONVERSATION_MESSAGE_WINDOW,
    });
  }
  const pivotCreatedAt = pivot.createdAt ?? 0;
  const [olderOrAt, newerOrAt] = await Promise.all([
    // The pivot and everything before it, newest-first, capped. The pivot is
    // included because `end` is inclusive of its createdAt.
    runtime.getMemories({
      roomId,
      tableName: "messages",
      end: pivotCreatedAt,
      limit: CONVERSATION_AROUND_RADIUS + 1,
      orderBy: "createdAt",
      orderDirection: "desc",
    }),
    // The pivot and everything after it, oldest-first, capped.
    runtime.getMemories({
      roomId,
      tableName: "messages",
      start: pivotCreatedAt,
      limit: CONVERSATION_AROUND_RADIUS + 1,
      orderBy: "createdAt",
      orderDirection: "asc",
    }),
  ]);
  // Merge the two half-windows, de-duping the shared pivot (and any createdAt
  // ties both bounds picked up) by id.
  const byId = new Map<UUID, Memory>();
  for (const memory of [...olderOrAt, ...newerOrAt]) {
    if (memory.id) {
      byId.set(memory.id, memory);
    }
  }
  return Array.from(byId.values());
}

/**
 * Parse the `?before=<createdAt>` cursor: a positive integer millisecond
 * timestamp (the createdAt of the client's current oldest message). Returns
 * null for absent / malformed / non-positive values so the handler falls back
 * to the recent window instead of paging from a bogus cursor.
 */
function parseBeforeCursor(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Clamp the `?limit=N` older-page size to a sane range. Defaults to
 * CONVERSATION_OLDER_PAGE_SIZE and caps at CONVERSATION_MESSAGE_WINDOW so a
 * client can't request an unbounded page.
 */
function clampOlderPageLimit(raw: string | null): number {
  if (raw === null) return CONVERSATION_OLDER_PAGE_SIZE;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return CONVERSATION_OLDER_PAGE_SIZE;
  }
  return Math.min(Math.floor(parsed), CONVERSATION_MESSAGE_WINDOW);
}

/**
 * Load one page of messages STRICTLY OLDER than the `before` cursor for the
 * infinite upward scroll (#13532). `before` is the createdAt of the oldest
 * message the client already holds; this returns up to `limit` turns with a
 * smaller createdAt, newest-first from the store, so the caller can prepend
 * them above the current top.
 *
 * The bound is pushed into the store as getMemories `end` (an inclusive
 * createdAt upper bound) with `before - 1`, so the cursor row itself is
 * excluded and there is NO in-process scan. One extra row beyond `limit` is
 * requested to compute `hasMore` without a second COUNT query; the caller
 * trims it.
 */
async function loadConversationMessagesBefore(
  runtime: AgentRuntime,
  roomId: UUID,
  before: number,
  limit: number,
): Promise<{ memories: Memory[]; hasMore: boolean }> {
  // `end` is inclusive, so subtract 1ms to make the cursor exclusive: the
  // client already holds the message at `before`, we want strictly older.
  const rows = await runtime.getMemories({
    roomId,
    tableName: "messages",
    end: before - 1,
    limit: limit + 1,
    orderBy: "createdAt",
    orderDirection: "desc",
  });
  const hasMore = rows.length > limit;
  return { memories: hasMore ? rows.slice(0, limit) : rows, hasMore };
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

type SerializedMessageAttachment = {
  id: string;
  url: string;
  contentType?: string;
  title?: string;
  description?: string;
  source?: string;
  text?: string;
  mimeType?: string;
  thumbnailUrl?: string;
  /** Reason enrichment could not extract text/description (see Media.notProcessed). */
  notProcessed?: string;
};

/**
 * Only URLs the browser can actually load are renderable. Inline-upload
 * placeholders (e.g. `attachment:img-0`) whose bytes were never persisted are
 * dropped here so the client never paints a broken image — real uploads and
 * generated media carry a served `/api/media/...`, remote https, or inline
 * `data:`/`blob:` URL.
 */
const RENDERABLE_ATTACHMENT_URL = /^(?:https?:|data:|blob:|\/)/i;

export function serializeMessageAttachments(
  content: Record<string, unknown> | undefined,
): SerializedMessageAttachment[] | undefined {
  const raw = content?.attachments;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: SerializedMessageAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const url = typeof a.url === "string" ? a.url : "";
    if (!url || !RENDERABLE_ATTACHMENT_URL.test(url)) continue;
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.length > 0 ? v : undefined;
    out.push({
      id: str(a.id) ?? `att-${out.length}`,
      url,
      ...(str(a.contentType) ? { contentType: str(a.contentType) } : {}),
      ...(str(a.title) ? { title: str(a.title) } : {}),
      ...(str(a.description) ? { description: str(a.description) } : {}),
      ...(str(a.source) ? { source: str(a.source) } : {}),
      ...(str(a.text) ? { text: str(a.text) } : {}),
      ...(str(a.mimeType) ? { mimeType: str(a.mimeType) } : {}),
      ...(str(a.thumbnailUrl) ? { thumbnailUrl: str(a.thumbnailUrl) } : {}),
      ...(str(a.notProcessed) ? { notProcessed: str(a.notProcessed) } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

type ConversationRouteMessageRecord = {
  id: string;
  role: "assistant" | "user";
  text: string;
  timestamp: number;
  attachments?: SerializedMessageAttachment[];
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
  /**
   * Synthetic-failure classification for this turn (provider-issue /
   * no-provider / insufficient-credits / …). Persisted on the failed
   * assistant memory as `content.failureKind` (live result) or
   * `metadata.chatFailureKind` (markSyntheticChatFailureContent). Round-tripped
   * here so the renderer's gate + Retry survive a GET /messages full-replace.
   */
  failureKind?: ChatFailureKind;
  /**
   * Structured "connect another account" request from the CONNECT_ACCOUNT
   * action. Persisted on the assistant memory as `content.accountConnect`
   * (spread through `buildPersistedAssistantContent`). Round-tripped here so
   * the renderer's inline AddAccountDialog entry point survives a reload.
   */
  accountConnect?: AccountConnectRequest;
};

// Serializes concurrent greeting ensures per conversation. The body is a
// read-check-then-write (getMemories scan → persistConversationMemory) with no
// room-level uniqueness on (room, source): each persist mints a fresh UUID so
// isDuplicateMemoryError never fires. Two overlapping callers — the
// bootstrapGreeting create racing a superseding hydration's POST /greeting, the
// new-chat fallback racing the empty-thread auto-greet, or two sessions
// hydrating the same fresh conversation — both read an empty room and both
// persist an identical deterministic greeting, minting the duplicate
// "Hey, I'm <agent>" row (which also leaks into model context via getMemories).
// Coalescing on one in-flight promise per conversation makes the second caller
// observe the first's committed row instead of re-racing it. Sequential
// create-then-fetch is unaffected: the entry is deleted before any later call.
const greetingEnsureInFlight = new Map<
  string,
  Promise<{
    text: string;
    agentName: string;
    generated: boolean;
    persisted: boolean;
  }>
>();

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
  const inFlight = greetingEnsureInFlight.get(conv.id);
  if (inFlight) return inFlight;
  const run = ensureConversationGreetingStoredUnlocked(state, conv, lang);
  greetingEnsureInFlight.set(conv.id, run);
  try {
    return await run;
  } finally {
    greetingEnsureInFlight.delete(conv.id);
  }
}

async function ensureConversationGreetingStoredUnlocked(
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
  const agentName = runtime?.character.name ?? state.agentName;
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
      content?.source === MESSAGE_SOURCE_AGENT_GREETING &&
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
          source: MESSAGE_SOURCE_AGENT_GREETING,
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

/**
 * Delete a SINGLE message from a conversation by id (#13533). Unlike
 * `truncateConversationMessages` (which drops the target and everything after —
 * the edit-and-resend primitive), this removes exactly one row and leaves the
 * rest of the thread intact.
 *
 * The id is resolved by store lookup and its `roomId` verified against the
 * conversation's room the same way `?around` guards a forged pivot
 * (`loadConversationMessagesAround`): a message id from another room yields a 404
 * ("not found"), never a cross-room delete. A `messageId` that resolves to no
 * memory is a 404.
 */
async function deleteConversationMessage(
  runtime: AgentRuntime,
  conv: ConversationMeta,
  messageId: string,
): Promise<{ deletedCount: number }> {
  const [memory] = await runtime.getMemoriesByIds(
    [messageId as UUID],
    "messages",
  );
  // Not found, or a forged id pointing at another room: treat both as 404 so a
  // cross-room id can't confirm existence or delete foreign content.
  if (!memory || memory.roomId !== conv.roomId) {
    const notFoundError = new Error(
      "Conversation message not found",
    ) as Error & { status?: number };
    notFoundError.status = 404;
    throw notFoundError;
  }
  const deletedCount = await deleteConversationMemories(runtime, [
    messageId as UUID,
  ]);
  return { deletedCount };
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

const MESSAGE_SEARCH_DEFAULT_LIMIT = 20;
const MESSAGE_SEARCH_MAX_LIMIT = 50;
const MESSAGE_SEARCH_SNIPPET_RADIUS = 72;

function clampMessageSearchLimit(value: string | null): number {
  const parsed = parsePositiveInteger(value, MESSAGE_SEARCH_DEFAULT_LIMIT);
  return Math.min(parsed, MESSAGE_SEARCH_MAX_LIMIT);
}

function normalizeMessageSearchQuery(value: string | null): string {
  return (value === null ? "" : value).trim().replace(/\s+/g, " ");
}

/**
 * Parse an optional `since`/`until` search param into epoch ms. Accepts a
 * non-negative epoch-ms integer or any `Date.parse`-able string (ISO 8601).
 * Absent → `null`; present-but-unparseable → `"invalid"` so the route can 400
 * instead of silently searching an unbounded window the caller didn't ask for.
 */
function parseMessageSearchTime(
  value: string | null,
): number | null | "invalid" {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return "invalid";
  if (/^\d+$/.test(trimmed)) {
    const epochMs = Number(trimmed);
    return Number.isSafeInteger(epochMs) ? epochMs : "invalid";
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? "invalid" : parsed;
}

/** A `…keyword…` excerpt around the first match, or a head-truncated fallback. */
function buildMessageSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (!normalizedText) return "";
  const index = normalizedText.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) {
    return normalizedText.length <= MESSAGE_SEARCH_SNIPPET_RADIUS * 2
      ? normalizedText
      : `${normalizedText.slice(0, MESSAGE_SEARCH_SNIPPET_RADIUS * 2).trimEnd()}...`;
  }
  const start = Math.max(0, index - MESSAGE_SEARCH_SNIPPET_RADIUS);
  const end = Math.min(
    normalizedText.length,
    index + query.length + MESSAGE_SEARCH_SNIPPET_RADIUS,
  );
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalizedText.length ? "..." : "";
  return `${prefix}${normalizedText.slice(start, end).trim()}${suffix}`;
}

export async function handleConversationRoutes(
  ctx: ConversationRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, readJsonBody, json, error, state } = ctx;
  const requestUrl = new URL(
    req.url === undefined ? "" : req.url,
    `http://${req.headers.host === undefined ? "localhost" : req.headers.host}`,
  );

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
    const waifuAccess = resolveWaifuChatAccess(req);
    const convos = Array.from(state.conversations.values())
      .filter((c) => !state.deletedConversationIds.has(c.id))
      .filter((c) => canWaifuAccessConversation(waifuAccess, c))
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    json(res, { conversations: convos });
    return true;
  }

  // ── GET /api/conversations/messages/search ──────────────────────────
  // Keyword search across every conversation the requester can see. The
  // predicate runs in the store (getMemories textContains → ILIKE), then
  // results are ranked + snippeted here. No vector search.
  if (method === "GET" && pathname === "/api/conversations/messages/search") {
    if (!state.runtime) {
      json(res, { results: [], count: 0 });
      return true;
    }
    const query = normalizeMessageSearchQuery(requestUrl.searchParams.get("q"));
    if (query.length < 2) {
      error(res, "Search query must be at least 2 characters", 400);
      return true;
    }
    const limit = clampMessageSearchLimit(requestUrl.searchParams.get("limit"));
    const offset = parsePositiveInteger(
      requestUrl.searchParams.get("offset"),
      0,
    );
    // Optional inclusive time window (epoch ms or ISO 8601): "messages from a
    // year ago" is `until=<9 months ago>` etc. Garbage input is a 400, never a
    // silently ignored filter.
    const since = parseMessageSearchTime(requestUrl.searchParams.get("since"));
    const until = parseMessageSearchTime(requestUrl.searchParams.get("until"));
    if (since === "invalid" || until === "invalid") {
      error(
        res,
        "since/until must be an epoch-ms timestamp or an ISO 8601 date",
        400,
      );
      return true;
    }
    if (since !== null && until !== null && since > until) {
      error(res, "since must not be later than until", 400);
      return true;
    }
    const runtime = state.runtime;
    const waifuAccess = resolveWaifuChatAccess(req);
    const conversationsByRoomId = new Map<UUID, ConversationMeta>();
    for (const conv of state.conversations.values()) {
      if (state.deletedConversationIds.has(conv.id)) continue;
      if (!canWaifuAccessConversation(waifuAccess, conv)) continue;
      conversationsByRoomId.set(conv.roomId, conv);
    }
    // Scope the keyword search to the rooms the requester can actually see, in
    // SQL. Filtering after a global LIMIT (newest-N across *all* the agent's
    // rooms — discord/telegram/inbox/deleted/…) would silently drop accessible
    // matches that fall outside that window. Pushing the room set into the store
    // applies LIMIT/OFFSET after access-scoping.
    const accessibleRoomIds = Array.from(conversationsByRoomId.keys());
    if (accessibleRoomIds.length === 0) {
      json(res, { results: [], count: 0 });
      return true;
    }
    try {
      // Corpus-wide FTS + trigram ranking in the store (#13534): the DB ranks
      // by `ts_rank_cd` over a `websearch_to_tsquery` match (multi-word,
      // non-adjacent, quoted phrases) plus a `pg_trgm` partial-word fallback,
      // applying access-scoping and LIMIT/OFFSET *after* ranking. A relevant hit
      // older than any recency window is therefore found and ordered — unlike
      // the retired `ILIKE '%whole query%'` gate that ranked only a recency-
      // truncated slice of exact-substring rows.
      const hits = await runtime.searchMessages({
        roomIds: accessibleRoomIds,
        query,
        tableName: "messages",
        limit,
        offset,
        ...(since !== null ? { since } : {}),
        ...(until !== null ? { until } : {}),
      });
      const results = hits.flatMap(({ memory, ftsRank, trigramSimilarity }) => {
        const roomId = memory.roomId;
        const conversation = roomId
          ? conversationsByRoomId.get(roomId)
          : undefined;
        if (!roomId || !conversation) return [];
        const text = (memory.content as { text?: unknown } | undefined)?.text;
        if (typeof text !== "string") return [];
        const rawText = text.trim();
        if (!rawText || !memory.id) return [];
        // A messages memory always carries a numeric createdAt; if it somehow
        // does not, drop the row rather than inject epoch-0 into the DTO.
        if (typeof memory.createdAt !== "number") return [];
        // Rows matched only by the trigram/partial branch have ftsRank 0; expose
        // the trigram similarity as the score so the client still orders them
        // meaningfully. Both are real measured signals from the store.
        const score = ftsRank > 0 ? ftsRank : trigramSimilarity;
        return [
          {
            messageId: memory.id,
            conversationId: conversation.id,
            roomId,
            role: (memory.entityId === runtime.agentId
              ? "assistant"
              : "user") as "assistant" | "user",
            text: rawText,
            snippet: buildMessageSearchSnippet(rawText, query),
            createdAt: memory.createdAt,
            score,
          },
        ];
      });
      logger.info(
        {
          queryLength: query.length,
          limit,
          offset,
          ...(since !== null ? { since } : {}),
          ...(until !== null ? { until } : {}),
          rawHits: hits.length,
          results: results.length,
        },
        "[ConversationSearch] FTS message search completed",
      );
      json(res, { results, count: results.length });
      return true;
    } catch (err) {
      logger.error(
        { error: getErrorMessage(err) },
        "[ConversationSearch] keyword message search failed",
      );
      error(res, "Failed to search conversation messages", 500);
      return true;
    }
  }

  // ── POST /api/conversations/dev/seed-messages ───────────────────────
  // Dev-only: generate a large, realistic, BACKDATED conversation history
  // (default 12 conversations × 40 messages over 13 months, plus derived
  // facts) so message search — including since/until windows like "a year
  // ago" — has a real corpus. Invoked by
  // `packages/scripts/seed-message-corpus.mjs` for manual demo prep.
  if (
    method === "POST" &&
    pathname === "/api/conversations/dev/seed-messages"
  ) {
    // 404 (not 403) in production so the route's existence isn't advertised.
    if (process.env.NODE_ENV === "production") {
      error(res, "Not found", 404);
      return true;
    }
    if (!state.runtime) {
      error(res, "Agent runtime not available", 503);
      return true;
    }
    const rawSeed = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawSeed === null) return true;
    const parsedSeed = PostSeedMessagesRequestSchema.safeParse(rawSeed);
    if (!parsedSeed.success) {
      error(
        res,
        parsedSeed.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    await waitForConversationRestore(state);
    const corpus = generateMessageCorpus({
      ...(parsedSeed.data.conversations !== undefined
        ? { conversationCount: parsedSeed.data.conversations }
        : {}),
      ...(parsedSeed.data.messagesPerConversation !== undefined
        ? { messagesPerConversation: parsedSeed.data.messagesPerConversation }
        : {}),
      ...(parsedSeed.data.spanMonths !== undefined
        ? { spanMonths: parsedSeed.data.spanMonths }
        : {}),
      ...(parsedSeed.data.factsPerConversation !== undefined
        ? { factsPerConversation: parsedSeed.data.factsPerConversation }
        : {}),
      ...(parsedSeed.data.seed !== undefined
        ? { seed: parsedSeed.data.seed }
        : {}),
    });
    const summary = await seedMessageCorpus(state.runtime, corpus);
    // Register the seeded conversations in the live in-memory list so they are
    // visible + searchable immediately, without waiting for a restart-restore.
    for (const conv of summary.conversations) {
      state.conversations.set(conv.id, {
        id: conv.id,
        title: conv.title,
        roomId: conv.roomId,
        createdAt: new Date(conv.createdAt).toISOString(),
        updatedAt: new Date(conv.lastMessageAt).toISOString(),
      });
    }
    evictOldestConversation(state.conversations, 500);
    logger.info(
      {
        conversations: summary.conversations.length,
        messages: summary.messagesCreated,
        facts: summary.factsCreated,
        oldestMessageAt: summary.oldestMessageAt,
        newestMessageAt: summary.newestMessageAt,
      },
      "[ConversationSearch] seeded backdated message corpus",
    );
    json(res, {
      conversations: summary.conversations.length,
      messagesCreated: summary.messagesCreated,
      factsCreated: summary.factsCreated,
      oldestMessageAt: summary.oldestMessageAt,
      newestMessageAt: summary.newestMessageAt,
      sampleQueries: summary.sampleQueries,
    });
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
    const metadata = addWaifuConversationOwnerMetadata(
      req,
      sanitizeConversationMetadata(body.metadata),
    );
    const conv: ConversationMeta = {
      id,
      title: body.title?.trim() || "New Chat",
      roomId,
      ...(metadata ? { metadata } : {}),
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
        await ensureConversationRoom(
          state,
          conv,
          resolveConversationCaller(req, state),
        );
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
    if (rejectWaifuConversationAccessIfNeeded(req, conv, error, res)) {
      return true;
    }
    if (!state.runtime) {
      json(res, { messages: [] });
      return true;
    }
    const runtime = state.runtime;
    try {
      // `?around=<messageId>` centers the window on a specific (possibly
      // far-back) message so a keyword-search jump can scroll to a hit older
      // than the default recent window (#9955). Absent → unchanged recent window.
      const aroundParam = validateUuid(requestUrl.searchParams.get("around"));
      // `?before=<createdAt>&limit=N` loads one page STRICTLY OLDER than the
      // cursor for the infinite upward scroll (#13532): the client passes the
      // createdAt of its current oldest message and prepends the returned page.
      // Mutually exclusive with `around` — a centered jump defines its own
      // window. Returns `hasMore` so the client stops paging at the true top.
      const beforeParam = parseBeforeCursor(
        requestUrl.searchParams.get("before"),
      );
      const olderLimit = clampOlderPageLimit(
        requestUrl.searchParams.get("limit"),
      );
      let hasMore = false;
      let memories: Memory[];
      if (!aroundParam && beforeParam !== null) {
        const page = await loadConversationMessagesBefore(
          runtime,
          conv.roomId,
          beforeParam,
          olderLimit,
        );
        memories = page.memories;
        hasMore = page.hasMore;
      } else {
        memories = aroundParam
          ? await loadConversationMessagesAround(
              runtime,
              conv.roomId,
              aroundParam,
            )
          : await runtime.getMemories({
              roomId: conv.roomId,
              tableName: "messages",
              limit: CONVERSATION_MESSAGE_WINDOW,
            });
      }
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
            contentSource !== MESSAGE_SOURCE_CLIENT_CHAT
              ? contentSource
              : undefined;
          const actionName =
            typeof content.action === "string" && content.action.length > 0
              ? content.action
              : undefined;
          const actionCallbackHistory = normalizeActionCallbackHistory(
            content.actionCallbackHistory,
          );
          // The failed assistant turn carries its classification on the live
          // result (`content.failureKind`) or, for synthetic fallbacks, on
          // `metadata.chatFailureKind` (markSyntheticChatFailureContent). Round
          // it back so the renderer's provider/credits gate + Retry survive the
          // GET /messages full-replace instead of vanishing.
          const rawFailureKind =
            typeof content.failureKind === "string"
              ? content.failureKind
              : typeof meta?.chatFailureKind === "string"
                ? meta.chatFailureKind
                : undefined;
          const failureKind: ChatFailureKind | undefined =
            rawFailureKind === "insufficient_credits" ||
            rawFailureKind === "no_provider" ||
            rawFailureKind === "provider_issue" ||
            rawFailureKind === "rate_limited" ||
            rawFailureKind === "local_inference"
              ? rawFailureKind
              : undefined;
          // The CONNECT_ACCOUNT action stamps `content.accountConnect` on the
          // assistant memory. Validate + round-trip it so the inline
          // AddAccountDialog entry point survives the GET /messages replace.
          const accountConnect = normalizeAccountConnectRequest(
            content.accountConnect,
          );
          const role = m.entityId === agentId ? "assistant" : "user";
          const rawText = formatConversationMessageText(
            (m.content as { text?: string })?.text ?? "",
            actionCallbackHistory,
          );
          const text =
            role === "assistant"
              ? normalizeChatResponseText(rawText, state.logBuffer, runtime)
              : rawText;
          const attachments = serializeMessageAttachments(content);
          const topics =
            Array.isArray(meta?.topics) && meta.topics.length > 0
              ? (meta.topics as unknown[]).filter(
                  (topic): topic is string => typeof topic === "string",
                )
              : undefined;
          return {
            id: m.id ?? "",
            role,
            text,
            timestamp: m.createdAt ?? 0,
            ...(attachments ? { attachments } : {}),
            ...(topics && topics.length > 0 ? { topics } : {}),
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
            ...(failureKind ? { failureKind } : {}),
            ...(accountConnect ? { accountConnect } : {}),
          } satisfies ConversationRouteMessageRecord;
        })
        // Drop action-log memories that have no visible text (e.g.
        // plugin action logs with only `thought` / `actions` fields).
        // Without this filter they appear as blank chat bubbles. Image-only
        // turns (uploaded or generated media with no caption) are kept.
        .filter(
          (m) => m.text.trim().length > 0 || (m.attachments?.length ?? 0) > 0,
        );
      const discordMessages = messages.filter((message) =>
        mayNeedDiscordMessageEnrichment(message.source),
      );
      const discord =
        discordMessages.length > 0
          ? await getDiscordConversationApi().catch((err) => {
              logger.debug(
                `[conversations] Discord metadata enrichment unavailable: ${getErrorMessage(err)}`,
              );
              return null;
            })
          : null;
      await Promise.all(
        discordMessages.map(async (message) => {
          if (!discord) {
            return;
          }
          if (!discord.isCanonicalDiscordSource(message.source)) {
            return;
          }

          try {
            const storedSenderProfile =
              await discord.resolveStoredDiscordEntityProfile(
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
                ? await discord.resolveDiscordMessageAuthorProfile(
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
              const profile = await discord.resolveDiscordUserProfile(
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

            message.avatarUrl = await discord.cacheDiscordAvatarForRuntime(
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
        // Only the load-older (`before`) path advertises pagination state; the
        // recent + around windows are single fixed reads and omit it so their
        // response shape is unchanged.
        ...(beforeParam !== null && !aroundParam ? { hasMore } : {}),
      });
    } catch (err) {
      logger.warn(
        `[conversations] Failed to fetch messages: ${err instanceof Error ? err.message : String(err)}`,
      );
      json(res, { messages: [], error: "Failed to fetch messages" }, 500);
    }
    return true;
  }

  // ── POST /api/conversations/:id/import ──────────────────────────────
  // Silent bulk-insert of prior messages into a conversation WITHOUT running
  // inference. Powers the shared→personal cloud handoff: the user's freshly
  // provisioned personal container imports the conversation they already had
  // on the shared agent so the switch is seamless. Keyed by the provided
  // conversation id (so the client re-opens the same conversation after the
  // switch) and idempotent per conversation — re-import onto an already
  // populated room is a no-op, never a duplicate.
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/import$/.test(pathname)
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const rawImport = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawImport === null) return true;
    const rawMessages = rawImport.messages;
    if (!Array.isArray(rawMessages)) {
      error(res, "Body must include a `messages` array", 400);
      return true;
    }
    const importMessages = rawMessages
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const rec = entry as Record<string, unknown>;
        const role =
          rec.role === "assistant"
            ? "assistant"
            : rec.role === "user"
              ? "user"
              : null;
        const rawText =
          typeof rec.text === "string"
            ? rec.text
            : typeof rec.content === "string"
              ? rec.content
              : "";
        const text = rawText.trim();
        if (!role || !text) return null;
        const timestamp =
          typeof rec.timestamp === "number" && Number.isFinite(rec.timestamp)
            ? rec.timestamp
            : undefined;
        return { role, text, timestamp } as const;
      })
      .filter(
        (
          m,
        ): m is {
          readonly role: "user" | "assistant";
          readonly text: string;
          readonly timestamp: number | undefined;
        } => m !== null,
      );

    const runtime = await resolveRuntimeForChatTurn(state);
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return true;
    }
    await waitForConversationRestore(state);

    let conv = state.conversations.get(convId);
    if (!conv) {
      const now = new Date().toISOString();
      conv = {
        id: convId,
        title:
          typeof rawImport.title === "string" && rawImport.title.trim()
            ? rawImport.title.trim()
            : "New Chat",
        roomId: stringToUuid(`web-conv-${convId}`),
        createdAt: now,
        updatedAt: now,
      };
      state.conversations.set(convId, conv);
      evictOldestConversation(state.conversations, 500);
    }

    const caller = resolveConversationCaller(req, state);
    try {
      await ensureConversationRoom(state, conv, caller);
    } catch (err) {
      error(
        res,
        `Failed to initialize conversation room: ${getErrorMessage(err)}`,
        500,
      );
      return true;
    }

    // Idempotency: a populated room means the handoff already ran (or the user
    // chatted here). Never double-import.
    const existing = await runtime.getMemories({
      roomId: conv.roomId,
      tableName: "messages",
      limit: 1,
    });
    if (existing.length > 0) {
      json(res, {
        conversationId: convId,
        inserted: 0,
        skipped: importMessages.length,
        alreadyPopulated: true,
      });
      return true;
    }

    // Preserve original ordering: assign strictly increasing timestamps,
    // anchored to the provided ones when present.
    let inserted = 0;
    const anchor = Date.now() - importMessages.length;
    for (let i = 0; i < importMessages.length; i += 1) {
      const m = importMessages[i];
      const entityId =
        m.role === "assistant" ? runtime.agentId : caller.entityId;
      const createdAt = m.timestamp ?? anchor + i;
      try {
        const memory = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId,
          roomId: conv.roomId,
          content: {
            text: m.text,
            channelType: ChannelType.DM,
            source: "handoff_import",
          },
        }) as ReturnType<typeof createMessageMemory> & {
          createdAt?: number;
          metadata?: Record<string, unknown>;
        };
        memory.createdAt = createdAt;
        if (memory.metadata && typeof memory.metadata === "object") {
          memory.metadata.timestamp = createdAt;
        }
        await persistConversationMemory(runtime, memory);
        inserted += 1;
      } catch (err) {
        logger.warn(
          `[conversations] import: failed to persist message ${i}: ${getErrorMessage(err)}`,
        );
      }
    }
    conv.updatedAt = new Date().toISOString();
    state.broadcastWs?.({ type: "conversation-updated", conversation: conv });
    json(res, {
      conversationId: convId,
      inserted,
      skipped: importMessages.length - inserted,
    });
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
    if (rejectWaifuNonAdminMutationIfNeeded(req, error, res)) return true;

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

  // ── DELETE /api/conversations/:id/messages/:messageId ──────────────
  // Delete ONE message from the conversation and its backing memory row
  // (#13533). Distinct from truncate (edit-and-resend) and from the local-only
  // `removeConversationMessage` suggestion dismissal (#8792): this persists.
  if (
    method === "DELETE" &&
    /^\/api\/conversations\/[^/]+\/messages\/[^/]+$/.test(pathname)
  ) {
    const segments = pathname.split("/");
    const convId = decodeURIComponent(segments[3]);
    const messageId = decodeURIComponent(segments[5]);
    const conv = await getConversationWithRestore(state, convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return true;
    }
    // Non-admin waifu callers may only mutate their own conversation; the
    // access-scoped 404 keeps a foreign conv id from leaking existence.
    if (rejectWaifuConversationAccessIfNeeded(req, conv, error, res)) {
      return true;
    }
    if (rejectWaifuNonAdminMutationIfNeeded(req, error, res)) return true;

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return true;
    }

    try {
      const result = await deleteConversationMessage(runtime, conv, messageId);
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
    if (rejectWaifuConversationAccessIfNeeded(req, conv, error, res)) {
      return true;
    }

    const disconnectTracker = createConversationStreamDisconnectTracker({
      req,
      res,
      conversationId: conv.id,
      roomId: conv.roomId,
    });
    const finishStreamResponse = () => {
      disconnectTracker.markCompleted();
      disconnectTracker.dispose();
      if (!res.writableEnded) {
        res.end();
      }
    };

    const chatPayload = await readChatRequestPayload(req, res, {
      readJsonBody,
      error,
    });
    if (!chatPayload) {
      finishStreamResponse();
      return true;
    }
    const {
      prompt,
      channelType,
      images,
      preferredLanguage,
      source,
      metadata: chatMetadata,
    } = chatPayload;

    // The SSE channel opens as soon as the request is validated — before
    // runtime resolution, room setup, and user-message persistence — so the
    // client sees headers, an immediate `thinking` status, and heartbeats
    // during the pre-model work (runtime warming alone can take seconds; the
    // pre-model DB steps add serial round-trips). Everything past this point
    // reports failure as a structured SSE `error` event (the client maps
    // `type:"error"` data lines to StreamGenerationError); only the validation
    // above may answer with plain HTTP status codes.
    initSse(res);
    writeChatStatusSse(res, { kind: "thinking" });
    writeConversationStreamHeartbeat(res, disconnectTracker);
    const heartbeatInterval = setInterval(() => {
      if (disconnectTracker.checkConnectionClosed()) {
        return;
      }
      writeConversationStreamHeartbeat(res, disconnectTracker);
    }, 5000);
    const failStream = (message: string): true => {
      writeSse(res, { type: "error", message });
      clearInterval(heartbeatInterval);
      finishStreamResponse();
      return true;
    };

    // Hold the streaming turn through the warming window instead of dropping it
    // — the client already shows the optimistic bubble + typing indicator, and
    // the response streams the instant first-turn capability comes online.
    const runtime = await resolveRuntimeForChatTurn(state);
    if (!runtime) {
      return failStream("Agent is not running");
    }

    const caller = resolveConversationCaller(req, state);
    const userId = caller.entityId;
    const turnStartedAt = Date.now();

    try {
      await ensureConversationRoom(state, conv, caller);
    } catch (err) {
      return failStream(
        `Failed to initialize conversation room: ${getErrorMessage(err)}`,
      );
    }

    const { userMessage, messageToStore } = await buildUserMessages({
      images,
      prompt,
      userId,
      agentId: runtime.agentId,
      roomId: conv.roomId,
      channelType,
      messageSource: source,
      metadata: chatMetadata,
    });

    try {
      await persistConversationMemory(runtime, messageToStore);
    } catch (err) {
      return failStream(
        `Failed to store user message: ${getErrorMessage(err)}`,
      );
    }

    const walletModeGuidance = resolveWalletModeGuidanceReply(state, prompt);
    if (walletModeGuidance) {
      const endActiveChatTurn = beginActiveChatTurn(state);
      try {
        if (!disconnectTracker.isAborted()) {
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
            return true;
          }
          writeSseJson(res, {
            type: "done",
            fullText: walletModeGuidance,
            agentName: state.agentName,
          });
        }
      } finally {
        clearInterval(heartbeatInterval);
        finishStreamResponse();
        endActiveChatTurn();
      }
      return true;
    }

    // ── Local runtime path (streaming) ───────────────────────

    const endActiveChatTurn = beginActiveChatTurn(state);

    let streamedText = "";
    // The route already wrote a `thinking` status when the SSE channel opened;
    // collapse the identical opening status generateChatResponse re-emits so
    // the wire carries each phase transition once. Distinct consecutive phases
    // (thinking → running_action → thinking) still pass through.
    let lastStatusSignature = "thinking::";
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
          isAborted: () => disconnectTracker.isAborted(),
          abortSignal: disconnectTracker.signal,
          onStatus: (status) => {
            if (
              disconnectTracker.isAborted() ||
              disconnectTracker.checkConnectionClosed()
            ) {
              return;
            }
            const signature = `${status.kind}:${status.actionName ?? ""}:${status.toolName ?? ""}`;
            if (signature === lastStatusSignature) {
              return;
            }
            lastStatusSignature = signature;
            writeChatStatusSse(res, status);
          },
          onToolEvent: (event) => {
            if (
              disconnectTracker.isAborted() ||
              disconnectTracker.checkConnectionClosed()
            ) {
              return;
            }
            writeChatToolSse(res, event);
          },
          onChunk: (chunk) => {
            if (!chunk) return;
            if (
              disconnectTracker.isAborted() ||
              disconnectTracker.checkConnectionClosed()
            ) {
              return;
            }
            streamedText += chunk;
            writeChatTokenSse(res, chunk, streamedText);
          },
          onSnapshot: (text) => {
            if (!text) return;
            if (
              !streamedText ||
              disconnectTracker.isAborted() ||
              disconnectTracker.checkConnectionClosed()
            ) {
              return;
            }
            // Structured field extractors can briefly normalize whitespace or
            // closing punctuation while the same visible field is still
            // streaming. Do not shrink the user-visible token stream for
            // prefix-equivalent snapshots; later longer snapshots/deltas still
            // advance normally.
            if (
              text.length < streamedText.length &&
              streamedText.startsWith(text)
            ) {
              return;
            }
            streamedText = text;
            writeChatTokenSse(res, text, streamedText);
          },
          resolveNoResponseText: () =>
            resolveNoResponseFallback(state.logBuffer, runtime),
          preferredLanguage,
        },
      );

      if (!disconnectTracker.isAborted()) {
        conv.updatedAt = new Date().toISOString();
        if (result.noResponseReason !== "ignored") {
          const resolvedText = normalizeChatResponseText(
            result.text,
            state.logBuffer,
            runtime,
          );
          if (!streamedText && resolvedText) {
            for (const chunk of chunkVisibleTextForSse(resolvedText)) {
              if (disconnectTracker.isAborted()) break;
              streamedText += chunk;
              writeChatTokenSse(res, chunk, streamedText);
              await new Promise((resolve) => setTimeout(resolve, 60));
            }
          }
          // Emit `done` BEFORE persistence so user-perceived end-of-turn
          // latency excludes the ~100-500ms memory write. Persistence runs
          // after res.end() in the `finally` block as a detached promise.
          writeSseJson(res, {
            type: "done",
            fullText: resolvedText,
            agentName: result.agentName,
            ...(result.thought ? { thought: result.thought } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
            ...(result.actionResults?.length
              ? { actionResults: result.actionResults }
              : {}),
            // A non-throwing result can still carry a failure classification
            // (e.g. a canned provider-issue phrase folded into the reply). Mirror
            // the error branch so the renderer's gate + Retry persist.
            ...(result.failureKind ? { failureKind: result.failureKind } : {}),
            // Structured "connect another account" request from CONNECT_ACCOUNT.
            // Carried like failureKind so the renderer can offer the inline
            // AddAccountDialog entry point instead of a plain reply bubble.
            ...(result.accountConnect
              ? { accountConnect: result.accountConnect }
              : {}),
            ...(result.localInference
              ? { localInference: result.localInference }
              : {}),
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
            ...(result.actionResults?.length
              ? { actionResults: result.actionResults }
              : {}),
          });
        }
      }
    } catch (err) {
      if (isTurnAbortError(err)) {
        logger.info(
          { conversationId: conv.id, roomId: conv.roomId },
          "[ConversationStream] generation aborted",
        );
      } else if (!disconnectTracker.isAborted()) {
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
            {
              err: getErrorMessage(err),
              stack: err instanceof Error ? err.stack : undefined,
            },
            "Chat generation failed with no streamed text",
          );
          const alreadyPersistedVisibleAssistantTurn =
            await hasRecentVisibleAssistantMemorySince(
              runtime,
              conv.roomId,
              turnStartedAt,
            );
          if (alreadyPersistedVisibleAssistantTurn) {
            logger.warn(
              {
                err: getErrorMessage(err),
                conversationId: conv.id,
                roomId: conv.roomId,
              },
              "Chat generation failed after an assistant reply was already persisted — suppressing synthetic fallback",
            );
            writeSseJson(res, {
              type: "done",
              fullText: "",
              agentName: state.agentName,
            });
            return true;
          }
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
      finishStreamResponse();
      endActiveChatTurn();
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
    if (rejectWaifuConversationAccessIfNeeded(req, conv, error, res)) {
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
      preferredLanguage,
      source,
      metadata: restMetadata,
    } = chatPayload;
    // Hold the turn through the warming window (early API bind → runtime ready)
    // instead of dropping it; the client already shows the optimistic bubble.
    const runtime = await resolveRuntimeForChatTurn(state);
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return true;
    }
    const caller = resolveConversationCaller(req, state);
    const userId = caller.entityId;
    const turnStartedAt = Date.now();

    try {
      await ensureConversationRoom(state, conv, caller);
    } catch (err) {
      error(
        res,
        `Failed to initialize conversation room: ${getErrorMessage(err)}`,
        500,
      );
      return true;
    }

    const { userMessage, messageToStore } = await buildUserMessages({
      images,
      prompt,
      userId,
      agentId: runtime.agentId,
      roomId: conv.roomId,
      channelType,
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
      const endActiveChatTurn = beginActiveChatTurn(state);
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
      } finally {
        endActiveChatTurn();
      }
      return true;
    }

    const endActiveChatTurn = beginActiveChatTurn(state);
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
          ...(result.actionResults?.length
            ? { actionResults: result.actionResults }
            : {}),
          // A non-throwing result can still carry a failure classification
          // (e.g. a canned provider-issue phrase folded into the reply). Mirror
          // the error branch so the renderer's gate + Retry persist.
          ...(result.failureKind ? { failureKind: result.failureKind } : {}),
          ...(result.accountConnect
            ? { accountConnect: result.accountConnect }
            : {}),
          ...(result.localInference
            ? { localInference: result.localInference }
            : {}),
        });
      } else {
        json(res, {
          text: "",
          agentName: result.agentName,
          noResponseReason: "ignored",
          ...(result.actionResults?.length
            ? { actionResults: result.actionResults }
            : {}),
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
    } finally {
      endActiveChatTurn();
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
    if (rejectWaifuConversationAccessIfNeeded(req, conv, error, res)) {
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
      await ensureConversationRoom(
        state,
        conv,
        resolveConversationCaller(req, state),
      );
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
    if (rejectWaifuNonAdminMutationIfNeeded(req, error, res)) return true;
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

      const titleAbortTracker = createRequestDisconnectAbortTracker({
        req,
        res,
        operation: "conversation title generation",
      });
      let newTitle: string | null = null;
      try {
        newTitle = await generateConversationTitle(
          state.runtime,
          prompt,
          state.agentName,
          { signal: titleAbortTracker.signal },
        );
      } finally {
        titleAbortTracker.markCompleted();
        titleAbortTracker.dispose();
      }
      if (titleAbortTracker.isAborted()) return true;

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
    if (rejectWaifuNonAdminMutationIfNeeded(req, error, res)) return true;
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
    if (rejectWaifuNonAdminMutationIfNeeded(req, error, res)) return true;
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
