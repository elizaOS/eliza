import { randomBytes } from "node:crypto";
import type http from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  AppLaunchDiagnostic,
  AppLaunchResult,
  AppLaunchSessionContext,
  AppRunSessionContext,
  AppSessionActivityItem,
  AppSessionJsonValue,
  AppSessionState,
} from "@elizaos/shared";

import type { JournalGoal, JournalMemory } from "./journal/types.js";
import type {
  PerceptionGroundItem,
  PerceptionInventoryItem,
  PerceptionNpc,
  PerceptionPlayer,
  PerceptionSkill,
  PerceptionSnapshot,
} from "./sdk/types.js";
import type { ScapeGameService } from "./services/game-service.js";

/**
 * HTTP route handlers for `@elizaos/app-scape`.
 *
 * ## Routes
 *
 *   GET  /api/apps/scape/viewer                     — iframe wrapper for the
 *                                                     xRSPS React client
 *   POST /api/apps/scape/prompt                     — legacy operator-steering
 *                                                     endpoint (pre-session)
 *   GET  /api/apps/scape/journal                    — recent memories (JSON)
 *   GET  /api/apps/scape/goals                      — current goals (JSON)
 *   GET  /api/apps/scape/session/:sessionId         — session snapshot
 *   POST /api/apps/scape/session/:sessionId/message — operator goal / verb
 *   POST /api/apps/scape/session/:sessionId/control — pause|resume
 *
 * The session-scoped message/control routes are the path elizaOS uses
 * when the operator types in the eliza Apps UI. We alias the
 * behaviour to the legacy `/prompt` handler so both paths share the
 * same `ScapeGameService.applyOperatorMessage` plumbing.
 *
 * ## Bodies
 *
 * Requests may arrive as JSON (Content-Type `application/json`) or as
 * raw text. The host's built-in `readJsonBody` helper is JSON-only, so for
 * non-JSON content types we read the raw request body ourselves and fall
 * back to treating it as a raw text directive.
 *
 * ## Responses
 *
 * Viewer → `text/html`
 * Everything else → `application/json; charset=utf-8`.
 *
 * ## Why a wrapper HTML and not a direct `launchUrl` iframe?
 *
 *   1. The xRSPS client is served by the craco dev server which sets
 *      its own CSP. We want our own CSP `frame-ancestors` controlling
 *      where eliza hosts can embed us, without mutating the client.
 *   2. Serving the wrapper from the eliza host gives us a single URL
 *      to point authenticated sessions at (we can inject a
 *      postMessage bridge for auto-login later).
 */

const APP_NAME = "@elizaos/app-scape";
const APP_DISPLAY_NAME = "'scape";
const VIEWER_ROUTE_PATH = "/api/apps/scape/viewer";
const PROMPT_ROUTE_PATH = "/api/apps/scape/prompt";
const JOURNAL_ROUTE_PATH = "/api/apps/scape/journal";
const GOALS_ROUTE_PATH = "/api/apps/scape/goals";
const SESSION_ROUTE_PREFIX = "/api/apps/scape/session/";

/**
 * Default URL the viewer iframe loads. Points at the production
 * 'scape deployment at Dexploarer/scape on Sevalla — the React
 * client (hosted as a Sevalla static site, with a CDN in front)
 * connects to the game server at wss://scape-96cxt.sevalla.app and
 * fetches the OSRS cache from
 * https://scape-cache-skrm0.sevalla.storage. All configuration is
 * baked into the client bundle at build time via REACT_APP_WS_URL /
 * REACT_APP_CACHE_URL.
 *
 * Override with `SCAPE_CLIENT_URL` via character secrets, runtime
 * settings, or the process env to point at a local dev client
 * (usually `http://localhost:3000`) or a fork's deployment.
 */
const DEFAULT_CLIENT_URL = "https://scape-client-2sqyc.kinsta.page";

// Same hosts the defense plugin whitelists; covers every runtime that
// might embed the eliza apps grid (browser, Electrobun native window,
// Capacitor mobile, Tauri, vscode webview, file://).
const VIEWER_FRAME_ANCESTORS_DIRECTIVE =
  "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* " +
  "http://[::1]:* http://[0:0:0:0:0:0:0:1]:* https://localhost:* " +
  "https://127.0.0.1:* https://[::1]:* https://[0:0:0:0:0:0:0:1]:* " +
  "electrobun: capacitor: capacitor-electron: app: tauri: file:";

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

