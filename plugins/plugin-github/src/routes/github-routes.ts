/**
 * GitHub credential routes — power the "GitHub" connection card in Settings →
 * Coding Agents (the guided credential setup step, #15796) and surface the
 * same token to the orchestrator's sub-agent spawn env.
 *
 * Exposes:
 *   GET    /api/github/token   — `{ connected: bool, deviceFlowAvailable: bool,
 *                                 username?, scopes?, savedAt? }`. Token itself
 *                                 is never returned.
 *   POST   /api/github/token   — body `{ token }`. Validates by calling
 *                                 GitHub's `/user` endpoint, then persists
 *                                 the credential record to disk and applies it
 *                                 to the live runtime's per-agent settings.
 *   DELETE /api/github/token   — clears the saved credential (disk + live
 *                                 runtime) and returns `{ connected: false }`.
 *   POST   /api/github/device/start — starts a GitHub OAuth device flow
 *                                 (requires the `GITHUB_OAUTH_CLIENT_ID`
 *                                 setting). Returns the user code + opaque
 *                                 flow id; the device code stays server-side.
 *   POST   /api/github/device/poll  — body `{ flowId }`. Polls the flow once:
 *                                 `pending` / `denied` / `expired`, or on
 *                                 approval validates + persists the token the
 *                                 same way the PAT route does and returns the
 *                                 connected status.
 *
 * `handleGitHubRoutes` is the pure dispatcher — no auth, no runtime deps
 * beyond the injectable `GitHubRouteContext` callbacks. The runtime adapter
 * (`createGitHubRouteHandler`) lives in index.ts where it can import the
 * heavier app-core auth surface without polluting this module's import graph
 * (and breaking tests that only need the pure handler).
 */

import type http from "node:http";
import { logger } from "@elizaos/core";
import {
  DeviceFlowError,
  pollDeviceFlow,
  startDeviceFlow,
} from "../device-flow.js";
import {
  buildCredentialsFromUserResponse,
  clearCredentials,
  type GitHubCredentialMetadata,
  loadMetadata,
  saveCredentials,
} from "../github-credentials.js";

const GITHUB_USER_URL = "https://api.github.com/user";
const VALIDATION_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 8 * 1024;

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  // The canonical runtime-plugin dispatcher pre-reads `application/json`
  // bodies and attaches the parsed object as `req.body` (the raw stream is
  // already consumed by then). Prefer it when present; fall back to reading
  // the stream for dispatch paths that leave the body untouched.
  const preParsed = (req as http.IncomingMessage & { body?: unknown }).body;
  if (preParsed && typeof preParsed === "object" && !Array.isArray(preParsed)) {
    return preParsed as Record<string, unknown>;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // error-policy:J3 sanitizing boundary — an unparseable body is treated as
    // "no valid body" (null); the caller rejects the missing field with a 400.
    return null;
  }
}
interface GitHubUserResponse {
  login: string;
}

export interface GitHubRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  /** Inject for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  json?: (status: number, body: unknown) => void;
  /**
   * Identity of the agent runtime serving this request. Device flows are
   * bound to it so one agent can never poll (and receive the token of) a
   * flow another agent started on the same host.
   */
  agentKey?: string;
  /**
   * Resolve the `GITHUB_OAUTH_CLIENT_ID` setting for this agent
   * (`runtime.getSetting` in production). Absent/empty means the owner has
   * not registered a device-flow-enabled OAuth app — the PAT path still works.
   */
  getOauthClientId?: () => string | undefined;
  /**
   * Apply a freshly validated token to the live runtime's per-agent settings
   * (`runtime.setSetting("GITHUB_TOKEN", token, true)` in production) so
   * GitHub capabilities work immediately, without a restart and without
   * writing process env (which would leak to every agent on the host).
   */
  applyRuntimeToken?: (token: string) => void;
  /** Remove the token from the live runtime's per-agent settings. */
  clearRuntimeToken?: () => void;
}

interface TokenStatusResponse {
  connected: boolean;
  /** True when `GITHUB_OAUTH_CLIENT_ID` is configured for this agent. */
  deviceFlowAvailable: boolean;
  username?: string;
  scopes?: string[];
  savedAt?: number;
}

interface GitHubValidationResponse {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
}

function sendJson(
  ctx: GitHubRouteContext,
  status: number,
  body: unknown,
): void {
  if (ctx.json) {
    ctx.json(status, body);
    return;
  }
  ctx.res.statusCode = status;
  ctx.res.setHeader("Content-Type", "application/json; charset=utf-8");
  ctx.res.end(JSON.stringify(body));
}

