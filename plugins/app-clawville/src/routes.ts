import { type IAgentRuntime, logger } from "@elizaos/core";
import type {
  AppLaunchDiagnostic,
  AppLaunchResult,
  AppLaunchSessionContext,
  AppRunSessionContext,
  AppSessionActionResult,
  AppSessionActivityItem,
  AppSessionState,
} from "@elizaos/shared";

import {
  asRuntimeLike,
  type ClawvilleConfig,
  type ClawvilleConnectResponse,
  clawvilleConnect,
  clawvillePerception,
  proxyClawvilleRequest,
  resolveClawvilleConfig,
  stashClawvilleSession,
} from "./clawville-auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = "@elizaos/app-clawville";
const APP_DISPLAY_NAME = "ClawVille";
const VIEWER_ROUTE_PATH = "/api/apps/clawville/viewer";
const VIEWER_FETCH_TIMEOUT_MS = 8_000;
const SESSION_ACTIVITY_LIMIT = 12;

/**
 * CSP frame-ancestors directive we send on the viewer HTML response so that
 * Host shells (desktop Electrobun, mobile Capacitor, plus
 * the dev http://localhost and https://localhost cases) can embed us in an
 * iframe. Mirrors the value used by app-defense-of-the-agents.
 */
const VIEWER_FRAME_ANCESTORS_DIRECTIVE =
  "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* " +
  "http://[::1]:* http://[0:0:0:0:0:0:0:1]:* https://localhost:* " +
  "https://127.0.0.1:* https://[::1]:* https://[0:0:0:0:0:0:0:1]:* " +
  "electrobun: capacitor: capacitor-electron: app: tauri: file:";

const BUILDINGS = [
  {
    id: "tool-workshop",
    label: "Krusty Krab",
    aliases: ["tool workshop", "krusty krab", "mcp", "tools"],
  },
  {
    id: "skill-forge",
    label: "Chum Bucket",
    aliases: ["skill forge", "chum bucket", "code", "debugging"],
  },
  {
    id: "memory-vault",
    label: "Squidward's House",
    aliases: ["memory vault", "squidward", "rag", "memory"],
  },
  {
    id: "canvas-studio",
    label: "Pineapple House",
    aliases: ["canvas studio", "pineapple", "sql", "analytics"],
  },
  {
    id: "security-fortress",
    label: "Patrick's Rock",
    aliases: ["security fortress", "patrick", "solana", "wallet"],
  },
  {
    id: "channel-bridge",
    label: "Sandy's Treedome",
    aliases: ["channel bridge", "sandy", "discord", "telegram", "email"],
  },
  {
    id: "webhook-gateway",
    label: "Salty Spitoon",
    aliases: ["webhook gateway", "salty spitoon", "api", "webhook"],
  },
  {
    id: "cron-hub",
    label: "Downtown Building",
    aliases: ["cron hub", "downtown", "automation", "cron"],
  },
  {
    id: "voice-tower",
    label: "Boating School",
    aliases: ["voice tower", "boating school", "research", "search"],
  },
  {
    id: "config-citadel",
    label: "Lighthouse",
    aliases: ["config citadel", "lighthouse", "config", "deployment"],
  },
] as const;

type ClawvilleSubroute = "move" | "visit-building" | "chat" | "buy";
type ClawvilleBuildingId = (typeof BUILDINGS)[number]["id"];

const sessionActivities = new Map<string, AppSessionActivityItem[]>();

