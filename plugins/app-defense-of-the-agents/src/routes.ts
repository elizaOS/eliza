import { randomBytes } from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  AppLaunchDiagnostic,
  AppLaunchResult,
  AppLaunchSessionContext,
  AppRunSessionContext,
  AppSessionActionResult,
  AppSessionState,
} from "@elizaos/shared";

const APP_NAME = "@elizaos/app-defense-of-the-agents";
const APP_DISPLAY_NAME = "Defense of the Agents";
const DEFAULT_API_BASE_URL = "https://wc2-agentic-dev-3o6un.ondigitalocean.app";
const DEFAULT_VIEWER_URL = "https://www.defenseoftheagents.com/";
const DEFAULT_HERO_CLASS = "mage";
const DEFAULT_HERO_LANE = "mid";
const DEFAULT_GAME_ID = 1;
const GAME_SEARCH_LIMIT = 5;
const FETCH_TIMEOUT_MS = 4_000;
const VIEWER_FETCH_TIMEOUT_MS = 8_000;
const VIEWER_ROUTE_PATH = "/api/apps/defense-of-the-agents/viewer";
const VIEWER_FRAME_ANCESTORS_DIRECTIVE =
  "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* " +
  "http://[::1]:* http://[0:0:0:0:0:0:0:1]:* https://localhost:* " +
  "https://127.0.0.1:* https://[::1]:* https://[0:0:0:0:0:0:0:1]:* " +
  "electrobun: capacitor: capacitor-electron: app: tauri: file:";
const DEPLOY_MESSAGE_LIMIT = 140;
const EXPLICIT_MESSAGE_PREFIXES = ["say ", "message ", "announce "];
const GAME_LOOP_INTERVAL_MS = 30_000;
const STRATEGY_REVIEW_INTERVAL_MS = 30 * 60 * 1000;
const STRATEGY_HISTORY_LIMIT = 5;
const STRATEGY_SETTING_CURRENT = "DEFENSE_STRATEGY_CURRENT";
const STRATEGY_SETTING_BEST = "DEFENSE_STRATEGY_BEST";
const STRATEGY_SETTING_HISTORY = "DEFENSE_STRATEGY_HISTORY";
const AUTOPLAY_SETTING = "DEFENSE_AUTO_PLAY";

type HeroClass = "melee" | "ranged" | "mage";
type HeroLane = "top" | "mid" | "bot";

interface DefenseAbility {
  id: string;
  level: number;
}

interface DefenseHero {
  name: string;
  faction: string;
  class: HeroClass;
  lane: HeroLane;
  hp: number;
  maxHp: number;
  alive: boolean;
  level: number;
  xp: number;
  xpToNext: number;
  abilities: DefenseAbility[];
  abilityChoices?: string[];
}

interface DefenseLaneState {
  human: number;
  orc: number;
  frontline: number;
}

interface DefenseTowerState {
  faction: string;
  lane: HeroLane;
  hp: number;
  maxHp: number;
  alive: boolean;
}

interface DefenseBaseState {
  hp: number;
  maxHp: number;
}

interface DefenseGameState {
  tick: number;
  agents: Record<string, string[]>;
  lanes: Record<HeroLane, DefenseLaneState>;
  towers: DefenseTowerState[];
  bases: Record<string, DefenseBaseState>;
  heroes: DefenseHero[];
  winner: string | null;
}

interface DefenseRegistrationResponse {
  message?: string;
  apiKey?: string;
}

interface DefenseDeploymentResponse {
  message?: string;
  gameId?: number;
}

interface DefenseDeploymentBody {
  heroClass?: HeroClass;
  heroLane?: HeroLane;
  abilityChoice?: string;
  action?: "recall";
  message?: string;
}

interface RuntimeLike {
  agentId?: string;
  character?: {
    name?: string;
    settings?: {
      secrets?: Record<string, string>;
    };
    secrets?: Record<string, string>;
  };
  getSetting?: (key: string) => string | null | undefined;
  setSetting?: (key: string, value: string, secret?: boolean) => void;
}

interface SessionContext {
  apiBaseUrl: string;
  apiKey?: string;
  agentName: string;
  /**
   * Stable per-runtime identifier — preferred over `agentName` for keying
   * per-session state. Null when no runtime is attached (e.g. background
   * health probes). Two runtimes that happen to share a character name
   * must not share a cache entry.
   */
  agentId: string | null;
  preferredGameId?: number;
  defaultHeroClass: HeroClass;
  defaultLane: HeroLane;
  runtime: IAgentRuntime | null;
}

/**
 * Cache key for per-session state. Prefers `agentId` so concurrent runtimes
 * sharing a character name (test fixtures, multi-agent setups) get isolated
 * cache entries; falls back to `agentName` when no runtime is attached.
 */
function sessionCacheKey(ctx: SessionContext): string {
  return ctx.agentId ?? `name:${ctx.agentName}`;
}

interface LocatedHeroState {
  gameId: number;
  state: DefenseGameState;
  hero: DefenseHero | null;
}

// ---------------------------------------------------------------------------
// Strategy types — self-improving heuristic play
// ---------------------------------------------------------------------------

interface StrategyMetrics {
  ticksTracked: number;
  ticksAlive: number;
  levelStart: number;
  levelEnd: number;
  abilitiesLearned: number;
  laneControlSum: number;
  lastReviewedAt: number;
}

interface GameStrategy {
  version: number;
  heroClass: HeroClass;
  preferredLane: HeroLane;
  recallThreshold: number;
  abilityPriority: string[];
  laneReinforcementThreshold: number;
  metrics: StrategyMetrics;
}

const DEFAULT_STRATEGY: GameStrategy = {
  version: 1,
  heroClass: "mage",
  preferredLane: "mid",
  recallThreshold: 0.25,
  abilityPriority: [
    "fireball",
    "fortitude",
    "tornado",
    "fury",
    "raise_skeleton",
    "cleave",
    "volley",
    "critical_strike",
    "bloodlust",
    "thorns",
    "divine_shield",
  ],
  laneReinforcementThreshold: 3,
  metrics: {
    ticksTracked: 0,
    ticksAlive: 0,
    levelStart: 1,
    levelEnd: 1,
    abilitiesLearned: 0,
    laneControlSum: 0,
    lastReviewedAt: Date.now(),
  },
};

interface GameLoopHandle {
  timer: ReturnType<typeof setInterval>;
  reviewTimer: ReturnType<typeof setInterval>;
  autoPlay: boolean;
}

interface LaunchFailureInfo {
  message: string;
  ts: number;
}

/** Active game loops keyed by agentId. */
const activeLoops = new Map<string, GameLoopHandle>();
const recentLaunchFailures = new Map<string, LaunchFailureInfo>();
const LAUNCH_FAILURE_TTL_MS = 5 * 60 * 1000;

/** Recent activity ring buffer keyed by agentId — shown in the UI telemetry panel. */
interface ActivityEntry {
  ts: number;
  action: string;
  detail: string;
}
const ACTIVITY_BUFFER_LIMIT = 20;
const recentActivity = new Map<string, ActivityEntry[]>();

function pushActivity(agentId: string, action: string, detail: string): void {
  let buffer = recentActivity.get(agentId);
  if (!buffer) {
    buffer = [];
    recentActivity.set(agentId, buffer);
  }
  buffer.push({ ts: Date.now(), action, detail });
  if (buffer.length > ACTIVITY_BUFFER_LIMIT) {
    buffer.splice(0, buffer.length - ACTIVITY_BUFFER_LIMIT);
  }
}

function getRecentActivity(agentId: string | undefined): ActivityEntry[] {
  if (!agentId) return [];
  return recentActivity.get(agentId) ?? [];
}

function rememberLaunchFailure(agentName: string, message: string): void {
  recentLaunchFailures.set(agentName, {
    message,
    ts: Date.now(),
  });
}

function readLaunchFailure(agentName: string): LaunchFailureInfo | null {
  const failure = recentLaunchFailures.get(agentName);
  if (!failure) return null;
  if (Date.now() - failure.ts > LAUNCH_FAILURE_TTL_MS) {
    recentLaunchFailures.delete(agentName);
    return null;
  }
  return failure;
}

function clearLaunchFailure(agentName: string): void {
  recentLaunchFailures.delete(agentName);
}

/** Legacy heartbeat hook (always inactive — @elizaos/plugin-cron removed from the tree). */
function pushEvent(_agentId: string, _text: string): void {
  void _agentId;
  void _text;
}

const HERO_CLASS_VALUES = new Set<HeroClass>(["melee", "ranged", "mage"]);
const HERO_LANE_VALUES = new Set<HeroLane>(["top", "mid", "bot"]);