function resolveOauthClientId(ctx: GitHubRouteContext): string {
  const clientId = ctx.getOauthClientId?.();
  return typeof clientId === "string" ? clientId.trim() : "";
}

function metadataToStatus(
  metadata: GitHubCredentialMetadata | null,
  deviceFlowAvailable: boolean,
): TokenStatusResponse {
  if (!metadata) return { connected: false, deviceFlowAvailable };
  return {
    connected: true,
    deviceFlowAvailable,
    username: metadata.username,
    scopes: metadata.scopes,
    savedAt: metadata.savedAt,
  };
}

/**
 * Error thrown by {@link validateToken}, carrying the HTTP status the route
 * should return. `status: 400` means the submitted token is bad (the caller's
 * fault); `status: 502` means GitHub itself was unreachable or misbehaved (an
 * upstream fault) — the route must not collapse the two into one code.
 */
class TokenValidationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TokenValidationError";
  }
}

async function validateToken(
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ user: GitHubUserResponse; scopes: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  let response: GitHubValidationResponse;
  try {
    response = (await fetchImpl(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "eliza-github-connection",
      },
      signal: controller.signal,
    })) as GitHubValidationResponse;
  } catch (err) {
    // error-policy:J2 context-adding rethrow — a network failure or the
    // validation timeout aborting the request is an upstream-reachability
    // problem, not a bad token, so it rethrows typed as 502 with the cause.
    throw new TokenValidationError(
      "Could not reach GitHub to validate the token. Try again.",
      502,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) {
    throw new TokenValidationError(
      "Token rejected by GitHub: bad credentials.",
      400,
    );
  }
  if (response.status === 403) {
    throw new TokenValidationError(
      "Token rejected by GitHub: forbidden. Check the token has at least `read:user` scope.",
      400,
    );
  }
  if (!response.ok) {
    // A non-401/403 status is GitHub failing, not the token being invalid.
    throw new TokenValidationError(
      `GitHub returned ${response.status} validating the token. Try again or generate a new token.`,
      502,
    );
  }

  let body: GitHubUserResponse;
  try {
    body = (await response.json()) as GitHubUserResponse;
  } catch (err) {
    // error-policy:J2 context-adding rethrow — a 2xx with an unparseable body is
    // GitHub misbehaving, the same upstream fault class as the missing-login
    // check below, so it surfaces as 502, not a token/client error.
    throw new TokenValidationError(
      "GitHub /user response was not valid JSON.",
      502,
      { cause: err },
    );
  }
  if (typeof body?.login !== "string" || body.login.length === 0) {
    throw new TokenValidationError(
      "GitHub /user response was missing the login field.",
      502,
    );
  }

  const scopesHeader = response.headers.get("x-oauth-scopes") ?? "";
  const scopes = scopesHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return { user: body, scopes };
}

async function handleGetToken(ctx: GitHubRouteContext): Promise<boolean> {
  const metadata = await loadMetadata();
  sendJson(
    ctx,
    200,
    metadataToStatus(metadata, resolveOauthClientId(ctx).length > 0),
  );
  return true;
}

/**
 * Shared tail of both credential intake paths (PAT paste and device-flow
 * grant): validate against GitHub `/user`, persist the record, and apply the
 * token to the live runtime's per-agent settings. Sends the error response
 * itself and returns `null` when validation fails.
 */
