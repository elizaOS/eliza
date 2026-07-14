/**
 * Authenticated HTTP boundary for an agent's guided GitHub connection.
 * It validates credentials against GitHub, persists them through the encrypted
 * agent-scoped store, and exposes the complete device-flow lifecycle without
 * ever returning a token or device code to the browser.
 */

import { ElizaError, logger } from "@elizaos/core";
import {
  cancelDeviceFlow,
  DeviceFlowError,
  pollDeviceFlow,
  startDeviceFlow,
} from "../device-flow.js";
import {
  buildCredentialsFromUserResponse,
  type GitHubCredentialMetadata,
  type GitHubCredentialStore,
} from "../github-credentials.js";

const GITHUB_USER_URL = "https://api.github.com/user";
const VALIDATION_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 8 * 1024;

interface GitHubUserResponse {
  login: string;
}

export interface GitHubRouteContext {
  req: GitHubRouteRequest;
  /** Raw-node response for direct HTTP dispatch; adapters may use `json`. */
  res?: GitHubRouteResponse;
  method: string;
  pathname: string;
  /** Identity of the agent runtime serving this request. */
  agentKey: string;
  /** Durable encrypted store shared by the host, internally keyed by agent. */
  credentialStore: GitHubCredentialStore;
  /** Inject for protocol tests; production uses global fetch. */
  fetch?: typeof fetch;
  json?: (status: number, body: unknown) => void;
  getOauthClientId?: () => string | undefined;
  /** Apply a committed credential only to this runtime and refresh clients. */
  applyRuntimeToken?: (token: string) => Promise<void> | void;
  /** Remove this runtime's credential and refresh clients. */
  clearRuntimeToken?: () => Promise<void> | void;
}

export interface GitHubRouteRequest {
  body?: unknown;
  [Symbol.asyncIterator]?(): AsyncIterator<unknown>;
}

export interface GitHubRouteResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

export interface TokenStatusResponse {
  connected: boolean;
  deviceFlowAvailable: boolean;
  username?: string;
  scopes?: string[];
  savedAt?: number;
}

interface GitHubValidationResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

class GitHubRouteError extends ElizaError {
  constructor(
    message: string,
    readonly status: number,
    options: {
      code: string;
      retryable?: boolean;
      retryAfter?: number;
      cause?: unknown;
      context?: Record<string, unknown>;
    },
  ) {
    super(message, {
      code: options.code,
      cause: options.cause,
      context: options.context,
      severity: options.retryable ? "ephemeral" : "fatal",
    });
    this.retryable = options.retryable === true;
    this.retryAfter = options.retryAfter;
  }

  readonly retryable: boolean;
  readonly retryAfter?: number;
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
  if (!ctx.res) {
    throw new ElizaError("GitHub route has no response transport", {
      code: "GITHUB_ROUTE_RESPONSE_MISSING",
      severity: "fatal",
    });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAsyncIterableRequest(
  req: GitHubRouteRequest,
): req is GitHubRouteRequest & AsyncIterable<unknown> {
  return typeof req[Symbol.asyncIterator] === "function";
}

async function readJsonBody(
  req: GitHubRouteRequest,
): Promise<Record<string, unknown> | null> {
  const preParsed = req.body;
  if (isRecord(preParsed)) return preParsed;

  if (!isAsyncIterableRequest(req)) return null;

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string" || chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : null;
    if (!buffer) return null;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    // error-policy:J3 untrusted-input sanitizing — invalid JSON becomes the
    // explicit invalid-body signal consumed by the 400 boundary below.
    return null;
  }
}

function requiredString(
  body: Record<string, unknown> | null,
  field: string,
): string {
  const value = body?.[field];
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new GitHubRouteError(`Missing \`${field}\` in request body.`, 400, {
      code: "GITHUB_INVALID_REQUEST",
    });
  }
  return normalized;
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
  } catch (cause) {
    // error-policy:J2 context-adding rethrow — reachability and timeout are
    // retryable upstream failures, distinct from a rejected credential.
    throw new GitHubRouteError(
      "Could not reach GitHub to validate the credential. Try again.",
      502,
      {
        code: "GITHUB_UPSTREAM_UNAVAILABLE",
        retryable: true,
        cause,
      },
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new GitHubRouteError(
      response.status === 401
        ? "GitHub rejected the credential. Check it and try again."
        : "GitHub rejected the credential's permissions. Grant repo and read:user access.",
      400,
      { code: "GITHUB_CREDENTIAL_REJECTED" },
    );
  }
  if (!response.ok) {
    throw new GitHubRouteError(
      `GitHub returned HTTP ${response.status} while validating the credential.`,
      502,
      { code: "GITHUB_UPSTREAM_UNAVAILABLE", retryable: true },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    // error-policy:J2 context-adding rethrow — a successful response with an
    // unreadable payload is an observable upstream protocol failure.
    throw new GitHubRouteError(
      "GitHub returned an unreadable user response.",
      502,
      {
        code: "GITHUB_UPSTREAM_INVALID_RESPONSE",
        retryable: true,
        cause,
      },
    );
  }
  const login = isRecord(body) ? body.login : undefined;
  if (typeof login !== "string" || !login.trim()) {
    throw new GitHubRouteError(
      "GitHub's user response did not identify an account.",
      502,
      {
        code: "GITHUB_UPSTREAM_INVALID_RESPONSE",
        retryable: true,
      },
    );
  }

  const scopesHeader = response.headers.get("x-oauth-scopes");
  const scopes = scopesHeader
    ? scopesHeader
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean)
    : [];
  return { user: { login: login.trim() }, scopes };
}

