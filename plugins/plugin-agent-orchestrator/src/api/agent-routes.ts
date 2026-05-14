/**
 * Task Agent Route Handlers
 *
 * Handles routes for ACP-based task-agent management:
 * - Preflight checks, metrics, workspace files
 * - Approval presets and config
 * - Agent CRUD: list, spawn, get, send, stop, output
 *
 * @module api/agent-routes
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, realpath, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { logger } from "@elizaos/core";
import { getTaskAgentFrameworkState } from "../services/task-agent-frameworks.js";
import type { AgentType, ApprovalPreset } from "../services/types.js";
import type { RouteContext } from "./route-utils.js";
import { parseBody, sendError, sendJson } from "./route-utils.js";

const execFileAsync = promisify(execFile);
const PREFLIGHT_DONE = new Set<string>();
const PREFLIGHT_INFLIGHT = new Map<string, Promise<void>>();

function shouldAutoPreflight(): boolean {
  if (process.env.ELIZA_BENCHMARK_PREFLIGHT_AUTO === "1") return true;
  return false;
}

function isPathInside(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

async function resolveSafeVenvPath(
  workdir: string,
  venvDirRaw: string,
): Promise<string> {
  const venvDir = venvDirRaw.trim();
  if (!venvDir) {
    throw new Error("ELIZA_BENCHMARK_PREFLIGHT_VENV must be non-empty");
  }
  if (path.isAbsolute(venvDir)) {
    throw new Error(
      "ELIZA_BENCHMARK_PREFLIGHT_VENV must be relative to workdir",
    );
  }

  const normalized = path.normalize(venvDir);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error("ELIZA_BENCHMARK_PREFLIGHT_VENV must stay within workdir");
  }

  const workdirResolved = path.resolve(workdir);
  const workdirReal = await realpath(workdirResolved);
  const resolved = path.resolve(workdirReal, normalized);
  if (!isPathInside(workdirReal, resolved)) {
    throw new Error("ELIZA_BENCHMARK_PREFLIGHT_VENV resolves outside workdir");
  }
  if (resolved === workdirReal) {
    throw new Error(
      "ELIZA_BENCHMARK_PREFLIGHT_VENV must not resolve to workdir root",
    );
  }

  // Canonicalize candidate when present to reject symlink escapes.
  try {
    const resolvedReal = await realpath(resolved);
    if (
      !isPathInside(workdirReal, resolvedReal) ||
      resolvedReal === workdirReal
    ) {
      throw new Error(
        "ELIZA_BENCHMARK_PREFLIGHT_VENV resolves outside workdir",
      );
    }
  } catch (err) {
    const maybeErr = err as NodeJS.ErrnoException;
    if (maybeErr?.code !== "ENOENT") throw err;
    const parentReal = await realpath(path.dirname(resolved));
    if (!isPathInside(workdirReal, parentReal)) {
      throw new Error(
        "ELIZA_BENCHMARK_PREFLIGHT_VENV parent resolves outside workdir",
      );
    }
  }

  return resolved;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRequirementsPath(
  workdir: string,
): Promise<string | null> {
  const workdirReal = await realpath(path.resolve(workdir));
  const candidates = [
    path.join(workdir, "apps", "api", "requirements.txt"),
    path.join(workdir, "requirements.txt"),
  ];
  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) continue;
    try {
      const candidateReal = await realpath(candidate);
      if (isPathInside(workdirReal, candidateReal)) return candidateReal;
    } catch {
      // Ignore malformed candidate and keep scanning.
    }
  }
  return null;
}

async function fingerprintRequirementsFile(
  requirementsPath: string,
): Promise<string> {
  const file = await readFile(requirementsPath);
  return createHash("sha256").update(file).digest("hex");
}

async function runBenchmarkPreflight(workdir: string): Promise<void> {
  if (!shouldAutoPreflight()) return;

  const requirementsPath = await resolveRequirementsPath(workdir);
  if (!requirementsPath) return;
  const requirementsFingerprint =
    await fingerprintRequirementsFile(requirementsPath);

  const mode =
    process.env.ELIZA_BENCHMARK_PREFLIGHT_MODE?.toLowerCase() === "warm"
      ? "warm"
      : "cold";
  const venvDir =
    process.env.ELIZA_BENCHMARK_PREFLIGHT_VENV || ".benchmark-venv";
  const venvPath = await resolveSafeVenvPath(workdir, venvDir);
  const pythonInVenv = path.join(
    venvPath,
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
  const key = `${workdir}::${mode}::${venvPath}::${requirementsFingerprint}`;
  if (PREFLIGHT_DONE.has(key)) {
    if (await fileExists(pythonInVenv)) return;
    PREFLIGHT_DONE.delete(key);
  }
  const existing = PREFLIGHT_INFLIGHT.get(key);
  if (existing) {
    await existing;
    return;
  }

  const run = (async () => {
    const pythonCommand = process.platform === "win32" ? "python" : "python3";

    if (mode === "cold") {
      await rm(venvPath, { recursive: true, force: true });
    }

    const hasVenv = await fileExists(pythonInVenv);
    if (!hasVenv) {
      await execFileAsync(pythonCommand, ["-m", "venv", venvPath], {
        cwd: workdir,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    }

    await execFileAsync(
      pythonInVenv,
      ["-m", "pip", "install", "--upgrade", "pip"],
      {
        cwd: workdir,
        timeout: 300_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );

    await execFileAsync(
      pythonInVenv,
      ["-m", "pip", "install", "-r", requirementsPath],
      {
        cwd: workdir,
        timeout: 600_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );

    PREFLIGHT_DONE.add(key);
  })();
  PREFLIGHT_INFLIGHT.set(key, run);
  try {
    await run;
  } finally {
    PREFLIGHT_INFLIGHT.delete(key);
  }
}

/**
 * Handle task-agent routes (/api/coding-agents/*)
 * Returns true if the route was handled, false otherwise
 */
