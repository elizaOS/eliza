/**
 * Sub-agent bridge routes — read-only HTTP endpoints exposing parent state.
 *
 * Spawned coding sub-agents (Claude Code, Codex) live in sealed PTY workspaces
 * with no direct access to the parent Eliza runtime's memory, character, or
 * room context. These routes give them a constrained read channel so they can
 * resolve pronouns ("the user's dad") and align with parent context the
 * orchestrator's task brief didn't surface.
 *
 * Endpoints (loopback-only, agentId-authed via the path):
 *
 *   GET /api/coding-agents/:sessionId/parent-context
 *   GET /api/coding-agents/:sessionId/memory?q=<query>&limit=<N>
 *   GET /api/coding-agents/:sessionId/active-workspaces
 *
 * All responses are read-only. Mutations stay with the orchestrator —
 * sub-agents can't write parent state through the bridge.
 *
 * Validation: every request's :sessionId is checked against the coordinator's
 * `tasks` map. Unknown / stale sessions get 404. Tasks in stopped/error/completed
 * status get 410 (so the sub-agent can fall back to no-parent-context mode
 * cleanly).
 *
 * @module api/bridge-routes
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskContext } from "../services/swarm-coordinator.js";
import type { RouteContext } from "./route-utils.js";
import { sendError, sendJson } from "./route-utils.js";

const SESSION_ID_PATTERN = /^pty-\d+-[0-9a-f]+$/;

/** Bridge endpoint path matcher. */
const BRIDGE_PATH =
  /^\/api\/coding-agents\/(pty-\d+-[0-9a-f]+)\/(parent-context|memory|active-workspaces)\/?$/;

/**
 * Parsed bridge request.
 */
interface BridgeRequest {
  sessionId: string;
  endpoint: "parent-context" | "memory" | "active-workspaces";
  query: URLSearchParams;
}

function parseBridgeRequest(
  pathname: string,
  rawUrl: string | undefined,
): BridgeRequest | null {
  const match = pathname.match(BRIDGE_PATH);
  if (!match) return null;
  const sessionId = match[1];
  const endpoint = match[2] as BridgeRequest["endpoint"];
  const fullUrl = rawUrl ?? "";
  const queryStart = fullUrl.indexOf("?");
  const query =
    queryStart >= 0
      ? new URLSearchParams(fullUrl.slice(queryStart + 1))
      : new URLSearchParams();
  return { sessionId, endpoint, query };
}

/**
 * Resolve the TaskContext for a sessionId from the coordinator. Returns the
 * task plus a "freshness" indicator the caller uses to decide between 200,
 * 404 (unknown), and 410 (stale).
 */
function resolveTaskContext(
  ctx: RouteContext,
  sessionId: string,
): { task: TaskContext | null; status: "active" | "stale" | "unknown" } {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return { task: null, status: "unknown" };
  }
  const coordinator = ctx.coordinator;
  if (!coordinator) {
    return { task: null, status: "unknown" };
  }
  const task = coordinator.tasks.get(sessionId) ?? null;
  if (!task) {
    return { task: null, status: "unknown" };
  }
  const stale =
    task.status === "stopped" ||
    task.status === "error" ||
    task.status === "completed";
  return { task, status: stale ? "stale" : "active" };
}

/**
 * GET /api/coding-agents/:sessionId/parent-context
 *
 * Returns the agent's character profile, the originating room (so the
 * sub-agent knows where its work eventually surfaces), and the task's spawn
 * metadata.
 */
async function handleParentContext(
  res: ServerResponse,
  ctx: RouteContext,
  task: TaskContext,
): Promise<void> {
  const character = ctx.runtime.character;
  const thread = task.threadId
    ? await ctx.coordinator?.taskRegistry
        .getThread(task.threadId)
        .catch(() => null)
    : null;
  sendJson(res, {
    session_id: task.sessionId,
    agent_label: task.label,
    workdir: task.workdir,
    repo: task.repo ?? null,
    agent_type: task.agentType,
    character: {
      name: character?.name ?? null,
      bio: Array.isArray(character?.bio)
        ? character.bio
        : typeof character?.bio === "string"
          ? [character.bio]
          : [],
      topics: Array.isArray(character?.topics) ? character.topics : [],
    },
    room: thread?.roomId
      ? {
          id: thread.roomId,
          thread_id: task.threadId,
        }
      : null,
    original_task: task.originalTask ?? null,
  });
}