const KNOWN_ABILITIES = [
  "cleave",
  "thorns",
  "divine_shield",
  "volley",
  "bloodlust",
  "critical_strike",
  "fireball",
  "tornado",
  "raise_skeleton",
  "fortitude",
  "fury",
] as const;

function asRuntimeLike(value: unknown): RuntimeLike | null {
  return value && typeof value === "object" ? (value as RuntimeLike) : null;
}

function resolveSettingLike(
  runtime: IAgentRuntime | RuntimeLike | null | undefined,
  key: string,
): string | undefined {
  const fromRuntime = runtime?.getSetting?.(key);
  if (typeof fromRuntime === "string" && fromRuntime.trim().length > 0) {
    return fromRuntime.trim();
  }
  const fromEnv = process.env[key];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return undefined;
}

function persistSetting(
  runtime: IAgentRuntime | null,
  key: string,
  value: string,
  secret = false,
): void {
  process.env[key] = value;
  const runtimeLike = asRuntimeLike(runtime);
  runtimeLike?.setSetting?.(key, value, secret);

  const character = runtimeLike?.character;
  if (!character) return;

  if (!character.settings) {
    character.settings = {};
  }
  if (!character.settings.secrets) {
    character.settings.secrets = {};
  }
  character.settings.secrets[key] = value;

  if (!character.secrets) {
    character.secrets = {};
  }
  character.secrets[key] = value;
}

function normalizeHeroClass(value: string | undefined): HeroClass {
  const normalized = value?.trim().toLowerCase();
  if (normalized && HERO_CLASS_VALUES.has(normalized as HeroClass)) {
    return normalized as HeroClass;
  }
  return DEFAULT_HERO_CLASS;
}

function normalizeHeroLane(value: string | undefined): HeroLane {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return DEFAULT_HERO_LANE;
  if (normalized === "middle") return "mid";
  if (normalized === "bottom") return "bot";
  if (HERO_LANE_VALUES.has(normalized as HeroLane)) {
    return normalized as HeroLane;
  }
  return DEFAULT_HERO_LANE;
}

function normalizeGameId(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return parsed;
}

function truncateMessage(value: string): string {
  return value.trim().slice(0, DEPLOY_MESSAGE_LIMIT);
}

function resolveAgentName(
  runtime: IAgentRuntime | null,
  explicitSessionId?: string | null,
): string {
  // Prefer the persisted agent name when we have one — it's the name
  // registered with the remote server (may include a random suffix from
  // 409 conflict retry). The session ID from the URL is for routing only.
  const configured =
    resolveSettingLike(runtime, "DEFENSE_OF_THE_AGENTS_AGENT_NAME") ??
    resolveSettingLike(runtime, "BOT_NAME");
  if (configured?.trim()) {
    return configured.trim();
  }

  if (explicitSessionId?.trim()) {
    return explicitSessionId.trim();
  }

  const runtimeLike = asRuntimeLike(runtime);
  const characterName = runtimeLike?.character?.name?.trim();
  if (characterName) {
    return characterName;
  }

  const agentId = runtimeLike?.agentId?.trim();
  if (agentId) {
    return `eliza-${agentId.slice(0, 8)}`;
  }

  return "Eliza";
}

function resolveSessionContext(
  runtime: IAgentRuntime | null,
  explicitSessionId?: string | null,
): SessionContext {
  const agentId = asRuntimeLike(runtime)?.agentId;
  return {
    apiBaseUrl: (
      resolveSettingLike(runtime, "DEFENSE_OF_THE_AGENTS_API_URL") ??
      DEFAULT_API_BASE_URL
    ).replace(/\/+$/, ""),
    apiKey: resolveSettingLike(runtime, "DEFENSE_OF_THE_AGENTS_API_KEY"),
    agentName: resolveAgentName(runtime, explicitSessionId),
    agentId: typeof agentId === "string" && agentId.length > 0 ? agentId : null,
    preferredGameId: normalizeGameId(
      resolveSettingLike(runtime, "DEFENSE_OF_THE_AGENTS_GAME_ID"),
    ),
    defaultHeroClass: normalizeHeroClass(
      resolveSettingLike(runtime, "DEFENSE_OF_THE_AGENTS_DEFAULT_HERO_CLASS"),
    ),
    defaultLane: normalizeHeroLane(
      resolveSettingLike(runtime, "DEFENSE_OF_THE_AGENTS_DEFAULT_LANE"),
    ),
    runtime,
  };
}

function resolveViewerUrl(runtime: IAgentRuntime | null): string {
  return (
    resolveSettingLike(runtime, "DEFENSE_OF_THE_AGENTS_VIEWER_URL") ??
    DEFAULT_VIEWER_URL
  ).trim();
}