interface RuntimeLike {
  character?: {
    settings?: { secrets?: Record<string, string> };
    secrets?: Record<string, string>;
  };
  getSetting?: (key: string) => string | null | undefined;
  agentId?: string;
  getService?: (name: string) => unknown;
}

function asRuntimeLike(runtime: unknown | null): RuntimeLike | null {
  if (!runtime || typeof runtime !== "object") return null;
  return runtime as RuntimeLike;
}

/**
 * Read a setting from either the eliza runtime (character secrets) or
 * the process env, in that order. Lets operators configure the plugin
 * per-character in a deployed eliza instance or globally via env.
 */
function resolveSettingLike(
  runtime: IAgentRuntime | null,
  key: string,
): string | undefined {
  const rt = asRuntimeLike(runtime);
  if (rt?.getSetting) {
    const fromRuntime = rt.getSetting(key);
    if (typeof fromRuntime === "string" && fromRuntime.trim().length > 0) {
      return fromRuntime.trim();
    }
  }
  const fromSecrets =
    rt?.character?.settings?.secrets?.[key] ?? rt?.character?.secrets?.[key];
  if (typeof fromSecrets === "string" && fromSecrets.trim().length > 0) {
    return fromSecrets.trim();
  }
  const fromEnv = process.env[key];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return undefined;
}

function resolveClientUrl(runtime: IAgentRuntime | null): string {
  return resolveSettingLike(runtime, "SCAPE_CLIENT_URL") ?? DEFAULT_CLIENT_URL;
}

/**
 * Derive a stable session id for this runtime. We key on
 * `runtime.agentId` — the canonical elizaOS identifier for the agent
 * — so every refresh cycle resolves to the same session. Previously
 * we used `Date.now()`, which meant every refresh pass (periodic,
 * driven by `packages/agent/src/services/app-manager.ts`) minted a
 * fresh id and invalidated the session-scoped message/control routes
 * the Apps UI relies on.
 *
 * If the runtime is absent we fall back to a module-scoped constant
 * so the session still validates on subsequent calls within the same
 * process — that scenario only happens in tests and dev stubs.
 */
let fallbackSessionId: string | null = null;
function resolveScapeSessionId(runtime: IAgentRuntime | null): string {
  const rt = asRuntimeLike(runtime);
  const agentId = rt?.agentId;
  if (typeof agentId === "string" && agentId.length > 0) {
    return `scape:${agentId}`;
  }
  if (!fallbackSessionId) {
    fallbackSessionId = `scape:${randomBytes(4).toString("hex")}`;
  }
  return fallbackSessionId;
}

// ---------------------------------------------------------------------------
// Viewer HTML
// ---------------------------------------------------------------------------

function buildViewerHtml(clientUrl: string): string {
  // Escape the URL for use in an HTML attribute. URLs shouldn't contain
  // these chars in normal use, but we prefer being safe over being lucky.
  const escaped = clientUrl.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${APP_DISPLAY_NAME}</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: #000;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #ccc;
  }
  #scape-frame {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    background: #000;
  }
  #scape-fallback {
    position: fixed;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    padding: 2rem;
    text-align: center;
  }
  #scape-fallback code {
    background: #1a1a1a;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    color: #f4b942;
  }
</style>
</head>
<body>
  <iframe
    id="scape-frame"
    src="${escaped}"
    allow="autoplay; fullscreen; clipboard-read; clipboard-write"
    sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
  ></iframe>
  <div id="scape-fallback">
    <h2>xRSPS client is not reachable</h2>
    <p>The 'scape plugin is trying to embed <code>${escaped}</code>.</p>
    <p>Start the xRSPS dev stack with <code>bun run dev</code>, or set
       <code>SCAPE_CLIENT_URL</code> to your deployed client.</p>
  </div>
  <script>
    // If the iframe fails to load within 5 seconds, flip to the
    // fallback message so operators know where to look.
    (function () {
      var frame = document.getElementById("scape-frame");
      var fallback = document.getElementById("scape-fallback");
      var loaded = false;
      frame.addEventListener("load", function () { loaded = true; });
      setTimeout(function () {
        if (!loaded) {
          frame.style.display = "none";
          fallback.style.display = "flex";
        }
      }, 5000);
    })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Response helpers (same shape defense / babylon use)
