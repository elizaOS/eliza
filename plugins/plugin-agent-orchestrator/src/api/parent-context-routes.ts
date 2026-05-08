/**
 * Read-only parent-runtime context bridge for spawned task agents.
 *
 * Child CLI agents receive their session id in the injected memory file. These
 * routes let that child read narrowly-scoped parent state without exposing any
 * mutation surface back into the parent runtime.
 *
 * @module api/parent-context-routes
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { activeWorkspaceContextProvider } from "../providers/active-workspace-context.js";
import type { SessionInfo } from "../services/pty-types.js";
import type { TaskContext } from "../services/swarm-coordinator.js";
import type { RouteContext } from "./route-utils.js";
import { sendJson } from "./route-utils.js";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type ParentMemoryHit = { [key: string]: JsonValue } & {
  id: string | null;
  tableName: string;
  text: string;
  similarity: number | null;
  roomId: string | null;
  worldId: string | null;
  entityId: string | null;
  createdAt: number | null;
  metadata: JsonValue;
};

const BRIDGE_TIMEOUT_MS = 5_000;
const DEFAULT_MEMORY_LIMIT = 10;
const MAX_MEMORY_LIMIT = 50;
const MEMORY_TABLES = ["facts", "messages", "documents"] as const;
const TERMINAL_TASK_STATUSES = new Set(["completed", "error", "stopped"]);
const TERMINAL_SESSION_STATUSES = new Set(["stopped", "error", "exited"]);

class BridgeRouteError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendBridgeError(
  res: ServerResponse,
  code: string,
  message: string,
  status: number,
): void {
  sendJson(res, { error: message, code }, status);
}

function isLoopbackRemoteAddress(
  remoteAddress: string | null | undefined,
): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized === "::ffff:0:127.0.0.1"
  );
}

function parseSessionId(raw: string): string | null {
  let decoded = "";
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("/") || decoded.includes("..")) {
    return null;
  }
  return decoded;
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_MEMORY_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MEMORY_LIMIT;
  return Math.max(1, Math.min(MAX_MEMORY_LIMIT, Math.floor(parsed)));
}

function withBridgeTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new BridgeRouteError(
          "parent_context_timeout",
          503,
          "Parent runtime context bridge timed out.",
        ),
      );
    }, BRIDGE_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function getSession(ctx: RouteContext, sessionId: string): SessionInfo | null {
  return ctx.ptyService?.getSession(sessionId) ?? null;
}

function getTask(ctx: RouteContext, sessionId: string): TaskContext | null {
  return ctx.coordinator?.getTaskContext(sessionId) ?? null;
}

function isActiveSession(
  task: TaskContext | null,
  session: SessionInfo | null,
): boolean {
  if (task && !TERMINAL_TASK_STATUSES.has(task.status)) return true;
  if (session && !TERMINAL_SESSION_STATUSES.has(String(session.status))) {
    return true;
  }
  return false;
}

function readSessionMetadata(
  task: TaskContext | null,
  session: SessionInfo | null,
): Record<string, unknown> {
  const raw = session?.metadata;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  return task?.originMetadata ?? {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readOriginRoomId(
  task: TaskContext | null,
  metadata: Record<string, unknown>,
): string | null {
  return (
    readString(task?.originRoomId) ??
    readString(metadata.originRoomId) ??
    readString(metadata.roomId)
  );
}

function normalizeDocumentSources(value: unknown): JsonValue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): JsonValue[] => {
    if (typeof entry === "string" && entry.trim()) return [entry.trim()];
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as {
      item?: { case?: string; value?: unknown };
      path?: unknown;
      directory?: unknown;
    };
    if (typeof raw.path === "string" && raw.path.trim()) {
      return [raw.path.trim()];
    }
    if (typeof raw.directory === "string" && raw.directory.trim()) {
      return [raw.directory.trim()];
    }
    if (raw.item?.case === "path" && typeof raw.item.value === "string") {
      return [raw.item.value];
    }
    if (
      raw.item?.case === "directory" &&
      raw.item.value &&
      typeof raw.item.value === "object"
    ) {
      const directory = raw.item.value as {
        path?: unknown;
        directory?: unknown;
      };
      const pathValue =
        readString(directory.path) ?? readString(directory.directory);
      return pathValue ? [pathValue] : [];
    }
    return [];
  });
}

function normalizeModel(
  task: TaskContext | null,
  session: SessionInfo | null,
  metadata: Record<string, unknown>,
): JsonValue {
  const rawPrefs = metadata.modelPrefs;
  const modelPrefs =
    rawPrefs && typeof rawPrefs === "object" && !Array.isArray(rawPrefs)
      ? (rawPrefs as Record<string, unknown>)
      : {};
  return {
    agentType: session?.agentType ?? task?.agentType ?? null,
    powerful: readString(modelPrefs.powerful),
    fast: readString(modelPrefs.fast),
  };
}

async function loadRoom(
  runtime: IAgentRuntime,
  roomId: string | null,
): Promise<JsonValue> {
  if (!roomId) return null;
  const room = await runtime.getRoom(roomId as Memory["roomId"]);
  if (!room) return { id: roomId, channel: null, platform: null };
  return {
    id: room.id,
    channel: room.channelId ?? room.name ?? null,
    platform: room.source ?? null,
    type: room.type ?? null,
    worldId: room.worldId ?? null,
  };
}

function normalizeMemoryHit(
  tableName: string,
  memory: Memory,
): ParentMemoryHit {
  const raw = memory as Memory & { similarity?: number };
  const text =
    typeof memory.content?.text === "string" ? memory.content.text : "";
  return {
    id: typeof memory.id === "string" ? memory.id : null,
    tableName,
    text,
    similarity:
      typeof raw.similarity === "number" && Number.isFinite(raw.similarity)
        ? raw.similarity
        : null,
    roomId: typeof memory.roomId === "string" ? memory.roomId : null,
    worldId: typeof memory.worldId === "string" ? memory.worldId : null,
    entityId: typeof memory.entityId === "string" ? memory.entityId : null,
    createdAt:
      typeof memory.createdAt === "number" && Number.isFinite(memory.createdAt)
        ? memory.createdAt
        : null,
    metadata:
      memory.metadata && typeof memory.metadata === "object"
        ? (memory.metadata as unknown as JsonValue)
        : null,
  };
}

async function buildParentContext(
  ctx: RouteContext,
  sessionId: string,
  task: TaskContext | null,
  session: SessionInfo | null,
): Promise<JsonValue> {
  const metadata = readSessionMetadata(task, session);
  const roomId = readOriginRoomId(task, metadata);
  const character = ctx.runtime.character;
  return {
    sessionId,
    character: {
      name: character.name ?? null,
      bio: Array.isArray(character.bio)
        ? character.bio
        : typeof character.bio === "string"
          ? [character.bio]
          : [],
      documents: normalizeDocumentSources([
        ...(Array.isArray(character.documents) ? character.documents : []),
        ...(Array.isArray(character.knowledge) ? character.knowledge : []),
      ]),
    },
    currentRoom: await loadRoom(ctx.runtime, roomId),
    workdir: session?.workdir ?? task?.workdir ?? null,
    model: normalizeModel(task, session, metadata),
  };
}

async function searchParentMemory(
  ctx: RouteContext,
  query: string,
  limit: number,
): Promise<JsonValue> {
  const embedding = await ctx.runtime.useModel(ModelType.TEXT_EMBEDDING, {
    text: query,
  });
  const perTableLimit = Math.max(
    limit,
    Math.ceil(limit / MEMORY_TABLES.length),
  );
  const grouped = await Promise.all(
    MEMORY_TABLES.map(async (tableName) => {
      const hits = await ctx.runtime.searchMemories({
        tableName,
        embedding,
        query,
        limit: perTableLimit,
      });
      return hits.map((hit) => normalizeMemoryHit(tableName, hit));
    }),
  );
  const hits = grouped
    .flat()
    .sort(
      (left, right) =>
        (right.similarity ?? Number.NEGATIVE_INFINITY) -
        (left.similarity ?? Number.NEGATIVE_INFINITY),
    )
    .slice(0, limit);
  return { query, limit, hits };
}

async function listActiveWorkspaceContext(
  ctx: RouteContext,
): Promise<JsonValue> {
  const result = await activeWorkspaceContextProvider.get(
    ctx.runtime,
    {
      id: ctx.runtime.agentId,
      agentId: ctx.runtime.agentId,
      entityId: ctx.runtime.agentId,
      roomId: ctx.runtime.agentId,
      content: { text: "" },
    } as Memory,
    { values: {}, data: {}, text: "" },
  );
  return (result.data ?? {}) as JsonValue;
}

/**
 * Handle read-only parent-runtime bridge routes.
 * Returns true if the route was handled, false otherwise.
 */