function absolutizeViewerHtmlAssetUrls(
  html: string,
  viewerUrl: string,
): string {
  const origin = new URL(viewerUrl).origin.replace(/\/+$/, "");

  return html
    .replace(
      /(src|href)=("|')\/(?!\/)/g,
      (_match, attribute: string, quote: string) =>
        `${attribute}=${quote}${origin}/`,
    )
    .replace(
      /url\((["']?)\/(?!\/)/g,
      (_match, quote: string) => `url(${quote}${origin}/`,
    );
}

function buildViewerShellInjection(viewerUrl: string): string {
  const viewerBaseUrl = new URL("./", viewerUrl).toString();

  return `<base id="eliza-defense-viewer-base" href="${viewerBaseUrl}">
<style id="eliza-defense-embedded-style">
html, body { background: #000 !important; }
#landing-overlay,
#auth-modal,
#class-modal,
#landing-reopen,
#profile-panel,
#leaderboard-panel,
#store-panel {
  display: none !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
#join-btn,
#lane-switcher,
#leaderboard-toggle,
#store-toggle {
  display: none !important;
}
#scoreboard-toggle {
  top: 18px !important;
}
#scoreboard-panel {
  top: 54px !important;
}
#bottom-hud {
  transform: translateX(-50%) !important;
}
</style>
<script id="eliza-defense-embedded-bootstrap">
(() => {
  const hiddenIds = [
    "landing-overlay",
    "auth-modal",
    "class-modal",
    "landing-reopen",
    "profile-panel",
    "leaderboard-panel",
    "store-panel",
  ];
  const hiddenSelectors = [
    "#join-btn",
    "#lane-switcher",
    "#leaderboard-toggle",
    "#store-toggle",
  ];
  let observerApplying = false;
  let observerPending = false;
  let observerScheduled = false;

  const hideNode = (node) => {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    let changed = false;
    if (node.classList.contains("open")) {
      node.classList.remove("open");
      changed = true;
    }
    if (!node.classList.contains("hidden")) {
      node.classList.add("hidden");
      changed = true;
    }
    if (node.style.display !== "none") {
      node.style.display = "none";
      changed = true;
    }
    if (node.style.opacity !== "0") {
      node.style.opacity = "0";
      changed = true;
    }
    if (node.style.pointerEvents !== "none") {
      node.style.pointerEvents = "none";
      changed = true;
    }
    return changed;
  };

  const scheduleEmbeddedViewerMode = () => {
    if (observerScheduled) {
      return;
    }
    observerScheduled = true;
    queueMicrotask(() => {
      observerScheduled = false;
      applyEmbeddedViewerMode();
    });
  };

  const applyEmbeddedViewerMode = () => {
    if (observerApplying) {
      observerPending = true;
      return;
    }

    observerApplying = true;
    try {
      localStorage.setItem("landing-closed", "1");
      for (const id of hiddenIds) {
        hideNode(document.getElementById(id));
      }
      for (const selector of hiddenSelectors) {
        hideNode(document.querySelector(selector));
      }

      const scoreboardToggle = document.getElementById("scoreboard-toggle");
      if (
        scoreboardToggle instanceof HTMLElement &&
        scoreboardToggle.style.top !== "18px"
      ) {
        scoreboardToggle.style.top = "18px";
      }

      const scoreboardPanel = document.getElementById("scoreboard-panel");
      if (
        scoreboardPanel instanceof HTMLElement &&
        scoreboardPanel.style.top !== "54px"
      ) {
        scoreboardPanel.style.top = "54px";
      }

      if (document.documentElement.dataset.elizaDefenseViewer !== "embedded") {
        document.documentElement.dataset.elizaDefenseViewer = "embedded";
      }
    } finally {
      observerApplying = false;
      if (observerPending) {
        observerPending = false;
        scheduleEmbeddedViewerMode();
      }
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyEmbeddedViewerMode, {
      once: true,
    });
  } else {
    applyEmbeddedViewerMode();
  }

  window.addEventListener("load", applyEmbeddedViewerMode, { once: true });

  const observer = new MutationObserver(() => {
    scheduleEmbeddedViewerMode();
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  window.addEventListener(
    "beforeunload",
    () => {
      observer.disconnect();
    },
    { once: true },
  );
})();
</script>`;
}

async function buildEmbeddedViewerHtml(
  runtime: IAgentRuntime | null,
): Promise<string> {
  const viewerUrl = resolveViewerUrl(runtime);
  const response = await fetch(viewerUrl, {
    signal: AbortSignal.timeout(VIEWER_FETCH_TIMEOUT_MS),
  });
  const html = await response.text();

  if (!response.ok) {
    throw new Error(
      `Defense viewer request failed (${response.status}): ${html.trim() || response.statusText}`,
    );
  }

  const absolutizedHtml = absolutizeViewerHtmlAssetUrls(html, viewerUrl);
  const injection = buildViewerShellInjection(viewerUrl);

  if (absolutizedHtml.includes("</head>")) {
    return absolutizedHtml.replace("</head>", `${injection}</head>`);
  }

  return `${injection}${absolutizedHtml}`;
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

async function fetchJson<T>(url: URL, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const text = await response.text();
  const data = text.trim().length > 0 ? (JSON.parse(text) as T) : ({} as T);

  if (!response.ok) {
    throw new Error(
      `Defense of the Agents API error (${response.status}): ${text.trim() || response.statusText}`,
    );
  }

  return data;
}

/** Short-lived cache for game state (avoids duplicate fetches within one request flow). */
const gameStateCache = new Map<
  string,
  { state: DefenseGameState; ts: number }
>();
const GAME_STATE_CACHE_TTL_MS = 5_000;

/** Last-known-good session state cache — returned when remote API is temporarily unavailable. */
const sessionStateCache = new Map<
  string,
  { session: AppSessionState; ts: number }
>();
const SESSION_STATE_CACHE_TTL_MS = 15_000;

async function fetchGameState(
  apiBaseUrl: string,
  gameId: number,
): Promise<DefenseGameState> {
  const cacheKey = `${apiBaseUrl}:${gameId}`;
  const cached = gameStateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < GAME_STATE_CACHE_TTL_MS) {
    return cached.state;
  }

  const url = new URL("/api/game/state", apiBaseUrl);
  url.searchParams.set("game", String(gameId));
  const state = await fetchJson<DefenseGameState>(url);
  gameStateCache.set(cacheKey, { state, ts: Date.now() });
  return state;
}

function findHero(
  state: DefenseGameState,
  agentName: string,
): DefenseHero | null {
  return (
    state.heroes.find(
      (hero) =>
        hero.name.trim().toLowerCase() === agentName.trim().toLowerCase(),
    ) ?? null
  );
}

async function locateHeroState(
  ctx: Pick<SessionContext, "apiBaseUrl" | "agentName" | "preferredGameId">,
): Promise<LocatedHeroState> {
  // Fast path: if we have a preferred game ID, try only that one.
  // This avoids scanning all games and hitting rate limits.
  if (ctx.preferredGameId) {
    try {
      const state = await fetchGameState(ctx.apiBaseUrl, ctx.preferredGameId);
      const hero = findHero(state, ctx.agentName);
      if (hero) {
        return { gameId: ctx.preferredGameId, state, hero };
      }
      // Hero not found in preferred game — scan others (hero may have been
      // assigned to a different game by the server after a restart)
      const others = Array.from(
        { length: GAME_SEARCH_LIMIT },
        (_, i) => i + 1,
      ).filter((id) => id !== ctx.preferredGameId);

      for (const gameId of others) {
        try {
          const otherState = await fetchGameState(ctx.apiBaseUrl, gameId);
          const otherHero = findHero(otherState, ctx.agentName);
          if (otherHero) {
            return { gameId, state: otherState, hero: otherHero };
          }
        } catch {}
      }
      // Hero nowhere — return preferred game state as fallback
      return { gameId: ctx.preferredGameId, state, hero: null };
    } catch {
      // Preferred game fetch failed (rate limit, network) — propagate so
      // caller can surface the error rather than silently returning stale data
      throw new Error(
        `Failed to fetch game state for game ${ctx.preferredGameId}. The remote API may be rate-limiting requests.`,
      );
    }
  }

  // No preferred game — scan sequentially
  let fallbackState: LocatedHeroState | null = null;
  for (let gameId = 1; gameId <= GAME_SEARCH_LIMIT; gameId++) {
    try {
      const state = await fetchGameState(ctx.apiBaseUrl, gameId);
      const hero = findHero(state, ctx.agentName);
      if (!fallbackState) {
        fallbackState = { gameId, state, hero };
      }
      if (hero) {
        return { gameId, state, hero };
      }
    } catch {}
  }

  if (fallbackState) return fallbackState;

  // Last resort — fetch game 1
  const state = await fetchGameState(ctx.apiBaseUrl, DEFAULT_GAME_ID);
  return { gameId: DEFAULT_GAME_ID, state, hero: null };
}

async function registerAgent(ctx: SessionContext): Promise<string> {
  const url = new URL("/api/agents/register", ctx.apiBaseUrl);

  let response: DefenseRegistrationResponse;
  try {
    response = await fetchJson<DefenseRegistrationResponse>(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentName: ctx.agentName,
      }),
    });
  } catch (err) {
    // 409 = agent name already taken. Try re-registering with a suffixed name.
    if (err instanceof Error && err.message.includes("409")) {
      const suffixed = `${ctx.agentName}${randomBytes(2).toString("hex")}`;
      const retryResponse = await fetchJson<DefenseRegistrationResponse>(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentName: suffixed }),
      });
      if (retryResponse.apiKey?.trim()) {
        ctx.agentName = suffixed;
        persistSetting(
          ctx.runtime,
          "DEFENSE_OF_THE_AGENTS_AGENT_NAME",
          suffixed,
        );
        persistSetting(
          ctx.runtime,
          "DEFENSE_OF_THE_AGENTS_API_KEY",
          retryResponse.apiKey.trim(),
          true,
        );
        return retryResponse.apiKey.trim();
      }
    }
    throw err;
  }

  if (!response.apiKey?.trim()) {
    throw new Error(
      "Defense of the Agents register response did not include an API key.",
    );
  }

  persistSetting(
    ctx.runtime,
    "DEFENSE_OF_THE_AGENTS_AGENT_NAME",
    ctx.agentName,
  );
  persistSetting(
    ctx.runtime,
    "DEFENSE_OF_THE_AGENTS_API_KEY",
    response.apiKey.trim(),
    true,
  );

  return response.apiKey.trim();
}

async function ensureApiKey(ctx: SessionContext): Promise<string> {
  if (ctx.apiKey?.trim()) {
    persistSetting(
      ctx.runtime,
      "DEFENSE_OF_THE_AGENTS_AGENT_NAME",
      ctx.agentName,
    );
    return ctx.apiKey.trim();
  }
  return registerAgent(ctx);
}

async function deployHero(
  ctx: SessionContext,
  body: DefenseDeploymentBody,
): Promise<DefenseDeploymentResponse> {
  const apiKey = await ensureApiKey(ctx);
  const url = new URL("/api/strategy/deployment", ctx.apiBaseUrl);
  const response = await fetchJson<DefenseDeploymentResponse>(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (typeof response.gameId === "number" && Number.isFinite(response.gameId)) {
    persistSetting(
      ctx.runtime,
      "DEFENSE_OF_THE_AGENTS_GAME_ID",
      String(response.gameId),
    );
  }

  return response;
}

function toAbilityLabel(abilityId: string): string {
  return abilityId
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Strategy persistence
// ---------------------------------------------------------------------------

function resolveStrategy(runtime: IAgentRuntime | null): GameStrategy {
  const raw = resolveSettingLike(runtime, STRATEGY_SETTING_CURRENT);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as GameStrategy;
      if (typeof parsed.version === "number") return parsed;
    } catch {
      // corrupt — fall through to default
    }
  }
  return { ...DEFAULT_STRATEGY, metrics: { ...DEFAULT_STRATEGY.metrics } };
}

function resolveBestStrategy(
  runtime: IAgentRuntime | null,
): GameStrategy | null {
  const raw = resolveSettingLike(runtime, STRATEGY_SETTING_BEST);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GameStrategy;
    if (typeof parsed.version === "number") return parsed;
  } catch {
    return null;
  }
  return null;
}

function persistStrategy(
  runtime: IAgentRuntime | null,
  strategy: GameStrategy,
): void {
  persistSetting(runtime, STRATEGY_SETTING_CURRENT, JSON.stringify(strategy));
}

function persistBestStrategy(
  runtime: IAgentRuntime | null,
  strategy: GameStrategy,
): void {
  persistSetting(runtime, STRATEGY_SETTING_BEST, JSON.stringify(strategy));
}