// ---------------------------------------------------------------------------

interface MutableResponse {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  removeHeader?: (name: string) => void;
  getHeader?: (name: string) => number | string | string[] | undefined;
  end: (body?: string) => void;
}

function applyViewerEmbedHeaders(response: MutableResponse): void {
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

  // The xRSPS React client *wants* SharedArrayBuffer (wasm threads), which
  // requires the page be cross-origin-isolated via COOP+COEP. But
  // cross-origin isolation also requires every cross-origin resource the
  // page loads — including this iframe's src — to opt in via a
  // `Cross-Origin-Resource-Policy` header. The live Sevalla deployment at
  // https://scape-client-2sqyc.kinsta.page does NOT send CORP headers
  // (only `access-control-allow-origin: *`), so setting
  // `Cross-Origin-Embedder-Policy: require-corp` causes WebKit to silently
  // refuse to load the iframe and the page's 5-second fallback trips —
  // breaking the PR's "click and play" primary flow.
  //
  // Until the Sevalla bucket is configured to emit
  // `Cross-Origin-Resource-Policy: cross-origin` (or the
  // `Cross-Origin-Embedder-Policy: require-corp` equivalent), we cannot
  // opt this page into cross-origin isolation without breaking manual
  // play. Leave these headers off for now; if/when xRSPS features that
  // need SharedArrayBuffer ship, the fix is an infra change upstream,
  // not a header change here.
}

function sendHtmlResponse(res: unknown, html: string): void {
  const response = res as MutableResponse;
  response.statusCode = 200;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  applyViewerEmbedHeaders(response);
  response.end(html);
}

/**
 * Send a JSON response. Mirrors `sendHtmlResponse` above but for the
 * agent-facing endpoints.
 */
function sendJsonResponse(
  res: unknown,
  status: number,
  payload: unknown,
): void {
  const response = res as MutableResponse;
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  const body = JSON.stringify(payload);
  response.end(body);
}

// ---------------------------------------------------------------------------
// Body reading
// ---------------------------------------------------------------------------

/**
 * Read the request body as a Node Buffer and decode it. We need this
 * because the host's `readJsonBody` helper rejects anything with a
 * non-JSON Content-Type, and our routes accept plain text. Size-capped at
 * 64KB so a pathological client can't OOM the eliza host.
 */
async function readRawBody(
  req: unknown,
  maxBytes = 64 * 1024,
): Promise<string | null> {
  if (!req || typeof req !== "object") return null;
  const incoming = req as NodeJS.ReadableStream & {
    readable?: boolean;
  };
  if (typeof (incoming as { on?: unknown }).on !== "function") return null;

  return new Promise<string | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    incoming.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.length;
      if (total > maxBytes) {
        settled = true;
        reject(new Error(`request body exceeded ${maxBytes} bytes`));
        return;
      }
      chunks.push(buf);
    });
    incoming.on("end", () => {
      if (chunks.length === 0) {
        finish(null);
        return;
      }
      finish(Buffer.concat(chunks).toString("utf-8"));
    });
    incoming.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Resolve an operator directive body to a plain string, regardless of
 * whether the caller sent JSON or raw text. Priority order:
 *
 *   1. If the host already parsed the body as JSON, check the known
 *      keys (`text`, `prompt`, `directive`, `message`, `content`).
 *   2. Otherwise read the raw body and fall back to treating the raw body
 *      as a plain text directive.
 *
 * Returns `null` if nothing usable was provided.
 */
async function readDirectiveBody(
  ctx: ScapeRouteContext,
): Promise<string | null> {
  const contentType = readHeader(ctx.req, "content-type").toLowerCase();
  const isJson = contentType.includes("application/json");

  // JSON path: delegate to the host so errors propagate normally.
  if (isJson) {
    try {
      const parsed = await ctx.readJsonBody();
      return extractDirectiveText(parsed);
    } catch {
      return null;
    }
  }

  // Anything else: read raw bytes and try to decode ourselves.
  let raw: string | null;
  try {
    raw = await readRawBody(ctx.req);
  } catch {
    return null;
  }
  if (!raw) return null;

  // Final fallback: the body is a plain text directive.
  return raw.trim() || null;
}

