/**
 * GitHub credential routes — power the "GitHub" connection card in Settings →
 * Coding Agents and surface the same token to the orchestrator's
 * sub-agent spawn env.
 *
 * Exposes:
 *   GET    /api/github/token   — `{ connected, deviceFlowAvailable, username?,
 *                                 scopes?, savedAt? }`. Token never returned.
 *   POST   /api/github/token   — body `{ token }`. Validates by calling
 *                                 GitHub's `/user` endpoint, then persists
 *                                 the credential record.
 *   DELETE /api/github/token   — clears the saved credential and returns
 *                                 `{ connected: false }`.
 *   POST   /api/github/device-login/start
 *                              — begins a GitHub OAuth device flow (#15796):
 *                                 returns `{ flowId, userCode, verificationUri,
 *                                 intervalSeconds, expiresInSeconds }`. Requires
 *                                 the GITHUB_OAUTH_CLIENT_ID setting; GitHub's
 *                                 device_code stays server-side.
 *   GET    /api/github/device-login/:flowId/status
 *                              — polls the flow: `{ status: "pending",
 *                                 retryAfterSeconds }` until the user approves
 *                                 on github.com, then validates + persists the
 *                                 token and returns `{ status: "complete",
 *                                 ...connection metadata }`.
 *
 * A validated token is persisted twice, deliberately: the on-disk credential
 * store (`github-credentials.ts`, feeds `gh`/`git` subprocess env at boot) and
 * the per-agent character secrets via `runtime.setSetting` + `updateAgent` —
 * the multi-tenant-safe path the orchestrator's
 * `runtime.getSetting("GITHUB_TOKEN")` resolution reads live, with no
 * process-env write (env is shared by every agent in the host; settings are
 * per-agent).
 *
 * `handleGitHubRoutes` is the pure dispatcher — no auth, no transitive
 * app-core deps. The runtime adapter (`createGitHubRouteHandler`) lives in
 * index.ts where it can import the heavier app-core auth surface without
 * polluting this module's import graph (and breaking tests that only need the
 * pure handler).
 */

import type http from "node:http";
import { logger } from "@elizaos/core";
import {
  buildCredentialsFromUserResponse,
  clearCredentials,
  type GitHubCredentialMetadata,
  type GitHubCredentials,
  loadMetadata,
  saveCredentials,
} from "../github-credentials.js";
import {
  DeviceFlowError,
  pollDeviceFlow,
  startDeviceFlow,
} from "./github-device-flow.js";

const GITHUB_USER_URL = "https://api.github.com/user";
const VALIDATION_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 8 * 1024;

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
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

/**
 * The slice of `IAgentRuntime` these routes consume. Structural on purpose:
 * the real runtime satisfies it with no cast, and tests can provide an honest
 * in-memory implementation instead of stubbing the whole runtime surface.
 */
export interface GitHubRouteRuntime {
  agentId: string;
  character: { secrets?: Record<string, string | boolean | number> };
  getSetting(key: string): string | boolean | number | null;
  setSetting(
    key: string,
    value: string | boolean | null,
    secret?: boolean,
  ): void;
  updateAgent(
    agentId: string,
    agent: { secrets?: Record<string, string | boolean | number> },
  ): Promise<boolean>;
}

export interface GitHubRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  /**
   * Per-agent settings surface. Reads GITHUB_OAUTH_CLIENT_ID for the device
   * flow and receives the validated token as a character secret so a running
   * agent picks it up without a restart or a process-env write.
   */
  runtime: GitHubRouteRuntime;
  /** Inject for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  json?: (status: number, body: unknown) => void;
}

interface TokenStatusResponse {
  connected: boolean;
  /** True when GITHUB_OAUTH_CLIENT_ID is configured so device sign-in can run. */
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

function deviceFlowClientId(runtime: GitHubRouteRuntime): string | null {
  const value = runtime.getSetting("GITHUB_OAUTH_CLIENT_ID");
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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
 * Persist a validated credential to both stores: the on-disk record (feeds
 * the boot-time `gh`/`git` env bridge) and the per-agent character secrets
 * (read live by `runtime.getSetting("GITHUB_TOKEN")` — the orchestrator's
 * resolution path — and persisted to the agent DB row via `updateAgent`).
 */
async function persistCredentials(
  runtime: GitHubRouteRuntime,
  credentials: GitHubCredentials,
): Promise<void> {
  await saveCredentials(credentials);
  runtime.setSetting("GITHUB_TOKEN", credentials.token, true);
  await runtime.updateAgent(runtime.agentId, {
    secrets: { ...(runtime.character.secrets ?? {}) },
  });
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
    metadataToStatus(metadata, deviceFlowClientId(ctx.runtime) !== null),
  );
  return true;
}

async function handlePostToken(ctx: GitHubRouteContext): Promise<boolean> {
  const body = await readJsonBody(ctx.req);
  const token = body && typeof body.token === "string" ? body.token.trim() : "";
  if (token.length === 0) {
    sendJson(ctx, 400, { error: "Missing `token` in request body." });
    return true;
  }

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
      `[github-routes] token validation failed (${status}): ${message}`,
    );
    sendJson(ctx, status, { error: message });
    return true;
  }

  const credentials = buildCredentialsFromUserResponse(
    token,
    validated.user,
    validated.scopes,
  );
  await persistCredentials(ctx.runtime, credentials);
  logger.info(
    `[github-routes] saved github token for @${validated.user.login} (scopes=${validated.scopes.join(",") || "(none)"})`,
  );
  sendJson(
    ctx,
    200,
    metadataToStatus(credentials, deviceFlowClientId(ctx.runtime) !== null),
  );
  return true;
}