function appendStrategyHistory(
  runtime: IAgentRuntime | null,
  strategy: GameStrategy,
): void {
  let history: GameStrategy[] = [];
  const raw = resolveSettingLike(runtime, STRATEGY_SETTING_HISTORY);
  if (raw) {
    try {
      history = JSON.parse(raw) as GameStrategy[];
    } catch {
      history = [];
    }
  }
  history.push(strategy);
  if (history.length > STRATEGY_HISTORY_LIMIT) {
    history = history.slice(-STRATEGY_HISTORY_LIMIT);
  }
  persistSetting(runtime, STRATEGY_SETTING_HISTORY, JSON.stringify(history));
}

// ---------------------------------------------------------------------------
// Strategy scoring
// ---------------------------------------------------------------------------

function scoreStrategy(metrics: StrategyMetrics): number {
  if (metrics.ticksTracked === 0) return 0;
  const survivalRate = metrics.ticksAlive / metrics.ticksTracked;
  const levelGain = metrics.levelEnd - metrics.levelStart;
  const avgLaneControl =
    metrics.ticksTracked > 0
      ? metrics.laneControlSum / metrics.ticksTracked
      : 0;
  // Weighted: 40% survival, 30% level gain (normalized), 30% lane control (normalized)
  return (
    survivalRate * 0.4 +
    Math.min(levelGain / 5, 1) * 0.3 +
    Math.min(Math.max(avgLaneControl + 50, 0) / 100, 1) * 0.3
  );
}

// ---------------------------------------------------------------------------
// Heuristic game loop tick
// ---------------------------------------------------------------------------

function pickAbility(
  choices: string[],
  priority: string[],
): string | undefined {
  for (const preferred of priority) {
    if (choices.includes(preferred)) return preferred;
  }
  return choices[0];
}

function findWeakestAlliedLane(
  state: DefenseGameState,
  faction: string,
): HeroLane {
  const laneOrder: HeroLane[] = ["top", "mid", "bot"];
  let weakest: HeroLane = "mid";
  let worstDiff = Number.POSITIVE_INFINITY;
  for (const lane of laneOrder) {
    const ls = state.lanes[lane];
    const diff = faction === "orc" ? ls.orc - ls.human : ls.human - ls.orc;
    if (diff < worstDiff) {
      worstDiff = diff;
      weakest = lane;
    }
  }
  return weakest;
}

function buildCompactSummary(
  hero: DefenseHero,
  state: DefenseGameState,
  gameId: number,
  strategy: GameStrategy,
): string {
  const hpPct = hero.maxHp > 0 ? Math.round((hero.hp / hero.maxHp) * 100) : 0;
  const lane = state.lanes[hero.lane];
  const alliedUnits = hero.faction === "orc" ? lane.orc : lane.human;
  const enemyUnits = hero.faction === "orc" ? lane.human : lane.orc;
  const abilityPart = hero.abilityChoices?.length
    ? ` Choices: ${hero.abilityChoices.join(", ")}.`
    : "";
  return (
    `[Game ${gameId}] ${toAbilityLabel(hero.class)} Lv${hero.level} ${hero.lane} lane, ` +
    `${hpPct}% HP (${hero.hp}/${hero.maxHp}), ${alliedUnits}v${enemyUnits} units.${abilityPart} ` +
    `Strategy v${strategy.version}.`
  );
}

function describeAction(
  action: string,
  hero: DefenseHero | null,
  state: DefenseGameState,
): string {
  if (action === "game-over")
    return `Game over — ${state.winner ?? "unknown"} wins`;
  if (action === "initial-deploy") return "Deployed hero into the arena";
  if (action === "respawning") return "Waiting to respawn...";
  if (action === "hold") {
    if (!hero) return "Holding position";
    const hpPct = hero.maxHp > 0 ? Math.round((hero.hp / hero.maxHp) * 100) : 0;
    return `Holding ${hero.lane} lane (${hpPct}% HP, Lv${hero.level})`;
  }
  if (action.startsWith("ability:")) {
    const ability = action.slice(8);
    return `Learned ${toAbilityLabel(ability)}`;
  }
  if (action === "ability+recall" || action.startsWith("ability+")) {
    return "Learned ability + recalling to base";
  }
  if (action === "recall") return "Recalling to base (low HP)";
  if (action.startsWith("move:")) {
    const lane = action.slice(5);
    return `Moving to ${lane} lane to reinforce`;
  }
  return action;
}

async function executeStrategyTick(
  ctx: SessionContext,
  strategy: GameStrategy,
): Promise<{
  deployed: boolean;
  action: string;
  hero: DefenseHero | null;
  state: DefenseGameState;
  gameId: number;
}> {
  const located = await locateHeroState(ctx);
  const { hero, state, gameId } = located;

  if (state.winner) {
    return { deployed: false, action: "game-over", hero, state, gameId };
  }

  if (!hero) {
    // Not deployed yet — deploy with strategy defaults
    await deployHero(ctx, {
      heroClass: strategy.heroClass,
      heroLane: strategy.preferredLane,
    });
    return {
      deployed: true,
      action: "initial-deploy",
      hero: null,
      state,
      gameId,
    };
  }

  if (!hero.alive) {
    return { deployed: false, action: "respawning", hero, state, gameId };
  }

  const deployment: DefenseDeploymentBody = {
    heroClass: hero.class,
    heroLane: hero.lane,
  };
  let action = "hold";
  let pickedAbility = false;

  // Priority 1: Pick ability if available (can combine with recall/move)
  if (hero.abilityChoices?.length) {
    const pick = pickAbility(hero.abilityChoices, strategy.abilityPriority);
    if (pick) {
      deployment.abilityChoice = pick;
      pickedAbility = true;
      action = `ability:${pick}`;
    }
  }

  // Priority 2: Recall if low HP
  const hpRatio = hero.maxHp > 0 ? hero.hp / hero.maxHp : 1;
  if (hpRatio <= strategy.recallThreshold && hpRatio > 0) {
    deployment.action = "recall";
    action = pickedAbility ? `ability+recall` : "recall";
  } else {
    // Priority 3: Reinforce weakest lane if differential exceeds threshold
    const weakest = findWeakestAlliedLane(state, hero.faction);
    const currentLane = state.lanes[hero.lane];
    const currentDiff =
      hero.faction === "orc"
        ? currentLane.orc - currentLane.human
        : currentLane.human - currentLane.orc;
    const weakestLane = state.lanes[weakest];
    const weakestDiff =
      hero.faction === "orc"
        ? weakestLane.orc - weakestLane.human
        : weakestLane.human - weakestLane.orc;

    if (
      weakest !== hero.lane &&
      weakestDiff < -strategy.laneReinforcementThreshold &&
      currentDiff > 0
    ) {
      deployment.heroLane = weakest;
      action = `move:${weakest}`;
    }
  }

  // Only deploy if there's something to do beyond holding
  if (action !== "hold") {
    await deployHero(ctx, deployment);
    return { deployed: true, action, hero, state, gameId };
  }

  return { deployed: false, action, hero, state, gameId };
}

// ---------------------------------------------------------------------------
// Strategy review (called every ~30 minutes)
// ---------------------------------------------------------------------------

function buildReviewSummary(
  current: GameStrategy,
  best: GameStrategy | null,
): string {
  const m = current.metrics;
  const survPct =
    m.ticksTracked > 0 ? Math.round((m.ticksAlive / m.ticksTracked) * 100) : 0;
  const avgLane =
    m.ticksTracked > 0 ? (m.laneControlSum / m.ticksTracked).toFixed(1) : "0";
  const currentScore = scoreStrategy(m).toFixed(3);

  let review =
    `Strategy Review v${current.version}: ` +
    `${toAbilityLabel(current.heroClass)} ${current.preferredLane} lane, ` +
    `recall@${Math.round(current.recallThreshold * 100)}%, ` +
    `priority: ${current.abilityPriority.slice(0, 3).join(">")}. ` +
    `Lv${m.levelStart}→${m.levelEnd}, survived ${survPct}%, ` +
    `lane control avg ${avgLane}, score=${currentScore}.`;

  if (best) {
    const bestScore = scoreStrategy(best.metrics).toFixed(3);
    review += ` Best: v${best.version} score=${bestScore}.`;
    const diff = scoreStrategy(m) - scoreStrategy(best.metrics);
    if (diff > 0) {
      review += " Current BEATS best!";
    } else if (diff < -0.05) {
      review += " Current underperforming — reverting to best.";
    } else {
      review += " Roughly even.";
    }
  }

  return review;
}