interface RouteContext {
  method: string;
  pathname: string;
  url?: URL;
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

function getConfig(ctx: RouteContext): ClawvilleConfig {
  return resolveClawvilleConfig(getRuntime(ctx));
}

/** Strip the `/api/apps/clawville` prefix to get the sub-path. */
function subpath(pathname: string): string {
  const match = pathname.match(/^\/api\/apps\/clawville(\/.*)?$/);
  return match?.[1] ?? "";
}

/** Parse `/session/:id/...` into the sessionId. */
function parseSessionId(pathValue: string): string | null {
  const match = pathValue.match(/\/session\/([^/]+)(?:\/|$)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** Parse the final segment of `/session/:id/<subroute>`. */
function parseSessionSubroute(
  pathValue: string,
): "message" | "move" | "visit-building" | "chat" | "buy" | null {
  if (pathValue.endsWith("/message")) return "message";
  if (pathValue.endsWith("/move")) return "move";
  if (pathValue.endsWith("/visit-building")) return "visit-building";
  if (pathValue.endsWith("/chat")) return "chat";
  if (pathValue.endsWith("/buy")) return "buy";
  return null;
}

// ---------------------------------------------------------------------------
// Session state construction
// ---------------------------------------------------------------------------

function readNearestBuilding(
  perception?: Record<string, unknown> | null,
): { buildingId?: string; label?: string } | null {
  const nearby = perception?.nearbyBuildings;
  if (!Array.isArray(nearby)) return null;
  const first = nearby[0];
  return first && typeof first === "object"
    ? (first as { buildingId?: string; label?: string })
    : null;
}

function readNearestBuildingId(
  perception?: Record<string, unknown> | null,
): string | null {
  const id = readNearestBuilding(perception)?.buildingId;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

function readNearestBuildingLabel(
  perception?: Record<string, unknown> | null,
): string | null {
  const label = readNearestBuilding(perception)?.label;
  return typeof label === "string" && label.trim().length > 0
    ? label.trim()
    : null;
}

function formatNearestBuildingGoal(
  perception?: Record<string, unknown> | null,
): string | null {
  const label = readNearestBuildingLabel(perception);
  return label
    ? `Near ${label}. Visit or ask the local NPC.`
    : "Exploring the reef";
}

function formatSessionSummary(
  connectResult: ClawvilleConnectResponse,
  perception?: Record<string, unknown> | null,
): string {
  const location = readNearestBuildingLabel(perception);
  const learned = connectResult.knowledge.length;
  const skillLabel = learned === 1 ? "skill" : "skills";
  return location
    ? `Near ${location}. ${learned} ${skillLabel} learned.`
    : `Exploring ClawVille. ${learned} ${skillLabel} learned.`;
}

function buildSessionState(
  config: ClawvilleConfig,
  connectResult: ClawvilleConnectResponse | null,
  perception?: Record<string, unknown> | null,
): AppSessionState {
  if (!connectResult) {
    return {
      sessionId: config.elizaAgentId ?? "clawville",
      appName: APP_NAME,
      mode: "spectate-and-steer",
      status: "connecting",
      displayName: APP_DISPLAY_NAME,
      agentId: config.elizaAgentId ?? undefined,
      canSendCommands: false,
      controls: [],
      summary: "Connecting to ClawVille...",
      goalLabel: null,
      suggestedPrompts: [
        "Move to tool workshop",
        "Visit the nearest building",
        "Ask the nearest NPC what to learn next",
      ],
      telemetry: null,
    };
  }

  return {
    sessionId: connectResult.sessionId,
    appName: APP_NAME,
    mode: "spectate-and-steer",
    status: "running",
    displayName: APP_DISPLAY_NAME,
    agentId: connectResult.agentId,
    canSendCommands: true,
    controls: [],
    summary: formatSessionSummary(connectResult, perception),
    goalLabel: formatNearestBuildingGoal(perception),
    suggestedPrompts: [
      "Move to tool workshop",
      "Visit the nearest building",
      "Ask the nearest NPC what to learn next",
      "Move to skill forge",
    ],
    activity: readSessionActivity(config, connectResult.sessionId),
    telemetry: {
      walletAddress: connectResult.walletAddress,
      botUuid: connectResult.uuid,
      isReturning: connectResult.isReturning,
      totalSessions: connectResult.totalSessions,
      knowledgeCount: connectResult.knowledge.length,
      identityType: connectResult.identityType,
      autonomyMode: connectResult.autonomyMode,
      sessionTicketUrl: connectResult.sessionTicket?.url ?? null,
      nearestBuildingId: readNearestBuildingId(perception),
      nearestBuildingLabel: readNearestBuildingLabel(perception),
    },
  };
}

// ---------------------------------------------------------------------------
// Viewer HTML rewrite + embed header injection
// ---------------------------------------------------------------------------

function buildViewerShellInjection(
  agentName: string,
  sessionId: string | null,
): string {
  const safeAgentName = JSON.stringify(agentName || "Eliza Agent");
  const safeSessionId = JSON.stringify(sessionId ?? "");

  return `<script id="eliza-clawville-embedded-bootstrap">
(() => {
  const agentName = ${safeAgentName};
  const sessionId = ${safeSessionId};

  try {
    localStorage.setItem("clawville-embed-mode", "eliza");
    localStorage.setItem("clawville-eliza-agent-name", agentName);
    if (sessionId) {
      localStorage.setItem("clawville-eliza-session-id", sessionId);
    }
    localStorage.setItem("landing-closed", "1");
  } catch {
  }

  const hiddenIds = [
    "landing-overlay",
    "auth-modal",
    "login-overlay",
    "create-pet-overlay",
    "create-pet-modal",
  ];
  for (const id of hiddenIds) {
    const node = document.getElementById(id);
    if (node) {
      node.style.display = "none";
      node.setAttribute("aria-hidden", "true");
    }
  }

  window.parent?.postMessage?.(
    { type: "eliza-clawville-ready", agentName, sessionId },
    "*",
  );
})();
</script>`;
}

/**
 * Rewrite relative asset URLs in the fetched HTML so they resolve against
 * the real clawville.world origin instead of against localhost.
 * Handles `src="..."`, `href="..."`, and `srcset="..."` attributes.
 */
function absolutizeViewerHtmlAssetUrls(html: string, baseUrl: string): string {
  const base = new URL(baseUrl);
  const origin = `${base.protocol}//${base.host}`;

  return html
    .replace(/(\s(?:src|href))=(["'])\/(?!\/)/gi, `$1=$2${origin}/`)
    .replace(
      /(\ssrcset)=(["'])([^"']+)\2/gi,
      (_match, attr, quote, value: string) => {
        const rewritten = value
          .split(",")
          .map((item) => {
            const trimmed = item.trim();
            if (!trimmed) return trimmed;
            const spaceIdx = trimmed.indexOf(" ");
            const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
            const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx);
            if (url.startsWith("/") && !url.startsWith("//")) {
              return `${origin}${url}${rest}`;
            }
            return trimmed;
          })
          .join(", ");
        return `${attr}=${quote}${rewritten}${quote}`;
      },
    );
}

async function buildEmbeddedViewerHtml(
  runtime: IAgentRuntime | null,
): Promise<string> {
  const config = resolveClawvilleConfig(runtime);
  const response = await fetch(config.viewerUrl, {
    signal: AbortSignal.timeout(VIEWER_FETCH_TIMEOUT_MS),
  });
  const html = await response.text();

  if (!response.ok) {
    throw new Error(
      `ClawVille viewer request failed (${response.status}): ${
        html.trim() || response.statusText
      }`,
    );
  }

  const absolutized = absolutizeViewerHtmlAssetUrls(html, config.viewerUrl);
  const injection = buildViewerShellInjection(
    config.elizaCharacterName ?? "Eliza Agent",
    config.storedSessionId ?? null,
  );

  if (absolutized.includes("</head>")) {
    return absolutized.replace("</head>", `${injection}</head>`);
  }
  return `${injection}${absolutized}`;
}

function sendHtmlResponse(res: unknown, html: string): void {
  const response = res as {
    end: (body?: string) => void;
    setHeader: (name: string, value: string) => void;
    statusCode: number;
    removeHeader?: (name: string) => void;
    getHeader?: (name: string) => number | string | string[] | undefined;
  };
  response.statusCode = 200;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  applyViewerEmbedHeaders(response);
  response.end(html);
}

function applyViewerEmbedHeaders(response: {
  setHeader: (name: string, value: string) => void;
  removeHeader?: (name: string) => void;
  getHeader?: (name: string) => number | string | string[] | undefined;
}): void {
  response.removeHeader?.("X-Frame-Options");
  const existingCsp = response.getHeader?.("Content-Security-Policy");
  const normalizedExisting =
    typeof existingCsp === "string"
      ? existingCsp.trim()
      : Array.isArray(existingCsp)
        ? existingCsp.join("; ").trim()
        : "";
  const nextCsp = /\bframe-ancestors\b/i.test(normalizedExisting)
    ? normalizedExisting
    : normalizedExisting.length > 0
      ? `${normalizedExisting}; ${VIEWER_FRAME_ANCESTORS_DIRECTIVE}`
      : VIEWER_FRAME_ANCESTORS_DIRECTIVE;
  response.setHeader("Content-Security-Policy", nextCsp);
}

// ---------------------------------------------------------------------------
// Launch session resolver
// ---------------------------------------------------------------------------
export async function resolveLaunchSession(
  ctx: AppLaunchSessionContext,
): Promise<AppLaunchResult["session"]> {
  const config = resolveClawvilleConfig(ctx.runtime);

  try {
    const connectResult = await clawvilleConnect(config);
    stashClawvilleSession(ctx.runtime, {
      sessionId: connectResult.sessionId,
      uuid: connectResult.uuid,
      walletAddress: connectResult.walletAddress,
    });
    return buildSessionState(config, connectResult);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "ClawVille connect failed.";
    logger.warn(`[ClawVille] resolveLaunchSession failed: ${message}`);
    return {
      ...buildSessionState(config, null),
      status: "degraded",
      summary: message,
    };
  }
}

export async function stopRun(): Promise<void> {}

function buildCachedConnect(
  config: ClawvilleConfig,
  sessionId: string,
  session?: AppSessionState | null,
): ClawvilleConnectResponse {
  return {
    agentId:
      typeof session?.agentId === "string"
        ? session.agentId
        : config.elizaAgentId
          ? `eliza:${config.elizaAgentId}`
          : "clawville",
    sessionId,
    uuid: config.storedUuid ?? "",
    isReturning: true,
    totalSessions:
      typeof session?.telemetry?.totalSessions === "number"
        ? session.telemetry.totalSessions
        : 1,
    knowledge: [],
    identityType: "eliza",
    autonomyMode: "server-managed",
    walletAddress: config.storedWalletAddress ?? null,
  };
}

export async function refreshRunSession(
  ctx: AppRunSessionContext,
): Promise<AppLaunchResult["session"]> {
  const config = resolveClawvilleConfig(ctx.runtime);
  const sessionId = config.storedSessionId ?? ctx.session?.sessionId ?? null;

  if (!sessionId) {
    return resolveLaunchSession(ctx);
  }

  const perception = await clawvillePerception(config, sessionId);
  if (!perception) {
    // Session likely expired — reconnect
    return resolveLaunchSession(ctx);
  }

  return buildSessionState(
    config,
    buildCachedConnect(config, sessionId, ctx.session),
    perception,
  );
}

export async function collectLaunchDiagnostics(ctx: {
  runtime: IAgentRuntime | null;
  session: AppSessionState | null;
}): Promise<AppLaunchDiagnostic[]> {
  const config = resolveClawvilleConfig(ctx.runtime);
  const diagnostics: AppLaunchDiagnostic[] = [];

  if (!config.elizaAgentId) {
    diagnostics.push({
      code: "clawville-missing-agent-id",
      severity: "error",
      message:
        "ClawVille requires a runtime agentId. Restart the agent after configuring.",
    });
  }

  if (ctx.session?.status === "degraded") {
    diagnostics.push({
      code: "clawville-api-degraded",
      severity: "warning",
      message:
        ctx.session.summary ??
        "Couldn't reach clawville.world. Launching in read-only viewer mode.",
    });
  }

  return diagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function resolveBuildingIdFromText(
  content: string,
): ClawvilleBuildingId | null {
  const normalized = normalizeText(content);
  for (const building of BUILDINGS) {
    const candidates = [building.id, building.label, ...building.aliases].map(
      normalizeText,
    );
    if (candidates.some((candidate) => normalized.includes(candidate))) {
      return building.id;
    }
  }
  return null;
}

function readStringField(
  body: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function sessionActivityKey(
  config: ClawvilleConfig,
  sessionId: string,
): string {
  return `${config.elizaAgentId ?? "clawville"}:${sessionId}`;
}

function readSessionActivity(
  config: ClawvilleConfig,
  sessionId: string,
): AppSessionActivityItem[] {
  return sessionActivities.get(sessionActivityKey(config, sessionId)) ?? [];
}

function appendSessionActivity(
  config: ClawvilleConfig,
  sessionId: string,
  items: AppSessionActivityItem[],
): void {
  sessionActivities.set(
    sessionActivityKey(config, sessionId),
    [...readSessionActivity(config, sessionId), ...items].slice(
      -SESSION_ACTIVITY_LIMIT,
    ),
  );
}

function formatBuildingId(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function describeCommand(
  subroute: ClawvilleSubroute,
  body: Record<string, unknown>,
): string {
  if (subroute === "chat") {
    return (
      readStringField(body, ["message", "content", "command"]) ??
      "Ask the nearest NPC."
    );
  }

  if (subroute === "move" || subroute === "visit-building") {
    const buildingId = readStringField(body, ["buildingId", "building"]);
    const target = buildingId
      ? formatBuildingId(buildingId)
      : "nearest building";
    return subroute === "move" ? `Move to ${target}.` : `Visit ${target}.`;
  }

  return "Command sent.";
}

function readNumberField(
  body: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function coerceBuildingId(
  body: Record<string, unknown>,
  perception?: Record<string, unknown> | null,
): string | null {
  const explicit = readStringField(body, [
    "buildingId",
    "locationId",
    "building",
    "location",
  ]);
  if (explicit) return explicit;
  const content = readStringField(body, ["content", "message", "command"]);
  if (content) return resolveBuildingIdFromText(content);
  return readNearestBuildingId(perception);
}

function normalizeDirectCommandBody(
  subroute: ClawvilleSubroute,
  body: unknown,
  perception?: Record<string, unknown> | null,
): Record<string, unknown> {
  const record = isRecord(body) ? body : {};

  if (subroute === "move") {
    const targetX = readNumberField(record, ["targetX", "x"]);
    const targetY = readNumberField(record, ["targetY", "y"]);
    if (targetX !== null && targetY !== null) {
      return { targetX, targetY };
    }
    const buildingId = coerceBuildingId(record, perception);
    return buildingId ? { buildingId } : record;
  }

  if (subroute === "visit-building") {
    const buildingId = coerceBuildingId(record, perception);
    return buildingId ? { buildingId } : record;
  }

  if (subroute === "chat") {
    const message = readStringField(record, ["message", "content", "command"]);
    return message ? { message } : record;
  }

  return record;
}

async function resolveNearestBuildingId(
  config: ClawvilleConfig,
  sessionId: string,
): Promise<string | null> {
  const perception = await clawvillePerception(config, sessionId);
  return readNearestBuildingId(perception);
}

async function buildMessageCommand(
  config: ClawvilleConfig,
  sessionId: string,
  content: string,
): Promise<{
  subroute: ClawvilleSubroute;
  body: Record<string, unknown>;
}> {
  const normalized = normalizeText(content);
  const explicitBuildingId = resolveBuildingIdFromText(content);

  if (/\b(buy|shop|book|market|purchase)\b/.test(normalized)) {
    return {
      subroute: "buy",
      body: { message: content },
    };
  }

  if (/\b(ask|talk|chat|npc|say|message)\b/.test(normalized)) {
    return {
      subroute: "chat",
      body: { message: content },
    };
  }

  if (/\b(move|go|head|travel|walk|path)\b/.test(normalized)) {
    const buildingId =
      explicitBuildingId ?? (await resolveNearestBuildingId(config, sessionId));
    if (!buildingId) {
      return {
        subroute: "chat",
        body: { message: content },
      };
    }
    return {
      subroute: "move",
      body: { buildingId },
    };
  }

  if (/\b(visit|enter|learn)\b/.test(normalized)) {
    const buildingId =
      explicitBuildingId ?? (await resolveNearestBuildingId(config, sessionId));
    if (!buildingId) {
      return {
        subroute: "chat",
        body: { message: content },
      };
    }
    return {
      subroute: "visit-building",
      body: { buildingId },
    };
  }

  return {
    subroute: "chat",
    body: { message: content },
  };
}

function resultMessage(
  subroute: ClawvilleSubroute,
  data: Record<string, unknown>,
): string {
  const message = readStringField(data, ["message", "status", "error"]);
  if (message) return message;
  switch (subroute) {
    case "move":
      return "Moving.";
    case "visit-building":
      return "Visiting building.";
    case "chat":
      return "Message sent.";
    case "buy":
      return "ClawVille agent shop control is not exposed by the current API.";
  }
}

async function proxyCommand(
  config: ClawvilleConfig,
  sessionId: string,
  subroute: ClawvilleSubroute,
  body: Record<string, unknown>,
): Promise<{
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
}> {
  if (subroute === "buy") {
    return {
      ok: false,
      status: 400,
      data: {
        error:
          "ClawVille agent shop control is not exposed by the current API.",
      },
    };
  }

  const response = await proxyClawvilleRequest(
    config,
    "POST",
    `/api/agent/${encodeURIComponent(sessionId)}/${subroute}`,
    body,
  );
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    data: isRecord(data) ? data : {},
  };
}

async function buildCommandResult(
  config: ClawvilleConfig,
  sessionId: string,
  subroute: ClawvilleSubroute,
  body: Record<string, unknown>,
): Promise<AppSessionActionResult> {
  const response = await proxyCommand(config, sessionId, subroute, body);
  const message = resultMessage(subroute, response.data);
  if (response.ok) {
    const timestamp = Date.now();
    appendSessionActivity(config, sessionId, [
      {
        id: `clawville-user-${timestamp}`,
        type: "You",
        message: describeCommand(subroute, body),
        timestamp,
        severity: "info",
      },
      {
        id: `clawville-game-${timestamp}`,
        type: subroute,
        message,
        timestamp: timestamp + 1,
        severity: "info",
      },
    ]);
  }
  const perception = response.ok
    ? await clawvillePerception(config, sessionId)
    : null;
  return {
    success: response.ok,
    message,
    session: response.ok
      ? buildSessionState(
          config,
          buildCachedConnect(config, sessionId),
          perception,
        )
      : null,
  };
}

// ---------------------------------------------------------------------------
// Main route handler — dispatches all /api/apps/clawville/* requests
// ---------------------------------------------------------------------------

export async function handleAppRoutes(ctx: RouteContext): Promise<boolean> {
  const runtime = getRuntime(ctx);

  // --- 1. Viewer HTML (GET /api/apps/clawville/viewer) ---
  if (ctx.method === "GET" && ctx.pathname === VIEWER_ROUTE_PATH) {
    try {
      sendHtmlResponse(ctx.res, await buildEmbeddedViewerHtml(runtime));
    } catch (error) {
      ctx.error(
        ctx.res,
        error instanceof Error
          ? error.message
          : "ClawVille viewer failed to load.",
        502,
      );
    }
    return true;
  }

  // --- 2. Everything else is /api/apps/clawville/session/:id/... ---
  const path = subpath(ctx.pathname);
  const sessionId = parseSessionId(path);
  if (!sessionId) {
    return false;
  }

  const config = getConfig(ctx);
  const subroute = parseSessionSubroute(path);
  const commandSubroute: ClawvilleSubroute | null =
    subroute && subroute !== "message" ? subroute : null;

  // GET /api/apps/clawville/session/:id — state poll
  if (ctx.method === "GET" && !subroute) {
    try {
      const perception = await clawvillePerception(config, sessionId);
      ctx.json(
        ctx.res,
        buildSessionState(
          config,
          buildCachedConnect(config, sessionId),
          perception,
        ),
      );
    } catch (err) {
      ctx.error(
        ctx.res,
        err instanceof Error ? err.message : "ClawVille state fetch failed.",
        502,
      );
    }
    return true;
  }

  if (ctx.method === "POST" && subroute === "message") {
    try {
      const body = await ctx.readJsonBody();
      const content =
        isRecord(body) && typeof body.content === "string"
          ? body.content.trim()
          : "";
      if (!content) {
        ctx.error(ctx.res, "Command content is required.", 400);
        return true;
      }
      const command = await buildMessageCommand(config, sessionId, content);
      const result = await buildCommandResult(
        config,
        sessionId,
        command.subroute,
        command.body,
      );
      ctx.json(ctx.res, result, result.success ? 200 : 400);
    } catch (err) {
      ctx.error(
        ctx.res,
        err instanceof Error ? err.message : "ClawVille command failed.",
        502,
      );
    }
    return true;
  }

  if (ctx.method === "POST" && commandSubroute) {
    try {
      const body = await ctx.readJsonBody();
      const needsPerception =
        commandSubroute === "move" || commandSubroute === "visit-building";
      const perception = needsPerception
        ? await clawvillePerception(config, sessionId)
        : null;
      const commandBody = normalizeDirectCommandBody(
        commandSubroute,
        body,
        perception,
      );
      const result = await buildCommandResult(
        config,
        sessionId,
        commandSubroute,
        commandBody,
      );
      ctx.json(ctx.res, result, result.success ? 200 : 400);
    } catch (err) {
      ctx.error(
        ctx.res,
        err instanceof Error ? err.message : "ClawVille command failed.",
        502,
      );
    }
    return true;
  }

  return false;
}
