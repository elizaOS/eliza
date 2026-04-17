/**
 * ClawVille app — Eliza plugin routes
 *
 * Registers at `/api/apps/clawville/*` inside Eliza's embedded HTTP server
 * and handles:
 *
 *   GET  /api/apps/clawville/viewer         — serves the embedded game HTML
 *   GET  /api/apps/clawville/session/:id    — current session state
 *   POST /api/apps/clawville/session/:id/command — execute an in-game command
 *   POST /api/apps/clawville/session/:id/control — pause/resume
 *
 * The `resolveLaunchSession` hook fires when the user clicks "Launch" on the
 * ClawVille app card. It POSTs to ClawVille's /api/agent/connect with the
 * Eliza runtime's agentId + character name (runtime-trust model — no token
 * exchange) and stashes the returned sessionId + wallet address back on the
 * runtime via setSetting.
 *
 * Pattern is adapted from app-babylon (thin proxy, simple session state) +
 * app-defense-of-the-agents (viewer HTML rewrite with bootstrap script
 * injection for embed-mode styling).
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  AppLaunchDiagnostic,
  AppLaunchResult,
  AppLaunchSessionContext,
  AppRunSessionContext,
  AppSessionActionResult,
  AppSessionState,
} from "@elizaos/shared/contracts/apps";

import {
  asRuntimeLike,
  clawvilleConnect,
  clawvillePerception,
  proxyClawvilleRequest,
  resolveClawvilleConfig,
  stashClawvilleSession,
  type ClawvilleConfig,
  type ClawvilleConnectResponse,
} from "./clawville-auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = "@clawville/app-clawville";
const APP_DISPLAY_NAME = "ClawVille";
const VIEWER_ROUTE_PATH = "/api/apps/clawville/viewer";
const VIEWER_FETCH_TIMEOUT_MS = 8_000;

/**
 * CSP frame-ancestors directive we send on the viewer HTML response so that
 * Eliza's various host shells (desktop Electrobun, mobile Capacitor, plus
 * the dev http://localhost and https://localhost cases) can embed us in an
 * iframe. Mirrors the value used by app-defense-of-the-agents.
 */
const VIEWER_FRAME_ANCESTORS_DIRECTIVE =
  "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* " +
  "http://[::1]:* http://[0:0:0:0:0:0:0:1]:* https://localhost:* " +
  "https://127.0.0.1:* https://[::1]:* https://[0:0:0:0:0:0:0:1]:* " +
  "electrobun: capacitor: capacitor-electron: app: tauri: file:";

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
): "move" | "visit-building" | "chat" | "buy" | "control" | null {
  if (pathValue.endsWith("/move")) return "move";
  if (pathValue.endsWith("/visit-building")) return "visit-building";
  if (pathValue.endsWith("/chat")) return "chat";
  if (pathValue.endsWith("/buy")) return "buy";
  if (pathValue.endsWith("/control")) return "control";
  return null;
}

// ---------------------------------------------------------------------------
// Session state construction
// ---------------------------------------------------------------------------

function buildSessionState(
  config: ClawvilleConfig,
  connectResult: ClawvilleConnectResponse | null,
  perception?: Record<string, unknown> | null,
): AppSessionState {
  const agentName = config.elizaCharacterName ?? "Eliza Agent";

  if (!connectResult) {
    return {
      sessionId: config.elizaAgentId ?? "clawville",
      appName: APP_NAME,
      mode: "spectate-and-steer",
      status: "connecting",
      displayName: APP_DISPLAY_NAME,
      agentId: config.elizaAgentId ?? undefined,
      canSendCommands: false,
      controls: ["pause", "resume"],
      summary: "Connecting to ClawVille...",
      goalLabel: null,
      suggestedPrompts: [
        "Visit the Salvage Workshop to learn about MCP",
        "Visit the Tide Clock Grotto to learn about cron jobs",
        "Visit the Memory Vault to learn about RAG",
      ],
      telemetry: null,
    };
  }

  const returningMarker = connectResult.isReturning ? "returning" : "new";
  const walletShort = connectResult.walletAddress
    ? `${connectResult.walletAddress.slice(0, 6)}...${connectResult.walletAddress.slice(-4)}`
    : "no wallet";
  const summaryParts = [
    `${agentName} (${returningMarker})`,
    `session #${connectResult.totalSessions}`,
    walletShort,
    `${connectResult.knowledge.length} skills learned`,
  ];

  return {
    sessionId: connectResult.sessionId,
    appName: APP_NAME,
    mode: "spectate-and-steer",
    status: "running",
    displayName: APP_DISPLAY_NAME,
    agentId: connectResult.agentId,
    canSendCommands: true,
    controls: ["pause", "resume"],
    summary: summaryParts.join(" | "),
    goalLabel: perception
      ? (perception.nearestBuilding as { id?: string } | null)?.id
        ? `Near ${(perception.nearestBuilding as { id?: string }).id}`
        : "Exploring the reef"
      : null,
    suggestedPrompts: [
      "Visit the Salvage Workshop",
      "Buy a knowledge book",
      "Chat with the building NPC",
      "Check my wallet balance",
    ],
    telemetry: {
      walletAddress: connectResult.walletAddress,
      botUuid: connectResult.uuid,
      isReturning: connectResult.isReturning,
      totalSessions: connectResult.totalSessions,
      knowledgeCount: connectResult.knowledge.length,
      identityType: connectResult.identityType,
      autonomyMode: connectResult.autonomyMode,
    },
  };
}

