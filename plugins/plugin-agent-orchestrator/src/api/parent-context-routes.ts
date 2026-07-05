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
import {
  type SessionInfo,
  TERMINAL_SESSION_STATUSES,
} from "../services/types.js";
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
/** How many of the most recent orchestrator decisions the bridge exposes. A
 * resumed/nested session needs the latest choices to avoid re-litigating them,
 * not the full audit log. */
const MAX_ORIGINATING_DECISIONS = 20;

/** The narrow slice of the AgentSkillsService the bridge reads. Structural to
 * avoid a hard dependency on `@elizaos/plugin-agent-skills` (optional at
 * runtime); `content` is the full SKILL.md body incl. frontmatter. */
interface SkillsServiceShape {
  getEligibleSkills: () => Promise<
    Array<{ slug: string; name: string; description: string; content: string }>
  >;
  isSkillEnabled: (slug: string) => boolean;
}

/** The narrow slice of the orchestrator task store the bridge reads to answer
 * "what am I working on?". Structural — avoids a value import on the service so
 * the route stays loosely coupled and the DTO shape can evolve independently. */
interface OrchestratorTaskServiceShape {
  getTask: (taskId: string) => Promise<{
    goal: string;
    acceptanceCriteria?: string[];
    decisions?: Array<{
      id: string;
      sessionId: string;
      event: string;
      decision: string;
      reasoning: string;
      response: string | null;
      timestamp: number;
      createdAt: string;
    }>;
  } | null>;
}

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
    // error-policy:J3 untrusted-input sanitizing; a malformed percent-encoding
    // is an explicit invalid session id (null), rejected by the caller.
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

async function getSession(
  ctx: RouteContext,
  sessionId: string,
): Promise<SessionInfo | null> {
  return (await ctx.acpService?.getSession(sessionId)) ?? null;
}

function isActiveSession(session: SessionInfo | null): boolean {
  if (session && !TERMINAL_SESSION_STATUSES.has(String(session.status))) {
    return true;
  }
  return false;
}

function readSessionMetadata(
  session: SessionInfo | null,
): Record<string, unknown> {
  const raw = session?.metadata;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  return {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null));
}

function readOriginRoomId(metadata: Record<string, unknown>): string | null {
  return readString(metadata.originRoomId) ?? readString(metadata.roomId);
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
  session: SessionInfo | null,
  metadata: Record<string, unknown>,
): JsonValue {
  const rawPrefs = metadata.modelPrefs;
  const modelPrefs =
    rawPrefs && typeof rawPrefs === "object" && !Array.isArray(rawPrefs)
      ? (rawPrefs as Record<string, unknown>)
      : {};
  return {
    agentType: session?.agentType ?? null,
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
    platform: room.source,
    type: room.type,
    worldId: room.worldId ?? null,
  };
}

function normalizeMemoryHit(
  tableName: string,
  memory: Memory,
): ParentMemoryHit {
  const raw = memory as Memory & { similarity?: number };
  const text =
    typeof memory.content.text === "string" ? memory.content.text : "";
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
        ? toJsonValue(memory.metadata)
        : null,
  };
}

/**
 * Load the originating orchestrator task a session serves — its goal, acceptance
 * criteria, and the latest decisions — so a resumed or child-spawned session can
 * read back what it is working on. Returns null when the session was not spawned
 * from an orchestrator task (no `taskId` in metadata), the task store is absent,
 * or the task no longer exists.
 */
async function loadOriginatingTask(
  ctx: RouteContext,
  metadata: Record<string, unknown>,
): Promise<JsonValue> {
  const taskId = readString(metadata.taskId);
  if (!taskId) return null;
  const service = ctx.runtime.getService("ORCHESTRATOR_TASK_SERVICE") as
    | OrchestratorTaskServiceShape
    | null
    | undefined;
  if (!service?.getTask) return null;
  const task = await service.getTask(taskId);
  if (!task) return null;
  const decisions = (task.decisions ?? [])
    .slice(-MAX_ORIGINATING_DECISIONS)
    .map((decision) => ({
      id: decision.id,
      sessionId: decision.sessionId,
      event: decision.event,
      decision: decision.decision,
      reasoning: decision.reasoning,
      response: decision.response,
      timestamp: decision.timestamp,
      createdAt: decision.createdAt,
    }));
  return {
    taskId,
    goal: task.goal,
    acceptanceCriteria: Array.isArray(task.acceptanceCriteria)
      ? task.acceptanceCriteria
      : [],
    decisions,
  };
}

