/**
 * Unified action surface for orchestrator task, agent, workspace, and issue operations.
 * Simile actions normalize into a small operation vocabulary before their
 * runners enforce access, routing, lifecycle, and session-event invariants.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  join as nodePathJoin,
  resolve as nodePathResolve,
  sep as nodePathSep,
} from "node:path";
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
  unwrapUserMessageText,
  userReferenceLogView,
} from "@elizaos/core";
import type { IssueInfo, PullRequestInfo } from "git-workspace-service";
import {
  detectTaskType,
  type OrchestratorTaskType,
} from "../services/acceptance-criteria.js";
import {
  ADMIN_STOP_META_KEY,
  markSessionAdministrativelyStopped,
} from "../services/admin-stop-marker.js";
import {
  augmentTaskWithDeployGuidance,
  isAppBuildTask,
  resolveAppDeployConfig,
} from "../services/app-deploy-guidance.js";
import { resolveCodingBackendLogged } from "../services/coding-backend-routing.js";
import {
  collisionProviderFromWorkspaceService,
  LanePlannerService,
  laneReadiness,
  shouldUseLanePlanner,
} from "../services/lane-planner.js";
import type { TaskThreadDto } from "../services/orchestrator-task-mapper.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import type { OrchestratorTaskStatus } from "../services/orchestrator-task-types.js";
import { isSessionBusyError } from "../services/parent-agent-dispatch.js";
import { resolveTaskSpawnWorkdir } from "../services/project-binding.js";
import { normalizeRepositoryInput } from "../services/repo-input.js";
import { requestVoiceKeyForMeta } from "../services/router-loop-guard.js";
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
  resolveRouteForWorkdir,
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
  phraseForUser,
  withMachineAppendix,
} from "../voice/phrase-for-user.js";
import {
  awaitCodingSupervisionBound,
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

/** Clamp display text at a word boundary with an ellipsis. A bare
 *  `slice(0, 80)` cut labels mid-word in user-visible acks ("Edit file l",
 *  "Commit loca" — live 2026-08-18). */
function clampLabel(text: string, max = 80): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${boundary > max - 24 ? cut.slice(0, boundary) : cut}…`;
}

function labelFrom(task: string, index: number): string {
  const cleaned = clampLabel(task);
  return cleaned || `task-${index + 1}`;
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

/**
 * Boot-race spawn refusal: after a restart the coordinator can sit "ACP stream
 * not bound" while spawns black-hole (no session created, action reports ok,
 * and core's effect-receipt guard rewrites the reply into "no authoritative
 * commit receipt"). Returning this truthful failure — with NO spawnSession
 * call made — keeps the receipt honest.
 */
function supervisionUnavailableResult(reason: string): ActionResult {
  return {
    success: false,
    error: "CODING_SUPERVISION_UNAVAILABLE",
    text: "The coding-agent supervisor is still starting up after a restart, so I couldn't launch this build — nothing is running. Try again in a moment.",
    continueChain: false,
    data: { reason },
  };
}

/**
 * Structurally claim the per-request ack slot on the SubAgentRouter so the
 * progress hook's spawn ack for a respawned successor session is denied (the
 * verify-driven respawn already ack'd this user request once). Cross-lane
 * contract: reach the router API ONLY via typeof guards and fail open — an
 * absent router or missing method means no gating, i.e. today's behavior.
 */
function claimRouterRequestAck(
  runtime: IAgentRuntime,
  requestKey: string | undefined,
  sessionId: string | undefined,
): void {
  if (!requestKey || !sessionId) return;
  const router = runtime.getService?.("ACPX_SUB_AGENT_ROUTER") as
    | { claimRequestAck?: (key: string, sessionId: string) => unknown }
    | null
    | undefined;
  if (!router || typeof router.claimRequestAck !== "function") return;
  try {
    router.claimRequestAck(requestKey, sessionId);
  } catch (error) {
    // error-policy:J6 ack-claim bookkeeping is best-effort suppression state;
    // failure degrades to today's duplicate-ack behavior, never to a lost spawn.
    logger(runtime).warn(
      `[TASKS] claimRequestAck failed for ${requestKey}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * An admitted respawn revives the request's voice on the router ledger: a
 * `failure` terminal held by an earlier generation is cleared so the retry's
 * progress/questions un-mute and its genuine completion is relayed instead of
 * terminal_denied (the failure narration itself invited this retry — live
 * defect: the invited retry succeeded invisibly). Same cross-lane contract as
 * `claimRouterRequestAck`: typeof-guarded, fail open.
 */