// ---------------------------------------------------------------------------
// Viewer HTML rewrite + embed header injection
// ---------------------------------------------------------------------------

/**
 * Build the bootstrap <script> we inject into the ClawVille viewer HTML.
 * When ClawVille's `/game` page loads inside a Eliza iframe, this script
 * runs in its DOM context and:
 *
 *   1. Sets localStorage flags that tell the ClawVille frontend to skip
 *      the login/create-pet overlay
 *   2. Hides any login-gate UI elements if they do render
 *   3. Adds a small "Watching {agentName}" banner so players know the
 *      Eliza agent is the one driving the avatar
 *
 * This mirrors the approach in app-defense-of-the-agents'
 * buildViewerShellInjection(agentName, viewerUrl) — fetch the real site,
 * inject a bootstrap block before </head>, let the SPA continue normally
 * with embed-mode flags pre-set.
 */
function buildViewerShellInjection(
  agentName: string,
  sessionId: string | null,
  viewerUrl: string,
): string {
  const safeAgentName = JSON.stringify(agentName || "Eliza Agent");
  const safeSessionId = JSON.stringify(sessionId ?? "");
  const safeFullSiteUrl = JSON.stringify(viewerUrl);

  return `<style id="eliza-clawville-embed-style">
#eliza-clawville-spectator-banner {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 9999;
  min-width: 200px;
  padding: 12px 14px;
  border: 1px solid rgba(0, 229, 255, 0.35);
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(10, 22, 40, 0.92), rgba(5, 14, 28, 0.88));
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45), 0 0 16px rgba(0, 229, 255, 0.08);
  color: #d6f4ff;
  font: 12px system-ui, -apple-system, "Segoe UI", sans-serif;
  pointer-events: auto;
}
#eliza-clawville-spectator-banner .eliza-clawville-title {
  color: #7fe6ff;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
  letter-spacing: 0.02em;
}
#eliza-clawville-spectator-banner .eliza-clawville-body {
  color: rgba(214, 244, 255, 0.72);
  line-height: 1.5;
  margin-bottom: 8px;
}
#eliza-clawville-spectator-banner .eliza-clawville-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid rgba(0, 229, 255, 0.4);
  color: #7fe6ff;
  text-decoration: none;
  background: rgba(0, 229, 255, 0.08);
  font-size: 11px;
}
#eliza-clawville-spectator-banner .eliza-clawville-link:hover {
  background: rgba(0, 229, 255, 0.15);
}
</style>
<script id="eliza-clawville-embedded-bootstrap">
(() => {
  const agentName = ${safeAgentName};
  const sessionId = ${safeSessionId};
  const fullSiteUrl = ${safeFullSiteUrl};

  // Tell the ClawVille SPA it's embedded inside a Eliza host so it can
  // skip landing-page overlays and login gates. ClawVille reads these
  // flags from localStorage on boot (it's a best-effort hint — if
  // ClawVille doesn't check them yet, the banner below still appears
  // and the rest of the app keeps working).
  try {
    localStorage.setItem("clawville-embed-mode", "eliza");
    localStorage.setItem("clawville-eliza-agent-name", agentName);
    if (sessionId) {
      localStorage.setItem("clawville-eliza-session-id", sessionId);
    }
    localStorage.setItem("landing-closed", "1");
  } catch {
    // localStorage may be blocked in some embed contexts — banner still works.
  }

  // Hide any landing-page / auth overlay that might render in the first
  // paint. IDs here are best-guess based on ClawVille's current frontend;
  // unknown IDs are no-ops. ClawVille can add more to this list by
  // observing what Eliza passes in its postMessage handshake (future).
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

  // postMessage the Eliza identity to the iframe — ClawVille's
  // /game page can listen on window.addEventListener('message', ...)
  // and call /api/auth/eliza-session-exchange to mint a ClawVille
  // guest cookie. (ClawVille-side wiring is planned but not required
  // for the plugin to load — if ClawVille ignores the message the
  // viewer still works in read-only mode.)
  window.parent?.postMessage?.(
    { type: "eliza-clawville-ready", agentName, sessionId },
    "*",
  );

  // Drop a small "Watching <agentName>" banner in the top-right so
  // players know the visible avatar is being steered by Eliza.
  const ensureBanner = () => {
    if (document.getElementById("eliza-clawville-spectator-banner")) return;
    if (!document.body) return;
    const banner = document.createElement("div");
    banner.id = "eliza-clawville-spectator-banner";
    const title = document.createElement("div");
    title.className = "eliza-clawville-title";
    title.textContent = "Watching " + agentName;
    const body = document.createElement("div");
    body.className = "eliza-clawville-body";
    body.textContent =
      "Eliza is steering this agent inside ClawVille. Open the full site if you want to create your own pet.";
    const link = document.createElement("a");
    link.className = "eliza-clawville-link";
    link.href = fullSiteUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open Full Game";
    banner.append(title, body, link);
    document.body.appendChild(banner);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureBanner, { once: true });
  } else {
    ensureBanner();
  }
  window.addEventListener("load", ensureBanner, { once: true });
})();
</script>`;
}

