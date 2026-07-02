import { timingSafeEqual } from "node:crypto";
import {
  type IAgentRuntime,
  logger,
  type Route,
  type RouteHandlerContext,
  type RouteHandlerResult,
} from "@elizaos/core";
import {
  buildElizaCodeCerebrasSpec,
  ELIZA_CLOUD_DEFAULT_BASE_URL,
  resolveElizaCodeBin,
} from "../lib/eliza-code-spec";
import {
  buildClaudeCliSpec,
  buildCodexCliSpec,
  type PtyVendorCliKind,
  resolveClaudeCliBin,
  resolveCodexCliBin,
} from "../lib/vendor-cli-spec";
import type { PtyService } from "../services/pty-service";
import type { PtySpawnSpec } from "../services/pty-types";

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

function timingSafeTokenMatches(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}

function header(ctx: RouteHandlerContext, name: string): string | undefined {
  return str(
    ctx.headers[name] ??
      ctx.headers[name.toLowerCase()] ??
      ctx.headers[name.toUpperCase()],
  );
}

function query(ctx: RouteHandlerContext, name: string): string | undefined {
  const value = ctx.query[name];
  return str(Array.isArray(value) ? value[0] : value);
}

function bodyToken(body: Record<string, unknown>): string | undefined {
  return str(body.terminalToken) ?? str(body.ptyToken);
}