function runStrategyReview(runtime: IAgentRuntime | null): void {
  const current = resolveStrategy(runtime);
  const best = resolveBestStrategy(runtime);
  const currentScore = scoreStrategy(current.metrics);
  const bestScore = best ? scoreStrategy(best.metrics) : -1;

  const review = buildReviewSummary(current, best);

  // Push review to heartbeat
  const agentId = asRuntimeLike(runtime)?.agentId;
  if (agentId) {
    pushEvent(agentId, review);
  }

  // Promote or revert
  if (currentScore > bestScore) {
    persistBestStrategy(runtime, { ...current });
  }

  // Archive current strategy
  appendStrategyHistory(runtime, { ...current });

  // Reset metrics for next review cycle, bump version
  const nextStrategy: GameStrategy = {
    ...current,
    version: current.version + 1,
    metrics: {
      ticksTracked: 0,
      ticksAlive: 0,
      levelStart: current.metrics.levelEnd,
      levelEnd: current.metrics.levelEnd,
      abilitiesLearned: 0,
      laneControlSum: 0,
      lastReviewedAt: Date.now(),
    },
  };

  // If underperforming, revert to best strategy params but keep new version number
  if (best && currentScore < bestScore - 0.05) {
    nextStrategy.heroClass = best.heroClass;
    nextStrategy.preferredLane = best.preferredLane;
    nextStrategy.recallThreshold = best.recallThreshold;
    nextStrategy.abilityPriority = [...best.abilityPriority];
    nextStrategy.laneReinforcementThreshold = best.laneReinforcementThreshold;
  }

  persistStrategy(runtime, nextStrategy);
}

// ---------------------------------------------------------------------------
// Game loop lifecycle
// ---------------------------------------------------------------------------

function updateMetrics(
  strategy: GameStrategy,
  hero: DefenseHero | null,
  state: DefenseGameState,
  action?: string,
): void {
  strategy.metrics.ticksTracked += 1;
  if (hero?.alive) {
    strategy.metrics.ticksAlive += 1;
  }
  if (hero) {
    strategy.metrics.levelEnd = Math.max(strategy.metrics.levelEnd, hero.level);
    if (hero.lane) {
      const lane = state.lanes[hero.lane];
      const control =
        hero.faction === "orc" ? lane.orc - lane.human : lane.human - lane.orc;
      strategy.metrics.laneControlSum += control;
    }
  }
  if (action?.startsWith("ability:") || action?.startsWith("ability+")) {
    strategy.metrics.abilitiesLearned += 1;
  }
}

function startGameLoop(
  runtime: IAgentRuntime | null,
  ctx: SessionContext,
): void {
  const agentId = asRuntimeLike(runtime)?.agentId;
  if (!agentId) return;

  // Don't start a duplicate loop
  if (activeLoops.has(agentId)) return;

  let tickRunning = false;
  const timer = setInterval(() => {
    if (tickRunning) return; // skip if previous tick still in flight
    tickRunning = true;
    void (async () => {
      const strategy = resolveStrategy(runtime);
      try {
        // Re-resolve context each tick so preferredGameId stays current
        const tickCtx = resolveSessionContext(runtime, ctx.agentName);
        const result = await executeStrategyTick(tickCtx, strategy);
        updateMetrics(strategy, result.hero, result.state, result.action);
        persistStrategy(runtime, strategy);

        // Build a human-readable description of what happened
        const actionLabel = describeAction(
          result.action,
          result.hero,
          result.state,
        );
        pushActivity(agentId, result.action, actionLabel);

        if (result.hero) {
          pushEvent(
            agentId,
            buildCompactSummary(
              result.hero,
              result.state,
              result.gameId,
              strategy,
            ),
          );
        }
      } catch (err) {
        // Swallow tick errors — don't crash the loop
        const msg = err instanceof Error ? err.message : String(err);
        pushActivity(agentId, "error", msg);
        pushEvent(agentId, `[Game tick error] ${msg}`);
      } finally {
        tickRunning = false;
      }
    })();
  }, GAME_LOOP_INTERVAL_MS);

  const reviewTimer = setInterval(() => {
    runStrategyReview(runtime);
  }, STRATEGY_REVIEW_INTERVAL_MS);

  activeLoops.set(agentId, { timer, reviewTimer, autoPlay: true });
  persistSetting(runtime, AUTOPLAY_SETTING, "1");
}

function stopGameLoop(runtime: IAgentRuntime | null): void {
  const agentId = asRuntimeLike(runtime)?.agentId;
  if (!agentId) return;
  const handle = activeLoops.get(agentId);
  if (handle) {
    clearInterval(handle.timer);
    clearInterval(handle.reviewTimer);
    activeLoops.delete(agentId);
  }
  persistSetting(runtime, AUTOPLAY_SETTING, "0");
}

/**
 * Flush every per-agent in-memory cache for a stopped run. Called from
 * `stopRun` so a relaunch starts from a clean slate instead of inheriting
 * 15s of stale session state or a stale launch-failure marker. The
 * shared `gameStateCache` (keyed by API + gameId) is left alone — it
 * benefits other agents pointed at the same game.
 */
function clearAgentRunState(ctx: SessionContext): void {
  if (ctx.agentId) {
    recentActivity.delete(ctx.agentId);
  }
  sessionStateCache.delete(sessionCacheKey(ctx));
  recentLaunchFailures.delete(ctx.agentName);
}

function isAutoPlayActive(runtime: IAgentRuntime | null): boolean {
  const agentId = asRuntimeLike(runtime)?.agentId;
  if (!agentId) return false;
  // Check in-memory loop first, then fall back to persisted setting
  // (setting survives module re-import; Map doesn't)
  if (activeLoops.has(agentId)) return true;
  return resolveSettingLike(runtime, AUTOPLAY_SETTING) === "1";
}

function resetInMemoryStateForTests(): void {
  for (const handle of activeLoops.values()) {
    clearInterval(handle.timer);
    clearInterval(handle.reviewTimer);
  }
  activeLoops.clear();
  recentActivity.clear();
  gameStateCache.clear();
  sessionStateCache.clear();
}

// ---------------------------------------------------------------------------
// Strategy update parsing (from LLM or user commands)
// ---------------------------------------------------------------------------

function parseStrategyUpdate(
  content: string,
  current: GameStrategy,
): GameStrategy | null {
  const trimmed = content.trim();

  // Handle JSON strategy object: {"strategy": {...}}
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        strategy?: Partial<GameStrategy>;
      };
      // Only match if the JSON explicitly contains a "strategy" key
      if (!parsed.strategy || typeof parsed.strategy !== "object") return null;
      const update = parsed.strategy;

      const next = { ...current };
      if (typeof update.heroClass === "string") {
        next.heroClass = normalizeHeroClass(update.heroClass);
      }
      if (typeof update.preferredLane === "string") {
        next.preferredLane = normalizeHeroLane(update.preferredLane);
      }
      if (typeof update.recallThreshold === "number") {
        next.recallThreshold = Math.max(0, Math.min(1, update.recallThreshold));
      }
      if (Array.isArray(update.abilityPriority)) {
        next.abilityPriority = update.abilityPriority.filter(
          (a): a is string => typeof a === "string",
        );
      }
      if (typeof update.laneReinforcementThreshold === "number") {
        next.laneReinforcementThreshold = Math.max(
          0,
          update.laneReinforcementThreshold,
        );
      }
      next.version = current.version + 1;
      return next;
    } catch {
      return null;
    }
  }

  return null;
}

function buildSuggestedPrompts(
  state: DefenseGameState,
  hero: DefenseHero | null,
  ctx: Pick<SessionContext, "defaultHeroClass" | "defaultLane">,
): string[] {
  const prompts: string[] = [];

  if (!hero) {
    prompts.push(
      `Deploy as ${ctx.defaultHeroClass} in ${ctx.defaultLane} lane`,
    );
    prompts.push("Deploy as ranged in top lane");
    prompts.push("Deploy as melee in bot lane");
    return prompts;
  }

  const laneOrder: HeroLane[] = ["top", "mid", "bot"];
  for (const lane of laneOrder) {
    if (lane !== hero.lane) {
      prompts.push(`Move to ${lane} lane`);
    }
  }

  if (hero.abilityChoices?.length) {
    for (const choice of hero.abilityChoices.slice(0, 3)) {
      prompts.push(`Learn ${toAbilityLabel(choice)}`);
    }
  }

  const hpPercent = hero.maxHp > 0 ? hero.hp / hero.maxHp : 0;
  if (hero.alive && hpPercent <= 0.35) {
    prompts.push("Recall to base");
  }

  const pressureLane = laneOrder
    .map((lane) => ({
      lane,
      score:
        hero.faction === "orc"
          ? state.lanes[lane].orc - state.lanes[lane].human
          : state.lanes[lane].human - state.lanes[lane].orc,
    }))
    .sort((left, right) => left.score - right.score)[0]?.lane;
  if (pressureLane && pressureLane !== hero.lane) {
    prompts.push(`Reinforce ${pressureLane} lane`);
  }

  return Array.from(new Set(prompts)).slice(0, 4);
}