/**
 * Check a parsed body (object form) for the conventional keys the
 * Apps UI and the operator CLI use to carry the directive text. We
 * accept a few aliases so the plugin works regardless of which
 * convention the caller picked.
 */
function extractDirectiveText(body: unknown): string | null {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    for (const key of [
      "text",
      "prompt",
      "directive",
      "message",
      "content",
    ] as const) {
      const value = obj[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  if (typeof body === "string" && body.trim().length > 0) {
    return body.trim();
  }
  return null;
}

/**
 * Read a header off the request regardless of how Node / the host
 * wrapper is exposing it. Always lowercased.
 */
function readHeader(req: unknown, name: string): string {
  if (!req || typeof req !== "object") return "";
  const headers = (
    req as { headers?: Record<string, string | string[] | undefined> }
  ).headers;
  if (!headers) return "";
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------------
// Session state helpers
// ---------------------------------------------------------------------------

function getScapeService(
  runtime: IAgentRuntime | null,
): ScapeGameService | null {
  const rt = asRuntimeLike(runtime);
  const service = rt?.getService?.("scape_game");
  return (service as unknown as ScapeGameService | null) ?? null;
}

// ---------------------------------------------------------------------------
// Telemetry extraction — feeds the ScapeOperatorSurface in the eliza UI
// ---------------------------------------------------------------------------

/** Chebyshev distance on the OSRS tile grid. `null` means unknown. */
function tileDistance(
  from: { x: number; z: number } | null | undefined,
  to: { x: number; z: number } | null | undefined,
): number | null {
  if (!from || !to) return null;
  return Math.max(Math.abs(from.x - to.x), Math.abs(from.z - to.z));
}

function mapSelf(
  snapshot: PerceptionSnapshot | null,
): Record<string, AppSessionJsonValue> | null {
  if (!snapshot?.self) return null;
  const self = snapshot.self;
  return {
    name: self.name,
    combatLevel: self.combatLevel,
    hp: self.hp,
    maxHp: self.maxHp,
    level: self.level,
    runEnergy: self.runEnergy,
    inCombat: self.inCombat,
    position: { x: self.x, z: self.z },
    tick: snapshot.tick,
  };
}

function mapSkills(
  snapshot: PerceptionSnapshot | null,
  limit: number,
): AppSessionJsonValue[] {
  const skills = snapshot?.skills ?? [];
  // Pick the skills most likely to be interesting to an operator at a
  // glance: Hitpoints, combat stats, then everything else by level desc.
  const PRIORITY: ReadonlyArray<string> = [
    "Hitpoints",
    "Attack",
    "Strength",
    "Defence",
    "Ranged",
    "Magic",
    "Prayer",
  ];
  const byPriority = (a: PerceptionSkill, b: PerceptionSkill): number => {
    const ai = PRIORITY.indexOf(a.name);
    const bi = PRIORITY.indexOf(b.name);
    if (ai !== -1 || bi !== -1) {
      return (
        (ai === -1 ? PRIORITY.length : ai) - (bi === -1 ? PRIORITY.length : bi)
      );
    }
    return b.level - a.level;
  };
  return skills
    .slice()
    .sort(byPriority)
    .slice(0, limit)
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      level: skill.level,
      baseLevel: skill.baseLevel,
      xp: skill.xp,
    }));
}

function mapInventory(
  snapshot: PerceptionSnapshot | null,
  limit: number,
): AppSessionJsonValue[] {
  const items: PerceptionInventoryItem[] = snapshot?.inventory ?? [];
  return items.slice(0, limit).map((item) => ({
    slot: item.slot,
    itemId: item.itemId,
    name: item.name,
    count: item.count,
  }));
}

function mapNearbyNpcs(
  snapshot: PerceptionSnapshot | null,
  limit: number,
): AppSessionJsonValue[] {
  const self = snapshot?.self;
  const npcs: PerceptionNpc[] = snapshot?.nearbyNpcs ?? [];
  return npcs
    .slice()
    .map((npc): { npc: PerceptionNpc; distance: number | null } => ({
      npc,
      distance: tileDistance(self, npc),
    }))
    .sort((a, b) => {
      const ad = a.distance ?? Number.POSITIVE_INFINITY;
      const bd = b.distance ?? Number.POSITIVE_INFINITY;
      return ad - bd;
    })
    .slice(0, limit)
    .map(({ npc, distance }) => ({
      id: npc.id,
      defId: npc.defId,
      name: npc.name,
      combatLevel: npc.combatLevel ?? null,
      hp: npc.hp ?? null,
      position: { x: npc.x, z: npc.z },
      distance,
    }));
}

