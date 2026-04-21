/**
 * Fallback handler for /api/coding-agents/* routes when the plugin
 * doesn't export createCodingAgentRouteHandler.
 * Uses the orchestrator plugin's CODE_TASK compatibility service to
 * provide task data.
 *
 * Extracted from server.ts to reduce file size.
 */

import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import {
  readJsonBody as parseJsonBody,
  sendJson,
  sendJsonError,
} from "./http-helpers.js";
import type { PTYService } from "./parse-action-block.js";

const MAX_BODY_BYTES = 1024 * 1024;

async function readJsonBody<T = Record<string, unknown>>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<T | null> {
  return parseJsonBody(req, res, {
    maxBytes: MAX_BODY_BYTES,
  });
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  sendJson(res, data, status);
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  sendJsonError(res, message, status);
}

type ScratchStatus = "pending_decision" | "kept" | "promoted";
type ScratchTerminalEvent = "stopped" | "task_complete" | "error";
type ScratchRecord = {
  sessionId: string;
  label: string;
  path: string;
  status: ScratchStatus;
  createdAt: number;
  terminalAt: number;
  terminalEvent: ScratchTerminalEvent;
  expiresAt?: number;
};
type AgentPreflightRecord = {
  adapter?: string;
  installed?: boolean;
  installCommand?: string;
  docsUrl?: string;
  auth?: import("./coding-agents-preflight-normalize").NormalizedPreflightAuth;
};
/** CLI login hook on adapter instances. */
type CodingAgentAdapterAuthHook = {
  triggerAuth?: () => Promise<
    | boolean
    | null
    | undefined
    | {
        launched?: boolean;
        url?: string;
        deviceCode?: string;
        instructions?: string;
      }
  >;
};
type CodeTaskService = {
  getTasks?: () => Promise<
    Array<{
      id?: string;
      name?: string;
      description?: string;
      metadata?: {
        status?: string;
        providerId?: string;
        providerLabel?: string;
        workingDirectory?: string;
        progress?: number;
        steps?: Array<{ status?: string }>;
      };
    }>
  >;
  getAgentPreflight?: () => Promise<unknown>;
  listAgentPreflight?: () => Promise<unknown>;
  preflightCodingAgents?: () => Promise<unknown>;
  preflight?: () => Promise<unknown>;
  listScratchWorkspaces?: () => Promise<unknown>;
  getScratchWorkspaces?: () => Promise<unknown>;
  listScratch?: () => Promise<unknown>;
  keepScratchWorkspace?: (sessionId: string) => Promise<unknown>;
  keepScratch?: (sessionId: string) => Promise<unknown>;
  deleteScratchWorkspace?: (sessionId: string) => Promise<unknown>;
  deleteScratch?: (sessionId: string) => Promise<unknown>;
  promoteScratchWorkspace?: (
    sessionId: string,
    name?: string,
  ) => Promise<unknown>;
  promoteScratch?: (sessionId: string, name?: string) => Promise<unknown>;
};

const buildEmptyCoordinatorStatus = () => ({
  supervisionLevel: "autonomous",
  taskCount: 0,
  tasks: [] as Array<Record<string, unknown>>,
  recentTasks: [] as Array<Record<string, unknown>>,
  taskThreadCount: 0,
  taskThreads: [] as Array<Record<string, unknown>>,
  pendingConfirmations: 0,
  frameworks: [] as Array<Record<string, unknown>>,
});

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};
const toScratchStatus = (value: unknown): ScratchStatus => {
  if (value === "kept" || value === "promoted") return value;
  return "pending_decision";
};
const toTerminalEvent = (value: unknown): ScratchTerminalEvent => {
  if (value === "stopped" || value === "error") return value;
  return "task_complete";
};
const normalizeScratchRecord = (value: unknown): ScratchRecord | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const sessionId =
    typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
  const pathValue = typeof raw.path === "string" ? raw.path.trim() : "";
  if (!sessionId || !pathValue) return null;
  const createdAt = toNumber(raw.createdAt, Date.now());
  const terminalAt = toNumber(raw.terminalAt, createdAt);
  const expiresAt = toNumber(raw.expiresAt, 0);
  return {
    sessionId,
    label:
      typeof raw.label === "string" && raw.label.trim().length > 0
        ? raw.label
        : sessionId,
    path: pathValue,
    status: toScratchStatus(raw.status),
    createdAt,
    terminalAt,
    terminalEvent: toTerminalEvent(raw.terminalEvent),
    ...(expiresAt > 0 ? { expiresAt } : {}),
  };
};
const parseSessionId = (raw: string): string | null => {
  let sessionId = "";
  try {
    sessionId = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!sessionId || sessionId.includes("/") || sessionId.includes("..")) {
    return null;
  }
  return sessionId;
};
const parseTaskId = (raw: string): string | null => {
  let taskId = "";
  try {
    taskId = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!taskId || taskId.includes("/") || taskId.includes("..")) {
    return null;
  }
  return taskId;
};