async function persistValidatedToken(
  ctx: GitHubRouteContext,
  token: string,
  source: "pat" | "device-flow",
): Promise<TokenStatusResponse> {
  const validated = await validateToken(token, ctx.fetch ?? fetch);
  const credentials = buildCredentialsFromUserResponse(
    token,
    validated.user,
    validated.scopes,
  );
  await ctx.credentialStore.save(ctx.agentKey, credentials);
  await ctx.applyRuntimeToken?.(token);
  logger.info(
    {
      src: "plugin:github:routes",
      agentId: ctx.agentKey,
      username: validated.user.login,
      source,
      scopeCount: validated.scopes.length,
    },
    "GitHub credential committed to the agent vault",
  );
  return metadataToStatus(credentials, resolveOauthClientId(ctx).length > 0);
}

async function handleGetToken(ctx: GitHubRouteContext): Promise<void> {
  const metadata = await ctx.credentialStore.loadMetadata(ctx.agentKey);
  sendJson(
    ctx,
    200,
    metadataToStatus(metadata, resolveOauthClientId(ctx).length > 0),
  );
}

async function handlePostToken(ctx: GitHubRouteContext): Promise<void> {
  const token = requiredString(await readJsonBody(ctx.req), "token");
  sendJson(ctx, 200, await persistValidatedToken(ctx, token, "pat"));
}

async function handleDeleteToken(ctx: GitHubRouteContext): Promise<void> {
  await ctx.credentialStore.clear(ctx.agentKey);
  await ctx.clearRuntimeToken?.();
  logger.info(
    { src: "plugin:github:routes", agentId: ctx.agentKey },
    "GitHub credential removed from the agent vault",
  );
  sendJson(ctx, 200, {
    connected: false,
    deviceFlowAvailable: resolveOauthClientId(ctx).length > 0,
  });
}

function requireDeviceClient(ctx: GitHubRouteContext): string {
  const clientId = resolveOauthClientId(ctx);
  if (!clientId) {
    throw new GitHubRouteError(
      "GitHub sign-in is unavailable until the owner configures a device-flow-enabled OAuth app. You can still paste a personal access token.",
      409,
      { code: "GITHUB_DEVICE_OWNER_SETUP_REQUIRED" },
    );
  }
  return clientId;
}

async function startOwnedDeviceFlow(
  ctx: GitHubRouteContext,
  mode: "connect" | "reconnect",
): Promise<void> {
  const metadata = await ctx.credentialStore.loadMetadata(ctx.agentKey);
  if (mode === "connect" && metadata) {
    throw new GitHubRouteError(
      "GitHub is already connected. Use reconnect to replace the credential without dropping the current connection first.",
      409,
      { code: "GITHUB_ALREADY_CONNECTED" },
    );
  }
  if (mode === "reconnect" && !metadata) {
    throw new GitHubRouteError(
      "GitHub is not connected yet. Start a new connection instead.",
      409,
      { code: "GITHUB_NOT_CONNECTED" },
    );
  }

  const started = await startDeviceFlow({
    clientId: requireDeviceClient(ctx),
    agentKey: ctx.agentKey,
    deps: ctx.fetch ? { fetchImpl: ctx.fetch } : undefined,
  });
  logger.info(
    {
      src: "plugin:github:routes",
      agentId: ctx.agentKey,
      mode,
      expiresInSeconds: started.expiresInSeconds,
    },
    "GitHub device sign-in started",
  );
  sendJson(ctx, 200, { status: "started", mode, ...started });
}