async function buildParentContext(
  ctx: RouteContext,
  sessionId: string,
  session: SessionInfo | null,
): Promise<JsonValue> {
  const metadata = readSessionMetadata(session);
  const roomId = readOriginRoomId(metadata);
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
    workdir: session?.workdir ?? null,
    model: normalizeModel(session, metadata),
    originatingTask: await loadOriginatingTask(ctx, metadata),
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

/** Resolve the AgentSkillsService, or null when the skills plugin is not loaded.
 * The manifest written into the workspace lists slugs a child can request; these
 * endpoints let the child fetch the full SKILL.md a slug maps to. */
function getSkillsService(ctx: RouteContext): SkillsServiceShape | null {
  const service = ctx.runtime.getService("AGENT_SKILLS_SERVICE") as
    | SkillsServiceShape
    | null
    | undefined;
  return typeof service?.getEligibleSkills === "function" ? service : null;
}

/**
 * List the enabled-and-eligible skills with their FULL (untruncated) description
 * — the SKILLS.md manifest only carries a 200-char preview, so a child reads
 * this to decide which skill body to fetch. Gated to enabled+eligible so the
 * list matches exactly what the child can actually request via the parent.
 */
async function listSkills(ctx: RouteContext): Promise<JsonValue> {
  const service = getSkillsService(ctx);
  if (!service) return { skills: [] };
  const eligible = await service.getEligibleSkills();
  const skills = eligible
    .filter((skill) => service.isSkillEnabled(skill.slug))
    .map((skill) => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
    }));
  return { skills };
}

/**
 * Return the full SKILL.md body (including frontmatter) for one slug, or null
 * when it is not an enabled+eligible skill — the caller turns null into a 404.
 * Same enabled+eligible gate as {@link listSkills} so a child can only read a
 * body it could request.
 */
async function readSkillBody(
  ctx: RouteContext,
  slug: string,
): Promise<JsonValue | null> {
  const service = getSkillsService(ctx);
  if (!service) return null;
  const eligible = await service.getEligibleSkills();
  const match = eligible.find(
    (skill) => skill.slug === slug && service.isSkillEnabled(skill.slug),
  );
  if (!match) return null;
  return {
    slug: match.slug,
    name: match.name,
    description: match.description,
    body: match.content,
  };
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
  return toJsonValue(result.data ?? {});
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
    /^\/api\/coding-agents\/([^/]+)\/(parent-context|memory|active-workspaces|skills)(?:\/([^/]+))?$/,
  );
  if (!match) return false;
  // `skills` takes an optional trailing slug (`.../skills/<slug>`); every other
  // endpoint is a leaf and must not carry one.
  const skillSlugSegment = match[3];
  if (skillSlugSegment !== undefined && match[2] !== "skills") return false;

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

  const session = await getSession(ctx, sessionId);
  if (!isActiveSession(session)) {
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
        await withBridgeTimeout(buildParentContext(ctx, sessionId, session)),
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
    if (endpoint === "skills") {
      if (skillSlugSegment === undefined) {
        sendJson(res, await withBridgeTimeout(listSkills(ctx)));
        return true;
      }
      const slug = parseSessionId(skillSlugSegment);
      if (!slug) {
        sendBridgeError(res, "invalid_skill_slug", "Invalid skill slug.", 400);
        return true;
      }
      const body = await withBridgeTimeout(readSkillBody(ctx, slug));
      if (body === null) {
        sendBridgeError(
          res,
          "skill_not_found",
          `No enabled skill matches slug "${slug}".`,
          404,
        );
        return true;
      }
      sendJson(res, body);
      return true;
    }
    sendJson(res, await withBridgeTimeout(listActiveWorkspaceContext(ctx)));
    return true;
  } catch (error) {
    // error-policy:J1 route boundary — translate any failure into a structured
    // HTTP error response (typed BridgeRouteError code, else a 503), never a
    // success; `return true` means "request handled", not "succeeded".
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
