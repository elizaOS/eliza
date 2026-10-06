import { type IAgentRuntime, logger } from "@elizaos/core";
import type {
  Route,
  RouteHandlerContext,
  RouteHandlerResult,
} from "@elizaos/host/protocol";
import {
  DeviceFlowError,
  pollDeviceFlow,
  startDeviceFlow,
} from "./device-flow.js";
import {
  buildCredentialsFromUserResponse,
  clearCredentials,
  type GitHubCredentialMetadata,
  loadMetadata,
  saveCredentials,
} from "./github-credentials.js";

const GITHUB_USER_URL = "https://api.github.com/user";
const VALIDATION_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 8 * 1024;
type Context = Pick<RouteHandlerContext, "runtime" | "body" | "signal">;
interface GitHubUserResponse {
  login: string;
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

function resolveOauthClientId({ runtime }: Context): string {
  const value = runtime.getSetting("GITHUB_OAUTH_CLIENT_ID");
  return typeof value === "string" ? value.trim() : "";
}
function field(body: unknown, key: string): string {
  const value =
    body && typeof body === "object" && !Array.isArray(body)
      ? Reflect.get(body, key)
      : undefined;
  return typeof value === "string" ? value.trim() : "";
}
function failure(ctx: Context, error: unknown): RouteHandlerResult {
  ctx.signal.throwIfAborted();
  const status =
    error instanceof TokenValidationError || error instanceof DeviceFlowError
      ? error.status
      : 500;
  const message = error instanceof Error ? error.message : String(error);
  ctx.runtime.reportError("github.credentialRoute", error);
  return { status, body: { error: message } };
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
  signal: AbortSignal,
): Promise<{ user: GitHubUserResponse; scopes: string[] }> {
  signal = AbortSignal.any([
    signal,
    AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
  ]);
  let response: GitHubValidationResponse;
  try {
    response = (await fetch(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "eliza-github-connection",
      },
      signal,
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

async function persistToken(
  ctx: Context,
  token: string,
): Promise<TokenStatusResponse> {
  const validated = await validateToken(token, ctx.signal);
  ctx.signal.throwIfAborted();
  const credentials = buildCredentialsFromUserResponse(
    token,
    validated.user,
    validated.scopes,
  );
  await saveCredentials(credentials);
  ctx.runtime.setSetting("GITHUB_TOKEN", token, true);
  logger.info(
    { src: "github-routes", username: validated.user.login },
    "Saved GitHub credential",
  );
  return metadataToStatus(credentials, resolveOauthClientId(ctx).length > 0);
}
function route(
  type: "GET" | "POST" | "DELETE",
  path: string,
  handler: (ctx: Context) => Promise<RouteHandlerResult>,
): Route {
  return {
    type,
    path: `/api/github/${path}`,
    rawPath: true,
    maxBodyBytes: MAX_BODY_BYTES,
    routeHandler: async (ctx) => {
      ctx.signal.throwIfAborted();
      try {
        return await handler(ctx);
      } catch (error) {
        // error-policy:J1 Preserve caller cancellation and translate credential failures at the HTTP boundary.
        return failure(ctx, error);
      }
    },
  };
}
export const githubRoutes: Route[] = [
  route("GET", "token", async (ctx) => ({
    status: 200,
    body: metadataToStatus(
      await loadMetadata(),
      resolveOauthClientId(ctx).length > 0,
    ),
  })),
  route("POST", "token", async (ctx) => {
    const token = field(ctx.body, "token");
    if (!token)
      return {
        status: 400,
        body: { error: "Missing `token` in request body." },
      };
    return { status: 200, body: await persistToken(ctx, token) };
  }),
  route("DELETE", "token", async (ctx) => {
    await clearCredentials();
    ctx.runtime.setSetting("GITHUB_TOKEN", null, true);
    return {
      status: 200,
      body: {
        connected: false,
        deviceFlowAvailable: resolveOauthClientId(ctx).length > 0,
      },
    };
  }),
  route("POST", "device/start", async (ctx) => {
    const clientId = resolveOauthClientId(ctx);
    if (!clientId)
      return {
        status: 409,
        body: {
          error:
            "GitHub device sign-in needs owner setup: no GITHUB_OAUTH_CLIENT_ID setting " +
            "is configured (register a GitHub OAuth app with device flow enabled). " +
            "You can still connect by pasting a personal access token.",
        },
      };
    const started = await startDeviceFlow({
      clientId,
      agentKey: String(ctx.runtime.agentId),
      signal: ctx.signal,
    });
    return { status: 200, body: { status: "started", ...started } };
  }),
  route("POST", "device/poll", async (ctx) => {
    const flowId = field(ctx.body, "flowId");
    if (!flowId)
      return {
        status: 400,
        body: { error: "Missing `flowId` in request body." },
      };
    const result = await pollDeviceFlow({
      flowId,
      agentKey: String(ctx.runtime.agentId),
      signal: ctx.signal,
    });
    if (result.status !== "complete") return { status: 200, body: result };
    return {
      status: 200,
      body: { status: "complete", ...(await persistToken(ctx, result.token)) },
    };
  }),
];