async function handleDevicePoll(ctx: GitHubRouteContext): Promise<void> {
  const flowId = requiredString(await readJsonBody(ctx.req), "flowId");
  const result = await pollDeviceFlow({
    flowId,
    agentKey: ctx.agentKey,
    deps: ctx.fetch ? { fetchImpl: ctx.fetch } : undefined,
  });
  if (result.status !== "complete") {
    sendJson(ctx, 200, result);
    return;
  }
  const status = await persistValidatedToken(ctx, result.token, "device-flow");
  sendJson(ctx, 200, { status: "complete", ...status });
}

async function handleDeviceCancel(ctx: GitHubRouteContext): Promise<void> {
  const flowId = requiredString(await readJsonBody(ctx.req), "flowId");
  const result = cancelDeviceFlow({ flowId, agentKey: ctx.agentKey });
  logger.info(
    { src: "plugin:github:routes", agentId: ctx.agentKey },
    "GitHub device sign-in cancelled",
  );
  sendJson(ctx, 200, result);
}

function routeError(error: unknown): GitHubRouteError {
  if (error instanceof GitHubRouteError) return error;
  if (error instanceof DeviceFlowError) {
    const code =
      error.code === "unknown_flow"
        ? "GITHUB_DEVICE_FLOW_NOT_FOUND"
        : error.code === "owner_setup"
          ? "GITHUB_DEVICE_OWNER_SETUP_REQUIRED"
          : error.code === "superseded"
            ? "GITHUB_DEVICE_FLOW_SUPERSEDED"
            : "GITHUB_UPSTREAM_UNAVAILABLE";
    return new GitHubRouteError(error.message, error.status, {
      code,
      retryable: error.code === "upstream",
      cause: error,
    });
  }
  if (error instanceof ElizaError) {
    return new GitHubRouteError(error.message, 500, {
      code: error.code,
      cause: error,
      context: error.context,
    });
  }
  return new GitHubRouteError("GitHub connection failed.", 500, {
    code: "GITHUB_CONNECTION_FAILED",
    cause: error,
  });
}

async function dispatchOwnedRoute(ctx: GitHubRouteContext): Promise<void> {
  if (ctx.method !== "POST" && ctx.pathname.startsWith("/api/github/device/")) {
    throw new GitHubRouteError("Method not allowed.", 405, {
      code: "GITHUB_METHOD_NOT_ALLOWED",
    });
  }
  switch (ctx.pathname) {
    case "/api/github/device/start":
      return startOwnedDeviceFlow(ctx, "connect");
    case "/api/github/device/reconnect":
      return startOwnedDeviceFlow(ctx, "reconnect");
    case "/api/github/device/poll":
      return handleDevicePoll(ctx);
    case "/api/github/device/cancel":
      return handleDeviceCancel(ctx);
    case "/api/github/token":
      if (ctx.method === "GET") return handleGetToken(ctx);
      if (ctx.method === "POST") return handlePostToken(ctx);
      if (ctx.method === "DELETE") return handleDeleteToken(ctx);
      throw new GitHubRouteError("Method not allowed.", 405, {
        code: "GITHUB_METHOD_NOT_ALLOWED",
      });
  }
}

const OWNED_PATHS = new Set([
  "/api/github/token",
  "/api/github/device/start",
  "/api/github/device/reconnect",
  "/api/github/device/poll",
  "/api/github/device/cancel",
]);

/** Dispatch a guided GitHub route after the host's authentication gate. */
export async function handleGitHubRoutes(
  ctx: GitHubRouteContext,
): Promise<boolean> {
  if (!OWNED_PATHS.has(ctx.pathname)) return false;
  try {
    await dispatchOwnedRoute(ctx);
  } catch (error) {
    // error-policy:J1 boundary translation — every internal/protocol/storage
    // failure becomes one typed HTTP error; no failed path renders healthy.
    const translated = routeError(error);
    logger.warn(
      {
        src: "plugin:github:routes",
        agentId: ctx.agentKey,
        code: translated.code,
        status: translated.status,
        err: translated.message,
      },
      "GitHub connection request failed",
    );
    sendJson(ctx, translated.status, {
      error: translated.message,
      code: translated.code,
      retryable: translated.retryable,
      ...(translated.retryAfter !== undefined
        ? { retryAfter: translated.retryAfter }
        : {}),
    });
  }
  return true;
}
