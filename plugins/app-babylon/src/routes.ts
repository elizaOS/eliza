import type { IAgentRuntime } from "@elizaos/core";
import type {
  AppLaunchDiagnostic,
  AppLaunchPreparation,
  AppLaunchResult,
  AppLaunchSessionContext,
  AppRunSessionContext,
  AppSessionState,
  AppViewerAuthMessage,
} from "@elizaos/shared";
import {
  asRuntimeLike,
  type BabylonConfig,
  persistBabylonCredential,
  proxyBabylonRequest,
  resolveBabylonClientUrl,
  resolveBabylonConfig,
  resolveSettingLike,
} from "./babylon-auth";

const APP_NAME = "@elizaos/app-babylon";
const APP_DISPLAY_NAME = "Babylon";
const BABYLON_AGENT_SESSION_TOKEN_KEY = "BABYLON_AGENT_SESSION_TOKEN";
const BABYLON_AGENT_SESSION_EXPIRES_AT_KEY = "BABYLON_AGENT_SESSION_EXPIRES_AT";

// ---------------------------------------------------------------------------
// Route context type (mirrors AppPackageRouteContext)
// ---------------------------------------------------------------------------

interface RouteContext {
  method: string;
  pathname: string;
  url: URL;
  runtime: unknown | null;
  res: unknown;
  error: (response: unknown, message: string, status?: number) => void;
  json: (response: unknown, data: unknown, status?: number) => void;
  readJsonBody: () => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRuntime(ctx: RouteContext): IAgentRuntime | null {
  return (asRuntimeLike(ctx.runtime) as IAgentRuntime | null) ?? null;
}

function getConfig(ctx: RouteContext): BabylonConfig {
  return resolveBabylonConfig(getRuntime(ctx));
}

function getAgentId(config: BabylonConfig): string | undefined {
  return config.agentId;
}

/** Strip the `/api/apps/babylon` prefix to get the sub-path. */
function subpath(pathname: string): string {
  const match = pathname.match(/^\/api\/apps\/babylon(\/.*)?$/);
  return match?.[1] ?? "";
}

async function proxyGet(
  config: BabylonConfig,
  apiPath: string,
  ctx: RouteContext,
): Promise<boolean> {
  try {
    const response = await proxyBabylonRequest(config, "GET", apiPath);
    const data = await response.json();
    ctx.json(ctx.res, data, response.ok ? 200 : response.status);
  } catch (err) {
    ctx.error(
      ctx.res,
      err instanceof Error ? err.message : "Babylon API request failed.",
      502,
    );
  }
  return true;
}

async function proxyPost(
  config: BabylonConfig,
  apiPath: string,
  body: unknown,
  ctx: RouteContext,
): Promise<boolean> {
  try {
    const response = await proxyBabylonRequest(config, "POST", apiPath, body);
    const data = await response.json();
    ctx.json(ctx.res, data, response.ok ? 200 : response.status);
  } catch (err) {
    ctx.error(
      ctx.res,
      err instanceof Error ? err.message : "Babylon API request failed.",
      502,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// SSE proxy — streams Babylon's SSE endpoint through to the client
// ---------------------------------------------------------------------------

async function handleSSEProxy(
  config: BabylonConfig,
  ctx: RouteContext,
): Promise<boolean> {
  const agentId = getAgentId(config);
  const channels = agentId ? `agent:${agentId},feed,markets` : "feed,markets";

  const sseUrl = new URL("/api/sse/events", config.apiBaseUrl);
  sseUrl.searchParams.set("channels", channels);

  const headers: Record<string, string> = {
    Accept: "text/event-stream",
  };

  const apiKey = resolveSettingLike(config.runtime, "BABYLON_A2A_API_KEY");
  if (apiKey) {
    headers["X-Babylon-Api-Key"] = apiKey;
  }

  try {
    const upstream = await fetch(sseUrl, {
      headers,
      signal: AbortSignal.timeout(60_000),
    });

    if (!upstream.ok || !upstream.body) {
      ctx.error(ctx.res, `Babylon SSE failed (${upstream.status})`, 502);
      return true;
    }

    const res = ctx.res as {
      writeHead: (status: number, headers: Record<string, string>) => void;
      write: (chunk: string) => boolean;
      end: () => void;
      on: (event: string, cb: () => void) => void;
    };

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let closed = false;

    res.on("close", () => {
      closed = true;
      reader.cancel().catch(() => {});
    });

    const pump = async () => {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        res.write(text);
      }
      if (!closed) res.end();
    };

    pump().catch(() => {
      if (!closed) res.end();
    });
  } catch (err) {
    ctx.error(
      ctx.res,
      err instanceof Error ? err.message : "Babylon SSE connection failed.",
      502,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Session state (for GameView session polling)
// ---------------------------------------------------------------------------

function buildSessionState(
  config: BabylonConfig,
  agentData?: Record<string, unknown>,
): AppSessionState {
  const agentId = getAgentId(config);
  const name =
    (agentData?.displayName as string) ??
    (agentData?.name as string) ??
    "Babylon Agent";
  const balance = (agentData?.balance as number) ?? 0;
  const pnl = (agentData?.lifetimePnL as number) ?? 0;

  return {
    sessionId: agentId ?? "babylon",
    appName: APP_NAME,
    mode: "spectate-and-steer",
    status: agentData ? "connected" : "connecting",
    displayName: APP_DISPLAY_NAME,
    agentId: agentId ?? undefined,
    canSendCommands: true,
    controls: ["pause", "resume"],
    summary: agentData
      ? `${name} | $${balance.toFixed(2)} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`
      : "Connecting to Babylon...",
    goalLabel: null,
    suggestedPrompts: [
      "What markets are trending?",
      "Show my positions",
      "Post an update",
      "Check my portfolio",
    ],
    telemetry: agentData
      ? {
          balance,
          lifetimePnL: pnl,
          winRate: asSessionNumber(agentData.winRate),
          reputation: asSessionNumber(agentData.reputationScore),
          totalTrades: asSessionNumber(agentData.totalTrades),
        }
      : null,
  };
}

function asSessionNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function readSessionState(
  config: BabylonConfig,
): Promise<AppSessionState> {
  const agentId = getAgentId(config);
  if (!agentId) {
    return buildSessionState(config);
  }

  try {
    const response = await proxyBabylonRequest(
      config,
      "GET",
      `/api/agents/${encodeURIComponent(agentId)}`,
    );
    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      return buildSessionState(config, data);
    }
  } catch {
    // Fall through to disconnected state
  }
  return buildSessionState(config);
}

async function probeBabylonDevCredentials(
  baseUrl: string,
): Promise<{ agentId: string; agentSecret: string } | null> {
  const nodeCrypto = await import("node:crypto");
  const os = await import("node:os");
  const agentIds = [
    "babylon-agent-alice",
    "babylon-test-agent",
    "dev-admin-local",
  ];
  const hostnames = new Set<string>(["localhost", "0.0.0.0"]);
  if (process.env.HOSTNAME) hostnames.add(process.env.HOSTNAME);
  hostnames.add(os.hostname());
  const secrets = Array.from(hostnames, (hostname) => {
    const hash = nodeCrypto
      .createHash("sha256")
      .update(`babylon-dev:${hostname}:agent`)
      .digest("hex")
      .substring(0, 32);
    return `dev_agent_${hash}`;
  });

  for (const agentId of agentIds) {
    for (const agentSecret of secrets) {
      try {
        const response = await fetch(new URL("/api/agents/auth", baseUrl), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId, agentSecret }),
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) continue;
        const data = (await response.json()) as {
          success?: boolean;
          sessionToken?: string;
        };
        if (data.success || data.sessionToken) {
          return { agentId, agentSecret };
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function authenticateBabylonAgentSession(
  baseUrl: string,
  agentId: string,
  agentSecret: string,
): Promise<{ sessionToken: string; expiresAt?: string } | null> {
  const response = await fetch(new URL("/api/agents/auth", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, agentSecret }),
    signal: AbortSignal.timeout(3_000),
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    sessionToken?: string;
    expiresAt?: string;
  };
  if (!data.sessionToken) {
    return null;
  }

  return {
    sessionToken: data.sessionToken,
    expiresAt:
      typeof data.expiresAt === "string" && data.expiresAt.trim().length > 0
        ? data.expiresAt
        : undefined,
  };
}

function persistSession(
  runtime: IAgentRuntime | null,
  session: { sessionToken: string; expiresAt?: string },
): void {
  persistBabylonCredential(
    runtime,
    BABYLON_AGENT_SESSION_TOKEN_KEY,
    session.sessionToken,
    true,
  );
  if (session.expiresAt) {
    persistBabylonCredential(
      runtime,
      BABYLON_AGENT_SESSION_EXPIRES_AT_KEY,
      session.expiresAt,
      true,
    );
  }
}

async function prepareBabylonCredentials(
  runtime: IAgentRuntime | null,
): Promise<AppLaunchDiagnostic[]> {
  const config = resolveBabylonConfig(runtime);
  const existingId = config.agentId;
  const existingSecret = config.agentSecret;

  if (existingId && existingSecret) {
    try {
      const session = await authenticateBabylonAgentSession(
        config.apiBaseUrl,
        existingId,
        existingSecret,
      );
      if (session) {
        persistSession(runtime, session);
        return [];
      }
      return [
        {
          code: "babylon-auth-failed",
          severity: "warning",
          message:
            "Babylon credentials are set but authentication failed. Check BABYLON_AGENT_ID and BABYLON_AGENT_SECRET.",
        },
      ];
    } catch {
      return [
        {
          code: "babylon-unreachable",
          severity: "warning",
          message: `Cannot reach Babylon at ${config.apiBaseUrl}. Is the server running?`,
        },
      ];
    }
  }

  if (process.env.NODE_ENV !== "production") {
    try {
      await fetch(new URL("/api/health", config.apiBaseUrl), {
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      return [
        {
          code: "babylon-unreachable",
          severity: "warning",
          message: `Cannot reach Babylon at ${config.apiBaseUrl}. Start the Babylon dev server and re-launch.`,
        },
      ];
    }

    const devCreds = await probeBabylonDevCredentials(config.apiBaseUrl);
    if (devCreds) {
      persistBabylonCredential(runtime, "BABYLON_AGENT_ID", devCreds.agentId);
      persistBabylonCredential(
        runtime,
        "BABYLON_AGENT_SECRET",
        devCreds.agentSecret,
        true,
      );
      const session = await authenticateBabylonAgentSession(
        config.apiBaseUrl,
        devCreds.agentId,
        devCreds.agentSecret,
      );
      if (session) {
        persistSession(runtime, session);
      }
      return [];
    }

    return [
      {
        code: "babylon-no-agent-id",
        severity: "warning",
        message:
          "Could not auto-provision Babylon credentials. Set BABYLON_AGENT_ID and BABYLON_AGENT_SECRET in your environment.",
      },
    ];
  }

  return [
    {
      code: "babylon-no-agent-id",
      severity: "warning",
      message:
        "BABYLON_AGENT_ID is not set. Set BABYLON_AGENT_ID and BABYLON_AGENT_SECRET for full Babylon integration.",
    },
  ];
}

// ---------------------------------------------------------------------------
// Session sub-routes (message + control for GameView integration)
// ---------------------------------------------------------------------------

function parseSessionId(pathname: string): string | null {
  const match = pathname.match(/\/session\/([^/]+)(?:\/|$)/);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

function parseSessionSubroute(pathname: string): "message" | "control" | null {
  if (pathname.endsWith("/message")) return "message";
  if (pathname.endsWith("/control")) return "control";
  return null;
}

function readPathSegment(pathValue: string, index: number): string | null {
  const segment = pathValue.split("/")[index];
  return typeof segment === "string" && segment.length > 0 ? segment : null;
}

// ---------------------------------------------------------------------------
// Launch session resolver
// ---------------------------------------------------------------------------

export async function resolveLaunchSession(
  ctx: AppLaunchSessionContext,
): Promise<AppLaunchResult["session"]> {
  const config = resolveBabylonConfig(ctx.runtime);
  return readSessionState(config);
}

export async function refreshRunSession(
  ctx: AppRunSessionContext,
): Promise<AppLaunchResult["session"]> {
  const config = resolveBabylonConfig(ctx.runtime);
  return readSessionState(config);
}

export async function prepareLaunch(ctx: {
  runtime: IAgentRuntime | null;
}): Promise<AppLaunchPreparation> {
  const runtime = getRuntime({ runtime: ctx.runtime } as RouteContext);
  return {
    diagnostics: await prepareBabylonCredentials(runtime),
    launchUrl: resolveBabylonClientUrl(runtime),
    viewer: {
      url: resolveBabylonClientUrl(runtime),
      postMessageAuth: true,
    },
  };
}

export async function resolveViewerAuthMessage(ctx: {
  runtime: IAgentRuntime | null;
}): Promise<AppViewerAuthMessage | null> {
  const runtime = getRuntime({ runtime: ctx.runtime } as RouteContext);
  const config = resolveBabylonConfig(runtime);
  const agentId = config.agentId;
  const sessionToken =
    resolveSettingLike(runtime, BABYLON_AGENT_SESSION_TOKEN_KEY) ??
    process.env[BABYLON_AGENT_SESSION_TOKEN_KEY]?.trim();

  if (!agentId || !sessionToken) {
    return null;
  }

  return {
    type: "BABYLON_AUTH",
    authToken: sessionToken,
    sessionToken,
    agentId,
    characterId: agentId,
  };
}

/**
 * Called by the host app-manager when the user stops the Babylon run.
 * Babylon is a stateless proxy to the external Babylon A2A API — there
 * are no local resources (WebSockets, timers, processes) to tear down.
 * Iframe unmount is sufficient. This hook is present so the app-manager
 * lifecycle path stays uniform across all game apps.
 */
export async function stopRun(): Promise<void> {
  // Intentional no-op — no server-side state to clean up.
}

// ---------------------------------------------------------------------------
// Main route handler
// ---------------------------------------------------------------------------

export async function handleAppRoutes(ctx: RouteContext): Promise<boolean> {
  const path = subpath(ctx.pathname);
  const config = getConfig(ctx);
  const agentId = getAgentId(config);

  // --- Agent status ---
  if (ctx.method === "GET" && path === "/agent/status") {
    if (!agentId) {
      ctx.json(ctx.res, { error: "No BABYLON_AGENT_ID configured" }, 400);
      return true;
    }
    return proxyGet(config, `/api/agents/${encodeURIComponent(agentId)}`, ctx);
  }

  // --- Agent activity feed ---
  if (ctx.method === "GET" && path === "/agent/activity") {
    if (!agentId) {
      ctx.json(ctx.res, { items: [], total: 0 }, 200);
      return true;
    }
    const limit = ctx.url.searchParams.get("limit") ?? "50";
    const type = ctx.url.searchParams.get("type") ?? "all";
    return proxyGet(
      config,
      `/api/agents/${encodeURIComponent(agentId)}/activity?limit=${limit}&type=${type}`,
      ctx,
    );
  }

  // --- Agent logs ---
  if (ctx.method === "GET" && path === "/agent/logs") {
    if (!agentId) {
      ctx.json(ctx.res, [], 200);
      return true;
    }
    const params = new URLSearchParams();
    const type = ctx.url.searchParams.get("type");
    const level = ctx.url.searchParams.get("level");
    if (type) params.set("type", type);
    if (level) params.set("level", level);
    const qs = params.toString();
    return proxyGet(
      config,
      `/api/agents/${encodeURIComponent(agentId)}/logs${qs ? `?${qs}` : ""}`,
      ctx,
    );
  }

  // --- Agent wallet ---
  if (ctx.method === "GET" && path === "/agent/wallet") {
    if (!agentId) {
      ctx.json(ctx.res, { balance: 0, transactions: [] }, 200);
      return true;
    }
    return proxyGet(
      config,
      `/api/agents/${encodeURIComponent(agentId)}/wallet`,
      ctx,
    );
  }

  // --- Granular autonomy control ---
  if (ctx.method === "POST" && path === "/agent/autonomy") {
    if (!agentId) {
      ctx.error(ctx.res, "No BABYLON_AGENT_ID configured.", 400);
      return true;
    }
    const body = (await ctx.readJsonBody()) as Record<string, boolean> | null;
    return proxyPost(
      config,
      `/api/admin/agents/${encodeURIComponent(agentId)}/autonomy`,
      body ?? {},
      ctx,
    );
  }

  // --- Team (all agents) ---
  if (ctx.method === "GET" && path === "/team") {
    return proxyGet(config, "/api/admin/agents", ctx);
  }

  // --- Team info (get/create team chat) ---
  if (ctx.method === "GET" && path === "/team/info") {
    return proxyGet(config, "/api/agents/team-chat", ctx);
  }

  // --- Team chat ---
  if (ctx.method === "POST" && path === "/team/chat") {
    const body = (await ctx.readJsonBody()) as {
      content?: string;
      mentions?: string[];
    } | null;
    if (!body?.content?.trim()) {
      ctx.error(ctx.res, "Chat content is required.", 400);
      return true;
    }
    return proxyPost(
      config,
      "/api/agents/team-chat/message",
      {
        content: body.content.trim(),
        mentions: body.mentions ?? [],
      },
      ctx,
    );
  }

  // --- Agent toggle (pause/resume) ---
  if (ctx.method === "POST" && path === "/agent/toggle") {
    if (!agentId) {
      ctx.error(ctx.res, "No BABYLON_AGENT_ID configured.", 400);
      return true;
    }
    const body = (await ctx.readJsonBody()) as {
      action?: string;
    } | null;
    return proxyPost(
      config,
      `/api/admin/agents/${encodeURIComponent(agentId)}/toggle`,
      { action: body?.action ?? "toggle" },
      ctx,
    );
  }

  // --- SSE stream proxy ---
  if (ctx.method === "GET" && path === "/sse") {
    return handleSSEProxy(config, ctx);
  }

  // =========================================================================
  // Markets — predictions
  // =========================================================================

  if (ctx.method === "GET" && path === "/markets/predictions") {
    const params = new URLSearchParams();
    for (const [k, v] of ctx.url.searchParams) {
      if (["page", "pageSize", "status", "category", "sort"].includes(k)) {
        params.set(k, v);
      }
    }
    const qs = params.toString();
    return proxyGet(
      config,
      `/api/markets/predictions${qs ? `?${qs}` : ""}`,
      ctx,
    );
  }

  if (ctx.method === "GET" && path.startsWith("/markets/predictions/")) {
    const marketId = path.replace("/markets/predictions/", "").split("/")[0];
    if (!marketId) return false;
    const sub = path.replace(`/markets/predictions/${marketId}`, "");
    if (!sub || sub === "/") {
      return proxyGet(
        config,
        `/api/markets/predictions/${encodeURIComponent(marketId)}`,
        ctx,
      );
    }
    if (sub === "/history") {
      return proxyGet(
        config,
        `/api/markets/predictions/${encodeURIComponent(marketId)}/history`,
        ctx,
      );
    }
    if (sub === "/trades") {
      return proxyGet(
        config,
        `/api/markets/predictions/${encodeURIComponent(marketId)}/trades`,
        ctx,
      );
    }
  }

  // Buy prediction shares
  if (
    ctx.method === "POST" &&
    path.match(/^\/markets\/predictions\/[^/]+\/buy$/)
  ) {
    const marketId = readPathSegment(path, 3);
    if (!marketId) return false;
    const body = await ctx.readJsonBody();
    return proxyPost(
      config,
      `/api/markets/predictions/${encodeURIComponent(marketId)}/buy`,
      body,
      ctx,
    );
  }

  // Sell prediction shares
  if (
    ctx.method === "POST" &&
    path.match(/^\/markets\/predictions\/[^/]+\/sell$/)
  ) {
    const marketId = readPathSegment(path, 3);
    if (!marketId) return false;
    const body = await ctx.readJsonBody();
    return proxyPost(
      config,
      `/api/markets/predictions/${encodeURIComponent(marketId)}/sell`,
      body,
      ctx,
    );
  }

  // =========================================================================
  // Markets — perps
  // =========================================================================

  if (ctx.method === "GET" && path === "/markets/perps") {
    return proxyGet(config, "/api/markets/perps", ctx);
  }

  if (ctx.method === "GET" && path === "/markets/perps/open") {
    return proxyGet(config, "/api/markets/perps/open", ctx);
  }

  // Preview perp trade
  if (ctx.method === "POST" && path === "/markets/perps/preview") {
    const body = await ctx.readJsonBody();
    return proxyPost(config, "/api/markets/perps/preview", body, ctx);
  }

  // Close perp position
  if (
    ctx.method === "POST" &&
    path.match(/^\/markets\/perps\/position\/[^/]+\/close$/)
  ) {
    const positionId = readPathSegment(path, 4);
    if (!positionId) return false;
    const body = await ctx.readJsonBody();
    return proxyPost(
      config,
      `/api/markets/perps/position/${encodeURIComponent(positionId)}/close`,
      body,
      ctx,
    );
  }

  // =========================================================================
  // Social — posts
  // =========================================================================

  // List / feed
  if (ctx.method === "GET" && path === "/posts") {
    const params = new URLSearchParams();
    for (const [k, v] of ctx.url.searchParams) {
      if (["page", "limit", "feed", "sort"].includes(k)) params.set(k, v);
    }
    const qs = params.toString();
    return proxyGet(config, `/api/posts${qs ? `?${qs}` : ""}`, ctx);
  }

  // Create post
  if (ctx.method === "POST" && path === "/posts") {
    const body = await ctx.readJsonBody();
    return proxyPost(config, "/api/posts", body, ctx);
  }

  // Single post + interactions
  if (ctx.method === "GET" && path.match(/^\/posts\/[^/]+$/)) {
    const postId = readPathSegment(path, 2);
    if (!postId) return false;
    return proxyGet(config, `/api/posts/${encodeURIComponent(postId)}`, ctx);
  }

  // Post comments
  if (ctx.method === "GET" && path.match(/^\/posts\/[^/]+\/comments$/)) {
    const postId = readPathSegment(path, 2);
    if (!postId) return false;
    return proxyGet(
      config,
      `/api/posts/${encodeURIComponent(postId)}/comments`,
      ctx,
    );
  }

  // Comment on post
  if (ctx.method === "POST" && path.match(/^\/posts\/[^/]+\/comments$/)) {
    const postId = readPathSegment(path, 2);
    if (!postId) return false;
    const body = await ctx.readJsonBody();
    return proxyPost(
      config,
      `/api/posts/${encodeURIComponent(postId)}/comments`,
      body,
      ctx,
    );
  }

  // Like post
  if (ctx.method === "POST" && path.match(/^\/posts\/[^/]+\/like$/)) {
    const postId = readPathSegment(path, 2);
    if (!postId) return false;
    return proxyPost(
      config,
      `/api/posts/${encodeURIComponent(postId)}/like`,
      {},
      ctx,
    );
  }

  // =========================================================================
  // Messaging — chats & DMs
  // =========================================================================

  // List chats
  if (ctx.method === "GET" && path === "/chats") {
    return proxyGet(config, "/api/chats", ctx);
  }

  // Create chat / DM
  if (ctx.method === "POST" && path === "/chats") {
    const body = await ctx.readJsonBody();
    return proxyPost(config, "/api/chats", body, ctx);
  }

  // Get DM with specific user
  if (ctx.method === "GET" && path === "/chats/dm") {
    const userId = ctx.url.searchParams.get("userId");
    return proxyGet(
      config,
      `/api/chats/dm${userId ? `?userId=${encodeURIComponent(userId)}` : ""}`,
      ctx,
    );
  }

  // Chat messages
  if (ctx.method === "GET" && path.match(/^\/chats\/[^/]+\/messages$/)) {
    const chatId = readPathSegment(path, 2);
    if (!chatId) return false;
    return proxyGet(
      config,
      `/api/chats/${encodeURIComponent(chatId)}/messages`,
      ctx,
    );
  }

  // Send message to chat
  if (ctx.method === "POST" && path.match(/^\/chats\/[^/]+\/message$/)) {
    const chatId = readPathSegment(path, 2);
    if (!chatId) return false;
    const body = await ctx.readJsonBody();
    return proxyPost(
      config,
      `/api/chats/${encodeURIComponent(chatId)}/message`,
      body,
      ctx,
    );
  }

  // =========================================================================
  // Groups
  // =========================================================================

  if (ctx.method === "GET" && path === "/groups") {
    return proxyGet(config, "/api/groups", ctx);
  }

  if (ctx.method === "POST" && path === "/groups") {
    const body = await ctx.readJsonBody();
    return proxyPost(config, "/api/groups", body, ctx);
  }

  if (ctx.method === "GET" && path.match(/^\/groups\/[^/]+$/)) {
    const groupId = readPathSegment(path, 2);
    if (!groupId) return false;
    return proxyGet(config, `/api/groups/${encodeURIComponent(groupId)}`, ctx);
  }

  if (ctx.method === "GET" && path.match(/^\/groups\/[^/]+\/members$/)) {
    const groupId = readPathSegment(path, 2);
    if (!groupId) return false;
    return proxyGet(
      config,
      `/api/groups/${encodeURIComponent(groupId)}/members`,
      ctx,
    );
  }

  // =========================================================================
  // Agent management (beyond status)
  // =========================================================================

  // Agent goals
  if (ctx.method === "GET" && path === "/agent/goals") {
    if (!agentId) {
      ctx.json(ctx.res, [], 200);
      return true;
    }
    return proxyGet(
      config,
      `/api/agents/${encodeURIComponent(agentId)}/goals`,
      ctx,
    );
  }

  // Agent stats
  if (ctx.method === "GET" && path === "/agent/stats") {
    if (!agentId) {
      ctx.json(ctx.res, {}, 200);
      return true;
    }
    return proxyGet(
      config,
      `/api/agents/${encodeURIComponent(agentId)}/stats`,
      ctx,
    );
  }

  // Agent summary
  if (ctx.method === "GET" && path === "/agent/summary") {
    if (!agentId) {
      ctx.json(ctx.res, {}, 200);
      return true;
    }
    return proxyGet(
      config,
      `/api/agents/${encodeURIComponent(agentId)}/summary`,
      ctx,
    );
  }

  // Agent recent trades
  if (ctx.method === "GET" && path === "/agent/recent-trades") {
    if (!agentId) {
      ctx.json(ctx.res, [], 200);
      return true;
    }
    return proxyGet(
      config,
      `/api/agents/${encodeURIComponent(agentId)}/recent-trades`,
      ctx,
    );
  }

  // Agent chat (direct messages with agent)
  if (ctx.method === "GET" && path === "/agent/chat") {
    if (!agentId) {
      ctx.json(ctx.res, { messages: [] }, 200);
      return true;
    }
    return proxyGet(
      config,
      `/api/agents/${encodeURIComponent(agentId)}/chat`,
      ctx,
    );
  }

  if (ctx.method === "POST" && path === "/agent/chat") {
    if (!agentId) {
      ctx.error(ctx.res, "No BABYLON_AGENT_ID configured.", 400);
      return true;
    }
    const body = await ctx.readJsonBody();
    return proxyPost(
      config,
      `/api/agents/${encodeURIComponent(agentId)}/chat`,
      body,
      ctx,
    );
  }

  // Agent card
  if (ctx.method === "GET" && path === "/agent/card") {
    if (!agentId) {
      ctx.json(ctx.res, {}, 200);
      return true;
    }
    return proxyGet(
      config,
      `/api/agents/${encodeURIComponent(agentId)}/card`,
      ctx,
    );
  }

  // Agent trading balance
  if (ctx.method === "GET" && path === "/agent/trading-balance") {
    if (!agentId) {
      ctx.json(ctx.res, { balance: 0 }, 200);
      return true;
    }
    return proxyGet(
      config,
      `/api/agents/${encodeURIComponent(agentId)}/trading-balance`,
      ctx,
    );
  }

  // Agent benchmark
  if (ctx.method === "GET" && path === "/agent/benchmark") {
    if (!agentId) {
      ctx.json(ctx.res, {}, 200);
      return true;
    }
    return proxyGet(
      config,
      `/api/agents/${encodeURIComponent(agentId)}/benchmark`,
      ctx,
    );
  }

  // =========================================================================
  // Feed endpoints
  // =========================================================================

  if (ctx.method === "GET" && path === "/feed/for-you") {
    return proxyGet(config, "/api/feed/for-you", ctx);
  }

  if (ctx.method === "GET" && path === "/feed/hot") {
    return proxyGet(config, "/api/feed/hot", ctx);
  }

  if (ctx.method === "GET" && path === "/trades") {
    return proxyGet(config, "/api/trades", ctx);
  }

  // =========================================================================
  // Discover agents
  // =========================================================================

  if (ctx.method === "GET" && path === "/agents/discover") {
    return proxyGet(config, "/api/agents/discover", ctx);
  }

  // =========================================================================
  // Team dashboard
  // =========================================================================

  if (ctx.method === "GET" && path === "/team/dashboard") {
    return proxyGet(config, "/api/agents/team-dashboard", ctx);
  }

  // Team chat conversations
  if (ctx.method === "GET" && path === "/team/conversations") {
    return proxyGet(config, "/api/agents/team-chat/conversations", ctx);
  }

  // =========================================================================
  // Admin: pause/resume all agents
  // =========================================================================

  if (ctx.method === "POST" && path === "/admin/agents/pause-all") {
    return proxyPost(config, "/api/admin/agents/pause-all", {}, ctx);
  }

  if (ctx.method === "POST" && path === "/admin/agents/resume-all") {
    return proxyPost(config, "/api/admin/agents/resume-all", {}, ctx);
  }

  // --- Session state (for GameView polling) ---
  const sessionId = parseSessionId(path);
  if (sessionId) {
    const subroute = parseSessionSubroute(path);

    if (ctx.method === "GET" && !subroute) {
      const state = await readSessionState(config);
      ctx.json(ctx.res, state);
      return true;
    }

    if (ctx.method === "POST" && subroute === "message") {
      const body = (await ctx.readJsonBody()) as {
        content?: string;
      } | null;
      if (!body?.content?.trim()) {
        ctx.error(ctx.res, "Message content is required.", 400);
        return true;
      }
      return proxyPost(
        config,
        "/api/agents/team-chat/message",
        { content: body.content.trim() },
        ctx,
      );
    }

    if (ctx.method === "POST" && subroute === "control") {
      const body = (await ctx.readJsonBody()) as {
        action?: string;
      } | null;
      if (!agentId) {
        ctx.error(ctx.res, "No BABYLON_AGENT_ID configured.", 400);
        return true;
      }
      return proxyPost(
        config,
        `/api/admin/agents/${encodeURIComponent(agentId)}/toggle`,
        { action: body?.action ?? "toggle" },
        ctx,
      );
    }
  }

  return false;
}