function reviveRouterRequestVoice(
  runtime: IAgentRuntime,
  requestKey: string | undefined,
): void {
  if (!requestKey) return;
  const router = runtime.getService?.("ACPX_SUB_AGENT_ROUTER") as
    | { noteRespawnAdmitted?: (key: string) => unknown }
    | null
    | undefined;
  if (!router || typeof router.noteRespawnAdmitted !== "function") return;
  try {
    router.noteRespawnAdmitted(requestKey);
  } catch (error) {
    // error-policy:J6 voice-revive bookkeeping is best-effort ledger state;
    // failure degrades to the pre-revive gagging, never to a lost spawn.
    logger(runtime).warn(
      `[TASKS] noteRespawnAdmitted failed for ${requestKey}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
    // Chained spawns must keep the USER'S room as origin. A synthetic
    // task_complete inbound runs its planner turn inside the minted TASK room;
    // stamping message.roomId there made the follow-up session's completions
    // deliver into a room no connector can map (live 2026-08-17: "Could not
    // resolve Discord channel ID for room 0314…" — the user saw silence). The
    // router stamps the true origin on its synthetic inbounds; inherit it.
    originRoomId:
      pickRoutingString(params, content, metadata, "originRoomId") ??
      message.roomId,
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
    // A prompt that died because the SESSION was administratively stopped
    // (user stop, or the interruption path absorbing a follow-up) is a
    // cancellation, not a failure. The workflow's own terminal says "failed"
    // either way (the killed worker exits non-zero), so the stamp is the only
    // reliable signal — surface it as a typed code the lane classifier keys
    // on, and skip the error event (the router suppresses it via the same
    // stamp anyway).
    let adminStopReason: string | undefined;
    try {
      const fresh = await service.getSession?.(session.sessionId);
      const freshMeta = fresh?.metadata as Record<string, unknown> | undefined;
      const stamp = freshMeta?.[ADMIN_STOP_META_KEY];
      if (typeof stamp === "string" && stamp) adminStopReason = stamp;
    } catch {
      // error-policy:J4 stamp lookup failure keeps the genuine-failure path.
    }
    if (adminStopReason) {
      throw new ElizaError(
        `Lane interrupted (${adminStopReason}) — the running child was stopped so a successor can absorb the new instruction`,
        {
          code: "LANE_INTERRUPTED",
          context: { sessionId: session.sessionId, reason: adminStopReason },
          severity: "ephemeral",
        },
      );
    }
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

  // Boot-race gate (before ANY side effect — no durable task, no session): a
  // coordinator stuck unbound after a restart black-holes spawns, so refuse
  // honestly instead of letting the effect-receipt guard invent the reply.
  const supervision = await awaitCodingSupervisionBound(runtime);
  if (!supervision.ok) {
    logger(runtime).warn(
      `[TASKS:create] refusing spawn — coding supervision unavailable: ${supervision.reason}`,
    );
    return supervisionUnavailableResult(supervision.reason);
  }

  const text = requestText(message);
  // Genuine user request for workdir-route matching — see runSpawnAgent and
  // resolveOriginatingRequestText. Keeps routing planner-independent.
  const routingRequest = await resolveOriginatingRequestText(
    runtime,
    message,
    state,
  );
  let tasks = taskParts(params, content, text);
  // One edit of one existing app is ONE lane. The planner fans edit asks into
  // parallel subtasks ("make the unit converter dark mode" became 3 builds,
  // live 2026-08-20), and every lane then resolves to the SAME app dir — three
  // children racing each other's writes in one directory. Collapse to a single
  // lane carrying the full instruction; genuine multi-app fan-outs (different
  // targets, creation asks) keep their lanes.
  if (tasks.length > 1 && isAppEditIntentText(text) && isAppBuildTask(text)) {
    logger(runtime).warn(
      `[TASKS:create] collapsing ${tasks.length} planner lanes to 1 for an edit of an existing app`,
    );
    tasks = [tasks.join("\n")];
  }
  if (tasks.length > MAX_CONCURRENT_AGENTS) {
    // Planner-facing refusal: mechanical text + structured facts; the planner
    // phrases the denial in voice instead of a canned callback bubble.
    return {
      success: false,
      error: "TOO_MANY_AGENTS",
      text: `Too many task agents requested (${tasks.length}); maximum is ${MAX_CONCURRENT_AGENTS}.`,
      data: {
        requestedParts: tasks.length,
        maxConcurrent: MAX_CONCURRENT_AGENTS,
      },
    };
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
  // Planner labels are model output and arrive corrupted on occasion — a
  // task literally titled ",title:" shipped from a JSON-fragment label (live
  // 2026-08-19). A label with no letters or digits carries no identity; drop
  // it so labelFrom derives one from the task text instead.
  // Generic labels ("web app", "page") name nothing — one produced the slug
  // web-app-2 as a published URL (live 2026-08-19). Treat them like absent
  // labels so labelFrom derives identity from the task text.
  const GENERIC_LABEL_RE =
    /^(?:web\s*app|webapp|web\s*page|webpage|app|page|site|website|task|build|project)$/i;
  const baseLabelSane =
    baseLabelParam &&
    /[a-z0-9]/i.test(baseLabelParam) &&
    !GENERIC_LABEL_RE.test(baseLabelParam.trim())
      ? baseLabelParam
      : undefined;
  const baseLabel = baseLabelSane
    ? userReferenceLogView(baseLabelSane)
    : undefined;
  const extraMetadata = additionalSessionMetadata(params, content);
  const keepAliveAfterComplete = hasVerifiedRetryLifecycle(
    params,
    content,
    extraMetadata,
  );
  const originConnectorMessageId = connectorMessageIdFromMemory(
    message,
    content,
  );
  // The stable per-request root id (see spawnRootIdFor). Stamped into BOTH the
  // session metadata and the durable task metadata so respawn keys and the
  // park-notice dedupe keep matching across task records for one user request.
  const spawnRootMessageId = spawnRootIdFor(message, content);
  // Fan-out part suffix for the request-voice key. Inherited when present
  // (lane-minted via runLanePlan's params.metadata, or router-re-stamped on a
  // synthetic respawn inbound) so a respawn keeps its predecessor's exact key;
  // a fresh MULTI-part create mints per-part below instead.
  const inheritedVoicePart = plainString(extraMetadata.requestVoicePart);
  // Router-stamped synthetic inbound (sub-agent-router stamps
  // content.metadata.subAgent=true on every internally-routed re-spawn); a
  // fresh user request never carries it and always has a new message id.
  const syntheticRespawnInbound = extraMetadata.subAgent === true;
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
    pickString(params, content, "goal") ?? plannerTitle ?? taskTitle;
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
  const originRoomId =
    typeof swarmRoomMetadata.originRoomId === "string"
      ? swarmRoomMetadata.originRoomId
      : undefined;
  const taskService = runtime.getService?.(
    OrchestratorTaskService.serviceType,
  ) as OrchestratorTaskService | null | undefined;
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
      return duplicateSpawnGuardResult(runtime, callback, duplicate);
    }
  }

  // Ack FIRST — before task-record creation (whose criteria generation can
  // spend a model call) and before the lanes run. Every later placement of
  // this ack lost the delivery race to fast workers' completion relays
  // (live 2026-08-19: three separate orderings observed).
  let earlyAckText: string | undefined;
  let ackPostedOutOfBand = false;
  if (!syntheticRespawnInbound && callback) {
    const ackTitles = tasks.map(
      (part, index) =>
        baseLabel ??
        labelFrom(parseAgentPrefix(part, baseAgentType).task, index),
    );
    const { text } = await phraseForUser(
      runtime,
      {
        intent: "confirm",
        facts: { createdCount: tasks.length, titles: ackTitles },
      },
      tasks.length > 1
        ? `On it — starting ${tasks.length} builds.`
        : "On it — building that now.",
      // 1.5s lost the race to Cerebras on effectively every create (the
      // fallback shipped verbatim across four consecutive live builds,
      // owner-reported as "hardcoded slop" 2026-08-20); 3.5s matches every
      // other phraseForUser site. The ack is out-of-band, so the only cost
      // is the ack arriving ~2s later.
      { timeoutMs: 3_500 },
    );
    earlyAckText = text;
    // Out-of-band send: same-turn callback deliveries batch at turn end (five
    // ack placements all landed ~2s before the completion relay, live
    // 2026-08-19), while sendMessageToTarget posts NOW — the same path the
    // park/recovery notices use to arrive mid-flight.
    const ackSend = (
      runtime as IAgentRuntime & {
        sendMessageToTarget?: (
          target: { source: string; roomId?: string },
          content: { text: string; source: string; agentVoiced?: boolean },
        ) => Promise<unknown>;
      }
    ).sendMessageToTarget;
    const ackSource =
      typeof (message.content as { source?: unknown })?.source === "string"
        ? String((message.content as { source?: unknown }).source)
        : undefined;
    if (typeof ackSend === "function" && ackSource && message.roomId) {
      // error-policy:J6 a failed ack send must never block the build itself.
      await ackSend(
        { source: ackSource, roomId: String(message.roomId) },
        { text: earlyAckText, source: ackSource, agentVoiced: true },
      ).catch(() => undefined);
      ackPostedOutOfBand = true;
      // Record (never re-send) so settle binds its receipt to this text
      // instead of synthesizing a duplicate delivery from result.text.
      await callback({
        text: earlyAckText,
        agentVoiced: true,
        metadata: { recordOnly: true },
      });
    } else {
      await callback({
        text: earlyAckText,
        agentVoiced: true,
        metadata: { immediate: true },
      });
    }
  }
  const useSmithers = shouldUseSmithersTaskRunner();
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
      const first = tasks[0]
        ? parseAgentPrefix(tasks[0], baseAgentType).task
        : undefined;
      const boundWorkdir = first
        ? resolveSpawnWorkdir(runtime, first, routingRequest, explicitWorkdir, {
            lockWorkdir: pickBoolean(params, content, "lockWorkdir") === true,
          }).workdir
        : explicitWorkdir;
      const detail = await taskService.createTask({
        title: taskTitle,
        goal: taskGoal,
        // Structural kind: the same gate that routes the build into a served
        // slug dir also names the criteria template. A "coding" kind on an
        // app ask mints typecheck/lint/test criteria a static page can never
        // evidence, and the planner's goal rewrite hides the app shape from
        // goal-text detection ("Implement dark mode for the unit converter"
        // parked on lint evidence, live 2026-08-20).
        kind:
          isAppBuildTask(text) ||
          (isAppEditIntentText(text) &&
            /\b(?:page|app|site|webapp|website)\b/i.test(text))
            ? "app-build"
            : "coding",
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
          // The per-request root id keeps the task-service respawn key and the
          // park-notice dedupe matched across task records (see spawnRootIdFor).
          ...(spawnRootMessageId ? { spawnRootMessageId } : {}),
          // Durable copy of the fan-out part: the task-service respawn path
          // and notifyVerifyEscalation read it back so this lane's respawns
          // and park notice key on the SAME per-lane voice slot.
          ...(inheritedVoicePart
            ? { requestVoicePart: inheritedVoicePart }
            : {}),
          ...(objectValue(extraMetadata.lane)
            ? { waveId: extraMetadata.waveId, lane: extraMetadata.lane }
            : {}),
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
      // Planner-facing: the truth-critical negative claim ("no workflow agent
      // was started") stays in the text; the planner voices the refusal.
      return {
        success: false,
        error: "SMITHERS_DURABLE_TASK_UNAVAILABLE",
        text: "The durable task record could not be created, so no workflow agent was started. Task storage is unavailable right now.",
        data: { nothingStarted: true },
      };
    }
    logger(runtime).warn(
      `[TASKS:create] durable task thread creation failed: ${detail}`,
    );
    threadId = null;
  }

  const smithersOwnerTaskId = useSmithers ? (threadId ?? undefined) : undefined;
  if (useSmithers && !smithersOwnerTaskId) {
    // Planner-facing (see the catch above): keep the negative claim in text.
    return {
      success: false,
      error: "SMITHERS_DURABLE_TASK_UNAVAILABLE",
      text: "No durable task owner could be established, so no workflow agent was started.",
      data: { nothingStarted: true },
    };
  }

  const settled = await Promise.allSettled(
    tasks.map(async (part, index) => {
      const parsed = parseAgentPrefix(part, baseAgentType);
      const task = parsed.task;
      const agentType = parsed.agentType as AgentType;
      const label = baseLabel ?? labelFrom(task, index);
      // Request-voice part for THIS session. A deliberate multi-part fan-out
      // (one create call, several parts) mints a per-part suffix so each
      // genuinely parallel part owns its own terminal slot — the first part's
      // completion must not gag the siblings' genuine results. An inherited
      // part (lane launch or respawn inbound) always wins so respawns keep
      // sharing their predecessor's key. Single-part creates stay unsuffixed
      // (the original ledger behavior: retries/cascades share one voice).
      const partVoicePart =
        inheritedVoicePart ?? (tasks.length > 1 ? `part:${index}` : undefined);
      // A matching workdir route outranks a planner-guessed workdir; a
      // scaffold-aware caller opts out with lockWorkdir — see runSpawnAgent.
      const {
        workdir: resolvedSessionWorkdir,
        route,
        isolate: resolvedCreateIsolate,
      } = resolveSpawnWorkdir(runtime, task, routingRequest, explicitWorkdir, {
        lockWorkdir: pickBoolean(params, content, "lockWorkdir") === true,
      });
      let sessionWorkdir = resolvedSessionWorkdir;
      let isolateWorkdir = resolvedCreateIsolate;
      // Same repo-provisioning contract as runSpawnAgent: a repo-targeted
      // create must run in a CLONE, not the cwd fallback (live 2026-08-17:
      // repo param present on the create path, the sub-agent git-init'd a
      // fresh repo in scratch and could not push).
      let createProvisionedWorkspaceId: string | undefined;
      const createRequestedRepo = await resolveRequestedRepo(
        runtime,
        params as Record<string, unknown>,
        [task, requestText(message)],
        requestText(message),
      );
      // An explicitly-named repo outranks a keyword route: "put up a pr on
      // my <name> repo" text-matches generic route entries ("pull request"),
      // which silently steered repo asks into unrelated local checkouts and
      // skipped provisioning (live 2026-08-18: sandbox asks ran inside the
      // operator's own project worktrees).
      if (createRequestedRepo && route) {
        logger(runtime).info(
          `[TASKS:create] explicit repo ${createRequestedRepo} outranks route ${route.id ?? route.workdir}; provisioning a clone`,
        );
      }
      if (createRequestedRepo) {
        const createWorkspaceService = getCodingWorkspaceService(runtime);
        // A planner-supplied workdir binds a repo ask ONLY when the registry
        // tracks it (live 2026-08-18: the planner copied a stale workspace
        // path out of room context onto a fresh repo ask, skipping
        // provisioning entirely). A registered match reuses that workspace —
        // and carries its id so auto-submit still works; anything else is
        // ignored and the repo provisions a real clone.
        const registeredCreateWorkspace = registeredWorkspaceForPath(
          createWorkspaceService,
          explicitWorkdir,
        );
        if (registeredCreateWorkspace) {
          sessionWorkdir = registeredCreateWorkspace.path;
          isolateWorkdir = false;
          createProvisionedWorkspaceId = registeredCreateWorkspace.id;
        } else if (createWorkspaceService) {
          if (explicitWorkdir) {
            logger(runtime).info(
              `[TASKS:create] ignoring unregistered workdir ${explicitWorkdir} on repo-targeted create; provisioning ${createRequestedRepo}`,
            );
          }
          try {
            const workspace = await createWorkspaceService.provisionWorkspace({
              repo: createRequestedRepo,
              useWorktree: false,
            });
            sessionWorkdir = workspace.path;
            isolateWorkdir = false;
            createProvisionedWorkspaceId = workspace.id;
            logger(runtime).info(
              `[TASKS:create] provisioned repo workspace: ${createRequestedRepo} -> ${workspace.path}`,
            );
          } catch (error) {
            // error-policy:J2 a named repo that cannot be provisioned fails this
            // lane loudly (the settled handler reports rejected lanes) — a
            // scratch git-init masquerading as the repo is worse.
            throw new Error(
              `Could not clone ${createRequestedRepo} for this task: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }

      // This path spawns WITHOUT `initialTask` and delivers the task via
      // sendPrompt (smithers or direct), so the AcpService initialTask deploy
      // injection never fires here. Re-attach the contract on the task text
      // itself; the helper is gated + idempotent so non-app tasks pass through.
      let createAssignedAppDir: string | undefined;
      let createSlugRoute: ResolvedWorkdirRoute | undefined;
      if (!createProvisionedWorkspaceId) {
        const slugDir = appBuildSlugWorkdir(
          task,
          label,
          sessionWorkdir,
          runtime,
          requestText(message),
        );
        if (slugDir) {
          sessionWorkdir = slugDir;
          isolateWorkdir = false;
          createAssignedAppDir = slugDir;
          // The slug dir sits inside the apps route's tree; without re-
          // resolving, the session missed the route stamp and the residuals
          // gate counted the whole shared checkout's uncommitted paths
          // against the build (live 2026-08-19: 142 residuals parked a live
          // page).
          createSlugRoute = resolveRouteForWorkdir(runtime, slugDir);
          logger(runtime).info(
            `[TASKS:create] app build runs in its served slug dir: ${slugDir}`,
          );
        }
      }
      const groundedCreateTask = createAssignedAppDir
        ? retargetPlannerAppPaths(task, createAssignedAppDir)
        : task;
      const createTaskForChild =
        createProvisionedWorkspaceId && createRequestedRepo
          ? withProvisionedRepoContract(groundedCreateTask, createRequestedRepo)
          : groundedCreateTask;
      const taskWithRouteHints = augmentTaskWithDeployGuidance(
        // A provisioned clone is NOT the route's tree: carrying the route's
        // id/instructions onto it would mislabel the workdir class and feed
        // the child instructions about a checkout it is not in.
        taskWithResolvedRoute(
          createTaskForChild,
          createProvisionedWorkspaceId ? undefined : route,
          sessionWorkdir,
          swarmRoomMetadata,
        ),
        undefined,
        {
          monetized: pickBoolean(params, content, "appMonetized") === true,
          assignedAppDir: createAssignedAppDir,
        },
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
      const session = await service.spawnSession({
        agentType,
        workdir: sessionWorkdir,
        isolateWorkdir,
        memoryContent,
        approvalPreset,
        model,
        timeoutMs,
        // Trace correlation + per-task child trajectory dir (#13775). The
        // task-service spawn path stamps this env, but THIS chat-create path
        // spawned bare — children recorded their trajectories into the shared
        // state-dir root under their own agent id, the per-task dir never
        // existed, and task_complete ingest silently attached nothing (live
        // 2026-08-20: every chat-built app task carried zero child
        // trajectories).
        ...(threadId && typeof taskService?.buildChildTraceEnv === "function"
          ? { env: taskService.buildChildTraceEnv(threadId) }
          : {}),
        metadata: {
          ...extraMetadata,
          ...(createProvisionedWorkspaceId
            ? { provisionedWorkspaceId: createProvisionedWorkspaceId }
            : {}),
          ...(originConnectorMessageId ? { originConnectorMessageId } : {}),
          // Persist the stable root id so SubAgentRouter re-stamps it onto the
          // next synthetic re-spawn inbound (same contract as the spawn_agent
          // path — the per-origin cap and request-voice keys stay anchored to
          // ONE user request across the whole loop). (#8875)
          ...(spawnRootMessageId ? { spawnRootMessageId } : {}),
          // Per-part voice scope (see partVoicePart above); the router reads
          // it via requestVoiceKeyForMeta and re-stamps it onto respawns.
          ...(partVoicePart ? { requestVoicePart: partVoicePart } : {}),
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
          workdirRouteId: (createSlugRoute ?? route)?.id,
          workdirRoute: createSlugRoute ?? route,
          // The create already posted its out-of-band ack; the progress hook
          // reads this stamp structurally (the ledger claim raced the hook's
          // event-time decision and lost, live 2026-08-19).
          ...(ackPostedOutOfBand ? { requestAckPosted: true } : {}),
          keepAliveAfterComplete,
          ...(durableRun ? smithersDurableRunMetadata(durableRun) : {}),
        },
      });

      // Post-spawn liveness receipt: a spawn that "returned" but has no live
      // session record (or one already terminal at birth) is a black-holed
      // launch — fail this part loudly before any prompt is sent, so the
      // action reports a truthful failure instead of the optimistic ack.
      const live = await Promise.resolve(service.getSession(session.sessionId));
      if (!live || TERMINAL_SESSION_STATUSES.has(String(live.status))) {
        throw new ElizaError(
          "the coding sub-agent session did not come up; nothing is running",
          {
            code: "CODING_SESSION_DID_NOT_START",
            context: {
              sessionId: session.sessionId,
              status: live ? String(live.status) : "missing",
            },
          },
        );
      }

      if (ackPostedOutOfBand) {
        // The early out-of-band ack already told the user; claim this lane's
        // request-ack slot NOW (the progress hook posts its own spawn ack
        // ~15s in, mid-lane — a post-lane claim was too late twice,
        // live 2026-08-19).
        claimRouterRequestAck(
          runtime,
          requestVoiceKeyForMeta({
            ...(spawnRootMessageId ? { spawnRootMessageId } : {}),
            ...(partVoicePart ? { requestVoicePart: partVoicePart } : {}),
          }) ?? undefined,
          session.sessionId,
        );
      }
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
              // Administrative rollback, not a crash: mark it so the terminal
              // relay does not post "stopped before completion" for a session
              // the orchestrator itself tore down before any work started.
              await markSessionAdministrativelyStopped(
                service,
                session.sessionId,
                "spawn_rollback",
              );
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
  const allFailed = results.filter((result) => result.status === "failed");
  // A lane killed mid-flight by an interruption (the user's follow-up
  // cancelled the running child so a successor could absorb the new
  // instruction) is a cancellation, not a launch failure — the successor's
  // own ack covers messaging. Narrating it shipped "stopped before
  // completion" AND "No task agents could be started — the launch failed"
  // one second before the merged build's ack (live 2026-08-20). The
  // cancellation shape is structural: the prompt/workflow terminal carries a
  // cancelled/stopped status, never a spawn error.
  const interruptCancelled = allFailed.filter((result) =>
    // ONLY the typed marker (stamped admin-stop → LANE_INTERRUPTED): a bare
    // cancelled/stopped prompt with no stamp is a reportable failure — a
    // text-shape match here silently swallowed those (unit pin: "reports a
    // cancelled PromptResult as failed").
    /\bLane interrupted\b/i.test(String(result.error ?? "")),
  );
  if (interruptCancelled.length > 0) {
    logger(runtime).warn(
      `[TASKS:create] ${interruptCancelled.length} lane(s) cancelled mid-flight (interrupt/stop); suppressing launch-failed notice (labels=${interruptCancelled.map((f) => f.label).join(",")})`,
    );
  }
  const failed = allFailed.filter(
    (result) => !interruptCancelled.includes(result),
  );
  // A launch killed by the user's own cancel is a cancellation, not a
  // failure: without this the cancel produced "No task agents could be
  // started — the launch failed" alongside the stop confirmation (live
  // 2026-08-19). The turn signal is this turn's own controller.
  const turnAborted =
    typeof message.roomId === "string" &&
    runtime.turnControllers?.signalFor?.(message.roomId)?.aborted === true;
  // A worker whose workflow died AFTER its child already reported completion
  // did not fail to launch — the deliverable is relayed and verifying. The
  // "No task agents could be started" line landed one second after "done…
  // verified live" for the same build (live 2026-08-19). Log-only there.
  let completionAlreadyReported = false;
  if (failed.length > 0 && smithersOwnerTaskId && taskService) {
    try {
      const ownerDoc = await taskService.getTask(smithersOwnerTaskId);
      completionAlreadyReported =
        ownerDoc !== null &&
        ["completion_reported", "validating", "done"].includes(
          String(ownerDoc.status),
        );
    } catch {
      // error-policy:J4 status lookup failure keeps today's failure report.
    }
  }
  if (failed.length > 0 && completionAlreadyReported && !turnAborted) {
    logger(runtime).warn(
      `[TASKS:create] worker exit after completion already reported; suppressing launch-failed notice (labels=${failed.map((f) => f.label).join(",")})`,
    );
  } else if (failed.length > 0 && turnAborted) {
    const text = "stopped the launch — you cancelled it before it got going.";
    await callbackText(callback, text);
    return {
      success: true,
      text,
      userFacingText: text,
      verifiedUserFacing: true,
      turnComplete: true,
      data: { cancelled: true, failedLabels: failed.map((f) => f.label) },
    };
  }
  if (failed.length > 0 && !completionAlreadyReported && !turnAborted) {
    // ONE model-phrased message from structured facts. The raw error.message
    // joins stay in logs (above) and in data.agents alongside the per-lane
    // session ids, which remain the receipts.
    const launchedCount = results.length - failed.length;
    const failedLabels = failed.map((item) => String(item.label));
    const failFallback =
      launchedCount > 0
        ? `Started ${launchedCount} of ${results.length} task agents; ${failed.length} failed to launch (${failedLabels.join(", ")}).`
        : `No task agents could be started — ${failed.length === 1 ? "the launch" : `all ${failed.length} launches`} failed (${failedLabels.join(", ")}).`;
    const { text: textOut } = await phraseForUser(
      runtime,
      {
        intent: "fail",
        facts: { launchedCount, failedCount: failed.length, failedLabels },
        mustNotClaim: [
          "every agent started successfully",
          launchedCount > 0
            ? "nothing was started"
            : "some of the work is still running",
        ],
      },
      failFallback,
    );
    await callbackText(callback, textOut, { voiced: true });
    return {
      success: false,
      text: textOut,
      data: { agents: results, suppressActionResultClipboard: true },
    };
  }

  // Machine widget rides as an appendix, byte-identical below whatever prose
  // the model wrote — widget parsers and the settle receipt binding depend on
  // the exact block.
  const widgetBlock = threadId ? `[TASK:${threadId}]${taskTitle}[/TASK]` : "";
  const composeCreateText = (prose: string): string =>
    widgetBlock ? withMachineAppendix(prose, widgetBlock) : prose;
  // Normie fallback (owner directive 2026-08-19): "Created task agent." is
  // dev-speak; even the no-model path should read like a person.
  const createdFallback =
    results.length > 1
      ? `On it — starting ${results.length} builds.`
      : "On it — building that now.";

  // Respawn-ack suppression: an internally-routed re-spawn (verify-driven
  // successor) must not post a second "Created task agent(s)." ack for the
  // same user request. The text stays planner-only (no model call spent on
  // it), and the request-voice ack slot is claimed for the successor session
  // so the progress hook's ack is denied too (fail-open when the router lacks
  // the API).
  if (syntheticRespawnInbound) {
    // The composed voice key (root + inherited fan-out part) via the SAME
    // ladder the router uses, so a lane respawn claims/revives ITS lane's
    // slot, not the whole request's.
    const respawnVoiceKey =
      requestVoiceKeyForMeta({
        ...(spawnRootMessageId ? { spawnRootMessageId } : {}),
        ...(inheritedVoicePart ? { requestVoicePart: inheritedVoicePart } : {}),
      }) ?? undefined;
    claimRouterRequestAck(runtime, respawnVoiceKey, sessions[0]?.sessionId);
    reviveRouterRequestVoice(runtime, respawnVoiceKey);
    return {
      success: true,
      text: composeCreateText(createdFallback),
      data: {
        agents: results,
        taskId: threadId,
        suppressActionResultClipboard: true,
      },
    };
  }

  // The visible ack already went out BEFORE the lanes ran (earlyAckText).
  // Re-sending here would double-bubble; the widget appendix rides on the
  // result text for the app UI's task card without another chat message.
  // When the ack already posted out-of-band, result.text must NOT be that
  // same ack: the turn's answerless floor re-shipped it byte-identical after
  // the result (live 2026-08-19, three variants). Grounding prose states the
  // pending contract instead — safe if any floor leaks it.
  const proseText = ackPostedOutOfBand
    ? composeCreateText(
        `Acknowledged and started ${results.length > 1 ? `${results.length} builds` : "the build"}; results arrive as follow-up messages.`,
      )
    : composeCreateText(earlyAckText ?? createdFallback);

  // The creation ack is the complete answer to a single-operation turn:
  // verified + turnComplete make the callback the sole delivery instead of
  // double-messaging with the evaluator's paraphrase.
  return {
    success: true,
    text: proseText,
    // When the ack already posted out-of-band, re-claiming it as the turn's
    // user-facing text redelivers it at settle (live 2026-08-19: doubled
    // "On it" twice in a row). The planner keeps the grounding text either way.
    ...(ackPostedOutOfBand
      ? {}
      : { userFacingText: proseText, verifiedUserFacing: true }),
    turnComplete: true,
    data: {
      agents: results,
      taskId: threadId,
      suppressActionResultClipboard: true,
      // The out-of-band ack IS this turn's answer; without this the planner's
      // evaluator mimicked the ack and the turn delivered it again at the end
      // (live 2026-08-19: trajectory shows eval FINISH "On it — building that
      // now." trailing the completion relay).
      ...(ackPostedOutOfBand ? { suppressPlannerReply: true } : {}),
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
      // Planner-facing: the producer prose stays in logs; the planner voices
      // the failure from the structured code.
      const msg = failureMessage(error);
      logger(runtime).warn(`[TASKS:create] lane plan rejected: ${msg}`);
      return {
        success: false,
        error: error.code,
        text: msg,
        continueChain: false,
        data: { laneErrorCode: error.code },
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
  // Per-lane request-voice part: a multi-lane fan-out from ONE user message
  // must give each lane its own terminal slot (the first lane's completion
  // must not gag the others). Minted ONCE here and inherited verbatim by
  // every respawn of the lane (task-metadata carry + router re-stamp), never
  // re-minted — so an inbound that already carries a part (a respawned create
  // routed back through the planner) keeps its predecessor's key even if the
  // fresh plan would assign different lane ids. waveId disambiguates two
  // separate lane plans spawned from the same request root.
  const inheritedLanePart = plainString(
    objectValue(content.metadata)?.requestVoicePart,
  );
  const laneVoicePart = (lane: { id: string }): string | undefined =>
    inheritedLanePart ??
    (plan.lanes.length > 1 ? `lane:${plan.waveId}:${lane.id}` : undefined);
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
            ...(laneVoicePart(lane)
              ? { requestVoicePart: laneVoicePart(lane) }
              : {}),
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

/** Cached login of the configured GITHUB_TOKEN's account (module-lifetime). */
let cachedTokenOwner: string | null | undefined;
async function githubTokenOwner(
  runtime: IAgentRuntime,
): Promise<string | null> {
  if (cachedTokenOwner !== undefined) return cachedTokenOwner;
  try {
    const token = runtime.getSetting?.("GITHUB_TOKEN");
    if (typeof token !== "string" || !token.trim()) {
      cachedTokenOwner = null;
      return null;
    }
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `token ${token.trim()}`,
        "User-Agent": "eliza-orchestrator",
      },
    });
    const body = (await res.json()) as { login?: string };
    cachedTokenOwner =
      typeof body.login === "string" && body.login ? body.login : null;
  } catch {
    // error-policy:J4 owner lookup is best-effort sugar for possessive repo
    // names; failing it just means the ask needs an explicit owner/URL.
    cachedTokenOwner = null;
  }
  return cachedTokenOwner;
}

const PLACEHOLDER_REPO_OWNERS = new Set([
  "yourusername",
  "your-username",
  "your_username",
  "username",
  "youruser",
  "your-user",
  "user",
  "yourorg",
  "your-org",
  "your_org",
  "org",
  "owner",
  "yourname",
  "your-name",
  "example",
  "examples",
  "myusername",
  "my-username",
  "acme",
  "yourhandle",
  "your-handle",
  "placeholder",
]);

/**
 * The slug directory a NEW app build should run in on a custom static host.
 * The publish guidance already tells children "write the files into
 * <appsDir>/<slug>/" and small models drop files at the route root anyway
 * (live 2026-08-18: countdown.html at the host checkout root, invisible to
 * /apps/). Pointing the session cwd AT the served slug directory makes
 * placement correct by construction. Returns undefined when the ask is not a
 * hosted-app build, the deploy target is not a custom host, or the resolved
 * workdir is not the checkout that contains the apps dir. Edits keep the
 * route root (the deploy-contract regex requires a build/create verb).
 */
/** Edit-shaped app ask: the user is changing an EXISTING app ("make the X
 * page dark mode", "keep the same link"), not commissioning a new one. */
function isAppEditIntentText(text: string): boolean {
  return (
    /\b(?:same\s+(?:link|url)|keep\s+the\s+(?:same\s+)?(?:link|url)|existing)\b/i.test(
      text,
    ) ||
    (/\b(?:the|my|our)\s+[\w -]{0,40}\b(?:page|app|site|game|tool)\b/i.test(
      text,
    ) &&
      !/\b(?:make|build|create|spin(?:\s+up)?|whip(?:\s+up)?)\s+(?:me|us)\s+a\b/i.test(
        text,
      ))
  );
}

/** Rewrite planner-invented absolute app paths onto the server-assigned slug
 * dir. The planner writes concrete path guesses into the task text ("...in
 * <appsDir>/unit-converter") and the child obeys them over the resolved
 * workdir — an edit ask then lands in a stale sibling dir while the app the
 * user meant sits untouched (live 2026-08-20). Only paths under the deploy
 * apps dir are rewritten; everything else in the prose stays verbatim. */
function retargetPlannerAppPaths(task: string, assignedDir: string): string {
  const deploy = resolveAppDeployConfig();
  if (!deploy.customAppsDir) return task;
  const appsDir = nodePathResolve(deploy.customAppsDir);
  const escaped = appsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}/[A-Za-z0-9._-]+`, "g");
  return task.replace(re, assignedDir);
}

function appBuildSlugWorkdir(
  task: string,
  label: string,
  resolvedWorkdir: string | undefined,
  runtime?: IAgentRuntime,
  userText?: string,
): string | undefined {
  // Decision logging: a silent undefined here drops the build into scratch
  // with no served URL and the park that follows is undiagnosable from the
  // channel (live 2026-08-19: name-picker replay landed in workspaces with
  // every placement fix live and nothing said why).
  const declined = (reason: string): undefined => {
    if (runtime) {
      logger(runtime).info(
        `[app-slug] no slug dir (${reason}); build stays in ${resolvedWorkdir ?? "<none>"}`,
      );
    }
    return undefined;
  };
  if (!resolvedWorkdir) return declined("no resolved workdir");
  // Gate on the USER'S OWN WORDS as well as the composed task: the planner
  // rewrites verbs freely ("make me a page" became "Implement a fully
  // working dark mode", live 2026-08-20), and a rewrite must not knock an
  // app ask off the slug-placement path.
  if (!isAppBuildTask(task) && !(userText && isAppBuildTask(userText))) {
    return declined("task text is not an app build");
  }
  const deploy = resolveAppDeployConfig();
  if (deploy.target !== "custom" || !deploy.customAppsDir) {
    return declined(`deploy target=${deploy.target ?? "unset"}`);
  }
  const appsDir = nodePathResolve(deploy.customAppsDir);
  const workdir = nodePathResolve(resolvedWorkdir);
  // A repo/route workdir OUTSIDE the apps tree still gets the slug dir: the
  // deploy guidance names the apps dir absolutely, so a child in a scratch
  // cwd writes there anyway — and a self-picked slug clobbered an existing
  // app (live 2026-08-19: pomodoro-timer overwritten from a workspaces cwd
  // after the planner hallucinated a nonexistent workdir). The only workdirs
  // exempt are ones INSIDE the apps tree's parent repo but outside the apps
  // dir — those are deliberate repo asks, handled by the provisioned path
  // before this helper runs.
  if (
    appsDir !== workdir &&
    !appsDir.startsWith(workdir + nodePathSep) &&
    !workdir.startsWith(appsDir + nodePathSep)
  ) {
    const appsRepoRoot = nodePathResolve(appsDir, "..", "..");
    if (workdir.startsWith(appsRepoRoot + nodePathSep)) {
      return declined(
        "workdir is a deliberate repo location inside the apps checkout",
      );
    }
  }
  const baseSlug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "app";
  // Edit-shaped asks reuse the newest EXISTING app in the slug family instead
  // of minting the next free slot: "make the unit converter dark mode, same
  // link" re-derived the slug from its label, landed on the STALE bare
  // `unit-converter/` while the app the user meant lived at
  // `unit-converter-3/`, and verification rightly parked the run (live
  // 2026-08-20). Creation phrasing ("make me a ...") keeps the never-clobber
  // slot scan.
  const intentText = userText?.trim() ? userText : task;
  const editIntent = isAppEditIntentText(intentText);
  if (editIntent) {
    // The label rarely matches the app's dir name ("Dark Mode for Unit
    // Converter" vs unit-converter-3), so match by NAME TOKENS against the
    // whole apps tree: an existing dir qualifies when every token of its
    // name (numeric suffix stripped) appears in the ask and at least one
    // token is distinctive. Newest mtime wins across the whole tree.
    const GENERIC_NAME_TOKENS = new Set([
      "app",
      "page",
      "site",
      "game",
      "tool",
      "the",
      "a",
      "for",
      "my",
      "lil",
    ]);
    // Anchor on the NAMED app when the ask has one ("the <name> page/app"):
    // matching against the whole text let descriptive words win — "make the
    // unit converter page dark mode" matched a stale `dark-mode/` dir minted
    // by an earlier failed run and the edit landed there (live 2026-08-20).
    const anchorMatch = intentText.match(
      /\b(?:the|my|our)\s+([a-z0-9][\w -]{1,40}?)\s+(?:page|app|site|game|tool)\b/i,
    );
    const taskTokens = new Set(
      (anchorMatch ? anchorMatch[1] : `${intentText} ${task}`)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );
    let newest: { dir: string; mtimeMs: number } | undefined;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(appsDir);
    } catch {
      // error-policy:J6 unreadable apps dir just skips the reuse scan.
    }
    for (const name of entries) {
      const tokens = name.replace(/-\d+$/, "").split("-").filter(Boolean);
      if (tokens.length === 0) continue;
      if (!tokens.every((token) => taskTokens.has(token))) continue;
      if (
        !tokens.some(
          (token) => token.length >= 4 && !GENERIC_NAME_TOKENS.has(token),
        )
      ) {
        continue;
      }
      const candidate = nodePathJoin(appsDir, name);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isDirectory() || fs.readdirSync(candidate).length === 0) {
          continue;
        }
        if (!newest || stat.mtimeMs > newest.mtimeMs) {
          newest = { dir: candidate, mtimeMs: stat.mtimeMs };
        }
      } catch {
        // error-policy:J6 an unreadable candidate just drops out of the scan.
      }
    }
    if (newest) {
      if (runtime) {
        logger(runtime).info(
          `[app-slug] edit-intent ask reuses existing app dir ${newest.dir}`,
        );
      }
      return newest.dir;
    }
  }
  let slug = baseSlug;
  for (let n = 2; n <= 9; n++) {
    const candidate = nodePathJoin(appsDir, slug);
    if (!fs.existsSync(candidate) || fs.readdirSync(candidate).length === 0) {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    }
    slug = `${baseSlug}-${n}`;
  }
  return declined("slug collision cap reached");
}

/** The registered workspace whose path is `workdir`, if any. Planner-supplied
 *  workdirs on repo-targeted asks are usually context junk (a stale workspace
 *  path copied from room history — live 2026-08-18); only a path the registry
 *  actually tracks is a trustworthy binding. */
function registeredWorkspaceForPath(
  service: { listWorkspaces(): Array<{ id: string; path: string }> } | null,
  workdir: string | undefined,
): { id: string; path: string } | undefined {
  if (!service || !workdir?.trim()) return undefined;
  try {
    const resolved = nodePathResolve(workdir);
    return service
      .listWorkspaces()
      .find((workspace) => nodePathResolve(workspace.path) === resolved);
  } catch {
    // error-policy:J3 an unresolvable path is simply not a registered workspace.
    return undefined;
  }
}

/** The execution contract appended to a provisioned-repo task. Children
 *  commit behind an isolated git wrapper and CANNOT push or open PRs — by
 *  design the orchestrator owns credentials. Without saying so, a task
 *  phrased "…and open a pull request" strands the child on an impossible
 *  step: live 2026-08-18, children edited the file, never committed, and
 *  ended (or stalled) without a commit for auto-submit to ship. */
function withProvisionedRepoContract(task: string, repo: string): string {
  return (
    `${task}

--- Workspace contract ---
` +
    `You are working in a local clone of ${repo} on a dedicated branch.
` +
    `Make the requested changes and COMMIT them locally (configure a git ` +
    `identity first if the commit asks for one).
` +
    `Do NOT push and do NOT try to open the pull request yourself - you do ` +
    `not have credentials. The orchestrator pushes your branch and opens ` +
    `the pull request automatically after you finish. Finish once your ` +
    `commit is in.`
  );
}

/**
 * Resolve the repo a spawn/create should provision, tolerant of how humans
 * actually ask: an explicit `repo` param, a URL anywhere in the request, an
 * `owner/name` form, or a possessive bare name ("my eliza-code-sandbox
 * repo") whose owner is the configured GitHub identity. Returns a
 * normalized repository input or undefined.
 */
async function resolveRequestedRepo(
  runtime: IAgentRuntime,
  params: Record<string, unknown>,
  requestTexts: ReadonlyArray<string | undefined>,
  userOnlyText?: string,
): Promise<string | undefined> {
  const rawParamRepo =
    typeof params.repo === "string" && params.repo.trim()
      ? params.repo.trim()
      : undefined;
  // The planner's repo param is model output and arrives corrupted on asks
  // that never named a repo (live 2026-08-19: repo="NubsCarson/»,requestedBackend:"
  // on "make me a lil word counter page" failed the spawn on a clone the user
  // never asked for). Only a URL or owner/name-shaped value counts; garbage
  // is dropped so the ask proceeds as the repo-less task it is.
  const paramRepo =
    rawParamRepo &&
    /^(?:https?:\/\/[\w./-]+|git@[\w.-]+:[\w./-]+|[\w.-]+(?:\/[\w.-]+)?)$/.test(
      rawParamRepo,
    )
      ? rawParamRepo
      : undefined;
  if (rawParamRepo && !paramRepo) {
    logger(runtime).warn(
      `[TASKS] ignoring malformed planner repo param: ${JSON.stringify(rawParamRepo).slice(0, 80)}`,
    );
  }
  const text = requestTexts.filter(Boolean).join("\n");
  // A shape-valid repo param can still be invented: the planner fabricated
  // https://github.com/NubsCarson/recipe-box-app.git for "make me a lil
  // recipe box page" and the spawn died on a clone the user never asked for
  // (live 2026-08-19). A repo is only honored when the USER's text grounds
  // it — a repo/git keyword, or the repo's own name appearing in the ask.
  let groundedParamRepo = paramRepo;
  if (paramRepo) {
    // Ground against the USER'S OWN WORDS only. The composed task text is
    // planner output — it grounds its own hallucination (live 2026-08-19:
    // the planner invented NubsCarson/coin-toss-streak AND wrote "repo" into
    // the task, so the joined-text check passed and the spawn died cloning).
    const groundingText = userOnlyText ?? text;
    const lowerText = groundingText.toLowerCase();
    const repoName = paramRepo
      .replace(/^https?:\/\/[^/]+\//i, "")
      .replace(/^git@[\w.-]+:/i, "")
      .replace(/\.git$/i, "")
      .split("/")
      .pop();
    const grounded =
      /\b(?:repo|repository|github|gitlab|bitbucket|clone|\.git|branch|pull request|pr)\b/i.test(
        groundingText,
      ) ||
      (repoName !== undefined &&
        repoName.length > 2 &&
        lowerText.includes(repoName.toLowerCase()));
    if (!grounded) {
      logger(runtime).warn(
        `[TASKS] ignoring ungrounded planner repo param (user text names no repo): ${paramRepo.slice(0, 80)}`,
      );
      groundedParamRepo = undefined;
    }
  }
  let candidate = groundedParamRepo;
  if (!candidate) {
    const url = text.match(
      /https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+(?:\.git)?/i,
    );
    if (url) candidate = url[0];
  }
  if (!candidate) {
    const slug = text.match(/\b([\w.-]+)\/([\w.-]+)\b(?=[^/]|$)/);
    if (slug && /\brepo(?:sitory)?\b/i.test(text)) {
      candidate = `${slug[1]}/${slug[2]}`;
    }
  }
  // Planner models emit placeholder owners when they only know the bare name
  // (live 2026-08-18: repo="https://github.com/yourusername/eliza-code-sandbox"
  // for a "my eliza-code-sandbox repo" ask — the clone then fails, or worse).
  // A placeholder owner is not identity; strip it so the bare name resolves
  // through the configured token owner like any possessive ask.
  if (candidate) {
    const slugForm = candidate
      .replace(/^https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\//i, "")
      .replace(/\.git$/i, "");
    const parts = slugForm.split("/");
    if (
      parts.length >= 2 &&
      parts[0] !== undefined &&
      parts[1] !== undefined &&
      PLACEHOLDER_REPO_OWNERS.has(parts[0].toLowerCase())
    ) {
      candidate = parts[1];
    }
  }
  // Possessive bare name: "my <name> repo" / "<name> repo" + a param repo
  // that is a bare name — owner defaults to the configured token's account.
  const bare =
    candidate && !candidate.includes("/")
      ? candidate
      : (text.match(/\bmy\s+([\w.-]+)\s+repo\b/i)?.[1] ?? undefined);
  if (bare && !candidate?.includes("/")) {
    const owner = await githubTokenOwner(runtime);
    if (owner) candidate = `${owner}/${bare}`;
    else return undefined;
  }
  if (!candidate) return undefined;
  let normalized: string | undefined;
  try {
    normalized = normalizeRepositoryInput(candidate);
  } catch {
    // error-policy:J3 an unparseable candidate is not a repo request.
    return undefined;
  }
  // Planner models also GUESS plausible-but-wrong owners the placeholder list
  // cannot catch (live 2026-08-18: "github.com/nubs/eliza-code-sandbox" for a
  // "my eliza-code-sandbox repo" ask — the token owner is NubsCarson). When a
  // possessive bare name is in the request, verify the candidate exists and
  // fall back to <token-owner>/<name> when it does not. Verification is
  // best-effort: no token or an API failure keeps the candidate untouched,
  // and the clone failure stays the loud backstop.
  const possessiveName = text.match(/\bmy\s+([\w.-]+)\s+repo\b/i)?.[1];
  if (possessiveName) {
    const exists = await repositoryExists(runtime, normalized);
    if (exists === false) {
      const owner = await githubTokenOwner(runtime);
      if (owner) {
        const fallback = `${owner}/${possessiveName}`;
        if ((await repositoryExists(runtime, fallback)) === true) {
          return normalizeRepositoryInput(fallback);
        }
      }
    }
  }
  return normalized;
}

/** true / false when the GitHub API answered, null when unverifiable (no
 *  token, non-github host, network failure). */
async function repositoryExists(
  runtime: IAgentRuntime,
  repoInput: string,
): Promise<boolean | null> {
  try {
    const token = runtime.getSetting("GITHUB_TOKEN");
    if (typeof token !== "string" || !token.trim()) return null;
    const slug = repoInput
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\.git$/i, "");
    if (/^https?:\/\//i.test(slug) || slug.split("/").length !== 2) {
      return null;
    }
    const res = await fetch(`https://api.github.com/repos/${slug}`, {
      headers: {
        Authorization: `token ${token.trim()}`,
        "User-Agent": "eliza-orchestrator",
      },
    });
    if (res.status === 404) return false;
    if (res.ok) return true;
    return null;
  } catch {
    // error-policy:J4 existence probing is best-effort routing sugar.
    return null;
  }
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
    // Planner-facing only (same contract as runSend): the evaluator owns
    // telling the user coding tasks are unavailable, in voice.
    return errorResult(
      "SERVICE_UNAVAILABLE",
      "ACP service is not available. Cannot spawn a task agent.",
    );
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
    const {
      workdir,
      route,
      isolate: resolvedIsolate,
    } = resolveSpawnWorkdir(
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
    const memoryContent = pickString(params, content, "memoryContent");
    const approvalPreset = parseApproval(
      pickString(params, content, "approvalPreset"),
    );
    const extraMetadata = additionalSessionMetadata(params, content);
    const keepAliveAfterComplete = hasVerifiedRetryLifecycle(
      params,
      content,
      extraMetadata,
    );
    // Structural only: the planner emits deferUserReply when the user asked for
    // no interim reply. No regex over the task text (the model judges intent).
    const deferUserReply =
      pickBoolean(params, content, "deferUserReply") === true;
    // A planner-supplied label is free text; clamp like the derived fallback
    // so listings, room names, and progress lines stay bounded.
    const labelParam = pickString(params, content, "label");
    const label = labelParam
      ? userReferenceLogView(labelParam)
      : clampLabel(task);
    const originConnectorMessageId = connectorMessageIdFromMemory(
      message,
      content,
    );
    // Router-driven re-spawns (failed-verification respawn loops) and nested
    // swarm children joining an explicit task room legitimately restate the
    // in-flight goal — the guard only screens fresh user-originated spawns.
    const userOriginatedSpawn =
      content.source !== MESSAGE_SOURCE_SUB_AGENT &&
      extraMetadata.subAgent !== true &&
      !pickRoutingString(params, content, extraMetadata, "taskRoomId")?.trim();
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
        return duplicateSpawnGuardResult(runtime, callback, duplicate);
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
    let effectiveRoute = route ?? inheritedRoute;
    let effectiveWorkdir = effectiveRoute?.workdir ?? workdir;
    // Only isolate per-session when we fell back to a shared scratch root (no
    // route). A route resolves to a specific project dir that must be used as-is.
    let isolateWorkdir = effectiveRoute ? false : resolvedIsolate === true;
    // A repo-targeted spawn must run IN A CLONE of that repo. The schema
    // advertises `repo` but only provision_workspace consumed it, so a
    // "branch + commit + PR in <repo>" ask spawned into the cwd fallback and
    // the sub-agent rummaged the HOME DIRECTORY (live 2026-08-17: repo param
    // present, workdir=/home/milady, report listed "Desktop" and "Git" as its
    // created files). When no route/explicit workdir claimed the spawn and a
    // repo is requested, provision the workspace clone here and bind to it.
    let provisionedRepo: string | undefined;
    let provisionedWorkspaceId: string | undefined;
    const requestedRepo = await resolveRequestedRepo(
      runtime,
      params as Record<string, unknown>,
      [task, requestText(message)],
      requestText(message),
    );
    if (requestedRepo && effectiveRoute) {
      logger(runtime).info(
        `[TASKS:spawn_agent] explicit repo ${requestedRepo} outranks route ${effectiveRoute.id ?? effectiveRoute.workdir}; provisioning a clone`,
      );
    }
    if (requestedRepo) {
      const workspaceService = getCodingWorkspaceService(runtime);
      // Same registered-workdir contract as the create path: a planner
      // workdir only binds a repo ask when the registry tracks it.
      const registeredSpawnWorkspace = registeredWorkspaceForPath(
        workspaceService,
        explicitWorkdir,
      );
      if (registeredSpawnWorkspace) {
        effectiveWorkdir = registeredSpawnWorkspace.path;
        isolateWorkdir = false;
        provisionedWorkspaceId = registeredSpawnWorkspace.id;
      } else if (workspaceService) {
        if (explicitWorkdir) {
          logger(runtime).info(
            `[TASKS:spawn_agent] ignoring unregistered workdir ${explicitWorkdir} on repo-targeted spawn; provisioning ${requestedRepo}`,
          );
        }
        try {
          const workspace = await workspaceService.provisionWorkspace({
            repo: requestedRepo,
            useWorktree: false,
          });
          effectiveWorkdir = workspace.path;
          isolateWorkdir = false;
          provisionedRepo = requestedRepo;
          provisionedWorkspaceId = workspace.id;
          logger(runtime).info(
            `[TASKS:spawn_agent] provisioned repo workspace for spawn: ${requestedRepo} -> ${workspace.path}`,
          );
        } catch (error) {
          // error-policy:J2 a repo the user named that cannot be provisioned
          // must fail the spawn loudly — running the task in an unrelated
          // directory is the worse outcome.
          const text = `Could not clone ${requestedRepo} for this task: ${
            error instanceof Error ? error.message : String(error)
          }`;
          return { success: false, text, error: new Error(text) };
        }
      }
    }
    if (!provisionedWorkspaceId) {
      const slugDir = appBuildSlugWorkdir(
        task,
        typeof params.label === "string" && params.label ? params.label : task,
        effectiveWorkdir,
        runtime,
        requestText(message),
      );
      if (slugDir) {
        effectiveWorkdir = slugDir;
        isolateWorkdir = false;
        // Same route re-resolution as the create path: the slug dir needs the
        // apps route stamp or the residuals gate misreads the shared checkout.
        effectiveRoute =
          resolveRouteForWorkdir(runtime, slugDir) ?? effectiveRoute;
        logger(runtime).info(
          `[TASKS:spawn_agent] app build runs in its served slug dir: ${slugDir}`,
        );
      }
    }
    const spawnTaskForChild =
      provisionedWorkspaceId && requestedRepo
        ? withProvisionedRepoContract(task, requestedRepo)
        : task;
    const taskWithRouteHints = taskWithResolvedRoute(
      spawnTaskForChild,
      provisionedWorkspaceId ? undefined : effectiveRoute,
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
        logger(runtime).warn(
          `[TASKS:spawn_agent] per-origin spawn cap (${cap}) reached for ${spawnOriginKey}; relaying best result instead of re-spawning`,
        );
        // Relay the captured deliverable when we have one (the router records
        // it before its early returns too) — verbatim, it IS the answer.
        const bestText = (best?.deliverable ?? best?.text ?? "").trim();
        if (bestText) {
          await callbackText(callback, bestText);
          return {
            success: true,
            text: bestText,
            continueChain: false,
            data: { actionName: "TASKS", spawnCapped: true },
          };
        }
        // No captured result: `continueChain:false` ends the turn, so no
        // later planner call exists to phrase the facts — phrase the honest
        // "attempt cap exhausted" report here (factual fallback on model
        // outage) and deliver it via the callback, like the relay above. Be
        // explicit that nothing is still in flight (capped-and-failed, not
        // in-progress).
        const { text: exhaustedText } = await phraseForUser(
          runtime,
          {
            intent: "fail",
            facts: {
              attempts: cap,
              outcome: "no attempt produced a result",
              retriesStopped: true,
              nothingStillRunning: true,
              suggestion:
                "the user could give more specific instructions or smaller steps",
            },
            mustInclude: [String(cap)],
            mustNotClaim: ["work is still in progress", "the task succeeded"],
          },
          `I tried that ${cap} times and no attempt produced a result, so I stopped retrying — nothing is still running. More specific instructions or smaller steps might help.`,
        );
        await callbackText(callback, exhaustedText);
        return {
          success: true,
          text: exhaustedText,
          continueChain: false,
          data: {
            actionName: "TASKS",
            spawnCapped: true,
            attempts: cap,
            outcome: "exhausted",
          },
        };
      }
    }

    // Boot-race gate (before the spawn slot wait and before spawnSession): a
    // coordinator stuck unbound after a restart black-holes spawns, so refuse
    // honestly — nothing is running — instead of letting the effect-receipt
    // guard invent the reply.
    const supervision = await awaitCodingSupervisionBound(runtime);
    if (!supervision.ok) {
      logger(runtime).warn(
        `[TASKS:spawn_agent] refusing spawn — coding supervision unavailable: ${supervision.reason}`,
      );
      return supervisionUnavailableResult(supervision.reason);
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
        ...(provisionedRepo ? { repo: provisionedRepo } : {}),
        ...(provisionedWorkspaceId ? { provisionedWorkspaceId } : {}),
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

    // Post-spawn liveness receipt: spawnSession returning is not proof the
    // session came up — a residual black-hole (boot race, transport fault)
    // leaves no live record or one already terminal at birth. Fail loudly
    // instead of returning the optimistic pending-status text, regardless of
    // root cause. Counted against the per-origin cap above so a broken
    // supervisor can't drive an unbounded respawn loop.
    const liveSession = await Promise.resolve(
      service.getSession(session.sessionId),
    );
    if (
      !liveSession ||
      TERMINAL_SESSION_STATUSES.has(String(liveSession.status))
    ) {
      const liveStatus = liveSession ? String(liveSession.status) : "missing";
      logger(runtime).error(
        `[TASKS:spawn_agent] session ${session.sessionId} did not come up (status=${liveStatus}); reporting spawn failure`,
      );
      return {
        success: false,
        error: "CODING_SESSION_DID_NOT_START",
        text: "The coding sub-agent session did not come up; nothing is running. Try again in a moment.",
        continueChain: false,
        data: { sessionId: session.sessionId, status: liveStatus },
      };
    }

    // Verify-driven respawn (router-stamped synthetic inbound): the original
    // request was already ack'd once — claim the request-voice ack slot for
    // the successor session so the progress hook's ack is denied. The action
    // text below is already planner-facing, so no further suppression needed.
    // The key composes root + inherited fan-out part via the router's ladder,
    // so a lane respawn claims/revives ITS lane's slot only.
    if (extraMetadata.subAgent === true) {
      const spawnVoicePart = plainString(extraMetadata.requestVoicePart);
      const respawnVoiceKey =
        requestVoiceKeyForMeta({
          ...(spawnRootMessageId ? { spawnRootMessageId } : {}),
          ...(spawnVoicePart ? { requestVoicePart: spawnVoicePart } : {}),
        }) ?? undefined;
      claimRouterRequestAck(runtime, respawnVoiceKey, session.sessionId);
      reviveRouterRequestVoice(runtime, respawnVoiceKey);
    }

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
      const spawnDurableService = runtime.getService?.(
        OrchestratorTaskService.serviceType,
      ) as OrchestratorTaskService | null | undefined;
      if (
        !spawnDurableService ||
        typeof spawnDurableService.createTask !== "function" ||
        typeof spawnDurableService.attachSession !== "function"
      ) {
        // Same degrade class as the catch below, and it must be JUST as loud:
        // a not-yet-registered task service at spawn time silently produced a
        // session with no durable owner — no restart protection, no
        // verification, invisible to the task list (live 2026-08-17,
        // ivy-lattice ~90s after boot).
        logger(runtime).error(
          `[TASKS:spawn_agent] durable task service unavailable for ${session.sessionId}; session runs WITHOUT restart protection or verification`,
        );
      } else {
        try {
          const detail = await spawnDurableService.createTask({
            title: label,
            // The durable goal is what smithers step prompts, verify
            // re-engages, and restart resumes compose FROM — the raw planner
            // task here dropped the resolved-route contract on the child's
            // actual prompt (live: tide-lines wrote to the workdir ROOT and
            // 404'd because the data/apps placement rules never reached it,
            // while initialTask carried them unused).
            goal: taskWithRouteHints,
            kind: "coding",
            priority: "normal",
            originalRequest: requestText(message),
            ...(session.workdir ? { workdir: session.workdir } : {}),
            ...(message.roomId ? { roomId: message.roomId } : {}),
            ...(resolvedTaskRoomId ? { taskRoomId: resolvedTaskRoomId } : {}),
            metadata: {
              ...(resolvedSpawnSource ? { source: resolvedSpawnSource } : {}),
              // Durable copy of the per-request root id: without it the
              // task-service respawn key degrades to task:<taskId> and the
              // park-notice dedupe loses cross-task-record matching.
              ...(spawnRootMessageId ? { spawnRootMessageId } : {}),
              // Durable copy of the fan-out part (when this spawn is a lane
              // respawn) so this task's respawns and park notice stay keyed
              // to the SAME per-lane voice slot.
              ...(plainString(extraMetadata.requestVoicePart)
                ? {
                    requestVoicePart: plainString(
                      extraMetadata.requestVoicePart,
                    ),
                  }
                : {}),
              spawnPath: "spawn_agent",
            },
          });
          durableTaskId = detail?.id ?? null;
          if (durableTaskId) {
            await spawnDurableService.attachSession(durableTaskId, {
              sessionId: session.sessionId,
              agentType: session.agentType,
              workdir: session.workdir,
              status: session.status,
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
    // User-facing ack is a SHORT model-phrased line — the structured spawn
    // status below stays planner-facing only. The verbose "Spawned coding
    // sub-agent … working asynchronously" text reached normies verbatim
    // (owner feedback 2026-08-19: dev-speak; wants "on it"-class acks).
    // An explicit planner deferUserReply means the user asked for no interim
    // reply — honor it by skipping the visible ack entirely (the structured
    // status below still grounds the planner's finish pass).
    const spawnAckText = deferUserReply
      ? undefined
      : (
          await phraseForUser(
            runtime,
            {
              intent: "notify",
              facts: { label, working: true, resultWillFollow: true },
              mustNotClaim: ["the work is finished"],
            },
            "on it.",
          )
        ).text;
    if (spawnAckText) {
      await callbackText(callback, spawnAckText, { voiced: true });
    }
    return {
      success: true,
      text: `Spawned coding sub-agent "${label}" (${session.agentType}). It is working asynchronously — its result is not available yet and will arrive as a follow-up message.`,
      ...(spawnAckText
        ? { userFacingText: spawnAckText, verifiedUserFacing: true }
        : {}),
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
      // costs 5x more Cerebras tokens, and (c) wastes sub-agent CPU
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
      // Deterministic interrupt redirect: the planner routinely answers a
      // mid-build follow-up with a SEND, but the interruption path has just
      // killed that session so a successor can absorb the new instruction —
      // the send then died SESSION_NOT_FOUND and no successor ever spawned
      // (live 2026-08-20: "Session 7df50ecd not found." was the user-visible
      // end of "oh also add a running score counter"). When an
      // interrupt-stopped predecessor with a recorded task exists in this
      // room, convert the send into the successor create carrying BOTH the
      // original task and the follow-up.
      const followUp =
        pickString(params, content, "input") ??
        pickString(params, content, "task");
      if (followUp) {
        const roomId = String(_message.roomId ?? "");
        const all = await Promise.resolve(service.listSessions());
        const predecessor = [...all].reverse().find((candidate) => {
          const meta = candidate.metadata as
            | Record<string, unknown>
            | undefined;
          return (
            typeof meta?.[ADMIN_STOP_META_KEY] === "string" &&
            String(meta[ADMIN_STOP_META_KEY]).includes("interrupt") &&
            typeof meta.initialTask === "string" &&
            (!roomId || String(meta.roomId ?? "") === roomId)
          );
        });
        const predecessorMeta = predecessor?.metadata as
          | Record<string, unknown>
          | undefined;
        const rawPredecessorTask =
          typeof predecessorMeta?.initialTask === "string"
            ? predecessorMeta.initialTask
            : "";
        const marker = "--- User Task ---";
        const markerAt = rawPredecessorTask.indexOf(marker);
        const predecessorTask = (
          markerAt >= 0
            ? rawPredecessorTask.slice(markerAt + marker.length)
            : rawPredecessorTask
        ).trim();
        if (predecessor && predecessorTask) {
          logger(runtime).info(
            `[TASKS:send] target session gone after interrupt; redirecting follow-up to a successor create (predecessor=${predecessor.id})`,
          );
          return runCreateLegacy(
            runtime,
            _message,
            state,
            {
              ...params,
              action: "create",
              task: `${predecessorTask}\n\nFollow-up from the user (fold into the SAME deliverable): ${followUp}`,
            },
            content,
            _callback,
          );
        }
      }
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
      // A smithers-driven session's conversation is OWNED by the workflow
      // executor — an interactive send resolves but is never consumed (live
      // 2026-08-20: "add streak counts" vanished; the page shipped without
      // it and the user got only an unconfirmed-send hedge). Queue through
      // the inbox instead; the idle-flush delivers it as a real follow-up
      // turn the moment the workflow settles.
      const smithersLink = (
        target.session.metadata as
          | { smithersDurableRun?: { state?: string } }
          | undefined
      )?.smithersDurableRun;
      const smithersActive =
        smithersLink?.state === "running" || smithersLink?.state === "pending";
      const queueInbox = (
        runtime as IAgentRuntime & {
          __orchestratorSubAgentInbox?: {
            enqueue: (sessionId: string, text: string) => void;
          };
        }
      ).__orchestratorSubAgentInbox;
      if (smithersActive && queueInbox) {
        queueInbox.enqueue(target.session.id, textInput);
        return {
          success: true,
          text: "The agent is mid-build; the instruction is queued and will be delivered the moment the current run settles. Do NOT stop or respawn the agent for this.",
          data: {
            sessionId: target.session.id,
            queued: true,
            ...(task ? { task } : {}),
          },
          continueChain: false,
        };
      }
      try {
        await service.sendToSession(target.session.id, textInput);
      } catch (error) {
        // A busy session is not a failure — it is exactly what the
        // sub-agent inbox exists for. The bare "ACP session is already
        // busy" error sent the planner escalating to STOPPING the running
        // build (live 2026-08-20, bmi-calculator follow-up); queue instead
        // and let the idle-flush deliver it between turns.
        const inbox = (
          runtime as IAgentRuntime & {
            __orchestratorSubAgentInbox?: {
              enqueue: (sessionId: string, text: string) => void;
            };
          }
        ).__orchestratorSubAgentInbox;
        if (isSessionBusyError(error) && inbox) {
          inbox.enqueue(target.session.id, textInput);
          return {
            success: true,
            text: "The agent is mid-step; the instruction is queued and will be delivered the moment the current step settles. Do NOT stop or respawn the agent for this.",
            data: {
              sessionId: target.session.id,
              queued: true,
              ...(task ? { task } : {}),
            },
            continueChain: false,
          };
        }
        throw error;
      }
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
    const allSessions = await Promise.resolve(service.listSessions());
    // Only genuinely active sessions are stoppable work; sweeping stored
    // terminal rows inflated the confirmation ("Stopped 14 task agents" for
    // one running build, live 2026-08-19).
    const sessions = allSessions.filter((session) =>
      ["busy", "ready", "starting"].includes(session.status),
    );

    if (all) {
      // allSettled: one unstoppable historical row must not fail the whole
      // sweep into the hedged "may have gone through" reply while the live
      // sessions DID stop (live 2026-08-19).
      const settled = await Promise.allSettled(
        sessions.map(async (session) => {
          // Mark BEFORE stopping so the terminal relay sees the stamp when the
          // stopped event lands — the action's own confirmation below is the
          // single manual-stop notice.
          await markSessionAdministrativelyStopped(
            service,
            session.id,
            "user_stop",
          );
          await service.stopSession(session.id);
        }),
      );
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          logger(runtime).warn(
            `[TASKS:stop_agent] one session stop failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          );
        }
      }
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
      // Model-phrased from facts; canonical text assigned pre-callback so the
      // settle receipt binding holds.
      const { text } = await phraseForUser(
        runtime,
        {
          intent: "confirm",
          facts: { stoppedCount: sessions.length },
        },
        `Stopped ${sessions.length} task agent${sessions.length === 1 ? "" : "s"}.`,
      );
      await callbackText(callback, text);
      return {
        success: true,
        text,
        userFacingText: text,
        verifiedUserFacing: true,
        turnComplete: true,
        data: {
          stoppedCount: sessions.length,
          stoppedSessions: sessions.map((session) => session.id),
        },
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
      const { text: noneText } = await phraseForUser(
        runtime,
        {
          intent: "notify",
          facts: { stoppedCount: 0, nothingRunning: true },
          mustNotClaim: ["anything was stopped"],
        },
        "There are no task agents running.",
      );
      await callbackText(callback, noneText);
      return {
        success: true,
        text: noneText,
        userFacingText: noneText,
        verifiedUserFacing: true,
        turnComplete: true,
      };
    }

    // Mark BEFORE stopping (see the all-sessions branch): the action's
    // verified "Stopped the task agent." is the single manual-stop notice; a
    // coordinator-synthesized "stopped before completion" would be a duplicate.
    await markSessionAdministrativelyStopped(service, target.id, "user_stop");
    await service.stopSession(target.id);
    if (
      (state as { codingSession?: { id?: string } } | undefined)?.codingSession
        ?.id === target.id
    ) {
      (state as { codingSession?: unknown }).codingSession = undefined;
    }
    const { text: stoppedText } = await phraseForUser(
      runtime,
      {
        intent: "confirm",
        facts: { stoppedCount: 1, label: labelFor(target) },
      },
      "Stopped the task agent.",
    );
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
  _callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const service = getAcpService(runtime);
  if (!service) {
    // Planner-facing only (see runSend): the evaluator voices unavailability.
    return errorResult("SERVICE_UNAVAILABLE", "ACP service is not available.");
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
        // Mark BEFORE cancelling so the terminal relay suppresses its own
        // stop notice — the cancel confirmation below is the single notice.
        await markSessionAdministrativelyStopped(
          service,
          session.id,
          "user_cancel",
        );
        await (service.cancelSession?.(session.id) ??
          service.stopSession(session.id));
        stoppedSessions.push(session.id);
      }
      // The cancel confirmation is the complete answer to a single-operation
      // turn: verified + turnComplete make the callback the sole delivery.
      const { text } = await phraseForUser(
        runtime,
        {
          intent: "confirm",
          facts: { canceledCount: stoppedSessions.length },
        },
        `Canceled ${stoppedSessions.length} task${stoppedSessions.length === 1 ? "" : "s"}.`,
      );
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

    // Mark BEFORE cancelling (see the all-sessions branch above).
    await markSessionAdministrativelyStopped(service, target.id, "user_cancel");
    await (service.cancelSession?.(target.id) ??
      service.stopSession(target.id));
    // Chat gets the task LABEL (findInFlightWork naming), never the raw
    // session/thread id — structural ids stay in data as receipts.
    const label = labelFor(target);
    const { text } = await phraseForUser(
      runtime,
      {
        intent: "confirm",
        facts: { canceledCount: 1, label },
        mustInclude: [label],
      },
      `Canceled "${label}".`,
    );
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
    // A session with no attached client or no active prompt already finished
    // — "cancel" on it is a no-op, not a failure. Relaying the internal error
    // read as breakage for work that had completed seconds earlier (live
    // 2026-08-19: "Failed to cancel task: ACP native session has no attached
    // client" right after the build's own completion message).
    const code = error instanceof ElizaError ? error.code : undefined;
    if (
      code === "ACP_NATIVE_CLIENT_MISSING" ||
      code === "ACP_CANCEL_NO_ACTIVE_PROMPT"
    ) {
      const text =
        "nothing to cancel — that task already finished before the cancel landed.";
      await callbackText(callback, text);
      return {
        success: true,
        text,
        userFacingText: text,
        verifiedUserFacing: true,
        turnComplete: true,
        data: { status: "already_finished" },
      };
    }
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
// waiting_on_user is deliberately ABSENT: a parked task is human-gated, not
// in flight — hours-old parked builds were matching UNRELATED new requests
// and stranding them ("wind-chimes build, waiting_on_user" blocked a github
// branch+PR ask, live 2026-08-17). A genuine follow-up about parked work
// needs no spawn, so the guard has nothing to protect there.
const IN_FLIGHT_TASK_STATUSES: ReadonlySet<string> = new Set([
  "open",
  "active",
  "validating",
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
  // max(): a short label overlapping a long request must not read as a near
  // duplicate. The old min() denominator let "tide-glass" match "ember-tide
  // build" on one shared token (live 2026-08-17).
  return overlap / Math.max(tokensA.size, tokensB.size);
}

const DUPLICATE_SPAWN_SIMILARITY_THRESHOLD = 0.6;

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
        const rawInitialTask =
          typeof session.metadata?.initialTask === "string"
            ? session.metadata.initialTask
            : "";
        // Compare only the GOAL, not the injected workspace/route contract:
        // every routed quick-app carries the same boilerplate sections, which
        // made unrelated builds read as near-duplicates of each other.
        const initialTask =
          rawInitialTask.split("--- Resolved Workspace ---")[0] ?? "";
        const existingText = `${label ?? ""} ${initialTask}`;
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

/**
 * Duplicate-spawn guard reply: the request matched work already in flight, so
 * no new agent starts. `continueChain:false` terminates the turn, which means
 * NO later planner call exists to phrase these facts — so the guard phrases
 * them itself through `phraseForUser` (deterministic factual fallback on
 * model outage) and delivers via the callback, exactly like the cap-relay
 * branch above it.
 */
async function duplicateSpawnGuardResult(
  runtime: IAgentRuntime,
  callback: HandlerCallback | undefined,
  duplicate: {
    name: string;
    status: string;
  },
): Promise<ActionResult> {
  const statusFact =
    duplicate.status === "validating"
      ? "finished its work and is awaiting completion verification"
      : duplicate.status;
  const { text } = await phraseForUser(
    runtime,
    {
      intent: "notify",
      facts: {
        existingWork: duplicate.name,
        currentState: statusFact,
        newAgentStarted: false,
        howToForceFreshAttempt: 'the user says "run it again"',
      },
      // The quoted label is a fact receipt; the generic fallback name is not
      // forced (it contains no user-recognizable identity to anchor on).
      ...(duplicate.name.startsWith('"')
        ? { mustInclude: [duplicate.name] }
        : {}),
      mustNotClaim: ["new work started"],
    },
    `That work (${duplicate.name}, ${statusFact}) is already underway. I didn't start a new one — say "run it again" for a fresh attempt.`,
  );
  await callbackText(callback, text);
  return {
    success: true,
    text,
    continueChain: false,
    data: {
      actionName: "TASKS",
      duplicateSpawnGuard: true,
      duplicateOfLabel: duplicate.name,
      status: duplicate.status,
    },
  };
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

/**
 * Planner-facing task-policy denial. The task-policy reason string is
 * planner/log detail — it is NOT echoed to chat via callback; the planner
 * phrases the denial (a denial stays a denial; role names only) from the
 * structured {requiredRole, actualRole, connector} facts in data.
 */
function taskPolicyDenialResult(
  actionName: string,
  access: {
    connector: string | null;
    requiredRole: string;
    actualRole: string;
    reason: string;
  },
): ActionResult {
  return failureResult(actionName, "FORBIDDEN", access.reason, {
    reason: "access_denied",
    requiredRole: access.requiredRole,
    actualRole: access.actualRole,
    connector: access.connector,
  });
}

async function runHistory(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  _callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const access = await requireTaskAgentAccess(runtime, message, "interact");
  if (!access.allowed) {
    return taskPolicyDenialResult("TASKS:history", access);
  }

  const text = requestText(message);
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
      // error-policy:J1 history action boundary → structured failure to the
      // planner (symmetric with the plannerOnlyRead successes: no callback).
      const msg = failureMessage(error);
      return failureResult("TASKS:history", "TASK_HISTORY_FAILED", msg);
    }
  }

  const service = getAcpService(runtime);
  if (!service) {
    return failureResult(
      "TASKS:history",
      "SERVICE_UNAVAILABLE",
      "ACP service is not available.",
      { reason: "acp_unavailable" },
    );
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
    return taskPolicyDenialResult("TASKS:control", access);
  }

  const service = getAcpService(runtime);
  if (!service) {
    // Planner-facing only: the evaluator voices unavailability.
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
      const { text: out } = await phraseForUser(
        runtime,
        {
          intent: "confirm",
          facts: { action: "resume", resumed: true },
        },
        "Resumed the coding task.",
      );
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

  const controlLabel = labelFor(target.session);
  let responseText = "";
  if (action === "stop") {
    // Mark BEFORE stopping: admin-stop-marker-first ordering is load-bearing —
    // the control confirmation below stays the single manual-stop notice.
    await markSessionAdministrativelyStopped(
      service,
      target.session.id,
      "user_stop",
    );
    await service.stopSession(target.session.id);
    responseText = (
      await phraseForUser(
        runtime,
        {
          intent: "confirm",
          facts: { action: "stop", label: controlLabel },
        },
        "Stopped the coding task.",
      )
    ).text;
  } else {
    const nextInstruction =
      instruction?.trim() || "Continue with the current task.";
    await service.sendToSession(target.session.id, nextInstruction);
    responseText = (
      await phraseForUser(
        runtime,
        {
          intent: "confirm",
          facts: { action: "forwarded follow-up", label: controlLabel },
          mustNotClaim: ["the follow-up work is already done"],
        },
        "Passed your follow-up instructions to the coding agent.",
      )
    ).text;
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
  _callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const access = await requireTaskAgentAccess(runtime, message, "interact");
  if (!access.allowed) {
    return taskPolicyDenialResult("TASKS:share", access);
  }

  const service = getAcpService(runtime);
  if (!service) {
    // Planner-facing only (symmetric with the plannerOnlyRead successes).
    return errorResult("SERVICE_UNAVAILABLE", "ACP service is not available.");
  }

  const target = await resolveSession(
    service,
    pickString(params, _content, "sessionId"),
    state,
  );
  if (!target.session) {
    return errorResult(
      "SESSION_NOT_FOUND",
      "No active coding session was found to share.",
    );
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
    return taskPolicyDenialResult("TASKS:provision_workspace", access);
  }

  const workspaceService = getCodingWorkspaceService(runtime);
  if (!workspaceService) {
    // Planner-facing only: the evaluator voices unavailability.
    return errorResult(
      "SERVICE_UNAVAILABLE",
      "Workspace service is not available.",
    );
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

    const workspacePath = workspace.path.slice(0, WORKSPACE_PATH_MAX_CHARS);
    const { text: createdText } = await phraseForUser(
      runtime,
      {
        intent: "confirm",
        facts: {
          path: workspacePath,
          branch: workspace.branch,
          isWorktree: workspace.isWorktree,
        },
        mustInclude: [workspacePath, workspace.branch],
      },
      `Created workspace at ${workspacePath}\n` +
        `Branch: ${workspace.branch}\n` +
        `Type: ${workspace.isWorktree ? "worktree" : "clone"}`,
    );
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
    // error-policy:J1 provision action boundary → structured failure to the
    // planner; the evaluator reports the failure in voice.
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: "PROVISION_FAILED",
      text: `Failed to provision workspace: ${errorMessage}`,
    };
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
    return taskPolicyDenialResult("TASKS:submit_workspace", access);
  }

  const workspaceService = getCodingWorkspaceService(runtime);
  if (!workspaceService) {
    // Planner-facing only: the evaluator voices unavailability.
    return errorResult(
      "SERVICE_UNAVAILABLE",
      "Workspace service is not available.",
    );
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
      const { text: noChangesText } = await phraseForUser(
        runtime,
        {
          intent: "notify",
          facts: { changesToCommit: false, workspaceClean: true },
          mustNotClaim: ["work was lost", "anything was pushed"],
        },
        "No changes to commit in this workspace.",
      );
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

    // HIGH receipt sensitivity: the commit hash and PR URL must ride verbatim
    // (userFacingEffectReceiptIds bind on them), so they travel as a machine
    // appendix below whatever prose the model wrote — never through the model.
    const commitShort = commitHash.slice(0, 8);
    const machineAppendix = prInfo
      ? `Commit: ${commitShort}\nPR #${prInfo.number}: ${prInfo.url}`
      : `Commit: ${commitShort}`;
    const { text: finalizedProse } = await phraseForUser(
      runtime,
      {
        intent: "confirm",
        facts: {
          pushed: true,
          committed: true,
          ...(prInfo
            ? { pullRequestOpened: true, prNumber: `#${prInfo.number}` }
            : { pullRequestOpened: false }),
        },
      },
      prInfo
        ? "Workspace finalized — committed, pushed, and a pull request is open."
        : "Workspace changes committed and pushed.",
    );
    const finalizedText = withMachineAppendix(finalizedProse, machineAppendix);
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
    return `Couldn't do that on ${repo} — the connected GitHub account doesn't have permission for it.`;
  }
  if (/not found|404/i.test(errorMessage)) {
    return `Couldn't find that on ${repo} — the repo or issue doesn't exist (or isn't visible to the connected account).`;
  }
  return `Couldn't finish that GitHub operation on ${repo}. Logged the details.`;
}

/** Structural failure class for the phrased issue-failure line; the raw
 * provider message stays planner/log-side. */
function issueFailureClass(
  errorMessage: string,
): "permission" | "not_found" | "unknown" {
  if (/permission|unauthorized|forbidden|403/i.test(errorMessage)) {
    return "permission";
  }
  if (/not found|404/i.test(errorMessage)) return "not_found";
  return "unknown";
}

async function handleIssueAction(
  runtime: IAgentRuntime,
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
            // evaluator owns asking the user, in voice. Issue numbers + URLs
            // are receipts: they ride as a machine appendix, byte-identical.
            const summary = created
              .map((i) => `#${i.number}: ${i.title}\n  ${i.url}`)
              .join("\n");
            const { text: bulkProse } = await phraseForUser(
              runtime,
              {
                intent: "confirm",
                facts: { action: "created issues", count: created.length },
              },
              `Created ${created.length} issues:`,
            );
            // The chat confirmation stays clean; a label degrade is recorded
            // planner-side (`text` + data) so the model can answer honestly
            // if asked, without machinery notes in the user's message.
            const bulkText = withMachineAppendix(bulkProse, summary);
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
        // planner-side (`text` + data) — no machinery notes in chat. The
        // issue number is pinned via mustInclude and the URL rides as a
        // byte-identical machine appendix (both are receipts).
        const { text: createdProse } = await phraseForUser(
          runtime,
          {
            intent: "confirm",
            facts: {
              action: "created issue",
              number: `#${issue.number}`,
              title: issue.title,
            },
            mustInclude: [`#${issue.number}`],
          },
          `Created issue #${issue.number}: ${issue.title}`,
        );
        const createdText = withMachineAppendix(createdProse, issue.url);
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
        if (callback) {
          const { text: updatedText } = await phraseForUser(
            runtime,
            {
              intent: "confirm",
              facts: {
                action: "updated issue",
                number: `#${issue.number}`,
                title: issue.title,
              },
              mustInclude: [`#${issue.number}`],
            },
            `Updated issue #${issue.number}: ${issue.title}`,
          );
          await callback({ text: updatedText });
        }
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
        // The comment URL is the receipt — machine appendix, never the model.
        const { text: commentedProse } = await phraseForUser(
          runtime,
          {
            intent: "confirm",
            facts: { action: "added comment", number: `#${issueNumber}` },
            mustInclude: [`#${issueNumber}`],
          },
          `Added a comment to issue #${issueNumber}.`,
        );
        const commentedText = withMachineAppendix(commentedProse, comment.url);
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
        if (callback) {
          const { text: closedText } = await phraseForUser(
            runtime,
            {
              intent: "confirm",
              facts: {
                action: "closed issue",
                number: `#${issue.number}`,
                title: issue.title,
              },
              mustInclude: [`#${issue.number}`],
            },
            `Closed issue #${issue.number}: ${issue.title}`,
          );
          await callback({ text: closedText });
        }
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
        if (callback) {
          const { text: reopenedText } = await phraseForUser(
            runtime,
            {
              intent: "confirm",
              facts: {
                action: "reopened issue",
                number: `#${issue.number}`,
                title: issue.title,
              },
              mustInclude: [`#${issue.number}`],
            },
            `Reopened issue #${issue.number}: ${issue.title}`,
          );
          await callback({ text: reopenedText });
        }
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
        if (callback) {
          const { text: labeledText } = await phraseForUser(
            runtime,
            {
              intent: "confirm",
              facts: {
                action: "added labels",
                labels,
                number: `#${issueNumber}`,
              },
              mustInclude: [`#${issueNumber}`],
            },
            `Added labels [${labels.join(", ")}] to issue #${issueNumber}`,
          );
          await callback({ text: labeledText });
        }
        return { success: true, data: { issue } };
      }

      default:
        // Planner-facing (see the missing-title guard): the evaluator owns
        // asking the user, in voice.
        return errorResult(
          "UNKNOWN_OPERATION",
          `Unknown issue action "${action}"; valid operations are create, list, get, update, comment, close, reopen, add_labels.`,
        );
    }
  } catch (error) {
    // error-policy:J1 issue-operation boundary → in-voice user line +
    // structured failure. The raw provider message stays planner/log-facing
    // only: shipping API JSON and docs links to chat was the 2026-08-10
    // incident's second half.
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (callback) {
      const { text: failureText } = await phraseForUser(
        runtime,
        {
          intent: "fail",
          facts: { repo, failureClass: issueFailureClass(errorMessage) },
          mustNotClaim: ["the operation succeeded"],
        },
        issueFailureReply(repo, errorMessage),
      );
      await callback({ text: failureText });
    }
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
    return taskPolicyDenialResult("TASKS:manage_issues", access);
  }

  const workspaceService = getCodingWorkspaceService(runtime);
  if (!workspaceService) {
    // Planner-facing only: the evaluator voices unavailability.
    return errorResult(
      "SERVICE_UNAVAILABLE",
      "Workspace service is not available.",
    );
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
      // Planner-facing clarification (the :4340 missing-title guard is the
      // model): the evaluator owns asking the user, in voice.
      return errorResult(
        "MISSING_REPO",
        "No repository found in the request; ask the user which repository they mean (owner/repo or a GitHub URL).",
      );
    }
    return (
      (await handleIssueAction(
        runtime,
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
      runtime,
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
    // Planner-facing guard (the missing-title guard is the model): the
    // evaluator owns asking the user, in voice.
    return failureResult(
      actionName,
      "MISSING_TASK_ID",
      `No taskId was provided; ask the user which task to ${op}.`,
      { reason: "missing_task_id" },
    );
  }
  const taskService = runtime.getService?.(
    OrchestratorTaskService.serviceType,
  ) as OrchestratorTaskService | null | undefined;
  if (!taskService) {
    return failureResult(
      actionName,
      "UNSUPPORTED_OPERATION",
      `Task ${op} is unavailable without the orchestrator task service.`,
      { reason: "acp_only", action: op },
    );
  }
  try {
    const result =
      op === "archive"
        ? await taskService.archiveTask(taskId)
        : op === "reopen"
          ? await taskService.reopenTask(taskId)
          : await taskService.pauseTask(taskId);
    if (!result) {
      return failureResult(
        actionName,
        "TASK_NOT_FOUND",
        `Task ${taskId} not found.`,
        { reason: "task_not_found", taskId },
      );
    }
    const verb =
      op === "archive" ? "Archived" : op === "reopen" ? "Reopened" : "Paused";
    // Chat gets the task title (never a raw uuid); the id stays in data as
    // the receipt the settle wrapper binds on.
    const title = plainString(objectValue(result)?.title);
    const { text: out } = await phraseForUser(
      runtime,
      {
        intent: "confirm",
        facts: { action: op, ...(title ? { title } : {}) },
        ...(title ? { mustInclude: [title] } : {}),
      },
      title ? `${verb} "${title}".` : `${verb} the coding task.`,
    );
    await callbackText(callback, out);
    return {
      success: true,
      text: out,
      data: { actionName, taskId, task: result },
    };
  } catch (err) {
    // error-policy:J1 lifecycle action boundary → warns + structured failure
    // to the planner; the evaluator reports the failure in voice.
    const errMsg = err instanceof Error ? err.message : String(err);
    coreLogger.warn(`[${actionName}] failed: ${errMsg}`);
    return failureResult(
      actionName,
      "LIFECYCLE_FAILED",
      `Failed to ${op} coding task ${taskId}: ${errMsg}`,
      { reason: "lifecycle_failed", taskId },
    );
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
  /** Already forwarded to the real callback (immediate lane); settle must
   *  bind receipts to it but never re-send it. */
  delivered?: boolean;
};

const TASKS_READ_ONLY_OPERATIONS: ReadonlySet<TaskOp> = new Set([
  "list_agents",
  "history",
  "share",
]);

const TASKS_REJECTED_FAILURE_CODES: ReadonlySet<string> = new Set([
  "EMPTY_TASK_PROMPT",
  "FORBIDDEN",
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
  if (result.success && data.duplicateSpawnGuard === true) {
    return "A near-duplicate of in-flight work was detected; no new agent was started.";
  }
  if (
    (operation === "stop_agent" || operation === "cancel") &&
    result.success &&
    (data.stoppedCount === 0 || data.status === "already_finished")
  ) {
    return "Nothing was running; there was nothing to stop.";
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
    return data.outcome === "exhausted"
      ? "The spawn cap was exhausted with no captured result; no new agent was started."
      : "The spawn cap reused an already captured result.";
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
  if (operation === "stop_agent" || operation === "cancel") {
    // Stops and cancels ARE the effect: the stopped session ids are the
    // receipt. Without this branch every stop verdicted "failed" and the
    // honest "Stopped N task agents." was replaced by the hedged "may have
    // gone through" line on every sweep (live 2026-08-19).
    const stopped = [
      ...effectRecords(data.stoppedSessions).map((row) => effectString(row.id)),
      ...(Array.isArray(data.stoppedSessions)
        ? (data.stoppedSessions as unknown[]).map((row) =>
            typeof row === "string" ? row : undefined,
          )
        : []),
      effectString(data.sessionId),
    ].filter((id): id is string => Boolean(id));
    const unique = [...new Set(stopped)];
    if (unique.length === 0) return undefined;
    return {
      commitId: unique[0],
      commitKind: "provider_accepted",
      resource: { kind: "acp.session", id: unique[0] },
      artifacts: unique.slice(1).map((id) => ({ kind: "acp.session", id })),
    };
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

/** Factual fallback for an unconfirmed effect. Deliberately free of commit /
 * receipt vocabulary — that is internal mechanism, not user language. */
function unverifiedTasksText(operation: TaskOp): string {
  return `The ${operation.replaceAll("_", " ")} may have gone through, but I could not confirm it — please check before retrying.`;
}

async function settleTasksOperation(args: {
  operation: TaskOp;
  runtime: IAgentRuntime;
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
    isIssueReadOperation(args.operation, args.params, args.content) ||
    // Respawn-ack suppression: a create driven by a router-stamped synthetic
    // sub-agent inbound (verify-driven respawn) is internal loop traffic — its
    // "Created task agent(s)." ack must NOT become the verified user-facing
    // reply for a request that was already ack'd once. The text stays visible
    // to the planner; genuine fresh user creates keep the visible ack.
    (args.operation === "create" &&
      (args.content.source === MESSAGE_SOURCE_SUB_AGENT ||
        objectValue(args.content.metadata)?.subAgent === true));
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
    // Model-phrased "unconfirmed outcome" note; the fallback carries the same
    // facts. This projection replaces whatever optimistic text the op wrote,
    // so it never claims success the receipt cannot back.
    const { text } = await phraseForUser(
      args.runtime,
      {
        intent: "warn",
        facts: {
          operation: args.operation.replaceAll("_", " "),
          outcome: "unconfirmed",
          userShouldCheckBeforeRetrying: true,
        },
        mustNotClaim: ["the operation definitely succeeded"],
      },
      unverifiedTasksText(args.operation),
    );
    result = {
      ...result,
      text,
    };
    // Planner-only projection: delivered:true blocks the settle re-send —
    // the hedge kept reaching chat through that leg even after losing the
    // verbatim license ("The message may have been sent, but I couldn't
    // confirm it" posted mid-turn, live 2026-08-20 color-mixer).
    canonical = {
      response: { ...(canonical?.response ?? {}), text },
      actionName: canonical?.actionName,
      delivered: true,
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
  // A canonical that already reached the user out-of-band (recordOnly ack
  // posted via sendMessageToTarget) must not be re-granted userFacingText /
  // verifiedUserFacing here: the turn never delivered it through a callback,
  // so re-binding it re-arms every turn-end delivery floor with text the user
  // already has (live 2026-08-19: settle re-bound the "On it" ack as verified
  // text on the create result after the runner deliberately omitted it).
  const canonicalAlreadyDelivered =
    (canonical as { delivered?: boolean } | undefined)?.delivered === true;
  // An unconfirmed-outcome hedge is planner grounding, not the user's answer:
  // granting it the do-not-paraphrase license shipped "The send may have gone
  // through, but I could not confirm it — please check before retrying."
  // verbatim over the evaluator's in-voice reply for a follow-up that HAD
  // been absorbed into the running build (live 2026-08-20, habit tracker).
  const hedgedUnconfirmed =
    result.success === true && receipt.outcome === "failed";
  const effectResult: ActionResult = {
    ...result,
    effectReceipts: [receipt],
    ...(canonical?.response.text &&
    !canonicalAlreadyDelivered &&
    !hedgedUnconfirmed
      ? result.success !== false
        ? {
            userFacingText: canonical.response.text,
            verifiedUserFacing: true,
            userFacingEffectReceiptIds: [receipt.receiptId],
          }
        : { userFacingText: canonical.response.text }
      : {}),
  };
  if (
    canonical &&
    args.callback &&
    helperEmittedCallback &&
    (canonical as { delivered?: boolean }).delivered !== true
  ) {
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
    "Planner surface for orchestrator workspace operations and coding task delegation to dedicated ACP coding sub-agents (elizaos / pi-agent / claude / codex). " +
    "Available operations (pick via `action`): create or spawn_agent (delegate new coding work), send (forward a message to an existing coding sub-agent), list_agents / history (read state), " +
    "control (pause | resume | continue | archive | reopen a task), share (surface task output), provision_workspace / submit_workspace (workspace setup and PR submission), manage_issues (GitHub issue operations), cancel / stop_agent (end a coding sub-agent run when the user asks to). " +
    "Choose this when the user asks to delegate coding work, use a coding adapter by name, or run multi-step development work — it is the canonical path for coding sub-agents and is preferred over inline FILE / BASH for delegated work. " +
    // Page/site builds ARE tasks now: the spawn pipeline places the build in
    // the served apps directory, verifies the live URL, and reports the link
    // (the old claim that a task workspace has no hosting path stopped being
    // true on 2026-08-19 and the APP-create detour parked working pages).
    "Building a web app/page/site/interactive HTML the user wants hosted with a live link IS this action: the build runs in the served apps directory and the reply reports the verified live URL.",
  descriptionCompressed:
    "ACP coding sub-agent elizaos|pi-agent|claude|codex: spawn|send|control|list|history",
  routingHint:
    'delegate coding/software/dev work to a coding sub-agent, or drive a coding adapter by name (elizaos|pi-agent|claude|codex) -> TASKS; GitHub issue operations ("any new issues?", list/create/comment/close/reopen an issue) -> TASKS_MANAGE_ISSUES — this IS the github-issues tool; do NOT use for personal reminders, check-ins, follow-ups, alarms or recurring routines ("remind me...", "every day...") -> use the exposed reminder/scheduling tool instead (TRIGGER_CREATE, SCHEDULED_TASKS, or OWNER_REMINDERS — whichever is exposed this turn); do NOT use for building a web app/page/site/interactive HTML the user wants hosted at a live link ("make me a website", "teach me with an interactive page", "host it and give me the link") -> APP action=create, which builds AND publishes — a coding task workspace has no hosting path; not for one-off inline file edits or shell commands -> FILE / BASH',
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
        "Heuristic backend guess (elizaos, pi-agent, codex, and claude) for create / spawn_agent / control.resume. This is a weak hint — it loses to the operator default/pin and to character routing. To honor an EXPLICIT user request use requestedBackend instead.",
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
        "Set ONLY when the user EXPLICITLY named a coding backend for THIS task (e.g. 'use codex', 'have claude build it') — one of elizaos, pi-agent, codex, and claude. Leave unset if the user did not name one; never guess. Unlike agentType this overrides the configured default/pin.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["elizaos", "pi-agent", "codex", "claude"],
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
          // An `immediate: true` metadata flag opts a notice OUT of the
          // capture-then-settle deferral: acks composed before long-running
          // work were otherwise held until the runner returned, and fast
          // children's completion relays overtook them in chat (live
          // 2026-08-19, three runs). Delivered-now entries still record so
          // settle binds receipts, but settle must not re-send them.
          const meta = (
            response as {
              metadata?: { immediate?: boolean; recordOnly?: boolean };
            }
          ).metadata;
          // recordOnly: the text was already posted out-of-band (early ack via
          // sendMessageToTarget); record it so settle binds receipts to it and
          // synthesizes nothing, but never send it again — the synthesized
          // canonical re-posted "On it" at turn end (live 2026-08-19).
          if (meta?.recordOnly === true) {
            capturedCallbacks.push({ response, actionName, delivered: true });
            return [];
          }
          if (meta?.immediate === true) {
            capturedCallbacks.push({ response, actionName, delivered: true });
            return callback(response, actionName);
          }
          capturedCallbacks.push({ response, actionName });
          return [];
        }
      : undefined;
    const result = await dispatchTasksOperation(
      action,
      runtime,
      message,
      state,
      params,
      content,
      captureCallback,
    );
    return settleTasksOperation({
      operation: action,
      runtime,
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
    // user-naming-the-adapter case (elizaos / pi-agent /
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
            "User asked to delegate to a sub-agent; TASKS action=spawn_agent routes to AcpService.spawnSession with the configured adapter (elizaos / pi-agent / claude / codex).",
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
          text: "use codex to write a script that prints hello world",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Spawning a codex sub-agent for the script.",
          actions: ["TASKS"],
          thought:
            "User explicitly named the coding adapter (codex). TASKS action=spawn_agent with agentType=codex hands off to the configured codex provider (openai-codex / openai-api via the account bridge).",
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
            "User asked to delegate to a sub-agent; TASKS action=spawn_agent routes through the ACP service with the configured adapter (elizaos / pi-agent / claude / codex).",
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