export async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method?.toUpperCase();

  // === Preflight Check ===
  // GET /api/coding-agents/preflight
  if (method === "GET" && pathname === "/api/coding-agents/preflight") {
    if (!ctx.acpService) {
      sendError(res, "ACP service not available", 503);
      return true;
    }

    try {
      const results =
        (await ctx.acpService.checkAvailableAgents?.()) ??
        (await ctx.acpService.getAvailableAgents?.()) ??
        [];
      sendJson(res, results);
    } catch (error) {
      sendError(
        res,
        error instanceof Error ? error.message : "Preflight check failed",
        500,
      );
    }
    return true;
  }

  // POST /api/coding-agents/auth/:agent — trigger CLI auth flow
  const authMatch = pathname.match(/^\/api\/coding-agents\/auth\/(\w+)$/);
  if (method === "POST" && authMatch) {
    if (!ctx.acpService) {
      sendError(res, "ACP service not available", 503);
      return true;
    }
    const rawAgentType = authMatch[1];

    const SUPPORTED_AGENTS: ReadonlyArray<string> = [
      "claude",
      "codex",
      "opencode",
    ];
    if (!SUPPORTED_AGENTS.includes(rawAgentType)) {
      sendError(res, `Unsupported agent type: ${rawAgentType}`, 400);
      return true;
    }

    sendError(
      res,
      `ACP auth is handled by acpx/the selected ${rawAgentType} CLI; no legacy auth flow is available.`,
      400,
    );
    return true;
  }

  // GET /api/coding-agents/metrics
  if (method === "GET" && pathname === "/api/coding-agents/metrics") {
    if (!ctx.acpService) {
      sendError(res, "ACP service not available", 503);
      return true;
    }
    sendJson(res, {});
    return true;
  }

  // === Scratch Workspace Retention ===
  // GET /api/coding-agents/scratch
  if (method === "GET" && pathname === "/api/coding-agents/scratch") {
    if (!ctx.workspaceService) {
      sendError(res, "Workspace Service not available", 503);
      return true;
    }
    sendJson(res, ctx.workspaceService.listScratchWorkspaces());
    return true;
  }

  // POST /api/coding-agents/:id/scratch/(keep|delete|promote)
  const scratchActionMatch = pathname.match(
    /^\/api\/coding-agents\/([^/]+)\/scratch\/(keep|delete|promote)$/,
  );
  if (method === "POST" && scratchActionMatch) {
    if (!ctx.workspaceService) {
      sendError(res, "Workspace Service not available", 503);
      return true;
    }
    const sessionId = scratchActionMatch[1];
    const action = scratchActionMatch[2];
    try {
      if (action === "keep") {
        const scratch =
          await ctx.workspaceService.keepScratchWorkspace(sessionId);
        sendJson(res, { success: true, scratch });
        return true;
      }
      if (action === "delete") {
        await ctx.workspaceService.deleteScratchWorkspace(sessionId);
        sendJson(res, {
          success: true,
          deleted: true,
          sessionId,
        });
        return true;
      }
      const body = await parseBody(req);
      const promoteName = typeof body.name === "string" ? body.name : undefined;
      const scratch = await ctx.workspaceService.promoteScratchWorkspace(
        sessionId,
        promoteName,
      );
      sendJson(res, { success: true, scratch });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("not found") ? 404 : 500;
      sendError(res, message, status);
    }
    return true;
  }

  // === Workspace Files ===
  // GET /api/coding-agents/workspace-files?agentType=claude
  if (method === "GET" && pathname === "/api/coding-agents/workspace-files") {
    if (!ctx.acpService) {
      sendError(res, "ACP service not available", 503);
      return true;
    }

    try {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const agentType = url.searchParams.get("agentType");
      if (!agentType) {
        sendError(
          res,
          "agentType query parameter required (claude, codex, opencode)",
          400,
        );
        return true;
      }

      sendJson(res, {
        agentType,
        memoryFilePath: null,
        files: [],
      });
    } catch (error) {
      sendError(
        res,
        error instanceof Error
          ? error.message
          : "Failed to get workspace files",
        500,
      );
    }
    return true;
  }

  // === Approval Presets ===
  // GET /api/coding-agents/approval-presets
  if (method === "GET" && pathname === "/api/coding-agents/approval-presets") {
    try {
      const { listPresets } = await import("coding-agent-adapters");
      const presets = listPresets();
      sendJson(res, presets);
    } catch (error) {
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to list presets",
        500,
      );
    }
    return true;
  }

  // GET /api/coding-agents/settings
  if (method === "GET" && pathname === "/api/coding-agents/settings") {
    if (!ctx.acpService) {
      sendError(res, "ACP service not available", 503);
      return true;
    }
    const frameworkState = await getTaskAgentFrameworkState(
      ctx.runtime,
      ctx.acpService,
    );
    sendJson(res, {
      defaultApprovalPreset: ctx.acpService.defaultApprovalPreset,
      agentSelectionStrategy: ctx.acpService.agentSelectionStrategy,
      defaultAgentType: await ctx.acpService.resolveAgentType?.({}),
      preferredAgentType: frameworkState.preferred.id,
      preferredAgentReason: frameworkState.preferred.reason,
      configuredSubscriptionProvider:
        frameworkState.configuredSubscriptionProvider,
      frameworks: frameworkState.frameworks,
    });
    return true;
  }

  // GET /api/coding-agents/approval-config?agentType=claude&preset=autonomous
  if (method === "GET" && pathname === "/api/coding-agents/approval-config") {
    if (!ctx.acpService) {
      sendError(res, "ACP service not available", 503);
      return true;
    }

    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const agentType = url.searchParams.get("agentType");
    const preset = url.searchParams.get("preset");
    if (!agentType || !preset) {
      sendError(res, "agentType and preset query parameters required", 400);
      return true;
    }

    try {
      sendJson(res, { agentType, preset, transport: "acp" });
    } catch (error) {
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to generate config",
        500,
      );
    }
    return true;
  }

  // === List Agents ===
  // GET /api/coding-agents
  if (method === "GET" && pathname === "/api/coding-agents") {
    if (!ctx.acpService) {
      sendError(res, "ACP service not available", 503);
      return true;
    }

    try {
      const sessions = await ctx.acpService.listSessions();
      sendJson(res, sessions);
    } catch (error) {
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to list agents",
        500,
      );
    }
    return true;
  }

  // === Spawn Agent ===
  // POST /api/coding-agents/spawn
  if (method === "POST" && pathname === "/api/coding-agents/spawn") {
    if (!ctx.acpService) {
      sendError(res, "ACP service not available", 503);
      return true;
    }

    try {
      const body = await parseBody(req);
      const {
        agentType,
        workdir: rawWorkdir,
        task,
        initialTask,
        memoryContent,
        approvalPreset,
        customCredentials,
        metadata,
      } = body;
      const taskText =
        typeof task === "string"
          ? task
          : typeof initialTask === "string"
            ? initialTask
            : undefined;

      // Validate workdir: must be within workspace base dir or cwd
      const workspaceBaseDir = path.join(os.homedir(), ".eliza", "workspaces");
      const workspaceBaseDirResolved = path.resolve(workspaceBaseDir);
      const cwdResolved = path.resolve(process.cwd());
      const workspaceBaseDirReal = await realpath(
        workspaceBaseDirResolved,
      ).catch(() => workspaceBaseDirResolved);
      const cwdReal = await realpath(cwdResolved).catch(() => cwdResolved);
      const allowedPrefixes = [workspaceBaseDirReal, cwdReal];
      let workdir = rawWorkdir as string | undefined;
      if (workdir) {
        const resolved = path.resolve(workdir);
        const resolvedReal = await realpath(resolved).catch(() => null);
        if (!resolvedReal) {
          sendError(res, "workdir must exist", 403);
          return true;
        }
        const isAllowed = allowedPrefixes.some(
          (prefix) =>
            resolvedReal === prefix ||
            resolvedReal.startsWith(prefix + path.sep),
        );
        if (!isAllowed) {
          sendError(
            res,
            "workdir must be within workspace base directory or cwd",
            403,
          );
          return true;
        }
        workdir = resolvedReal;
      }

      // Check concurrency limit before spawning
      const activeSessions = await ctx.acpService.listSessions();
      const maxSessions = 8;
      if (activeSessions.length >= maxSessions) {
        sendError(
          res,
          `Concurrent session limit reached (${maxSessions})`,
          429,
        );
        return true;
      }

      if (workdir) {
        try {
          await runBenchmarkPreflight(workdir);
        } catch (preflightError) {
          logger.warn(
            `[coding-agent] benchmark preflight failed for ${workdir}: ${
              preflightError instanceof Error
                ? preflightError.message
                : String(preflightError)
            }`,
          );
        }
      }

      // Resolve requested framework through the single ACP path.
      const agentStr = agentType
        ? (agentType as string).toLowerCase()
        : String((await ctx.acpService.resolveAgentType?.({})) ?? "codex");

      const session = await ctx.acpService.spawnSession({
        name: `agent-${Date.now()}`,
        agentType: agentStr as AgentType,
        workdir: workdir as string,
        initialTask: taskText,
        memoryContent: memoryContent as string | undefined,
        approvalPreset: approvalPreset as ApprovalPreset | undefined,
        customCredentials: customCredentials as
          | Record<string, string>
          | undefined,
        metadata: {
          requestedType: agentStr,
          ...(metadata as Record<string, unknown>),
        },
      });

      sendJson(
        res,
        {
          sessionId: session.id,
          agentType: session.agentType,
          workdir: session.workdir,
          status: session.status,
        },
        201,
      );
    } catch (error) {
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to spawn agent",
        500,
      );
    }
    return true;
  }

  // === Get Agent Status ===
  // GET /api/coding-agents/:id
  const agentMatch = pathname.match(/^\/api\/coding-agents\/([^/]+)$/);
  if (method === "GET" && agentMatch) {
    if (!ctx.acpService) {
      sendError(res, "ACP service not available", 503);
      return true;
    }

    const sessionId = agentMatch[1];
    const session = await ctx.acpService.getSession(sessionId);

    if (!session) {
      sendError(res, "Agent session not found", 404);
      return true;
    }

    sendJson(res, session);
    return true;
  }

  // === Send to Agent ===
  // POST /api/coding-agents/:id/send
  const sendMatch = pathname.match(/^\/api\/coding-agents\/([^/]+)\/send$/);
  if (method === "POST" && sendMatch) {
    if (!ctx.acpService) {
      sendError(res, "ACP service not available", 503);
      return true;
    }

    try {
      const sessionId = sendMatch[1];
      const body = await parseBody(req);
      const { input, keys } = body;

      if (keys) {
        sendError(res, "ACP sessions do not support raw key input", 400);
        return true;
      } else if (input && typeof input === "string") {
        await ctx.acpService.sendToSession(sessionId, input);
        sendJson(res, { success: true });
      } else {
        sendError(
          res,
          "Either 'input' (string) or 'keys' (string|string[]) required",
          400,
        );
        return true;
      }
    } catch (error) {
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to send input",
        500,
      );
    }
    return true;
  }

  // === Stop Agent ===
  // POST /api/coding-agents/:id/stop
  const stopMatch = pathname.match(/^\/api\/coding-agents\/([^/]+)\/stop$/);
  if (method === "POST" && stopMatch) {
    if (!ctx.acpService) {
      sendError(res, "ACP service not available", 503);
      return true;
    }

    try {
      const sessionId = stopMatch[1];
      await ctx.acpService.stopSession(sessionId);
      sendJson(res, { success: true, sessionId });
    } catch (error) {
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to stop agent",
        500,
      );
    }
    return true;
  }

  // === Get Agent Output ===
  // GET /api/coding-agents/:id/output
  const outputMatch = pathname.match(/^\/api\/coding-agents\/([^/]+)\/output$/);
  if (method === "GET" && outputMatch) {
    if (!ctx.acpService) {
      sendError(res, "ACP service not available", 503);
      return true;
    }

    try {
      const sessionId = outputMatch[1];
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const lines = parseInt(url.searchParams.get("lines") || "100", 10);

      const output = await ctx.acpService.getSessionOutput?.(sessionId, lines);
      sendJson(res, { sessionId, output });
    } catch (error) {
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to get output",
        500,
      );
    }
    return true;
  }

  // === Get Buffered Terminal Output ===
  // GET /api/coding-agents/:id/buffered-output
  const bufferedMatch = pathname.match(
    /^\/api\/coding-agents\/([^/]+)\/buffered-output$/,
  );
  if (method === "GET" && bufferedMatch) {
    if (!ctx.acpService?.getSessionOutput) {
      sendError(res, "ACP output buffer not available", 503);
      return true;
    }
    try {
      const sessionId = bufferedMatch[1];
      const output = await ctx.acpService.getSessionOutput(sessionId, 500);
      sendJson(res, { sessionId, output });
    } catch (error) {
      sendError(
        res,
        error instanceof Error
          ? error.message
          : "Failed to get buffered output",
        500,
      );
    }
    return true;
  }

  // Route not handled
  return false;
}
