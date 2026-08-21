/**
 * Unified action surface for orchestrator task, agent, workspace, and issue operations.
 * Simile actions normalize into a small operation vocabulary before their
 * runners enforce access, routing, lifecycle, and session-event invariants.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type {
  Action,
  ActionResult,
  Content,
  EffectReceipt,
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
  ElizaError,
  looksLikeBareLinkShare,
  MESSAGE_SOURCE_SUB_AGENT,
  stringToUuid,
  TRACE_ENV,
  unwrapUserMessageText,
  userReferenceLogView,
} from "@elizaos/core";
import type { IssueInfo, PullRequestInfo } from "git-workspace-service";
import {
  detectTaskType,
  type OrchestratorTaskType,
  staticAcceptanceCriteria,
  workspaceMutationExpected,
} from "../services/acceptance-criteria.js";
import { augmentTaskWithDeployGuidance } from "../services/app-deploy-guidance.js";
import { resolveCodingBackendLogged } from "../services/coding-backend-routing.js";
import { shouldAutoVerifyGoal } from "../services/goal-llm-verifier.js";
import {
  collisionProviderFromWorkspaceService,
  LanePlannerService,
  laneReadiness,
  shouldUseLanePlanner,
} from "../services/lane-planner.js";
import type { TaskThreadDto } from "../services/orchestrator-task-mapper.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import type { OrchestratorTaskStatus } from "../services/orchestrator-task-types.js";
import { resolveTaskSpawnWorkdir } from "../services/project-binding.js";
import { normalizeRepositoryInput } from "../services/repo-input.js";
import {
  runDurableTask,
  type SmithersDurableRunLink,
  shouldUseSmithersTaskRunner,
  smithersDurableRunMetadata,
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
  getReadyAcpService,
  getTimeoutMs,
  type HandlerOptionsLike,
  hasExplicitPayload,
  isAuthError,
  labelFor,
  listSessionsWithin,
  logger,
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
import { parseHistoryLimit } from "./tasks-history-limit.js";

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

/**
 * The user's actual words for every fallback that reads the inbound message as
 * request/task text. `hardenIncomingUserMessage` wraps external messages'
 * content.text IN PLACE in the security envelope, so a raw read stores and
 * echoes the armor instead of the request (live leak tj-2dc95f75456876,
 * task e7312d73's originalRequest persisted the whole envelope).
 */
function requestText(message: Memory): string {
  if (typeof message.content === "string") return message.content;
  return unwrapUserMessageText(message);
}

/**
 * Structured pre-spawn refusal. Machine detail rides in `data` (the planner
 * reads it from the tool turn) while `text`/`userFacingText` carry ONLY a
 * short human line that is safe to reach chat verbatim — a redirect
 * instruction in the diagnostic text gets promoted to canonical user-facing
 * copy by the settle wrapper and shipped word-for-word (live leak
 * tj-f1e0716132eb14: the whole "Refused to spawn…" envelope replaced the
 * evaluator's human reply). `awaitingUserInput` marks the refusal as a
 * deliberate pause for direction, not an unresolved failure, so when the
 * planner follows `plannerGuidance` (e.g. WEB_FETCH on a bare link) the
 * successful read owns the turn's reply instead of being overridden by the
 * failure authority.
 */
function spawnRefusalResult(
  code: "EMPTY_TASK_PROMPT" | "LINK_SHARE_NOT_A_TASK",
  humanText: string,
  plannerGuidance: string,
): ActionResult {
  return {
    success: false,
    error: code,
    text: humanText,
    userFacingText: humanText,
    data: { code, awaitingUserInput: true, plannerGuidance },
  };
}

/**
 * A brand-new hosted app belongs to the APP create workflow, which provisions
 * a real scaffold and owns build/browser/publish verification. TASKS remains
 * valid for explicit existing-repository work and for `spawn_agent` (where the
 * user deliberately asked for a raw coding worker). This is a fail-closed
 * boundary after planner selection, not a natural-language shortcut: it stops
 * a mistaken TASKS create from inventing a scratch path and declaring a loose
 * file to be a website while still letting the planner invoke APP normally.
 */
function guardHostedAppCreate(args: {
  runtime: IAgentRuntime;
  operation: TaskOp;
  params: Record<string, unknown>;
  content: Record<string, unknown>;
  fallbackText: string;
}): ActionResult | undefined {
  if (args.operation !== "create") return undefined;
  const registeredActions =
    typeof args.runtime.getAllActions === "function"
      ? args.runtime.getAllActions()
      : (args.runtime.actions ?? []);
  const appActionAvailable = registeredActions.some(
    (action) => action.name.toUpperCase() === "APP",
  );
  if (!appActionAvailable) return undefined;

  // A caller that locks an existing workdir, binds a managed project, or names
  // a repository is intentionally operating on code that already exists.
  if (
    pickBoolean(args.params, args.content, "lockWorkdir") === true ||
    pickString(args.params, args.content, "repo") ||
    pickString(args.params, args.content, "projectId") ||
    pickString(args.params, args.content, "workspaceId")
  ) {
    return undefined;
  }

  const goal = taskParts(args.params, args.content, args.fallbackText).join(
    "\n",
  );
  if (detectTaskType(goal) !== "app-build") return undefined;

  const humanText =
    "I’m switching this to the app builder so it gets a real preview and verification.";
  return {
    success: false,
    error: "HOSTED_APP_NEEDS_APP_BUILDER",
    text: humanText,
    userFacingText: humanText,
    data: {
      code: "HOSTED_APP_NEEDS_APP_BUILDER",
      plannerGuidance:
        "Call APP with action=create and pass the user's website/app request as the intent. APP owns scaffolding, coding-agent dispatch, browser verification, and the live preview/publish result. Do not retry TASKS and do not invent a workdir.",
    },
  };
}

/**
 * Pre-spawn intent gate — fails fast BEFORE any ACP session exists. A coding
 * sub-agent must only be spawned on an explicit instruction. Refuses:
 *
 * 1. An empty/whitespace task prompt: a session spawned with nothing to do
 *    dead-ends its planner and surfaces an opaque "runtime step failed" to the
 *    user (observed live: spawn args with body/instruction/input all empty).
 * 2. A task derived ONLY from a shared link (bare URL, optionally with the
 *    connector's embed preview text, and no explicit work imperative in the
 *    user's own words): a shared link is content to read and react to, not a
 *    work order. The refusal's `data.plannerGuidance` points the planner at
 *    the web-read light path instead.
 *
 * Sub-agent re-spawn turns (router-synthesized inbounds) skip the link check —
 * their root turn was already gated and their task comes from stored metadata.
 */
function guardSpawnTaskIntent(args: {
  task: string;
  originatingText: string;
  isSubAgentRespawn: boolean;
}): ActionResult | undefined {
  if (!args.task.trim()) {
    return spawnRefusalResult(
      "EMPTY_TASK_PROMPT",
      "there's nothing concrete to delegate yet — what do you want built, fixed, or investigated?",
      "Do not spawn a coding sub-agent: the task prompt is empty, so there is nothing to delegate. No session was created. Ask the user what they actually want built, fixed, or investigated before delegating.",
    );
  }
  if (args.isSubAgentRespawn) return undefined;
  if (looksLikeBareLinkShare(args.originatingText)) {
    return spawnRefusalResult(
      "LINK_SHARE_NOT_A_TASK",
      "that's a link, not a task — want me to read it, or do something specific with it?",
      "Do not spawn a coding sub-agent: the user's message is a shared link with no explicit build/fix/code instruction — the candidate task text was derived from the link's embed preview, not from the user. No session was created. Instead, read the page (WEB_FETCH) and respond about its actual content; if it is not fetchable (private or auth-walled), react using the embed title/description already present in the message and ask whether the user wants anything specific done with it.",
    );
  }
  return undefined;
}

async function rejectMissingExplicitWorkdir(
  callback: HandlerCallback | undefined,
  rejectedExplicitWorkdir: string | undefined,
): Promise<ActionResult | undefined> {
  if (!rejectedExplicitWorkdir) return undefined;
  const humanText = `The requested coding workspace does not exist: ${rejectedExplicitWorkdir}. No coding agent was started.`;
  await callbackText(callback, humanText);
  return {
    ...errorResult("WORKDIR_NOT_FOUND", humanText),
    data: {
      code: "WORKDIR_NOT_FOUND",
      rejectedWorkdir: rejectedExplicitWorkdir,
      plannerGuidance:
        "Retry TASKS without a workdir to use an isolated scratch workspace, or provision/create the intended workspace first. Never substitute a different existing repository.",
    },
  };
}

function taskParts(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  fallbackText: string,
): string[] {
  // `task` is the canonical single-worker instruction. Some planners emit an
  // `agents` backend hint alongside it (for example `agents: "elizaos"` even
  // though `agentType` already carries that choice). Never let that overloaded
  // compatibility field replace a concrete task: doing so turns a real build
  // request into the adapter's name. `agents` remains the multi-lane fallback
  // only when no single task was supplied.
  const task = pickString(params, content, "task");
  if (task) return [task];
  const agents = pickString(params, content, "agents");
  if (!agents) return [fallbackText];
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
  const validator = objectValue(params.validator ?? content.validator);
  const maxRetries = params.maxRetries ?? content.maxRetries;
  const onVerificationFail =
    typeof (params.onVerificationFail ?? content.onVerificationFail) ===
    "string"
      ? (params.onVerificationFail ?? content.onVerificationFail)
      : undefined;
  return {
    ...(objectValue(content.metadata) ?? {}),
    ...(objectValue(params.metadata) ?? {}),
    ...(validator ? { validator } : {}),
    ...(typeof maxRetries === "number" && Number.isInteger(maxRetries)
      ? { maxRetries }
      : {}),
    ...(onVerificationFail ? { onVerificationFail } : {}),
  };
}

/**
 * Only the app-verification retry contract may retain a completed one-shot
 * session. The model-facing boolean is deliberately ignored: a live session
 * needs a concrete validator, a bounded retry budget, and a locked verifier
 * workdir matching the task workdir so the coordinator has an owner that will
 * either retry or close it.
 */
