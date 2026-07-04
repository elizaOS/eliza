/**
 * TASKS — single Pattern C parent action that subsumes the orchestrator's
 * task-agent lifecycle, workspace lifecycle, GitHub issue management, and
 * coding-task archive/reopen surface.
 *
 * Each sub-action is exposed as a simile of the parent and dispatched to a
 * per-action runner in this file.
 *
 * Actions:
 *   create               — CREATE_AGENT_TASK / START_CODING_TASK
 *   spawn_agent          — SPAWN_AGENT
 *   send                 — SEND_TO_AGENT
 *   stop_agent           — STOP_AGENT
 *   list_agents          — LIST_AGENTS
 *   cancel               — CANCEL_TASK
 *   history              — TASK_HISTORY
 *   control              — TASK_CONTROL (action: pause|resume|stop|continue|archive|reopen)
 *   share                — TASK_SHARE
 *   provision_workspace  — CREATE_WORKSPACE / PROVISION_WORKSPACE
 *   submit_workspace     — SUBMIT_WORKSPACE / FINALIZE_WORKSPACE
 *   manage_issues        — MANAGE_ISSUES (action: create|list|get|update|comment|close|reopen|add_labels)
 *   archive              — ARCHIVE_CODING_TASK
 *   reopen               — REOPEN_CODING_TASK
 *
 * @module actions/tasks
 */

import * as fs from "node:fs";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Room,
  State,
  UUID,
} from "@elizaos/core";
import {
  ChannelType,
  logger as coreLogger,
  MESSAGE_SOURCE_SUB_AGENT,
  stringToUuid,
} from "@elizaos/core";
import type { IssueInfo, PullRequestInfo } from "git-workspace-service";
import {
  detectTaskType,
  type OrchestratorTaskType,
} from "../services/acceptance-criteria.js";
import { augmentTaskWithDeployGuidance } from "../services/app-deploy-guidance.js";
import { resolveCodingBackendLogged } from "../services/coding-backend-routing.js";
import type { TaskThreadDto } from "../services/orchestrator-task-mapper.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import type { OrchestratorTaskStatus } from "../services/orchestrator-task-types.js";
import { normalizeRepositoryInput } from "../services/repo-input.js";
import {
  runDurableTask,
  shouldUseSmithersTaskRunner,
} from "../services/smithers-task-integration";
import {
  KNOWN_ADAPTER_TYPES,
  normalizeTaskAgentAdapter,
  type ResolvedWorkdirRoute,
  resolveSpawnWorkdir,
} from "../services/task-agent-routing.js";
import { requireTaskAgentAccess } from "../services/task-policy.js";
import {
  type AgentType,
  type SessionInfo,
  type SpawnResult,
  TERMINAL_SESSION_STATUSES,
} from "../services/types.js";
import type {
  AuthPromptCallback,
  CodingWorkspaceService,
  WorkspaceResult,
} from "../services/workspace-service.js";
import { getCodingWorkspaceService } from "../services/workspace-service.js";
import {
  callbackText,
  contentRecord,
  emitSessionEvent,
  errorResult,
  failureMessage,
  getAcpService,
  getTimeoutMs,
  type HandlerOptionsLike,
  hasExplicitPayload,
  isAuthError,
  labelFor,
  listSessionsWithin,
  logger,
  messageText,
  newestSession,
  paramsRecord,
  parseApproval,
  pickBoolean,
  pickString,
  resolveOriginatingRequestText,
  resolveSession,
  setCurrentSession,
  setCurrentSessions,
  shortId,
  waitForSpawnSlot,
} from "./common.js";

const MAX_CONCURRENT_AGENTS = 8;
const PROVISION_WORKSPACE_TIMEOUT_MS = 60_000;
const WORKSPACE_PATH_MAX_CHARS = 500;
const ISSUE_RESULT_LIMIT = 25;
const ISSUE_BODY_MAX_CHARS = 4_000;

type TaskOp =
  | "create"
  | "spawn_agent"
  | "send"
  | "stop_agent"
  | "list_agents"
  | "cancel"
  | "history"
  | "control"
  | "share"
  | "provision_workspace"
  | "submit_workspace"
  | "manage_issues"
  | "archive"
  | "reopen";

const SUPPORTED_OPS: readonly TaskOp[] = [
  "create",
  "spawn_agent",
  "send",
  "stop_agent",
  "list_agents",
  "cancel",
  "history",
  "control",
  "share",
  "provision_workspace",
  "submit_workspace",
  "manage_issues",
  "archive",
  "reopen",
] as const;

type ControlAction =
  | "pause"
  | "stop"
  | "resume"
  | "continue"
  | "archive"
  | "reopen";

type HistoryMetric = "list" | "count" | "detail";
type HistoryWindow =
  | "active"
  | "today"
  | "yesterday"
  | "last_7_days"
  | "last_30_days";

const TASK_HISTORY_STATUSES: ReadonlySet<OrchestratorTaskStatus> = new Set([
  "open",
  "active",
  "waiting_on_user",
  "blocked",
  "validating",
  "done",
  "failed",
  "archived",
  "interrupted",
]);

const ACTIVE_TASK_HISTORY_STATUSES: ReadonlySet<OrchestratorTaskStatus> =
  new Set([
    "open",
    "active",
    "waiting_on_user",
    "blocked",
    "validating",
    "interrupted",
  ]);

function startOfDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function endOfDay(date: Date): Date {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end;
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function readOp(params: Record<string, unknown>): TaskOp | null {
  const raw = [
    params.action,
    params.op,
    params.subaction,
    params.operation,
  ].find((value): value is string => typeof value === "string");
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/-/g, "_");
  return (SUPPORTED_OPS as readonly string[]).includes(normalized)
    ? (normalized as TaskOp)
    : null;
}

// ── action: create (CREATE_AGENT_TASK) ──────────────────────────────────────

function taskParts(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  fallbackText: string,
): string[] {
  const agents = pickString(params, content, "agents");
  if (!agents) return [pickString(params, content, "task") ?? fallbackText];
  return agents
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * A leading `backend:` prefix is an explicit per-subtask backend override (e.g.
 * "claude: refactor X"). It only counts when the prefix is a KNOWN adapter —
 * otherwise the colon is ordinary text ("Fix: the login bug", "Note: ...", a
 * bare URL) and the whole part is the task. This keeps the prefix a structural
 * backend selector rather than a regex that turns any leading word into a
 * spawn target (which would crash on an unknown command and amounts to picking
 * a backend from arbitrary message text).
 */
function parseAgentPrefix(
  part: string,
  fallbackAgentType: string,
): { task: string; agentType: string } {
  const match = part.match(/^([a-z][a-z0-9_-]{1,32})\s*:\s*(.+)$/i);
  if (!match) return { task: part, agentType: fallbackAgentType };
  const candidate = normalizeTaskAgentAdapter(match[1]);
  if (!candidate || !KNOWN_ADAPTER_TYPES.has(candidate)) {
    return { task: part, agentType: fallbackAgentType };
  }
  return { agentType: candidate, task: match[2] ?? part };
}

function labelFrom(task: string, index: number): string {
  const cleaned = task.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 80) : `task-${index + 1}`;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function additionalSessionMetadata(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(objectValue(content.metadata) ?? {}),
    ...(objectValue(params.metadata) ?? {}),
  };
}