function buildSuggestedPromptsWithAutoPlay(
  state: DefenseGameState,
  hero: DefenseHero | null,
  ctx: Pick<SessionContext, "defaultHeroClass" | "defaultLane">,
  runtime: IAgentRuntime | null,
): string[] {
  const autoPlay = isAutoPlayActive(runtime);
  const prompts = buildSuggestedPrompts(state, hero, ctx);
  // Add auto-play toggle as first prompt
  prompts.unshift(autoPlay ? "Auto-play OFF" : "Auto-play ON");
  if (autoPlay) {
    prompts.push("Review strategy");
  }
  return prompts.slice(0, 4);
}

function buildSummary(
  hero: DefenseHero | null,
  state: DefenseGameState,
  gameId: number,
): string {
  if (!hero) {
    return `Agent registered. Send a deployment command to join game ${gameId}.`;
  }
  if (state.winner) {
    return `Game ${gameId} finished. ${state.winner} won.`;
  }
  const health = hero.maxHp > 0 ? `${hero.hp}/${hero.maxHp} HP` : "respawning";
  return `${toAbilityLabel(hero.class)} level ${hero.level} in ${hero.lane} lane, ${health}.`;
}

function buildGoalLabel(hero: DefenseHero | null): string | null {
  if (!hero) return "Deploy into the arena";
  if (hero.abilityChoices?.length) {
    return `Choose an ability for ${hero.name}`;
  }
  const hpPercent = hero.maxHp > 0 ? hero.hp / hero.maxHp : 0;
  if (hero.alive && hpPercent <= 0.35) {
    return "Low HP: consider recalling";
  }
  return `${toAbilityLabel(hero.class)} holding ${hero.lane} lane`;
}

function buildTelemetry(
  state: DefenseGameState,
  hero: DefenseHero | null,
  gameId: number,
  runtime: IAgentRuntime | null,
): AppSessionState["telemetry"] {
  const activeLane = hero ? state.lanes[hero.lane] : state.lanes.mid;
  const strategy = resolveStrategy(runtime);
  const best = resolveBestStrategy(runtime);
  const agentId = asRuntimeLike(runtime)?.agentId;
  return {
    gameId,
    tick: state.tick,
    winner: state.winner,
    heroFaction: hero?.faction ?? null,
    heroClass: hero?.class ?? null,
    heroLane: hero?.lane ?? null,
    heroLevel: hero?.level ?? null,
    heroHp: hero?.hp ?? null,
    heroMaxHp: hero?.maxHp ?? null,
    heroAlive: hero?.alive ?? null,
    heroAbilityChoices: hero?.abilityChoices?.length ?? 0,
    humanAgents: state.agents.human?.length ?? 0,
    orcAgents: state.agents.orc?.length ?? 0,
    laneHumanUnits: activeLane?.human ?? null,
    laneOrcUnits: activeLane?.orc ?? null,
    laneFrontline: activeLane?.frontline ?? null,
    autoPlay: isAutoPlayActive(runtime),
    strategyVersion: strategy.version,
    strategyScore: scoreStrategy(strategy.metrics),
    bestStrategyVersion: best?.version ?? null,
    bestStrategyScore: best ? scoreStrategy(best.metrics) : null,
    survivalRate:
      strategy.metrics.ticksTracked > 0
        ? strategy.metrics.ticksAlive / strategy.metrics.ticksTracked
        : null,
    // Strategy details for display
    recallThreshold: strategy.recallThreshold,
    preferredLane: strategy.preferredLane,
    abilityPriority: strategy.abilityPriority.slice(0, 3),
    ticksTracked: strategy.metrics.ticksTracked,
    abilitiesLearned: strategy.metrics.abilitiesLearned,
    // Recent activity feed
    recentActivity: getRecentActivity(agentId).map((e) => ({
      ts: e.ts,
      action: e.action,
      detail: e.detail,
    })),
  };
}

function buildSessionState(
  ctx: SessionContext,
  located: LocatedHeroState,
): AppSessionState {
  const { hero, state, gameId } = located;
  const status = state.winner
    ? "completed"
    : !hero
      ? "ready"
      : hero.alive
        ? "running"
        : "respawning";

  return {
    sessionId: ctx.agentName,
    appName: APP_NAME,
    mode: "spectate-and-steer",
    status,
    displayName: APP_DISPLAY_NAME,
    agentId: ctx.runtime?.agentId,
    canSendCommands: Boolean(
      ctx.apiKey ?? process.env.DEFENSE_OF_THE_AGENTS_API_KEY,
    ),
    controls: [],
    summary: buildSummary(hero, state, gameId),
    goalLabel: buildGoalLabel(hero),
    suggestedPrompts: buildSuggestedPromptsWithAutoPlay(
      state,
      hero,
      ctx,
      ctx.runtime,
    ),
    telemetry: buildTelemetry(state, hero, gameId, ctx.runtime),
  };
}

function normalizeErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  const trimmed = error.message.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function buildUnavailableSession(
  ctx: SessionContext,
  error: unknown,
): AppSessionState {
  const message = normalizeErrorMessage(
    error,
    "Defense control API is temporarily unavailable.",
  );
  const agentId = asRuntimeLike(ctx.runtime)?.agentId;
  return {
    sessionId: ctx.agentName,
    appName: APP_NAME,
    mode: "spectate-and-steer",
    status: "degraded",
    displayName: APP_DISPLAY_NAME,
    agentId,
    canSendCommands: false,
    controls: [],
    summary: `Defense control API unavailable: ${message}`,
    goalLabel: "Viewer is available. Retry once the Defense backend responds.",
    suggestedPrompts: [],
    telemetry: {
      apiBaseUrl: ctx.apiBaseUrl,
      viewerUrl: resolveViewerUrl(ctx.runtime),
      preferredGameId: ctx.preferredGameId ?? null,
      autoPlay: isAutoPlayActive(ctx.runtime),
      startupError: message,
      recentActivity: getRecentActivity(agentId).map((entry) => ({
        ts: entry.ts,
        action: entry.action,
        detail: entry.detail,
      })),
    },
  };
}

function readCachedSessionState(ctx: SessionContext): AppSessionState | null {
  return sessionStateCache.get(sessionCacheKey(ctx))?.session ?? null;
}

function clearCachedSessionState(ctx: SessionContext): void {
  sessionStateCache.delete(sessionCacheKey(ctx));
}

function buildCommandOnlySessionState(ctx: SessionContext): AppSessionState {
  const agentId = asRuntimeLike(ctx.runtime)?.agentId;
  return {
    sessionId: ctx.agentName,
    appName: APP_NAME,
    mode: "spectate-and-steer",
    status: "ready",
    displayName: APP_DISPLAY_NAME,
    agentId,
    canSendCommands: Boolean(
      ctx.apiKey ?? process.env.DEFENSE_OF_THE_AGENTS_API_KEY,
    ),
    controls: [],
    summary:
      "Strategy note recorded. Open the live viewer for current battlefield state.",
    goalLabel:
      "Use autoplay, lane, recall, or ability commands for direct play.",
    suggestedPrompts: ["Autoplay on", "Recall", "Go mid", "Use Fireball"],
    telemetry: {
      apiBaseUrl: ctx.apiBaseUrl,
      viewerUrl: resolveViewerUrl(ctx.runtime),
      preferredGameId: ctx.preferredGameId ?? null,
      autoPlay: isAutoPlayActive(ctx.runtime),
      recentActivity: getRecentActivity(agentId).map((entry) => ({
        ts: entry.ts,
        action: entry.action,
        detail: entry.detail,
      })),
    },
  };
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ");
}

function parseExplicitMessage(content: string): string | undefined {
  const trimmed = content.trim();
  const normalized = normalizeText(trimmed);
  for (const prefix of EXPLICIT_MESSAGE_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return truncateMessage(trimmed.slice(prefix.length));
    }
  }
  return undefined;
}

function parseAbilityChoice(
  content: string,
  hero: DefenseHero | null,
): string | undefined {
  const normalized = normalizeText(content);
  const choices = hero?.abilityChoices ?? KNOWN_ABILITIES;

  for (const choice of choices) {
    const label = normalizeText(choice);
    if (
      normalized.includes(label) ||
      normalized.includes(label.replace(/\s+/g, "")) ||
      normalized.includes(toAbilityLabel(choice).toLowerCase())
    ) {
      return choice;
    }
  }

  return undefined;
}