/**
 * Rewrite relative asset URLs in the fetched HTML so they resolve against
 * the real clawville.world origin instead of against Eliza's localhost.
 * Handles `src="..."`, `href="..."`, and `srcset="..."` attributes.
 */
function absolutizeViewerHtmlAssetUrls(
  html: string,
  baseUrl: string,
): string {
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
            const url =
              spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
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
    config.viewerUrl,
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
// Launch session resolver — fires on "Launch" click in Eliza's app UI
// ---------------------------------------------------------------------------

/**
 * Called by Eliza when the user clicks "Launch" on the ClawVille app card.
 * We POST to ClawVille's /api/agent/connect with runtime.agentId +
 * runtime.character.name, stash the returned session artifacts back onto
 * the runtime via setSetting, and return a populated AppSessionState for
 * Eliza's side panel to render.
 *
 * On failure we return a degraded "connecting" session state and log a
 * diagnostic — the user sees a clear error message in the panel without
 * the whole app launch being rejected.
 */
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
    console.error("[app-clawville] resolveLaunchSession error:", message);
    return {
      ...buildSessionState(config, null),
      status: "degraded",
      summary: message,
    };
  }
}

/**
 * Called periodically by Eliza to refresh the side-panel state after
 * launch. We avoid another /connect call (which would bump totalSessions)
 * and instead fetch perception data for the stored sessionId. If the
 * sessionId has expired server-side (e.g. container restart), we fall
 * back to a fresh /connect via resolveLaunchSession.
 */
/**
 * Called by the host app-manager when the user stops the ClawVille run.
 * ClawVille is a thin proxy to the external ClawVille API — session state
 * is stored in runtime settings (non-volatile) and the game server is
 * managed externally. No local resources to tear down. Iframe unmount is
 * sufficient. This hook is present so the app-manager lifecycle path
 * stays uniform across all game apps.
 */
export async function stopRun(): Promise<void> {
  // Intentional no-op — no server-side state to clean up.
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

  // Rebuild state with the cached connect-time data + fresh perception
  const fauxConnect: ClawvilleConnectResponse = {
    agentId: (ctx.session?.agentId as string) ?? `eliza:${config.elizaAgentId ?? "unknown"}`,
    sessionId,
    uuid: config.storedUuid ?? "",
    isReturning: true,
    totalSessions:
      (ctx.session?.telemetry as { totalSessions?: number } | null)?.totalSessions ?? 1,
    knowledge: [],
    identityType: "eliza",
    autonomyMode: "server-managed",
    walletAddress: config.storedWalletAddress ?? null,
  };

  return buildSessionState(config, fauxConnect, perception);
}

/**
 * Emit launch diagnostics (warnings shown in the Eliza UI below the app
 * card). We use this to surface config issues early — e.g. if the runtime
 * somehow has no agentId.
 */
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
        "ClawVille requires a Eliza runtime agentId. Restart the agent after configuring.",
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

  // GET /api/apps/clawville/session/:id — state poll
  if (ctx.method === "GET" && !subroute) {
    try {
      const perception = await clawvillePerception(config, sessionId);
      const fauxConnect: ClawvilleConnectResponse = {
        agentId:
          config.elizaAgentId
            ? `eliza:${config.elizaAgentId}`
            : "clawville",
        sessionId,
        uuid: config.storedUuid ?? "",
        isReturning: true,
        totalSessions: 1,
        knowledge: [],
        identityType: "eliza",
        autonomyMode: "server-managed",
        walletAddress: config.storedWalletAddress ?? null,
      };
      ctx.json(ctx.res, buildSessionState(config, fauxConnect, perception));
    } catch (err) {
      ctx.error(
        ctx.res,
        err instanceof Error ? err.message : "ClawVille state fetch failed.",
        502,
      );
    }
    return true;
  }

  // POST /api/apps/clawville/session/:id/control — pause/resume
  if (ctx.method === "POST" && subroute === "control") {
    // ClawVille has no server-side pause/resume concept yet — return a
    // no-op success so Eliza's UI doesn't show an error.
    const result: AppSessionActionResult = {
      success: true,
      message: "ClawVille pause/resume is a no-op (simulation runs server-side).",
      session: null,
    };
    ctx.json(ctx.res, result);
    return true;
  }

  // POST /api/apps/clawville/session/:id/{move,visit-building,chat,buy}
  if (ctx.method === "POST" && subroute) {
    try {
      const body = await ctx.readJsonBody();
      const response = await proxyClawvilleRequest(
        config,
        "POST",
        `/api/agent/${encodeURIComponent(sessionId)}/${subroute}`,
        body,
      );
      const data = await response.json().catch(() => ({}));
      ctx.json(ctx.res, data, response.ok ? 200 : response.status);
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