export async function handleCodingAgentsFallback(
  runtime: AgentRuntime,
  pathname: string,
  method: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const codeTaskService = runtime.getService(
    "CODE_TASK",
  ) as CodeTaskService | null;

  const ptyListService = runtime.getService("PTY_SERVICE") as
    | (PTYService & {
        listSessions?: () => Promise<unknown[]>;
      })
    | null;

  // GET /api/coding-agents/tasks
  if (method === "GET" && pathname === "/api/coding-agents/tasks") {
    if (!codeTaskService?.getTasks) {
      error(res, "Coding agent task service unavailable", 503);
      return true;
    }
    try {
      const url = new URL(req.url ?? pathname, "http://localhost");
      const requestedStatus = url.searchParams.get("status");
      const requestedLimit = Number(url.searchParams.get("limit"));
      let tasks = (await codeTaskService.getTasks()) ?? [];
      if (!Array.isArray(tasks)) {
        tasks = [];
      }
      if (requestedStatus) {
        tasks = tasks.filter(
          (task) => task.metadata?.status === requestedStatus,
        );
      }
      if (Number.isFinite(requestedLimit) && requestedLimit > 0) {
        tasks = tasks.slice(0, requestedLimit);
      }
      json(res, { tasks });
      return true;
    } catch (e: unknown) {
      error(res, `Failed to list coding agent tasks: ${e}`, 500);
      return true;
    }
  }

  const taskMatch = pathname.match(/^\/api\/coding-agents\/tasks\/([^/]+)$/);
  if (method === "GET" && taskMatch) {
    const taskId = parseTaskId(taskMatch[1]);
    if (!taskId) {
      error(res, "Invalid task ID", 400);
      return true;
    }
    if (!codeTaskService?.getTasks) {
      error(res, "Coding agent task service unavailable", 503);
      return true;
    }
    try {
      const tasks = (await codeTaskService.getTasks()) ?? [];
      const task = Array.isArray(tasks)
        ? tasks.find((entry) => entry.id === taskId)
        : undefined;
      if (!task) {
        error(res, "Task not found", 404);
        return true;
      }
      json(res, { task });
      return true;
    } catch (e: unknown) {
      error(res, `Failed to get coding agent task: ${e}`, 500);
      return true;
    }
  }

  // GET /api/coding-agents/sessions
  if (method === "GET" && pathname === "/api/coding-agents/sessions") {
    if (!ptyListService?.listSessions) {
      error(res, "Coding agent session service unavailable", 503);
      return true;
    }
    try {
      const sessions = (await ptyListService.listSessions()) ?? [];
      json(res, { sessions: Array.isArray(sessions) ? sessions : [] });
      return true;
    } catch (e: unknown) {
      error(res, `Failed to list coding agent sessions: ${e}`, 500);
      return true;
    }
  }

  const sessionMatch = pathname.match(
    /^\/api\/coding-agents\/sessions\/([^/]+)$/,
  );
  if (method === "GET" && sessionMatch) {
    const sessionId = parseSessionId(sessionMatch[1]);
    if (!sessionId) {
      error(res, "Invalid session ID", 400);
      return true;
    }
    if (!ptyListService?.listSessions) {
      error(res, "Coding agent session service unavailable", 503);
      return true;
    }
    try {
      const sessions = (await ptyListService.listSessions()) ?? [];
      const session = Array.isArray(sessions)
        ? sessions.find((entry) => {
            if (!entry || typeof entry !== "object") return false;
            const raw = entry as Record<string, unknown>;
            return (
              raw.id === sessionId ||
              raw.sessionId === sessionId ||
              raw.roomId === sessionId
            );
          })
        : undefined;
      if (!session) {
        error(res, "Session not found", 404);
        return true;
      }
      json(res, { session });
      return true;
    } catch (e: unknown) {
      error(res, `Failed to get coding agent session: ${e}`, 500);
      return true;
    }
  }

  // GET /api/coding-agents/preflight
  if (method === "GET" && pathname === "/api/coding-agents/preflight") {
    const loaders: Array<(() => Promise<unknown>) | undefined> = [
      codeTaskService?.getAgentPreflight,
      codeTaskService?.listAgentPreflight,
      codeTaskService?.preflightCodingAgents,
      codeTaskService?.preflight,
    ];
    if (!loaders.some(Boolean)) {
      error(res, "Coding agent preflight unavailable", 503);
      return true;
    }
    try {
      let rows: unknown[] = [];
      for (const loader of loaders) {
        if (!loader) continue;
        const maybeRows = await loader.call(codeTaskService);
        if (Array.isArray(maybeRows)) {
          rows = maybeRows;
          break;
        }
      }
      const { normalizePreflightAuth } = await import(
        "./coding-agents-preflight-normalize"
      );
      const normalized = rows.flatMap((item): AgentPreflightRecord[] => {
        if (!item || typeof item !== "object") return [];
        const raw = item as Record<string, unknown>;
        const adapter =
          typeof raw.adapter === "string" ? raw.adapter.trim() : "";
        if (!adapter) return [];
        const auth = normalizePreflightAuth(raw.auth);
        return [
          {
            adapter,
            installed: Boolean(raw.installed),
            installCommand:
              typeof raw.installCommand === "string"
                ? raw.installCommand
                : undefined,
            docsUrl: typeof raw.docsUrl === "string" ? raw.docsUrl : undefined,
            ...(auth ? { auth } : {}),
          },
        ];
      });
      json(res, normalized);
      return true;
    } catch (e: unknown) {
      error(res, `Failed to get coding agent preflight: ${e}`, 500);
      return true;
    }
  }

  // GET /api/coding-agents/coordinator/status
  if (
    method === "GET" &&
    pathname === "/api/coding-agents/coordinator/status"
  ) {
    if (!codeTaskService?.getTasks) {
      error(res, "Coding agent coordinator unavailable", 503);
      return true;
    }

    try {
      const tasks = await codeTaskService.getTasks();

      const mappedTasks = tasks.map((task) => {
        const meta = task.metadata ?? {};
        let status: string = "active";
        switch (meta.status) {
          case "completed":
            status = "completed";
            break;
          case "failed":
          case "error":
            status = "error";
            break;
          case "cancelled":
            status = "stopped";
            break;
          case "paused":
            status = "blocked";
            break;
          case "running":
            status = "active";
            break;
          case "pending":
            status = "active";
            break;
          default:
            status = "active";
        }

        return {
          sessionId: task.id ?? "",
          agentType: meta.providerId ?? "eliza",
          label: meta.providerLabel ?? task.name ?? "Task",
          originalTask: task.description ?? task.name ?? "",
          workdir: meta.workingDirectory ?? process.cwd(),
          status,
          decisionCount: meta.steps?.length ?? 0,
          autoResolvedCount:
            meta.steps?.filter((s) => s.status === "completed").length ?? 0,
        };
      });

      json(res, {
        ...buildEmptyCoordinatorStatus(),
        taskCount: mappedTasks.length,
        tasks: mappedTasks,
        recentTasks: mappedTasks,
        pendingConfirmations: 0,
      });
      return true;
    } catch (e: unknown) {
      error(res, `Failed to get coding agent status: ${e}`, 500);
      return true;
    }
  }

  // POST /api/coding-agents/:sessionId/stop
  const stopMatch = pathname.match(/^\/api\/coding-agents\/([^/]+)\/stop$/);
  if (method === "POST" && stopMatch) {
    const sessionId = parseSessionId(stopMatch[1]);
    if (!sessionId) {
      error(res, "Invalid session ID", 400);
      return true;
    }
    const ptyService = runtime.getService("PTY_SERVICE") as PTYService | null;

    if (!ptyService?.stopSession) {
      error(res, "PTY Service not available", 503);
      return true;
    }

    try {
      await ptyService.stopSession(sessionId);
      json(res, { ok: true });
      return true;
    } catch (e: unknown) {
      error(res, `Failed to stop session: ${e}`, 500);
      return true;
    }
  }

  // GET /api/coding-agents/scratch
  if (method === "GET" && pathname === "/api/coding-agents/scratch") {
    const loaders: Array<(() => Promise<unknown>) | undefined> = [
      codeTaskService?.listScratchWorkspaces,
      codeTaskService?.getScratchWorkspaces,
      codeTaskService?.listScratch,
    ];
    if (!loaders.some(Boolean)) {
      error(res, "Coding agent scratch workspace service unavailable", 503);
      return true;
    }
    try {
      let rows: unknown[] = [];
      for (const loader of loaders) {
        if (!loader) continue;
        const maybeRows = await loader.call(codeTaskService);
        if (Array.isArray(maybeRows)) {
          rows = maybeRows;
          break;
        }
      }
      const normalized = rows
        .map((item) => normalizeScratchRecord(item))
        .filter((item): item is ScratchRecord => item !== null);
      json(res, normalized);
      return true;
    } catch (e: unknown) {
      error(res, `Failed to list scratch workspaces: ${e}`, 500);
      return true;
    }
  }

  const keepMatch = pathname.match(
    /^\/api\/coding-agents\/([^/]+)\/scratch\/keep$/,
  );
  if (method === "POST" && keepMatch) {
    const sessionId = parseSessionId(keepMatch[1]);
    if (!sessionId) {
      error(res, "Invalid session ID", 400);
      return true;
    }
    const keeper =
      codeTaskService?.keepScratchWorkspace ?? codeTaskService?.keepScratch;
    if (!keeper) {
      error(res, "Scratch keep is not available", 503);
      return true;
    }
    try {
      await keeper.call(codeTaskService, sessionId);
      json(res, { ok: true });
      return true;
    } catch (e: unknown) {
      error(res, `Failed to keep scratch workspace: ${e}`, 500);
      return true;
    }
  }

  const deleteMatch = pathname.match(
    /^\/api\/coding-agents\/([^/]+)\/scratch\/delete$/,
  );
  if (method === "POST" && deleteMatch) {
    const sessionId = parseSessionId(deleteMatch[1]);
    if (!sessionId) {
      error(res, "Invalid session ID", 400);
      return true;
    }
    const deleter =
      codeTaskService?.deleteScratchWorkspace ?? codeTaskService?.deleteScratch;
    if (!deleter) {
      error(res, "Scratch delete is not available", 503);
      return true;
    }
    try {
      await deleter.call(codeTaskService, sessionId);
      json(res, { ok: true });
      return true;
    } catch (e: unknown) {
      error(res, `Failed to delete scratch workspace: ${e}`, 500);
      return true;
    }
  }

  const promoteMatch = pathname.match(
    /^\/api\/coding-agents\/([^/]+)\/scratch\/promote$/,
  );
  if (method === "POST" && promoteMatch) {
    const sessionId = parseSessionId(promoteMatch[1]);
    if (!sessionId) {
      error(res, "Invalid session ID", 400);
      return true;
    }
    const promoter =
      codeTaskService?.promoteScratchWorkspace ??
      codeTaskService?.promoteScratch;
    if (!promoter) {
      error(res, "Scratch promote is not available", 503);
      return true;
    }
    const body = await readJsonBody<{ name?: string }>(req, res);
    if (body === null) return true;
    const name =
      typeof body.name === "string" && body.name.trim().length > 0
        ? body.name.trim()
        : undefined;
    try {
      const promoted = await promoter.call(codeTaskService, sessionId, name);
      const scratch = normalizeScratchRecord(promoted);
      json(res, { success: true, ...(scratch ? { scratch } : {}) });
      return true;
    } catch (e: unknown) {
      error(res, `Failed to promote scratch workspace: ${e}`, 500);
      return true;
    }
  }

  // GET /api/coding-agents
  if (method === "GET" && pathname === "/api/coding-agents") {
    if (!codeTaskService?.getTasks) {
      error(res, "Coding agent task service unavailable", 503);
      return true;
    }
    try {
      const tasks = await codeTaskService.getTasks();
      json(res, Array.isArray(tasks) ? tasks : []);
      return true;
    } catch (e: unknown) {
      error(res, `Failed to list coding agents: ${e}`, 500);
      return true;
    }
  }

  // POST /api/coding-agents/auth/:agent
  const authMatch = pathname.match(/^\/api\/coding-agents\/auth\/(\w+)$/);
  if (method === "POST" && authMatch) {
    const agentType = authMatch[1];
    const ALLOWED_AGENT_TYPES = new Set(["claude", "codex", "gemini", "aider"]);
    if (!ALLOWED_AGENT_TYPES.has(agentType)) {
      error(res, `Unsupported agent type: ${agentType}`, 400);
      return true;
    }
    try {
      const ptyService = runtime.getService("PTY_SERVICE") as {
        triggerAgentAuth?: (
          agent: import("coding-agent-adapters").AdapterType,
        ) => Promise<unknown>;
      } | null;
      const triggerAuthFn =
        typeof ptyService?.triggerAgentAuth === "function"
          ? () =>
              ptyService.triggerAgentAuth?.(
                agentType as import("coding-agent-adapters").AdapterType,
              )
          : null;
      if (!triggerAuthFn) {
        const { createAdapter } = await import("coding-agent-adapters");
        const adapter = createAdapter(
          agentType as import("coding-agent-adapters").AdapterType,
        );
        const authAdapter = adapter as unknown as CodingAgentAdapterAuthHook;
        if (typeof authAdapter.triggerAuth !== "function") {
          error(res, `Auth trigger is unavailable for ${agentType}`, 501);
          return true;
        }
      }
      const AUTH_TIMEOUT_MS = 15_000;
      const timeoutError = new Error("auth trigger timeout");
      const triggered = await Promise.race([
        triggerAuthFn
          ? triggerAuthFn()
          : (
              (await import("coding-agent-adapters")).createAdapter(
                agentType as import("coding-agent-adapters").AdapterType,
              ) as unknown as CodingAgentAdapterAuthHook
            ).triggerAuth?.(),
        new Promise((_, reject) =>
          setTimeout(() => reject(timeoutError), AUTH_TIMEOUT_MS),
        ),
      ]).catch((e) => {
        if (e === timeoutError) return "__timeout__" as const;
        throw e;
      });
      if (triggered === "__timeout__") {
        error(res, `Auth trigger timed out for ${agentType}`, 504);
      } else if (!triggered) {
        error(res, `No auth flow available for ${agentType}`, 400);
      } else {
        const { sanitizeAuthResult } = await import(
          "./coding-agents-auth-sanitize"
        );
        json(res, sanitizeAuthResult(triggered));
      }
    } catch (e: unknown) {
      const { logger } = await import("@elizaos/core");
      logger.error(
        `[coding-agents/auth] triggerAuth failed for ${agentType}: ${
          e instanceof Error ? (e.stack ?? e.message) : String(e)
        }`,
      );
      error(res, `Auth trigger failed for ${agentType}`, 500);
    }
    return true;
  }

  // Not handled by fallback
  return false;
}