function parseStructuredDeployment(
  content: string,
): DefenseDeploymentBody | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const deployment: DefenseDeploymentBody = {};

    if (typeof parsed.heroClass === "string") {
      deployment.heroClass = normalizeHeroClass(parsed.heroClass);
    }
    if (typeof parsed.heroLane === "string") {
      deployment.heroLane = normalizeHeroLane(parsed.heroLane);
    }
    if (
      typeof parsed.abilityChoice === "string" &&
      parsed.abilityChoice.trim()
    ) {
      deployment.abilityChoice = parsed.abilityChoice.trim();
    }
    if (parsed.action === "recall") {
      deployment.action = "recall";
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      deployment.message = truncateMessage(parsed.message);
    }

    return deployment;
  } catch {
    return null;
  }
}

function isDeploymentControlCommand(
  content: string,
  hero: DefenseHero | null,
): boolean {
  const trimmed = content.trim();
  if (parseStructuredDeployment(trimmed)) return true;
  if (parseExplicitMessage(trimmed)) return true;

  const normalized = normalizeText(trimmed);
  if (
    /\b(melee|ranged|mage|top|mid|middle|bot|bottom|recall|heal|base|retreat)\b/.test(
      normalized,
    )
  ) {
    return true;
  }

  return Boolean(parseAbilityChoice(trimmed, hero));
}

function parseDeploymentCommand(
  content: string,
  ctx: SessionContext,
  hero: DefenseHero | null,
): DefenseDeploymentBody {
  const structured = parseStructuredDeployment(content);
  if (structured) {
    return {
      heroClass: structured.heroClass ?? hero?.class ?? ctx.defaultHeroClass,
      heroLane: structured.heroLane ?? hero?.lane ?? ctx.defaultLane,
      ...(structured.abilityChoice
        ? { abilityChoice: structured.abilityChoice }
        : {}),
      ...(structured.action ? { action: structured.action } : {}),
      ...(structured.message ? { message: structured.message } : {}),
    };
  }

  const normalized = normalizeText(content);
  const deployment: DefenseDeploymentBody = {
    heroClass: hero?.class ?? ctx.defaultHeroClass,
    heroLane: hero?.lane ?? ctx.defaultLane,
  };

  if (normalized.includes("melee")) deployment.heroClass = "melee";
  if (normalized.includes("ranged")) deployment.heroClass = "ranged";
  if (normalized.includes("mage")) deployment.heroClass = "mage";

  if (/\btop\b/.test(normalized)) deployment.heroLane = "top";
  if (/\bmid\b|\bmiddle\b/.test(normalized)) deployment.heroLane = "mid";
  if (/\bbot\b|\bbottom\b/.test(normalized)) deployment.heroLane = "bot";

  if (/\brecall\b|\bheal\b|\bbase\b|\bretreat\b/.test(normalized)) {
    deployment.action = "recall";
  }

  const abilityChoice = parseAbilityChoice(content, hero);
  if (abilityChoice) {
    deployment.abilityChoice = abilityChoice;
  }

  const explicitMessage = parseExplicitMessage(content);
  if (explicitMessage) {
    deployment.message = explicitMessage;
  }

  return deployment;
}

async function ensureJoinedGame(
  ctx: SessionContext,
): Promise<LocatedHeroState> {
  const current = await locateHeroState(ctx);
  if (current.hero) {
    if (current.gameId) {
      persistSetting(
        ctx.runtime,
        "DEFENSE_OF_THE_AGENTS_GAME_ID",
        String(current.gameId),
      );
    }
    return current;
  }

  const deployment = await deployHero(ctx, {
    heroClass: ctx.defaultHeroClass,
    heroLane: ctx.defaultLane,
  });
  const nextGameId =
    deployment.gameId ?? ctx.preferredGameId ?? DEFAULT_GAME_ID;
  // Clear cached state so we get fresh data with the newly deployed hero
  gameStateCache.delete(`${ctx.apiBaseUrl}:${nextGameId}`);
  const state = await fetchGameState(ctx.apiBaseUrl, nextGameId);
  return {
    gameId: nextGameId,
    state,
    hero: findHero(state, ctx.agentName),
  };
}

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

async function readSessionState(
  runtime: IAgentRuntime | null,
  sessionId?: string | null,
  autoJoin = false,
): Promise<AppSessionState> {
  const ctx = resolveSessionContext(runtime, sessionId);
  const cacheKey = sessionCacheKey(ctx);

  // Return fresh cache if within TTL (prevents hammering remote API on UI polls)
  const cached = sessionStateCache.get(cacheKey);
  if (
    cached &&
    Date.now() - cached.ts < SESSION_STATE_CACHE_TTL_MS &&
    !autoJoin
  ) {
    return cached.session;
  }

  try {
    const located = autoJoin
      ? await ensureJoinedGame(ctx)
      : await locateHeroState(ctx);

    if (typeof located.gameId === "number" && Number.isFinite(located.gameId)) {
      persistSetting(
        runtime,
        "DEFENSE_OF_THE_AGENTS_GAME_ID",
        String(located.gameId),
      );
    }

    const session = buildSessionState(ctx, located);
    sessionStateCache.set(cacheKey, { session, ts: Date.now() });
    return session;
  } catch (err) {
    // If remote API is temporarily unavailable, return last-known-good state
    if (cached) {
      return cached.session;
    }
    throw err;
  }
}

function okResponse(
  success: boolean,
  message: string,
  session?: AppSessionState | null,
): AppSessionActionResult {
  return {
    success,
    message,
    session: session ?? null,
  };
}

export async function resolveLaunchSession(
  ctx: AppLaunchSessionContext,
): Promise<AppLaunchResult["session"]> {
  const sessionCtx = resolveSessionContext(ctx.runtime, null);
  try {
    const session = await readSessionState(ctx.runtime, null, true);
    clearLaunchFailure(sessionCtx.agentName);

    // Start auto-play game loop on launch
    if (ctx.runtime && session.canSendCommands) {
      startGameLoop(ctx.runtime, sessionCtx);
      const launchAgentId = asRuntimeLike(ctx.runtime)?.agentId;
      if (launchAgentId) {
        pushActivity(
          launchAgentId,
          "launch",
          "Game session launched — auto-play started",
        );
      }
    }

    return session;
  } catch (error) {
    const degradedSession = buildUnavailableSession(sessionCtx, error);
    rememberLaunchFailure(
      sessionCtx.agentName,
      degradedSession.summary ?? "Defense launch degraded.",
    );
    const launchAgentId = asRuntimeLike(ctx.runtime)?.agentId;
    if (launchAgentId) {
      pushActivity(
        launchAgentId,
        "launch-error",
        degradedSession.summary ?? "Defense launch degraded.",
      );
    }
    return degradedSession;
  }
}

export async function refreshRunSession(
  ctx: AppRunSessionContext,
): Promise<AppLaunchResult["session"]> {
  const sessionCtx = resolveSessionContext(
    ctx.runtime,
    ctx.session?.sessionId ?? null,
  );
  try {
    const session = await readSessionState(
      ctx.runtime,
      ctx.session?.sessionId ?? null,
      false,
    );
    clearLaunchFailure(sessionCtx.agentName);
    return session;
  } catch (error) {
    const degradedSession = buildUnavailableSession(sessionCtx, error);
    rememberLaunchFailure(
      sessionCtx.agentName,
      degradedSession.summary ?? "Defense refresh degraded.",
    );
    return degradedSession;
  }
}

/**
 * Called by the host app-manager when a Defense of the Agents run is
 * stopped — explicitly via the Stop button, or implicitly by the
 * stale-run sweeper when the UI heartbeat goes silent. Stops the
 * auto-play game loop, the strategy-review timer, and flushes every
 * per-agent cache so a relaunch starts clean.
 *
 * Idempotent: every step is a no-op if the resource is already gone.
 */
export async function stopRun(ctx: { runtime: unknown | null }): Promise<void> {
  const runtime = ctx.runtime as IAgentRuntime | null;
  try {
    stopGameLoop(runtime);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[app-defense-of-the-agents] stopRun: stopGameLoop failed: ${msg}`,
    );
  }
  try {
    clearAgentRunState(resolveSessionContext(runtime, null));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[app-defense-of-the-agents] stopRun: clearAgentRunState failed: ${msg}`,
    );
  }
}

