/**
 * Task Agent Route Handlers
 *
 * Handles routes for PTY-based task-agent management:
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
import { extractEvalRunMetadata } from "../actions/eval-metadata.js";
import {
  buildAgentCredentials,
  isAnthropicOAuthToken,
  sanitizeCustomCredentials,
} from "../services/agent-credentials.js";
import { getCoordinator } from "../services/pty-service.js";
import {
  type CodingAgentType,
  isOpencodeAgentType,
  isPiAgentType,
  normalizeAgentType,
  toPiCommand,
} from "../services/pty-types.js";
import { getTaskAgentFrameworkState } from "../services/task-agent-frameworks.js";
import type { RouteContext } from "./route-utils.js";
import { parseBody, sendError, sendJson } from "./route-utils.js";

const execFileAsync = promisify(execFile);
const PREFLIGHT_DONE = new Set<string>();
const PREFLIGHT_INFLIGHT = new Map<string, Promise<void>>();

function shouldAutoPreflight(): boolean {
  if (process.env.PARALLAX_BENCHMARK_PREFLIGHT_AUTO === "1") return true;
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
    throw new Error("PARALLAX_BENCHMARK_PREFLIGHT_VENV must be non-empty");
  }
  if (path.isAbsolute(venvDir)) {
    throw new Error(
      "PARALLAX_BENCHMARK_PREFLIGHT_VENV must be relative to workdir",
    );
  }

  const normalized = path.normalize(venvDir);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      "PARALLAX_BENCHMARK_PREFLIGHT_VENV must stay within workdir",
    );
  }

  const workdirResolved = path.resolve(workdir);
  const workdirReal = await realpath(workdirResolved);
  const resolved = path.resolve(workdirReal, normalized);
  if (!isPathInside(workdirReal, resolved)) {
    throw new Error(
      "PARALLAX_BENCHMARK_PREFLIGHT_VENV resolves outside workdir",
    );
  }
  if (resolved === workdirReal) {
    throw new Error(
      "PARALLAX_BENCHMARK_PREFLIGHT_VENV must not resolve to workdir root",
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
        "PARALLAX_BENCHMARK_PREFLIGHT_VENV resolves outside workdir",
      );
    }
  } catch (err) {
    const maybeErr = err as NodeJS.ErrnoException;
    if (maybeErr?.code !== "ENOENT") throw err;
    const parentReal = await realpath(path.dirname(resolved));
    if (!isPathInside(workdirReal, parentReal)) {
      throw new Error(
        "PARALLAX_BENCHMARK_PREFLIGHT_VENV parent resolves outside workdir",
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
    process.env.PARALLAX_BENCHMARK_PREFLIGHT_MODE?.toLowerCase() === "warm"
      ? "warm"
      : "cold";
  const venvDir =
    process.env.PARALLAX_BENCHMARK_PREFLIGHT_VENV || ".benchmark-venv";
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
    if (!ctx.ptyService) {
      sendError(res, "PTY Service not available", 503);
      return true;
    }

    try {
      const results = await ctx.ptyService.checkAvailableAgents();
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
    if (!ctx.ptyService) {
      sendError(res, "PTY Service not available", 503);
      return true;
    }
    const rawAgentType = authMatch[1];

    // Validate agent type before instantiating an adapter.
    // Must stay in sync with PTYService.checkAvailableAgents() default list.
    const SUPPORTED_AGENTS: ReadonlyArray<string> = [
      "claude",
      "codex",
      "gemini",
      "aider",
    ];
    if (!SUPPORTED_AGENTS.includes(rawAgentType)) {
      sendError(res, `Unsupported agent type: ${rawAgentType}`, 400);
      return true;
    }

    const agentType =
      rawAgentType as import("../services/task-agent-frameworks.js").SupportedTaskAgentAdapter;
    try {
      const result = await ctx.ptyService.triggerAgentAuth(agentType);
      if (!result) {
        sendError(res, `No auth flow available for ${agentType}`, 400);
      } else {
        sendJson(res, result);
      }
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Auth trigger failed";
      // Defensive fallback: primary input validation is handled by
      // SUPPORTED_AGENTS above, so reaching here means the adapter package's
      // own validation failed (e.g. internal lookup table mismatch). The regex
      // is brittle if `coding-agent-adapters` changes its error wording, but
      // it lets us return 400 instead of 500 for likely client errors.
      const status = /unknown adapter|unsupported/i.test(msg) ? 400 : 500;
      sendError(res, msg, status);
    }
    return true;
  }

  // GET /api/coding-agents/metrics
  if (method === "GET" && pathname === "/api/coding-agents/metrics") {
    if (!ctx.ptyService) {
      sendError(res, "PTY Service not available", 503);
      return true;
    }
    sendJson(res, ctx.ptyService.getAgentMetrics());
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
    if (!ctx.ptyService) {
      sendError(res, "PTY Service not available", 503);
      return true;
    }

    try {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const agentType = url.searchParams.get("agentType");
      if (!agentType) {
        sendError(
          res,
          "agentType query parameter required (claude, gemini, codex, aider, pi)",
          400,
        );
        return true;
      }

      if (isPiAgentType(agentType)) {
        sendJson(res, {
          agentType: "pi",
          memoryFilePath: ".pi/agent/settings.json",
          files: [],
        });
        return true;
      }

      const files = ctx.ptyService.getWorkspaceFiles(
        agentType as import("coding-agent-adapters").AdapterType,
      );
      const memoryFilePath = ctx.ptyService.getMemoryFilePath(
        agentType as import("coding-agent-adapters").AdapterType,
      );
      sendJson(res, {
        agentType,
        memoryFilePath,
        files,
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
    if (!ctx.ptyService) {
      sendError(res, "PTY Service not available", 503);
      return true;
    }
    const frameworkState = await getTaskAgentFrameworkState(
      ctx.runtime,
      ctx.ptyService,
    );
    sendJson(res, {
      defaultApprovalPreset: ctx.ptyService.defaultApprovalPreset,
      agentSelectionStrategy: ctx.ptyService.agentSelectionStrategy,
      defaultAgentType: ctx.ptyService.defaultAgentType,
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
    if (!ctx.ptyService) {
      sendError(res, "PTY Service not available", 503);
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
      const config = ctx.ptyService.getApprovalConfig(
        agentType as import("coding-agent-adapters").AdapterType,
        preset as import("coding-agent-adapters").ApprovalPreset,
      );
      sendJson(res, config);
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
    if (!ctx.ptyService) {
      sendError(res, "PTY Service not available", 503);
      return true;
    }

    try {
      const sessions = await ctx.ptyService.listSessions();
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
    if (!ctx.ptyService) {
      sendError(res, "PTY Service not available", 503);
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
      const activeSessions = await ctx.ptyService.listSessions();
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
          console.warn(
            `[coding-agent] benchmark preflight failed for ${workdir}:`,
            preflightError,
          );
        }
      }

      // Build credentials from runtime
      const rawAnthropicKey = ctx.runtime.getSetting("ANTHROPIC_API_KEY") as
        | string
        | undefined;
      let credentials: ReturnType<typeof buildAgentCredentials>;
      try {
        credentials = buildAgentCredentials(ctx.runtime);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to build credentials";
        sendError(res, message, 400);
        return true;
      }

      // Resolve requested framework; PTYService applies model preferences centrally.
      const agentStr = agentType
        ? (agentType as string).toLowerCase()
        : await ctx.ptyService.resolveAgentType();
      const piRequested = isPiAgentType(agentStr);
      const opencodeRequested = isOpencodeAgentType(agentStr);
      // For pi/opencode we keep the unnormalized type so spawnSession can
      // detect the request via its own `isOpencodeAgentType` / `isPiAgentType`
      // check. Normalizing here to "shell" too early skips the per-adapter
      // brief + AGENTS.md write paths inside spawnSession.
      const normalizedType: CodingAgentType =
        piRequested || opencodeRequested
          ? (agentStr as CodingAgentType)
          : normalizeAgentType(agentStr);
      const aiderProvider =
        agentStr === "aider"
          ? (ctx.runtime.getSetting("PARALLAX_AIDER_PROVIDER") as string | null)
          : null;

      // Check if coordinator is active — route blocking prompts through it
      const coordinator = getCoordinator(ctx.runtime);
      const requestedThreadId =
        typeof (metadata as Record<string, unknown>)?.threadId === "string"
          ? ((metadata as Record<string, unknown>).threadId as string)
          : null;
      const evalRunMetadata = extractEvalRunMetadata(
        metadata as Record<string, unknown>,
      );
      const taskThread =
        coordinator && taskText && !requestedThreadId
          ? await coordinator.createTaskThread({
              title:
                ((metadata as Record<string, unknown>)?.label as
                  | string
                  | undefined) ?? `Task ${Date.now()}`,
              originalRequest: taskText,
              scenarioId: evalRunMetadata.scenarioId,
              batchId: evalRunMetadata.batchId,
              metadata: {
                workdir: workdir ?? null,
                source: "api-spawn",
                ...(evalRunMetadata.scenarioId
                  ? { scenarioId: evalRunMetadata.scenarioId }
                  : {}),
                ...(evalRunMetadata.batchId
                  ? { batchId: evalRunMetadata.batchId }
                  : {}),
              },
            })
          : requestedThreadId
            ? await coordinator?.getTaskThread(requestedThreadId)
            : null;

      const session = await ctx.ptyService.spawnSession({
        name: `agent-${Date.now()}`,
        agentType: normalizedType,
        workdir: workdir as string,
        initialTask: piRequested ? toPiCommand(taskText) : taskText,
        memoryContent: memoryContent as string | undefined,
        credentials,
        approvalPreset: approvalPreset as
          | import("coding-agent-adapters").ApprovalPreset
          | undefined,
        customCredentials: sanitizeCustomCredentials(
          customCredentials as Record<string, string> | undefined,
          isAnthropicOAuthToken(rawAnthropicKey) ? [rawAnthropicKey] : [],
        ),
        // Let adapter auto-response handle known prompts (permissions, trust, etc.)
        // instantly. The coordinator handles only unrecognized prompts via LLM.
        metadata: {
          threadId: taskThread?.id ?? requestedThreadId,
          requestedType: agentStr,
          ...(metadata as Record<string, unknown>),
          ...(aiderProvider ? { provider: aiderProvider } : {}),
        },
      });
      if (coordinator) {
        const label = (metadata as Record<string, unknown>)?.label as
          | string
          | undefined;
        const defaultLabelPrefix =
          normalizedType === "shell" ? "shell" : "agent";
        await coordinator.registerTask(session.id, {
          threadId: taskThread?.id ?? requestedThreadId ?? session.id,
          agentType:
            agentStr as import("../services/pty-service.js").CodingAgentType,
          label: label || `${defaultLabelPrefix}-${session.id.slice(-8)}`,
          originalTask: taskText ?? "",
          workdir: session.workdir,
        });
      }

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
    if (!ctx.ptyService) {
      sendError(res, "PTY Service not available", 503);
      return true;
    }

    const sessionId = agentMatch[1];
    const session = ctx.ptyService.getSession(sessionId);

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
    if (!ctx.ptyService) {
      sendError(res, "PTY Service not available", 503);
      return true;
    }

    try {
      const sessionId = sendMatch[1];
      const body = await parseBody(req);
      const { input, keys } = body;

      if (keys) {
        // Send special keys (e.g. "enter", ["down","enter"], "Ctrl-C")
        await ctx.ptyService.sendKeysToSession(
          sessionId,
          keys as string | string[],
        );
        sendJson(res, { success: true });
      } else if (input && typeof input === "string") {
        await ctx.ptyService.sendToSession(sessionId, input);
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
    if (!ctx.ptyService) {
      sendError(res, "PTY Service not available", 503);
      return true;
    }

    try {
      const sessionId = stopMatch[1];
      await ctx.ptyService.stopSession(sessionId);
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
    if (!ctx.ptyService) {
      sendError(res, "PTY Service not available", 503);
      return true;
    }

    try {
      const sessionId = outputMatch[1];
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const lines = parseInt(url.searchParams.get("lines") || "100", 10);

      const output = await ctx.ptyService.getSessionOutput(sessionId, lines);
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

  // === Get Buffered Terminal Output (raw ANSI for xterm.js hydration) ===
  // GET /api/coding-agents/:id/buffered-output
  const bufferedMatch = pathname.match(
    /^\/api\/coding-agents\/([^/]+)\/buffered-output$/,
  );
  if (method === "GET" && bufferedMatch) {
    if (!ctx.ptyService?.consoleBridge) {
      sendError(res, "Console bridge not available", 503);
      return true;
    }
    try {
      const sessionId = bufferedMatch[1];
      const output = ctx.ptyService.consoleBridge.getBufferedOutput(sessionId);
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