function splitCsv(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function allowedBaseUrls(runtime: IAgentRuntime): Set<string> {
  const configured = [
    ...splitCsv(getStr(runtime, "PTY_ALLOWED_BASE_URLS")),
    ...splitCsv(getStr(runtime, "PTY_ELIZA_CLOUD_BASE_URL_ALLOWLIST")),
  ];
  return new Set(
    [ELIZA_CLOUD_DEFAULT_BASE_URL, ...configured].map((url) =>
      normalizeBaseUrl(url),
    ),
  );
}

function resolveAllowedBaseUrl(
  runtime: IAgentRuntime,
  requested: string | undefined,
): string | undefined {
  if (!requested) return undefined;
  const normalized = normalizeBaseUrl(requested);
  if (!allowedBaseUrls(runtime).has(normalized)) {
    throw new Error(
      `Unsupported PTY baseUrl "${requested}". Configure PTY_ALLOWED_BASE_URLS to allow it explicitly.`,
    );
  }
  return normalized;
}

function providedTerminalToken(
  ctx: RouteHandlerContext,
  body: Record<string, unknown> = {},
): string | undefined {
  return (
    header(ctx, "x-eliza-terminal-token") ??
    header(ctx, "x-pty-terminal-token") ??
    bodyToken(body) ??
    query(ctx, "terminalToken") ??
    query(ctx, "ptyToken")
  );
}

function ptyAccessRejection(
  ctx: RouteHandlerContext,
  body: Record<string, unknown> = {},
): RouteHandlerResult | null {
  const expected =
    getStr(ctx.runtime, "ELIZA_TERMINAL_RUN_TOKEN") ??
    getStr(ctx.runtime, "PTY_TERMINAL_RUN_TOKEN");

  // Compatibility mode: trusted in-process callers keep working in local
  // builds unless the operator explicitly configures a terminal step-up token.
  if (!expected) {
    if (ctx.inProcess || ctx.isTrustedLocal) return null;
    return json(403, {
      error:
        "Interactive PTY routes require a terminal token (ELIZA_TERMINAL_RUN_TOKEN) for HTTP access.",
    });
  }

  if (ctx.isTrustedLocal) return null;

  const provided = providedTerminalToken(ctx, body);
  if (!provided) {
    return json(401, {
      error:
        "Missing terminal token. Provide X-Eliza-Terminal-Token or terminalToken.",
    });
  }
  if (!timingSafeTokenMatches(expected, provided)) {
    return json(401, { error: "Invalid terminal token." });
  }
  return null;
}

/**
 * Interactive spawning is on unless explicitly disabled or on a store build
 * (which forbids running child processes / dynamic code).
 */
function interactiveEnabled(runtime: IAgentRuntime): boolean {
  const variant = (getStr(runtime, "ELIZA_BUILD_VARIANT") ?? "").toLowerCase();
  if (variant === "store") return false;
  const flag = getStr(runtime, "PTY_INTERACTIVE_ENABLED")?.trim().toLowerCase();
  if (flag !== undefined && flag !== "") {
    // An explicit setting only ENABLES on a recognized truthy value — a
    // near-miss disable ("off", "FALSE", "no", a typo) must not silently
    // leave spawning on when the operator believes it is off.
    return flag === "true" || flag === "1" || flag === "on" || flag === "yes";
  }
  return true;
}

/**
 * The experimental vendor-CLI tier (#10832 Phase 2): the real interactive
 * Claude Code / Codex CLIs on the user's own subscription. Inherently
 * TOS-unsafe, so it is a SEPARATE gate from PTY_INTERACTIVE_ENABLED and
 * defaults OFF — only the exact truthy allowlist enables it, and store builds
 * never do.
 */
function vendorCliEnabled(runtime: IAgentRuntime): boolean {
  const variant = (getStr(runtime, "ELIZA_BUILD_VARIANT") ?? "").toLowerCase();
  if (variant === "store") return false;
  const flag = getStr(runtime, "PTY_VENDOR_CLI_ENABLED")?.trim().toLowerCase();
  return flag === "true" || flag === "1" || flag === "on" || flag === "yes";
}

/**
 * The Eliza Cloud API key eliza-code will authenticate with. Do not fall back
 * to the agent's primary OPENAI_API_KEY; terminal users can inspect their env.
 */
function resolveCloudApiKey(
  runtime: IAgentRuntime,
  bodyKey?: string,
): string | undefined {
  return bodyKey ?? getStr(runtime, "PTY_ELIZA_CLOUD_API_KEY");
}

function defaultCwd(runtime: IAgentRuntime): string {
  return getStr(runtime, "PTY_ALLOWED_DIRECTORY") ?? process.cwd();
}

// --- handlers ------------------------------------------------------------

/**
 * Builds the eliza-code spawn spec from a validated request. `apiKey` is
 * pre-resolved by the route so the missing-key rejection carries the
 * config-specific guidance.
 */
function elizaCodeSpecFromRequest(
  runtime: IAgentRuntime,
  body: Record<string, unknown>,
  cwd: string,
  apiKey: string,
): PtySpawnSpec {
  return buildElizaCodeCerebrasSpec({
    cwd,
    apiKey,
    binPath: resolveElizaCodeBin(),
    tier: str(body.tier) === "smart" ? "smart" : "fast",
    baseUrl: resolveAllowedBaseUrl(runtime, str(body.baseUrl)),
    // Deployment knob (like PTY_ELIZA_CLOUD_API_KEY): pin the tier models
    // without a client change, e.g. while the deployed cloud's model
    // registry lags the repo's DEFAULT_CEREBRAS_TEXT_MODEL.
    fastModel:
      str(body.fastModel) ?? getStr(runtime, "PTY_ELIZA_CLOUD_FAST_MODEL"),
    smartModel:
      str(body.smartModel) ?? getStr(runtime, "PTY_ELIZA_CLOUD_SMART_MODEL"),
  });
}

/**
 * Builds a vendor-CLI spawn spec (gate already checked). Credentials are the
 * user's own subscription handles, passed through opaquely — the claude token
 * via plugin-anthropic-proxy's `CLAUDE_CODE_OAUTH_TOKEN` env path, the codex
 * auth dir via the `CODEX_HOME` convention; with neither configured, each CLI
 * reads its own credential file (`~/.claude/.credentials.json` /
 * `~/.codex/auth.json`) through the inherited HOME.
 */
function vendorCliSpecFromRequest(
  runtime: IAgentRuntime,
  kind: PtyVendorCliKind,
  cwd: string,
): PtySpawnSpec {
  if (kind === "claude") {
    return buildClaudeCliSpec({
      cwd,
      binPath: resolveClaudeCliBin(),
      oauthToken: getStr(runtime, "CLAUDE_CODE_OAUTH_TOKEN"),
    });
  }
  return buildCodexCliSpec({
    cwd,
    binPath: resolveCodexCliBin(),
    codexHome: getStr(runtime, "CODEX_HOME"),
  });
}

/**
 * POST /api/pty/sessions — spawn an interactive session. `kind: "eliza-code"`
 * (real slash-command CLI on Eliza Cloud/cerebras) is the default; the
 * experimental `kind: "claude" | "codex"` vendor tier additionally requires
 * PTY_VENDOR_CLI_ENABLED. Never logs the request body (it may carry an API
 * key).
 */
async function spawnHandler(
  ctx: RouteHandlerContext,
): Promise<RouteHandlerResult> {
  const { runtime } = ctx;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const rejection = ptyAccessRejection(ctx, body);
  if (rejection) return rejection;

  if (!interactiveEnabled(runtime)) {
    return json(403, {
      error:
        "Interactive PTY sessions are disabled (PTY_INTERACTIVE_ENABLED=false or store build).",
    });
  }
  const svc = getService(ctx);
  if (!svc) return json(503, { error: "PTY_SERVICE is not available." });

  const kind = str(body.kind) ?? "eliza-code";
  if (kind !== "eliza-code" && kind !== "claude" && kind !== "codex") {
    return json(400, {
      error: `Unsupported session kind "${kind}". Supported kinds: "eliza-code", "claude", "codex".`,
    });
  }

  if (kind !== "eliza-code" && !vendorCliEnabled(runtime)) {
    return json(403, {
      error:
        `Interactive "${kind}" CLI sessions are an experimental tier that is off by default ` +
        "(runs the real vendor CLI on your own subscription). Set PTY_VENDOR_CLI_ENABLED=true to enable it.",
    });
  }

  const cwd = str(body.cwd) ?? defaultCwd(runtime);

  try {
    let spec: PtySpawnSpec;
    if (kind === "eliza-code") {
      const apiKey = resolveCloudApiKey(runtime, str(body.apiKey));
      if (!apiKey) {
        return json(400, {
          error:
            "No dedicated Eliza Cloud API key available. Pass { apiKey } or configure PTY_ELIZA_CLOUD_API_KEY.",
        });
      }
      spec = elizaCodeSpecFromRequest(runtime, body, cwd, apiKey);
    } else {
      spec = vendorCliSpecFromRequest(runtime, kind, cwd);
    }
    spec.ownerClientId = header(ctx, "x-elizaos-client-id");
    const cols = num(body.cols);
    const rows = num(body.rows);
    if (cols) spec.cols = cols;
    if (rows) spec.rows = rows;

    const session = await svc.startSession(spec);
    logger.info(
      `[plugin-pty] spawned interactive session ${session.sessionId} kind=${kind} label=${spec.label} cwd=${cwd}`,
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
  const rejection = ptyAccessRejection(ctx);
  if (rejection) return rejection;

  const svc = getService(ctx);
  if (!svc) return json(503, { error: "PTY_SERVICE is not available." });
  return json(200, { sessions: svc.listSessions() });
}

/** GET /api/pty/sessions/:id/buffered-output — initial scrollback for late subscribers. */
async function bufferedOutputHandler(
  ctx: RouteHandlerContext,
): Promise<RouteHandlerResult> {
  const rejection = ptyAccessRejection(ctx);
  if (rejection) return rejection;

  const svc = getService(ctx);
  if (!svc) return json(503, { error: "PTY_SERVICE is not available." });
  const id = ctx.params?.id;
  if (!id) return json(400, { error: "Missing session id." });
  const output = svc.getBufferedOutput(id);
  if (output === undefined)
    return json(404, { error: "PTY session not found." });
  return json(200, { output });
}

/** DELETE /api/pty/sessions/:id — kill a session. */
async function stopHandler(
  ctx: RouteHandlerContext,
): Promise<RouteHandlerResult> {
  const rejection = ptyAccessRejection(ctx);
  if (rejection) return rejection;

  const svc = getService(ctx);
  if (!svc) return json(503, { error: "PTY_SERVICE is not available." });
  const id = ctx.params?.id;
  if (!id) return json(400, { error: "Missing session id." });
  await svc.stopSession(id);
  return json(200, { ok: true });
}

/**
 * Sensitive developer terminal routes. Generic route authentication is not
 * enough: HTTP callers must pass the terminal step-up token, while in-process
 * local calls remain compatible only when no token is configured. `rawPath`
 * keeps the `/api/pty/*` URLs stable for the cockpit client instead of
 * prefixing them with the plugin name.
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
    type: "GET",
    path: "/api/pty/sessions/:id/buffered-output",
    rawPath: true,
    name: "pty-buffered-output",
    routeHandler: bufferedOutputHandler,
  },
  {
    type: "DELETE",
    path: "/api/pty/sessions/:id",
    rawPath: true,
    name: "pty-stop-session",
    routeHandler: stopHandler,
  },
];