function mapNearbyPlayers(
  snapshot: PerceptionSnapshot | null,
  limit: number,
): AppSessionJsonValue[] {
  const self = snapshot?.self;
  const players: PerceptionPlayer[] = snapshot?.nearbyPlayers ?? [];
  return players
    .slice()
    .map((player) => ({ player, distance: tileDistance(self, player) }))
    .sort((a, b) => {
      const ad = a.distance ?? Number.POSITIVE_INFINITY;
      const bd = b.distance ?? Number.POSITIVE_INFINITY;
      return ad - bd;
    })
    .slice(0, limit)
    .map(({ player, distance }) => ({
      id: player.id,
      name: player.name,
      combatLevel: player.combatLevel,
      position: { x: player.x, z: player.z },
      distance,
    }));
}

function mapNearbyItems(
  snapshot: PerceptionSnapshot | null,
  limit: number,
): AppSessionJsonValue[] {
  const self = snapshot?.self;
  const items: PerceptionGroundItem[] = snapshot?.nearbyGroundItems ?? [];
  return items
    .slice()
    .map((item) => ({ item, distance: tileDistance(self, item) }))
    .sort((a, b) => {
      const ad = a.distance ?? Number.POSITIVE_INFINITY;
      const bd = b.distance ?? Number.POSITIVE_INFINITY;
      return ad - bd;
    })
    .slice(0, limit)
    .map(({ item, distance }) => ({
      itemId: item.itemId,
      name: item.name,
      count: item.count,
      position: { x: item.x, z: item.z },
      distance,
    }));
}

