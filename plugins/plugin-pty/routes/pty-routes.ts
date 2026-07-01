import {
  type IAgentRuntime,
  logger,
  type Route,
  type RouteHandlerContext,
  type RouteHandlerResult,
} from "@elizaos/core";
import {
  buildElizaCodeCerebrasSpec,
  resolveElizaCodeBin,
} from "../lib/eliza-code-spec";
import type { PtyService } from "../services/pty-service";

// --- small helpers -------------------------------------------------------

function json(status: number, body: unknown): RouteHandlerResult {
  return { status, headers: { "content-type": "application/json" }, body };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function getStr(runtime: IAgentRuntime, key: string): string | undefined {
  const fromSetting = runtime.getSetting?.(key);
  if (typeof fromSetting === "string" && fromSetting.trim().length > 0) {
    return fromSetting.trim();
  }
  const fromEnv = process.env[key];
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined;
}

function getService(ctx: RouteHandlerContext): PtyService | null {
  return (ctx.runtime.getService("PTY_SERVICE") as PtyService | null) ?? null;
}

/**
 * Interactive spawning is on unless explicitly disabled or on a store build
 * (which forbids running child processes / dynamic code).
 */
function interactiveEnabled(runtime: IAgentRuntime): boolean {
  const variant = (getStr(runtime, "ELIZA_BUILD_VARIANT") ?? "").toLowerCase();
  if (variant === "store") return false;
  const flag = getStr(runtime, "PTY_INTERACTIVE_ENABLED");
  if (flag !== undefined) return flag !== "false" && flag !== "0";
  return true;
}

/**
 * The Eliza Cloud API key eliza-code will authenticate with: an explicit body
 * key → a dedicated setting → the agent's OpenAI-compatible key.
 */
function resolveCloudApiKey(
  runtime: IAgentRuntime,
  bodyKey?: string,
): string | undefined {
  return (
    bodyKey ??
    getStr(runtime, "PTY_ELIZA_CLOUD_API_KEY") ??
    getStr(runtime, "OPENAI_API_KEY")
  );
}

function defaultCwd(runtime: IAgentRuntime): string {
  return getStr(runtime, "PTY_ALLOWED_DIRECTORY") ?? process.cwd();
}

// --- handlers ------------------------------------------------------------

/**
 * POST /api/pty/sessions — spawn an interactive session. Currently supports
 * `kind: "eliza-code"` (real slash-command CLI on Eliza Cloud/cerebras).
 * Never logs the request body (it may carry an API key).
 */
async function spawnHandler(
  ctx: RouteHandlerContext,
): Promise<RouteHandlerResult> {
  const { runtime } = ctx;
  if (!interactiveEnabled(runtime)) {
    return json(403, {
      error:
        "Interactive PTY sessions are disabled (PTY_INTERACTIVE_ENABLED=false or store build).",
    });
  }
  const svc = getService(ctx);
  if (!svc) return json(503, { error: "PTY_SERVICE is not available." });

  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const kind = str(body.kind) ?? "eliza-code";
  if (kind !== "eliza-code") {
    return json(400, {
      error: `Unsupported session kind "${kind}". Only "eliza-code" is supported.`,
    });
  }

  const apiKey = resolveCloudApiKey(runtime, str(body.apiKey));
  if (!apiKey) {
    return json(400, {
      error:
        "No Eliza Cloud API key available. Pass { apiKey } or configure OPENAI_API_KEY.",
    });
  }

  const cwd = str(body.cwd) ?? defaultCwd(runtime);
  const tier = str(body.tier) === "smart" ? "smart" : "fast";

  try {
    const binPath = resolveElizaCodeBin();
    const spec = buildElizaCodeCerebrasSpec({
      cwd,
      apiKey,
      binPath,
      tier,
      baseUrl: str(body.baseUrl),
      fastModel: str(body.fastModel),
      smartModel: str(body.smartModel),
    });
    const cols = num(body.cols);
    const rows = num(body.rows);
    if (cols) spec.cols = cols;
    if (rows) spec.rows = rows;

    const session = await svc.startSession(spec);
    logger.info(
      `[plugin-pty] spawned interactive session ${session.sessionId} kind=${kind} tier=${tier} cwd=${cwd}`,
    );
    return json(200, { session });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[plugin-pty] spawn failed: ${message}`);
    return json(400, { error: message });
  }
}

/** GET /api/pty/sessions — list live sessions. */
async function listHandler(
  ctx: RouteHandlerContext,
): Promise<RouteHandlerResult> {
  const svc = getService(ctx);
  if (!svc) return json(503, { error: "PTY_SERVICE is not available." });
  return json(200, { sessions: svc.listSessions() });
}

/** DELETE /api/pty/sessions/:id — kill a session. */
async function stopHandler(
  ctx: RouteHandlerContext,
): Promise<RouteHandlerResult> {
  const svc = getService(ctx);
  if (!svc) return json(503, { error: "PTY_SERVICE is not available." });
  const id = ctx.params?.id;
  if (!id) return json(400, { error: "Missing session id." });
  await svc.stopSession(id);
  return json(200, { ok: true });
}

/**
 * Private (authenticated) routes. `rawPath` keeps the `/api/pty/*` URLs stable
 * for the cockpit client instead of prefixing them with the plugin name.
 */
export const ptyRoutes: Route[] = [
  {
    type: "POST",
    path: "/api/pty/sessions",
    rawPath: true,
    name: "pty-spawn-session",
    routeHandler: spawnHandler,
  },
  {
    type: "GET",
    path: "/api/pty/sessions",
    rawPath: true,
    name: "pty-list-sessions",
    routeHandler: listHandler,
  },
  {
    type: "DELETE",
    path: "/api/pty/sessions/:id",
    rawPath: true,
    name: "pty-stop-session",
    routeHandler: stopHandler,
  },
];