async function handleDeleteToken(ctx: GitHubRouteContext): Promise<boolean> {
  await clearCredentials();
  // Also drop the per-agent secret so disconnect really disconnects the
  // running agent; env-provided tokens (developer shell export) are
  // deliberately untouched — explicit env always wins elsewhere too.
  const secrets = ctx.runtime.character.secrets;
  if (secrets && "GITHUB_TOKEN" in secrets) {
    delete secrets.GITHUB_TOKEN;
    await ctx.runtime.updateAgent(ctx.runtime.agentId, {
      secrets: { ...secrets },
    });
  }
  logger.info("[github-routes] cleared saved github token");
  sendJson(ctx, 200, {
    connected: false,
    deviceFlowAvailable: deviceFlowClientId(ctx.runtime) !== null,
  });
  return true;
}

async function handleDeviceLoginStart(
  ctx: GitHubRouteContext,
): Promise<boolean> {
  const clientId = deviceFlowClientId(ctx.runtime);
  if (!clientId) {
    // Designed unavailable state, not a transport error: device sign-in needs
    // owner setup (a GitHub OAuth app client id) before it can run at all.
    sendJson(ctx, 409, {
      error:
        "GitHub device sign-in needs owner setup: set GITHUB_OAUTH_CLIENT_ID to a GitHub OAuth app client ID with device flow enabled.",
      code: "client_id_missing",
    });
    return true;
  }
  const fetchImpl = ctx.fetch ?? fetch;
  let started: Awaited<ReturnType<typeof startDeviceFlow>>;
  try {
    started = await startDeviceFlow(clientId, { fetchImpl });
  } catch (err) {
    // error-policy:J1 boundary translation — DeviceFlowError carries the HTTP
    // status for the failure class (upstream faults are 502); anything else is
    // a real 500.
    const status = err instanceof DeviceFlowError ? err.httpStatus : 500;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[github-routes] device-login start failed (${status}): ${message}`,
    );
    sendJson(ctx, status, { error: message });
    return true;
  }
  logger.info(
    `[github-routes] device-login flow started (verify at ${started.verificationUri}, expires in ${started.expiresInSeconds}s)`,
  );
  sendJson(ctx, 200, started);
  return true;
}

async function handleDeviceLoginStatus(
  ctx: GitHubRouteContext,
  flowId: string,
): Promise<boolean> {
  const fetchImpl = ctx.fetch ?? fetch;
  let poll: Awaited<ReturnType<typeof pollDeviceFlow>>;
  try {
    poll = await pollDeviceFlow(flowId, { fetchImpl });
  } catch (err) {
    // error-policy:J1 boundary translation — terminal flow outcomes map to
    // the status DeviceFlowError carries (404 unknown, 403 declined, 410
    // expired, 502 upstream); the body keeps the machine-readable code so the
    // card can render each as a distinct designed error state.
    if (err instanceof DeviceFlowError) {
      logger.warn(
        `[github-routes] device-login flow ended (${err.code}): ${err.message}`,
      );
      sendJson(ctx, err.httpStatus, {
        status: "error",
        code: err.code,
        error: err.message,
      });
      return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[github-routes] device-login status failed: ${message}`);
    sendJson(ctx, 500, { status: "error", code: "internal", error: message });
    return true;
  }

  if (poll.status === "pending") {
    sendJson(ctx, 200, poll);
    return true;
  }

  // GitHub issued a token: validate it against /user exactly like the PAT
  // path (yielding username + effective scopes), then persist to both stores.
  let validated: Awaited<ReturnType<typeof validateToken>>;
  try {
    validated = await validateToken(poll.token, fetchImpl);
  } catch (err) {
    // error-policy:J1 boundary translation — the flow is already consumed, so
    // a validation failure ends it; a freshly-issued token failing /user is an
    // upstream fault, surfaced with the status TokenValidationError carries.
    const status = err instanceof TokenValidationError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[github-routes] device-login token validation failed (${status}): ${message}`,
    );
    sendJson(ctx, status, {
      status: "error",
      code: "validation_failed",
      error: message,
    });
    return true;
  }

  const credentials = buildCredentialsFromUserResponse(
    poll.token,
    validated.user,
    validated.scopes,
  );
  await persistCredentials(ctx.runtime, credentials);
  logger.info(
    `[github-routes] device-login connected @${validated.user.login} (scopes=${validated.scopes.join(",") || "(none)"})`,
  );
  sendJson(ctx, 200, {
    status: "complete",
    ...metadataToStatus(credentials, true),
  });
  return true;
}

const DEVICE_LOGIN_STATUS_RE =
  /^\/api\/github\/device-login\/([A-Za-z0-9_-]+)\/status$/;

/**
 * Dispatch entry point. Returns `true` when this module owned the request.
 * Caller is responsible for auth (mirrors `/api/workflow/*` in server.ts).
 */
export async function handleGitHubRoutes(
  ctx: GitHubRouteContext,
): Promise<boolean> {
  if (ctx.pathname === "/api/github/token") {
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
  if (ctx.pathname === "/api/github/device-login/start") {
    if (ctx.method !== "POST") {
      sendJson(ctx, 405, { error: "Method not allowed" });
      return true;
    }
    return handleDeviceLoginStart(ctx);
  }
  const statusMatch = DEVICE_LOGIN_STATUS_RE.exec(ctx.pathname);
  if (statusMatch) {
    if (ctx.method !== "GET") {
      sendJson(ctx, 405, { error: "Method not allowed" });
      return true;
    }
    return handleDeviceLoginStatus(ctx, statusMatch[1]);
  }
  return false;
}