export async function handleParentContextRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: RouteContext,
): Promise<boolean> {
  const match = pathname.match(
    /^\/api\/coding-agents\/([^/]+)\/(parent-context|memory|active-workspaces)$/,
  );
  if (!match) return false;

  if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
    sendBridgeError(
      res,
      "loopback_only",
      "Bridge routes are loopback-only.",
      403,
    );
    return true;
  }

  const method = req.method?.toUpperCase() ?? "GET";
  if (method !== "GET") {
    sendBridgeError(
      res,
      "method_not_allowed",
      "Bridge routes are read-only and only support GET.",
      405,
    );
    return true;
  }

  const sessionId = parseSessionId(match[1]);
  if (!sessionId) {
    sendBridgeError(res, "invalid_agent_id", "Invalid task-agent id.", 400);
    return true;
  }

  const task = getTask(ctx, sessionId);
  const session = getSession(ctx, sessionId);
  if (!isActiveSession(task, session)) {
    sendBridgeError(
      res,
      "task_no_longer_active",
      "The task-agent session is no longer active in this parent runtime.",
      410,
    );
    return true;
  }

  try {
    const endpoint = match[2];
    if (endpoint === "parent-context") {
      sendJson(
        res,
        await withBridgeTimeout(
          buildParentContext(ctx, sessionId, task, session),
        ),
      );
      return true;
    }
    if (endpoint === "memory") {
      const url = new URL(req.url ?? pathname, "http://localhost");
      const query = url.searchParams.get("q")?.trim() ?? "";
      if (!query) {
        sendBridgeError(
          res,
          "missing_query",
          "memory requires q=<query>.",
          400,
        );
        return true;
      }
      sendJson(
        res,
        await withBridgeTimeout(
          searchParentMemory(
            ctx,
            query,
            parseLimit(url.searchParams.get("limit")),
          ),
        ),
      );
      return true;
    }
    sendJson(res, await withBridgeTimeout(listActiveWorkspaceContext(ctx)));
    return true;
  } catch (error) {
    if (error instanceof BridgeRouteError) {
      sendBridgeError(res, error.code, error.message, error.status);
      return true;
    }
    sendBridgeError(
      res,
      "parent_context_unavailable",
      error instanceof Error
        ? error.message
        : "Parent runtime context bridge failed.",
      503,
    );
    return true;
  }
}