async function validatePersistAndApply(
  ctx: GitHubRouteContext,
  token: string,
  source: "pat" | "device-flow",
): Promise<TokenStatusResponse | null> {
  const fetchImpl = ctx.fetch ?? fetch;
  let validated: Awaited<ReturnType<typeof validateToken>>;
  try {
    validated = await validateToken(token, fetchImpl);
  } catch (err) {
    // error-policy:J1 boundary translation — a bad token surfaces as 400
    // (client input), an unreachable/misbehaving GitHub as 502 (upstream);
    // TokenValidationError carries which. Unexpected error types default to
    // 500 rather than masquerading as a client error.
    const status = err instanceof TokenValidationError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[github-routes] token validation failed (${status}, source=${source}): ${message}`,
    );
    sendJson(ctx, status, { error: message });
    return null;
  }

  const credentials = buildCredentialsFromUserResponse(
    token,
    validated.user,
    validated.scopes,
  );
  await saveCredentials(credentials);
  ctx.applyRuntimeToken?.(token);
  logger.info(
    `[github-routes] saved github token for @${validated.user.login} (source=${source}, scopes=${validated.scopes.join(",") || "(none)"})`,
  );
  return metadataToStatus(credentials, resolveOauthClientId(ctx).length > 0);
}

async function handlePostToken(ctx: GitHubRouteContext): Promise<boolean> {
  const body = await readJsonBody(ctx.req);
  const token = body && typeof body.token === "string" ? body.token.trim() : "";
  if (token.length === 0) {
    sendJson(ctx, 400, { error: "Missing `token` in request body." });
    return true;
  }
  const status = await validatePersistAndApply(ctx, token, "pat");
  if (status) sendJson(ctx, 200, status);
  return true;
}

async function handleDeleteToken(ctx: GitHubRouteContext): Promise<boolean> {
  await clearCredentials();
  ctx.clearRuntimeToken?.();
  logger.info("[github-routes] cleared saved github token");
  sendJson(ctx, 200, {
    connected: false,
    deviceFlowAvailable: resolveOauthClientId(ctx).length > 0,
  });
  return true;
}

async function handleDeviceStart(ctx: GitHubRouteContext): Promise<boolean> {
  const clientId = resolveOauthClientId(ctx);
  if (clientId.length === 0) {
    sendJson(ctx, 409, {
      error:
        "GitHub device sign-in needs owner setup: no GITHUB_OAUTH_CLIENT_ID setting " +
        "is configured (register a GitHub OAuth app with device flow enabled). " +
        "You can still connect by pasting a personal access token.",
    });
    return true;
  }
  try {
    const started = await startDeviceFlow({
      clientId,
      agentKey: ctx.agentKey ?? "",
      deps: ctx.fetch ? { fetchImpl: ctx.fetch } : undefined,
    });
    logger.info(
      `[github-routes] started github device sign-in (interval=${started.intervalSeconds}s, expires=${started.expiresInSeconds}s)`,
    );
    sendJson(ctx, 200, { status: "started", ...started });
  } catch (err) {
    const status = err instanceof DeviceFlowError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[github-routes] github device sign-in start failed (${status}): ${message}`,
    );
    sendJson(ctx, status, { error: message });
  }
  return true;
}

async function handleDevicePoll(ctx: GitHubRouteContext): Promise<boolean> {
  const body = await readJsonBody(ctx.req);
  const flowId =
    body && typeof body.flowId === "string" ? body.flowId.trim() : "";
  if (flowId.length === 0) {
    sendJson(ctx, 400, { error: "Missing `flowId` in request body." });
    return true;
  }
  let result: Awaited<ReturnType<typeof pollDeviceFlow>>;
  try {
    result = await pollDeviceFlow({
      flowId,
      agentKey: ctx.agentKey ?? "",
      deps: ctx.fetch ? { fetchImpl: ctx.fetch } : undefined,
    });
  } catch (err) {
    const status = err instanceof DeviceFlowError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[github-routes] github device sign-in poll failed (${status}): ${message}`,
    );
    sendJson(ctx, status, { error: message });
    return true;
  }
  if (result.status !== "complete") {
    // pending / denied / expired are protocol outcomes, not transport errors —
    // the polling client switches on `status`.
    if (result.status !== "pending") {
      logger.info(
        `[github-routes] github device sign-in ended without a grant (${result.status})`,
      );
    }
    sendJson(ctx, 200, result);
    return true;
  }
  const status = await validatePersistAndApply(
    ctx,
    result.token,
    "device-flow",
  );
  if (status) sendJson(ctx, 200, { status: "complete", ...status });
  return true;
}

/**
 * Dispatch entry point. Returns `true` when this module owned the request.
 * Caller is responsible for auth (mirrors `/api/workflow/*` in server.ts).
 */
export async function handleGitHubRoutes(
  ctx: GitHubRouteContext,
): Promise<boolean> {
  if (ctx.pathname === "/api/github/device/start") {
    if (ctx.method !== "POST") {
      sendJson(ctx, 405, { error: "Method not allowed" });
      return true;
    }
    return handleDeviceStart(ctx);
  }
  if (ctx.pathname === "/api/github/device/poll") {
    if (ctx.method !== "POST") {
      sendJson(ctx, 405, { error: "Method not allowed" });
      return true;
    }
    return handleDevicePoll(ctx);
  }
  if (ctx.pathname !== "/api/github/token") return false;
  switch (ctx.method) {
    case "GET":
      return handleGetToken(ctx);
    case "POST":
      return handlePostToken(ctx);
    case "DELETE":
      return handleDeleteToken(ctx);
    default:
      sendJson(ctx, 405, { error: "Method not allowed" });
      return true;
  }
}