function mapGoal(
  goal: JournalGoal | null,
): Record<string, AppSessionJsonValue> | null {
  if (!goal) return null;
  return {
    id: goal.id,
    title: goal.title,
    notes: goal.notes ?? null,
    status: goal.status,
    source: goal.source,
    progress: goal.progress ?? null,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

function mapJournalMemories(
  memories: JournalMemory[] | null,
  limit: number,
): AppSessionJsonValue[] {
  if (!memories) return [];
  // Memories are stored newest-last — reverse for "most recent first".
  return memories
    .slice(-limit)
    .reverse()
    .map((memory) => ({
      id: memory.id,
      kind: memory.kind,
      text: memory.text,
      weight: memory.weight ?? null,
      timestamp: memory.timestamp,
      position:
        typeof memory.x === "number" && typeof memory.z === "number"
          ? { x: memory.x, z: memory.z }
          : null,
    }));
}

function buildScapeSessionState(
  runtime: IAgentRuntime | null,
): AppSessionState {
  const clientUrl = resolveClientUrl(runtime);
  const sessionId = resolveScapeSessionId(runtime);
  const service = getScapeService(runtime);
  const paused = service?.isPausedByOperator?.() === true;
  const operatorGoal = service?.getOperatorGoal?.() ?? "";
  const connectionStatus = service?.getStatus?.() ?? "idle";
  const perception = service?.getPerception?.() ?? null;
  const journalService = service?.getJournalService?.() ?? null;
  const journalState = journalService?.getState?.() ?? null;
  const activeGoal = journalService?.getActiveGoal?.() ?? null;
  const eventLog = service?.getRecentEventLog?.(16) ?? [];

  // Activity feed — the eliza run pane shows this as a timeline next
  // to the viewer. Each autonomous step emits an entry via
  // `pushEventLog`; we surface the latest 16 newest-first so the
  // operator can watch the agent's decisions land.
  const activity: AppSessionActivityItem[] = eventLog
    .slice()
    .reverse()
    .map((entry, index) => ({
      id: `scape-step-${entry.stepNumber}-${index}`,
      type: entry.action,
      message: entry.message,
      severity: entry.success ? "info" : "warning",
      timestamp: null,
    }));

  // Telemetry — structured JSON consumed by ScapeOperatorSurface in
  // packages/app-core. Keep nesting shallow and keys stable; the
  // surface pulls by name and tolerates missing fields.
  const telemetry: Record<string, AppSessionJsonValue> = {
    clientUrl,
    connectionStatus,
    pausedByOperator: paused,
    operatorGoal: operatorGoal.length > 0 ? operatorGoal : null,
    activeGoal: mapGoal(activeGoal),
    journal: {
      sessionCount: journalState?.sessionCount ?? 0,
      memoryCount: journalState?.memories?.length ?? 0,
      recent: mapJournalMemories(journalState?.memories ?? null, 8),
    },
    agent: mapSelf(perception),
    skills: mapSkills(perception, 7),
    inventory: mapInventory(perception, 12),
    nearby: {
      npcs: mapNearbyNpcs(perception, 6),
      players: mapNearbyPlayers(perception, 6),
      items: mapNearbyItems(perception, 6),
    },
  };

  // `status` drives the Apps UI health banner. Map the bot-SDK
  // connection state (idle | connecting | auth-pending | spawn-pending |
  // connected | reconnecting | closed | failed) onto the small set the UI
  // understands.
  const runtimeStatus: string = paused
    ? "paused"
    : connectionStatus === "connected"
      ? "ready"
      : connectionStatus === "connecting" ||
          connectionStatus === "auth-pending" ||
          connectionStatus === "spawn-pending" ||
          connectionStatus === "reconnecting"
        ? "connecting"
        : connectionStatus === "failed" || connectionStatus === "closed"
          ? "error"
          : "ready";

  return {
    sessionId,
    appName: APP_NAME,
    mode: "spectate-and-steer",
    status: runtimeStatus,
    displayName: APP_DISPLAY_NAME,
    summary:
      operatorGoal.length > 0
        ? `Operator goal: "${operatorGoal}"`
        : `Embedding xRSPS client at ${clientUrl}.`,
    canSendCommands: true,
    // The shared AppSessionState contract only allows the two
    // stock verbs here ("pause" | "resume"); the eliza Apps UI
    // renders them as buttons and handles the label/disabled
    // state itself based on `status`.
    controls: paused ? ["resume"] : ["pause"],
    suggestedPrompts: [
      "Walk to the Lumbridge cows and train attack.",
      "Pause and tell me what you see.",
      "Head to the Varrock west bank and deposit everything.",
    ],
    recommendations: [],
    activity,
    telemetry,
  };
}

// ---------------------------------------------------------------------------
// Public exports — these match the shape the eliza host imports from
// every curated app plugin.
// ---------------------------------------------------------------------------

export async function resolveLaunchSession(
  ctx: AppLaunchSessionContext,
): Promise<AppLaunchResult["session"]> {
  return buildScapeSessionState(ctx.runtime);
}

export async function refreshRunSession(
  ctx: AppRunSessionContext,
): Promise<AppLaunchResult["session"]> {
  // IMPORTANT: `resolveScapeSessionId` is keyed on runtime.agentId,
  // so this always returns the same sessionId for the same agent,
  // no matter how many refresh cycles the app-manager runs.
  return buildScapeSessionState(ctx.runtime);
}

/**
 * Called by the host app-manager when the user stops the Scape run.
 * Tears down the bot-SDK WebSocket connection and the autonomous-loop
 * timer so the game actually stops doing work server-side instead of
 * just unmounting the viewer iframe.
 *
 * Idempotent: if the service isn't running this is a no-op.
 */
export async function stopRun(ctx: { runtime: unknown | null }): Promise<void> {
  const service = getScapeService(ctx.runtime as IAgentRuntime | null);
  if (!service) {
    return;
  }
  await service.stop();
}

export async function collectLaunchDiagnostics(_ctx: {
  runtime: IAgentRuntime | null;
  session: AppSessionState | null;
}): Promise<AppLaunchDiagnostic[]> {
  // No diagnostics surfaced yet — the plugin surface area for
  // operator warnings lives in the Apps UI status banner.
  return [];
}

// ---------------------------------------------------------------------------
// Route dispatcher
// ---------------------------------------------------------------------------

interface ScapeRouteContext {
  method: string;
  pathname: string;
  url?: URL;
  runtime: unknown | null;
  error: (response: unknown, message: string, status?: number) => void;
  json: (response: unknown, data: unknown, status?: number) => void;
  readJsonBody: () => Promise<unknown>;
  req: http.IncomingMessage;
  res: unknown;
}

/**
 * Main HTTP entry point for `/api/apps/scape/*`. Returns true when the
 * plugin handled the request, false to let the host dispatch it
 * elsewhere.
 */
export async function handleAppRoutes(
  ctx: ScapeRouteContext,
): Promise<boolean> {
  // ─── Viewer ────────────────────────────────────────────────────
  if (ctx.method === "GET" && ctx.pathname === VIEWER_ROUTE_PATH) {
    try {
      const runtime =
        (asRuntimeLike(ctx.runtime) as IAgentRuntime | null) ?? null;
      const clientUrl = resolveClientUrl(runtime);
      sendHtmlResponse(ctx.res, buildViewerHtml(clientUrl));
    } catch (error) {
      ctx.error(
        ctx.res,
        error instanceof Error
          ? error.message
          : "Failed to render 'scape viewer.",
        500,
      );
    }
    return true;
  }

  // ─── Legacy /prompt route (pre-session Apps UI path) ───────────
  if (ctx.method === "POST" && ctx.pathname === PROMPT_ROUTE_PATH) {
    return handleOperatorDirective(ctx, /*sessionId*/ null);
  }

  // ─── Session-scoped routes (Apps UI run-steering) ──────────────
  //
  //   GET  /api/apps/scape/session/:id               — snapshot
  //   POST /api/apps/scape/session/:id/message       — directive
  //   POST /api/apps/scape/session/:id/control       — pause/resume
  //
  // See packages/agent/src/api/apps-routes.ts:232 for the caller —
  // the host proxies operator messages here after looking up the
  // run's sessionId in the session state we return from
  // buildScapeSessionState.
  if (ctx.pathname.startsWith(SESSION_ROUTE_PREFIX)) {
    return handleSessionRoute(ctx);
  }

  // ─── Journal ───────────────────────────────────────────────────
  if (ctx.method === "GET" && ctx.pathname === JOURNAL_ROUTE_PATH) {
    try {
      const runtime =
        (asRuntimeLike(ctx.runtime) as IAgentRuntime | null) ?? null;
      const service = getScapeService(runtime);
      const journal = service?.getJournalService?.();
      if (!journal) {
        sendJsonResponse(ctx.res, 503, {
          error: "journal not available",
        });
        return true;
      }
      const state = journal.getState();
      sendJsonResponse(ctx.res, 200, {
        agentId: state.agentId,
        displayName: state.displayName,
        sessionCount: state.sessionCount,
        memories: state.memories,
        updatedAt: state.updatedAt,
      });
    } catch (error) {
      sendJsonResponse(ctx.res, 500, {
        error:
          error instanceof Error ? error.message : "Failed to read journal",
      });
    }
    return true;
  }

  // ─── Goals ─────────────────────────────────────────────────────
  if (ctx.method === "GET" && ctx.pathname === GOALS_ROUTE_PATH) {
    try {
      const runtime =
        (asRuntimeLike(ctx.runtime) as IAgentRuntime | null) ?? null;
      const service = getScapeService(runtime);
      const journal = service?.getJournalService?.();
      if (!journal) {
        sendJsonResponse(ctx.res, 503, {
          error: "journal not available",
        });
        return true;
      }
      const active = journal.getActiveGoal();
      const all = journal.getGoals();
      sendJsonResponse(ctx.res, 200, {
        active,
        goals: all,
      });
    } catch (error) {
      sendJsonResponse(ctx.res, 500, {
        error: error instanceof Error ? error.message : "Failed to read goals",
      });
    }
    return true;
  }

  return false;
}

/**
 * Parse `/api/apps/scape/session/:id(/:subroute)?`. Returns null for
 * anything that doesn't match so the dispatcher can fall through.
 */
function parseSessionPath(pathname: string): {
  sessionId: string;
  subroute: "" | "message" | "control";
} | null {
  if (!pathname.startsWith(SESSION_ROUTE_PREFIX)) return null;
  const tail = pathname.slice(SESSION_ROUTE_PREFIX.length);
  const [rawId, rawSub = ""] = tail.split("/", 2);
  if (!rawId) return null;
  const subroute =
    rawSub === "" || rawSub === "message" || rawSub === "control"
      ? (rawSub as "" | "message" | "control")
      : null;
  if (subroute === null) return null;
  return {
    sessionId: decodeURIComponent(rawId),
    subroute,
  };
}

async function handleSessionRoute(ctx: ScapeRouteContext): Promise<boolean> {
  const parsed = parseSessionPath(ctx.pathname);
  if (!parsed) return false;

  const runtime = (asRuntimeLike(ctx.runtime) as IAgentRuntime | null) ?? null;
  const expectedSessionId = resolveScapeSessionId(runtime);

  // Reject cross-session operations. The host occasionally keeps a
  // stale sessionId around after a hard refresh; rather than accept
  // silently and act on the wrong run we return a structured error
  // so the host can re-resolve and retry.
  if (parsed.sessionId !== expectedSessionId) {
    sendJsonResponse(ctx.res, 404, {
      error: "session id does not match current 'scape session",
      expected: expectedSessionId,
      received: parsed.sessionId,
    });
    return true;
  }

  // GET session snapshot
  if (ctx.method === "GET" && parsed.subroute === "") {
    sendJsonResponse(ctx.res, 200, {
      success: true,
      session: buildScapeSessionState(runtime),
    });
    return true;
  }

  // POST operator message — forwarded to ScapeGameService
  if (ctx.method === "POST" && parsed.subroute === "message") {
    return handleOperatorDirective(ctx, parsed.sessionId);
  }

  // POST control — pause/resume
  if (ctx.method === "POST" && parsed.subroute === "control") {
    try {
      const service = getScapeService(runtime);
      if (!service) {
        sendJsonResponse(ctx.res, 503, {
          success: false,
          error: "scape_game service not available",
          disposition: "unsupported",
        });
        return true;
      }
      const raw = await readDirectiveBody(ctx);
      const action = (raw ?? "").toLowerCase();
      if (action === "pause") {
        service.pause();
      } else if (action === "resume") {
        service.resume();
      } else {
        sendJsonResponse(ctx.res, 400, {
          success: false,
          error: "control action must be 'pause' or 'resume'",
          disposition: "rejected",
        });
        return true;
      }
      sendJsonResponse(ctx.res, 200, {
        success: true,
        disposition: "accepted",
        message: action === "pause" ? "autoplay paused" : "autoplay resumed",
        session: buildScapeSessionState(runtime),
      });
    } catch (error) {
      sendJsonResponse(ctx.res, 500, {
        success: false,
        error: error instanceof Error ? error.message : "control action failed",
        disposition: "unsupported",
      });
    }
    return true;
  }

  return false;
}

/**
 * Shared directive handler for `/prompt` and
 * `/session/:id/message`. Reads the body (JSON or raw text),
 * hands it to the service's `applyOperatorMessage`, and responds with
 * a disposition the app-manager expects.
 */
async function handleOperatorDirective(
  ctx: ScapeRouteContext,
  sessionId: string | null,
): Promise<boolean> {
  try {
    const runtime =
      (asRuntimeLike(ctx.runtime) as IAgentRuntime | null) ?? null;
    const service = getScapeService(runtime);
    if (!service) {
      sendJsonResponse(ctx.res, 503, {
        success: false,
        error: "scape_game service not available",
        disposition: "unsupported",
      });
      return true;
    }

    const text = await readDirectiveBody(ctx);
    if (!text) {
      sendJsonResponse(ctx.res, 400, {
        success: false,
        error:
          "expected body with `text`, `prompt`, `directive`, `message`, or `content`",
        disposition: "rejected",
      });
      return true;
    }

    const outcome = service.applyOperatorMessage(text);
    sendJsonResponse(ctx.res, outcome.disposition === "queued" ? 202 : 200, {
      success: true,
      disposition: outcome.disposition,
      message: outcome.note,
      accepted: true,
      text,
      sessionId: sessionId ?? resolveScapeSessionId(runtime),
      session: buildScapeSessionState(runtime),
    });
  } catch (error) {
    sendJsonResponse(ctx.res, 500, {
      success: false,
      error:
        error instanceof Error ? error.message : "failed to accept directive",
      disposition: "unsupported",
    });
  }
  return true;
}