/**
 * GET /api/coding-agents/:sessionId/memory?q=<query>&limit=<N>
 *
 * Returns recent messages from the originating room, optionally filtered by
 * a substring query. Useful for the sub-agent to resolve pronouns or recover
 * context the task brief didn't capture. Read-only — no write API exists.
 */
async function handleMemory(
  res: ServerResponse,
  ctx: RouteContext,
  task: TaskContext,
  query: URLSearchParams,
): Promise<void> {
  const thread = task.threadId
    ? await ctx.coordinator?.taskRegistry
        .getThread(task.threadId)
        .catch(() => null)
    : null;
  if (!thread?.roomId) {
    sendJson(res, { messages: [], count: 0, room_id: null });
    return;
  }

  const rawLimit = Number(query.get("limit") ?? "10");
  const limit = Math.max(
    1,
    Math.min(50, Number.isFinite(rawLimit) ? rawLimit : 10),
  );
  const queryText = (query.get("q") ?? "").trim().toLowerCase();

  const memories = await ctx.runtime
    .getMemories({
      roomId: thread.roomId,
      count: limit * 2,
      tableName: "messages",
    })
    .catch(() => []);

  const matched = memories
    .map((m) => {
      const text = (m.content as { text?: string }).text;
      if (typeof text !== "string" || text.length === 0) return null;
      if (queryText && !text.toLowerCase().includes(queryText)) return null;
      return {
        speaker: m.entityId === ctx.runtime.agentId ? "agent" : "user",
        text: text.length > 600 ? `${text.slice(0, 600)}...` : text,
        created_at: m.createdAt ? new Date(m.createdAt).toISOString() : null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, limit);

  sendJson(res, {
    room_id: thread.roomId,
    query: queryText || null,
    count: matched.length,
    messages: matched.reverse(),
  });
}

/**
 * GET /api/coding-agents/:sessionId/active-workspaces
 *
 * Returns the orchestrator's currently-active task workspaces (other than
 * the requesting one). Lets a sub-agent see its siblings when running under
 * a swarm without parsing the injected CLAUDE.md.
 */
function handleActiveWorkspaces(
  res: ServerResponse,
  ctx: RouteContext,
  requesting: TaskContext,
): void {
  const coordinator = ctx.coordinator;
  if (!coordinator) {
    sendJson(res, { workspaces: [], count: 0 });
    return;
  }
  const peers = [...coordinator.tasks.values()]
    .filter(
      (t) =>
        t.sessionId !== requesting.sessionId &&
        (t.status === "active" || t.status === "tool_running"),
    )
    .map((t) => ({
      session_id: t.sessionId,
      label: t.label,
      agent_type: t.agentType,
      workdir: t.workdir,
      repo: t.repo ?? null,
    }));
  sendJson(res, { workspaces: peers, count: peers.length });
}

/**
 * Entry point — dispatches to the right handler based on parsed path.
 */
export async function handleBridgeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: RouteContext,
): Promise<boolean> {
  const parsed = parseBridgeRequest(pathname, req.url);
  if (!parsed) return false;

  if ((req.method ?? "").toUpperCase() !== "GET") {
    sendError(res, "Bridge endpoints are GET-only", 405);
    return true;
  }

  const { task, status } = resolveTaskContext(ctx, parsed.sessionId);
  if (status === "unknown" || !task) {
    sendError(res, `Unknown sessionId ${parsed.sessionId}`, 404);
    return true;
  }
  if (status === "stale") {
    sendError(
      res,
      `Session ${parsed.sessionId} is in terminal state (${task.status}); no parent context available`,
      410,
    );
    return true;
  }

  switch (parsed.endpoint) {
    case "parent-context":
      await handleParentContext(res, ctx, task);
      return true;
    case "memory":
      await handleMemory(res, ctx, task, parsed.query);
      return true;
    case "active-workspaces":
      handleActiveWorkspaces(res, ctx, task);
      return true;
  }
}
