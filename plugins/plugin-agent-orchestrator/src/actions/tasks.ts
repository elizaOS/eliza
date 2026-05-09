/**
 * TASKS — single Pattern C parent action that subsumes the orchestrator's
 * task-agent lifecycle, workspace lifecycle, GitHub issue management, and
 * coding-task archive/reopen surface.
 *
 * Old leaf actions live as similes; their handlers were folded into per-op
 * runners on this file.
 *
 * Ops:
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

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger as coreLogger } from "@elizaos/core";
import { getCoordinator } from "../services/pty-service.js";
import { requireTaskAgentAccess } from "../services/task-policy.js";
import type { ListTaskThreadsOptions } from "../services/task-registry.js";
import { discoverTaskShareOptions } from "../services/task-share.js";
import type { AgentType, SpawnResult } from "../services/types.js";
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
  resolveSession,
  setCurrentSession,
  setCurrentSessions,
  shortId,
} from "./common.js";
import { resolveTaskThreadTarget } from "./task-thread-target.js";

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

function readOp(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
): TaskOp | null {
  const raw = pickString(params, content, "op");
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/-/g, "_");
  return (SUPPORTED_OPS as readonly string[]).includes(normalized)
    ? (normalized as TaskOp)
    : null;
}

// ── op: create (CREATE_AGENT_TASK) ──────────────────────────────────────

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

function parseAgentPrefix(
  part: string,
  fallbackAgentType: string,
): { task: string; agentType: string } {
  const match = part.match(/^([a-z][a-z0-9_-]{1,32})\s*:\s*(.+)$/i);
  if (!match) return { task: part, agentType: fallbackAgentType };
  return { agentType: match[1] ?? fallbackAgentType, task: match[2] ?? part };
}

function labelFrom(task: string, index: number): string {
  const cleaned = task.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 80) : `task-${index + 1}`;
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
  const tasks = taskParts(params, content, text);
  if (tasks.length > MAX_CONCURRENT_AGENTS) {
    const msg = `Too many task agents requested (${tasks.length}); maximum is ${MAX_CONCURRENT_AGENTS}.`;
    await callbackText(callback, msg);
    return errorResult("TOO_MANY_AGENTS", msg);
  }

  const baseAgentType =
    pickString(params, content, "agentType") ??
    String(
      (await service.resolveAgentType?.({
        task: tasks[0],
        subtaskCount: tasks.length,
      })) ?? "codex",
    );
  const workdir = pickString(params, content, "workdir") ?? process.cwd();
  const model = pickString(params, content, "model");
  const memoryContent = pickString(params, content, "memoryContent");
  const approvalPreset = parseApproval(
    pickString(params, content, "approvalPreset"),
  );
  const timeoutMs = getTimeoutMs(params, content);
  const baseLabel = pickString(params, content, "label");
  const settled = await Promise.allSettled(
    tasks.map(async (part, index) => {
      const parsed = parseAgentPrefix(part, baseAgentType);
      const task = parsed.task;
      const agentType = parsed.agentType as AgentType;
      const label = baseLabel ?? labelFrom(task, index);
      const session = await service.spawnSession({
        agentType,
        workdir,
        memoryContent,
        approvalPreset,
        model,
        timeoutMs,
        metadata: {
          requestedType: baseAgentType,
          messageId: message.id,
          roomId: message.roomId,
          worldId: message.worldId,
          userId: message.entityId,
          label,
          source: content.source,
        },
      });
      await runPromptAndClose(service, session, task, timeoutMs, model);
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
    logger(runtime).error?.(
      `TASKS:create launch failed: ${JSON.stringify({
        error: msg,
        agentType,
        workdir,
      })}`,
    );
    results.push({
      sessionId: "",
      id: "",
      agentType,
      workdir,
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

  return {
    success: true,
    text: "",
    data: { agents: results, suppressActionResultClipboard: true },
  };
}

// ── op: spawn_agent (SPAWN_AGENT) ───────────────────────────────────────

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
    const text = "PTY Service is not available. Cannot spawn a task agent.";
    await callbackText(callback, text);
    return errorResult("SERVICE_UNAVAILABLE");
  }

  try {
    const text = messageText(message);
    const task = pickString(params, content, "task") ?? text;
    const explicitAgentType = pickString(params, content, "agentType");
    const agentType = (explicitAgentType ??
      (await service.resolveAgentType?.({
        task,
        workdir: pickString(params, content, "workdir"),
      })) ??
      "codex") as AgentType;
    const workdir = pickString(params, content, "workdir") ?? process.cwd();
    const memoryContent = pickString(params, content, "memoryContent");
    const approvalPreset = parseApproval(
      pickString(params, content, "approvalPreset"),
    );
    const keepAliveAfterComplete = pickBoolean(
      params,
      content,
      "keepAliveAfterComplete",
    );
    const label = pickString(params, content, "label") ?? task.slice(0, 80);

    const session = await service.spawnSession({
      agentType,
      workdir,
      initialTask: task,
      memoryContent,
      approvalPreset,
      metadata: {
        requestedType: explicitAgentType ?? agentType,
        messageId: message.id,
        roomId: message.roomId,
        worldId: message.worldId,
        userId: message.entityId,
        label,
        source: content.source,
        keepAliveAfterComplete,
      },
    });

    setCurrentSession(state, session);
    logger(runtime).info?.(
      `Spawned acpx task agent: ${JSON.stringify({
        sessionId: session.sessionId,
        agentType: session.agentType,
        workdir: session.workdir,
      })}`,
    );

    return {
      success: true,
      text: "",
      data: {
        sessionId: session.sessionId,
        agentType: session.agentType,
        workdir: session.workdir,
        status: session.status,
        label,
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
    return { success: false, error: code };
  }
}

// ── op: send (SEND_TO_AGENT) ────────────────────────────────────────────

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
    await callbackText(callback, "PTY Service is not available.");
    return errorResult("SERVICE_UNAVAILABLE");
  }

  try {
    const sessionId = pickString(params, content, "sessionId");
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

    const textInput = input ?? task;
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

// ── op: stop_agent (STOP_AGENT) ─────────────────────────────────────────

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
    await callbackText(callback, "PTY Service is not available.");
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

// ── op: list_agents (LIST_AGENTS) ───────────────────────────────────────

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
    await callbackText(callback, "PTY Service is not available.");
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
      'No active task agents. Use TASKS { op: "create" } when the user needs anything more involved than a simple direct reply.';
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

// ── op: cancel (CANCEL_TASK) ────────────────────────────────────────────

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
    await callbackText(callback, "PTY Service is not available.");
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

// ── op: history (TASK_HISTORY) ──────────────────────────────────────────

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
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
  if (/\bshow me\b|\bgive me\b|\blist\b|\bwhat are\b/i.test(text))
    return "list";
  return "detail";
}

function inferStatuses(
  text: string,
  rawStatuses?: string[],
): string[] | undefined {
  if (rawStatuses && rawStatuses.length > 0) {
    return rawStatuses;
  }
  const statuses = new Set<string>();
  if (/\bactive\b|\bright now\b|\bworking on right now\b/i.test(text)) {
    statuses.add("active");
  }
  if (/\bblocked\b/i.test(text)) {
    statuses.add("blocked");
  }
  if (/\binterrupted\b|\bpaused\b/i.test(text)) {
    statuses.add("interrupted");
  }
  if (/\bdone\b|\bcompleted\b|\bfinished\b/i.test(text)) {
    statuses.add("done");
  }
  if (/\bfailed\b|\berror\b/i.test(text)) {
    statuses.add("failed");
  }
  return statuses.size > 0 ? Array.from(statuses) : undefined;
}

function inferWindow(text: string, raw?: string): HistoryWindow | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (
    normalized === "active" ||
    normalized === "today" ||
    normalized === "yesterday" ||
    normalized === "last_7_days" ||
    normalized === "last_30_days"
  ) {
    return normalized;
  }
  if (/\bright now\b|\bcurrently\b|\bactive\b/i.test(text)) return "active";
  if (/\byesterday\b/i.test(text)) return "yesterday";
  if (/\blast week\b|\blast 7 days\b|\bin the last week\b/i.test(text)) {
    return "last_7_days";
  }
  if (/\blast month\b|\blast 30 days\b/i.test(text)) return "last_30_days";
  if (/\btoday\b/i.test(text)) return "today";
  return undefined;
}

function inferSearch(text: string, raw?: string): string | undefined {
  if (raw?.trim()) return raw.trim();
  const quoted =
    text.match(/"([^"]{3,120})"/)?.[1] ?? text.match(/'([^']{3,120})'/)?.[1];
  if (quoted) return quoted.trim();
  const topical =
    text.match(/\bworking on\s+(.+?)(?:[?.!,]|$)/i)?.[1] ??
    text.match(
      /\ball tasks where we were working on\s+(.+?)(?:[?.!,]|$)/i,
    )?.[1];
  return topical?.trim();
}

function buildWindowFilters(window: HistoryWindow | undefined): {
  latestActivityAfter?: number;
  latestActivityBefore?: number;
  label?: string;
} {
  const now = new Date();
  if (window === "active") {
    return { label: "active tasks right now" };
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

function renderThreadLine(entry: {
  title: string;
  status: string;
  latestActivityAt?: number | null;
  summary?: string;
}): string {
  const activity =
    typeof entry.latestActivityAt === "number"
      ? new Date(entry.latestActivityAt).toLocaleString("en-US")
      : "unknown time";
  return `- ${entry.title} [${entry.status}] (${activity})${entry.summary ? `: ${entry.summary}` : ""}`;
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
    if (callback) await callback({ text: access.reason });
    return failureResult("TASKS:history", "FORBIDDEN", access.reason, {
      reason: "access_denied",
    });
  }

  const coordinator = getCoordinator(runtime);
  if (!coordinator) {
    if (callback) await callback({ text: "Coordinator is not available." });
    return failureResult(
      "TASKS:history",
      "SERVICE_UNAVAILABLE",
      "Coordinator is not available.",
      { reason: "coordinator_unavailable" },
    );
  }

  const text = typeof content.text === "string" ? content.text : "";

  const metric = inferMetric(
    text,
    textValue(params.metric) ?? textValue(content.metric),
  );
  const statuses = inferStatuses(
    text,
    Array.isArray(params.statuses)
      ? params.statuses.filter(
          (value): value is string => typeof value === "string",
        )
      : Array.isArray(content.statuses)
        ? content.statuses.filter(
            (value): value is string => typeof value === "string",
          )
        : undefined,
  );
  const window = inferWindow(
    text,
    textValue(params.window) ?? textValue(content.window),
  );
  const search = inferSearch(
    text,
    textValue(params.search) ?? textValue(content.search),
  );
  const limitRaw = Number(
    params.limit ?? content.limit ?? (metric === "detail" ? 1 : 10),
  );
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : 10;
  const includeArchived =
    (params.includeArchived as boolean | undefined) ??
    (content.includeArchived as boolean | undefined) ??
    false;
  const windowFilters = buildWindowFilters(window);

  const threadFilters: ListTaskThreadsOptions = {
    includeArchived,
    ...(statuses && statuses.length > 0
      ? { statuses: statuses as ListTaskThreadsOptions["statuses"] }
      : {}),
    ...(windowFilters.latestActivityAfter
      ? { latestActivityAfter: windowFilters.latestActivityAfter }
      : {}),
    ...(windowFilters.latestActivityBefore
      ? { latestActivityBefore: windowFilters.latestActivityBefore }
      : {}),
    ...(search ? { search } : {}),
    ...(window === "active" ? { hasActiveSession: true } : {}),
    limit,
  };

  const [count, threads] = await Promise.all([
    coordinator.countTaskThreads(threadFilters),
    coordinator.listTaskThreads(threadFilters),
  ]);

  const summaryWindow =
    windowFilters.label ??
    (window === "active"
      ? "right now"
      : includeArchived
        ? "all recorded time"
        : "recent task history");
  const summaryTopic = search ? ` for "${search}"` : "";
  const summaryStatus =
    statuses && statuses.length > 0
      ? ` with status ${statuses.join(", ")}`
      : "";

  let responseText = "";
  if (metric === "count") {
    responseText = `I found ${count} task${count === 1 ? "" : "s"} ${summaryWindow}${summaryTopic}${summaryStatus}.`;
  } else if (threads.length === 0) {
    responseText = `I did not find any tasks ${summaryWindow}${summaryTopic}${summaryStatus}.`;
  } else if (metric === "detail" && threads[0]) {
    const thread = await coordinator.getTaskThread(threads[0].id);
    responseText = [
      `The most relevant task is "${threads[0].title}" [${threads[0].status}].`,
      thread?.summary ? `Summary: ${thread.summary}` : "",
      thread?.latestWorkdir ? `Workspace: ${thread.latestWorkdir}` : "",
      thread?.latestRepo ? `Repository: ${thread.latestRepo}` : "",
      typeof thread?.latestActivityAt === "number"
        ? `Latest activity: ${new Date(thread.latestActivityAt).toLocaleString("en-US")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  } else {
    responseText = [
      `I found ${count} task${count === 1 ? "" : "s"} ${summaryWindow}${summaryTopic}${summaryStatus}.`,
      ...threads.slice(0, limit).map(renderThreadLine),
    ].join("\n");
  }

  if (callback) await callback({ text: responseText });
  return {
    success: true,
    text: responseText,
    data: {
      actionName: "TASKS:history",
      filters: threadFilters,
      window,
      count,
      threadIds: threads.map((thread) => thread.id),
    },
  };
}

// ── op: control (TASK_CONTROL) ──────────────────────────────────────────

function inferControlAction(
  text: string,
  value?: string,
): ControlAction | null {
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
  if (/\barchive\b/i.test(text)) return "archive";
  if (/\breopen\b/i.test(text)) return "reopen";
  if (/\bpause\b|\bhold on\b|\bthat's not right\b/i.test(text)) return "pause";
  if (/\bstop\b|\bcancel\b|\bkill\b/i.test(text)) return "stop";
  if (/\bresume\b|\bmake it so\b|\bdo it\b|\byea(h)? i'm down\b/i.test(text)) {
    return "resume";
  }
  if (/\bcontinue\b|\bgo ahead\b/i.test(text)) return "continue";
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
    if (callback) await callback({ text: access.reason });
    return failureResult("TASKS:control", "FORBIDDEN", access.reason, {
      reason: "access_denied",
    });
  }

  const coordinator = getCoordinator(runtime);
  if (!coordinator) {
    if (callback) await callback({ text: "Coordinator is not available." });
    return failureResult(
      "TASKS:control",
      "SERVICE_UNAVAILABLE",
      "Coordinator is not available.",
      { reason: "coordinator_unavailable" },
    );
  }

  const text = typeof content.text === "string" ? content.text : "";
  const action = inferControlAction(
    text,
    textValue(params.action) ?? textValue(content.action),
  );

  if (!action) {
    const msg =
      "No task-control action was specified. Use pause, stop, resume, continue, archive, or reopen.";
    if (callback) await callback({ text: msg });
    return failureResult("TASKS:control", "INVALID_OPERATION", msg, {
      reason: "invalid_operation",
    });
  }

  const thread = await resolveTaskThreadTarget({
    coordinator,
    message,
    state,
    options: params,
    includeArchived: action === "reopen" || action === "archive",
  });
  if (!thread) {
    const msg = "I could not find a matching task thread.";
    if (callback) await callback({ text: msg });
    return failureResult("TASKS:control", "THREAD_NOT_FOUND", msg, {
      reason: "thread_not_found",
      action,
    });
  }

  const note =
    textValue(params.note) ??
    textValue(content.note) ??
    (text.length > 0 ? text : undefined);
  const instruction =
    textValue(params.instruction) ??
    textValue(content.instruction) ??
    (action === "continue" || action === "resume" ? text : undefined);
  const requestedAgentType =
    textValue(params.agentType) ?? textValue(content.agentType);

  let responseText = "";
  let data: Record<string, unknown> = {
    actionName: "TASKS:control",
    threadId: thread.id,
    action,
  };

  if (action === "pause") {
    const result = await coordinator.pauseTaskThread(thread.id, note);
    responseText = `Paused "${thread.title}" and preserved the thread for follow-up discussion.`;
    data = { ...data, ...result };
  } else if (action === "stop") {
    const result = await coordinator.stopTaskThread(thread.id, note);
    responseText = `Stopped "${thread.title}" and kept the thread history intact.`;
    data = { ...data, ...result };
  } else if (action === "archive") {
    await coordinator.archiveTaskThread(thread.id);
    responseText = `Archived "${thread.title}".`;
  } else if (action === "reopen") {
    await coordinator.reopenTaskThread(thread.id);
    responseText = `Reopened "${thread.title}".`;
  } else if (action === "continue") {
    const nextInstruction =
      instruction?.trim() || `Continue the task "${thread.title}".`;
    const result = await coordinator.continueTaskThread(
      thread.id,
      nextInstruction,
      requestedAgentType,
    );
    responseText = result.reusedSession
      ? `Sent follow-up instructions to "${thread.title}" on the existing task session.`
      : `Resumed "${thread.title}" on a new task session.`;
    data = { ...data, ...result };
  } else {
    const result = await coordinator.resumeTaskThread(
      thread.id,
      instruction?.trim() || undefined,
      requestedAgentType,
    );
    responseText = result.reusedSession
      ? `Resumed "${thread.title}" on the current task session.`
      : `Resumed "${thread.title}" on a new task session.`;
    data = { ...data, ...result };
  }

  if (callback) await callback({ text: responseText });
  return {
    success: true,
    text: responseText,
    data: data as ActionResult["data"],
  };
}

// ── op: share (TASK_SHARE) ──────────────────────────────────────────────

function artifactTypeForTarget(type: string): string {
  if (type === "preview_url" || type === "artifact_uri") return "share_link";
  if (type === "artifact_path") return "share_path";
  return "workspace";
}

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
    if (callback) await callback({ text: access.reason });
    return { success: false, error: "FORBIDDEN", text: access.reason };
  }

  const coordinator = getCoordinator(runtime);
  if (!coordinator) {
    if (callback) await callback({ text: "Coordinator is not available." });
    return { success: false, error: "SERVICE_UNAVAILABLE" };
  }

  const thread = await resolveTaskThreadTarget({
    coordinator,
    message,
    state,
    options: params,
    includeArchived: true,
  });
  if (!thread) {
    if (callback)
      await callback({ text: "I could not find a task thread to share." });
    return { success: false, error: "THREAD_NOT_FOUND" };
  }

  const discovery = await discoverTaskShareOptions(coordinator, thread.id);
  if (!discovery || discovery.targets.length === 0) {
    const fallback = `I found the task thread "${thread.title}", but I did not find a preview URL or shareable artifact yet.`;
    if (callback) await callback({ text: fallback });
    return {
      success: false,
      error: "NO_SHARE_TARGET",
      text: fallback,
      data: {
        threadId: thread.id,
        shareCapabilities: discovery?.shareCapabilities ?? [],
      },
    };
  }

  const detail = await coordinator.getTaskThread(thread.id);
  const existingKeys = new Set(
    (detail?.artifacts ?? []).map(
      (artifact) =>
        artifact.uri?.trim() ||
        artifact.path?.trim() ||
        `${artifact.artifactType}:${artifact.title}`,
    ),
  );
  for (const target of discovery.targets) {
    const key = target.value.trim();
    if (!key || existingKeys.has(key)) continue;
    await coordinator.taskRegistry.recordArtifact({
      threadId: thread.id,
      artifactType: artifactTypeForTarget(target.type),
      title: target.label,
      ...(target.type === "artifact_path" || target.type === "workspace"
        ? { path: target.value }
        : { uri: target.value }),
      metadata: {
        source: target.source,
        remoteAccessible: target.remoteAccessible,
        discoveredVia: "tasks-share-action",
      },
    });
    existingKeys.add(key);
  }

  const preferred = discovery.preferredTarget;
  const lines = [
    preferred
      ? `Best available view for "${thread.title}": ${preferred.value}`
      : `I found share options for "${thread.title}".`,
    ...discovery.targets
      .slice(0, 5)
      .map(
        (target) =>
          `- ${target.label}: ${target.value}${target.remoteAccessible ? " (remote-ready)" : ""}`,
      ),
    discovery.shareCapabilities.length > 0
      ? `Environment share capabilities: ${discovery.shareCapabilities.join(", ")}`
      : "No explicit remote-share capability is configured, so local artifact paths and preview URLs are the only confirmed options right now.",
  ].filter(Boolean);
  const responseText = lines.join("\n");

  if (callback) await callback({ text: responseText });
  return {
    success: true,
    text: responseText,
    data: {
      threadId: thread.id,
      preferredTarget: preferred,
      shareCapabilities: discovery.shareCapabilities,
      targetCount: discovery.targets.length,
    },
  };
}

// ── op: provision_workspace (CREATE_WORKSPACE) ─────────────────────────

async function runProvisionWorkspace(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  _params: Record<string, unknown>,
  _content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const access = await requireTaskAgentAccess(runtime, message, "create");
  if (!access.allowed) {
    if (callback) await callback({ text: access.reason });
    return { success: false, error: "FORBIDDEN", text: access.reason };
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

  let repo = content.repo;
  if (!repo && content.text) {
    const urlMatch = content.text.match(
      /https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+(?:\.git)?/i,
    );
    if (urlMatch) {
      repo = urlMatch[0];
    }
  }

  if (!repo && !content.useWorktree) {
    if (callback)
      await callback({
        text: "Please specify a repository URL or use worktree mode with a parent workspace.",
      });
    return { success: false, error: "MISSING_REPO" };
  }

  if (repo) {
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

  let parentWorkspaceId = content.parentWorkspaceId;
  if (content.useWorktree && !parentWorkspaceId) {
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

  try {
    const workspace: WorkspaceResult = await Promise.race([
      workspaceService.provisionWorkspace({
        repo: repo ?? "",
        baseBranch: content.baseBranch,
        useWorktree: content.useWorktree,
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

// ── op: submit_workspace (SUBMIT_WORKSPACE) ────────────────────────────

async function runSubmitWorkspace(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  _params: Record<string, unknown>,
  _content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const access = await requireTaskAgentAccess(runtime, message, "interact");
  if (!access.allowed) {
    if (callback) await callback({ text: access.reason });
    return { success: false, error: "FORBIDDEN", text: access.reason };
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

  let workspaceId = content.workspaceId;
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
      content.commitMessage ??
      `feat: automated changes from task agent\n\nGenerated by Eliza task-agent plugin.`;

    const commitHash = await workspaceService.commit(workspaceId, {
      message: commitMessage,
      all: true,
    });

    await workspaceService.push(workspaceId, { setUpstream: true });

    let prInfo = null;
    if (!content.skipPR) {
      const prTitle = content.prTitle ?? `[Eliza] ${workspace.branch}`;
      const prBody =
        content.prBody ??
        `## Summary\n\nAutomated changes generated by Eliza task agent.\n\n` +
          `**Branch:** ${workspace.branch}\n` +
          `**Commit:** ${commitHash}\n\n` +
          `---\n*Generated by @elizaos/plugin-agent-orchestrator*`;

      prInfo = await workspaceService.createPR(workspaceId, {
        title: prTitle,
        body: prBody,
        base: content.baseBranch,
        draft: content.draft,
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

// ── op: manage_issues (MANAGE_ISSUES) ──────────────────────────────────

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
            const created = [];
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
    if (callback) await callback({ text: access.reason });
    return { success: false, error: "FORBIDDEN", text: access.reason };
  }

  const workspaceService = getCodingWorkspaceService(runtime);
  if (!workspaceService) {
    if (callback)
      await callback({ text: "Workspace Service is not available." });
    return { success: false, error: "SERVICE_UNAVAILABLE" };
  }

  workspaceService.setAuthPromptCallback(
    (prompt: Parameters<AuthPromptCallback>[0]) => {
      const delivered =
        getCoordinator(runtime)?.sendChatMessage(
          formatGitHubAuthPrompt(prompt),
          "github-auth",
        ) === true;
      if (!delivered) {
        coreLogger.warn(
          "[TASKS:manage_issues] GitHub OAuth prompt requires immediate delivery, but the coordinator chat bridge is not wired",
        );
      }
      return delivered;
    },
  );

  const text = ((content.text as string) ?? "").slice(0, ISSUE_BODY_MAX_CHARS);

  const action =
    (params.action as string) ??
    (content.action as string) ??
    inferIssueAction(text);
  const repo = (params.repo as string) ?? (content.repo as string);

  if (!repo) {
    const urlMatch = text?.match(
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

// ── op: archive / reopen (ARCHIVE_CODING_TASK / REOPEN_CODING_TASK) ────

async function runArchive(
  runtime: IAgentRuntime,
  _message: Memory,
  _state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const coordinator = getCoordinator(runtime);
  if (!coordinator) {
    const msg = "Coordinator is not available.";
    await callbackText(callback, msg);
    return { success: false, error: "SERVICE_UNAVAILABLE", text: msg };
  }

  const taskId =
    pickString(params, content, "taskId") ??
    pickString(params, content, "threadId");
  if (!taskId) {
    const msg = "taskId is required.";
    await callbackText(callback, msg);
    return {
      success: false,
      text: msg,
      values: { error: "MISSING_TASK_ID" },
    };
  }

  try {
    await coordinator.archiveTaskThread(taskId);
    const msg = `Archived coding task ${taskId}.`;
    await callbackText(callback, msg);
    return {
      success: true,
      text: msg,
      values: { taskId, archived: true },
      data: { actionName: "TASKS:archive", taskId },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    coreLogger.warn(`[TASKS:archive] failed: ${errMsg}`);
    const out = `Failed to archive coding task ${taskId}: ${errMsg}`;
    await callbackText(callback, out);
    return { success: false, text: out, error: errMsg };
  }
}

async function runReopen(
  runtime: IAgentRuntime,
  _message: Memory,
  _state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const coordinator = getCoordinator(runtime);
  if (!coordinator) {
    const msg = "Coordinator is not available.";
    await callbackText(callback, msg);
    return { success: false, error: "SERVICE_UNAVAILABLE", text: msg };
  }

  const taskId =
    pickString(params, content, "taskId") ??
    pickString(params, content, "threadId");
  if (!taskId) {
    const msg = "taskId is required.";
    await callbackText(callback, msg);
    return {
      success: false,
      text: msg,
      values: { error: "MISSING_TASK_ID" },
    };
  }

  try {
    await coordinator.reopenTaskThread(taskId);
    const msg = `Reopened coding task ${taskId}.`;
    await callbackText(callback, msg);
    return {
      success: true,
      text: msg,
      values: { taskId, reopened: true },
      data: { actionName: "TASKS:reopen", taskId },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    coreLogger.warn(`[TASKS:reopen] failed: ${errMsg}`);
    const out = `Failed to reopen coding task ${taskId}: ${errMsg}`;
    await callbackText(callback, out);
    return { success: false, text: out, error: errMsg };
  }
}

// ── parent action ──────────────────────────────────────────────────────

export const tasksAction: Action & { suppressPostActionContinuation: true } = {
  name: "TASKS",
  contexts: ["tasks", "code", "automation", "agent_internal", "connectors"],
  roleGate: { minRole: "USER" },
  similes: [
    // create
    "CREATE_AGENT_TASK",
    "CREATE_TASK",
    "START_CODING_TASK",
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
    "Single planner-visible surface for the orchestrator's task-agent and workspace lifecycle. " +
    "Pick `op` to dispatch: create / spawn_agent / send / stop_agent / list_agents / cancel / history / control / share / provision_workspace / submit_workspace / manage_issues / archive / reopen. " +
    "Use `control` with action=pause|resume|stop|continue|archive|reopen for task-thread state transitions, and `manage_issues` with action=create|list|get|update|comment|close|reopen|add_labels for GitHub issues.",
  descriptionCompressed:
    "tasks: op=create|spawn_agent|send|stop_agent|list_agents|cancel|history|control|share|provision_workspace|submit_workspace|manage_issues|archive|reopen",
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "op",
      description:
        "Task operation: create, spawn_agent, send, stop_agent, list_agents, cancel, history, control, share, provision_workspace, submit_workspace, manage_issues, archive, reopen.",
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
        "Agent type (codex, claude, etc.) for create / spawn_agent / control.resume.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "agents",
      description: "Pipe-delimited multi-agent task list for op=create.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "repo",
      description:
        "Repository URL/slug for op=create / op=manage_issues / op=provision_workspace.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "workdir",
      description: "Working directory for op=create / op=spawn_agent.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "memoryContent",
      description: "Additional memory/context for op=create / op=spawn_agent.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "label",
      description: "Task label for op=create / op=spawn_agent / op=send.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "approvalPreset",
      description: "Approval preset for op=create / op=spawn_agent.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["readonly", "standard", "permissive", "autonomous"],
      },
    },
    {
      name: "keepAliveAfterComplete",
      description: "Keep session alive after completion for op=spawn_agent.",
      required: false,
      schema: { type: "boolean" as const },
    },
    // send
    {
      name: "input",
      description: "Text input to send to a running session for op=send.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "keys",
      description: "Key sequence to send for op=send.",
      required: false,
      schema: { type: "string" as const },
    },
    // session/thread targeting
    {
      name: "sessionId",
      description:
        "Target session id for op=send / op=stop_agent / op=cancel / op=control / op=share.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "threadId",
      description:
        "Target task-thread id for op=cancel / op=control / op=share / op=archive / op=reopen.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "taskId",
      description: "Alias for threadId; preferred for op=archive / op=reopen.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "all",
      description: "Apply to all sessions for op=stop_agent / op=cancel.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "search",
      description:
        "Free-text search for thread/task lookup in op=cancel / op=control / op=history / op=share.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description: "Cancellation reason for op=cancel.",
      required: false,
      schema: { type: "string" as const },
    },
    // history
    {
      name: "metric",
      description:
        "History query mode for op=history: list (default), count, or detail.",
      required: false,
      schema: { type: "string" as const, enum: ["list", "count", "detail"] },
    },
    {
      name: "window",
      description: "Relative window for op=history.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["active", "today", "yesterday", "last_7_days", "last_30_days"],
      },
    },
    {
      name: "statuses",
      description: "Status filter list for op=history.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "limit",
      description: "Result limit for op=history.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "includeArchived",
      description: "Include archived threads in op=history.",
      required: false,
      schema: { type: "boolean" as const },
    },
    // control
    {
      name: "action",
      description:
        "Sub-action for op=control (pause|resume|stop|continue|archive|reopen) " +
        "or for op=manage_issues (create|list|get|update|comment|close|reopen|add_labels).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "note",
      description: "Optional note for op=control with action=pause|stop.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "instruction",
      description:
        "Follow-up instruction for op=control with action=resume|continue.",
      required: false,
      schema: { type: "string" as const },
    },
    // workspace
    {
      name: "baseBranch",
      description:
        "Base branch for op=provision_workspace / op=submit_workspace.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "useWorktree",
      description: "Use worktree mode for op=provision_workspace.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "parentWorkspaceId",
      description:
        "Parent workspace id for op=provision_workspace worktree mode.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "workspaceId",
      description: "Workspace id for op=submit_workspace.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "commitMessage",
      description: "Commit message for op=submit_workspace.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "prTitle",
      description: "PR title for op=submit_workspace.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "prBody",
      description: "PR body for op=submit_workspace.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "draft",
      description: "Create draft PR for op=submit_workspace.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "skipPR",
      description: "Skip PR creation for op=submit_workspace.",
      required: false,
      schema: { type: "boolean" as const },
    },
    // manage_issues
    {
      name: "title",
      description:
        "Issue title for op=manage_issues with action=create|update.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "body",
      description:
        "Issue body for op=manage_issues with action=create|update|comment.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "issueNumber",
      description:
        "Issue number for op=manage_issues with action=get|update|comment|close|reopen|add_labels.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "labels",
      description:
        "Labels (csv string or array) for op=manage_issues with action=create|update|add_labels|list.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "state",
      description:
        "State filter (open|closed|all) for op=manage_issues with action=list.",
      required: false,
      schema: { type: "string" as const },
    },
    // misc
    {
      name: "validator",
      description: "Optional verifier for op=create.",
      required: false,
      schema: { type: "object" as const },
    },
    {
      name: "maxRetries",
      description: "Verifier retry count for op=create.",
      required: false,
      schema: { type: "integer" as const, minimum: 0 },
    },
    {
      name: "onVerificationFail",
      description: "Verifier failure behavior for op=create.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["retry", "escalate"],
      },
    },
    {
      name: "metadata",
      description: "Additional metadata for op=create.",
      required: false,
      schema: { type: "object" as const },
    },
  ],
  validate: async (runtime, message) => {
    // Always allow when ACP service is available — op switch handles dispatch.
    if (!getAcpService(runtime) && !getCoordinator(runtime)) return false;
    if (
      hasExplicitPayload(message, [
        "op",
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
    const op = readOp(params, content) ?? "create";

    switch (op) {
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
        return errorResult("UNKNOWN", `Unknown TASKS op: ${String(op)}`);
    }
  },
};

// Operation-specific handles resolve to the consolidated TASKS action.
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