function inheritedResolvedWorkdirRoute(
  metadata: Record<string, unknown>,
): ResolvedWorkdirRoute | undefined {
  const route = objectValue(metadata.workdirRoute);
  if (!route) return undefined;
  const id = plainString(route.id);
  const workdir = plainString(route.workdir);
  if (!id || !workdir || !fs.existsSync(workdir)) return undefined;
  const instructions = plainString(route.instructions);
  const urlMappings = Array.isArray(route.urlMappings)
    ? route.urlMappings
        .map((entry) => {
          const record = objectValue(entry);
          const urlPrefix = plainString(record?.urlPrefix);
          const localPath = plainString(record?.localPath);
          if (!urlPrefix || !localPath) return undefined;
          return {
            urlPrefix,
            localPath,
            ...(record?.requireFresh === true ? { requireFresh: true } : {}),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    : undefined;
  return {
    id,
    workdir,
    ...(instructions ? { instructions } : {}),
    ...(urlMappings && urlMappings.length > 0 ? { urlMappings } : {}),
  };
}

function plainString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function connectorMessageIdFromMemory(
  message: Memory,
  content: Record<string, unknown>,
): string | undefined {
  const contentMetadata = objectValue(content.metadata);
  const messageMetadata = objectValue(message.metadata);
  const discordMetadata = objectValue(messageMetadata?.discord);
  return (
    plainString(contentMetadata?.originConnectorMessageId) ??
    plainString(contentMetadata?.replyToExternalMessageId) ??
    plainString(messageMetadata?.messageIdFull) ??
    plainString(messageMetadata?.discordMessageId) ??
    plainString(discordMetadata?.messageId)
  );
}

/**
 * The stable per-request root id used to key the per-origin spawn cap (#8875).
 * On the FIRST spawn it is the connector message id (Discord/connectors) or,
 * when none exists (dashboard/web), the user message id. SubAgentRouter stamps
 * this id back onto every synthetic re-spawn inbound as `spawnRootMessageId`,
 * so a request that re-spawns resolves the SAME id on EVERY transport. The
 * connector-less dashboard/web path falls back to the user message id, so the
 * per-origin cap fires there too. Kept as a pure exported fn so the record
 * (SubAgentRouter) and enforce (this action) sides can be proven to agree.
 */
export function spawnRootIdFor(
  message: Memory,
  content: Record<string, unknown>,
): string | undefined {
  return (
    connectorMessageIdFromMemory(message, content) ??
    plainString(objectValue(content.metadata)?.spawnRootMessageId) ??
    message.id
  );
}

/** `spawnRootIdFor` scoped to an agent type — the exact per-origin cap key.
 * `undefined` only when the inbound carries no id at all (the cap is skipped,
 * exactly as before). */
export function spawnOriginKeyFor(
  message: Memory,
  content: Record<string, unknown>,
  agentType: string,
): string | undefined {
  const root = spawnRootIdFor(message, content);
  return root ? `${root}\0${agentType}` : undefined;
}

function pickRoutingString(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  return (
    pickString(params, content, key) ??
    (typeof metadata[key] === "string"
      ? (metadata[key] as string).trim() || undefined
      : undefined)
  );
}

/**
 * Mint and ensure a DISTINCT task room so a task (and its swarm of sub-agents)
 * lives in its own room, separate from the originating chat room. Multiple
 * sub-agents spawned for the SAME task (i.e. resolved within a single spawn
 * action call, or by passing the parent's room id down to nested children)
 * share this room; different tasks get a different room. The origin (chat) room
 * is preserved separately on the swarm metadata so the supervisor can bridge
 * task status back to the human.
 *
 * Returns the existing room id when an explicit taskRoomId was provided (caller
 * intent wins: this is how nested child sub-agents JOIN their parent's task
 * room), otherwise a freshly created room id. Best-effort: when room creation
 * is unavailable (no createRoom / no resolvable world) or fails, falls back to
 * the origin room, which is the prior single-room behavior.
 *
 * Opt-out: `ELIZA_ORCHESTRATOR_TASK_ROOMS=0` keeps the legacy single-room
 * (origin == task room) behavior.
 */
async function ensureDistinctTaskRoom(
  runtime: IAgentRuntime,
  message: Memory,
  explicitTaskRoomId: string | undefined,
  label: string | undefined,
): Promise<string> {
  const originRoomId =
    typeof message.roomId === "string"
      ? message.roomId
      : String(message.roomId);
  // Caller intent wins: an explicit taskRoomId means "join THIS room" (e.g. a
  // nested child sub-agent joining the parent's swarm room), so never mint.
  if (explicitTaskRoomId?.trim()) {
    return explicitTaskRoomId.trim();
  }
  // Opt-out keeps the legacy single-room behavior (origin == task room).
  const taskRoomsEnabled =
    runtime.getSetting?.("ELIZA_ORCHESTRATOR_TASK_ROOMS") !== "0";
  if (!taskRoomsEnabled || typeof runtime.createRoom !== "function") {
    return originRoomId;
  }
  try {
    const seed = `task-${label?.trim() ?? ""}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const roomId = stringToUuid(seed);
    // createRoom needs a worldId. The API/chat context often has none, so fall
    // back to a stable per-agent "tasks" world to host all minted task rooms.
    let worldId =
      typeof message.worldId === "string"
        ? (message.worldId as UUID)
        : undefined;
    if (!worldId && typeof runtime.ensureWorldExists === "function") {
      worldId = stringToUuid(`orchestrator-tasks-world-${runtime.agentId}`);
      await runtime.ensureWorldExists({
        id: worldId,
        name: "Orchestrator Tasks",
        agentId: runtime.agentId,
        serverId: worldId,
      } as Parameters<typeof runtime.ensureWorldExists>[0]);
    }
    if (!worldId) {
      // No world available and none can be created, fall back to origin room.
      return originRoomId;
    }
    await runtime.createRoom({
      id: roomId,
      name: label?.trim() || `Task ${seed.slice(0, 18)}`,
      source: "orchestrator-task",
      type: ChannelType.GROUP,
      worldId,
    } as Room);
    return roomId;
  } catch (error) {
    coreLogger.warn(
      `[TASKS] distinct task room creation failed, using origin room: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return originRoomId;
  }
}

function buildSwarmRoomMetadata(
  message: Memory,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  metadata: Record<string, unknown>,
  resolvedTaskRoomId?: string,
): {
  originRoomId: unknown;
  taskRoomId: unknown;
  worktreeRoomId?: string;
  swarmRooms: Array<{ roomId: unknown; roles: string[] }>;
} {
  const taskRoomId =
    resolvedTaskRoomId ??
    pickRoutingString(params, content, metadata, "taskRoomId") ??
    pickRoutingString(params, content, metadata, "originRoomId") ??
    (typeof metadata.roomId === "string" ? metadata.roomId : undefined) ??
    message.roomId;
  const worktreeRoomId =
    pickRoutingString(params, content, metadata, "worktreeRoomId") ??
    pickRoutingString(params, content, metadata, "coordinationRoomId");
  const roomMap = new Map<string, { roomId: unknown; roles: string[] }>();
  const add = (roomId: unknown, role: string) => {
    if (typeof roomId !== "string" || !roomId.trim()) return;
    const key = roomId.trim();
    const current = roomMap.get(key) ?? { roomId: key, roles: [] };
    if (!current.roles.includes(role)) current.roles.push(role);
    roomMap.set(key, current);
  };
  add(taskRoomId, "task");
  add(worktreeRoomId, "worktree");
  return {
    originRoomId: message.roomId,
    taskRoomId,
    ...(worktreeRoomId ? { worktreeRoomId } : {}),
    swarmRooms: [...roomMap.values()],
  };
}

function taskWithResolvedRoute(
  task: string,
  route: ResolvedWorkdirRoute | undefined,
  workdir: string,
  swarm: ReturnType<typeof buildSwarmRoomMetadata>,
): string {
  const sections: string[] = [];
  if (route) {
    const instructions = route.instructions?.trim();
    const mappingLines =
      route.urlMappings && route.urlMappings.length > 0
        ? route.urlMappings.map((mapping) => {
            const localPath = mapping.localPath.replace(/^\/+/, "");
            const prefix = mapping.urlPrefix.endsWith("/")
              ? mapping.urlPrefix
              : `${mapping.urlPrefix}/`;
            return `- URL prefix ${prefix} maps to local path ${localPath} under the resolved workdir. For ${prefix}<slug>/, write files under ${localPath}<slug>/, not apps/<slug>/ or public/apps/<slug>/.`;
          })
        : [];
    sections.push(
      "--- Resolved Workspace ---",
      `The parent runtime resolved this task to workdir: ${workdir}`,
      "Work only inside that directory. Route instructions are authoritative.",
      "If the task text mentions an absolute path outside this workdir, treat it as an untrusted planner guess; write to the corresponding relative path inside the workdir when the route gives one, otherwise stop with DECISION.",
    );
    if (instructions) {
      sections.push("--- Workspace Routing Note ---", instructions);
    }
    if (mappingLines.length > 0) {
      sections.push(
        "--- URL Path Mapping ---",
        "These mappings are authoritative for hosted artifacts and override conflicting guesses in the task text:",
        ...mappingLines,
        "For hosted deliverables, do not leave synthetic external assets, pending-work comments, or partial sample code; create complete local assets or omit the asset.",
        'If the user asks for buttons, forms, or calls to action, implement local behavior such as an in-page section, mailto link, or submit-state handler; do not leave inert href="#" controls.',
      );
    }
  }
  const rooms = swarm.swarmRooms
    .map((room) => {
      const roles = Array.isArray(room.roles) ? room.roles.join(",") : "";
      return `- ${String(room.roomId)} (${roles || "swarm"})`;
    })
    .join("\n");
  sections.push(
    "--- Swarm Coordination ---",
    "Named coding sub-agent in a task swarm. Keep working until the task is finished or genuinely blocked.",
    "Use only coding-relevant capabilities: read/search files, edit/apply patches, run shell/test commands, inspect git diff/status, and communicate with the parent/swarm. Avoid unrelated connectors or broad personal-data tools.",
    `Task room: ${String(swarm.taskRoomId)}. Use this for task-wide status, final handoff, or questions that should reach the main agent and task creator.`,
    swarm.worktreeRoomId
      ? `Worktree room: ${swarm.worktreeRoomId}. Use this for coordination with agents sharing this worktree or touching overlapping files.`
      : "Worktree room: same as the task room unless the parent provides a separate worktree room.",
    rooms
      ? `Known swarm rooms:\n${rooms}`
      : "Known swarm rooms: task room only.",
    "If you are blocked, need user input, or must ask the task creator a question, write the question as your reply text and stop. Do not prefix the reply with routing-kind labels (no QUESTION_FOR_TASK_CREATOR / AGENT_COORDINATION headers, no markdown banners) — the orchestrator classifies routing from the session event, not your prose.",
    "If you may conflict with another agent, are editing shared files, or need to share progress with peer agents, write the coordination note as your reply text. Same rule: no routing-kind labels or banners in the text itself.",
    "When you finish, include what changed, tests run, remaining risks, and whether any peer coordination is still needed.",
    "--- User Task ---",
    task,
  );
  return sections.join("\n");
}

// Specialized (non-default) task types detectTaskType only returns for
// unambiguous build/deploy/view signals — a bare personal to-do never trips them.
const SPECIALIZED_CODING_TASK_TYPES: ReadonlySet<OrchestratorTaskType> =
  new Set(["view-create", "app-build", "deploy"]);

function looksLikePersonalLifeOpsTask(text: string): boolean {
  if (
    !/\b(?:add|create|make|open|save|set)\s+(?:an?\s+)?(?:to-?do|task|reminder|note)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  // A conversational "add a task to build/deploy a landing page/app/site/view" is
  // a coding request phrased as a to-do, not a personal-lifeops item. Reuse the
  // structural task classifier: it flags those unambiguous build/deploy/view
  // signals, so don't suppress the coding orchestrator for them. A generic
  // "add a task to buy milk" carries no such signal (detectTaskType → "coding"
  // default) and stays a suppressed lifeops item.
  return !SPECIALIZED_CODING_TASK_TYPES.has(detectTaskType(text));
}

// Durable variant of runPromptAndClose: drives the spawned session through the
// Smithers engine (a persisted, crash-resumable run) instead of a single direct
// prompt. Single-turn by default, so behaviour matches; enabled by default (see
// shouldUseSmithersTaskRunner). Emits the same session events as runPromptAndClose.
async function runPromptViaSmithers(
  service: ReturnType<typeof getAcpService> & {},
  session: SpawnResult,
  task: string,
  timeoutMs: number | undefined,
  model: string | undefined,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const { lastResponse } = await runDurableTask(service, session, task, {
      timeoutMs,
      model,
    });
    emitSessionEvent(service, session.sessionId, "task_complete", {
      response: lastResponse ?? "",
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    emitSessionEvent(service, session.sessionId, "error", {
      message: failureMessage(error),
    });
    throw error;
  } finally {
    try {
      await service.stopSession(session.sessionId);
    } finally {
      emitSessionEvent(service, session.sessionId, "stopped", {
        sessionId: session.sessionId,
      });
    }
  }
}

async function runPromptAndClose(
  service: ReturnType<typeof getAcpService> & {},
  session: SpawnResult,
  task: string,
  timeoutMs: number | undefined,
  model: string | undefined,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = service.sendPrompt
      ? await service.sendPrompt(session.sessionId, task, { timeoutMs, model })
      : await service.sendToSession(session.sessionId, task);
    if (result.error || result.stopReason === "error") {
      emitSessionEvent(service, session.sessionId, "error", {
        message: result.error ?? "acpx prompt ended with stopReason error",
        stopReason: result.stopReason,
      });
      throw new Error(result.error ?? "acpx prompt failed");
    }
    emitSessionEvent(service, session.sessionId, "task_complete", {
      response: result.finalText || result.response,
      durationMs: result.durationMs || Date.now() - startedAt,
      stopReason: result.stopReason,
    });
  } catch (error) {
    emitSessionEvent(service, session.sessionId, "error", {
      message: failureMessage(error),
    });
    throw error;
  } finally {
    try {
      await service.stopSession(session.sessionId);
    } finally {
      emitSessionEvent(service, session.sessionId, "stopped", {
        sessionId: session.sessionId,
      });
    }
  }
}

async function runCreate(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const service = getAcpService(runtime);
  if (!service) {
    const text =
      "ACP subprocess service is not available. Install acpx and ensure @elizaos/plugin-agent-orchestrator is loaded.";
    await callbackText(callback, text);
    return errorResult("SERVICE_UNAVAILABLE");
  }

  const text = messageText(message);
  // Genuine user request for workdir-route matching — see runSpawnAgent and
  // resolveOriginatingRequestText. Keeps routing planner-independent.
  const routingRequest = await resolveOriginatingRequestText(
    runtime,
    message,
    state,
  );
  const tasks = taskParts(params, content, text);
  if (tasks.length > MAX_CONCURRENT_AGENTS) {
    const msg = `Too many task agents requested (${tasks.length}); maximum is ${MAX_CONCURRENT_AGENTS}.`;
    await callbackText(callback, msg);
    return errorResult("TOO_MANY_AGENTS", msg);
  }

  // Backend routing (see resolveCodingBackend): explicit ask > character policy
  // > operator pin > planner guess. Per-task `framework:` prefixes (e.g.
  // "claude: do X") still override this per-part in the parseAgentPrefix step
  // below — they are the most explicit per-subtask signal.
  const routedBase = resolveCodingBackendLogged({
    runtime,
    explicit: pickString(params, content, "requestedBackend"),
    tag: pickString(params, content, "taskComplexity"),
    plannerGuess: pickString(params, content, "agentType"),
  });
  const baseAgentType =
    routedBase?.agentType ??
    String(
      (await service.resolveAgentType?.({
        task: tasks[0],
        subtaskCount: tasks.length,
      })) ?? "codex",
    );
  const explicitWorkdir = pickString(params, content, "workdir");
  const fallbackWorkdir = explicitWorkdir ?? process.cwd();
  const model = pickString(params, content, "model");
  const memoryContent = pickString(params, content, "memoryContent");
  const approvalPreset = parseApproval(
    pickString(params, content, "approvalPreset"),
  );
  const timeoutMs = getTimeoutMs(params, content);
  const baseLabel = pickString(params, content, "label");
  const extraMetadata = additionalSessionMetadata(params, content);
  const originConnectorMessageId = connectorMessageIdFromMemory(
    message,
    content,
  );
  // Resolve ONE distinct task room for this whole create call so every
  // sub-agent spawned for this task shares it (swarm collaboration); a
  // different task (a separate call) mints a different room. An explicit
  // taskRoomId or the opt-out env short-circuits the mint.
  const resolvedTaskRoomId = await ensureDistinctTaskRoom(
    runtime,
    message,
    pickRoutingString(params, content, extraMetadata, "taskRoomId"),
    baseLabel,
  );
  const swarmRoomMetadata = buildSwarmRoomMetadata(
    message,
    params,
    content,
    extraMetadata,
    resolvedTaskRoomId,
  );
  const settled = await Promise.allSettled(
    tasks.map(async (part, index) => {
      const parsed = parseAgentPrefix(part, baseAgentType);
      const task = parsed.task;
      const agentType = parsed.agentType as AgentType;
      const label = baseLabel ?? labelFrom(task, index);
      // A matching workdir route outranks a planner-guessed workdir; a
      // scaffold-aware caller opts out with lockWorkdir — see runSpawnAgent.
      const {
        workdir: sessionWorkdir,
        route,
        isolate: isolateWorkdir,
      } = resolveSpawnWorkdir(runtime, task, routingRequest, explicitWorkdir, {
        lockWorkdir: pickBoolean(params, content, "lockWorkdir") === true,
      });
      // This path spawns WITHOUT `initialTask` and delivers the task via
      // sendPrompt (smithers or direct), so the AcpService initialTask deploy
      // injection never fires here. Re-attach the contract on the task text
      // itself; the helper is gated + idempotent so non-app tasks pass through.
      const taskWithRouteHints = augmentTaskWithDeployGuidance(
        taskWithResolvedRoute(task, route, sessionWorkdir, swarmRoomMetadata),
        undefined,
        { monetized: pickBoolean(params, content, "appMonetized") === true },
      );
      const session = await service.spawnSession({
        agentType,
        workdir: sessionWorkdir,
        isolateWorkdir,
        memoryContent,
        approvalPreset,
        model,
        timeoutMs,
        metadata: {
          ...extraMetadata,
          ...(originConnectorMessageId ? { originConnectorMessageId } : {}),
          requestedType: baseAgentType,
          messageId: message.id,
          roomId: swarmRoomMetadata.taskRoomId,
          ...swarmRoomMetadata,
          worldId: message.worldId,
          userId: message.entityId,
          label,
          source: content.source,
          workdirRouteId: route?.id,
          workdirRoute: route,
        },
      });
      if (shouldUseSmithersTaskRunner()) {
        await runPromptViaSmithers(
          service,
          session,
          taskWithRouteHints,
          timeoutMs,
          model,
        );
      } else {
        await runPromptAndClose(
          service,
          session,
          taskWithRouteHints,
          timeoutMs,
          model,
        );
      }
      return { session, label, agentType, originalTask: taskWithRouteHints };
    }),
  );

  const results: Array<Record<string, unknown>> = [];
  const sessions: SpawnResult[] = [];
  // Parallel to `sessions`; carries the per-part context needed to attach a
  // successful spawn into the durable task thread minted below. Kept out of
  // SpawnResult so the ACP contract stays lean.
  const sessionAttachHints: Array<{ label: string; originalTask: string }> = [];
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") {
      const { session, label, originalTask } = outcome.value;
      sessions.push(session);
      sessionAttachHints.push({ label, originalTask });
      results.push({
        id: session.sessionId,
        sessionId: session.sessionId,
        agentType: session.agentType,
        name: session.name,
        workdir: session.workdir,
        label,
        status: "completed",
      });
      continue;
    }
    const part = tasks[index];
    const parsed = parseAgentPrefix(part, baseAgentType);
    const agentType = parsed.agentType as AgentType;
    const label = baseLabel ?? labelFrom(parsed.task, index);
    const msg = failureMessage(outcome.reason);
    logger(runtime).error(
      `TASKS:create launch failed: ${JSON.stringify({
        error: msg,
        agentType,
        workdir: fallbackWorkdir,
      })}`,
    );
    results.push({
      sessionId: "",
      id: "",
      agentType,
      workdir: fallbackWorkdir,
      label,
      status: "failed",
      error: msg,
    });
  }

  setCurrentSessions(state, sessions);
  const failed = results.filter((result) => result.status === "failed");
  if (failed.length > 0) {
    const textOut = `I started some task agents, but ${failed.length} failed to launch: ${failed.map((item) => String(item.error)).join("; ")}.`;
    await callbackText(callback, textOut);
    return {
      success: false,
      text: textOut,
      data: { agents: results, suppressActionResultClipboard: true },
    };
  }

  // Mint a durable orchestrator task thread so the chat surface can render
  // the `[TASK:<id>]<title>[/TASK]` widget that links back to the workbench.
  // The ACP sessions have already succeeded; a failure here is logged but
  // never demotes the action's success — the agents are still running.
  //
  // The ACP sessions spawned above via `service.spawnSession` are then
  // registered against the freshly-minted thread through the task service's
  // `attachSession` — without that, `resolveTaskId` never learns about them,
  // event routing drops their session events, and the widget reads `0/0
  // agents`. Per-session attach failures are logged but never demote the
  // action's success, same policy as thread-mint failure.
  const taskTitle =
    pickString(params, content, "title") ??
    pickString(params, content, "goal") ??
    (tasks[0] ? labelFrom(tasks[0], 0) : "Coding task");
  const taskGoal = pickString(params, content, "goal") ?? taskTitle;
  const taskPriority = (pickString(params, content, "priority") ?? "normal") as
    | "low"
    | "normal"
    | "high"
    | "urgent";
  const acceptanceCriteria = pickStringArrayFromInputs(
    params,
    content,
    "acceptanceCriteria",
  );
  const taskRoomId =
    typeof swarmRoomMetadata.taskRoomId === "string"
      ? swarmRoomMetadata.taskRoomId
      : undefined;
  // Preserve the ORIGIN (chat) room on the durable task's `roomId` so the
  // supervisor can bridge task status back to the human (getTaskOriginTarget),
  // while `taskRoomId` carries the DISTINCT swarm room the sub-agents share.
  // When task rooms are opted out, both resolve to the origin room (no change).
  const originRoomId =
    typeof swarmRoomMetadata.originRoomId === "string"
      ? swarmRoomMetadata.originRoomId
      : undefined;
  let threadId: string | null = null;
  const taskService = runtime.getService?.(
    OrchestratorTaskService.serviceType,
  ) as OrchestratorTaskService | null | undefined;
  try {
    if (taskService && typeof taskService.createTask === "function") {
      const detail = await taskService.createTask({
        title: taskTitle,
        goal: taskGoal,
        kind: "coding",
        priority: taskPriority,
        originalRequest: messageText(message),
        ...((originRoomId ?? taskRoomId)
          ? { roomId: originRoomId ?? taskRoomId }
          : {}),
        ...(taskRoomId ? { taskRoomId } : {}),
        acceptanceCriteria,
      });
      threadId = detail?.id ?? null;
    }
  } catch (error) {
    logger(runtime).warn(
      `[TASKS:create] durable task thread creation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    threadId = null;
  }

  // Bind every successfully spawned session to the freshly-minted thread so
  // the task widget / tasks panel sees them (sessionCount, latestSessionId,
  // token usage). Thread-mint-failed path skips this cleanly — no taskId to
  // attach against, and the sessions are still running / stopped independently.
  if (
    threadId &&
    taskService &&
    typeof taskService.attachSession === "function"
  ) {
    for (const [index, session] of sessions.entries()) {
      const hint = sessionAttachHints[index];
      try {
        // Every session that resolved fulfilled above was driven through
        // runPromptAndClose / runPromptViaSmithers, which stop it in their
        // `finally` before we reach here. So the `SpawnResult.status` captured
        // at spawn time is a stale `ready` snapshot — passing it would make
        // attachSession falsely promote the task to `active` and count a
        // finished single-turn session as live. Read the real post-run status
        // from the service instead; a fulfilled outcome always means the
        // session was stopped, so fall back to a terminal status if its record
        // is already gone.
        const refreshed = await service.getSession(session.sessionId);
        const effectiveStatus = refreshed?.status ?? "stopped";
        await taskService.attachSession(threadId, {
          sessionId: session.sessionId,
          agentType: session.agentType,
          workdir: session.workdir,
          status: effectiveStatus,
          ...(session.metadata ? { metadata: session.metadata } : {}),
          ...(hint?.label ? { label: hint.label } : {}),
          ...(hint?.originalTask ? { originalTask: hint.originalTask } : {}),
          ...(model ? { model } : {}),
        });
      } catch (error) {
        logger(runtime).warn(
          `[TASKS:create] attachSession failed for ${session.sessionId} on task ${threadId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const widgetBlock = threadId
    ? `\n\n[TASK:${threadId}]${taskTitle}[/TASK]`
    : "";
  const proseText = `Created task agent${results.length > 1 ? "s" : ""}.${widgetBlock}`;
  await callbackText(callback, proseText);

  return {
    success: true,
    text: proseText,
    data: {
      agents: results,
      taskId: threadId,
      suppressActionResultClipboard: true,
    },
  };
}

function pickStringArrayFromInputs(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  name: string,
): string[] {
  const raw = params[name] ?? content[name];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// ── action: spawn_agent (SPAWN_AGENT) ───────────────────────────────────────

/** Minimal view of SubAgentRouter's per-origin spawn-cap surface. Read via the
 *  ACPX_SUB_AGENT_ROUTER service id; a structural type (rather than importing
 *  the concrete SubAgentRouter class) keeps this action module from importing
 *  the router — the two are already wired together only by the index.ts barrel. */
type SpawnCapRouter = {
  spawnCountForOrigin(originKey: string): number;
  noteSpawnForOrigin(originKey: string): void;
  bestResultFor(
    originKey: string,
  ): { text: string; deliverable?: string } | undefined;
};

/** getService is loosely typed and (in test doubles) can resolve a service that
 *  isn't the SubAgentRouter; verify the cap API exists before calling it. */
function isSpawnCapRouter(service: unknown): service is SpawnCapRouter {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as SpawnCapRouter).spawnCountForOrigin === "function" &&
    typeof (service as SpawnCapRouter).noteSpawnForOrigin === "function" &&
    typeof (service as SpawnCapRouter).bestResultFor === "function"
  );
}

/** Max sub-agent spawns per root user message before the orchestrator relays
 *  the best already-captured result instead of re-spawning — bounds the
 *  weak-model re-spawn loop. Default 3 (a legitimate spawn + a retry or two);
 *  override with ELIZA_MAX_SPAWNS_PER_ORIGIN. */
function maxSpawnsPerOrigin(runtime: IAgentRuntime): number {
  const raw =
    runtime.getSetting?.("ELIZA_MAX_SPAWNS_PER_ORIGIN") ??
    process.env.ELIZA_MAX_SPAWNS_PER_ORIGIN;
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

async function runSpawnAgent(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const service = getAcpService(runtime);
  if (!service) {
    const text = "ACP service is not available. Cannot spawn a task agent.";
    await callbackText(callback, text);
    return errorResult("SERVICE_UNAVAILABLE");
  }

  try {
    const text = messageText(message);
    const task = pickString(params, content, "task") ?? text;
    // Route matching must see the genuine user request, not the planner's
    // (possibly terse) rephrasing or an empty content.text. Without this, a
    // request like "build me a … web page" routes correctly under a verbose
    // planner but falls back to the default ACP workspace under a terser one.
    // `state` carries the runtime-composed conversation window, which holds
    // the real request synchronously even when content.text is empty.
    const routingRequest = await resolveOriginatingRequestText(
      runtime,
      message,
      state,
    );
    // Backend routing (see resolveCodingBackend): an explicit user ask wins,
    // then declared `character.routing.coding` policy, then the operator pin
    // (ELIZA_ACP_DEFAULT_AGENT), then the planner's heuristic `agentType` guess.
    // The pin does not unconditionally override: declared character routing or
    // an explicitly named backend takes precedence over it, while a bare
    // planner guess sits below the pin (it routinely guesses from context tokens).
    const routed = resolveCodingBackendLogged({
      runtime,
      explicit: pickString(params, content, "requestedBackend"),
      tag: pickString(params, content, "taskComplexity"),
      plannerGuess: pickString(params, content, "agentType"),
    });
    const agentType = (routed?.agentType ??
      (await service.resolveAgentType?.({
        task,
        workdir: pickString(params, content, "workdir"),
      })) ??
      "codex") as AgentType;
    // Resolve the spawn workdir. A matching `TASK_AGENT_WORKDIR_ROUTES`
    // route outranks the planner-supplied workdir — the planner just
    // guesses a path-shaped string from context, while a route is
    // deliberate operator policy. A scaffold-aware caller that KNOWS its
    // workdir is correct (e.g. APP_CREATE) passes `lockWorkdir: true` to
    // skip route resolution entirely.
    const {
      workdir,
      route,
      isolate: resolvedIsolate,
    } = resolveSpawnWorkdir(
      runtime,
      task,
      routingRequest,
      pickString(params, content, "workdir"),
      { lockWorkdir: pickBoolean(params, content, "lockWorkdir") === true },
    );
    const memoryContent = pickString(params, content, "memoryContent");
    const approvalPreset = parseApproval(
      pickString(params, content, "approvalPreset"),
    );
    const keepAliveAfterComplete = pickBoolean(
      params,
      content,
      "keepAliveAfterComplete",
    );
    const extraMetadata = additionalSessionMetadata(params, content);
    // Structural only: the planner emits deferUserReply when the user asked for
    // no interim reply. No regex over the task text (the model judges intent).
    const deferUserReply =
      pickBoolean(params, content, "deferUserReply") === true;
    const label = pickString(params, content, "label") ?? task.slice(0, 80);
    const originConnectorMessageId = connectorMessageIdFromMemory(
      message,
      content,
    );
    // Nested/child sub-agents JOIN the parent's task room when an explicit
    // taskRoomId is supplied (swarm collaboration on the same task); only a
    // brand-new task with no explicit room mints its own distinct room. The
    // opt-out env keeps origin == task room.
    const resolvedTaskRoomId = await ensureDistinctTaskRoom(
      runtime,
      message,
      pickRoutingString(params, content, extraMetadata, "taskRoomId"),
      label,
    );
    const swarmRoomMetadata = buildSwarmRoomMetadata(
      message,
      params,
      content,
      extraMetadata,
      resolvedTaskRoomId,
    );
    const inheritedRoute =
      content.source === MESSAGE_SOURCE_SUB_AGENT &&
      extraMetadata.subAgent === true
        ? inheritedResolvedWorkdirRoute(extraMetadata)
        : undefined;
    const effectiveRoute = route ?? inheritedRoute;
    const effectiveWorkdir = effectiveRoute?.workdir ?? workdir;
    // Only isolate per-session when we fell back to a shared scratch root (no
    // route). A route resolves to a specific project dir that must be used as-is.
    const isolateWorkdir = effectiveRoute ? false : resolvedIsolate === true;
    const taskWithRouteHints = taskWithResolvedRoute(
      task,
      effectiveRoute,
      effectiveWorkdir,
      swarmRoomMetadata,
    );

    // Resolve the connector source for routing the sub-agent's eventual
    // reply back to the user. For messages that originated on a platform
    // (discord etc.) content.source is the platform name. For messages
    // SYNTHESIZED by SubAgentRouter (a previous sub-agent's task_complete
    // routed back into the runtime so the planner could decide to reply or
    // re-delegate), content.source is the router's marker string and
    // `runtime.sendMessageToTarget` has no handler for it. Unwrap one
    // level by reading the upstream `originSource` the router stamps onto
    // its synthetic inbound's metadata, so nested spawns inherit the
    // real user-facing platform.
    const inboundOriginSource =
      typeof content.metadata === "object" &&
      content.metadata !== null &&
      typeof (content.metadata as Record<string, unknown>).originSource ===
        "string"
        ? ((content.metadata as Record<string, unknown>).originSource as string)
        : undefined;
    const resolvedSpawnSource =
      content.source === MESSAGE_SOURCE_SUB_AGENT && inboundOriginSource
        ? inboundOriginSource
        : content.source;

    // Per-root-origin spawn cap. A weak coding model that returns a truncated or
    // blocked completion makes the planner re-issue TASKS_SPAWN_AGENT for the
    // SAME user request across turns (the router re-injects each completion, so
    // `continueChain:false` below only stops intra-turn dups — observed live:
    // 70 spawns for one request → ack+answer Discord spam). Once we've spawned
    // the cap of sub-agents for this connector message + agent type, stop
    // re-spawning and relay the best already-captured result instead.
    // Only treat the resolved service as a spawn-cap router when it actually
    // exposes the cap API (calling a missing method would throw and abort the
    // spawn — test doubles return one mock for every service id).
    const spawnCapRouterService = runtime.getService?.("ACPX_SUB_AGENT_ROUTER");
    const spawnCapRouter = isSpawnCapRouter(spawnCapRouterService)
      ? spawnCapRouterService
      : undefined;
    // The stable per-request root id + cap key (see spawnRootIdFor). Anchored to
    // ONE user request across the whole re-spawn loop on EVERY transport,
    // closing the dashboard/web no-op where `originConnectorMessageId` is absent
    // and the cap silently never fired (#8875).
    const spawnRootMessageId = spawnRootIdFor(message, content);
    const spawnOriginKey = spawnOriginKeyFor(message, content, agentType);
    if (spawnCapRouter && spawnOriginKey) {
      const cap = maxSpawnsPerOrigin(runtime);
      if (spawnCapRouter.spawnCountForOrigin(spawnOriginKey) >= cap) {
        const best = spawnCapRouter.bestResultFor(spawnOriginKey);
        // Relay the captured deliverable when we have one (the router records
        // it before its early returns too). Only when there is genuinely no
        // result do we fall back — and then be HONEST that we hit the attempt
        // cap rather than implying it's still in progress ("still working"),
        // which conflates capped-and-failed with in-flight.
        const replyText =
          (best?.deliverable ?? best?.text ?? "").trim() ||
          `I attempted this task ${cap} times but couldn't complete it. Try giving me more specific instructions, or breaking it into smaller steps.`;
        logger(runtime).warn(
          `[TASKS:spawn_agent] per-origin spawn cap (${cap}) reached for ${spawnOriginKey}; relaying best result instead of re-spawning`,
        );
        await callbackText(callback, replyText);
        return {
          success: true,
          text: replyText,
          continueChain: false,
          data: { actionName: "TASKS", spawnCapped: true },
        };
      }
    }

    // Concurrency gate: serialise spawns past a small ceiling so parallel
    // coding sub-agents don't stampede the model provider into rate-limited,
    // tool-call-skipping degradation. See waitForSpawnSlot.
    await waitForSpawnSlot(runtime, service);

    const session = await service.spawnSession({
      agentType,
      workdir: effectiveWorkdir,
      isolateWorkdir,
      initialTask: taskWithRouteHints,
      monetized: pickBoolean(params, content, "appMonetized") === true,
      memoryContent,
      approvalPreset,
      metadata: {
        ...extraMetadata,
        ...(originConnectorMessageId ? { originConnectorMessageId } : {}),
        // Persist the stable root id so SubAgentRouter re-stamps it onto the
        // next synthetic re-spawn inbound (keeping the per-origin spawn cap
        // anchored to ONE user request across the whole loop, on every
        // transport — including connector-less dashboard/web). (#8875)
        ...(spawnRootMessageId ? { spawnRootMessageId } : {}),
        requestedType: agentType,
        messageId: message.id,
        roomId: swarmRoomMetadata.taskRoomId,
        ...swarmRoomMetadata,
        worldId: message.worldId,
        userId: message.entityId,
        label,
        source: resolvedSpawnSource,
        keepAliveAfterComplete,
        workdirRouteId: effectiveRoute?.id,
        workdirRoute: effectiveRoute,
        // Stash the resolved task so SubAgentRouter can re-dispatch the
        // sub-agent on a failed verification without reconstructing it.
        // SessionInfo itself doesn't carry initialTask; metadata does.
        initialTask: taskWithRouteHints,
      },
    });

    setCurrentSession(state, session);
    if (spawnCapRouter && spawnOriginKey) {
      spawnCapRouter.noteSpawnForOrigin(spawnOriginKey);
    }
    logger(runtime).info(
      `Spawned acpx task agent: ${JSON.stringify({
        sessionId: session.sessionId,
        agentType: session.agentType,
        workdir: session.workdir,
      })}`,
    );

    // No text ack here. The orchestrator's progress hook owns user-visible
    // status updates; emitting "On it" duplicates that and (worse) surfaces
    // the planner's hallucinated messageToUser via the bootstrap REPLY path.
    return {
      success: true,
      text: "",
      // Terminate the planner loop after the first spawn fires.
      //
      // TASKS_SPAWN_AGENT is fire-and-forget: the action returns the
      // instant the PTY starts, while the sub-agent's actual work runs
      // asynchronously over the next 5-60+ seconds. The planner loop,
      // not seeing a "completed" signal in the immediate result, calls
      // the planner again and the planner re-emits another
      // TASKS_SPAWN_AGENT for the same task. We've observed up to 5
      // duplicate spawns per Discord message, which (a) burns through
      // the 8-slot concurrent-session pool inside a single turn, (b)
      // costs 5x more Cerebras tokens, and (c) wastes opencode CPU
      // running the same task in parallel.
      //
      // `continueChain: false` is the planner-loop's terminal flag —
      // setting it here makes the spawn act as a "the request has
      // been dispatched, end the turn" signal. The orchestrator's
      // separate task-event channel reports completion subsequent when the
      // sub-agent actually finishes (or fails). This matches how
      // sendDraft / respondToMessage already mark themselves terminal.
      continueChain: false,
      data: {
        sessionId: session.sessionId,
        agentType: session.agentType,
        workdir: session.workdir,
        status: session.status,
        label,
        deferredUserReply: deferUserReply,
        suppressActionResultClipboard: true,
      },
    };
  } catch (error) {
    const messageTextValue = failureMessage(error);
    const code = isAuthError(error) ? "INVALID_CREDENTIALS" : messageTextValue;
    await callbackText(
      callback,
      isAuthError(error)
        ? "Invalid credentials for task agent."
        : `Failed to spawn agent: ${messageTextValue}`,
    );
    return { success: false, error: code, continueChain: false };
  }
}

// ── action: send (SEND_TO_AGENT) ────────────────────────────────────────────

async function runSend(
  runtime: IAgentRuntime,
  _message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const service = getAcpService(runtime);
  if (!service) {
    await callbackText(callback, "ACP service is not available.");
    return errorResult("SERVICE_UNAVAILABLE");
  }

  try {
    const routedCompletion = routedSubAgentCompletion(content);
    const sessionId =
      pickString(params, content, "sessionId") ?? routedCompletion?.sessionId;
    const input = pickString(params, content, "input");
    const task = pickString(params, content, "task");
    const keys = pickString(params, content, "keys");
    const target = await resolveSession(service, sessionId, state);

    if (!target.session) {
      if (target.missingId) {
        const text = `Session ${target.missingId} not found.`;
        await callbackText(callback, text);
        return errorResult("SESSION_NOT_FOUND");
      }
      await callbackText(
        callback,
        "No active task-agent sessions. Spawn an agent first.",
      );
      return errorResult("NO_SESSION");
    }

    if (keys) {
      await service.sendKeysToSession(target.session.id, keys);
      await callbackText(callback, "Sent key sequence");
      return {
        success: true,
        text: "Sent key sequence",
        data: { sessionId: target.session.id, keys },
      };
    }

    const plannerInput = input ?? task;
    const textInput = routedCompletion
      ? buildSubAgentCompletionFollowUp(routedCompletion, plannerInput)
      : plannerInput;
    if (textInput) {
      await service.sendToSession(target.session.id, textInput);
      const text = task ? "Assigned new task to agent" : "Sent input to agent";
      await callbackText(callback, text);
      return {
        success: true,
        text,
        data: {
          sessionId: target.session.id,
          input: textInput,
          ...(task ? { task } : {}),
        },
      };
    }

    await callbackText(
      callback,
      "No input provided. Specify 'input', 'task', or 'keys' parameter.",
    );
    return errorResult("NO_INPUT");
  } catch (error) {
    const msg = failureMessage(error);
    await callbackText(callback, `Failed to send to agent: ${msg}`);
    return { success: false, error: msg };
  }
}

function routedSubAgentCompletion(
  content: Record<string, unknown>,
): { completionText: string; sessionId: string } | undefined {
  if (content.source !== MESSAGE_SOURCE_SUB_AGENT) return undefined;
  const metadata =
    content.metadata !== null && typeof content.metadata === "object"
      ? (content.metadata as Record<string, unknown>)
      : undefined;
  if (
    metadata?.subAgent !== true ||
    textValue(metadata.subAgentEvent) !== "task_complete"
  ) {
    return undefined;
  }
  const sessionId = textValue(metadata.subAgentSessionId);
  if (!sessionId) return undefined;
  return {
    sessionId,
    completionText: textValue(content.text) ?? "",
  };
}

function buildSubAgentCompletionFollowUp(
  completion: { completionText: string; sessionId: string },
  plannerInput: string | undefined,
): string {
  const parts = [
    "Continue the original task in this same sub-agent session.",
    "Your previous completion was incomplete or mostly raw tool output. Do not ask the user for command output, and do not just restate the partial result.",
  ];
  if (plannerInput) {
    parts.push(`Parent follow-up:\n${plannerInput}`);
  }
  if (completion.completionText) {
    parts.push(`Previous completion:\n${completion.completionText}`);
  }
  parts.push(
    "Run any additional commands needed, then return one complete user-facing answer that satisfies the original request.",
  );
  return parts.join("\n\n");
}

// ── action: stop_agent (STOP_AGENT) ─────────────────────────────────────────

async function runStopAgent(
  runtime: IAgentRuntime,
  _message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const service = getAcpService(runtime);
  if (!service) {
    await callbackText(callback, "ACP service is not available.");
    return errorResult("SERVICE_UNAVAILABLE");
  }

  try {
    const all = pickBoolean(params, content, "all") ?? false;
    const sessions = await Promise.resolve(service.listSessions());

    if (all) {
      await Promise.all(
        sessions.map((session) => service.stopSession(session.id)),
      );
      if (state)
        (
          state as {
            codingSession?: unknown;
            codingSessions?: unknown;
          }
        ).codingSession = undefined;
      if (state) (state as { codingSessions?: unknown }).codingSessions = [];
      const text = `Stopped ${sessions.length} sessions`;
      await callbackText(callback, text);
      return { success: true, text, data: { stoppedCount: sessions.length } };
    }

    const requestedId =
      pickString(params, content, "sessionId") ??
      (state as { codingSession?: { id?: string } } | undefined)?.codingSession
        ?.id;
    const target = requestedId
      ? await Promise.resolve(service.getSession(requestedId))
      : newestSession(sessions);

    if (!target) {
      if (requestedId) {
        const text = `Session ${requestedId} not found.`;
        await callbackText(callback, text);
        return errorResult("SESSION_NOT_FOUND");
      }
      await callbackText(callback, "No sessions to stop");
      return { success: true, text: "No sessions to stop" };
    }

    await service.stopSession(target.id);
    if (
      (state as { codingSession?: { id?: string } } | undefined)?.codingSession
        ?.id === target.id
    ) {
      (state as { codingSession?: unknown }).codingSession = undefined;
    }
    await callbackText(callback, `Stopped task-agent session ${target.id}.`);
    return {
      success: true,
      text: `Stopped session ${target.id}`,
      data: { sessionId: target.id, agentType: String(target.agentType) },
    };
  } catch (error) {
    const msg = failureMessage(error);
    await callbackText(callback, `Failed to stop agent: ${msg}`);
    return { success: false, error: msg };
  }
}

// ── action: list_agents (LIST_AGENTS) ───────────────────────────────────────

function dateString(value: Date | string | number): string {
  return new Date(value).toISOString();
}

async function runListAgents(
  runtime: IAgentRuntime,
  _message: Memory,
  _state: State | undefined,
  _params: Record<string, unknown>,
  _content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const service = getAcpService(runtime);
  if (!service) {
    await callbackText(callback, "ACP service is not available.");
    return errorResult("SERVICE_UNAVAILABLE");
  }

  const sessions = await listSessionsWithin(service, 2000);
  const preferredTaskAgent = {
    id: String((await service.resolveAgentType?.({})) ?? "codex"),
    reason: "acpx default agent",
  };
  const tasks: Array<Record<string, unknown>> = [];
  const pendingConfirmations = 0;

  if (sessions.length === 0) {
    const text =
      'No active task agents. Use TASKS { action: "create" } when the user needs anything more involved than a simple direct reply.';
    await callbackText(callback, text);
    return {
      success: true,
      text,
      data: { sessions: [], tasks, pendingConfirmations, preferredTaskAgent },
    };
  }

  const lines = [`Active task agents (${sessions.length}):`];
  for (const session of sessions) {
    lines.push(
      `- ${labelFor(session)} [${shortId(session.id)}] ${session.agentType} ${session.status} in ${session.workdir}`,
    );
  }
  const text = lines.join("\n");
  await callbackText(callback, text);

  return {
    success: true,
    text,
    data: {
      sessions: sessions.map((session) => ({
        id: session.id,
        agentType: String(session.agentType),
        status: String(session.status),
        workdir: session.workdir,
        createdAt: dateString(session.createdAt),
        lastActivity: dateString(session.lastActivityAt),
        label: labelFor(session),
      })),
      tasks,
      pendingConfirmations,
      preferredTaskAgent,
    },
  };
}

// ── action: cancel (CANCEL_TASK) ────────────────────────────────────────────

async function runCancel(
  runtime: IAgentRuntime,
  _message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const service = getAcpService(runtime);
  if (!service) {
    await callbackText(callback, "ACP service is not available.");
    return errorResult("SERVICE_UNAVAILABLE");
  }

  try {
    const all = pickBoolean(params, content, "all") ?? false;
    const threadId = pickString(params, content, "threadId");
    const sessionId =
      pickString(params, content, "sessionId") ??
      (state as { codingSession?: { id?: string } } | undefined)?.codingSession
        ?.id;
    const search = pickString(params, content, "search")?.toLowerCase();
    const sessions = await Promise.resolve(service.listSessions());

    if (all) {
      const stoppedSessions: string[] = [];
      for (const session of sessions) {
        await (service.cancelSession?.(session.id) ??
          service.stopSession(session.id));
        stoppedSessions.push(session.id);
      }
      const text = `Canceled ${stoppedSessions.length} task(s).`;
      await callbackText(callback, text);
      return {
        success: true,
        text,
        data: { canceledCount: stoppedSessions.length, stoppedSessions },
      };
    }

    const target = sessionId
      ? await Promise.resolve(service.getSession(sessionId))
      : search
        ? sessions.find((session) =>
            `${session.id} ${session.name ?? ""} ${session.metadata?.label ?? ""}`
              .toLowerCase()
              .includes(search),
          )
        : newestSession(sessions);

    if (!target) {
      const code = sessionId ? "SESSION_NOT_FOUND" : "TASK_NOT_FOUND";
      const text = sessionId
        ? `Session ${sessionId} not found.`
        : "No matching task found.";
      await callbackText(callback, text);
      return errorResult(code);
    }

    await (service.cancelSession?.(target.id) ??
      service.stopSession(target.id));
    const id = threadId ?? target.id;
    const text = `Canceled task ${id}`;
    await callbackText(callback, text);
    return {
      success: true,
      text,
      data: {
        ...(threadId ? { threadId } : {}),
        sessionId: target.id,
        stoppedSessions: [target.id],
        status: "canceled",
      },
    };
  } catch (error) {
    const msg = failureMessage(error);
    await callbackText(callback, `Failed to cancel task: ${msg}`);
    return { success: false, error: msg };
  }
}

// ── action: history (TASK_HISTORY) ──────────────────────────────────────────

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function inferMetric(text: string, value?: string): HistoryMetric {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "count" ||
    normalized === "detail" ||
    normalized === "list"
  ) {
    return normalized;
  }
  if (/\bhow many\b|\bcount\b/i.test(text)) return "count";
  if (/\bdetail\b|\bdetails\b|\bmost recent\b|\blatest\b/i.test(text)) {
    return "detail";
  }
  if (/\bshow me\b|\bgive me\b|\blist\b|\bwhat are\b/i.test(text))
    return "list";
  return "list";
}

function historyWindowValue(value: unknown): HistoryWindow | undefined {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : undefined;
  if (
    normalized === "active" ||
    normalized === "today" ||
    normalized === "yesterday" ||
    normalized === "last_7_days" ||
    normalized === "last_30_days"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeHistoryStatus(
  value: string,
): OrchestratorTaskStatus | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (normalized === "all") return undefined;
  if (normalized === "complete" || normalized === "completed") return "done";
  if (
    normalized === "error" ||
    normalized === "errored" ||
    normalized === "failure"
  ) {
    return "failed";
  }
  if (normalized === "paused" || normalized === "interrupted") {
    return "interrupted";
  }
  if (TASK_HISTORY_STATUSES.has(normalized as OrchestratorTaskStatus)) {
    return normalized as OrchestratorTaskStatus;
  }
  return undefined;
}

function historyStatusesValue(value: unknown): OrchestratorTaskStatus[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const statuses = new Set<OrchestratorTaskStatus>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const status = normalizeHistoryStatus(item);
    if (status) statuses.add(status);
  }
  return Array.from(statuses);
}

function buildWindowFilters(window: HistoryWindow | undefined): {
  latestActivityAfter?: number;
  latestActivityBefore?: number;
  statuses?: ReadonlySet<OrchestratorTaskStatus>;
  label?: string;
} {
  const now = new Date();
  if (window === "active") {
    return {
      statuses: ACTIVE_TASK_HISTORY_STATUSES,
      label: "active tasks right now",
    };
  }
  if (window === "today") {
    const start = startOfDay(now);
    const end = endOfDay(now);
    return {
      latestActivityAfter: start.getTime(),
      latestActivityBefore: end.getTime(),
      label: `${formatDate(start)} through ${formatDate(end)}`,
    };
  }
  if (window === "yesterday") {
    const start = startOfDay(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const end = endOfDay(start);
    return {
      latestActivityAfter: start.getTime(),
      latestActivityBefore: end.getTime(),
      label: `${formatDate(start)} through ${formatDate(end)}`,
    };
  }
  if (window === "last_7_days") {
    const start = startOfDay(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
    return {
      latestActivityAfter: start.getTime(),
      latestActivityBefore: now.getTime(),
      label: `${formatDate(start)} through ${formatDate(now)}`,
    };
  }
  if (window === "last_30_days") {
    const start = startOfDay(
      new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000),
    );
    return {
      latestActivityAfter: start.getTime(),
      latestActivityBefore: now.getTime(),
      label: `${formatDate(start)} through ${formatDate(now)}`,
    };
  }
  return {};
}

function renderThreadLine(entry: TaskThreadDto): string {
  const activity =
    typeof entry.latestActivityAt === "number"
      ? dateString(entry.latestActivityAt)
      : "unknown time";
  const session = entry.latestSessionLabel
    ? ` via ${entry.latestSessionLabel}`
    : entry.latestSessionId
      ? ` via ${entry.latestSessionId}`
      : "";
  return `- ${entry.title} [${entry.status}] (${activity})${session}${entry.summary ? `: ${entry.summary}` : ""}`;
}

function taskMatchesHistoryFilters(
  task: TaskThreadDto,
  statuses: readonly OrchestratorTaskStatus[],
  windowFilters: ReturnType<typeof buildWindowFilters>,
  search: string | undefined,
): boolean {
  if (statuses.length > 0 && !statuses.includes(task.status)) return false;
  if (windowFilters.statuses && !windowFilters.statuses.has(task.status)) {
    return false;
  }
  if (search && !taskMatchesSearch(task, search)) return false;
  const latest = task.latestActivityAt ?? Date.parse(task.updatedAt);
  if (windowFilters.latestActivityAfter !== undefined) {
    if (
      !Number.isFinite(latest) ||
      latest < windowFilters.latestActivityAfter
    ) {
      return false;
    }
  }
  if (windowFilters.latestActivityBefore !== undefined) {
    if (
      !Number.isFinite(latest) ||
      latest > windowFilters.latestActivityBefore
    ) {
      return false;
    }
  }
  return true;
}

function taskMatchesSearch(task: TaskThreadDto, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    task.id,
    task.title,
    task.originalRequest,
    task.summary,
    task.latestSessionId,
    task.latestSessionLabel,
    task.latestWorkdir,
    task.latestRepo,
    task.kind,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function sessionMatchesHistoryFilters(
  session: SessionInfo,
  statuses: readonly OrchestratorTaskStatus[],
  windowFilters: ReturnType<typeof buildWindowFilters>,
  search: string | undefined,
): boolean {
  if (
    statuses.length > 0 &&
    !statuses.some((status) => sessionMatchesTaskStatus(session.status, status))
  ) {
    return false;
  }
  if (
    windowFilters.statuses &&
    !Array.from(windowFilters.statuses).some((status) =>
      sessionMatchesTaskStatus(session.status, status),
    )
  ) {
    return false;
  }
  if (search) {
    const haystack =
      `${session.id} ${session.name ?? ""} ${session.metadata?.label ?? ""} ${session.agentType} ${session.workdir}`.toLowerCase();
    if (!haystack.includes(search.toLowerCase())) return false;
  }
  const latest = session.lastActivityAt.getTime();
  if (windowFilters.latestActivityAfter !== undefined) {
    if (latest < windowFilters.latestActivityAfter) return false;
  }
  if (windowFilters.latestActivityBefore !== undefined) {
    if (latest > windowFilters.latestActivityBefore) return false;
  }
  return true;
}

function sessionMatchesTaskStatus(
  sessionStatus: string,
  taskStatus: OrchestratorTaskStatus,
): boolean {
  const status = sessionStatus.toLowerCase();
  if (taskStatus === "active" || taskStatus === "open") {
    return !TERMINAL_SESSION_STATUSES.has(status);
  }
  if (taskStatus === "blocked") return status === "blocked";
  if (taskStatus === "done") {
    return status === "completed" || status === "stopped";
  }
  if (taskStatus === "failed")
    return status === "error" || status === "errored";
  if (taskStatus === "interrupted") return status === "cancelled";
  return status === taskStatus;
}

function failureResult(
  actionName: string,
  error: string,
  text: string,
  data: Record<string, unknown> = {},
): ActionResult {
  return {
    success: false,
    error,
    text,
    data: {
      actionName,
      ...data,
    },
  };
}

async function runHistory(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const access = await requireTaskAgentAccess(runtime, message, "interact");
  if (!access.allowed) {
    const reason = (access as { reason: string }).reason;
    if (callback) await callback({ text: reason });
    return failureResult("TASKS:history", "FORBIDDEN", reason, {
      reason: "access_denied",
    });
  }

  const text = typeof content.text === "string" ? content.text : "";
  const metric = inferMetric(
    text,
    textValue(params.metric) ?? textValue(content.metric),
  );
  const limitRaw = Number(
    params.limit ?? content.limit ?? (metric === "detail" ? 1 : 10),
  );
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : 10;
  const window = historyWindowValue(params.window ?? content.window);
  const statuses = historyStatusesValue(params.statuses ?? content.statuses);
  const search = textValue(params.search) ?? textValue(content.search);
  const includeArchived =
    pickBoolean(params, content, "includeArchived") ?? false;
  const windowFilters = buildWindowFilters(window);
  const taskService = runtime.getService?.(
    OrchestratorTaskService.serviceType,
  ) as OrchestratorTaskService | null | undefined;
  if (taskService && typeof taskService.listTasks === "function") {
    try {
      const allTasks = (
        await taskService.listTasks({
          includeArchived,
          ...(search ? { search } : {}),
        })
      ).filter((task) =>
        taskMatchesHistoryFilters(task, statuses, windowFilters, search),
      );
      const count = allTasks.length;
      const tasks = allTasks.slice(0, limit);
      const filterParts = [
        windowFilters.label ? `window ${windowFilters.label}` : undefined,
        statuses.length > 0 ? `statuses ${statuses.join(", ")}` : undefined,
        search ? `search "${search}"` : undefined,
        includeArchived ? "including archived" : undefined,
      ].filter((part): part is string => Boolean(part));
      const filterSuffix =
        filterParts.length > 0 ? ` matching ${filterParts.join("; ")}` : "";

      let responseText = "";
      if (metric === "count") {
        responseText = `I found ${count} orchestrator task${count === 1 ? "" : "s"}${filterSuffix}.`;
      } else if (tasks.length === 0) {
        responseText = `I did not find any orchestrator task threads${filterSuffix}.`;
      } else if (metric === "detail") {
        const task = tasks[0];
        responseText = [
          `The most recent orchestrator task is "${task.title}" [${task.status}].`,
          `Task id: ${task.id}`,
          `Latest session: ${task.latestSessionLabel ?? task.latestSessionId ?? "none"}`,
          `Workspace: ${task.latestWorkdir ?? "none"}`,
          `Latest activity: ${task.latestActivityAt ? dateString(task.latestActivityAt) : "unknown"}`,
          task.summary ? `Summary: ${task.summary}` : undefined,
        ]
          .filter(Boolean)
          .join("\n");
      } else {
        responseText = [
          `I found ${count} orchestrator task${count === 1 ? "" : "s"}${filterSuffix}.`,
          ...tasks.map(renderThreadLine),
        ].join("\n");
      }

      if (callback) await callback({ text: responseText });
      return {
        success: true,
        text: responseText,
        data: {
          actionName: "TASKS:history",
          count,
          taskIds: tasks.map((task) => task.id),
          filters: {
            metric,
            ...(window ? { window } : {}),
            ...(statuses.length > 0 ? { statuses } : {}),
            ...(search ? { search } : {}),
            includeArchived,
            limit,
          },
        },
      };
    } catch (error) {
      const msg = failureMessage(error);
      if (callback)
        await callback({ text: `Failed to read task history: ${msg}` });
      return failureResult("TASKS:history", "TASK_HISTORY_FAILED", msg);
    }
  }

  const service = getAcpService(runtime);
  if (!service) {
    const msg = "ACP service is not available.";
    if (callback) await callback({ text: msg });
    return failureResult("TASKS:history", "SERVICE_UNAVAILABLE", msg, {
      reason: "acp_unavailable",
    });
  }
  const sessions = (await listSessionsWithin(service, 2000))
    .filter((session) =>
      sessionMatchesHistoryFilters(session, statuses, windowFilters, search),
    )
    .slice(0, limit);
  const count = sessions.length;

  let responseText = "";
  if (metric === "count") {
    responseText = `I found ${count} active ACP session${count === 1 ? "" : "s"}.`;
  } else if (sessions.length === 0) {
    responseText = "I did not find any active ACP task-agent sessions.";
  } else if (metric === "detail" && sessions[0]) {
    const session = sessions[0];
    responseText = [
      `The most recent ACP session is "${labelFor(session)}" [${session.status}].`,
      `Agent: ${session.agentType}`,
      `Workspace: ${session.workdir}`,
      `Latest activity: ${dateString(session.lastActivityAt)}`,
    ]
      .filter(Boolean)
      .join("\n");
  } else {
    responseText = [
      `I found ${count} active ACP session${count === 1 ? "" : "s"}.`,
      ...sessions.map(
        (session) =>
          `- ${labelFor(session)} [${session.status}] (${dateString(session.lastActivityAt)}): ${session.agentType} in ${session.workdir}`,
      ),
    ].join("\n");
  }

  if (callback) await callback({ text: responseText });
  return {
    success: true,
    text: responseText,
    data: {
      actionName: "TASKS:history",
      count,
      sessionIds: sessions.map((session) => session.id),
    },
  };
}

// ── action: control (TASK_CONTROL) ──────────────────────────────────────────

// Structural only: the planner emits `controlAction` (or the legacy top-level
// action value) when the user asks to pause/stop/resume — the model judges
// intent. No regex over message text: hardcoded phrasings ("make it so",
// "hold on") misfire on ordinary prose (#11028).
function normalizeControlAction(value?: string): ControlAction | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "pause" ||
    normalized === "stop" ||
    normalized === "resume" ||
    normalized === "continue" ||
    normalized === "archive" ||
    normalized === "reopen"
  ) {
    return normalized;
  }
  return null;
}

async function runControl(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const access = await requireTaskAgentAccess(runtime, message, "interact");
  if (!access.allowed) {
    const reason = (access as { reason: string }).reason;
    if (callback) await callback({ text: reason });
    return failureResult("TASKS:control", "FORBIDDEN", reason, {
      reason: "access_denied",
    });
  }

  const service = getAcpService(runtime);
  if (!service) {
    if (callback) await callback({ text: "ACP service is not available." });
    return failureResult(
      "TASKS:control",
      "SERVICE_UNAVAILABLE",
      "ACP service is not available.",
      { reason: "acp_unavailable" },
    );
  }

  const text = typeof content.text === "string" ? content.text : "";
  const topLevelAction = textValue(params.action) ?? textValue(content.action);
  const normalizedTopLevelAction = topLevelAction
    ?.toLowerCase()
    .replace(/-/g, "_");
  const legacyControlAction =
    topLevelAction && normalizedTopLevelAction !== "control"
      ? topLevelAction
      : undefined;
  const action = normalizeControlAction(
    textValue(params.controlAction) ??
      textValue(content.controlAction) ??
      legacyControlAction,
  );

  if (!action) {
    const msg =
      "No task-control action was specified. Use pause, stop, resume, continue, archive, or reopen.";
    if (callback) await callback({ text: msg });
    return failureResult("TASKS:control", "INVALID_OPERATION", msg, {
      reason: "invalid_operation",
    });
  }

  // Archive / reopen / pause are durable task-lifecycle operations, not ACP
  // session controls — route them to the durable task service (see
  // runTaskLifecycleControl), which supports all three.
  if (action === "archive" || action === "reopen" || action === "pause") {
    return runTaskLifecycleControl(runtime, params, content, callback, action);
  }

  const instruction =
    textValue(params.instruction) ??
    textValue(content.instruction) ??
    (action === "continue" || action === "resume" ? text : undefined);

  // Resume/continue must clear the durable paused flag before any ACP send:
  // the pause branch above routes to pauseTask, which stops the task's
  // sessions and sets paused:true — freezing advanceTaskStatus. A bare
  // session send can never unpause the task (and after a pause there is
  // usually no live session left to send to), so without this pause would be
  // a one-way door from the action surface. Session-only calls (no
  // taskId/threadId, or no task service) keep the plain ACP-send fallback.
  const controlTaskId =
    action === "resume" || action === "continue"
      ? (pickString(params, content, "taskId") ??
        pickString(params, content, "threadId"))
      : undefined;
  let resumedTask: Awaited<ReturnType<OrchestratorTaskService["resumeTask"]>> =
    null;
  if (controlTaskId) {
    const taskService = runtime.getService?.(
      OrchestratorTaskService.serviceType,
    ) as OrchestratorTaskService | null | undefined;
    if (taskService) {
      try {
        resumedTask = await taskService.resumeTask(controlTaskId);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        coreLogger.warn(`[TASKS:control] resume failed: ${errMsg}`);
        const out = `Failed to resume coding task ${controlTaskId}: ${errMsg}`;
        if (callback) await callback({ text: out });
        return failureResult("TASKS:control", "LIFECYCLE_FAILED", out, {
          reason: "lifecycle_failed",
          taskId: controlTaskId,
        });
      }
    }
  }

  const target = await resolveSession(
    service,
    pickString(params, content, "sessionId"),
    state,
  );
  if (!target.session) {
    if (resumedTask && controlTaskId) {
      const out = `Resumed coding task ${controlTaskId}. No active ACP session to instruct — the task is unpaused.`;
      if (callback) await callback({ text: out });
      return {
        success: true,
        text: out,
        data: {
          actionName: "TASKS:control",
          action,
          taskId: controlTaskId,
          task: resumedTask,
        },
      };
    }
    const msg = target.missingId
      ? `Session ${target.missingId} not found.`
      : "No active ACP session found.";
    if (callback) await callback({ text: msg });
    return failureResult("TASKS:control", "SESSION_NOT_FOUND", msg, {
      reason: "session_not_found",
      action,
    });
  }

  let data: Record<string, unknown> = {
    actionName: "TASKS:control",
    sessionId: target.session.id,
    action,
  };
  if (resumedTask && controlTaskId) {
    data = { ...data, taskId: controlTaskId };
  }

  let responseText = "";
  if (action === "stop") {
    await service.stopSession(target.session.id);
    responseText = `Stopped ACP session ${target.session.id}.`;
  } else {
    const nextInstruction =
      instruction?.trim() || "Continue with the current task.";
    await service.sendToSession(target.session.id, nextInstruction);
    responseText = `Sent follow-up instructions to ACP session ${target.session.id}.`;
    data = { ...data, instruction: nextInstruction };
  }

  if (callback) await callback({ text: responseText });
  return {
    success: true,
    text: responseText,
    data: data as ActionResult["data"],
  };
}

// ── action: share (TASK_SHARE) ──────────────────────────────────────────────

async function runShare(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  _content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const access = await requireTaskAgentAccess(runtime, message, "interact");
  if (!access.allowed) {
    const reason = (access as { reason: string }).reason;
    if (callback) await callback({ text: reason });
    return { success: false, error: "FORBIDDEN", text: reason };
  }

  const service = getAcpService(runtime);
  if (!service) {
    if (callback) await callback({ text: "ACP service is not available." });
    return { success: false, error: "SERVICE_UNAVAILABLE" };
  }

  const target = await resolveSession(
    service,
    pickString(params, _content, "sessionId"),
    state,
  );
  if (!target.session) {
    const text = "I could not find an active ACP session to share.";
    if (callback) await callback({ text });
    return { success: false, error: "SESSION_NOT_FOUND", text };
  }

  const responseText = [
    `ACP session ${target.session.id}`,
    `Agent: ${target.session.agentType}`,
    `Status: ${target.session.status}`,
    `Workspace: ${target.session.workdir}`,
  ].join("\n");

  if (callback) await callback({ text: responseText });
  return {
    success: true,
    text: responseText,
    data: {
      sessionId: target.session.id,
      workdir: target.session.workdir,
    },
  };
}

// ── action: provision_workspace (CREATE_WORKSPACE) ─────────────────────────

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

async function runProvisionWorkspace(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  _content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const access = await requireTaskAgentAccess(runtime, message, "create");
  if (!access.allowed) {
    const reason = (access as { reason: string }).reason;
    if (callback) await callback({ text: reason });
    return { success: false, error: "FORBIDDEN", text: reason };
  }

  const workspaceService = getCodingWorkspaceService(runtime);
  if (!workspaceService) {
    if (callback)
      await callback({ text: "Workspace Service is not available." });
    return { success: false, error: "SERVICE_UNAVAILABLE" };
  }

  const content = message.content as {
    text?: string;
    repo?: string;
    baseBranch?: string;
    useWorktree?: boolean;
    parentWorkspaceId?: string;
  };

  const paramRepo = typeof params.repo === "string" ? params.repo : undefined;
  const paramBaseBranch =
    typeof params.baseBranch === "string" ? params.baseBranch : undefined;
  const paramUseWorktree = readOptionalBoolean(params.useWorktree);
  const paramParentWorkspaceId =
    typeof params.parentWorkspaceId === "string"
      ? params.parentWorkspaceId
      : undefined;

  let repo = paramRepo ?? content.repo;
  if (!repo && content.text) {
    const urlMatch = content.text.match(
      /https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+(?:\.git)?/i,
    );
    if (urlMatch) {
      repo = urlMatch[0];
    }
  }

  const useWorktree = paramUseWorktree ?? content.useWorktree === true;
  if (!repo && !useWorktree) {
    if (callback)
      await callback({
        text: "Please specify a repository URL or use worktree mode with a parent workspace.",
      });
    return { success: false, error: "MISSING_REPO" };
  }

  if (repo) {
    repo = normalizeRepositoryInput(repo);
    const ALLOWED_DOMAINS =
      /^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//i;
    if (!ALLOWED_DOMAINS.test(repo)) {
      if (callback)
        await callback({
          text: "Repository URL must be from github.com, gitlab.com, or bitbucket.org.",
        });
      return { success: false, error: "INVALID_REPO_DOMAIN" };
    }
  }

  let parentWorkspaceId = paramParentWorkspaceId ?? content.parentWorkspaceId;
  if (useWorktree && !parentWorkspaceId) {
    if (state?.codingWorkspace) {
      parentWorkspaceId = (state.codingWorkspace as { id: string }).id;
    } else {
      if (callback)
        await callback({
          text: "Worktree mode requires a parent workspace. Clone a repo first or specify parentWorkspaceId.",
        });
      return { success: false, error: "MISSING_PARENT" };
    }
  }
  if (useWorktree && !repo && parentWorkspaceId) {
    const parentWorkspace = workspaceService.getWorkspace(parentWorkspaceId);
    if (!parentWorkspace) {
      if (callback)
        await callback({
          text: `Parent workspace ${parentWorkspaceId} not found.`,
        });
      return { success: false, error: "WORKSPACE_NOT_FOUND" };
    }
    repo = parentWorkspace.repo;
  }

  try {
    const workspace: WorkspaceResult = await Promise.race([
      workspaceService.provisionWorkspace({
        repo: repo ?? "",
        baseBranch: paramBaseBranch ?? content.baseBranch,
        useWorktree,
        parentWorkspaceId,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Workspace provisioning timeout")),
          PROVISION_WORKSPACE_TIMEOUT_MS,
        ),
      ),
    ]);

    if (state) {
      state.codingWorkspace = {
        id: workspace.id,
        path: workspace.path.slice(0, WORKSPACE_PATH_MAX_CHARS),
        branch: workspace.branch,
        isWorktree: workspace.isWorktree,
      };
    }

    if (callback)
      await callback({
        text:
          `Created workspace at ${workspace.path.slice(0, WORKSPACE_PATH_MAX_CHARS)}\n` +
          `Branch: ${workspace.branch}\n` +
          `Type: ${workspace.isWorktree ? "worktree" : "clone"}`,
      });

    return {
      success: true,
      text: `Created workspace ${workspace.id}`,
      data: {
        workspaceId: workspace.id,
        path: workspace.path.slice(0, WORKSPACE_PATH_MAX_CHARS),
        branch: workspace.branch,
        isWorktree: workspace.isWorktree,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (callback)
      await callback({
        text: `Failed to provision workspace: ${errorMessage}`,
      });
    return { success: false, error: errorMessage };
  }
}

// ── action: submit_workspace (SUBMIT_WORKSPACE) ────────────────────────────

async function runSubmitWorkspace(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  _content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const access = await requireTaskAgentAccess(runtime, message, "interact");
  if (!access.allowed) {
    const reason = (access as { reason: string }).reason;
    if (callback) await callback({ text: reason });
    return { success: false, error: "FORBIDDEN", text: reason };
  }

  const workspaceService = getCodingWorkspaceService(runtime);
  if (!workspaceService) {
    if (callback)
      await callback({ text: "Workspace Service is not available." });
    return { success: false, error: "SERVICE_UNAVAILABLE" };
  }

  const content = message.content as {
    workspaceId?: string;
    commitMessage?: string;
    prTitle?: string;
    prBody?: string;
    baseBranch?: string;
    draft?: boolean;
    skipPR?: boolean;
  };

  const paramWorkspaceId =
    typeof params.workspaceId === "string" ? params.workspaceId : undefined;
  const paramCommitMessage =
    typeof params.commitMessage === "string" ? params.commitMessage : undefined;
  const paramPrTitle =
    typeof params.prTitle === "string" ? params.prTitle : undefined;
  const paramPrBody =
    typeof params.prBody === "string" ? params.prBody : undefined;
  const paramBaseBranch =
    typeof params.baseBranch === "string" ? params.baseBranch : undefined;
  const paramDraft = readOptionalBoolean(params.draft);
  const paramSkipPR = readOptionalBoolean(params.skipPR);

  let workspaceId = paramWorkspaceId ?? content.workspaceId;
  if (!workspaceId && state?.codingWorkspace) {
    workspaceId = (state.codingWorkspace as { id: string }).id;
  }

  if (!workspaceId) {
    const workspaces = workspaceService.listWorkspaces();
    if (workspaces.length === 0) {
      if (callback)
        await callback({
          text: "No workspaces available. Provision a workspace first.",
        });
      return { success: false, error: "NO_WORKSPACE" };
    }
    workspaceId = workspaces[workspaces.length - 1].id;
  }

  const workspace = workspaceService.getWorkspace(workspaceId);
  if (!workspace) {
    if (callback)
      await callback({ text: `Workspace ${workspaceId} not found.` });
    return { success: false, error: "WORKSPACE_NOT_FOUND" };
  }

  try {
    const status = await workspaceService.getStatus(workspaceId);

    if (status.clean && status.staged.length === 0) {
      if (callback)
        await callback({ text: "No changes to commit in this workspace." });
      return {
        success: true,
        text: "No changes to commit",
        data: { workspaceId, status },
      };
    }

    const commitMessage =
      paramCommitMessage ??
      content.commitMessage ??
      `feat: automated changes from task agent\n\nGenerated by Eliza task-agent plugin.`;

    const commitHash = await workspaceService.commit(workspaceId, {
      message: commitMessage,
      all: true,
    });

    await workspaceService.push(workspaceId, { setUpstream: true });

    let prInfo: PullRequestInfo | null = null;
    const skipPR = paramSkipPR ?? content.skipPR === true;
    if (!skipPR) {
      const prTitle =
        paramPrTitle ?? content.prTitle ?? `[Eliza] ${workspace.branch}`;
      const prBody =
        paramPrBody ??
        content.prBody ??
        `## Summary\n\nAutomated changes generated by Eliza task agent.\n\n` +
          `**Branch:** ${workspace.branch}\n` +
          `**Commit:** ${commitHash}\n\n` +
          `---\n*Generated by @elizaos/plugin-agent-orchestrator*`;

      prInfo = await workspaceService.createPR(workspaceId, {
        title: prTitle,
        body: prBody,
        base: paramBaseBranch ?? content.baseBranch,
        draft: paramDraft ?? content.draft,
      });
    }

    if (callback) {
      if (prInfo) {
        await callback({
          text:
            `Workspace finalized!\n` +
            `Commit: ${commitHash.slice(0, 8)}\n` +
            `PR #${prInfo.number}: ${prInfo.url}`,
        });
      } else {
        await callback({
          text:
            `Workspace changes committed and pushed.\n` +
            `Commit: ${commitHash.slice(0, 8)}`,
        });
      }
    }

    return {
      success: true,
      text: prInfo
        ? `Created PR #${prInfo.number}`
        : "Changes committed and pushed",
      data: {
        workspaceId,
        commitHash,
        pr: prInfo ? { number: prInfo.number, url: prInfo.url } : undefined,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (callback)
      await callback({ text: `Failed to finalize workspace: ${errorMessage}` });
    return { success: false, error: "FINALIZE_FAILED" };
  }
}

// ── action: manage_issues (MANAGE_ISSUES) ──────────────────────────────────

function formatGitHubAuthPrompt(
  prompt: Parameters<AuthPromptCallback>[0],
): string {
  return (
    `I need GitHub access to manage issues. Please authorize me:\n\n` +
    `Go to: ${prompt.verificationUri}\n` +
    `Enter code: **${prompt.userCode}**\n\n` +
    `This code expires in ${Math.floor(prompt.expiresIn / 60)} minutes. ` +
    `I'll wait for you to complete authorization...`
  );
}

function extractBulkItems(
  text: string,
): Array<{ title: string; body?: string }> {
  if (!text) return [];

  const numberedPattern =
    /(?:^|\s)(\d+)[).:-]\s*(.+?)(?=(?:\s+\d+[).:-]\s)|$)/gs;
  const items: Array<{ title: string; body?: string }> = [];

  for (const match of text.matchAll(numberedPattern)) {
    const raw = match[2].trim();
    if (raw.length > 0) {
      items.push({ title: raw });
    }
  }

  if (items.length >= 2) return items;

  const bulletPattern = /(?:^|\n)\s*[-*•]\s+(.+)/g;
  const bulletItems: Array<{ title: string; body?: string }> = [];
  for (const match of text.matchAll(bulletPattern)) {
    const raw = match[1].trim();
    if (raw.length > 0) {
      bulletItems.push({ title: raw });
    }
  }

  if (bulletItems.length >= 2) return bulletItems;

  return [];
}

function inferIssueAction(text: string): string {
  const lower = text.toLowerCase();

  if (/\b(create|open|file|submit|make|add)\b.*\bissue/.test(lower))
    return "create";
  if (/\bissue.*\b(create|open|file|submit|make)\b/.test(lower))
    return "create";
  if (/\b(close|resolve)\b.*\bissue/.test(lower)) return "close";
  if (/\bissue.*\b(close|resolve)\b/.test(lower)) return "close";
  if (/\b(reopen|re-open)\b.*\bissue/.test(lower)) return "reopen";
  if (/\b(comment|reply)\b.*\bissue/.test(lower)) return "comment";
  if (/\bissue.*\b(comment|reply)\b/.test(lower)) return "comment";
  if (/\b(update|edit|modify)\b.*\bissue/.test(lower)) return "update";
  if (/\bissue.*\b(update|edit|modify)\b/.test(lower)) return "update";
  if (/\b(label|tag)\b.*\bissue/.test(lower)) return "add_labels";
  if (/\bget\b.*\bissue\s*#?\d/.test(lower)) return "get";
  if (/\bissue\s*#?\d/.test(lower) && !/\b(list|show|all)\b/.test(lower))
    return "get";
  if (/\b(list|show|check|what are)\b.*\bissue/.test(lower)) return "list";

  return "list";
}

function parseLabels(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(String);
  if (typeof input === "string")
    return input
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

async function handleIssueAction(
  service: CodingWorkspaceService,
  repo: string,
  action: string,
  params: Record<string, unknown>,
  originalText: string,
  callback?: HandlerCallback,
): Promise<ActionResult | undefined> {
  try {
    switch (action.toLowerCase()) {
      case "create": {
        const title = params.title as string;
        const body = params.body as string | undefined;

        if (!title) {
          const items = extractBulkItems(
            (params.text as string) ?? originalText,
          );
          if (items.length > 0) {
            const labels = parseLabels(params.labels);
            const created: IssueInfo[] = [];
            for (const item of items.slice(0, ISSUE_RESULT_LIMIT)) {
              const issue = await service.createIssue(repo, {
                title: item.title,
                body: item.body ?? "",
                labels: labels.length > 0 ? labels : undefined,
              });
              created.push(issue);
            }
            if (callback) {
              const summary = created
                .map((i) => `#${i.number}: ${i.title}\n  ${i.url}`)
                .join("\n");
              await callback({
                text: `Created ${created.length} issues:\n${summary}`,
              });
            }
            return { success: true, data: { issues: created } };
          }

          if (callback)
            await callback({ text: "Issue title is required for create." });
          return { success: false, error: "MISSING_TITLE" };
        }

        const labels = parseLabels(params.labels);
        const issue = await service.createIssue(repo, {
          title,
          body: body ?? "",
          labels: labels.length > 0 ? labels : undefined,
        });
        if (callback)
          await callback({
            text: `Created issue #${issue.number}: ${issue.title}\n${issue.url}`,
          });
        return { success: true, data: { issue } };
      }

      case "list": {
        const stateFilter = (params.state as string) ?? "open";
        const labels = parseLabels(params.labels);
        const issues = (
          await service.listIssues(repo, {
            state: stateFilter as "open" | "closed" | "all",
            labels: labels.length > 0 ? labels : undefined,
          })
        ).slice(0, ISSUE_RESULT_LIMIT);
        if (callback) {
          if (issues.length === 0) {
            await callback({
              text: `No ${stateFilter} issues found in ${repo}.`,
            });
          } else {
            const summary = issues
              .map(
                (i) =>
                  `#${i.number} [${i.state}] ${i.title}${i.labels.length > 0 ? ` (${i.labels.join(", ")})` : ""}`,
              )
              .join("\n");
            await callback({ text: `Issues in ${repo}:\n${summary}` });
          }
        }
        return { success: true, data: { issues } };
      }

      case "get": {
        const issueNumber = Number(params.issueNumber);
        if (!issueNumber) {
          if (callback) await callback({ text: "Issue number is required." });
          return { success: false, error: "MISSING_ISSUE_NUMBER" };
        }
        const issue = await service.getIssue(repo, issueNumber);
        if (callback)
          await callback({
            text: `Issue #${issue.number}: ${issue.title} [${issue.state}]\n\n${issue.body.slice(0, ISSUE_BODY_MAX_CHARS)}\n\nLabels: ${issue.labels.join(", ") || "none"}\n${issue.url}`,
          });
        return { success: true, data: { issue } };
      }

      case "update": {
        const issueNumber = Number(params.issueNumber);
        if (!issueNumber) {
          if (callback) await callback({ text: "Issue number is required." });
          return { success: false, error: "MISSING_ISSUE_NUMBER" };
        }
        const labels = parseLabels(params.labels);
        const issue = await service.updateIssue(repo, issueNumber, {
          title: params.title as string | undefined,
          body: params.body as string | undefined,
          labels: labels.length > 0 ? labels : undefined,
        });
        if (callback)
          await callback({
            text: `Updated issue #${issue.number}: ${issue.title}`,
          });
        return { success: true, data: { issue } };
      }

      case "comment": {
        const issueNumber = Number(params.issueNumber);
        const body = params.body as string;
        if (!issueNumber || !body) {
          if (callback)
            await callback({
              text: "Issue number and comment body are required.",
            });
          return { success: false, error: "MISSING_PARAMS" };
        }
        const comment = await service.addComment(repo, issueNumber, body);
        if (callback)
          await callback({
            text: `Added comment to issue #${issueNumber}: ${comment.url}`,
          });
        return { success: true, data: { comment } };
      }

      case "close": {
        const issueNumber = Number(params.issueNumber);
        if (!issueNumber) {
          if (callback) await callback({ text: "Issue number is required." });
          return { success: false, error: "MISSING_ISSUE_NUMBER" };
        }
        const issue = await service.closeIssue(repo, issueNumber);
        if (callback)
          await callback({
            text: `Closed issue #${issue.number}: ${issue.title}`,
          });
        return { success: true, data: { issue } };
      }

      case "reopen": {
        const issueNumber = Number(params.issueNumber);
        if (!issueNumber) {
          if (callback) await callback({ text: "Issue number is required." });
          return { success: false, error: "MISSING_ISSUE_NUMBER" };
        }
        const issue = await service.reopenIssue(repo, issueNumber);
        if (callback)
          await callback({
            text: `Reopened issue #${issue.number}: ${issue.title}`,
          });
        return { success: true, data: { issue } };
      }

      case "add_labels": {
        const issueNumber = Number(params.issueNumber);
        const labels = parseLabels(params.labels);
        if (!issueNumber || labels.length === 0) {
          if (callback)
            await callback({ text: "Issue number and labels are required." });
          return { success: false, error: "MISSING_PARAMS" };
        }
        await service.addLabels(repo, issueNumber, labels);
        if (callback)
          await callback({
            text: `Added labels [${labels.join(", ")}] to issue #${issueNumber}`,
          });
        return { success: true };
      }

      default:
        if (callback)
          await callback({
            text: `Unknown issue action: ${action}. Use: create, list, get, update, comment, close, reopen, add_labels`,
          });
        return { success: false, error: "UNKNOWN_OPERATION" };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (callback)
      await callback({ text: `Issue operation failed: ${errorMessage}` });
    return { success: false, error: errorMessage };
  }
}

async function runManageIssues(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const access = await requireTaskAgentAccess(runtime, message, "interact");
  if (!access.allowed) {
    const reason = (access as { reason: string }).reason;
    if (callback) await callback({ text: reason });
    return { success: false, error: "FORBIDDEN", text: reason };
  }

  const workspaceService = getCodingWorkspaceService(runtime);
  if (!workspaceService) {
    if (callback)
      await callback({ text: "Workspace Service is not available." });
    return { success: false, error: "SERVICE_UNAVAILABLE" };
  }

  workspaceService.setAuthPromptCallback(
    (prompt: Parameters<AuthPromptCallback>[0]) => {
      coreLogger.warn(
        `[TASKS:manage_issues] GitHub OAuth prompt could not be delivered automatically in ACP-only mode: ${formatGitHubAuthPrompt(prompt)}`,
      );
      return false;
    },
  );

  const text = ((content.text as string) ?? "").slice(0, ISSUE_BODY_MAX_CHARS);

  const topLevelAction = textValue(params.action) ?? textValue(content.action);
  const normalizedTopLevelAction = topLevelAction
    ?.toLowerCase()
    .replace(/-/g, "_");
  const legacyIssueAction =
    topLevelAction && normalizedTopLevelAction !== "manage_issues"
      ? topLevelAction
      : undefined;
  const action =
    (params.issueAction as string) ??
    (content.issueAction as string) ??
    legacyIssueAction ??
    inferIssueAction(text);
  const repo = (params.repo as string) ?? (content.repo as string);

  if (!repo) {
    const urlMatch = text.match(
      /(?:https?:\/\/github\.com\/)?([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/,
    );
    if (!urlMatch) {
      if (callback)
        await callback({
          text: "Please specify a repository (e.g., owner/repo or a GitHub URL).",
        });
      return { success: false, error: "MISSING_REPO" };
    }
    return (
      (await handleIssueAction(
        workspaceService,
        urlMatch[1],
        action,
        { ...content, ...params },
        text,
        callback,
      )) ?? { success: false, error: "UNKNOWN_OPERATION" }
    );
  }

  return (
    (await handleIssueAction(
      workspaceService,
      repo,
      action,
      { ...content, ...params },
      text,
      callback,
    )) ?? { success: false, error: "UNKNOWN_OPERATION" }
  );
}

// ── action: archive / reopen (ARCHIVE_CODING_TASK / REOPEN_CODING_TASK) ────

type TaskLifecycleOp = "archive" | "reopen" | "pause";

/**
 * Archive / reopen / pause a durable task via OrchestratorTaskService. These are
 * first-class operations on the durable task store — the
 * `/api/orchestrator/tasks/:id/{archive,reopen}` routes already expose them, and
 * `archiveTask`/`reopenTask`/`pauseTask` all exist. The old action paths returned
 * `UNSUPPORTED_OPERATION` ("ACP-only mode") from before the task service existed,
 * which then failed the very calls the archive/reopen similes train the planner
 * to make. Only a genuinely ACP-only runtime (no task service registered) still
 * reports the operation as unavailable.
 */
async function runTaskLifecycleControl(
  runtime: IAgentRuntime,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
  op: TaskLifecycleOp,
): Promise<ActionResult> {
  const actionName = `TASKS:${op}`;
  const taskId =
    pickString(params, content, "taskId") ??
    pickString(params, content, "threadId");
  if (!taskId) {
    const msg = "taskId is required.";
    await callbackText(callback, msg);
    return failureResult(actionName, "MISSING_TASK_ID", msg, {
      reason: "missing_task_id",
    });
  }
  const taskService = runtime.getService?.(
    OrchestratorTaskService.serviceType,
  ) as OrchestratorTaskService | null | undefined;
  if (!taskService) {
    const msg = `Task ${op} is unavailable without the orchestrator task service.`;
    await callbackText(callback, msg);
    return failureResult(actionName, "UNSUPPORTED_OPERATION", msg, {
      reason: "acp_only",
      action: op,
    });
  }
  try {
    const result =
      op === "archive"
        ? await taskService.archiveTask(taskId)
        : op === "reopen"
          ? await taskService.reopenTask(taskId)
          : await taskService.pauseTask(taskId);
    if (!result) {
      const msg = `Task ${taskId} not found.`;
      await callbackText(callback, msg);
      return failureResult(actionName, "TASK_NOT_FOUND", msg, {
        reason: "task_not_found",
        taskId,
      });
    }
    const verb =
      op === "archive" ? "Archived" : op === "reopen" ? "Reopened" : "Paused";
    const out = `${verb} coding task ${taskId}.`;
    await callbackText(callback, out);
    return {
      success: true,
      text: out,
      data: { actionName, taskId, task: result },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    coreLogger.warn(`[${actionName}] failed: ${errMsg}`);
    const out = `Failed to ${op} coding task ${taskId}: ${errMsg}`;
    await callbackText(callback, out);
    return failureResult(actionName, "LIFECYCLE_FAILED", out, {
      reason: "lifecycle_failed",
      taskId,
    });
  }
}

async function runArchive(
  runtime: IAgentRuntime,
  _message: Memory,
  _state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  return runTaskLifecycleControl(runtime, params, content, callback, "archive");
}

async function runReopen(
  runtime: IAgentRuntime,
  _message: Memory,
  _state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  return runTaskLifecycleControl(runtime, params, content, callback, "reopen");
}

// ── parent action ──────────────────────────────────────────────────────

export const tasksAction: Action & {
  suppressPostActionContinuation: true;
  suppressEarlyReply: true;
} = {
  name: "TASKS",
  contexts: ["code", "automation", "agent_internal", "connectors"],
  roleGate: { minRole: "USER" },
  tags: [
    "domain:coding",
    "domain:agent-orchestration",
    "resource:agent-task",
    "resource:coding-task",
    "capability:delegate",
    "surface:task-coordinator",
  ],
  similes: [
    // create
    "CREATE_AGENT_TASK",
    "CREATE_TASK",
    "START_CODING_TASK",
    "CODE_TASK",
    "LAUNCH_CODING_TASK",
    "RUN_CODING_TASK",
    "START_AGENT_TASK",
    "SPAWN_AND_PROVISION",
    "CODE_THIS",
    "LAUNCH_TASK",
    "CREATE_SUBTASK",
    // spawn_agent
    "SPAWN_AGENT",
    "SPAWN_CODING_AGENT",
    "START_CODING_AGENT",
    "LAUNCH_CODING_AGENT",
    "CREATE_CODING_AGENT",
    "SPAWN_CODER",
    "RUN_CODING_AGENT",
    "SPAWN_SUB_AGENT",
    "START_TASK_AGENT",
    "CREATE_AGENT",
    // send
    "SEND_TO_AGENT",
    "SEND_TO_CODING_AGENT",
    "MESSAGE_CODING_AGENT",
    "INPUT_TO_AGENT",
    "RESPOND_TO_AGENT",
    "TELL_CODING_AGENT",
    "MESSAGE_AGENT",
    "TELL_TASK_AGENT",
    // stop_agent
    "STOP_AGENT",
    "STOP_CODING_AGENT",
    "KILL_CODING_AGENT",
    "TERMINATE_AGENT",
    "END_CODING_SESSION",
    "CANCEL_AGENT",
    "CANCEL_TASK_AGENT",
    "STOP_SUB_AGENT",
    // list_agents
    "LIST_AGENTS",
    "LIST_CODING_AGENTS",
    "SHOW_CODING_AGENTS",
    "GET_ACTIVE_AGENTS",
    "LIST_SESSIONS",
    "SHOW_CODING_SESSIONS",
    "SHOW_TASK_AGENTS",
    "LIST_SUB_AGENTS",
    "SHOW_TASK_STATUS",
    // cancel
    "CANCEL_TASK",
    "STOP_TASK",
    "ABORT_TASK",
    "KILL_TASK",
    "STOP_SUBTASK",
    // history
    "TASK_HISTORY",
    "LIST_TASK_HISTORY",
    "GET_TASK_HISTORY",
    "SHOW_TASKS",
    "COUNT_TASKS",
    "TASK_STATUS_HISTORY",
    // control
    "TASK_CONTROL",
    "CONTROL_TASK",
    "PAUSE_TASK",
    "RESUME_TASK",
    "CONTINUE_TASK",
    "ARCHIVE_TASK",
    "REOPEN_TASK",
    // share
    "TASK_SHARE",
    "SHARE_TASK_RESULT",
    "SHOW_TASK_ARTIFACT",
    "VIEW_TASK_OUTPUT",
    "CAN_I_SEE_IT",
    "PULL_IT_UP",
    // provision_workspace
    "CREATE_WORKSPACE",
    "PROVISION_WORKSPACE",
    "CLONE_REPO",
    "SETUP_WORKSPACE",
    "PREPARE_WORKSPACE",
    // submit_workspace
    "SUBMIT_WORKSPACE",
    "FINALIZE_WORKSPACE",
    "COMMIT_AND_PR",
    "CREATE_PR",
    "SUBMIT_CHANGES",
    "FINISH_WORKSPACE",
    // manage_issues
    "MANAGE_ISSUES",
    "CREATE_ISSUE",
    "LIST_ISSUES",
    "CLOSE_ISSUE",
    "COMMENT_ISSUE",
    "UPDATE_ISSUE",
    "GET_ISSUE",
    // archive / reopen
    "ARCHIVE_CODING_TASK",
    "CLOSE_CODING_TASK",
    "ARCHIVE_TASK_THREAD",
    "REOPEN_CODING_TASK",
    "UNARCHIVE_CODING_TASK",
    "RESUME_CODING_TASK",
  ],
  description:
    "Planner surface for orchestrator workspace operations and coding task delegation to dedicated ACP coding sub-agents (elizaos / pi-agent / opencode / claude / codex). " +
    "Available operations (pick via `action`): create or spawn_agent (delegate new coding work), send (forward a message to an existing coding sub-agent), list_agents / history (read state), " +
    "control (pause | resume | continue | archive | reopen a task), share (surface task output), provision_workspace / submit_workspace (workspace setup and PR submission), manage_issues (GitHub issue operations), cancel / stop_agent (end a coding sub-agent run when the user asks to). " +
    "Choose this when the user asks to delegate coding work, use a coding adapter by name, or run multi-step development work — it is the canonical path for coding sub-agents and is preferred over inline FILE / BASH for delegated work.",
  descriptionCompressed:
    "ACP coding sub-agent elizaos|pi-agent|opencode|claude|codex: spawn|send|control|list|history",
  routingHint:
    'delegate coding/software/dev work to a coding sub-agent, or drive a coding adapter by name (elizaos|pi-agent|opencode|claude|codex) -> TASKS; do NOT use for personal reminders, check-ins, follow-ups, alarms or recurring routines ("remind me...", "every day...") -> SCHEDULED_TASKS / OWNER_REMINDERS / OWNER_ROUTINES instead; not for one-off inline file edits or shell commands -> FILE / BASH',
  suppressPostActionContinuation: true,
  // When the planner picks any TASKS_* subaction (spawn_agent, send, etc.),
  // suppress the response-handler's draft reply: the action's own callback
  // emits the canonical ack ("On it — spawning…") and the sub-agent's real
  // answer comes back asynchronously via the router. Shipping the draft
  // alongside the ack duplicates the bot's voice and confuses the user.
  suppressEarlyReply: true,
  parameters: [
    {
      name: "action",
      description:
        "Task operation: create, spawn_agent, send, stop_agent, list_agents, cancel, history, control, share, provision_workspace, submit_workspace, manage_issues, archive, reopen.",
      required: false,
      schema: { type: "string" as const, enum: [...SUPPORTED_OPS] },
    },
    {
      name: "op",
      description: "Planner alias for action.",
      required: false,
      schema: { type: "string" as const, enum: [...SUPPORTED_OPS] },
    },
    {
      name: "subaction",
      description: "Planner alias for action.",
      required: false,
      schema: { type: "string" as const, enum: [...SUPPORTED_OPS] },
    },
    {
      name: "operation",
      description: "Planner alias for action.",
      required: false,
      schema: { type: "string" as const, enum: [...SUPPORTED_OPS] },
    },
    // create / spawn_agent
    {
      name: "task",
      description: "Task prompt for create / spawn_agent / send (as new task).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "agentType",
      description:
        "Heuristic backend guess (elizaos, pi-agent, opencode, codex, or claude) for create / spawn_agent / control.resume. This is a weak hint — it loses to the operator default/pin and to character routing. To honor an EXPLICIT user request use requestedBackend instead.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "appMonetized",
      description:
        "Set true when the user wants the app to EARN MONEY / charge for access — e.g. 'people pay $1 to chat with X', 'charge per message', 'a paid app', 'monetized', a paywall, or per-use pricing. Judge the user's INTENT, not specific keywords. When true the sub-agent gets the monetized Eliza Cloud contract (register for an appId, inference markup, OAuth + affiliate billing) instead of a free static page. Leave unset for a normal free app or non-app task.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "requestedBackend",
      description:
        "Set ONLY when the user EXPLICITLY named a coding backend for THIS task (e.g. 'use codex', 'have claude build it') — one of elizaos, pi-agent, opencode, codex, claude. Leave unset if the user did not name one; never guess. Unlike agentType this overrides the configured default/pin.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["elizaos", "pi-agent", "opencode", "codex", "claude"],
      },
    },
    {
      name: "taskComplexity",
      description:
        "Your honest assessment of this coding task's difficulty: 'simple' (small/routine), 'moderate', or 'hard' (large, subtle, multi-file, or architectural). Used only to route to whichever backend the character configured for that difficulty (character.routing.coding.byTag). Judge the task itself — do not echo words from the user.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["simple", "moderate", "hard"],
      },
    },
    {
      name: "agents",
      description: "Pipe-delimited multi-agent task list for action=create.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "repo",
      description:
        "Repository URL/slug for action=create / action=manage_issues / action=provision_workspace.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "workdir",
      description: "Working directory for action=create / action=spawn_agent.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "memoryContent",
      description:
        "Additional memory/context for action=create / action=spawn_agent.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "label",
      description:
        "Task label for action=create / action=spawn_agent / action=send.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "approvalPreset",
      description: "Approval preset for action=create / action=spawn_agent.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["readonly", "standard", "permissive", "autonomous"],
      },
    },
    {
      name: "keepAliveAfterComplete",
      description:
        "Keep session alive after completion for action=spawn_agent.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "deferUserReply",
      description:
        "For action=spawn_agent, suppress the immediate visible acknowledgement when the user explicitly requested no interim reply, such as 'reply only after verification'. The sub-agent completion router will post the final result.",
      required: false,
      schema: { type: "boolean" as const },
    },
    // send
    {
      name: "input",
      description: "Text input to send to a running session for action=send.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "keys",
      description: "Key sequence to send for action=send.",
      required: false,
      schema: { type: "string" as const },
    },
    // session/thread targeting
    {
      name: "sessionId",
      description:
        "Target session id for action=send / action=stop_agent / action=cancel / action=control / action=share.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "threadId",
      description:
        "Target task-thread id for action=cancel / action=control / action=share / action=archive / action=reopen.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "taskId",
      description:
        "Alias for threadId; preferred for action=archive / action=reopen.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "all",
      description:
        "Apply to all sessions for action=stop_agent / action=cancel.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "search",
      description:
        "Free-text search for thread/task lookup in action=cancel / action=control / action=history / action=share.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description: "Cancellation reason for action=cancel.",
      required: false,
      schema: { type: "string" as const },
    },
    // history
    {
      name: "metric",
      description:
        "History query mode for action=history: list (default), count, or detail.",
      required: false,
      schema: { type: "string" as const, enum: ["list", "count", "detail"] },
    },
    {
      name: "window",
      description: "Relative window for action=history.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["active", "today", "yesterday", "last_7_days", "last_30_days"],
      },
    },
    {
      name: "statuses",
      description: "Status filter list for action=history.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "limit",
      description: "Result limit for action=history.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "includeArchived",
      description: "Include archived threads in action=history.",
      required: false,
      schema: { type: "boolean" as const },
    },
    // control
    {
      name: "controlAction",
      description:
        "Child action for action=control: pause | resume | stop | continue | archive | reopen.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "issueAction",
      description:
        "Child action for action=manage_issues: create | list | get | update | comment | close | reopen | add_labels.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "note",
      description:
        "Optional note for action=control with controlAction=pause|stop.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "instruction",
      description:
        "Follow-up instruction for action=control with controlAction=resume|continue.",
      required: false,
      schema: { type: "string" as const },
    },
    // workspace
    {
      name: "baseBranch",
      description:
        "Base branch for action=provision_workspace / action=submit_workspace.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "useWorktree",
      description: "Use worktree mode for action=provision_workspace.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "parentWorkspaceId",
      description:
        "Parent workspace id for action=provision_workspace worktree mode.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "workspaceId",
      description: "Workspace id for action=submit_workspace.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "commitMessage",
      description: "Commit message for action=submit_workspace.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "prTitle",
      description: "PR title for action=submit_workspace.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "prBody",
      description: "PR body for action=submit_workspace.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "draft",
      description: "Create draft PR for action=submit_workspace.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "skipPR",
      description: "Skip PR creation for action=submit_workspace.",
      required: false,
      schema: { type: "boolean" as const },
    },
    // manage_issues
    {
      name: "title",
      description:
        "Issue title for action=manage_issues with issueAction=create|update.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "body",
      description:
        "Issue body for action=manage_issues with issueAction=create|update|comment.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "issueNumber",
      description:
        "Issue number for action=manage_issues with issueAction=get|update|comment|close|reopen|add_labels.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "labels",
      description:
        "Labels (csv string or array) for action=manage_issues with issueAction=create|update|add_labels|list.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "state",
      description:
        "State filter (open|closed|all) for action=manage_issues with issueAction=list.",
      required: false,
      schema: { type: "string" as const },
    },
    // misc
    {
      name: "validator",
      description: "Optional verifier for action=create.",
      required: false,
      schema: { type: "object" as const },
    },
    {
      name: "maxRetries",
      description: "Verifier retry count for action=create.",
      required: false,
      schema: { type: "integer" as const, minimum: 0 },
    },
    {
      name: "onVerificationFail",
      description: "Verifier failure behavior for action=create.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["retry", "escalate"],
      },
    },
    {
      name: "metadata",
      description:
        "Additional metadata for action=create / action=spawn_agent.",
      required: false,
      schema: { type: "object" as const },
    },
    {
      name: "taskRoomId",
      description:
        "Optional task-owner swarm room id for action=create / action=spawn_agent.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "worktreeRoomId",
      description:
        "Optional worktree coordination swarm room id for action=create / action=spawn_agent.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  validate: async (runtime, message) => {
    const content = contentRecord(message);
    // Always allow when ACP service is available — action switch handles dispatch.
    if (!getAcpService(runtime)) {
      const taskService = runtime.getService?.(
        OrchestratorTaskService.serviceType,
      ) as OrchestratorTaskService | null | undefined;
      return (
        readOp(content) === "history" &&
        typeof taskService?.listTasks === "function"
      );
    }
    // Sub-agent task_complete events are routed back through the runtime as
    // synthetic inbound messages. Most verified completions are handled by
    // the response evaluator, but incomplete completions still need the TASKS
    // surface so the parent can send a follow-up to the same session instead
    // of asking the user to paste command output.
    const messageContent = message.content as {
      metadata?: unknown;
      source?: unknown;
    };
    if (messageContent.source === MESSAGE_SOURCE_SUB_AGENT) {
      const metadata =
        messageContent.metadata !== null &&
        typeof messageContent.metadata === "object"
          ? (messageContent.metadata as Record<string, unknown>)
          : undefined;
      return (
        metadata?.subAgent === true &&
        typeof metadata.subAgentSessionId === "string" &&
        typeof metadata.subAgentEvent === "string"
      );
    }
    if (
      hasExplicitPayload(message, [
        "action",
        "task",
        "repo",
        "workdir",
        "agents",
        "agentType",
        "sessionId",
        "threadId",
        "taskId",
      ])
    )
      return true;
    // Availability gate only: the orchestrator service is present and this is
    // not a personal-lifeops to-do. WHETHER the coding parent actually surfaces
    // to the planner is decided structurally — by the action's declared coding
    // contexts, retrieval scoring against the action description/similes, and
    // the Stage-1 context router — not by keyword-matching the request text here.
    const text = messageText(message);
    if (looksLikePersonalLifeOpsTask(text)) return false;
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const params = paramsRecord(options as HandlerOptionsLike | undefined);
    const content = contentRecord(message);
    const action = readOp(params) ?? "create";

    switch (action) {
      case "create":
        return runCreate(runtime, message, state, params, content, callback);
      case "spawn_agent":
        return runSpawnAgent(
          runtime,
          message,
          state,
          params,
          content,
          callback,
        );
      case "send":
        return runSend(runtime, message, state, params, content, callback);
      case "stop_agent":
        return runStopAgent(runtime, message, state, params, content, callback);
      case "list_agents":
        return runListAgents(
          runtime,
          message,
          state,
          params,
          content,
          callback,
        );
      case "cancel":
        return runCancel(runtime, message, state, params, content, callback);
      case "history":
        return runHistory(runtime, message, state, params, content, callback);
      case "control":
        return runControl(runtime, message, state, params, content, callback);
      case "share":
        return runShare(runtime, message, state, params, content, callback);
      case "provision_workspace":
        return runProvisionWorkspace(
          runtime,
          message,
          state,
          params,
          content,
          callback,
        );
      case "submit_workspace":
        return runSubmitWorkspace(
          runtime,
          message,
          state,
          params,
          content,
          callback,
        );
      case "manage_issues":
        return runManageIssues(
          runtime,
          message,
          state,
          params,
          content,
          callback,
        );
      case "archive":
        return runArchive(runtime, message, state, params, content, callback);
      case "reopen":
        return runReopen(runtime, message, state, params, content, callback);
      default:
        return errorResult(
          "UNKNOWN",
          `Unknown TASKS action: ${String(action)}`,
        );
    }
  },

  examples: [
    // ── delegation / sub-agent spawn (action=spawn_agent) ─────────────
    // These few-shots are the canonical signal that maps "spawn a sub-
    // agent / delegate this / fire up a coding agent" → TASKS with
    // action=spawn_agent. Without them, weaker planner LLMs (e.g.
    // gpt-oss-120b on Cerebras at high prompt sizes) sometimes pick
    // inline FILE.write or hallucinate a refusal. The cluster covers
    // explicit verbs (spawn / delegate / fire up), explicit nouns
    // (sub-agent / coding agent / sub-process), and the
    // user-naming-the-adapter case (elizaos / pi-agent / opencode /
    // claude / codex) so the
    // few-shot matches whatever provider the user has wired.
    [
      {
        name: "{{name1}}",
        content: {
          text: "Spawn a coding sub-agent to refactor the auth module.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Spinning up a coding sub-agent for the auth refactor.",
          actions: ["TASKS"],
          thought:
            "User asked to delegate to a sub-agent; TASKS action=spawn_agent routes to AcpService.spawnSession with the configured adapter (elizaos / pi-agent / opencode / claude / codex).",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Delegate this to a sub-agent: build a small python CLI at /tmp/oc-todo with main.py + tests.py.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Delegating the multi-file CLI build to a coding sub-agent.",
          actions: ["TASKS"],
          thought:
            "Explicit delegation request → TASKS action=spawn_agent. Multi-file project work is exactly what sub-agent isolation is for; do NOT use inline FILE.write for delegated work.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "use opencode to write a script that prints hello world",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Spawning an opencode sub-agent for the script.",
          actions: ["TASKS"],
          thought:
            "User explicitly named the coding adapter (opencode). TASKS action=spawn_agent with agentType=opencode hands off to the configured opencode provider (cerebras / openrouter / etc. via auto-detected key).",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "fire up a coding agent to investigate why the migration is hanging",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Spawning a coding sub-agent to investigate the migration.",
          actions: ["TASKS"],
          thought:
            "Investigation / debugging tasks benefit from sub-agent process isolation (own workspace, own tool loop). TASKS action=spawn_agent.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Spawn a coding sub-agent to refactor the auth module.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Spinning up a coding sub-agent for the auth refactor.",
          actions: ["TASKS"],
          thought:
            "User asked to delegate to a sub-agent; TASKS action=spawn_agent routes through the ACP service with the configured adapter (elizaos / pi-agent / opencode / claude / codex).",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Delegate this to a sub-agent: build a small python CLI at /tmp/oc-todo with main.py + tests.py.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Delegating the multi-file CLI build to a coding sub-agent.",
          actions: ["TASKS"],
          thought:
            "Explicit delegation request → TASKS action=spawn_agent. Multi-file project work is exactly what sub-agent isolation is for; do NOT use inline FILE.write for delegated work.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "fire up a coding agent to investigate why the migration is hanging",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Spawning a coding sub-agent to investigate the migration.",
          actions: ["TASKS"],
          thought:
            "Investigation / debugging tasks benefit from sub-agent process isolation (own workspace, own tool loop). TASKS action=spawn_agent.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Spawn a coding agent to refactor the auth module.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Creating the task and dispatching a coding sub-agent.",
          actions: ["TASKS"],
          thought:
            "User asked to delegate a coding job; TASKS action=create with kind=coding routes to the orchestrator's spawn path.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "What's the status of my running tasks?",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Listing active tasks.",
          actions: ["TASKS"],
          thought:
            "Status check maps to TASKS action=list_agents filtering for in_progress / queued tasks.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Stop the migration task; I'll come back to it later.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Pausing the task.",
          actions: ["TASKS"],
          thought:
            "Halt-and-keep-state maps to TASKS action=control with controlAction=pause; archive/reopen are for fully resolved tasks.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Show me the worktree for task TASK-12.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Opening the worktree.",
          actions: ["TASKS"],
          thought:
            "Worktree inspection maps to TASKS action=share with the explicit task id.",
        },
      },
    ],
  ],
};

// Operation-specific handles resolve to the TASKS action.
export const createTaskAction = tasksAction;
export const startCodingTaskAction = tasksAction;
export const spawnAgentAction = tasksAction;
export const spawnTaskAgentAction = tasksAction;
export const sendToAgentAction = tasksAction;
export const sendToTaskAgentAction = tasksAction;
export const stopAgentAction = tasksAction;
export const stopTaskAgentAction = tasksAction;
export const listAgentsAction = tasksAction;
export const listTaskAgentsAction = tasksAction;
export const cancelTaskAction = tasksAction;
export const taskHistoryAction = tasksAction;
export const taskControlAction = tasksAction;
export const taskShareAction = tasksAction;
export const provisionWorkspaceAction = tasksAction;
export const finalizeWorkspaceAction = tasksAction;
export const manageIssuesAction = tasksAction;
export const archiveCodingTaskAction = tasksAction;
export const reopenCodingTaskAction = tasksAction;