export async function collectLaunchDiagnostics(ctx: {
  runtime: IAgentRuntime | null;
  session: AppSessionState | null;
}): Promise<AppLaunchDiagnostic[]> {
  const agentName = resolveSessionContext(
    ctx.runtime,
    ctx.session?.sessionId ?? null,
  ).agentName;
  const launchFailure =
    (ctx.session?.status === "degraded" &&
    typeof ctx.session.summary === "string" &&
    ctx.session.summary.trim().length > 0
      ? {
          message: ctx.session.summary.trim(),
        }
      : null) ?? readLaunchFailure(agentName);

  if (!launchFailure) {
    return [];
  }

  return [
    {
      code: "defense-control-api-unavailable",
      severity: "warning",
      message: launchFailure.message,
    },
  ];
}

export async function handleAppRoutes(ctx: {
  method: string;
  pathname: string;
  url?: URL;
  runtime: unknown | null;
  error: (response: unknown, message: string, status?: number) => void;
  json: (response: unknown, data: unknown, status?: number) => void;
  readJsonBody: () => Promise<unknown>;
  res: unknown;
}): Promise<boolean> {
  const runtime = (asRuntimeLike(ctx.runtime) as IAgentRuntime | null) ?? null;

  if (ctx.method === "GET" && ctx.pathname === VIEWER_ROUTE_PATH) {
    try {
      sendHtmlResponse(ctx.res, await buildEmbeddedViewerHtml(runtime));
    } catch (error) {
      ctx.error(
        ctx.res,
        error instanceof Error
          ? error.message
          : "Defense viewer failed to load.",
        502,
      );
    }
    return true;
  }

  const sessionId = parseSessionId(ctx.pathname);
  if (!sessionId) return false;

  const subroute = parseSessionSubroute(ctx.pathname);

  try {
    // Auto-recover game loop if setting says ON but loop isn't running
    // (happens after server restart or module re-import)
    if (runtime && resolveSettingLike(runtime, AUTOPLAY_SETTING) === "1") {
      const agentId = asRuntimeLike(runtime)?.agentId;
      if (agentId && !activeLoops.has(agentId)) {
        const sessionCtx = resolveSessionContext(runtime, sessionId);
        startGameLoop(runtime, sessionCtx);
      }
    }

    if (ctx.method === "GET" && !subroute) {
      ctx.json(ctx.res, await readSessionState(runtime, sessionId));
      return true;
    }

    if (ctx.method === "POST" && subroute === "message") {
      const body = (await ctx.readJsonBody()) as { content?: string } | null;
      const content = body?.content?.trim();
      if (!content) {
        ctx.error(ctx.res, "Command content is required.", 400);
        return true;
      }

      const normalizedCmd = content
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .trim();

      const cmdAgentId = asRuntimeLike(runtime)?.agentId;

      // Handle auto-play toggle
      if (normalizedCmd === "autoplay on" || normalizedCmd === "auto play on") {
        const sessionCtx = resolveSessionContext(runtime, sessionId);
        startGameLoop(runtime, sessionCtx);
        clearCachedSessionState(sessionCtx);
        if (cmdAgentId)
          pushActivity(cmdAgentId, "auto-play-on", "Auto-play enabled");
        const refreshed = await readSessionState(runtime, sessionId);
        ctx.json(
          ctx.res,
          okResponse(
            true,
            "Auto-play enabled. Agent is now playing autonomously.",
            refreshed,
          ),
        );
        return true;
      }
      if (
        normalizedCmd === "autoplay off" ||
        normalizedCmd === "auto play off"
      ) {
        const sessionCtx = resolveSessionContext(runtime, sessionId);
        stopGameLoop(runtime);
        clearCachedSessionState(sessionCtx);
        if (cmdAgentId)
          pushActivity(cmdAgentId, "auto-play-off", "Auto-play disabled");
        const refreshed = await readSessionState(runtime, sessionId);
        ctx.json(
          ctx.res,
          okResponse(
            true,
            "Auto-play disabled. Send commands manually.",
            refreshed,
          ),
        );
        return true;
      }

      // Handle strategy review trigger
      if (
        normalizedCmd === "review strategy" ||
        normalizedCmd === "strategy review"
      ) {
        runStrategyReview(runtime);
        if (cmdAgentId)
          pushActivity(
            cmdAgentId,
            "strategy-review",
            "Manual strategy review triggered",
          );
        const refreshed = await readSessionState(runtime, sessionId);
        ctx.json(
          ctx.res,
          okResponse(true, "Strategy review completed.", refreshed),
        );
        return true;
      }

      // Handle strategy update (JSON)
      const strategyUpdate = parseStrategyUpdate(
        content,
        resolveStrategy(runtime),
      );
      if (strategyUpdate) {
        persistStrategy(runtime, {
          ...strategyUpdate,
          metrics: {
            ...resolveStrategy(runtime).metrics,
            lastReviewedAt: Date.now(),
          },
        });
        const refreshed = await readSessionState(runtime, sessionId);
        ctx.json(
          ctx.res,
          okResponse(
            true,
            `Strategy updated to v${strategyUpdate.version}.`,
            refreshed,
          ),
        );
        return true;
      }

      const sessionCtx = resolveSessionContext(runtime, sessionId);

      if (!isDeploymentControlCommand(content, null)) {
        if (cmdAgentId) {
          pushActivity(
            cmdAgentId,
            "strategy-note",
            `Strategy note: ${content.slice(0, 120)}`,
          );
        }
        const refreshed =
          readCachedSessionState(sessionCtx) ??
          buildCommandOnlySessionState(sessionCtx);
        ctx.json(
          ctx.res,
          okResponse(
            true,
            "Strategy note recorded. Use lane, recall, ability, or autoplay commands for direct control.",
            refreshed,
          ),
        );
        return true;
      }

      // If we have a preferred game, do a single fast fetch to get hero state.
      // If not (first deploy), skip the scan to avoid rate limits — deploy
      // directly and let the server assign a game.
      let currentHero: DefenseHero | null = null;
      let currentGameId: number | undefined;
      if (sessionCtx.preferredGameId) {
        try {
          const state = await fetchGameState(
            sessionCtx.apiBaseUrl,
            sessionCtx.preferredGameId,
          );
          currentHero = findHero(state, sessionCtx.agentName);
          currentGameId = sessionCtx.preferredGameId;
        } catch {
          // Rate limited — deploy with whatever we know
        }
      }

      const deployment = parseDeploymentCommand(
        content,
        sessionCtx,
        currentHero,
      );
      const response = await deployHero(sessionCtx, deployment);

      // Persist the game ID so subsequent calls use the fast path
      const assignedGameId =
        response.gameId ?? currentGameId ?? sessionCtx.preferredGameId;
      if (typeof assignedGameId === "number") {
        sessionCtx.preferredGameId = assignedGameId;
        persistSetting(
          runtime,
          "DEFENSE_OF_THE_AGENTS_GAME_ID",
          String(assignedGameId),
        );
      }

      // Clear cache for the assigned game so we get fresh state after deploy
      if (assignedGameId) {
        gameStateCache.delete(`${sessionCtx.apiBaseUrl}:${assignedGameId}`);
      }

      // Re-fetch game state once (not a full locate scan) to get updated hero
      const refreshedGameId = assignedGameId ?? DEFAULT_GAME_ID;
      const refreshedState = await fetchGameState(
        sessionCtx.apiBaseUrl,
        refreshedGameId,
      );
      const refreshedHero = findHero(refreshedState, sessionCtx.agentName);
      const refreshedSession = buildSessionState(sessionCtx, {
        gameId: refreshedGameId,
        state: refreshedState,
        hero: refreshedHero,
      });

      if (cmdAgentId) {
        pushActivity(cmdAgentId, "command", `Sent: ${content.slice(0, 60)}`);
      }

      ctx.json(
        ctx.res,
        okResponse(
          true,
          response.message?.trim() || "Deployment received.",
          refreshedSession,
        ),
      );
      return true;
    }

    if (ctx.method === "POST" && subroute === "control") {
      ctx.error(
        ctx.res,
        "Defense of the Agents does not expose pause or resume controls.",
        400,
      );
      return true;
    }

    return false;
  } catch (error) {
    ctx.error(
      ctx.res,
      error instanceof Error
        ? error.message
        : "Defense of the Agents request failed.",
      502,
    );
    return true;
  }
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  activeLoops,
  buildReviewSummary,
  clearAgentRunState,
  DEFAULT_STRATEGY,
  executeStrategyTick,
  findWeakestAlliedLane,
  type GameStrategy,
  isAutoPlayActive,
  parseStrategyUpdate,
  persistBestStrategy,
  persistStrategy,
  pickAbility,
  recentActivity,
  resetInMemoryStateForTests,
  resolveBestStrategy,
  resolveSessionContext,
  resolveStrategy,
  runStrategyReview,
  type StrategyMetrics,
  scoreStrategy,
  sessionCacheKey,
  sessionStateCache,
  startGameLoop,
  stopGameLoop,
  updateMetrics,
};