function hasVerifiedRetryLifecycle(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  metadata: Record<string, unknown>,
): boolean {
  const validator = objectValue(metadata.validator);
  const validatorParams = objectValue(validator?.params);
  const taskWorkdir = pickString(params, content, "workdir");
  const validatorWorkdir = plainString(validatorParams?.workdir);
  const maxRetries = metadata.maxRetries;
  return (
    validator?.service === "app-verification" &&
    (validator.method === "verifyApp" || validator.method === "verifyPlugin") &&
    metadata.onVerificationFail === "retry" &&
    typeof maxRetries === "number" &&
    Number.isInteger(maxRetries) &&
    maxRetries > 0 &&
    pickBoolean(params, content, "lockWorkdir") === true &&
    taskWorkdir !== undefined &&
    validatorWorkdir === taskWorkdir
  );
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
    // error-policy:J4 task-room mint failed → documented single-room (origin)
    // fallback (same as the opt-out env); warned, so the degrade is observable.
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
// shouldUseSmithersTaskRunner). Terminal events come from AcpService itself;
// structural test doubles and older services are bridged here when needed.
async function runPromptViaSmithers(
  service: ReturnType<typeof getAcpService> & {},
  session: SpawnResult,
  task: string,
  durableRun: SmithersDurableRunLink,
  timeoutMs: number | undefined,
  model: string | undefined,
  keepAliveAfterComplete: boolean,
): Promise<void> {
  const startedAt = Date.now();
  let completed = false;
  try {
    const { lastResponse } = await runDurableTask(service, session, task, {
      tenantId: durableRun.tenantId,
      taskId: durableRun.taskId,
      runId: durableRun.runId,
      timeoutMs,
      model,
      maxTurns: durableRun.maxTurns,
    });
    if (service.emitsPromptTerminalEvents !== true) {
      emitSessionEvent(service, session.sessionId, "task_complete", {
        response: lastResponse,
        durationMs: Date.now() - startedAt,
      });
    }
    completed = true;
  } catch (error) {
    // error-policy:J1 action boundary translates a durable-run failure into the
    // legacy session-event contract before propagating it to TASKS.
    if (service.emitsPromptTerminalEvents !== true) {
      emitSessionEvent(service, session.sessionId, "error", {
        message: failureMessage(error),
      });
    }
    throw error;
  } finally {
    // A custom validator owns the session after the successful terminal event
    // so it can send a corrective prompt on the same ACP conversation. Error
    // paths still close here because no validator completion can follow them.
    if (!(completed && keepAliveAfterComplete)) {
      try {
        await service.stopSession(session.sessionId);
      } finally {
        emitSessionEvent(service, session.sessionId, "stopped", {
          sessionId: session.sessionId,
        });
      }
    }
  }
}

async function runPromptAndClose(
  service: ReturnType<typeof getAcpService> & {},
  session: SpawnResult,
  task: string,
  timeoutMs: number | undefined,
  model: string | undefined,
  keepAliveAfterComplete: boolean,
): Promise<void> {
  const startedAt = Date.now();
  let completed = false;
  try {
    const result = service.sendPrompt
      ? await service.sendPrompt(session.sessionId, task, { timeoutMs, model })
      : await service.sendToSession(session.sessionId, task);
    if (
      result.error ||
      result.stopReason === "error" ||
      result.stopReason === "cancelled" ||
      result.stopReason === "stopped"
    ) {
      const message =
        result.error ??
        (result.stopReason === "cancelled"
          ? "ACP task prompt was cancelled"
          : result.stopReason === "stopped"
            ? "ACP task prompt was stopped"
            : "ACP task prompt failed");
      throw new ElizaError(message, {
        code:
          result.stopReason === "cancelled"
            ? "ACP_TASK_PROMPT_CANCELLED"
            : result.stopReason === "stopped"
              ? "ACP_TASK_PROMPT_STOPPED"
              : "ACP_TASK_PROMPT_FAILED",
        context: {
          sessionId: session.sessionId,
          stopReason: result.stopReason,
        },
        severity: "ephemeral",
      });
    }
    if (service.emitsPromptTerminalEvents !== true) {
      emitSessionEvent(service, session.sessionId, "task_complete", {
        response: result.finalText || result.response,
        durationMs: result.durationMs || Date.now() - startedAt,
        stopReason: result.stopReason,
      });
    }
    completed = true;
  } catch (error) {
    // error-policy:J1 action boundary translates one prompt failure into the
    // legacy session-event contract before propagating it to TASKS. AcpService
    // advertises structural terminal events and therefore bypasses this bridge.
    if (service.emitsPromptTerminalEvents !== true) {
      emitSessionEvent(service, session.sessionId, "error", {
        message: failureMessage(error),
      });
    }
    throw error;
  } finally {
    // See runPromptViaSmithers: validator retries need the same live session.
    if (!(completed && keepAliveAfterComplete)) {
      try {
        await service.stopSession(session.sessionId);
      } finally {
        emitSessionEvent(service, session.sessionId, "stopped", {
          sessionId: session.sessionId,
        });
      }
    }
  }
}

async function runCreateLegacy(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const service = getAcpService(runtime);
  if (!service) {
    // Planner-facing only: the install boilerplate is dev tool-speak in chat
    // next to the evaluator's in-voice reply. The evaluator owns telling the
    // user coding tasks are unavailable.
    return errorResult(
      "SERVICE_UNAVAILABLE",
      "ACP subprocess service is not available (acpx missing or plugin not loaded); tell the user coding tasks cannot run right now.",
    );
  }

  const text = requestText(message);
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
  const maxSmithersTurns = readPositiveInteger(
    params.maxTurns ?? content.maxTurns,
  );
  // A planner-supplied label is free text; clamp like the labelFrom fallback
  // so listings, room names, and progress lines stay bounded.
  const baseLabelParam = pickString(params, content, "label");
  const baseLabel = baseLabelParam
    ? userReferenceLogView(baseLabelParam)
    : undefined;
  const extraMetadata = additionalSessionMetadata(params, content);
  const explicitKeepAliveAfterComplete = hasVerifiedRetryLifecycle(
    params,
    content,
    extraMetadata,
  );
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

  // The durable task must exist before ACP work begins. Its id is the stable
  // owner recorded in every Smithers run link, so a host restart can discover
  // the task/session pair and resume the same graph without reconstructing the
  // action call from transient planner state.
  // Planner-supplied title/goal is unbounded free text (it can be a whole
  // blob); clamp at the persist/display seam — the stored task title and the
  // [TASK:] widget block both render it. labelFrom's fallback is already
  // 80-clamped, so only the params-derived branch needs bounding.
  const plannerTitle =
    pickString(params, content, "title") ?? pickString(params, content, "goal");
  const taskTitle = plannerTitle
    ? userReferenceLogView(plannerTitle)
    : tasks[0]
      ? labelFrom(tasks[0], 0)
      : "Coding task";
  // Goal is an instruction channel (goal-prompt first instruction, acceptance
  // criteria, resume prompts), not display — it must never inherit the title's
  // display clamp, or a long planner title silently truncates the instructions.
  const taskGoal =
    pickString(params, content, "goal") ??
    tasks.join("\n") ??
    plannerTitle ??
    taskTitle;
  const taskPriority = (pickString(params, content, "priority") ?? "normal") as
    | "low"
    | "normal"
    | "high"
    | "urgent";
  const requestedAcceptanceCriteria = pickStringArrayFromInputs(
    params,
    content,
    "acceptanceCriteria",
  );
  // Planner-generated TASKS_CREATE calls usually omit an explicit contract.
  // Seed the durable task with the actual worker instructions instead of the
  // display title/goal, which may be as terse as "Hello Agent V2". This keeps
  // a one-file script task from inheriting the broad coding fallback
  // (typecheck/lint/tests/diff) that can never be proven in a bare workspace.
  const acceptanceCriteria =
    requestedAcceptanceCriteria.length > 0
      ? requestedAcceptanceCriteria
      : staticAcceptanceCriteria(tasks.join("\n"));
  const taskRoomId =
    typeof swarmRoomMetadata.taskRoomId === "string"
      ? swarmRoomMetadata.taskRoomId
      : undefined;
  const originRoomId =
    typeof swarmRoomMetadata.originRoomId === "string"
      ? swarmRoomMetadata.originRoomId
      : undefined;
  const taskService = runtime.getService?.(
    OrchestratorTaskService.serviceType,
  ) as OrchestratorTaskService | null | undefined;
  const hasAutoValidationOwner =
    shouldAutoVerifyGoal() &&
    typeof taskService?.createTask === "function" &&
    typeof taskService?.attachSession === "function" &&
    typeof taskService?.prepareDetachedChildTrace === "function";
  // The durable owner may need to send a corrective turn after the first
  // completion. Keep that ACP transport writable until validation passes;
  // OrchestratorTaskService closes it immediately after the green verdict.
  const keepAliveAfterComplete =
    explicitKeepAliveAfterComplete || hasAutoValidationOwner;
  {
    // Same skip as the spawn path: router-driven synthetic inbounds restate
    // in-flight goals by design; only fresh user-originated creates screen.
    const duplicate =
      content.source !== MESSAGE_SOURCE_SUB_AGENT &&
      extraMetadata.subAgent !== true
        ? await findNearDuplicateInFlightWork({
            runtime,
            taskService,
            candidateText: `${taskTitle} ${taskGoal}`,
            userText: typeof content.text === "string" ? content.text : "",
          })
        : undefined;
    if (duplicate) {
      const replyText = duplicateSpawnReply(duplicate);
      await callbackText(callback, replyText);
      return {
        success: true,
        text: replyText,
        continueChain: false,
        data: { actionName: "TASKS", duplicateSpawnGuard: true },
      };
    }
  }
  const useSmithers = shouldUseSmithersTaskRunner();
  const firstTask = tasks[0]
    ? parseAgentPrefix(tasks[0], baseAgentType).task
    : undefined;
  const initialWorkdirResolution = firstTask
    ? resolveSpawnWorkdir(runtime, firstTask, routingRequest, explicitWorkdir, {
        lockWorkdir: pickBoolean(params, content, "lockWorkdir") === true,
      })
    : undefined;
  const missingWorkdir = await rejectMissingExplicitWorkdir(
    callback,
    initialWorkdirResolution?.rejectedExplicitWorkdir,
  );
  if (missingWorkdir) return missingWorkdir;
  let threadId: string | null = null;
  try {
    if (!taskService || typeof taskService.createTask !== "function") {
      if (useSmithers) {
        throw new ElizaError(
          "Smithers requires the durable orchestrator task service",
          {
            code: "SMITHERS_DURABLE_TASK_SERVICE_UNAVAILABLE",
            context: { taskTitle },
          },
        );
      }
    } else {
      const explicitProjectId = pickString(params, content, "projectId");
      const boundWorkdir = initialWorkdirResolution?.workdir ?? explicitWorkdir;
      const detail = await taskService.createTask({
        title: taskTitle,
        goal: taskGoal,
        kind: "coding",
        priority: taskPriority,
        originalRequest: requestText(message),
        ...(explicitProjectId ? { projectId: explicitProjectId } : {}),
        ...(boundWorkdir ? { workdir: boundWorkdir } : {}),
        ...((originRoomId ?? taskRoomId)
          ? { roomId: originRoomId ?? taskRoomId }
          : {}),
        ...(taskRoomId ? { taskRoomId } : {}),
        acceptanceCriteria,
        metadata: {
          // Persist the originating connector source on the durable record so
          // proactive surfaces (TaskSupervisorService digest) can reach the
          // origin room through a registered send handler.
          ...(typeof content.source === "string" && content.source
            ? { source: content.source }
            : {}),
          ...(objectValue(extraMetadata.lane)
            ? { waveId: extraMetadata.waveId, lane: extraMetadata.lane }
            : {}),
          spawnPath: "create",
          workspaceMutationExpected: workspaceMutationExpected(taskGoal),
        },
      });
      threadId = detail?.id ?? null;
      if (useSmithers && !threadId) {
        throw new ElizaError(
          "Durable task creation returned no task id for Smithers",
          {
            code: "SMITHERS_DURABLE_TASK_MISSING_ID",
            context: { taskTitle },
          },
        );
      }
    }
  } catch (error) {
    // error-policy:J1 the action boundary refuses Smithers execution when its
    // restart owner cannot be persisted; no ACP session or graph side effect
    // exists yet. The explicitly configured direct runner keeps its legacy J4
    // widget-less degradation because it has no durable graph to recover.
    const detail = error instanceof Error ? error.message : String(error);
    if (useSmithers) {
      logger(runtime).error(
        `[TASKS:create] refusing Smithers launch without a durable task: ${detail}`,
      );
      const textOut =
        "I couldn't create the durable task record, so no workflow agent was started. Please retry once task storage is available.";
      await callbackText(callback, textOut);
      return errorResult("SMITHERS_DURABLE_TASK_UNAVAILABLE", textOut);
    }
    logger(runtime).warn(
      `[TASKS:create] durable task thread creation failed: ${detail}`,
    );
    threadId = null;
  }

  const smithersOwnerTaskId = useSmithers ? (threadId ?? undefined) : undefined;
  if (useSmithers && !smithersOwnerTaskId) {
    const textOut =
      "I couldn't establish a durable task owner, so no workflow agent was started.";
    await callbackText(callback, textOut);
    return errorResult("SMITHERS_DURABLE_TASK_UNAVAILABLE", textOut);
  }

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
      const smithersRunId = randomUUID();
      const durableRun: SmithersDurableRunLink | undefined =
        smithersOwnerTaskId === undefined
          ? undefined
          : {
              version: 1,
              orchestratorTaskId: smithersOwnerTaskId,
              taskId: `${smithersOwnerTaskId}:part:${index}`,
              runId: smithersRunId,
              tenantId: runtime.agentId,
              initialPrompt: taskWithRouteHints,
              state: "pending",
              keepAliveAfterComplete,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
              ...(model === undefined ? {} : { model }),
              ...(approvalPreset === undefined ? {} : { approvalPreset }),
              ...(maxSmithersTurns === undefined
                ? {}
                : { maxTurns: maxSmithersTurns }),
            };
      const detachedTrace = hasAutoValidationOwner
        ? taskService.prepareDetachedChildTrace()
        : undefined;
      const session = await service.spawnSession({
        ...(detachedTrace ? { env: detachedTrace.env } : {}),
        agentType,
        workdir: sessionWorkdir,
        isolateWorkdir,
        memoryContent,
        approvalPreset,
        model,
        timeoutMs,
        metadata: {
          ...extraMetadata,
          ...(detachedTrace?.metadata ?? {}),
          ...(originConnectorMessageId ? { originConnectorMessageId } : {}),
          requestedType: baseAgentType,
          messageId: message.id,
          roomId: swarmRoomMetadata.taskRoomId,
          ...swarmRoomMetadata,
          worldId: message.worldId,
          userId: message.entityId,
          label,
          source: content.source,
          // Session-metadata copy of the task (NOT the spawn-option
          // `initialTask`, which would double-deliver the prompt — this path
          // delivers via sendPrompt). The router's recovery valves
          // (retryIncompleteBuild / respawnStateLost) read `meta.initialTask`
          // to reconstruct the work; without this stamp both silently return
          // false on every TASKS:create session and a failed verification
          // posts a failure instead of re-dispatching.
          initialTask: taskWithRouteHints,
          workdirRouteId: route?.id,
          workdirRoute: route,
          keepAliveAfterComplete,
          ...(durableRun ? smithersDurableRunMetadata(durableRun) : {}),
        },
      });

      // Link the already-durable ACP record to its task before the first
      // prompt. If this write fails on the Smithers path, do not execute: boot
      // recovery can reconstruct the missing copy from ACP metadata and start
      // once the store is healthy, without risking an unowned side effect.
      if (
        threadId &&
        taskService &&
        typeof taskService.attachSession === "function"
      ) {
        try {
          const attached = await taskService.attachSession(threadId, {
            sessionId: session.sessionId,
            agentType: session.agentType,
            workdir: session.workdir,
            status: session.status,
            ...(session.metadata ? { metadata: session.metadata } : {}),
            label,
            originalTask: taskWithRouteHints,
            ...(detachedTrace?.env[TRACE_ENV.TRACE_ID]
              ? { traceId: detachedTrace.env[TRACE_ENV.TRACE_ID] }
              : {}),
            ...(detachedTrace?.env[TRACE_ENV.PARENT_STEP_ID]
              ? {
                  parentTrajectoryStepId:
                    detachedTrace.env[TRACE_ENV.PARENT_STEP_ID],
                }
              : {}),
            ...(model ? { model } : {}),
            ...(durableRun ? { durableRun } : {}),
          });
          if (!attached && durableRun) {
            throw new ElizaError(
              "Durable task disappeared before Smithers execution",
              {
                code: "SMITHERS_TASK_LINK_MISSING",
                context: { threadId, sessionId: session.sessionId },
              },
            );
          }
        } catch (error) {
          if (durableRun) {
            try {
              await service.stopSession(session.sessionId);
            } catch (stopError) {
              // error-policy:J6 the attachment failure remains authoritative;
              // stopping an unprompted ACP session is best-effort teardown.
              logger(runtime).warn(
                `[TASKS:create] failed to stop unlinked Smithers session ${session.sessionId}: ${
                  stopError instanceof Error
                    ? stopError.message
                    : String(stopError)
                }`,
              );
            }
            throw error;
          }
          // error-policy:J7 direct-prompt compatibility path: the ACP session
          // still has value when optional widget bookkeeping is unavailable.
          logger(runtime).warn(
            `[TASKS:create] attachSession failed for ${session.sessionId} on task ${threadId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      if (durableRun) {
        const runningRun: SmithersDurableRunLink = {
          ...durableRun,
          state: "running",
        };
        const stateWrites: Promise<unknown>[] = [];
        if (service.updateSessionMetadata) {
          stateWrites.push(
            service.updateSessionMetadata(
              session.sessionId,
              smithersDurableRunMetadata(runningRun),
            ),
          );
        }
        if (threadId && taskService?.updateSmithersDurableRun) {
          stateWrites.push(
            taskService.updateSmithersDurableRun(session.sessionId, runningRun),
          );
        }
        await Promise.all(stateWrites);
        await runPromptViaSmithers(
          service,
          session,
          taskWithRouteHints,
          runningRun,
          timeoutMs,
          model,
          keepAliveAfterComplete,
        );
        const completedRun: SmithersDurableRunLink = {
          ...durableRun,
          state: "completed",
        };
        const completionWrites: Promise<unknown>[] = [];
        if (service.updateSessionMetadata) {
          completionWrites.push(
            service.updateSessionMetadata(
              session.sessionId,
              smithersDurableRunMetadata(completedRun),
            ),
          );
        }
        if (threadId && taskService?.updateSmithersDurableRun) {
          completionWrites.push(
            taskService.updateSmithersDurableRun(
              session.sessionId,
              completedRun,
            ),
          );
        }
        await Promise.all(completionWrites);
      } else {
        await runPromptAndClose(
          service,
          session,
          taskWithRouteHints,
          timeoutMs,
          model,
          keepAliveAfterComplete,
        );
      }
      return { session, label, agentType };
    }),
  );

  const results: Array<Record<string, unknown>> = [];
  const sessions: SpawnResult[] = [];
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") {
      const { session, label } = outcome.value;
      sessions.push(session);
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

  const widgetBlock = threadId
    ? `\n\n[TASK:${threadId}]${taskTitle}[/TASK]`
    : "";
  const proseText = `Created task agent${results.length > 1 ? "s" : ""}.${widgetBlock}`;
  await callbackText(callback, proseText);

  // The creation ack is the complete answer to a single-operation turn:
  // verified + turnComplete make the callback the sole delivery instead of
  // double-messaging with the evaluator's paraphrase.
  return {
    success: true,
    text: proseText,
    userFacingText: proseText,
    verifiedUserFacing: true,
    turnComplete: true,
    data: {
      agents: results,
      taskId: threadId,
      suppressActionResultClipboard: true,
    },
  };
}

async function runCreate(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  // Fail fast on empty/derived-only tasks BEFORE any planner or ACP work; this
  // single gate covers the lane-planner path and every runCreateLegacy fallback.
  // A missing ACP service still wins (SERVICE_UNAVAILABLE) — capability absence
  // outranks input validation, and the legacy path owns that refusal.
  if (getAcpService(runtime)) {
    const guardFallbackText = requestText(message);
    const createGuard = guardSpawnTaskIntent({
      task:
        taskParts(params, content, guardFallbackText)
          .find((part) => part.trim())
          ?.trim() ?? "",
      originatingText:
        (await resolveOriginatingRequestText(runtime, message, state)) ||
        guardFallbackText,
      isSubAgentRespawn: content.source === MESSAGE_SOURCE_SUB_AGENT,
    });
    if (createGuard) return createGuard;
  }

  if (!shouldUseLanePlanner(runtime)) {
    return runCreateLegacy(runtime, message, state, params, content, callback);
  }

  let plan: Awaited<ReturnType<LanePlannerService["plan"]>>;
  try {
    const text = requestText(message);
    const tasks = taskParts(params, content, text);
    const waveId = randomUUID();
    const explicitWorkdir = pickString(params, content, "workdir");
    const planner = new LanePlannerService(
      runtime,
      collisionProviderFromWorkspaceService(getCodingWorkspaceService(runtime)),
    );
    plan = await planner.plan({
      task: pickString(params, content, "task") ?? text,
      tasks,
      dependencies: readLaneDependencies(params, content),
      maxParallel: readPositiveInteger(
        params.maxParallel ?? content.maxParallel,
      ),
      title: pickString(params, content, "title"),
      goal: pickString(params, content, "goal"),
      acceptanceCriteria: pickStringArrayFromInputs(
        params,
        content,
        "acceptanceCriteria",
      ),
      difficultyTag: pickString(params, content, "taskComplexity"),
      waveId,
      workdir: explicitWorkdir,
    });
  } catch (error) {
    if (
      error instanceof ElizaError &&
      (String(error.code).startsWith("LANE_DEPENDENCY_") ||
        error.code === "LANE_PLAN_DEADLOCK")
    ) {
      const msg = failureMessage(error);
      await callbackText(callback, msg);
      return {
        success: false,
        error: error.code,
        text: msg,
        continueChain: false,
      };
    }
    logger(runtime).warn(
      `[TASKS:create] lane planner failed, falling back to legacy single-task behavior: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return runCreateLegacy(runtime, message, state, params, content, callback);
  }

  if (plan.lanes.length <= 1) {
    const lane = plan.lanes[0];
    if (!lane || lane.scopePaths.length === 0) {
      return runCreateLegacy(
        runtime,
        message,
        state,
        params,
        content,
        callback,
      );
    }
  }

  const laneOutcome = await runLanePlan(
    runtime,
    message,
    state,
    params,
    content,
    callback,
    plan,
  );
  if (!laneOutcome.success) return laneOutcome.result;
  const successfulResults = laneOutcome.results;
  return {
    success: true,
    text: `Created ${successfulResults.length} task-agent lanes. They are working asynchronously — no lane result is available yet; results will arrive as follow-up messages.`,
    data: {
      waveId: plan.waveId,
      agents: successfulResults.flatMap((result) =>
        effectRecords(objectValue(result.data)?.agents),
      ),
      lanes: plan.lanes.map((lane, index) => ({
        id: lane.id,
        title: lane.title,
        taskId: successfulResults[index]?.data?.taskId,
        scopePaths: lane.scopePaths,
        forbiddenPaths: lane.forbiddenPaths,
        branchName: lane.branchName,
        dependencies: lane.dependencies,
        collisions: lane.collisions,
      })),
      suppressActionResultClipboard: true,
    },
  };
}

/** Execute a lane plan with dependency-aware admission. maxParallel only gates
 * currently running lanes; ready backlog stays queued until predecessors finish
 * instead of being dropped when capacity is saturated. */
async function runLanePlan(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
  plan: Awaited<ReturnType<LanePlannerService["plan"]>>,
): Promise<
  | { success: true; results: ActionResult[] }
  | { success: false; result: ActionResult }
> {
  const pending = new Map(
    plan.lanes.map((lane, index) => [lane.id, { lane, index }]),
  );
  const completed = new Set<string>();
  const failed = new Set<string>();
  const results = new Array<ActionResult>(plan.lanes.length);
  const active = new Set<Promise<void>>();
  let dependencyFailure: ActionResult | undefined;
  const workspaceService = getCodingWorkspaceService(runtime);
  const reuseTaskId =
    pickString(params, content, "taskId") ??
    pickString(params, content, "threadId");
  const launch = (lane: (typeof plan.lanes)[number], index: number) => {
    const run = (async () => {
      if (workspaceService && reuseTaskId) {
        const activeSession = await workspaceService.findActiveSessionForTask({
          taskId: reuseTaskId,
        });
        if (activeSession) {
          results[index] = {
            success: true,
            text: `Reused active task-agent session ${activeSession.sessionId}.`,
            data: {
              taskId: activeSession.taskId,
              agents: [
                {
                  id: activeSession.sessionId,
                  sessionId: activeSession.sessionId,
                  agentType: activeSession.agentType,
                  workdir: activeSession.workdir,
                  status: activeSession.status,
                  label: lane.title,
                  reused: true,
                },
              ],
              suppressActionResultClipboard: true,
            },
          };
          completed.add(lane.id);
          return;
        }
      }
      results[index] = await runCreateLegacy(
        runtime,
        message,
        state,
        {
          ...params,
          task: lane.initialPrompt,
          agents: undefined,
          title: lane.title,
          goal: lane.initialPrompt,
          taskComplexity: lane.difficultyTag,
          acceptanceCriteria: [...lane.acceptanceCriteria],
          branchName: lane.branchName,
          metadata: {
            ...(objectValue(params.metadata) ?? {}),
            ...laneMetadata(plan, lane),
          },
        },
        laneExecutionContent(content),
        callback,
      );
    })()
      .then((result) => {
        const actionResult = result ?? results[index];
        if (!actionResult) {
          throw new ElizaError("Lane did not produce an action result", {
            code: "LANE_RESULT_MISSING",
            context: { laneId: lane.id },
            severity: "ephemeral",
          });
        }
        if (actionResult.success) completed.add(lane.id);
        else failed.add(lane.id);
      })
      .finally(() => {
        active.delete(run);
      });
    active.add(run);
  };

  while (pending.size > 0 || active.size > 0) {
    let launched = false;
    for (const [id, entry] of [...pending]) {
      if (active.size >= plan.maxParallel) break;
      const readiness = laneReadiness(entry.lane, completed, failed);
      const failedBlocker = readiness.blockers.find((blocker) =>
        blocker.endsWith(": failed"),
      );
      if (failedBlocker) {
        dependencyFailure = {
          success: false,
          error: "LANE_DEPENDENCY_FAILED",
          text: `Lane ${entry.lane.id} blocked by ${failedBlocker}.`,
        };
        pending.clear();
        break;
      }
      if (!readiness.ready) continue;
      pending.delete(id);
      launch(entry.lane, entry.index);
      launched = true;
    }
    if (dependencyFailure) {
      // Already-launched independent lanes remain owned by this action. Wait for
      // them to settle so failures cannot escape as unobserved background work.
      if (active.size > 0) await Promise.allSettled([...active]);
      return { success: false, result: dependencyFailure };
    }
    if (active.size === 0 && !launched) {
      const blocked = [...pending.values()].map(({ lane }) => ({
        laneId: lane.id,
        blockers: laneReadiness(lane, completed, failed).blockers,
      }));
      throw new ElizaError("No lane is ready to launch", {
        code: "LANE_PLAN_DEADLOCK",
        context: { blocked },
        severity: "ephemeral",
      });
    }
    if (active.size > 0) await Promise.race(active);
  }

  for (const result of results) {
    if (!result.success) return { success: false, result };
  }
  return { success: true, results };
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

/** Read planner-supplied lane dependency edges from a strict object:
 * `{ "lane-2": ["lane-1"] }`. Other shapes are ignored so natural-language
 * content cannot accidentally invent graph edges. */
function readLaneDependencies(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
): Record<string, string[]> | undefined {
  const raw = objectValue(params.dependencies ?? content.dependencies);
  if (!raw) return undefined;
  const deps: Record<string, string[]> = {};
  for (const [laneId, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    deps[laneId] = value.filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    );
  }
  return deps;
}

/** Parse numeric planner parameters only when they are explicit positive
 * integers; malformed values fall back to the planner default. */
function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function laneExecutionContent(
  content: Record<string, unknown>,
): Record<string, unknown> {
  const rest = { ...content };
  delete rest.agents;
  return rest;
}

function laneMetadata(
  plan: { waveId: string },
  lane: {
    id: string;
    title: string;
    branchName: string;
    dependencies: string[];
    scopePaths: string[];
    forbiddenPaths: string[];
    collisions: unknown[];
    difficultyTag: string;
  },
): Record<string, unknown> {
  return {
    waveId: plan.waveId,
    lane: {
      id: lane.id,
      title: lane.title,
      branchName: lane.branchName,
      dependencies: [...lane.dependencies],
      scopePaths: lane.scopePaths,
      forbiddenPaths: lane.forbiddenPaths,
      collisions: lane.collisions,
      difficultyTag: lane.difficultyTag,
    },
  };
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

/** The registered project's localPath for a durable task, or null when the task
 * id is absent, the task is unbound, or its project id is stale. Used to lock a
 * follow-up spawn to the same repo the task was bound to. */
/** Read the registered-project id a task is bound to (if any), so the caller
 * can feed it to {@link resolveTaskSpawnWorkdir} and apply the shared
 * project > explicit > bound precedence (#14108). Returns `undefined` for an
 * unbound task, a missing service, or an unknown taskId. */
async function resolveTaskProjectBinding(
  runtime: IAgentRuntime,
  taskId: string | undefined,
): Promise<string | undefined> {
  if (!taskId) return undefined;
  const taskService = runtime.getService?.(
    OrchestratorTaskService.serviceType,
  ) as OrchestratorTaskService | null | undefined;
  if (!taskService || typeof taskService.getTask !== "function")
    return undefined;
  const detail = await taskService.getTask(taskId);
  return detail?.projectId ?? undefined;
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
    const text = requestText(message);
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
    // Fail fast on empty/derived-only tasks BEFORE resolving backends or
    // creating any ACP session (see guardSpawnTaskIntent).
    const spawnGuard = guardSpawnTaskIntent({
      task,
      originatingText: routingRequest || text,
      isSubAgentRespawn: content.source === MESSAGE_SOURCE_SUB_AGENT,
    });
    if (spawnGuard) return spawnGuard;
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
    //
    // A task bound to a registered Project always spawns in that project's
    // localPath: resolve it up-front and pass it as an explicit, LOCKED workdir
    // so route/convention resolution is skipped and every session of the task
    // targets the same repo (the #13776 per-session drift fix). Unbound tasks
    // fall through to the normal explicit/route/convention resolution.
    //
    // Precedence is delegated to the shared resolver so this action path and
    // the direct-service `spawnAgentForTask` path can never diverge on the same
    // operator input (#14108): project localPath > explicit caller workdir >
    // bound pin. When an explicit workdir loses to a project binding the shared
    // resolver logs loudly instead of silently substituting.
    const boundProjectId = await resolveTaskProjectBinding(
      runtime,
      pickString(params, content, "taskId") ??
        pickString(params, content, "threadId"),
    );
    const explicitWorkdir = pickString(params, content, "workdir");
    const resolvedTaskWorkdir = resolveTaskSpawnWorkdir({
      projectId: boundProjectId,
      explicitWorkdir,
      // The action path never reuses the first-spawn pin here; boundWorkdir
      // reuse happens later in the service layer when no explicit workdir is
      // passed. Omitting it keeps unbound tasks falling through to route /
      // convention resolution below.
    });
    const workdirResolution = resolveSpawnWorkdir(
      runtime,
      task,
      routingRequest,
      resolvedTaskWorkdir.workdir ?? explicitWorkdir,
      {
        lockWorkdir:
          resolvedTaskWorkdir.lockWorkdir ||
          pickBoolean(params, content, "lockWorkdir") === true,
      },
    );
    const missingWorkdir = await rejectMissingExplicitWorkdir(
      callback,
      workdirResolution.rejectedExplicitWorkdir,
    );
    if (missingWorkdir) return missingWorkdir;
    const { workdir, route, isolate: resolvedIsolate } = workdirResolution;
    const memoryContent = pickString(params, content, "memoryContent");
    const approvalPreset = parseApproval(
      pickString(params, content, "approvalPreset"),
    );
    const extraMetadata = additionalSessionMetadata(params, content);
    // Structural only: the planner emits deferUserReply when the user asked for
    // no interim reply. No regex over the task text (the model judges intent).
    const deferUserReply =
      pickBoolean(params, content, "deferUserReply") === true;
    // A planner-supplied label is free text; clamp like the derived fallback
    // so listings, room names, and progress lines stay bounded.
    const labelParam = pickString(params, content, "label");
    const label = labelParam
      ? userReferenceLogView(labelParam)
      : task.slice(0, 80);
    const originConnectorMessageId = connectorMessageIdFromMemory(
      message,
      content,
    );
    // Router-driven re-spawns (failed-verification respawn loops) and nested
    // swarm children carry explicit provenance and legitimately restate the
    // in-flight goal — the guard only screens fresh user-originated spawns.
    // Provenance, not room routing, decides durable ownership. A top-level
    // planner may legitimately supply taskRoomId so the new task uses a known
    // thread; that must not make its child look parent-owned and skip the
    // durable row. Router respawns and nested swarm children carry the explicit
    // sub-agent source/metadata signals instead.
    const userOriginatedSpawn =
      content.source !== MESSAGE_SOURCE_SUB_AGENT &&
      extraMetadata.subAgent !== true;
    {
      const spawnTaskService = runtime.getService?.(
        OrchestratorTaskService.serviceType,
      ) as OrchestratorTaskService | null | undefined;
      const duplicate = userOriginatedSpawn
        ? await findNearDuplicateInFlightWork({
            runtime,
            taskService: spawnTaskService,
            candidateText: `${label} ${task}`,
            userText: typeof content.text === "string" ? content.text : "",
          })
        : undefined;
      if (duplicate) {
        const replyText = duplicateSpawnReply(duplicate);
        await callbackText(callback, replyText);
        return {
          success: true,
          text: replyText,
          continueChain: false,
          data: { actionName: "TASKS", duplicateSpawnGuard: true },
        };
      }
    }
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

    const spawnDurableService = userOriginatedSpawn
      ? (runtime.getService?.(OrchestratorTaskService.serviceType) as
          | OrchestratorTaskService
          | null
          | undefined)
      : undefined;
    const hasDurableOwner =
      typeof spawnDurableService?.createTask === "function" &&
      typeof spawnDurableService?.attachSession === "function";
    // A durable top-level task owns automatic validation. Keep its one-shot ACP
    // child writable until that verdict either passes or sends a corrective
    // turn; the task service closes it immediately after a passing verdict.
    const keepAliveAfterComplete =
      hasVerifiedRetryLifecycle(params, content, extraMetadata) ||
      hasDurableOwner;
    // A top-level spawn only receives its durable task id after spawnSession
    // returns. Give the child a unique managed trajectory directory now and
    // persist that directory on the session so the later task attachment can
    // ingest its real FILE/SHELL trace instead of falsely verifying from prose.
    const detachedTrace =
      hasDurableOwner &&
      typeof spawnDurableService.prepareDetachedChildTrace === "function"
        ? spawnDurableService.prepareDetachedChildTrace()
        : undefined;

    const session = await service.spawnSession({
      ...(detachedTrace ? { env: detachedTrace.env } : {}),
      agentType,
      workdir: effectiveWorkdir,
      isolateWorkdir,
      initialTask: taskWithRouteHints,
      monetized: pickBoolean(params, content, "appMonetized") === true,
      memoryContent,
      approvalPreset,
      metadata: {
        ...extraMetadata,
        ...(detachedTrace?.metadata ?? {}),
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

    // Durable restart owner for the fire-and-forget spawn path. Without a
    // task record a runtime restart orphans the live session SILENTLY: the
    // sub-agent's work may finish on disk, but the "result will arrive as a
    // follow-up" promise below dies with the process and nothing resumes or
    // relays (observed live 2026-08-16: the session built its artifact,
    // a restart killed the relay, and no record existed to recover it).
    // create-path tasks persist their owner BEFORE the first prompt;
    // spawn_agent mirrors that contract post-spawn. Only user-originated
    // top-level spawns mint a record — router respawns and swarm children
    // are owned by their parent task. Persistence failure degrades (the
    // session is already running; killing it over bookkeeping would trade
    // a silent-loss bug for a loud-loss one) but is reported loudly.
    let durableTaskId: string | null = null;
    if (userOriginatedSpawn) {
      if (spawnDurableService && hasDurableOwner) {
        try {
          const detail = await spawnDurableService.createTask({
            title: label,
            goal: task,
            kind: "coding",
            priority: "normal",
            // The child is already live at this point. Supply the deterministic
            // contract so createTask cannot block durable ownership on an
            // optional model refinement before attachSession runs.
            acceptanceCriteria: staticAcceptanceCriteria(task),
            originalRequest: requestText(message),
            ...(session.workdir ? { workdir: session.workdir } : {}),
            ...(message.roomId ? { roomId: message.roomId } : {}),
            ...(resolvedTaskRoomId ? { taskRoomId: resolvedTaskRoomId } : {}),
            metadata: {
              ...(resolvedSpawnSource ? { source: resolvedSpawnSource } : {}),
              spawnPath: "spawn_agent",
              workspaceMutationExpected: workspaceMutationExpected(task),
            },
          });
          durableTaskId = detail?.id ?? null;
          if (durableTaskId) {
            await spawnDurableService.attachSession(durableTaskId, {
              sessionId: session.sessionId,
              agentType: session.agentType,
              workdir: session.workdir,
              status: session.status,
              ...(detachedTrace?.env[TRACE_ENV.TRACE_ID]
                ? { traceId: detachedTrace.env[TRACE_ENV.TRACE_ID] }
                : {}),
              ...(detachedTrace?.env[TRACE_ENV.PARENT_STEP_ID]
                ? {
                    parentTrajectoryStepId:
                      detachedTrace.env[TRACE_ENV.PARENT_STEP_ID],
                  }
                : {}),
              ...(session.metadata ? { metadata: session.metadata } : {}),
              label,
              originalTask: taskWithRouteHints,
            });
          }
        } catch (error) {
          // error-policy:J7 durable bookkeeping must not kill the already
          // running session; the gap is surfaced through reportError so the
          // owner sees the restart-durability exposure instead of silence.
          durableTaskId = null;
          runtime.reportError?.(
            "TASKS:spawn_agent",
            error instanceof Error ? error : new Error(String(error)),
            { sessionId: session.sessionId, label },
          );
          logger(runtime).error(
            `[TASKS:spawn_agent] durable task persistence failed for ${session.sessionId}; session runs WITHOUT restart protection: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    // An empty text here left the planner finish with nothing to relay for an
    // async spawn, and it answered the user's question from thin air instead
    // (observed live: fabricated `bun --version` output). State the pending
    // contract as a plain status: it grounds the finish pass AND reads
    // correctly if a transport falls back to this text verbatim (the api
    // response path does when no callback fired), so no planner-directed
    // imperatives here.
    return {
      success: true,
      text: `Spawned coding sub-agent "${label}" (${session.agentType}). It is working asynchronously — its result is not available yet and will arrive as a follow-up message.`,
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
        ...(durableTaskId ? { durableTaskId } : {}),
        deferredUserReply: deferUserReply,
        suppressActionResultClipboard: true,
      },
    };
  } catch (error) {
    // error-policy:J1 spawn action boundary → structured failure to the
    // planner; no visible callback (see runSend's catch) — the evaluator
    // reports the failure in voice instead of a raw canned bubble. The
    // planner echoes `text` toward chat, so producers must keep their
    // messages human (ElizaError with technical fields in `context`);
    // that context is preserved here in the action's error data.
    const messageTextValue = failureMessage(error);
    const code = isAuthError(error)
      ? "INVALID_CREDENTIALS"
      : error instanceof ElizaError
        ? error.code
        : messageTextValue;
    return {
      success: false,
      error: code,
      text: isAuthError(error)
        ? "Task-agent credentials are invalid; tell the user the coding agent could not authenticate."
        : `Failed to spawn agent: ${messageTextValue}`,
      ...(error instanceof ElizaError && error.context
        ? { data: { errorCode: error.code, errorContext: error.context } }
        : {}),
      continueChain: false,
    };
  }
}

// ── action: send (SEND_TO_AGENT) ────────────────────────────────────────────

async function runSend(
  runtime: IAgentRuntime,
  _message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  _callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const service = getAcpService(runtime);
  if (!service) {
    // Planner-facing only throughout runSend: acks and guards are progress
    // notes, not the user's answer — the evaluator's in-voice reply is the
    // turn's single delivery.
    return errorResult("SERVICE_UNAVAILABLE", "ACP service is not available.");
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
        return errorResult(
          "SESSION_NOT_FOUND",
          `Session ${target.missingId} not found.`,
        );
      }
      return errorResult(
        "NO_SESSION",
        "No active task-agent sessions; spawn an agent first.",
      );
    }

    if (keys) {
      await service.sendKeysToSession(target.session.id, keys);
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

    // Planner-input error: the failure reaches the model via the ActionResult
    // and the planner corrects or reports — posting the raw diagnostic mid-turn
    // produced a bare "Failed to send to agent: …" message before the answer.
    return errorResult("NO_INPUT");
  } catch (error) {
    // error-policy:J1 send action boundary → structured failure to the planner;
    // no raw callback text (the turn's final message reports honestly).
    const msg = failureMessage(error);
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
    return errorResult("SERVICE_UNAVAILABLE", "ACP service is not available.");
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
      // The stop confirmation is the complete answer to a single-operation
      // turn: verified + turnComplete make the callback the sole delivery.
      const text = `Stopped ${sessions.length} task agent${sessions.length === 1 ? "" : "s"}.`;
      await callbackText(callback, text);
      return {
        success: true,
        text,
        userFacingText: text,
        verifiedUserFacing: true,
        turnComplete: true,
        data: { stoppedCount: sessions.length },
      };
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
        return errorResult(
          "SESSION_NOT_FOUND",
          `Session ${requestedId} not found.`,
        );
      }
      const noneText = "There are no task agents running.";
      await callbackText(callback, noneText);
      return {
        success: true,
        text: noneText,
        userFacingText: noneText,
        verifiedUserFacing: true,
        turnComplete: true,
      };
    }

    await service.stopSession(target.id);
    if (
      (state as { codingSession?: { id?: string } } | undefined)?.codingSession
        ?.id === target.id
    ) {
      (state as { codingSession?: unknown }).codingSession = undefined;
    }
    const stoppedText = "Stopped the task agent.";
    await callbackText(callback, stoppedText);
    return {
      success: true,
      text: stoppedText,
      userFacingText: stoppedText,
      verifiedUserFacing: true,
      turnComplete: true,
      data: { sessionId: target.id, agentType: String(target.agentType) },
    };
  } catch (error) {
    // error-policy:J1 stop action boundary → structured failure to the
    // planner; the evaluator reports the failure in voice.
    const msg = failureMessage(error);
    return { success: false, error: msg, text: `Failed to stop agent: ${msg}` };
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

  const sessions = await listSessionsWithin(service);
  const preferredTaskAgent = {
    id: String((await service.resolveAgentType?.({})) ?? "codex"),
    reason: "acpx default agent",
  };
  const tasks: Array<Record<string, unknown>> = [];
  const pendingConfirmations = 0;

  if (sessions.length === 0) {
    const text =
      'No active task agents. Use TASKS { action: "create" } when the user needs anything more involved than a simple direct reply.';
    // Read-only query: no visible callback (see history).
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
  // Read-only query: no visible callback. The listing reaches the model via
  // the ActionResult; posting it raw produced a double reply (dump, answer).

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
    return errorResult("SERVICE_UNAVAILABLE", "ACP service is not available.");
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
      // The cancel confirmation is the complete answer to a single-operation
      // turn: verified + turnComplete make the callback the sole delivery.
      const text = `Canceled ${stoppedSessions.length} task${stoppedSessions.length === 1 ? "" : "s"}.`;
      await callbackText(callback, text);
      return {
        success: true,
        text,
        userFacingText: text,
        verifiedUserFacing: true,
        turnComplete: true,
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
      // Planner-facing only: the not-found guard next to the evaluator's
      // in-voice reply was a double message.
      const code = sessionId ? "SESSION_NOT_FOUND" : "TASK_NOT_FOUND";
      return errorResult(
        code,
        sessionId
          ? `Session ${sessionId} not found.`
          : "No matching task found.",
      );
    }

    await (service.cancelSession?.(target.id) ??
      service.stopSession(target.id));
    const id = threadId ?? target.id;
    const text = `Canceled task ${id}.`;
    await callbackText(callback, text);
    return {
      success: true,
      text,
      userFacingText: text,
      verifiedUserFacing: true,
      turnComplete: true,
      data: {
        ...(threadId ? { threadId } : {}),
        sessionId: target.id,
        stoppedSessions: [target.id],
        status: "canceled",
      },
    };
  } catch (error) {
    // error-policy:J1 cancel action boundary → structured failure to the
    // planner; the evaluator reports the failure in voice.
    const msg = failureMessage(error);
    return {
      success: false,
      error: msg,
      text: `Failed to cancel task: ${msg}`,
    };
  }
}

// ── action: history (TASK_HISTORY) ──────────────────────────────────────────

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Sentinel words a weak planner emits for an *absent* structural id filter
 * ("no project", "no session"). Left as-is they become a literal filter — a
 * task query for a project/session named "none" matches nothing — and leak
 * into the reply as "project none" / "that session" (live 2026-08-10: a
 * rhetorical "any burning fires?" routed to TASKS with `projectId:"none"`,
 * answered shaw with the reconstructed junk filter). Only structural id
 * filters normalize these; a free-text `search` term is never coerced.
 */
const ABSENT_FILTER_SENTINELS = new Set([
  "none",
  "null",
  "nil",
  "undefined",
  "n/a",
  "na",
  "any",
  "all",
]);

function filterIdValue(value: unknown): string | undefined {
  const text = textValue(value);
  if (text === undefined) return undefined;
  return ABSENT_FILTER_SENTINELS.has(text.toLowerCase()) ? undefined : text;
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
  if (haystack.includes(needle)) return true;
  // Token-AND fallback: planner-composed searches are noun phrases in the
  // planner's word order ("nubs website"), while the stored title carries the
  // user's ("personal website for nubs") — a whole-phrase substring miss then
  // reads as "no task exists" against a store that plainly holds it (observed
  // live). Every whitespace token present somewhere in the haystack matches.
  const tokens = needle.split(/\s+/).filter((token) => token.length > 0);
  return tokens.length > 1 && tokens.every((token) => haystack.includes(token));
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

/**
 * Explicit user phrasing that overrides the near-duplicate spawn guard — the
 * user is deliberately asking for a repeat/fresh attempt, not accidentally
 * re-describing in-flight work.
 */
export const DUPLICATE_SPAWN_FORCE_RE =
  /\b(?:again|another|fresh|new one|restart|retry|redo|re-?run|one more|from scratch)\b/i;

/** Task statuses that mean the work is still in flight (or parked awaiting a
 * verdict/human) — a near-identical new spawn against one of these is a
 * duplicate, not a new request. */
const IN_FLIGHT_TASK_STATUSES: ReadonlySet<string> = new Set([
  "open",
  "active",
  "validating",
  "waiting_on_user",
  "blocked",
]);

function goalTokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );
}

/** Overlap over the smaller token set — the composed duplicate goal is often a
 * compressed restatement of the original, so containment beats Jaccard here. */
export function goalSimilarity(a: string, b: string): number {
  const tokensA = goalTokenSet(a);
  const tokensB = goalTokenSet(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let overlap = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) overlap += 1;
  }
  return overlap / Math.min(tokensA.size, tokensB.size);
}

const DUPLICATE_SPAWN_SIMILARITY_THRESHOLD = 0.6;

const SLUG_TOKEN_RE = /\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g;

/**
 * Distinct hyphenated slugs veto a near-duplicate match. Quick-app requests
 * share nearly all their phrasing ("build a one-file page in the shared route
 * workdir called <slug>") so token containment crosses the threshold on
 * boilerplate alone — live: "tide-glass" matched a parked "ember-tide" on the
 * shared "tide" token. When BOTH texts name slugs and NEITHER text mentions
 * any of the other's, they are different deliverables, not a re-ask.
 */
export function hasDistinctSlugIdentity(a: string, b: string): boolean {
  const slugsA = new Set(a.toLowerCase().match(SLUG_TOKEN_RE) ?? []);
  const slugsB = new Set(b.toLowerCase().match(SLUG_TOKEN_RE) ?? []);
  if (slugsA.size === 0 || slugsB.size === 0) return false;
  // Boilerplate carries shared hyphenated tokens ("one-file"), so the veto
  // requires each side to name a slug the other lacks — a mutual exclusive
  // identity, not full disjointness.
  const aOnly = [...slugsA].some((slug) => !slugsB.has(slug));
  const bOnly = [...slugsB].some((slug) => !slugsA.has(slug));
  return aOnly && bOnly;
}

/**
 * Cross-request near-duplicate guard for create/spawn. The per-origin spawn cap
 * only anchors ONE user request; a status-shaped follow-up ("so is my site
 * done?? where can i see it") arrives as a NEW message, the planner re-composes
 * a near-identical goal, and a duplicate agent spawns against work that is
 * already in flight or parked validating (observed live: "Nubs mechanical
 * keyboard site" re-spawned while the original build task sat `validating`,
 * then zombied). When a non-terminal task or session with a near-identical
 * goal exists, report it instead of spawning; explicit "again/fresh/retry"
 * phrasing bypasses the guard.
 */
async function findNearDuplicateInFlightWork(args: {
  runtime: IAgentRuntime;
  taskService: OrchestratorTaskService | null | undefined;
  candidateText: string;
  userText: string;
}): Promise<{ name: string; status: string } | undefined> {
  const { runtime, taskService, candidateText, userText } = args;
  if (!candidateText.trim()) return undefined;
  if (DUPLICATE_SPAWN_FORCE_RE.test(userText)) return undefined;
  try {
    if (taskService && typeof taskService.listTasks === "function") {
      const tasks = await taskService.listTasks({});
      for (const task of tasks) {
        if (!IN_FLIGHT_TASK_STATUSES.has(task.status)) continue;
        const existingText = `${task.title} ${task.originalRequest ?? ""}`;
        if (hasDistinctSlugIdentity(candidateText, existingText)) continue;
        if (
          goalSimilarity(candidateText, existingText) >=
          DUPLICATE_SPAWN_SIMILARITY_THRESHOLD
        ) {
          return { name: `"${task.title}"`, status: task.status };
        }
      }
    }
    const service = getAcpService(runtime);
    if (service) {
      for (const session of await listSessionsWithin(service)) {
        if (TERMINAL_SESSION_STATUSES.has(session.status.toLowerCase())) {
          continue;
        }
        const label =
          typeof session.metadata?.label === "string"
            ? session.metadata.label
            : session.name;
        const initialTask =
          typeof session.metadata?.initialTask === "string"
            ? session.metadata.initialTask
            : "";
        const existingText = `${label ?? ""} ${initialTask}`;
        if (hasDistinctSlugIdentity(candidateText, existingText)) continue;
        if (
          goalSimilarity(candidateText, existingText) >=
          DUPLICATE_SPAWN_SIMILARITY_THRESHOLD
        ) {
          return {
            name: label ? `"${label}"` : "a coding session",
            status: session.status.toLowerCase(),
          };
        }
      }
    }
  } catch {
    // error-policy:J4 the guard is best-effort protection; an inspection
    // failure must not block a legitimate spawn.
    return undefined;
  }
  return undefined;
}

function duplicateSpawnReply(duplicate: {
  name: string;
  status: string;
}): string {
  const statusLine =
    duplicate.status === "validating"
      ? "it finished its work and is awaiting completion verification"
      : `its status is ${duplicate.status}`;
  return `That work is already underway: ${duplicate.name} — ${statusLine}. I won't start a duplicate; ask me for its status any time, or say "run it again" if you want a fresh attempt.`;
}

/**
 * Best-effort probe for the empty-history answer: "I found no task threads"
 * while a build is visibly running mid-turn reads as a contradiction in chat
 * (observed live on "what did you just change?" during a build). Prefers the
 * durable candidates the filters excluded, then falls back to any non-terminal
 * ACP session. Returns a chat-safe display name (title/label in quotes — never
 * a raw uuid) plus structural ids for the action data.
 */
async function findInFlightWork(
  runtime: IAgentRuntime,
  candidates: readonly TaskThreadDto[],
): Promise<{ name: string; taskId?: string; sessionId?: string } | undefined> {
  const running = candidates.find(
    (task) =>
      !task.paused &&
      task.activeSessionCount > 0 &&
      (task.status === "active" || task.status === "open"),
  );
  if (running) return { name: `"${running.title}"`, taskId: running.id };
  const service = getAcpService(runtime);
  if (!service) return undefined;
  const active = (await listSessionsWithin(service)).find(
    (session) => !TERMINAL_SESSION_STATUSES.has(session.status.toLowerCase()),
  );
  if (!active) return undefined;
  const label =
    typeof active.metadata?.label === "string"
      ? active.metadata.label
      : active.name;
  return {
    name: label ? `"${label}"` : "a coding task",
    sessionId: active.id,
  };
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

  const text = requestText(message);
  const metric = inferMetric(
    text,
    textValue(params.metric) ?? textValue(content.metric),
  );
  const fallbackLimit = metric === "detail" ? 1 : 10;
  const limit = parseHistoryLimit(params.limit ?? content.limit, fallbackLimit);
  const window = historyWindowValue(params.window ?? content.window);
  const statuses = historyStatusesValue(params.statuses ?? content.statuses);
  const search = textValue(params.search) ?? textValue(content.search);
  // Session-scoped history resolves through the durable session index. A task
  // may have several sessions, so comparing only its latest session would make
  // older sessions disappear or allow an unrelated thread into the answer.
  const sessionId =
    filterIdValue(params.sessionId) ?? filterIdValue(content.sessionId);
  // Registered-project filter: restrict the thread listing to tasks bound to
  // one project (the store filters on the indexed/structural `projectId`).
  const projectId =
    filterIdValue(params.projectId) ?? filterIdValue(content.projectId);
  const includeArchived =
    pickBoolean(params, content, "includeArchived") ?? false;
  const windowFilters = buildWindowFilters(window);
  const taskService = runtime.getService?.(
    OrchestratorTaskService.serviceType,
  ) as OrchestratorTaskService | null | undefined;
  if (taskService && typeof taskService.listTasks === "function") {
    try {
      const sessionTask = sessionId
        ? await taskService.getTaskForSession(sessionId)
        : undefined;
      const taskCandidates =
        sessionId && !sessionTask
          ? []
          : await taskService.listTasks({
              includeArchived,
              ...(search ? { search } : {}),
              ...(projectId ? { projectId } : {}),
            });
      const allTasks = taskCandidates.filter(
        (task) =>
          taskMatchesHistoryFilters(task, statuses, windowFilters, search) &&
          (!sessionTask || task.id === sessionTask.id),
      );
      const count = allTasks.length;
      const tasks = allTasks.slice(0, limit);
      const filterParts = [
        windowFilters.label ? `window ${windowFilters.label}` : undefined,
        statuses.length > 0 ? `statuses ${statuses.join(", ")}` : undefined,
        search ? `search "${search}"` : undefined,
        projectId ? `project ${projectId}` : undefined,
        // The raw session uuid is planner/log detail (kept in data.filters);
        // user-bound text refers to it in plain words.
        sessionId ? "that session" : undefined,
        includeArchived ? "including archived" : undefined,
      ].filter((part): part is string => Boolean(part));
      const filterSuffix =
        filterParts.length > 0 ? ` matching ${filterParts.join("; ")}` : "";

      let responseText = "";
      let inFlight: Awaited<ReturnType<typeof findInFlightWork>> | undefined;
      if (metric === "count") {
        responseText = `I found ${count} orchestrator task${count === 1 ? "" : "s"}${filterSuffix}.`;
      } else if (tasks.length === 0) {
        inFlight = await findInFlightWork(runtime, taskCandidates);
        // Search-matched tasks the status/window filter excluded. A
        // planner-guessed status list ("active, done, failed") silently hides
        // a `validating` task, and the bare "found nothing" then reads as "no
        // task exists" against a store that plainly holds it (observed live).
        // Disclose what the filters hid instead of implying absence.
        const excludedByFilters = taskCandidates
          .filter((task) => !sessionTask || task.id === sessionTask.id)
          .filter(
            (task) =>
              !taskMatchesHistoryFilters(task, statuses, windowFilters, search),
          )
          .slice(0, 3);
        responseText = inFlight
          ? `Nothing has finished yet — I'm still working on ${inFlight.name}.`
          : excludedByFilters.length > 0
            ? [
                `No task threads matched${filterSuffix}, but related tasks exist outside those filters:`,
                ...excludedByFilters.map(
                  (task) => `- "${task.title}" — status=${task.status}`,
                ),
              ].join("\n")
            : `I did not find any orchestrator task threads${filterSuffix}.`;
      } else if (metric === "detail") {
        const task = tasks[0];
        responseText = [
          sessionId
            ? `The orchestrator task for that session is "${task.title}" [${task.status}].`
            : `The most recent orchestrator task is "${task.title}" [${task.status}].`,
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

      // Read-only query: no visible callback. The listing reaches the model
      // via the ActionResult and the user via the planner's final message —
      // posting the raw dump produced a double reply (dump, then answer).
      return {
        success: true,
        text: responseText,
        data: {
          actionName: "TASKS:history",
          count,
          taskIds: tasks.map((task) => task.id),
          ...(inFlight
            ? {
                inFlight: {
                  ...(inFlight.taskId ? { taskId: inFlight.taskId } : {}),
                  ...(inFlight.sessionId
                    ? { sessionId: inFlight.sessionId }
                    : {}),
                },
              }
            : {}),
          filters: {
            metric,
            ...(window ? { window } : {}),
            ...(statuses.length > 0 ? { statuses } : {}),
            ...(search ? { search } : {}),
            ...(projectId ? { projectId } : {}),
            ...(sessionId ? { sessionId } : {}),
            includeArchived,
            limit,
          },
        },
      };
    } catch (error) {
      // error-policy:J1 history action boundary → user-facing error + structured failure.
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
  const sessions = (await listSessionsWithin(service))
    .filter(
      (session) =>
        (!sessionId || session.id === sessionId) &&
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

  // Read-only query: no visible callback (same contract as history).
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

  // Unwrapped: the continue/resume branch below forwards this text to the
  // coding session as the follow-up instruction — it must be the user's words,
  // not the security envelope.
  const text = requestText(message);
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
    // Planner-facing only: the evaluator owns asking the user, in voice.
    const msg =
      "No task-control action was specified; ask the user whether they want to pause, stop, resume, continue, archive, or reopen the task.";
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
        // error-policy:J1 control action boundary → warns + structured failure
        // to the planner; the evaluator reports the failure in voice.
        const errMsg = err instanceof Error ? err.message : String(err);
        coreLogger.warn(`[TASKS:control] resume failed: ${errMsg}`);
        const out = `Failed to resume coding task ${controlTaskId}: ${errMsg}`;
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
      const out = "Resumed the coding task.";
      if (callback) await callback({ text: out });
      return {
        success: true,
        // Planner-facing text keeps the id for follow-ups; the visible layer
        // stays human.
        text: `Resumed coding task ${controlTaskId}`,
        userFacingText: out,
        verifiedUserFacing: true,
        turnComplete: true,
        data: {
          actionName: "TASKS:control",
          action,
          taskId: controlTaskId,
          task: resumedTask,
        },
      };
    }
    // Planner-facing only: the not-found guard next to the evaluator's
    // in-voice reply was a double message.
    const msg = target.missingId
      ? `Session ${target.missingId} not found.`
      : "No active ACP session found.";
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
    responseText = "Stopped the coding task.";
  } else {
    const nextInstruction =
      instruction?.trim() || "Continue with the current task.";
    await service.sendToSession(target.session.id, nextInstruction);
    responseText = "Passed your follow-up instructions to the coding agent.";
    data = { ...data, instruction: nextInstruction };
  }

  // The control outcome is the complete answer to a single-operation turn:
  // verified + turnComplete make the callback the sole delivery.
  if (callback) await callback({ text: responseText });
  return {
    success: true,
    text: responseText,
    userFacingText: responseText,
    verifiedUserFacing: true,
    turnComplete: true,
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

  // No visible callback: session internals and absolute paths are
  // planner-facing detail — the evaluator voices what the user needs.
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
  // Planner-facing only for these guards: canned parameter clarifications in
  // chat next to the evaluator's in-voice reply were a double message.
  if (!repo && !useWorktree) {
    return {
      success: false,
      error: "MISSING_REPO",
      text: "No repository URL found in the request; ask the user which repository to provision (or to use worktree mode with a parent workspace).",
    };
  }

  if (repo) {
    repo = normalizeRepositoryInput(repo);
    const ALLOWED_DOMAINS =
      /^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//i;
    if (!ALLOWED_DOMAINS.test(repo)) {
      return {
        success: false,
        error: "INVALID_REPO_DOMAIN",
        text: "The repository URL is not from github.com, gitlab.com, or bitbucket.org; ask the user for a supported repository URL.",
      };
    }
  }

  let parentWorkspaceId = paramParentWorkspaceId ?? content.parentWorkspaceId;
  if (useWorktree && !parentWorkspaceId) {
    if (state?.codingWorkspace) {
      parentWorkspaceId = (state.codingWorkspace as { id: string }).id;
    } else {
      return {
        success: false,
        error: "MISSING_PARENT",
        text: "Worktree mode requires a parent workspace; ask the user to clone a repo first or provide parentWorkspaceId.",
      };
    }
  }
  if (useWorktree && !repo && parentWorkspaceId) {
    const parentWorkspace = workspaceService.getWorkspace(parentWorkspaceId);
    if (!parentWorkspace) {
      return {
        success: false,
        error: "WORKSPACE_NOT_FOUND",
        text: `Parent workspace ${parentWorkspaceId} not found.`,
      };
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

    const createdText =
      `Created workspace at ${workspace.path.slice(0, WORKSPACE_PATH_MAX_CHARS)}\n` +
      `Branch: ${workspace.branch}\n` +
      `Type: ${workspace.isWorktree ? "worktree" : "clone"}`;
    if (callback) await callback({ text: createdText });

    // The provisioning confirmation is the complete answer to a
    // single-operation turn: verified + turnComplete make the callback the
    // sole delivery.
    return {
      success: true,
      text: createdText,
      userFacingText: createdText,
      verifiedUserFacing: true,
      turnComplete: true,
      data: {
        workspaceId: workspace.id,
        path: workspace.path.slice(0, WORKSPACE_PATH_MAX_CHARS),
        branch: workspace.branch,
        isWorktree: workspace.isWorktree,
      },
    };
  } catch (error) {
    // error-policy:J1 provision action boundary → user-facing error + structured failure.
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
      // Planner-facing only: the guard next to the evaluator's in-voice reply
      // was a double message.
      return {
        success: false,
        error: "NO_WORKSPACE",
        text: "No workspaces available; provision a workspace first.",
      };
    }
    workspaceId = workspaces[workspaces.length - 1].id;
  }

  const workspace = workspaceService.getWorkspace(workspaceId);
  if (!workspace) {
    return {
      success: false,
      error: "WORKSPACE_NOT_FOUND",
      text: `Workspace ${workspaceId} not found.`,
    };
  }

  try {
    const status = await workspaceService.getStatus(workspaceId);

    if (status.clean && status.staged.length === 0) {
      const noChangesText = "No changes to commit in this workspace.";
      if (callback) await callback({ text: noChangesText });
      return {
        success: true,
        text: noChangesText,
        userFacingText: noChangesText,
        verifiedUserFacing: true,
        turnComplete: true,
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

    const finalizedText = prInfo
      ? `Workspace finalized!\n` +
        `Commit: ${commitHash.slice(0, 8)}\n` +
        `PR #${prInfo.number}: ${prInfo.url}`
      : `Workspace changes committed and pushed.\n` +
        `Commit: ${commitHash.slice(0, 8)}`;
    if (callback) await callback({ text: finalizedText });

    // The finalize confirmation is the complete answer to a single-operation
    // turn: verified + turnComplete make the callback the sole delivery.
    return {
      success: true,
      text: finalizedText,
      userFacingText: finalizedText,
      verifiedUserFacing: true,
      turnComplete: true,
      data: {
        workspaceId,
        commitHash,
        pr: prInfo ? { number: prInfo.number, url: prInfo.url } : undefined,
      },
    };
  } catch (error) {
    // error-policy:J1 submit action boundary → structured failure to the
    // planner; the evaluator reports the failure in voice.
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: "FINALIZE_FAILED",
      text: `Failed to finalize workspace: ${errorMessage}`,
    };
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

/**
 * Create an issue with labels applied as a SEPARATE best-effort step. Labels
 * on GitHub's create call require push/triage access, so a read-tier token
 * fails the ENTIRE creation over a decoration (live incident 2026-08-10: a
 * good issue died on "You do not have permission to create labels"). Title
 * and body always land; a label failure degrades to a short note.
 */
export async function createIssueWithBestEffortLabels(
  service: CodingWorkspaceService,
  repo: string,
  options: { title: string; body: string; labels: string[] },
): Promise<{ issue: IssueInfo; labelNote: string }> {
  const issue = await service.createIssue(repo, {
    title: options.title,
    body: options.body,
  });
  if (options.labels.length === 0) return { issue, labelNote: "" };
  try {
    await service.addLabels(repo, issue.number, options.labels);
    return { issue, labelNote: "" };
  } catch {
    // error-policy:J4 labels are decoration; the created issue is the
    // deliverable and a label-permission failure must not fail the turn.
    return { issue, labelNote: " (labels skipped — no permission)" };
  }
}

/**
 * One in-voice line for a failed issue operation. The raw provider error
 * stays in the returned `error` field for the planner and in logs — chat
 * gets a human sentence, never API JSON and docs links.
 */
export function issueFailureReply(repo: string, errorMessage: string): string {
  if (/permission|unauthorized|forbidden|403/i.test(errorMessage)) {
    return `couldn't do that on ${repo} — the connected github account doesn't have permission for it.`;
  }
  if (/not found|404/i.test(errorMessage)) {
    return `couldn't find that on ${repo} — the repo or issue doesn't exist (or isn't visible to the connected account).`;
  }
  return `couldn't finish that github operation on ${repo}. logged the details.`;
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
            let bulkLabelNote = "";
            for (const item of items.slice(0, ISSUE_RESULT_LIMIT)) {
              const { issue, labelNote } =
                await createIssueWithBestEffortLabels(service, repo, {
                  title: item.title,
                  body: item.body ?? "",
                  labels,
                });
              if (labelNote) bulkLabelNote = labelNote;
              created.push(issue);
            }
            // Create/list/get answers are the complete answer to the turn:
            // verified + turnComplete make the callback the sole delivery.
            // Missing-param clarifications stay planner-facing — the
            // evaluator owns asking the user, in voice.
            const summary = created
              .map((i) => `#${i.number}: ${i.title}\n  ${i.url}`)
              .join("\n");
            // The chat confirmation stays clean; a label degrade is recorded
            // planner-side (`text` + data) so the model can answer honestly
            // if asked, without machinery notes in the user's message.
            const bulkText = `Created ${created.length} issues:\n${summary}`;
            if (callback) await callback({ text: bulkText });
            return {
              success: true,
              text: bulkLabelNote
                ? `${bulkText}\n(requested labels not applied: no label permission on ${repo})`
                : bulkText,
              userFacingText: bulkText,
              verifiedUserFacing: true,
              turnComplete: true,
              data: { issues: created, labelsApplied: !bulkLabelNote },
            };
          }

          return {
            success: false,
            error: "MISSING_TITLE",
            text: "No issue title found in the request; ask the user what the issue title should be.",
          };
        }

        const labels = parseLabels(params.labels);
        const { issue, labelNote } = await createIssueWithBestEffortLabels(
          service,
          repo,
          { title, body: body ?? "", labels },
        );
        // Clean human confirmation only; the label degrade stays
        // planner-side (`text` + data) — no machinery notes in chat.
        const createdText = `Created issue #${issue.number}: ${issue.title}\n${issue.url}`;
        if (callback) await callback({ text: createdText });
        return {
          success: true,
          text: labelNote
            ? `${createdText}\n(requested labels not applied: no label permission on ${repo})`
            : createdText,
          userFacingText: createdText,
          verifiedUserFacing: true,
          turnComplete: true,
          data: { issue, labelsApplied: !labelNote },
        };
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
        const listText =
          issues.length === 0
            ? `No ${stateFilter} issues found in ${repo}.`
            : `Issues in ${repo}:\n${issues
                .map(
                  (i) =>
                    `#${i.number} [${i.state}] ${i.title}${i.labels.length > 0 ? ` (${i.labels.join(", ")})` : ""}`,
                )
                .join("\n")}`;
        // Reads remain planner-visible because this lookup may feed a later
        // issue mutation. The final boundary synthesizes a standalone read
        // answer when the trajectory has no follow-up work.
        return {
          success: true,
          text: listText,
          data: { issues },
        };
      }

      case "get": {
        const issueNumber = Number(params.issueNumber);
        if (!issueNumber) {
          return {
            success: false,
            error: "MISSING_ISSUE_NUMBER",
            text: "No issue number found in the request; ask the user which issue they mean.",
          };
        }
        const issue = await service.getIssue(repo, issueNumber);
        const issueText = `Issue #${issue.number}: ${issue.title} [${issue.state}]\n\n${issue.body.slice(0, ISSUE_BODY_MAX_CHARS)}\n\nLabels: ${issue.labels.join(", ") || "none"}\n${issue.url}`;
        return {
          success: true,
          text: issueText,
          data: { issue },
        };
      }

      case "update": {
        const issueNumber = Number(params.issueNumber);
        if (!issueNumber) {
          return {
            success: false,
            error: "MISSING_ISSUE_NUMBER",
            text: "No issue number found in the request; ask the user which issue they mean.",
          };
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
          return {
            success: false,
            error: "MISSING_PARAMS",
            text: "Missing the issue number or comment body; ask the user for both.",
          };
        }
        const comment = await service.addComment(repo, issueNumber, body);
        const commentedText = `Added comment to issue #${issueNumber}: ${comment.url}`;
        if (callback) await callback({ text: commentedText });
        // Settled like create/list/get: the callback is the sole delivery, so
        // the planner does not append a second "done, commented" bubble
        // (live double-message 2026-08-10, same class as the create paths).
        return {
          success: true,
          text: commentedText,
          userFacingText: commentedText,
          verifiedUserFacing: true,
          turnComplete: true,
          data: { comment },
        };
      }

      case "close": {
        const issueNumber = Number(params.issueNumber);
        if (!issueNumber) {
          return {
            success: false,
            error: "MISSING_ISSUE_NUMBER",
            text: "No issue number found in the request; ask the user which issue they mean.",
          };
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
          return {
            success: false,
            error: "MISSING_ISSUE_NUMBER",
            text: "No issue number found in the request; ask the user which issue they mean.",
          };
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
          return {
            success: false,
            error: "MISSING_PARAMS",
            text: "Missing the issue number or labels; ask the user for both.",
          };
        }
        const issue = await service.addLabels(repo, issueNumber, labels);
        if (callback)
          await callback({
            text: `Added labels [${labels.join(", ")}] to issue #${issueNumber}`,
          });
        return { success: true, data: { issue } };
      }

      default:
        if (callback)
          await callback({
            text: `Unknown issue action: ${action}. Use: create, list, get, update, comment, close, reopen, add_labels`,
          });
        return { success: false, error: "UNKNOWN_OPERATION" };
    }
  } catch (error) {
    // error-policy:J1 issue-operation boundary → in-voice user line +
    // structured failure. The raw provider message stays planner/log-facing
    // only: shipping API JSON and docs links to chat was the 2026-08-10
    // incident's second half.
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (callback)
      await callback({ text: issueFailureReply(repo, errorMessage) });
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

  // Unwrapped: bulk-issue extraction and action/repo inference read this as
  // the user's request; a raw envelope read would mint GitHub issues out of
  // security-notice lines (and the slice could truncate the real payload).
  const text = requestText(message).slice(0, ISSUE_BODY_MAX_CHARS);

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
    // error-policy:J1 lifecycle action boundary → warns + user-facing error +
    // structured failure result.
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

type TasksEffectProof = {
  commitId: string;
  commitKind: "durable" | "provider_accepted";
  resource: { kind: string; id: string };
  artifacts?: Array<{ kind: string; id: string }>;
};

type CapturedCallback = {
  response: Content;
  actionName?: string;
};

const TASKS_READ_ONLY_OPERATIONS: ReadonlySet<TaskOp> = new Set([
  "list_agents",
  "history",
  "share",
]);

const TASKS_REJECTED_FAILURE_CODES: ReadonlySet<string> = new Set([
  "EMPTY_TASK_PROMPT",
  "FORBIDDEN",
  "HOSTED_APP_NEEDS_APP_BUILDER",
  "INVALID_CREDENTIALS",
  "INVALID_REPO_DOMAIN",
  "LINK_SHARE_NOT_A_TASK",
  "MISSING_INPUT",
  "MISSING_ISSUE_NUMBER",
  "MISSING_PARAMS",
  "MISSING_PARENT",
  "MISSING_REPO",
  "MISSING_TASK_ID",
  "MISSING_TITLE",
  "NO_INPUT",
  "NO_SESSION",
  "NO_WORKSPACE",
  "SESSION_NOT_FOUND",
  "SERVICE_UNAVAILABLE",
  "SMITHERS_DURABLE_TASK_UNAVAILABLE",
  "TASK_NOT_FOUND",
  "TASK_HISTORY_FAILED",
  "UNKNOWN_OPERATION",
  "UNSUPPORTED_OPERATION",
  "WORKSPACE_NOT_FOUND",
]);

function effectString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function effectNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function effectRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .map((entry) => objectValue(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
}

function uniqueEffectRefs(
  refs: Array<{ kind: string; id: string }>,
): Array<{ kind: string; id: string }> {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function issueOperation(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
): string {
  const topLevelAction =
    effectString(params.action) ?? effectString(content.action);
  const normalizedTopLevelAction = topLevelAction
    ?.toLowerCase()
    .replace(/-/g, "_");
  return (
    effectString(params.issueAction) ??
    effectString(content.issueAction) ??
    (topLevelAction && normalizedTopLevelAction !== "manage_issues"
      ? topLevelAction
      : undefined) ??
    inferIssueAction(effectString(content.text) ?? "")
  ).toLowerCase();
}

function isIssueReadOperation(
  operation: TaskOp,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
): boolean {
  if (operation !== "manage_issues") return false;
  const issueAction = issueOperation(params, content);
  return issueAction === "list" || issueAction === "get";
}

function tasksNoopReason(
  operation: TaskOp,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  result: ActionResult,
): string | undefined {
  if (result.success && TASKS_READ_ONLY_OPERATIONS.has(operation)) {
    return "The operation only read orchestrator state.";
  }
  const data = objectValue(result.data) ?? {};
  if (result.success && isIssueReadOperation(operation, params, content)) {
    return "The operation only read provider issue state.";
  }
  if (
    operation === "submit_workspace" &&
    result.success &&
    !effectString(data.commitHash)
  ) {
    return "The workspace had no changes to submit.";
  }
  if (
    operation === "spawn_agent" &&
    result.success &&
    data.spawnCapped === true
  ) {
    return "The spawn cap reused an already captured result.";
  }
  if (
    operation === "create" &&
    result.success &&
    effectRecords(data.agents).length > 0 &&
    effectRecords(data.agents).every((agent) => agent.reused === true)
  ) {
    return "Every requested lane reused an active task-agent session.";
  }
  if (
    operation === "stop_agent" &&
    result.success &&
    (data.stoppedCount === 0 || result.text === "No sessions to stop")
  ) {
    return "There were no active sessions to stop.";
  }
  if (operation === "cancel" && result.success && data.canceledCount === 0) {
    return "There were no active tasks to cancel.";
  }
  return undefined;
}

function issueEffectProof(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  data: Record<string, unknown>,
): TasksEffectProof | undefined {
  const op = issueOperation(params, content);
  if (op === "list" || op === "get") return undefined;
  const repo = effectString(params.repo) ?? effectString(content.repo);
  const issue = objectValue(data.issue);
  const issueRecords = [
    ...(issue ? [issue] : []),
    ...effectRecords(data.issues),
  ];
  const issueRefs = issueRecords
    .map((issue) => {
      const number = effectNumber(issue.number);
      const url = effectString(issue.url);
      const id = url ?? (number && repo ? `${repo}#${number}` : undefined);
      return id ? { kind: "github.issue", id } : undefined;
    })
    .filter((ref): ref is { kind: string; id: string } => ref !== undefined);
  const comment = objectValue(data.comment);
  const commentUrl = effectString(comment?.url);
  if (commentUrl) {
    return {
      commitId: commentUrl,
      commitKind: "provider_accepted",
      resource: { kind: "github.issue-comment", id: commentUrl },
    };
  }
  const refs = uniqueEffectRefs(issueRefs);
  if (refs.length === 0) return undefined;
  return {
    commitId: refs[0].id,
    commitKind: "provider_accepted",
    resource: refs[0],
    artifacts: refs.slice(1),
  };
}

function tasksEffectProof(
  operation: TaskOp,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  result: ActionResult,
): TasksEffectProof | undefined {
  const data = objectValue(result.data) ?? {};
  if (operation === "manage_issues") {
    return issueEffectProof(params, content, data);
  }
  if (operation === "provision_workspace") {
    const workspaceId = effectString(data.workspaceId);
    return workspaceId
      ? {
          commitId: workspaceId,
          commitKind: "durable",
          resource: { kind: "coding.workspace", id: workspaceId },
        }
      : undefined;
  }
  if (operation === "submit_workspace") {
    const workspaceId = effectString(data.workspaceId);
    const commitHash = effectString(data.commitHash);
    if (!workspaceId || !commitHash) return undefined;
    const pullRequest = objectValue(data.pr);
    const pullRequestUrl = effectString(pullRequest?.url);
    const pullRequestNumber = effectNumber(pullRequest?.number);
    const pullRequestId =
      pullRequestUrl ??
      (pullRequestNumber ? `pull-request:${pullRequestNumber}` : undefined);
    return {
      commitId: commitHash,
      commitKind: "provider_accepted",
      resource: { kind: "coding.workspace", id: workspaceId },
      artifacts: pullRequestId
        ? [{ kind: "github.pull-request", id: pullRequestId }]
        : [],
    };
  }
  if (operation === "archive" || operation === "reopen") {
    const taskId = effectString(data.taskId);
    return taskId && objectValue(data.task)
      ? {
          commitId: taskId,
          commitKind: "durable",
          resource: { kind: "orchestrator.task", id: taskId },
        }
      : undefined;
  }
  if (operation === "control") {
    const controlAction =
      normalizeControlAction(
        effectString(params.controlAction) ??
          effectString(content.controlAction),
      ) ?? "continue";
    const taskId = effectString(data.taskId);
    const sessionId = effectString(data.sessionId);
    if (
      taskId &&
      (controlAction === "pause" ||
        ((controlAction === "resume" || controlAction === "continue") &&
          !sessionId))
    ) {
      return {
        commitId: taskId,
        commitKind: "durable",
        resource: { kind: "orchestrator.task", id: taskId },
      };
    }
    return undefined;
  }
  if (operation === "spawn_agent") {
    const sessionId = effectString(data.sessionId);
    return sessionId
      ? {
          commitId: sessionId,
          commitKind: "provider_accepted",
          resource: { kind: "acp.session", id: sessionId },
        }
      : undefined;
  }
  if (operation === "create") {
    const taskRefs = [
      effectString(data.taskId),
      ...effectRecords(data.lanes).map((lane) => effectString(lane.taskId)),
    ]
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ kind: "orchestrator.task", id }));
    const sessionRefs = effectRecords(data.agents)
      .filter((agent) => agent.status !== "failed" && agent.reused !== true)
      .map((agent) => effectString(agent.sessionId) ?? effectString(agent.id))
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ kind: "acp.session", id }));
    const refs = uniqueEffectRefs([...taskRefs, ...sessionRefs]);
    if (refs.length === 0) return undefined;
    const durable = refs.find((ref) => ref.kind === "orchestrator.task");
    const resource = durable ?? refs[0];
    return {
      commitId: resource.id,
      commitKind: durable ? "durable" : "provider_accepted",
      resource,
      artifacts: refs.filter(
        (ref) => ref.kind !== resource.kind || ref.id !== resource.id,
      ),
    };
  }
  return undefined;
}

function tasksReceiptBase(
  operation: TaskOp,
  resource: { kind: string; id: string },
) {
  return {
    receiptId: randomUUID(),
    operation: `agent-orchestrator.tasks.${operation}`,
    resource,
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt: new Date().toISOString(),
  } as const;
}

function tasksEffectReceipt(args: {
  operation: TaskOp;
  message: Memory;
  params: Record<string, unknown>;
  content: Record<string, unknown>;
  result: ActionResult;
}): { receipt: EffectReceipt; outcomeUnknown: boolean } {
  const requestId = effectString(args.message.id) ?? randomUUID();
  const noopReason = tasksNoopReason(
    args.operation,
    args.params,
    args.content,
    args.result,
  );
  if (noopReason) {
    return {
      receipt: {
        ...tasksReceiptBase(args.operation, {
          kind: "orchestrator.request",
          id: requestId,
        }),
        outcome: "noop",
        reason: noopReason,
      },
      outcomeUnknown: false,
    };
  }
  const proof = tasksEffectProof(
    args.operation,
    args.params,
    args.content,
    args.result,
  );
  if (proof) {
    const observedAt = new Date().toISOString();
    return {
      receipt: {
        ...tasksReceiptBase(args.operation, proof.resource),
        artifacts: proof.artifacts ?? [],
        observedAt,
        outcome: "applied",
        commit: {
          kind: proof.commitKind,
          id: proof.commitId,
          committedAt: observedAt,
        },
      },
      outcomeUnknown: false,
    };
  }
  const errorCode =
    effectString(args.result.error) ?? "AUTHORITATIVE_RECEIPT_MISSING";
  const rejected =
    args.result.success === false &&
    TASKS_REJECTED_FAILURE_CODES.has(errorCode);
  return {
    receipt: {
      ...tasksReceiptBase(args.operation, {
        kind: "orchestrator.request",
        id: requestId,
      }),
      outcome: "failed",
      failure: {
        code: errorCode,
        retryable: false,
        acceptance: rejected ? "rejected" : "unknown",
      },
    },
    outcomeUnknown: !rejected,
  };
}

function unverifiedTasksText(operation: TaskOp): string {
  return (
    `The ${operation.replaceAll("_", " ")} request may have reached its target, ` +
    "but no authoritative commit receipt was returned. Verify the external state before retrying."
  );
}

async function settleTasksOperation(args: {
  operation: TaskOp;
  message: Memory;
  params: Record<string, unknown>;
  content: Record<string, unknown>;
  result: ActionResult;
  capturedCallbacks: CapturedCallback[];
  callback?: HandlerCallback;
}): Promise<ActionResult> {
  // A read-only op's text is planner observation, never a user reply: keep it
  // out of the canonical callback so the planner composes the answer instead of
  // shipping the raw tool text. Covers the GitHub-issue reads (#18248) AND the
  // orchestrator reads that share the same "no visible callback" contract —
  // list_agents/history/share — whose internal text otherwise leaks verbatim
  // (live 2026-08-10: a status-y ask routed to list_agents shipped
  // "No active task agents. Use TASKS { action: \"create\" }..." to chat).
  const plannerOnlyRead =
    TASKS_READ_ONLY_OPERATIONS.has(args.operation) ||
    isIssueReadOperation(args.operation, args.params, args.content);
  const { receipt, outcomeUnknown } = tasksEffectReceipt(args);
  const {
    userFacingText: _readUserFacingText,
    verifiedUserFacing: _readVerifiedUserFacing,
    turnComplete: _readTurnComplete,
    ...plannerOnlyResult
  } = args.result;
  let result = plannerOnlyRead ? plannerOnlyResult : args.result;
  const helperEmittedCallback =
    !plannerOnlyRead && args.capturedCallbacks.length > 0;
  let canonical = helperEmittedCallback
    ? args.capturedCallbacks.at(-1)
    : undefined;
  if (!plannerOnlyRead && !canonical && effectString(result.text)) {
    canonical = { response: { text: effectString(result.text) } };
  }
  if (
    !plannerOnlyRead &&
    args.capturedCallbacks.length > 1 &&
    effectString(result.text) !== undefined
  ) {
    canonical = {
      response: {
        ...canonical?.response,
        text: effectString(result.text),
      },
      actionName: canonical?.actionName,
    };
  }
  if (result.success && receipt.outcome === "failed") {
    const text = unverifiedTasksText(args.operation);
    result = {
      ...result,
      text,
    };
    canonical = {
      response: { ...(canonical?.response ?? {}), text },
      actionName: canonical?.actionName,
    };
  } else if (outcomeUnknown && result.success === false) {
    result = {
      ...result,
      data: {
        ...(objectValue(result.data) ?? {}),
        outcomeUnknown: true,
        retryable: false,
        reconciliationRequired: true,
      },
    };
  }

  // A failed op keeps its canonical text as a plain user-facing projection but
  // never the `verifiedUserFacing` do-not-paraphrase license: that license
  // outranks the evaluator's own reply at the terminal boundary, and granting
  // it to an undelivered failure shipped the LINK_SHARE_NOT_A_TASK redirect
  // envelope to chat word-for-word OVER the evaluator's correct human line
  // (live tj-f1e0716132eb14). Receipt binding follows the license: a failed
  // receipt proves nothing the exact text is entitled to claim.
  const effectResult: ActionResult = {
    ...result,
    effectReceipts: [receipt],
    ...(canonical?.response.text
      ? result.success !== false
        ? {
            userFacingText: canonical.response.text,
            verifiedUserFacing: true,
            userFacingEffectReceiptIds: [receipt.receiptId],
          }
        : { userFacingText: canonical.response.text }
      : {}),
  };
  if (canonical && args.callback && helperEmittedCallback) {
    await args.callback(canonical.response, canonical.actionName);
  }
  return effectResult;
}

async function dispatchTasksOperation(
  action: TaskOp,
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  switch (action) {
    case "create":
      return runCreate(runtime, message, state, params, content, callback);
    case "spawn_agent":
      return runSpawnAgent(runtime, message, state, params, content, callback);
    case "send":
      return runSend(runtime, message, state, params, content, callback);
    case "stop_agent":
      return runStopAgent(runtime, message, state, params, content, callback);
    case "list_agents":
      return runListAgents(runtime, message, state, params, content, callback);
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
  }
}

// ── parent action ──────────────────────────────────────────────────────

export const tasksAction: Action & {
  suppressPostActionContinuation: true;
  suppressEarlyReply: true;
  asyncHandoff: true;
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
    "effect:receipt-required",
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
    // Stage-1 nominates provider-prefixed issue aliases before the child is
    // exposed, so the parent must own them for issue management to remain
    // reachable.
    "MANAGE_ISSUES",
    "CREATE_ISSUE",
    "LIST_ISSUES",
    "CLOSE_ISSUE",
    "COMMENT_ISSUE",
    "UPDATE_ISSUE",
    "GET_ISSUE",
    "GITHUB_ISSUE",
    "GITHUB_ISSUES",
    "GITHUB_CREATE_ISSUE",
    "CREATE_GITHUB_ISSUE",
    "GITHUB_LIST_ISSUES",
    "LIST_GITHUB_ISSUES",
    "GITHUB_CLOSE_ISSUE",
    "CLOSE_GITHUB_ISSUE",
    "GITHUB_REOPEN_ISSUE",
    "REOPEN_GITHUB_ISSUE",
    "GITHUB_UPDATE_ISSUE",
    "UPDATE_GITHUB_ISSUE",
    "GITHUB_GET_ISSUE",
    "GET_GITHUB_ISSUE",
    "GITHUB_ADD_COMMENT",
    "GITHUB_COMMENT_ISSUE",
    "ADD_COMMENT",
    "GITHUB_ADD_LABEL",
    "ADD_LABEL",
    "LABEL_ISSUE",
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
    "Choose this when the user asks to delegate coding work, use a coding adapter by name, or run multi-step development work — it is the canonical path for coding sub-agents and is preferred over inline FILE / BASH for delegated work. " +
    "NOT for building a web app/page/site/interactive HTML the user wants hosted with a live link — that is APP action=create, which builds, verifies, AND publishes; a task workspace has no hosting path, so files built here never get a URL.",
  descriptionCompressed:
    "ACP coding sub-agent elizaos|pi-agent|opencode|claude|codex: spawn|send|control|list|history",
  routingHint:
    'delegate coding/software/dev work to a coding sub-agent, or drive a coding adapter by name (elizaos|pi-agent|opencode|claude|codex) -> TASKS; GitHub issue operations ("any new issues?", list/create/comment/close/reopen an issue) -> TASKS_MANAGE_ISSUES — this IS the github-issues tool; do NOT use for personal reminders, check-ins, follow-ups, alarms or recurring routines ("remind me...", "every day...") -> use the exposed reminder/scheduling tool instead (TRIGGER_CREATE, SCHEDULED_TASKS, or OWNER_REMINDERS — whichever is exposed this turn); do NOT use for building a web app/page/site/interactive HTML the user wants hosted at a live link ("make me a website", "teach me with an interactive page", "host it and give me the link") -> APP action=create, which builds AND publishes — a coding task workspace has no hosting path; not for one-off inline file edits or shell commands -> FILE / BASH',
  suppressPostActionContinuation: true,
  // When the planner picks any TASKS_* subaction (spawn_agent, send, etc.),
  // suppress the response-handler's draft reply: the action's own callback
  // emits the canonical ack ("On it — spawning…") and the sub-agent's real
  // answer comes back asynchronously via the router. Shipping the draft
  // alongside the ack duplicates the bot's voice and confuses the user.
  suppressEarlyReply: true,
  // Sub-agent work continues after the turn returns and the real result
  // arrives later via the router — the structural signal that a pre-planner
  // early ack is warranted on latency-sensitive channels (voice). Promoted
  // TASKS_* subactions inherit this flag.
  asyncHandoff: true,
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
      description:
        "Pipe-delimited multi-agent task list for action=create. When lane planner is enabled, each part becomes lane-N in order.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "dependencies",
      description:
        'Lane dependency graph for gated action=create, shaped as {"lane-2":["lane-1"]}. References must use generated lane ids.',
      required: false,
      schema: { type: "object" as const },
    },
    {
      name: "maxParallel",
      description:
        "Maximum concurrently launched lanes for gated action=create; ready backlog remains queued until dependencies and capacity allow launch.",
      required: false,
      schema: { type: "integer" as const, minimum: 1 },
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
      name: "lockWorkdir",
      description:
        "For action=create / action=spawn_agent, set true when the user explicitly requires the exact supplied existing workdir. This makes that directory authoritative and prevents project-route or convention auto-detection from relocating the coding agent.",
      required: false,
      schema: { type: "boolean" as const },
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
        "Exact ACP session id for action=send / action=stop_agent / action=cancel / action=control / action=share / action=history. For history, returns the durable task containing that session even when it is not the task's latest session.",
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
    {
      name: "projectId",
      description:
        "Registered project id: binds the new task to that project for action=create; restricts the thread listing to that project's tasks for action=history.",
      required: false,
      schema: { type: "string" as const },
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
    // Registration starts services asynchronously. Validation is the first
    // consumer on a cold plugin load, so it owns the readiness wait before the
    // planner decides whether TASKS exists.
    if (!(await getReadyAcpService(runtime))) {
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
    const text = requestText(message);
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
    const capturedCallbacks: CapturedCallback[] = [];
    const captureCallback: HandlerCallback | undefined = callback
      ? async (response, actionName) => {
          capturedCallbacks.push({ response, actionName });
          return [];
        }
      : undefined;
    const result =
      guardHostedAppCreate({
        runtime,
        operation: action,
        params,
        content,
        fallbackText: requestText(message),
      }) ??
      (await dispatchTasksOperation(
        action,
        runtime,
        message,
        state,
        params,
        content,
        captureCallback,
      ));
    return settleTasksOperation({
      operation: action,
      message,
      params,
      content,
      result,
      capturedCallbacks,
      callback,
    });
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
