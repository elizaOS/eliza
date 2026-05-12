import { randomInt } from "node:crypto";
import type http from "node:http";
import { type IAgentRuntime, logger } from "@elizaos/core";
import type {
  AppLaunchDiagnostic,
  AppLaunchPreparation,
  AppLaunchResult,
  AppSessionActionResult,
  AppSessionJsonValue,
  AppSessionState,
  AppViewerAuthMessage,
} from "@elizaos/shared";

// ---------------------------------------------------------------------------
// Inline route-context types (previously from @elizaos/agent route-helpers)
// ---------------------------------------------------------------------------

interface RouteRequestMeta {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
}

interface RouteHelpers {
  json: (res: http.ServerResponse, data: object, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_NAME = "@elizaos/app-2004scape";
const APP_DISPLAY_NAME = "2004scape";
const VIEWER_ROUTE_PATH = "/api/apps/2004scape/viewer";
const VIEWER_PROXY_PREFIX = `${VIEWER_ROUTE_PATH}/proxy`;
const RS_2004SCAPE_AUTH_MESSAGE_TYPE = "RS_2004SCAPE_AUTH";
const RS_2004SCAPE_BOT_NAME_KEYS = ["RS_SDK_BOT_NAME", "BOT_NAME"] as const;
const RS_2004SCAPE_BOT_PASSWORD_KEYS = [
  "RS_SDK_BOT_PASSWORD",
  "BOT_PASSWORD",
] as const;
const DEFAULT_RS_SDK_SERVER_URL = "https://rs-sdk-demo.fly.dev";
const FETCH_TIMEOUT_MS = 30_000;
const VIEWER_STALE_MS = 12_000;
const COMMAND_HISTORY_LIMIT = 48;
const ACTIVITY_LIMIT = 16;
const VIEWER_SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-forms";
const VIEWER_FRAME_ANCESTORS_DIRECTIVE =
  "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* " +
  "http://[::1]:* http://[0:0:0:0:0:0:0:1]:* https://localhost:* " +
  "https://127.0.0.1:* https://[::1]:* https://[0:0:0:0:0:0:0:1]:* " +
  "electrobun: capacitor: capacitor-electron: app: tauri: file:";
const USERNAME_SUFFIX_WORDS: readonly string[] = [
  "ash",
  "bay",
  "elm",
  "fir",
  "ivy",
  "oak",
  "ore",
  "rye",
  "tin",
  "yew",
  "coal",
  "fern",
  "flax",
  "gem",
  "moss",
  "reed",
  "rune",
  "star",
] as const;
const PASSWORD_CHARS =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OperatorIntent =
  | "tutorial"
  | "woodcutting"
  | "fishing"
  | "explore"
  | "bank";

type BridgeCommand =
  | {
      seq: number;
      type: "pause" | "resume" | "skip-tutorial";
    }
  | {
      seq: number;
      type: "set-goal";
      goal: string;
    }
  | {
      seq: number;
      type: "set-intent";
      intent: OperatorIntent;
    }
  | {
      seq: number;
      type: "say";
      text: string;
    };

type BridgeCommandInput =
  | { type: "pause" | "resume" | "skip-tutorial" }
  | { type: "set-goal"; goal: string }
  | { type: "set-intent"; intent: OperatorIntent }
  | { type: "say"; text: string };

interface RecentActivityEntry {
  id: string;
  action: string;
  detail: string;
  ts: number;
  severity?: "info" | "warning" | "error";
}

interface ViewerSyncBody {
  cursor?: number;
  telemetry?: Record<string, AppSessionJsonValue> | null;
  viewer?: {
    statusText?: string;
    tutorialVisible?: boolean;
    url?: string;
  } | null;
}

interface SessionRecord {
  sessionId: string;
  botName: string;
  botPassword: string;
  remoteServerUrl: string;
  agentId?: string;
  viewerSeenAt: number | null;
  statusText: string | null;
  paused: boolean;
  intent: OperatorIntent;
  goal: string | null;
  nextSeq: number;
  commands: BridgeCommand[];
  telemetry: Record<string, AppSessionJsonValue> | null;
  activity: RecentActivityEntry[];
}

interface AppLaunchSessionContext {
  appName: string;
  launchUrl: string | null;
  runtime: IAgentRuntime | null;
  viewer: AppLaunchResult["viewer"] | null;
}

interface AppRunSessionContext extends AppLaunchSessionContext {
  runId: string;
  session: AppSessionState | null;
}

interface RouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "error" | "json"> {
  url: URL;
  runtime: unknown | null;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  readJsonBody: () => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

const sessionStore = new Map<string, SessionRecord>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSettingLike(
  runtime: IAgentRuntime | null | undefined,
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

function resolveRemoteServerUrl(runtime: IAgentRuntime | null): string {
  const configured = resolveSettingLike(runtime, "RS_SDK_SERVER_URL");
  if (configured) {
    try {
      return new URL(configured).toString().replace(/\/+$/, "");
    } catch {
      return DEFAULT_RS_SDK_SERVER_URL;
    }
  }
  return DEFAULT_RS_SDK_SERVER_URL;
}

async function isServerReachable(
  serverUrl: string,
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    const url = new URL(serverUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url.href, {
      method: "HEAD",
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(timer);
    return res !== null;
  } catch {
    return false;
  }
}

function getCredentialKeys(
  key: "RS_SDK_BOT_NAME" | "RS_SDK_BOT_PASSWORD",
): readonly string[] {
  return key === "RS_SDK_BOT_NAME"
    ? RS_2004SCAPE_BOT_NAME_KEYS
    : RS_2004SCAPE_BOT_PASSWORD_KEYS;
}

function resolveCredential(
  runtime: IAgentRuntime | null | undefined,
  key: "RS_SDK_BOT_NAME" | "RS_SDK_BOT_PASSWORD",
): string | undefined {
  for (const credentialKey of getCredentialKeys(key)) {
    const value = resolveSettingLike(runtime, credentialKey);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function persistCredential(
  runtime: IAgentRuntime | null,
  key: "RS_SDK_BOT_NAME" | "RS_SDK_BOT_PASSWORD",
  value: string,
  secret = false,
): void {
  const credentialKeys = getCredentialKeys(key);
  for (const credentialKey of credentialKeys) {
    process.env[credentialKey] = value;
  }
  if (!runtime) return;

  const character = runtime.character as {
    settings?: { secrets?: Record<string, string> };
    secrets?: Record<string, string>;
  };
  if (!character.settings) {
    character.settings = {};
  }
  if (!character.settings.secrets) {
    character.settings.secrets = {};
  }
  if (!character.secrets) {
    character.secrets = {};
  }

  for (const credentialKey of credentialKeys) {
    try {
      runtime.setSetting(credentialKey, value, secret);
    } catch (err) {
      logger.error(
        `[app-2004scape] Failed to persist credential "${credentialKey}": ${err}`,
      );
    }
    character.settings.secrets[credentialKey] = value;
    character.secrets[credentialKey] = value;
  }
}

function sanitizeUsernameBase(name: string, maxLength: number): string {
  return name
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .slice(0, maxLength);
}

function generateBotUsername(agentName: string): string {
  const word = USERNAME_SUFFIX_WORDS[randomInt(USERNAME_SUFFIX_WORDS.length)];
  const num = randomInt(100).toString().padStart(2, "0");
  const suffixLength = word.length + num.length;
  const maxNameLength = Math.max(1, 12 - suffixLength);
  const sanitized = sanitizeUsernameBase(agentName, maxNameLength);
  const base = sanitized.length > 0 ? sanitized : "bot";
  return `${base}${word}${num}`;
}

function generateBotPassword(length = 16): string {
  return Array.from(
    { length },
    () => PASSWORD_CHARS[randomInt(PASSWORD_CHARS.length)],
  ).join("");
}

async function prepareCredentials(
  runtime: IAgentRuntime | null,
): Promise<AppLaunchDiagnostic[]> {
  const primaryName = resolveSettingLike(runtime, "RS_SDK_BOT_NAME");
  const compatName = resolveSettingLike(runtime, "BOT_NAME");
  const primaryPassword = resolveSettingLike(runtime, "RS_SDK_BOT_PASSWORD");
  const compatPassword = resolveSettingLike(runtime, "BOT_PASSWORD");
  const agentDisplayName = runtime?.character?.name || "agent";
  const username =
    primaryName ?? compatName ?? generateBotUsername(agentDisplayName);
  const password = primaryPassword ?? compatPassword ?? generateBotPassword();

  const shouldPersistName = primaryName !== username || compatName !== username;
  const shouldPersistPassword =
    primaryPassword !== password || compatPassword !== password;

  if (shouldPersistName) {
    persistCredential(runtime, "RS_SDK_BOT_NAME", username);
  }
  if (shouldPersistPassword) {
    persistCredential(runtime, "RS_SDK_BOT_PASSWORD", password, true);
  }

  if (shouldPersistName || shouldPersistPassword) {
    logger.info(`[app-2004scape] Prepared credentials for "${username}"`);
  }

  return [];
}

function normalizeSessionId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toJsonValue(
  value: unknown,
  depth = 0,
): AppSessionJsonValue | undefined {
  if (depth > 6) return null;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value as AppSessionJsonValue;
  }
  if (Array.isArray(value)) {
    const next = value
      .map((entry) => toJsonValue(entry, depth + 1))
      .filter((entry): entry is AppSessionJsonValue => entry !== undefined);
    return next;
  }
  if (typeof value === "object") {
    const record: Record<string, AppSessionJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = toJsonValue(entry, depth + 1);
      if (next !== undefined) {
        record[key] = next;
      }
    }
    return record;
  }
  return undefined;
}

function toJsonRecord(
  value: unknown,
): Record<string, AppSessionJsonValue> | null {
  const next = toJsonValue(value);
  return next && typeof next === "object" && !Array.isArray(next)
    ? (next as Record<string, AppSessionJsonValue>)
    : null;
}

function readRecord(
  record: Record<string, AppSessionJsonValue> | null | undefined,
  key: string,
): Record<string, AppSessionJsonValue> | null {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, AppSessionJsonValue>)
    : null;
}

function readArray(
  record: Record<string, AppSessionJsonValue> | null | undefined,
  key: string,
): AppSessionJsonValue[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function readString(
  record: Record<string, AppSessionJsonValue> | null | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBoolean(
  record: Record<string, AppSessionJsonValue> | null | undefined,
  key: string,
): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function readNumber(
  record: Record<string, AppSessionJsonValue> | null | undefined,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeIntent(raw: string | null | undefined): OperatorIntent {
  const normalized = raw?.trim().toLowerCase() ?? "";
  if (
    normalized.includes("tutorial") ||
    normalized.includes("guide") ||
    normalized.includes("starter")
  ) {
    return "tutorial";
  }
  if (
    normalized.includes("wood") ||
    normalized.includes("tree") ||
    normalized.includes("chop") ||
    normalized.includes("log")
  ) {
    return "woodcutting";
  }
  if (
    normalized.includes("fish") ||
    normalized.includes("shrimp") ||
    normalized.includes("net")
  ) {
    return "fishing";
  }
  if (normalized.includes("bank")) {
    return "bank";
  }
  return "explore";
}

function buildActivityId(action: string, detail: string, ts: number): string {
  return `${action}:${detail}:${ts}`;
}

function mergeActivity(
  existing: RecentActivityEntry[],
  nextEntries: RecentActivityEntry[],
): RecentActivityEntry[] {
  const merged = new Map<string, RecentActivityEntry>();
  for (const entry of [...existing, ...nextEntries]) {
    merged.set(entry.id, entry);
  }
  return [...merged.values()]
    .sort((left, right) => right.ts - left.ts)
    .slice(0, ACTIVITY_LIMIT);
}

function coerceRecentActivity(
  telemetry: Record<string, AppSessionJsonValue> | null,
): RecentActivityEntry[] {
  const entries = readArray(telemetry, "recentActivity");
  const next: RecentActivityEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, AppSessionJsonValue>;
    const action = readString(record, "action") ?? "activity";
    const detail = readString(record, "detail") ?? "No detail captured.";
    const ts = readNumber(record, "ts") ?? Date.now();
    next.push({
      id: buildActivityId(action, detail, ts),
      action,
      detail,
      ts,
      severity:
        readString(record, "severity") === "warning" ||
        readString(record, "severity") === "error"
          ? (readString(record, "severity") as "warning" | "error")
          : "info",
    });
  }
  return next;
}

function appendActivity(
  record: SessionRecord,
  action: string,
  detail: string,
  severity: "info" | "warning" | "error" = "info",
): void {
  record.activity = mergeActivity(record.activity, [
    {
      id: buildActivityId(action, detail, Date.now()),
      action,
      detail,
      ts: Date.now(),
      severity,
    },
  ]);
}

function enqueueCommand(
  record: SessionRecord,
  command: BridgeCommandInput,
): BridgeCommand {
  const next: BridgeCommand = {
    ...command,
    seq: record.nextSeq++,
  };
  record.commands = [...record.commands, next].slice(-COMMAND_HISTORY_LIMIT);
  return next;
}

function readGatewayPort(service: unknown): number | null {
  const candidate = service as
    | { getGatewayPort?: () => number | null }
    | null
    | undefined;
  return typeof candidate?.getGatewayPort === "function"
    ? (candidate.getGatewayPort() ?? null)
    : null;
}

function resolveTutorialActive(record: SessionRecord): {
  active: boolean;
  prompt: string | null;
} {
  const tutorial = readRecord(record.telemetry, "tutorial");
  const prompt = readString(tutorial, "prompt");
  const active =
    readBoolean(tutorial, "active") ??
    readBoolean(tutorial, "guideNearby") ??
    readBoolean(tutorial, "visible") ??
    false;
  return { active, prompt };
}

function resolveStatus(record: SessionRecord): AppSessionState["status"] {
  if (record.paused) {
    return "paused";
  }
  if (!record.viewerSeenAt) {
    return "connecting";
  }
  if (Date.now() - record.viewerSeenAt > VIEWER_STALE_MS) {
    return "disconnected";
  }
  return readBoolean(record.telemetry, "inGame") ? "running" : "connecting";
}

function buildSummary(record: SessionRecord): string {
  const status = resolveStatus(record);
  if (status === "paused") {
    return "Autoplay paused. Resume to keep the bot moving.";
  }
  if (status === "disconnected") {
    return "Viewer bridge stale. Reattach to continue the live loop.";
  }
  if (status === "connecting") {
    return `Logging in as ${record.botName}.`;
  }

  const tutorial = resolveTutorialActive(record);
  if (tutorial.active) {
    return tutorial.prompt
      ? `Tutorial island: ${tutorial.prompt}`
      : "Tutorial island: working through the starter flow.";
  }

  const player = readRecord(record.telemetry, "player");
  const x = readNumber(player, "worldX");
  const z = readNumber(player, "worldZ");
  const coords = x !== null && z !== null ? ` at ${x}, ${z}` : "";

  switch (record.intent) {
    case "woodcutting":
      return `Autoplay chopping nearby trees${coords}.`;
    case "fishing":
      return `Autoplay catching shrimp${coords}.`;
    case "bank":
      return `Preparing to bank when the route opens up${coords}.`;
    default:
      return `Exploring the nearby area${coords}.`;
  }
}

function buildGoalLabel(record: SessionRecord): string | null {
  if (record.goal) return record.goal;
  if (resolveTutorialActive(record).active) {
    return "Finish tutorial and reach the mainland.";
  }
  switch (record.intent) {
    case "woodcutting":
      return "Gather wood and keep moving.";
    case "fishing":
      return "Catch fish and keep the loop alive.";
    case "bank":
      return "Find a bank route and stash the haul.";
    default:
      return "Explore nearby and keep the session active.";
  }
}

function buildSuggestedPrompts(record: SessionRecord): string[] {
  if (resolveTutorialActive(record).active) {
    return [
      "Finish tutorial",
      "Talk to the RuneScape Guide",
      "Explore nearby",
      "Say hello",
    ];
  }
  if (record.paused) {
    return [
      "Resume autoplay",
      "Chop nearby tree",
      "Catch nearby fish",
      "Walk around",
    ];
  }
  return ["Chop nearby tree", "Catch nearby fish", "Walk around", "Say hello"];
}

function buildSessionTelemetry(
  record: SessionRecord,
): Record<string, AppSessionJsonValue> | null {
  const telemetry: Record<string, AppSessionJsonValue> = {
    ...(record.telemetry ?? {}),
    botName: record.botName,
    autoPlay: !record.paused,
    paused: record.paused,
    intent: record.intent,
    goal: record.goal,
    remoteServerUrl: record.remoteServerUrl,
    recentActivity: record.activity.map((entry) => ({
      action: entry.action,
      detail: entry.detail,
      ts: entry.ts,
      severity: entry.severity ?? "info",
    })),
  };
  return telemetry;
}

function buildSessionState(record: SessionRecord): AppSessionState {
  return {
    sessionId: record.sessionId,
    appName: APP_NAME,
    mode: "spectate-and-steer",
    status: resolveStatus(record),
    displayName: APP_DISPLAY_NAME,
    agentId: record.agentId,
    characterId: record.botName,
    canSendCommands: true,
    controls: ["pause", "resume"],
    summary: buildSummary(record),
    goalLabel: buildGoalLabel(record),
    suggestedPrompts: buildSuggestedPrompts(record),
    telemetry: buildSessionTelemetry(record),
  };
}

function createSessionRecord(input: {
  sessionId: string;
  botName: string;
  botPassword: string;
  remoteServerUrl: string;
  agentId?: string;
}): SessionRecord {
  return {
    sessionId: input.sessionId,
    botName: input.botName,
    botPassword: input.botPassword,
    remoteServerUrl: input.remoteServerUrl,
    agentId: input.agentId,
    viewerSeenAt: null,
    statusText: null,
    paused: false,
    intent: "tutorial",
    goal: "Finish tutorial and start gathering resources.",
    nextSeq: 1,
    commands: [],
    telemetry: null,
    activity: [],
  };
}

function upsertSessionRecord(input: {
  sessionId: string;
  botName?: string;
  botPassword?: string;
  remoteServerUrl?: string;
  agentId?: string;
}): SessionRecord {
  const existing = sessionStore.get(input.sessionId);
  if (!existing) {
    const created = createSessionRecord({
      sessionId: input.sessionId,
      botName: input.botName ?? input.sessionId,
      botPassword: input.botPassword ?? "",
      remoteServerUrl: input.remoteServerUrl ?? DEFAULT_RS_SDK_SERVER_URL,
      agentId: input.agentId,
    });
    sessionStore.set(created.sessionId, created);
    return created;
  }
  if (input.botName) {
    existing.botName = input.botName;
  }
  if (input.botPassword) {
    existing.botPassword = input.botPassword;
  }
  if (input.remoteServerUrl) {
    existing.remoteServerUrl = input.remoteServerUrl;
  }
  if (input.agentId) {
    existing.agentId = input.agentId;
  }
  return existing;
}

function resolveRouteSessionRecord(
  sessionId: string,
  runtime: IAgentRuntime | null,
): SessionRecord {
  return upsertSessionRecord({
    sessionId,
    botName: sessionId,
    botPassword: "",
    remoteServerUrl: resolveRemoteServerUrl(runtime),
    agentId: runtime?.agentId,
  });
}

const MAX_HTML_REWRITE_BYTES = 10 * 1024 * 1024; // 10 MB guard against ReDoS on large payloads

function rewriteViewerHtml(html: string): string {
  if (html.length > MAX_HTML_REWRITE_BYTES) {
    return html;
  }
  return html
    .replace(/(src|href|action)=("|')\/(?!\/)/g, `$1=$2${VIEWER_PROXY_PREFIX}/`)
    .replace(/url\((["']?)\/(?!\/)/g, `url($1${VIEWER_PROXY_PREFIX}/`);
}

function buildViewerShellInjection(
  remoteServerUrl: string,
  gatewayPort?: number | null,
): string {
  return `<base id="eliza-2004scape-viewer-base" href="${VIEWER_PROXY_PREFIX}/">
<script id="eliza-2004scape-bridge">
(() => {
  const READY_TYPE = "RS_2004SCAPE_READY";
  const AUTH_TYPE = "RS_2004SCAPE_AUTH";
  const PROXY_PREFIX = ${JSON.stringify(VIEWER_PROXY_PREFIX)};
  const SESSION_PREFIX = "/api/apps/2004scape/session";
  const REMOTE_ORIGIN = ${JSON.stringify(new URL(remoteServerUrl).origin)};
  const REMOTE_HOSTNAME = ${JSON.stringify(new URL(remoteServerUrl).hostname)};
  const REMOTE_PORT = ${JSON.stringify(new URL(remoteServerUrl).port)};
  const REMOTE_WS_PROTOCOL = ${JSON.stringify(
    new URL(remoteServerUrl).protocol === "https:" ? "wss:" : "ws:",
  )};
  const GATEWAY_PORT = ${gatewayPort ? JSON.stringify(gatewayPort) : "null"};
  const DEFAULT_GOAL = "Finish tutorial and start gathering resources.";
  const baseFetch = window.fetch.bind(window);
  const NativeWebSocket = window.WebSocket;
  const bridge = (window.__ELIZA_2004SCAPE_BRIDGE__ = {
    auth: null,
    cursor: 0,
    goal: DEFAULT_GOAL,
    intent: "tutorial",
    loginStarted: false,
    paused: false,
    recentActivity: [],
    sessionId: null,
    syncing: false,
    lastActionAt: 0,
    readyTimer: null,
    syncTimer: null,
    autoplayTimer: null,
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const safeText = (value) => (typeof value === "string" ? value.trim() : "");
  const rewriteSocketUrl = (value) => {
    const input = typeof value === "string" ? value : String(value ?? "");
    if (!input) {
      return input;
    }
    try {
      const parsed = new URL(input, window.location.href);
      if (
        parsed.host === window.location.host ||
        parsed.origin === window.location.origin
      ) {
        parsed.protocol = REMOTE_WS_PROTOCOL;
        parsed.hostname = REMOTE_HOSTNAME;
        parsed.port = REMOTE_PORT;
        return parsed.toString();
      }
    } catch {
      return input;
    }
    return input;
  };
  if (typeof NativeWebSocket === "function") {
    function ElizaWebSocket(url, protocols) {
      const rewrittenUrl = rewriteSocketUrl(url);
      return protocols === undefined
        ? new NativeWebSocket(rewrittenUrl)
        : new NativeWebSocket(rewrittenUrl, protocols);
    }
    ElizaWebSocket.prototype = NativeWebSocket.prototype;
    Object.defineProperties(ElizaWebSocket, {
      CONNECTING: { value: NativeWebSocket.CONNECTING },
      OPEN: { value: NativeWebSocket.OPEN },
      CLOSING: { value: NativeWebSocket.CLOSING },
      CLOSED: { value: NativeWebSocket.CLOSED },
    });
    window.WebSocket = ElizaWebSocket;
  }
  const pushActivity = (action, detail, severity = "info") => {
    const ts = Date.now();
    const id = action + ":" + detail + ":" + ts;
    bridge.recentActivity = [{ id, action, detail, ts, severity }, ...bridge.recentActivity].slice(0, 12);
  };
  const markAction = (action, detail) => {
    bridge.lastActionAt = Date.now();
    pushActivity(action, detail);
  };
  const getClient = () => window.gameClient ?? null;
  const getTutorialVisible = () => {
    const node = document.getElementById("tutorial-controls");
    return node instanceof HTMLElement ? getComputedStyle(node).display !== "none" : false;
  };
  const findGuideNearby = (state) =>
    Array.isArray(state?.nearbyNpcs) &&
    state.nearbyNpcs.some((npc) => safeText(npc?.name).toLowerCase() === "runescape guide");
  const coerceList = (value) => (Array.isArray(value) ? value : []);
  const trimNpc = (npc) => ({
    index: typeof npc?.index === "number" ? npc.index : -1,
    name: safeText(npc?.name) || "Unknown",
    distance: typeof npc?.distance === "number" ? npc.distance : null,
    x: typeof npc?.x === "number" ? npc.x : null,
    z: typeof npc?.z === "number" ? npc.z : null,
    optionsWithIndex: coerceList(npc?.optionsWithIndex).slice(0, 3).map((option) => ({
      text: safeText(option?.text) || "Option",
      opIndex: typeof option?.opIndex === "number" ? option.opIndex : 1,
    })),
  });
  const trimLoc = (loc) => ({
    id: typeof loc?.id === "number" ? loc.id : -1,
    name: safeText(loc?.name) || "Unknown",
    distance: typeof loc?.distance === "number" ? loc.distance : null,
    x: typeof loc?.x === "number" ? loc.x : null,
    z: typeof loc?.z === "number" ? loc.z : null,
    optionsWithIndex: coerceList(loc?.optionsWithIndex).slice(0, 3).map((option) => ({
      text: safeText(option?.text) || "Option",
      opIndex: typeof option?.opIndex === "number" ? option.opIndex : 1,
    })),
  });
  const trimMessage = (message) => ({
    text: safeText(message?.text),
    sender: safeText(message?.sender),
    tick: typeof message?.tick === "number" ? message.tick : null,
    type: typeof message?.type === "number" ? message.type : null,
  });
  const trimDialog = (dialog) => ({
    text: coerceList(dialog?.text).filter((entry) => typeof entry === "string").slice(0, 4),
    tick: typeof dialog?.tick === "number" ? dialog.tick : null,
    interfaceId: typeof dialog?.interfaceId === "number" ? dialog.interfaceId : null,
  });
  const trimInventoryItem = (item) => ({
    id: typeof item?.id === "number" ? item.id : -1,
    name: safeText(item?.name) || "Item",
    amount: typeof item?.amount === "number" ? item.amount : 1,
  });
  const trimSkill = (skill) => ({
    name: safeText(skill?.name) || "Skill",
    level: typeof skill?.level === "number" ? skill.level : null,
    experience: typeof skill?.experience === "number" ? skill.experience : null,
  });
  const relativeProxyUrl = (url) => {
    if (typeof url !== "string" || url.length === 0) {
      return url;
    }
    if (url.startsWith("/api/apps/2004scape/")) {
      return url;
    }
    if (url.startsWith(REMOTE_ORIGIN)) {
      const parsed = new URL(url);
      return PROXY_PREFIX + parsed.pathname + parsed.search;
    }
    if (url.startsWith("/")) {
      return PROXY_PREFIX + url;
    }
    return url;
  };
  window.fetch = (input, init) => {
    if (typeof input === "string") {
      return baseFetch(relativeProxyUrl(input), init);
    }
    if (input instanceof URL) {
      return baseFetch(relativeProxyUrl(input.toString()), init);
    }
    if (input instanceof Request) {
      const rewritten = relativeProxyUrl(input.url);
      const nextRequest = rewritten === input.url ? input : new Request(rewritten, input);
      return baseFetch(nextRequest, init);
    }
    return baseFetch(input, init);
  };
  const emitReady = () => {
    if (window.parent && typeof window.parent.postMessage === "function") {
      window.parent.postMessage({ type: READY_TYPE }, "*");
    }
  };
  const fillCredentials = (auth) => {
    const username = document.getElementById("bot-username");
    const password = document.getElementById("bot-password");
    if (username instanceof HTMLInputElement && safeText(auth?.authToken)) {
      username.value = safeText(auth.authToken);
    }
    if (password instanceof HTMLInputElement && safeText(auth?.sessionToken)) {
      password.value = safeText(auth.sessionToken);
    }
  };
  const waitForClient = async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30000) {
      const client = getClient();
      if (client && typeof client.getBotState === "function") {
        return client;
      }
      await sleep(100);
    }
    throw new Error("2004scape client bridge did not finish loading.");
  };
  const acceptStarterInterface = (state, client) => {
    const options = coerceList(state?.interface?.options);
    const accept = options.find((option) => /accept/i.test(safeText(option?.text)));
    if (!accept || typeof accept.index !== "number" || typeof client?.clickInterfaceOption !== "function") {
      return false;
    }
    const ok = client.clickInterfaceOption(accept.index);
    if (ok) {
      markAction("starter-ui", "Accepted the starter appearance preset.");
    }
    return ok;
  };
  const approachWorldTarget = (client, target, label) => {
    if (!target || typeof client?.walkTo !== "function") {
      return false;
    }
    const ok = client.walkTo(target.x, target.z);
    if (ok) {
      markAction("move", "Walking to " + label + ".");
    }
    return ok;
  };
  const interactClosestTree = (state, client) => {
    const trees = coerceList(state?.nearbyLocs)
      .filter((loc) => /tree|oak/i.test(safeText(loc?.name)))
      .map(trimLoc)
      .filter((loc) =>
        coerceList(loc.optionsWithIndex).some((option) => /chop/i.test(safeText(option?.text))),
      )
      .sort((left, right) => (left.distance ?? 999) - (right.distance ?? 999));
    const tree = trees[0];
    if (!tree) {
      return false;
    }
    if ((tree.distance ?? 999) > 3) {
      return approachWorldTarget(client, tree, tree.name);
    }
    const opIndex =
      coerceList(tree.optionsWithIndex).find((option) => /chop/i.test(safeText(option?.text)))?.opIndex ?? 1;
    const ok =
      typeof client?.interactLoc === "function"
        ? client.interactLoc(tree.x, tree.z, tree.id, opIndex)
        : false;
    if (ok) {
      markAction("woodcut", "Started chopping " + tree.name + ".");
    }
    return ok;
  };
  const interactClosestFishingSpot = (state, client) => {
    const spots = coerceList(state?.nearbyNpcs)
      .map(trimNpc)
      .filter((npc) =>
        /fishing spot/i.test(npc.name) &&
        coerceList(npc.optionsWithIndex).some((option) => /net/i.test(safeText(option?.text))),
      )
      .sort((left, right) => (left.distance ?? 999) - (right.distance ?? 999));
    const spot = spots[0];
    if (!spot) {
      return false;
    }
    if ((spot.distance ?? 999) > 3) {
      return approachWorldTarget(client, spot, spot.name);
    }
    const opIndex =
      coerceList(spot.optionsWithIndex).find((option) => /net/i.test(safeText(option?.text)))?.opIndex ?? 1;
    const ok =
      typeof client?.interactNpc === "function"
        ? client.interactNpc(spot.index, opIndex)
        : false;
    if (ok) {
      markAction("fishing", "Started fishing at a nearby spot.");
    }
    return ok;
  };
  const wanderNearby = (client) => {
    if (typeof client?.walkRelative !== "function") {
      return false;
    }
    const offsets = [
      [2, 0],
      [0, 2],
      [-2, 0],
      [0, -2],
      [2, 2],
    ];
    const [dx, dz] = offsets[Math.floor(Date.now() / 1500) % offsets.length];
    const ok = client.walkRelative(dx, dz);
    if (ok) {
      markAction("explore", "Walking a short loop around the starter area.");
    }
    return ok;
  };
  const handleTutorialTick = async (state, client) => {
    if (acceptStarterInterface(state, client)) {
      return true;
    }
    if (typeof window.skipTutorial === "function") {
      await window.skipTutorial();
      markAction("tutorial", "Worked through the tutorial prompts.");
      return true;
    }
    if (typeof client?.talkToNpc === "function" && typeof client?.findNpcByName === "function") {
      const guideIndex = client.findNpcByName("RuneScape Guide");
      if (guideIndex >= 0 && client.talkToNpc(guideIndex)) {
        markAction("tutorial", "Talking to the RuneScape Guide.");
        return true;
      }
    }
    return false;
  };
  const applyCommand = async (command) => {
    if (!command || typeof command !== "object") {
      return;
    }
    const client = await waitForClient();
    if (command.type === "pause") {
      bridge.paused = true;
      pushActivity("operator", "Paused autoplay.");
      return;
    }
    if (command.type === "resume") {
      bridge.paused = false;
      pushActivity("operator", "Resumed autoplay.");
      return;
    }
    if (command.type === "set-goal" && safeText(command.goal)) {
      bridge.goal = safeText(command.goal);
      pushActivity("operator", "Updated goal: " + bridge.goal);
      return;
    }
    if (command.type === "set-intent" && safeText(command.intent)) {
      bridge.intent = safeText(command.intent);
      pushActivity("operator", "Switched intent to " + bridge.intent + ".");
      return;
    }
    if (command.type === "skip-tutorial") {
      bridge.intent = "tutorial";
      await handleTutorialTick(client.getBotState?.(), client);
      return;
    }
    if (command.type === "say" && safeText(command.text) && typeof client?.say === "function") {
      const ok = client.say(command.text);
      if (ok) {
        markAction("say", "Said: " + safeText(command.text));
      }
    }
  };
  const buildTelemetry = () => {
    const client = getClient();
    const state = typeof client?.getBotState === "function" ? client.getBotState() : null;
    const player = state?.player ?? null;
    const combatStyle = state?.combatStyle ?? null;
    const tutorialPrompt = coerceList(state?.recentDialogs)
      .slice(-1)
      .map((dialog) => coerceList(dialog?.text).filter((entry) => typeof entry === "string").join(" "))
      .find((entry) => entry.length > 0) ?? null;
    return {
      inGame: Boolean(state?.inGame),
      statusText: safeText(document.getElementById("bot-status")?.textContent),
      tutorial: {
        active: getTutorialVisible() || findGuideNearby(state) || Boolean(state?.modalOpen) || Boolean(state?.dialog?.isOpen),
        guideNearby: findGuideNearby(state),
        visible: getTutorialVisible(),
        prompt: tutorialPrompt,
      },
      player: player
        ? {
            name: safeText(player.name),
            combatLevel: player.combatLevel ?? null,
            hp: player.hp ?? null,
            maxHp: player.maxHp ?? null,
            worldX: player.worldX ?? null,
            worldZ: player.worldZ ?? null,
            animId: player.animId ?? null,
            runEnergy: player.runEnergy ?? null,
            runWeight: player.runWeight ?? null,
          }
        : null,
      combatStyle: combatStyle
        ? {
            currentStyle: combatStyle.currentStyle ?? null,
            weaponName: safeText(combatStyle.weaponName),
            activeStyle:
              coerceList(combatStyle.styles)[combatStyle.currentStyle ?? 0]?.name ?? null,
          }
        : null,
      inventory: coerceList(state?.inventory).slice(0, 8).map(trimInventoryItem),
      skills: coerceList(state?.skills)
        .filter((skill) => ["Woodcutting", "Fishing", "Attack", "Strength", "Defence", "Hitpoints"].includes(safeText(skill?.name)))
        .slice(0, 6)
        .map(trimSkill),
      nearbyNpcs: coerceList(state?.nearbyNpcs).slice(0, 6).map(trimNpc),
      nearbyLocs: coerceList(state?.nearbyLocs).slice(0, 6).map(trimLoc),
      gameMessages: coerceList(state?.gameMessages).slice(-5).map(trimMessage),
      recentDialogs: coerceList(state?.recentDialogs).slice(-3).map(trimDialog),
      autoPlay: !bridge.paused,
      paused: bridge.paused,
      intent: bridge.intent,
      goal: bridge.goal,
      recentActivity: bridge.recentActivity.map((entry) => ({
        action: entry.action,
        detail: entry.detail,
        ts: entry.ts,
        severity: entry.severity,
      })),
    };
  };
  const syncBridge = async () => {
    if (!bridge.sessionId || bridge.syncing) {
      return;
    }
    bridge.syncing = true;
    try {
      const response = await baseFetch(
        SESSION_PREFIX + "/" + encodeURIComponent(bridge.sessionId) + "/bridge/sync",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            cursor: bridge.cursor,
            telemetry: buildTelemetry(),
            viewer: {
              statusText: safeText(document.getElementById("bot-status")?.textContent),
              tutorialVisible: getTutorialVisible(),
              url: window.location.href,
            },
          }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (Array.isArray(data?.commands)) {
        for (const command of data.commands) {
          await applyCommand(command);
          if (typeof command?.seq === "number" && command.seq > bridge.cursor) {
            bridge.cursor = command.seq;
          }
        }
      }
      if (safeText(data?.session?.goalLabel) && !bridge.goal) {
        bridge.goal = safeText(data.session.goalLabel);
      }
    } catch (error) {
      pushActivity(
        "sync-error",
        error instanceof Error ? error.message : "Viewer sync failed.",
        "error",
      );
    } finally {
      bridge.syncing = false;
    }
  };
  const autoplayTick = async () => {
    if (bridge.paused || !bridge.auth) {
      return;
    }
    const client = getClient();
    const state = typeof client?.getBotState === "function" ? client.getBotState() : null;
    if (!state?.inGame || !client) {
      return;
    }
    if (Date.now() - bridge.lastActionAt < 2500) {
      return;
    }
    if (typeof state?.player?.animId === "number" && state.player.animId !== -1) {
      return;
    }
    if (
      bridge.intent === "tutorial" ||
      getTutorialVisible() ||
      findGuideNearby(state) ||
      Boolean(state?.modalOpen) ||
      Boolean(state?.dialog?.isOpen)
    ) {
      await handleTutorialTick(state, client);
      return;
    }
    if (bridge.intent === "fishing" && interactClosestFishingSpot(state, client)) {
      return;
    }
    if (bridge.intent === "explore" && wanderNearby(client)) {
      return;
    }
    if (interactClosestTree(state, client)) {
      return;
    }
    if (interactClosestFishingSpot(state, client)) {
      return;
    }
    wanderNearby(client);
  };
  /* ------------------------------------------------------------------ */
  /*  Gateway WebSocket bridge — connects game client to SDK             */
  /* ------------------------------------------------------------------ */
  let gatewayWs = null;
  let gatewayReconnectTimer = null;
  let gatewayStateTimer = null;
  const connectGateway = () => {
    if (!GATEWAY_PORT || !bridge.sessionId) return;
    try {
      const wsUrl = "ws://localhost:" + GATEWAY_PORT + "/ws?username=" + encodeURIComponent(bridge.sessionId);
      gatewayWs = new NativeWebSocket(wsUrl);
      gatewayWs.onopen = () => {
        pushActivity("gateway", "Connected to SDK gateway.");
        if (gatewayReconnectTimer) { clearTimeout(gatewayReconnectTimer); gatewayReconnectTimer = null; }
      };
      gatewayWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "sdk_action") {
            handleSdkAction(msg.action, msg.id);
          }
        } catch {}
      };
      gatewayWs.onclose = () => {
        gatewayWs = null;
        if (!bridge.paused) {
          gatewayReconnectTimer = setTimeout(connectGateway, 3000);
        }
      };
      gatewayWs.onerror = () => { /* onclose will fire */ };
    } catch {}
  };
  const sendGatewayState = () => {
    if (!gatewayWs || gatewayWs.readyState !== 1) return;
    const client = getClient();
    const state = typeof client?.getBotState === "function" ? client.getBotState() : null;
    if (!state) return;
    try {
      gatewayWs.send(JSON.stringify({ type: "sdk_state", state }));
    } catch {}
  };
  const handleSdkAction = (action, id) => {
    const client = getClient();
    if (!client) {
      sendGatewayAck(id, false, "Game client not available.");
      return;
    }
    let ok = false;
    let msg = "Action executed.";
    try {
      switch (action?.type) {
        case "walkTo":
          ok = typeof client.walkTo === "function" && client.walkTo(action.x, action.z);
          msg = ok ? "Walking to (" + action.x + ", " + action.z + ")." : "Walk failed.";
          break;
        case "interactLoc":
          ok = typeof client.interactLoc === "function" && client.interactLoc(action.x ?? 0, action.z ?? 0, action.locId, action.opIndex ?? 1);
          break;
        case "interactNpc":
          ok = typeof client.interactNpc === "function" && client.interactNpc(action.nid, action.opIndex ?? 1);
          break;
        case "attackNpc":
          ok = typeof client.interactNpc === "function" && client.interactNpc(action.nid, 0);
          break;
        case "talkToNpc":
          ok = typeof client.interactNpc === "function" && client.interactNpc(action.nid, 1);
          break;
        case "useInventory":
          ok = typeof client.useInventoryItem === "function" && client.useInventoryItem(action.slot);
          break;
        case "equipItem":
          ok = typeof client.equipItem === "function" && client.equipItem(action.slot);
          break;
        case "unequipItem":
          ok = typeof client.unequipItem === "function" && client.unequipItem(action.slot);
          break;
        case "dropItem":
          ok = typeof client.dropItem === "function" && client.dropItem(action.slot);
          break;
        case "pickupItem":
          ok = typeof client.pickupGroundItem === "function" && client.pickupGroundItem(action.id, action.x, action.z);
          break;
        case "useItemOnItem":
          ok = typeof client.useItemOnItem === "function" && client.useItemOnItem(action.slot1, action.slot2);
          break;
        case "useItemOnLoc":
          ok = typeof client.useItemOnLoc === "function" && client.useItemOnLoc(action.slot, action.locId);
          break;
        case "useItemOnNpc":
          ok = typeof client.useItemOnNpc === "function" && client.useItemOnNpc(action.slot, action.nid);
          break;
        case "dialogOption":
          ok = typeof client.clickInterfaceOption === "function" && client.clickInterfaceOption(action.option);
          break;
        case "openBank":
          ok = typeof client.openBank === "function" && client.openBank();
          break;
        case "closeBank":
          ok = typeof client.closeBank === "function" && client.closeBank();
          break;
        case "depositItem":
          ok = typeof client.depositItem === "function" && client.depositItem(action.slot, action.count ?? 1);
          break;
        case "withdrawItem":
          ok = typeof client.withdrawItem === "function" && client.withdrawItem(action.slot, action.count ?? 1);
          break;
        case "openShop":
          ok = typeof client.interactNpc === "function" && client.interactNpc(action.nid, 1);
          break;
        case "closeShop":
          ok = typeof client.closeShop === "function" && client.closeShop();
          break;
        case "buyItem":
          ok = typeof client.buyItem === "function" && client.buyItem(action.slot, action.count ?? 1);
          break;
        case "sellItem":
          ok = typeof client.sellItem === "function" && client.sellItem(action.slot, action.count ?? 1);
          break;
        case "setCombatStyle":
          ok = typeof client.setCombatStyle === "function" && client.setCombatStyle(action.style);
          break;
        case "castSpell":
          ok = typeof client.castSpell === "function" && client.castSpell(action.spellId, action.targetNid);
          break;
        default:
          msg = "Unknown action type: " + (action?.type || "null");
      }
    } catch (err) {
      msg = "Action error: " + (err?.message || String(err));
    }
    if (ok) { markAction("sdk-action", action.type + " executed."); }
    sendGatewayAck(id, ok, msg);
  };
  const sendGatewayAck = (id, success, message) => {
    if (!gatewayWs || gatewayWs.readyState !== 1 || !id) return;
    try {
      gatewayWs.send(JSON.stringify({ type: "sdk_action_ack", id, success, message }));
    } catch {}
  };

  /* ------------------------------------------------------------------ */
  /*  Timers and event handlers                                          */
  /* ------------------------------------------------------------------ */
  bridge.readyTimer = window.setInterval(() => {
    if (!bridge.auth) {
      emitReady();
      return;
    }
    window.clearInterval(bridge.readyTimer);
  }, 600);
  bridge.syncTimer = window.setInterval(() => {
    void syncBridge();
  }, 1500);
  bridge.autoplayTimer = window.setInterval(() => {
    void autoplayTick();
  }, 1200);
  // Send full game state to the SDK gateway every 500ms
  if (GATEWAY_PORT) {
    gatewayStateTimer = window.setInterval(sendGatewayState, 500);
  }
  emitReady();
  window.addEventListener("message", async (event) => {
    if (event?.data?.type !== AUTH_TYPE) {
      return;
    }
    bridge.auth = event.data;
    bridge.sessionId = safeText(event.data?.authToken) || safeText(event.data?.characterId) || "2004scape";
    fillCredentials(event.data);
    if (!bridge.loginStarted) {
      bridge.loginStarted = true;
      try {
        const client = await waitForClient();
        if (typeof window.createAndLogin === "function") {
          await window.createAndLogin();
        } else if (typeof client?.autoLogin === "function") {
          await client.autoLogin(bridge.sessionId, safeText(event.data?.sessionToken));
        }
        pushActivity("login", "Logging in as " + bridge.sessionId + ".");
      } catch (error) {
        pushActivity(
          "login-error",
          error instanceof Error ? error.message : "Auto-login failed.",
          "error",
        );
      }
    }
    await syncBridge();
    // Connect to SDK gateway after auth
    if (GATEWAY_PORT) { connectGateway(); }
  });
  window.addEventListener(
    "beforeunload",
    () => {
      window.clearInterval(bridge.readyTimer);
      window.clearInterval(bridge.syncTimer);
      window.clearInterval(bridge.autoplayTimer);
      if (gatewayStateTimer) window.clearInterval(gatewayStateTimer);
      if (gatewayWs) { try { gatewayWs.close(); } catch {} }
    },
    { once: true },
  );
})();
</script>`;
}

async function buildViewerHtml(runtime: IAgentRuntime | null): Promise<string> {
  const remoteServerUrl = resolveRemoteServerUrl(runtime);
  const response = await fetch(new URL("/bot", `${remoteServerUrl}/`), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const html = await response.text();

  if (!response.ok) {
    throw new Error(
      `2004scape viewer request failed (${response.status}): ${html.trim() || response.statusText}`,
    );
  }

  // Resolve the gateway port from the game service if available
  const gatewayPort = readGatewayPort(runtime?.getService?.("rs_2004scape"));

  const injected = buildViewerShellInjection(remoteServerUrl, gatewayPort);
  const rewritten = rewriteViewerHtml(html);
  return rewritten.includes("</head>")
    ? rewritten.replace("</head>", `${injected}</head>`)
    : `${injected}${rewritten}`;
}

function sendHtmlResponse(res: http.ServerResponse, html: string): void {
  res.statusCode = 200;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  applyViewerEmbedHeaders(res);
  res.end(html);
}

function applyViewerEmbedHeaders(res: http.ServerResponse): void {
  res.removeHeader("X-Frame-Options");
  const existingCsp = res.getHeader("Content-Security-Policy");
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
  res.setHeader("Content-Security-Policy", nextCsp);
}

function filterProxyRequestHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      !value ||
      name === "host" ||
      name === "origin" ||
      name === "referer" ||
      name === "content-length"
    ) {
      continue;
    }
    next[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return next;
}

function incomingMessageBody(
  req: http.IncomingMessage,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer | string) => {
        controller.enqueue(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on("end", () => controller.close());
      req.on("error", (error) => controller.error(error));
    },
    cancel() {
      req.destroy();
    },
  });
}

function waitForDrain(res: http.ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    res.once("drain", resolve);
    res.once("error", reject);
  });
}

async function pipeResponseBody(
  body: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
): Promise<void> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && !res.write(value)) {
        await waitForDrain(res);
      }
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

async function proxyViewerRequest(
  ctx: RouteContext,
  proxyPathname: string,
): Promise<boolean> {
  const remoteServerUrl = resolveRemoteServerUrl(
    ctx.runtime as IAgentRuntime | null,
  );
  const remoteUrl = new URL(proxyPathname || "/", `${remoteServerUrl}/`);
  remoteUrl.search = ctx.url.search;

  const requestInit: RequestInit & { duplex?: "half" } = {
    method: ctx.method,
    headers: filterProxyRequestHeaders(ctx.req.headers),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };

  if (ctx.method !== "GET" && ctx.method !== "HEAD") {
    requestInit.body = incomingMessageBody(ctx.req);
    requestInit.duplex = "half";
  }

  const upstream = await fetch(remoteUrl, requestInit);
  ctx.res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    if (key === "content-length" || key === "content-encoding") {
      ctx.res.removeHeader(key);
      return;
    }
    ctx.res.setHeader(key, value);
  });
  if (upstream.headers.get("content-type")?.includes("text/html")) {
    applyViewerEmbedHeaders(ctx.res);
  }

  if (!upstream.body) {
    ctx.res.end();
    return true;
  }

  await pipeResponseBody(upstream.body, ctx.res);
  return true;
}

function parseSessionPath(pathname: string): {
  sessionId: string;
  subroute: "" | "message" | "control" | "bridge/sync";
} | null {
  const match = pathname.match(
    /^\/api\/apps\/2004scape\/session\/([^/]+)(?:\/(message|control|bridge\/sync))?$/,
  );
  if (!match?.[1]) return null;
  return {
    sessionId: decodeURIComponent(match[1]),
    subroute: (match[2] as "" | "message" | "control" | "bridge/sync") ?? "",
  };
}

function applyOperatorMessage(record: SessionRecord, content: string): void {
  const normalized = content.trim();
  record.goal = normalized;

  if (/^(pause|pause autoplay|pause session)$/i.test(normalized)) {
    applyControlAction(record, "pause");
    return;
  }

  if (/^(resume|resume autoplay|resume session)$/i.test(normalized)) {
    applyControlAction(record, "resume");
    return;
  }

  if (/^say\s+/i.test(normalized)) {
    enqueueCommand(record, {
      type: "say",
      text: normalized.replace(/^say\s+/i, "").trim(),
    });
    appendActivity(record, "operator", `Queued in-game chat: ${normalized}`);
    return;
  }

  const intent = normalizeIntent(normalized);
  if (intent !== record.intent) {
    record.intent = intent;
    enqueueCommand(record, {
      type: "set-intent",
      intent,
    });
  }

  enqueueCommand(record, {
    type: "set-goal",
    goal: normalized,
  });

  if (
    intent === "tutorial" ||
    /\bskip\b/.test(normalized.toLowerCase()) ||
    /\bguide\b/.test(normalized.toLowerCase())
  ) {
    enqueueCommand(record, { type: "skip-tutorial" });
  }

  appendActivity(record, "operator", `Updated goal: ${normalized}`);
}

function applyControlAction(
  record: SessionRecord,
  action: "pause" | "resume",
): void {
  if (action === "pause") {
    record.paused = true;
    enqueueCommand(record, { type: "pause" });
    appendActivity(record, "control", "Paused autoplay.");
    return;
  }

  record.paused = false;
  enqueueCommand(record, { type: "resume" });
  appendActivity(record, "control", "Resumed autoplay.");
}

function resolveLaunchRecord(
  ctx: AppLaunchSessionContext | AppRunSessionContext,
): SessionRecord | null {
  const sessionState = "session" in ctx ? ctx.session : null;
  const sessionId = normalizeSessionId(
    ctx.viewer?.authMessage?.authToken ??
      sessionState?.sessionId ??
      ctx.viewer?.authMessage?.characterId ??
      ctx.runtime?.agentId ??
      null,
  );
  if (!sessionId) {
    return null;
  }

  return upsertSessionRecord({
    sessionId,
    botName:
      normalizeSessionId(ctx.viewer?.authMessage?.authToken) ?? sessionId,
    botPassword:
      normalizeSessionId(ctx.viewer?.authMessage?.sessionToken) ?? "",
    remoteServerUrl: resolveRemoteServerUrl(ctx.runtime),
    agentId: ctx.runtime?.agentId,
  });
}

// ---------------------------------------------------------------------------
// Exported route module interface (AppRouteModule)
// ---------------------------------------------------------------------------

export async function prepareLaunch(ctx: {
  runtime: IAgentRuntime | null;
}): Promise<AppLaunchPreparation> {
  const runtime = ctx.runtime ?? null;
  const rsSdkServerUrl = resolveRemoteServerUrl(runtime);
  const viewer = {
    url: VIEWER_ROUTE_PATH,
    embedParams: {
      bot: "",
      password: "",
    },
    postMessageAuth: true,
    sandbox: VIEWER_SANDBOX,
  };

  const serverUp = await isServerReachable(rsSdkServerUrl);
  if (!serverUp) {
    logger.info(
      `[app-2004scape] Server is not reachable at ${rsSdkServerUrl}; skipping plugin registration`,
    );
    return {
      skipRuntimePluginRegistration: true,
      diagnostics: [
        {
          code: "2004scape-server-unreachable",
          severity: "warning",
          message: `2004scape game server is not running at ${rsSdkServerUrl}. Start the server and re-launch the app.`,
        },
      ],
      launchUrl: VIEWER_ROUTE_PATH,
      viewer,
    };
  }

  return {
    diagnostics: await prepareCredentials(runtime),
    launchUrl: VIEWER_ROUTE_PATH,
    viewer,
  };
}

export async function resolveViewerAuthMessage(ctx: {
  runtime: IAgentRuntime | null;
}): Promise<AppViewerAuthMessage | null> {
  const runtime = ctx.runtime ?? null;
  await prepareCredentials(runtime);
  const username = resolveCredential(runtime, "RS_SDK_BOT_NAME");
  const password = resolveCredential(runtime, "RS_SDK_BOT_PASSWORD");

  if (!username || !password) {
    logger.warn(
      "[app-2004scape] Credentials are unavailable. Launch with a live runtime to auto-provision credentials.",
    );
    return null;
  }

  return {
    type: RS_2004SCAPE_AUTH_MESSAGE_TYPE,
    authToken: username,
    sessionToken: password,
    characterId: username,
    agentId: runtime?.agentId,
  };
}

export async function collectLaunchDiagnostics(ctx: {
  runtime: IAgentRuntime | null;
  viewer: AppLaunchResult["viewer"] | null;
}): Promise<AppLaunchDiagnostic[]> {
  const diagnostics: AppLaunchDiagnostic[] = [];
  const botName = resolveCredential(ctx.runtime, "RS_SDK_BOT_NAME");
  const botPassword = resolveCredential(ctx.runtime, "RS_SDK_BOT_PASSWORD");

  if (!botName || !botPassword) {
    diagnostics.push({
      code: "2004scape-credentials-missing",
      severity: "warning",
      message:
        "2004scape bot credentials are not stored yet. The viewer will load without auto-login until launch provisions them.",
    });
  }

  if (ctx.viewer?.postMessageAuth && !ctx.viewer.authMessage) {
    diagnostics.push({
      code: "2004scape-auth-unavailable",
      severity: "error",
      message:
        "2004scape auto-sign-in could not resolve stored bot credentials for this run.",
    });
  }

  return diagnostics;
}

export async function resolveLaunchSession(
  ctx: AppLaunchSessionContext,
): Promise<AppLaunchResult["session"]> {
  const record = resolveLaunchRecord(ctx);
  return record ? buildSessionState(record) : null;
}

export async function refreshRunSession(
  ctx: AppRunSessionContext,
): Promise<AppLaunchResult["session"]> {
  const record = resolveLaunchRecord(ctx);
  return record ? buildSessionState(record) : ctx.session;
}

/**
 * Called by the host app-manager when the user stops the 2004scape run.
 * Tears down the embedded gateway WebSocket server, bot-SDK connection,
 * and the autonomous-loop timer so the game actually stops server-side
 * instead of just unmounting the viewer iframe.
 *
 * Idempotent: if the service isn't running or already stopped this is a
 * no-op.
 */
export async function stopRun(ctx: { runtime: unknown | null }): Promise<void> {
  const runtime = ctx.runtime as {
    getService?: (name: string) => unknown;
  } | null;
  const service = runtime?.getService?.("rs_2004scape") as
    | { stop?: () => Promise<void> | void }
    | null
    | undefined;
  if (!service || typeof service.stop !== "function") {
    return;
  }
  await service.stop();
}

export async function handleAppRoutes(ctx: RouteContext): Promise<boolean> {
  if (ctx.method === "GET" && ctx.pathname === VIEWER_ROUTE_PATH) {
    try {
      sendHtmlResponse(
        ctx.res,
        await buildViewerHtml(ctx.runtime as IAgentRuntime | null),
      );
    } catch (error) {
      ctx.error(
        ctx.res,
        error instanceof Error
          ? error.message
          : "Failed to load the 2004scape viewer shell.",
        502,
      );
    }
    return true;
  }

  if (ctx.pathname.startsWith(`${VIEWER_ROUTE_PATH}/proxy`)) {
    const proxyPath = ctx.pathname.slice(`${VIEWER_ROUTE_PATH}/proxy`.length);
    try {
      return await proxyViewerRequest(ctx, proxyPath);
    } catch (error) {
      ctx.error(
        ctx.res,
        error instanceof Error
          ? error.message
          : "Failed to proxy the 2004scape viewer asset.",
        502,
      );
      return true;
    }
  }

  const sessionRoute = parseSessionPath(ctx.pathname);
  if (!sessionRoute) {
    return false;
  }

  const runtime = (ctx.runtime as IAgentRuntime | null) ?? null;
  const record = resolveRouteSessionRecord(sessionRoute.sessionId, runtime);

  if (ctx.method === "GET" && sessionRoute.subroute === "") {
    ctx.json(ctx.res, buildSessionState(record));
    return true;
  }

  if (ctx.method === "POST" && sessionRoute.subroute === "message") {
    const body = (await ctx.readJsonBody()) as {
      content?: string;
      message?: string;
    } | null;
    const content =
      typeof body?.content === "string"
        ? body.content.trim()
        : typeof body?.message === "string"
          ? body.message.trim()
          : "";
    if (!content) {
      ctx.error(ctx.res, "Operator guidance is required.", 400);
      return true;
    }
    applyOperatorMessage(record, content);
    ctx.json(
      ctx.res,
      {
        success: true,
        disposition: "queued",
        message: "Queued 2004scape guidance for the live loop.",
        session: buildSessionState(record),
      } satisfies AppSessionActionResult & { disposition: string },
      202,
    );
    return true;
  }

  if (ctx.method === "POST" && sessionRoute.subroute === "control") {
    const body = (await ctx.readJsonBody()) as { action?: string } | null;
    const action =
      body?.action === "pause"
        ? "pause"
        : body?.action === "resume"
          ? "resume"
          : null;
    if (!action) {
      ctx.error(ctx.res, "Action must be pause or resume.", 400);
      return true;
    }
    applyControlAction(record, action);
    ctx.json(ctx.res, {
      success: true,
      disposition: "accepted",
      message:
        action === "pause"
          ? "Paused the 2004scape autoplay loop."
          : "Resumed the 2004scape autoplay loop.",
      session: buildSessionState(record),
    } satisfies AppSessionActionResult & { disposition: string });
    return true;
  }

  if (ctx.method === "POST" && sessionRoute.subroute === "bridge/sync") {
    const body = (await ctx.readJsonBody()) as ViewerSyncBody | null;
    const cursor =
      typeof body?.cursor === "number" && Number.isFinite(body.cursor)
        ? body.cursor
        : 0;
    record.viewerSeenAt = Date.now();
    const viewerStatusText =
      typeof body?.viewer?.statusText === "string"
        ? body.viewer.statusText.trim()
        : "";
    if (viewerStatusText.length > 0) {
      record.statusText = viewerStatusText;
    }

    const telemetry = toJsonRecord(body?.telemetry);
    if (telemetry) {
      record.telemetry = telemetry;
      record.activity = mergeActivity(
        record.activity,
        coerceRecentActivity(telemetry),
      );
    }

    if (cursor > 0) {
      record.commands = record.commands.filter(
        (command) => command.seq > cursor,
      );
    }

    ctx.json(ctx.res, {
      success: true,
      session: buildSessionState(record),
      commands: record.commands,
    });
    return true;
  }

  return false;
}

export function __reset2004scapeBridgeForTests(): void {
  sessionStore.clear();
}
