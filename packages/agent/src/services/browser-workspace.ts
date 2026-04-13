import { existsSync, readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { JSDOM } from "jsdom";

let jsdomCtor: typeof import("jsdom").JSDOM | undefined;

/**
 * Locate jsdom's package.json on disk, then resolve its declared entry file from there.
 * Vitest workers run on Node; Node cannot resolve `jsdom` from workspace roots when
 * Bun hoists deps under node_modules/.bun, but requiring jsdom from its own package
 * directory still works.
 */
function findJsdomPackageJsonPath(): string {
  const candidatesUnderBase = (base: string): string | undefined => {
    const rels = [
      path.join("node_modules", "jsdom", "package.json"),
      path.join("apps", "app", "node_modules", "jsdom", "package.json"),
    ];
    for (const rel of rels) {
      const full = path.join(base, rel);
      if (existsSync(full)) {
        return full;
      }
    }
    return undefined;
  };

  const walk = (start: string, maxDepth: number): string | undefined => {
    let dir = start;
    for (let depth = 0; depth < maxDepth; depth += 1) {
      const hit = candidatesUnderBase(dir);
      if (hit) {
        return hit;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return undefined;
  };

  const fromSource = walk(path.dirname(fileURLToPath(import.meta.url)), 24);
  if (fromSource) {
    return fromSource;
  }
  const fromCwd = walk(process.cwd(), 16);
  if (fromCwd) {
    return fromCwd;
  }

  throw new Error(
    "Could not find jsdom on disk (install dependencies: jsdom is listed on @elizaos/agent and apps/app).",
  );
}

/** Lazy-load jsdom so importing this module does not require jsdom at parse time (Vitest / server tests). */
function getJSDOMClass(): typeof import("jsdom").JSDOM {
  if (!jsdomCtor) {
    const jsdomPkg = findJsdomPackageJsonPath();
    const jsdomDir = path.dirname(jsdomPkg);
    const meta = JSON.parse(readFileSync(jsdomPkg, "utf8")) as { main?: string };
    const mainRel = (meta.main ?? "./lib/api.js").replace(/^\.\//, "");
    const entry = path.join(jsdomDir, mainRel);
    const req = createRequire(jsdomPkg);
    const mod = req(entry) as { JSDOM: typeof import("jsdom").JSDOM };
    jsdomCtor = mod.JSDOM;
  }
  return jsdomCtor;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_WAIT_INTERVAL_MS = 120;
const DEFAULT_WEB_PARTITION = "persist:eliza-browser";
const DESKTOP_BRIDGE_UNAVAILABLE_MESSAGE =
  "Eliza browser workspace desktop bridge is unavailable.";
const browserWorkspacePageFetch = globalThis.fetch.bind(globalThis);

/**
 * Simple async mutex to serialise mutations to webWorkspaceState.
 * Prevents concurrent requests from corrupting tab state or history.
 */
let webStateLock: Promise<void> = Promise.resolve();
function withWebStateLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = webStateLock.then(fn, fn);
  webStateLock = next.then(
    () => {},
    () => {},
  );
  return next;
}

export type BrowserWorkspaceMode = "desktop" | "web";

export type BrowserWorkspaceOperation =
  | "list"
  | "open"
  | "navigate"
  | "show"
  | "hide"
  | "close"
  | "eval"
  | "screenshot";

export type BrowserWorkspaceSubaction =
  | BrowserWorkspaceOperation
  | "back"
  | "batch"
  | "check"
  | "clipboard"
  | "click"
  | "fill"
  | "find"
  | "focus"
  | "forward"
  | "frame"
  | "get"
  | "hover"
  | "inspect"
  | "keydown"
  | "keyup"
  | "keyboardinserttext"
  | "keyboardtype"
  | "console"
  | "cookies"
  | "diff"
  | "dialog"
  | "press"
  | "drag"
  | "errors"
  | "highlight"
  | "mouse"
  | "network"
  | "pdf"
  | "profiler"
  | "reload"
  | "scroll"
  | "scrollinto"
  | "select"
  | "set"
  | "snapshot"
  | "state"
  | "storage"
  | "tab"
  | "trace"
  | "type"
  | "dblclick"
  | "upload"
  | "uncheck"
  | "wait"
  | "window";

export type BrowserWorkspaceGetMode =
  | "attr"
  | "box"
  | "checked"
  | "count"
  | "enabled"
  | "html"
  | "styles"
  | "text"
  | "title"
  | "url"
  | "value"
  | "visible";

export type BrowserWorkspaceFindBy =
  | "alt"
  | "first"
  | "label"
  | "last"
  | "nth"
  | "placeholder"
  | "role"
  | "testid"
  | "text"
  | "title";

export type BrowserWorkspaceFindAction =
  | "check"
  | "click"
  | "fill"
  | "focus"
  | "hover"
  | "text"
  | "type"
  | "uncheck";

export type BrowserWorkspaceWaitState = "hidden" | "visible";

export type BrowserWorkspaceScrollDirection = "down" | "left" | "right" | "up";

export type BrowserWorkspaceClipboardAction =
  | "copy"
  | "paste"
  | "read"
  | "write";

export type BrowserWorkspaceMouseAction = "down" | "move" | "up" | "wheel";

export type BrowserWorkspaceMouseButton = "left" | "middle" | "right";

export type BrowserWorkspaceSetAction =
  | "credentials"
  | "device"
  | "geo"
  | "headers"
  | "media"
  | "offline"
  | "viewport";

export type BrowserWorkspaceCookieAction = "clear" | "get" | "set";

export type BrowserWorkspaceStorageArea = "local" | "session";

export type BrowserWorkspaceStorageAction = "clear" | "get" | "set";

export type BrowserWorkspaceNetworkAction =
  | "harstart"
  | "harstop"
  | "request"
  | "requests"
  | "route"
  | "unroute";

export type BrowserWorkspaceDialogAction = "accept" | "dismiss" | "status";

export type BrowserWorkspaceDiffAction = "screenshot" | "snapshot" | "url";

export type BrowserWorkspaceTraceAction = "start" | "stop";

export type BrowserWorkspaceProfilerAction = "start" | "stop";

export type BrowserWorkspaceStateAction = "load" | "save";

export type BrowserWorkspaceFrameAction = "main" | "select";

export type BrowserWorkspaceTabAction = "close" | "list" | "new" | "switch";

export type BrowserWorkspaceWindowAction = "new";

export type BrowserWorkspaceConsoleAction = "clear" | "list";

export interface BrowserWorkspaceTab {
  id: string;
  title: string;
  url: string;
  partition: string;
  visible: boolean;
  createdAt: string;
  updatedAt: string;
  lastFocusedAt: string | null;
}

export interface BrowserWorkspaceSnapshot {
  mode: BrowserWorkspaceMode;
  tabs: BrowserWorkspaceTab[];
}

export interface BrowserWorkspaceBridgeConfig {
  baseUrl: string;
  token: string | null;
}

export interface OpenBrowserWorkspaceTabRequest {
  url?: string;
  title?: string;
  show?: boolean;
  partition?: string;
  width?: number;
  height?: number;
}

export interface NavigateBrowserWorkspaceTabRequest {
  id: string;
  url: string;
}

export interface EvaluateBrowserWorkspaceTabRequest {
  id: string;
  script: string;
}

export interface BrowserWorkspaceDomElementSummary {
  ref?: string;
  selector: string;
  tag: string;
  text: string;
  type: string | null;
  name: string | null;
  href: string | null;
  value: string | null;
}

export interface BrowserWorkspaceCommand {
  subaction: BrowserWorkspaceSubaction;
  operation?: BrowserWorkspaceSubaction | "goto" | "read";
  action?: BrowserWorkspaceFindAction;
  baselinePath?: string;
  button?: BrowserWorkspaceMouseButton;
  clipboardAction?: BrowserWorkspaceClipboardAction;
  compact?: boolean;
  consoleAction?: BrowserWorkspaceConsoleAction;
  cookieAction?: BrowserWorkspaceCookieAction;
  deltaX?: number;
  deltaY?: number;
  device?: string;
  dialogAction?: BrowserWorkspaceDialogAction;
  diffAction?: BrowserWorkspaceDiffAction;
  domain?: string;
  id?: string;
  entryKey?: string;
  filePath?: string;
  filter?: string;
  files?: string[];
  frameAction?: BrowserWorkspaceFrameAction;
  fullPage?: boolean;
  headers?: Record<string, string>;
  height?: number;
  url?: string;
  secondaryUrl?: string;
  title?: string;
  script?: string;
  show?: boolean;
  partition?: string;
  selector?: string;
  text?: string;
  value?: string;
  attribute?: string;
  direction?: BrowserWorkspaceScrollDirection;
  exact?: boolean;
  findBy?: BrowserWorkspaceFindBy;
  index?: number;
  key?: string;
  latitude?: number;
  longitude?: number;
  media?: "dark" | "light";
  method?: string;
  mouseAction?: BrowserWorkspaceMouseAction;
  networkAction?: BrowserWorkspaceNetworkAction;
  offline?: boolean;
  outputPath?: string;
  getMode?: BrowserWorkspaceGetMode;
  name?: string;
  pixels?: number;
  profilerAction?: BrowserWorkspaceProfilerAction;
  promptText?: string;
  requestId?: string;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  responseStatus?: number;
  role?: string;
  scale?: number;
  setAction?: BrowserWorkspaceSetAction;
  state?: BrowserWorkspaceWaitState;
  stateAction?: BrowserWorkspaceStateAction;
  status?: string;
  storageAction?: BrowserWorkspaceStorageAction;
  storageArea?: BrowserWorkspaceStorageArea;
  tabAction?: BrowserWorkspaceTabAction;
  timeoutMs?: number;
  traceAction?: BrowserWorkspaceTraceAction;
  windowAction?: BrowserWorkspaceWindowAction;
  width?: number;
  x?: number;
  y?: number;
  username?: string;
  password?: string;
  ms?: number;
  milliseconds?: number;
  steps?: BrowserWorkspaceCommand[];
}

export interface BrowserWorkspaceCommandResult {
  mode: BrowserWorkspaceMode;
  subaction: BrowserWorkspaceSubaction;
  tab?: BrowserWorkspaceTab;
  tabs?: BrowserWorkspaceTab[];
  closed?: boolean;
  value?: unknown;
  elements?: BrowserWorkspaceDomElementSummary[];
  snapshot?: { data: string };
  steps?: BrowserWorkspaceCommandResult[];
}

interface BrowserWorkspaceConsoleEntry {
  level: "error" | "info" | "log" | "warn";
  message: string;
  timestamp: string;
}

interface BrowserWorkspaceErrorEntry {
  message: string;
  stack: string | null;
  timestamp: string;
}

interface BrowserWorkspaceDialogState {
  defaultValue: string | null;
  message: string;
  open: boolean;
  type: "alert" | "beforeunload" | "confirm" | "prompt";
}

interface BrowserWorkspaceMouseState {
  buttons: BrowserWorkspaceMouseButton[];
  x: number;
  y: number;
}

interface BrowserWorkspaceSettingsState {
  credentials: { password: string; username: string } | null;
  device: string | null;
  geo: { latitude: number; longitude: number } | null;
  headers: Record<string, string>;
  media: "dark" | "light" | null;
  offline: boolean;
  viewport: { height: number; scale: number; width: number } | null;
}

interface BrowserWorkspaceNetworkRoute {
  abort: boolean;
  body: string | null;
  headers: Record<string, string>;
  pattern: string;
  status: number | null;
}

interface BrowserWorkspaceNetworkRequestRecord {
  id: string;
  matchedRoute: string | null;
  method: string;
  resourceType: string;
  responseBody: string | null;
  responseHeaders: Record<string, string>;
  status: number | null;
  timestamp: string;
  url: string;
}

interface BrowserWorkspaceTraceRecord {
  active: boolean;
  entries: Array<Record<string, unknown>>;
}

interface BrowserWorkspaceProfilerRecord {
  active: boolean;
  entries: Array<Record<string, unknown>>;
}

interface BrowserWorkspaceHarRecord {
  active: boolean;
  entries: BrowserWorkspaceNetworkRequestRecord[];
  startedAt: string | null;
}

interface BrowserWorkspaceSnapshotRecord {
  bodyText: string;
  title: string;
  url: string;
}

interface BrowserWorkspaceRuntimeState {
  consoleEntries: BrowserWorkspaceConsoleEntry[];
  currentFrame: string | null;
  dialog: BrowserWorkspaceDialogState | null;
  errors: BrowserWorkspaceErrorEntry[];
  frameDoms: Map<string, JSDOM>;
  highlightedSelector: string | null;
  lastScreenshotData: string | null;
  lastSnapshot: BrowserWorkspaceSnapshotRecord | null;
  mouse: BrowserWorkspaceMouseState;
  networkHar: BrowserWorkspaceHarRecord;
  networkNextRequestId: number;
  networkRequests: BrowserWorkspaceNetworkRequestRecord[];
  networkRoutes: BrowserWorkspaceNetworkRoute[];
  settings: BrowserWorkspaceSettingsState;
  trace: BrowserWorkspaceTraceRecord;
  profiler: BrowserWorkspaceProfilerRecord;
}

interface WebBrowserWorkspaceTabState extends BrowserWorkspaceTab {
  dom: JSDOM | null;
  history: string[];
  historyIndex: number;
  loadedUrl: string | null;
}

const webWorkspaceState: {
  nextId: number;
  tabs: WebBrowserWorkspaceTabState[];
} = {
  nextId: 1,
  tabs: [],
};

const browserWorkspaceElementRefs = new Map<string, Map<string, string>>();
const browserWorkspaceRuntimeState = new Map<
  string,
  BrowserWorkspaceRuntimeState
>();
let browserWorkspaceClipboardText = "";

/** @internal - test-only reset */
export async function __resetBrowserWorkspaceStateForTests(): Promise<void> {
  await withWebStateLock(async () => {
    webWorkspaceState.nextId = 1;
    webWorkspaceState.tabs = [];
    browserWorkspaceElementRefs.clear();
    browserWorkspaceRuntimeState.clear();
    browserWorkspaceClipboardText = "";
  });
  webStateLock = Promise.resolve();
}

function normalizeEnvValue(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBrowserWorkspaceText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseBrowserWorkspaceNumberLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getBrowserWorkspaceTimestamp(): string {
  return new Date().toISOString();
}

function getBrowserWorkspaceElementRefStateKey(
  mode: BrowserWorkspaceMode,
  tabId: string,
): string {
  return `${mode}:${tabId}`;
}

function createBrowserWorkspaceRuntimeState(): BrowserWorkspaceRuntimeState {
  return {
    consoleEntries: [],
    currentFrame: null,
    dialog: null,
    errors: [],
    frameDoms: new Map<string, JSDOM>(),
    highlightedSelector: null,
    lastScreenshotData: null,
    lastSnapshot: null,
    mouse: { buttons: [], x: 0, y: 0 },
    networkHar: { active: false, entries: [], startedAt: null },
    networkNextRequestId: 1,
    networkRequests: [],
    networkRoutes: [],
    settings: {
      credentials: null,
      device: null,
      geo: null,
      headers: {},
      media: null,
      offline: false,
      viewport: null,
    },
    trace: { active: false, entries: [] },
    profiler: { active: false, entries: [] },
  };
}

function getBrowserWorkspaceRuntimeStateKey(
  mode: BrowserWorkspaceMode,
  tabId: string,
): string {
  return `${mode}:${tabId}`;
}

function getBrowserWorkspaceRuntimeState(
  mode: BrowserWorkspaceMode,
  tabId: string,
): BrowserWorkspaceRuntimeState {
  const key = getBrowserWorkspaceRuntimeStateKey(mode, tabId);
  let state = browserWorkspaceRuntimeState.get(key);
  if (!state) {
    state = createBrowserWorkspaceRuntimeState();
    browserWorkspaceRuntimeState.set(key, state);
  }
  return state;
}

function clearBrowserWorkspaceRuntimeState(
  mode: BrowserWorkspaceMode,
  tabId: string,
): void {
  browserWorkspaceRuntimeState.delete(
    getBrowserWorkspaceRuntimeStateKey(mode, tabId),
  );
}

function resetBrowserWorkspaceRuntimeNavigationState(
  state: BrowserWorkspaceRuntimeState,
): void {
  state.currentFrame = null;
  state.dialog = null;
  state.frameDoms.clear();
  state.highlightedSelector = null;
}

function appendBrowserWorkspaceTraceEntry(
  state: BrowserWorkspaceRuntimeState,
  entry: Record<string, unknown>,
): void {
  if (!state.trace.active) {
    return;
  }
  state.trace.entries.push({
    ...entry,
    timestamp: getBrowserWorkspaceTimestamp(),
  });
}

function appendBrowserWorkspaceProfilerEntry(
  state: BrowserWorkspaceRuntimeState,
  entry: Record<string, unknown>,
): void {
  if (!state.profiler.active) {
    return;
  }
  state.profiler.entries.push({
    ...entry,
    timestamp: getBrowserWorkspaceTimestamp(),
  });
}

function clearBrowserWorkspaceElementRefs(
  mode: BrowserWorkspaceMode,
  tabId: string,
): void {
  browserWorkspaceElementRefs.delete(
    getBrowserWorkspaceElementRefStateKey(mode, tabId),
  );
}

function registerBrowserWorkspaceElementRefs(
  mode: BrowserWorkspaceMode,
  tabId: string,
  elements: BrowserWorkspaceDomElementSummary[],
): BrowserWorkspaceDomElementSummary[] {
  if (elements.length === 0) {
    clearBrowserWorkspaceElementRefs(mode, tabId);
    return [];
  }

  const refs = new Map<string, string>();
  const augmented = elements.map((element, index) => {
    const ref = `@e${index + 1}`;
    refs.set(ref, element.selector);
    return { ...element, ref };
  });
  browserWorkspaceElementRefs.set(
    getBrowserWorkspaceElementRefStateKey(mode, tabId),
    refs,
  );
  return augmented;
}

function resolveBrowserWorkspaceElementRef(
  mode: BrowserWorkspaceMode,
  tabId: string,
  ref: string,
): string | null {
  return (
    browserWorkspaceElementRefs
      .get(getBrowserWorkspaceElementRefStateKey(mode, tabId))
      ?.get(ref.trim()) ?? null
  );
}

function resolveBrowserWorkspaceCommandElementRefs(
  command: BrowserWorkspaceCommand,
  mode: BrowserWorkspaceMode,
  tabId: string,
): BrowserWorkspaceCommand {
  const selector = command.selector?.trim();
  if (!selector) {
    return command;
  }

  const match = selector.match(/^(@e\d+)([\s\S]*)$/i);
  if (!match?.[1]) {
    return command;
  }

  const resolvedSelector = resolveBrowserWorkspaceElementRef(
    mode,
    tabId,
    match[1],
  );
  if (!resolvedSelector) {
    throw new Error(
      `Unknown browser snapshot element ref ${match[1]}. Run snapshot or inspect again before reusing element refs.`,
    );
  }

  return {
    ...command,
    selector: `${resolvedSelector}${match[2] ?? ""}`,
  };
}

function assertBrowserWorkspaceUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed === "about:blank") {
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`browser workspace rejected invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `browser workspace only supports http/https URLs, got ${parsed.protocol}`,
    );
  }

  return parsed.toString();
}

function createBrowserWorkspaceDesktopOnlyMessage(
  subaction: BrowserWorkspaceSubaction,
): string {
  return `Eliza browser workspace ${subaction} is only available in the desktop app.`;
}

function createBrowserWorkspaceNotFoundError(tabId: string): Error {
  return new Error(
    `Browser workspace request failed (404): Tab ${tabId} was not found.`,
  );
}

function createBrowserWorkspaceCommandTargetError(
  subaction: BrowserWorkspaceSubaction,
): Error {
  return new Error(
    `Eliza browser workspace ${subaction} requires a current tab. Open or show a tab first, or pass an explicit id.`,
  );
}

function inferBrowserWorkspaceTitle(url: string): string {
  if (url === "about:blank") {
    return "New Tab";
  }

  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Eliza Browser";
  } catch {
    return "Eliza Browser";
  }
}

function cloneBrowserWorkspaceTab(
  tab: BrowserWorkspaceTab,
): BrowserWorkspaceTab {
  return { ...tab };
}

function cloneBrowserWorkspaceTabs(
  tabs: BrowserWorkspaceTab[],
): BrowserWorkspaceTab[] {
  return tabs.map((tab) => cloneBrowserWorkspaceTab(tab));
}

function cloneWebBrowserWorkspaceTabState(
  tab: WebBrowserWorkspaceTabState,
): BrowserWorkspaceTab {
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url,
    partition: tab.partition,
    visible: tab.visible,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
    lastFocusedAt: tab.lastFocusedAt,
  };
}

function clearWebBrowserWorkspaceTabElementRefs(tabId: string): void {
  clearBrowserWorkspaceElementRefs("web", tabId);
}

function createEmptyWebBrowserWorkspaceDom(url: string): JSDOM {
  return new (getJSDOMClass())(
    '<!doctype html><html lang="en"><head><title>New Tab</title></head><body></body></html>',
    {
      pretendToBeVisual: true,
      url,
    },
  );
}

function applyBrowserWorkspaceDomSettings(
  dom: JSDOM,
  state: BrowserWorkspaceRuntimeState,
): void {
  const viewport = state.settings.viewport;
  if (viewport) {
    Object.defineProperty(dom.window, "innerWidth", {
      configurable: true,
      value: viewport.width,
    });
    Object.defineProperty(dom.window, "innerHeight", {
      configurable: true,
      value: viewport.height,
    });
    Object.defineProperty(dom.window, "devicePixelRatio", {
      configurable: true,
      value: viewport.scale,
    });
  }

  Object.defineProperty(dom.window.navigator, "onLine", {
    configurable: true,
    get: () => !state.settings.offline,
  });

  if (state.settings.device) {
    Object.defineProperty(dom.window.navigator, "userAgent", {
      configurable: true,
      value: `ElizaBrowserWorkspace/${state.settings.device}`,
    });
  }

  const matchMedia = (query: string) => {
    const matches =
      query.includes("prefers-color-scheme") &&
      ((state.settings.media === "dark" && query.includes("dark")) ||
        (state.settings.media === "light" && query.includes("light")));
    return {
      addEventListener() {},
      addListener() {},
      dispatchEvent() {
        return true;
      },
      matches,
      media: query,
      onchange: null,
      removeEventListener() {},
      removeListener() {},
    };
  };
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: matchMedia,
  });

  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: {
      readText: async () => browserWorkspaceClipboardText,
      writeText: async (value: string) => {
        browserWorkspaceClipboardText = String(value ?? "");
      },
    },
  });

  Object.defineProperty(dom.window.navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (success: (position: unknown) => void) => {
        const coords = state.settings.geo ?? { latitude: 0, longitude: 0 };
        success({
          coords: {
            accuracy: 1,
            latitude: coords.latitude,
            longitude: coords.longitude,
          },
          timestamp: Date.now(),
        });
      },
    },
  });
}

function installBrowserWorkspaceWebRuntime(
  tab: WebBrowserWorkspaceTabState,
  dom: JSDOM,
): void {
  const state = getBrowserWorkspaceRuntimeState("web", tab.id);
  applyBrowserWorkspaceDomSettings(dom, state);

  const windowRecord = dom.window as unknown as Record<string, unknown>;
  windowRecord.__elizaBrowserWorkspaceState = state;

  const consoleTarget = dom.window.console as Console & Record<string, unknown>;
  if (!consoleTarget.__elizaWrapped) {
    for (const level of ["log", "info", "warn", "error"] as const) {
      consoleTarget[level] = (...args: unknown[]) => {
        state.consoleEntries.push({
          level,
          message: args
            .map((value) => normalizeBrowserWorkspaceText(value))
            .join(" "),
          timestamp: getBrowserWorkspaceTimestamp(),
        });
        return undefined;
      };
    }
    consoleTarget.__elizaWrapped = true;
  }

  dom.window.alert = (message?: string) => {
    state.dialog = {
      defaultValue: null,
      message: String(message ?? ""),
      open: true,
      type: "alert",
    };
  };
  dom.window.confirm = (message?: string) => {
    state.dialog = {
      defaultValue: null,
      message: String(message ?? ""),
      open: true,
      type: "confirm",
    };
    return false;
  };
  dom.window.prompt = (message?: string, defaultValue?: string) => {
    state.dialog = {
      defaultValue: defaultValue ?? null,
      message: String(message ?? ""),
      open: true,
      type: "prompt",
    };
    return null;
  };

  Object.defineProperty(dom.window, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const inputUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : typeof (input as Request).url === "string"
              ? (input as Request).url
              : String(input);
      return fetchBrowserWorkspaceTrackedResponse(
        state,
        new URL(inputUrl, tab.url).toString(),
        {
          ...init,
          headers:
            init?.headers ??
            ((input as Request).headers
              ? (input as Request).headers
              : undefined),
          method:
            init?.method ??
            (typeof (input as Request).method === "string"
              ? (input as Request).method
              : undefined),
        },
        "fetch",
      );
    },
  });
}

function getWebBrowserWorkspaceTabIndex(tabId: string): number {
  return webWorkspaceState.tabs.findIndex((tab) => tab.id === tabId);
}

function getWebBrowserWorkspaceTabState(
  tabId: string,
): WebBrowserWorkspaceTabState {
  const tab = webWorkspaceState.tabs.find((entry) => entry.id === tabId);
  if (!tab) {
    throw createBrowserWorkspaceNotFoundError(tabId);
  }
  return tab;
}

function getCurrentWebBrowserWorkspaceTabState(): WebBrowserWorkspaceTabState | null {
  if (webWorkspaceState.tabs.length === 0) {
    return null;
  }

  return (
    webWorkspaceState.tabs.find((tab) => tab.visible) ??
    [...webWorkspaceState.tabs].sort((left, right) => {
      const leftTime = left.lastFocusedAt ?? left.updatedAt;
      const rightTime = right.lastFocusedAt ?? right.updatedAt;
      return (
        rightTime.localeCompare(leftTime) || left.id.localeCompare(right.id)
      );
    })[0] ??
    null
  );
}

function createWebBrowserWorkspaceTab(
  request: OpenBrowserWorkspaceTabRequest,
): WebBrowserWorkspaceTabState {
  const now = getBrowserWorkspaceTimestamp();
  const url = assertBrowserWorkspaceUrl(request.url?.trim() || "about:blank");
  const visible = request.show === true;
  const id = `btab_${webWorkspaceState.nextId++}`;
  const dom =
    url === "about:blank" ? createEmptyWebBrowserWorkspaceDom(url) : null;
  if (dom) {
    const bootstrapTab = {
      id,
      title: request.title?.trim() || inferBrowserWorkspaceTitle(url),
      url,
      partition: request.partition?.trim() || DEFAULT_WEB_PARTITION,
      visible,
      createdAt: now,
      updatedAt: now,
      lastFocusedAt: visible ? now : null,
      dom,
      history: [url],
      historyIndex: 0,
      loadedUrl: url,
    } satisfies WebBrowserWorkspaceTabState;
    installBrowserWorkspaceWebRuntime(bootstrapTab, dom);
    return bootstrapTab;
  }
  return {
    id,
    title: request.title?.trim() || inferBrowserWorkspaceTitle(url),
    url,
    partition: request.partition?.trim() || DEFAULT_WEB_PARTITION,
    visible,
    createdAt: now,
    updatedAt: now,
    lastFocusedAt: visible ? now : null,
    dom,
    history: [url],
    historyIndex: 0,
    loadedUrl: url === "about:blank" ? url : null,
  };
}

function buildBrowserWorkspaceCssStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function buildBrowserWorkspaceElementSelector(element: Element): string {
  const escapedId =
    typeof (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS
      ?.escape === "function"
      ? (
          globalThis as { CSS: { escape: (value: string) => string } }
        ).CSS.escape(element.id)
      : element.id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");

  if (element.id) {
    return `#${escapedId}`;
  }

  const testId = element.getAttribute("data-testid")?.trim();
  if (testId) {
    return `[data-testid=${buildBrowserWorkspaceCssStringLiteral(testId)}]`;
  }

  const name = element.getAttribute("name")?.trim();
  if (name) {
    return `${element.tagName.toLowerCase()}[name=${buildBrowserWorkspaceCssStringLiteral(name)}]`;
  }

  const type = element.getAttribute("type")?.trim();
  if (type) {
    return `${element.tagName.toLowerCase()}[type=${buildBrowserWorkspaceCssStringLiteral(type)}]`;
  }

  const parent = element.parentElement;
  if (!parent) {
    return element.tagName.toLowerCase();
  }

  const siblings = parent.children;
  let index = 1;
  for (let cursor = 0; cursor < siblings.length; cursor += 1) {
    const sibling = siblings.item(cursor);
    if (!sibling || sibling.tagName !== element.tagName) {
      continue;
    }
    if (sibling === element) {
      break;
    }
    index += 1;
  }

  return `${element.tagName.toLowerCase()}:nth-of-type(${index})`;
}

function createBrowserWorkspaceElementSummary(
  element: Element,
): BrowserWorkspaceDomElementSummary {
  const inputLike =
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT";

  const elementValue = inputLike
    ? ((element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)
        .value ?? null)
    : null;

  return {
    selector: buildBrowserWorkspaceElementSelector(element),
    tag: element.tagName.toLowerCase(),
    text: normalizeBrowserWorkspaceText(
      inputLike ? elementValue : element.textContent,
    ),
    type: element.getAttribute("type"),
    name: element.getAttribute("name"),
    href: element.getAttribute("href"),
    value: typeof elementValue === "string" ? elementValue : null,
  };
}

function collectBrowserWorkspaceInspectElements(
  document: Document,
): BrowserWorkspaceDomElementSummary[] {
  const elements = Array.from(
    document.querySelectorAll(
      "a, button, input, textarea, select, form, [role='button'], [data-testid]",
    ),
  );
  const summaries: BrowserWorkspaceDomElementSummary[] = [];
  const seenSelectors = new Set<string>();

  for (const element of elements) {
    const summary = createBrowserWorkspaceElementSummary(element);
    if (seenSelectors.has(summary.selector)) {
      continue;
    }
    seenSelectors.add(summary.selector);
    summaries.push(summary);
    if (summaries.length >= 40) {
      break;
    }
  }

  return summaries;
}

function resolveBrowserWorkspaceIframeDocument(
  runtime: BrowserWorkspaceRuntimeState,
  frameElement: Element | null,
  baseUrl: string,
): Document | null {
  if (!frameElement || frameElement.tagName !== "IFRAME") {
    return null;
  }

  const iframe = frameElement as HTMLIFrameElement;
  const srcdoc = iframe.getAttribute("srcdoc");
  if (srcdoc?.trim()) {
    const selector = buildBrowserWorkspaceElementSelector(frameElement);
    const cached = runtime.frameDoms.get(selector);
    if (cached) {
      return cached.window.document;
    }
    if (
      iframe.contentDocument &&
      normalizeBrowserWorkspaceText(iframe.contentDocument.body?.textContent)
        .length > 0
    ) {
      return iframe.contentDocument;
    }
    const parsed = new (getJSDOMClass())(srcdoc, {
      pretendToBeVisual: true,
      url: baseUrl,
    });
    runtime.frameDoms.set(selector, parsed);
    return parsed.window.document;
  }

  if (iframe.contentDocument) {
    return iframe.contentDocument;
  }

  return null;
}

function resolveWebBrowserWorkspaceCommandDocument(
  tab: WebBrowserWorkspaceTabState,
  dom: JSDOM,
): { document: Document; frameSelector: string | null } {
  const state = getBrowserWorkspaceRuntimeState("web", tab.id);
  const frameSelector = state.currentFrame?.trim() || null;
  if (!frameSelector) {
    return { document: dom.window.document, frameSelector: null };
  }

  const frameElement = resolveBrowserWorkspaceElement(
    dom.window.document,
    frameSelector,
  );
  const frameDocument = resolveBrowserWorkspaceIframeDocument(
    state,
    frameElement,
    tab.url,
  );
  if (!frameDocument) {
    return { document: dom.window.document, frameSelector: null };
  }

  return { document: frameDocument, frameSelector };
}

function getBrowserWorkspaceElementSearchTexts(element: Element): string[] {
  const labelText =
    element.id && element.ownerDocument
      ? Array.from(
          element.ownerDocument.querySelectorAll(`label[for="${element.id}"]`),
        )
          .map((label) => label.textContent)
          .join(" ")
      : "";
  return [
    element.textContent,
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
    element.getAttribute("title"),
    element.getAttribute("name"),
    element.getAttribute("alt"),
    element.getAttribute("data-testid"),
    labelText,
    (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)
      .value,
  ]
    .map((value) => normalizeBrowserWorkspaceText(value))
    .filter(Boolean);
}

function browserWorkspaceTextMatches(
  candidate: string,
  wanted: string,
  exact = false,
): boolean {
  const normalizedCandidate =
    normalizeBrowserWorkspaceText(candidate).toLowerCase();
  const normalizedWanted = normalizeBrowserWorkspaceText(wanted).toLowerCase();
  if (!normalizedCandidate || !normalizedWanted) {
    return false;
  }
  return exact
    ? normalizedCandidate === normalizedWanted
    : normalizedCandidate.includes(normalizedWanted);
}

function isBrowserWorkspaceElementVisible(element: Element): boolean {
  if (
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden") === "true"
  ) {
    return false;
  }

  const htmlElement = element as HTMLElement;
  const inlineDisplay = htmlElement.style?.display?.trim().toLowerCase();
  const inlineVisibility = htmlElement.style?.visibility?.trim().toLowerCase();
  if (inlineDisplay === "none" || inlineVisibility === "hidden") {
    return false;
  }

  return true;
}

function findBrowserWorkspaceElementByLabel(
  document: Document,
  labelText: string,
  exact = false,
): Element | null {
  const labels = Array.from(document.querySelectorAll("label"));
  for (const label of labels) {
    if (
      !browserWorkspaceTextMatches(label.textContent ?? "", labelText, exact)
    ) {
      continue;
    }

    const forId = label.getAttribute("for")?.trim();
    if (forId) {
      const explicit = document.getElementById(forId);
      if (explicit) {
        return explicit;
      }
    }

    const nested = label.querySelector("input, textarea, select, button");
    if (nested) {
      return nested;
    }
  }
  return null;
}

function getBrowserWorkspaceNativeRole(element: Element): string | null {
  const explicitRole = element.getAttribute("role")?.trim().toLowerCase();
  if (explicitRole) {
    return explicitRole;
  }

  const tag = element.tagName.toLowerCase();
  if (tag === "a" && element.getAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "option") return "option";
  if (tag === "textarea") return "textbox";
  if (tag === "form") return "form";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "input") {
    const input = element as HTMLInputElement;
    const type = (input.type || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (["button", "submit", "reset", "image"].includes(type)) {
      return "button";
    }
    return "textbox";
  }
  return null;
}

function findBrowserWorkspaceElementByRole(
  document: Document,
  role: string,
  name?: string,
  exact = false,
): Element | null {
  const wantedRole = role.trim().toLowerCase();
  if (!wantedRole) {
    return null;
  }

  const candidates = Array.from(
    document.querySelectorAll(
      "a, button, input, textarea, select, option, form, h1, h2, h3, h4, h5, h6, [role], [data-testid]",
    ),
  );
  for (const candidate of candidates) {
    if (getBrowserWorkspaceNativeRole(candidate) !== wantedRole) {
      continue;
    }
    if (!name?.trim()) {
      return candidate;
    }
    const haystacks = getBrowserWorkspaceElementSearchTexts(candidate);
    if (
      haystacks.some((value) => browserWorkspaceTextMatches(value, name, exact))
    ) {
      return candidate;
    }
  }
  return null;
}

function trimBrowserWorkspaceQuotedValue(value: string): string {
  const trimmed = value.trim();
  const hasTextMatch = trimmed.match(/^has-text\((['"])([\s\S]*?)\1\)$/i);
  if (hasTextMatch?.[2]) {
    return hasTextMatch[2].trim();
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeBrowserWorkspaceSelectorSyntax(selector: string): string {
  let normalized = selector.trim();
  normalized = normalized.replace(
    /^role\s*[:=]\s*([a-z0-9_-]+)\s+name\s*[:=]\s*(.+)$/i,
    "role=$1[name=$2]",
  );
  normalized = normalized.replace(
    /^((?:label|text|placeholder|alt|title|testid|data-testid)\s*[:=]\s*(?:has-text\((['"])[\s\S]*?\2\)|"[^"]+"|'[^']+'|[^>]+?))\s+((?:input|textarea|select)[\s\S]*)$/i,
    "$1 >> $3",
  );
  return normalized;
}

function parseBrowserWorkspaceSemanticSelector(
  selector: string,
): Pick<
  BrowserWorkspaceCommand,
  "findBy" | "name" | "role" | "selector" | "text"
> | null {
  const trimmed = normalizeBrowserWorkspaceSelectorSyntax(selector);
  const match = trimmed.match(/^([a-z-]+)\s*[:=]\s*(.+)$/i);
  if (!match) {
    return null;
  }

  const kind = match[1]?.trim().toLowerCase();
  const rawValue = match[2]?.trim() ?? "";
  if (!kind || !rawValue) {
    return null;
  }

  switch (kind) {
    case "alt":
      return { findBy: "alt", text: trimBrowserWorkspaceQuotedValue(rawValue) };
    case "css":
      return { selector: trimBrowserWorkspaceQuotedValue(rawValue) };
    case "data-testid":
    case "testid":
      return {
        findBy: "testid",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    case "label":
      return {
        findBy: "label",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    case "placeholder":
      return {
        findBy: "placeholder",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    case "role": {
      const roleMatch = rawValue.match(
        /^([a-z0-9_-]+)(?:\s*\[\s*name\s*[:=]\s*(.+?)\s*\])?$/i,
      );
      if (!roleMatch?.[1]) {
        return null;
      }
      return {
        findBy: "role",
        name: roleMatch[2]
          ? trimBrowserWorkspaceQuotedValue(roleMatch[2])
          : undefined,
        role: roleMatch[1].trim().toLowerCase(),
      };
    }
    case "text":
      return {
        findBy: "text",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    case "title":
      return {
        findBy: "title",
        text: trimBrowserWorkspaceQuotedValue(rawValue),
      };
    default:
      return null;
  }
}

function mergeBrowserWorkspaceSelectorCommand(
  command: BrowserWorkspaceCommand | undefined,
  selector: string,
): BrowserWorkspaceCommand | null {
  const parsed = parseBrowserWorkspaceSemanticSelector(selector);
  if (!parsed) {
    return null;
  }

  return {
    ...command,
    ...parsed,
    selector: parsed.selector,
  } as BrowserWorkspaceCommand;
}

function queryBrowserWorkspaceSelector(
  root: Document | Element,
  selector: string,
): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    throw new Error(`Invalid selector ${selector}`);
  }
}

function queryAllBrowserWorkspaceSelector(
  root: Document | Element,
  selector: string,
): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    throw new Error(`Invalid selector ${selector}`);
  }
}

function browserWorkspacePatternMatches(
  pattern: string,
  value: string,
): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  if (!trimmed.includes("*")) {
    return value.includes(trimmed);
  }
  let wildcardPattern = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] ?? "";
    if (char === "*") {
      const next = trimmed[index + 1];
      if (next === "*") {
        wildcardPattern += ".*";
        index += 1;
      } else {
        wildcardPattern += ".*";
      }
      continue;
    }
    wildcardPattern += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${wildcardPattern}$`, "i").test(value);
}

function normalizeBrowserWorkspaceHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" &&
        entry[0].trim().length > 0 &&
        typeof entry[1] === "string",
    ),
  );
}

function findBrowserWorkspaceNetworkRoute(
  state: BrowserWorkspaceRuntimeState,
  url: string,
): BrowserWorkspaceNetworkRoute | null {
  return (
    [...state.networkRoutes]
      .reverse()
      .find((route) => browserWorkspacePatternMatches(route.pattern, url)) ??
    null
  );
}

function recordBrowserWorkspaceNetworkRequest(
  state: BrowserWorkspaceRuntimeState,
  request: Omit<BrowserWorkspaceNetworkRequestRecord, "id" | "timestamp">,
): BrowserWorkspaceNetworkRequestRecord {
  const entry: BrowserWorkspaceNetworkRequestRecord = {
    ...request,
    id: `req_${state.networkNextRequestId++}`,
    timestamp: getBrowserWorkspaceTimestamp(),
  };
  state.networkRequests.push(entry);
  if (state.networkHar.active) {
    state.networkHar.entries.push(entry);
  }
  return entry;
}

async function fetchBrowserWorkspaceTrackedResponse(
  state: BrowserWorkspaceRuntimeState,
  url: string,
  init: RequestInit = {},
  resourceType: string,
): Promise<Response> {
  if (state.settings.offline) {
    recordBrowserWorkspaceNetworkRequest(state, {
      matchedRoute: null,
      method: String(init.method ?? "GET").toUpperCase(),
      resourceType,
      responseBody: null,
      responseHeaders: {},
      status: 0,
      url,
    });
    throw new Error("Browser workspace is offline.");
  }

  const route = findBrowserWorkspaceNetworkRoute(state, url);
  if (route?.abort) {
    recordBrowserWorkspaceNetworkRequest(state, {
      matchedRoute: route.pattern,
      method: String(init.method ?? "GET").toUpperCase(),
      resourceType,
      responseBody: null,
      responseHeaders: route.headers,
      status: 0,
      url,
    });
    throw new Error(`Browser workspace network route aborted request: ${url}`);
  }

  if (
    route &&
    (route.body !== null ||
      route.status !== null ||
      Object.keys(route.headers).length > 0)
  ) {
    const response = new Response(route?.body ?? "", {
      headers: route?.headers,
      status: route?.status ?? 200,
    });
    recordBrowserWorkspaceNetworkRequest(state, {
      matchedRoute: route?.pattern ?? null,
      method: String(init.method ?? "GET").toUpperCase(),
      resourceType,
      responseBody: route?.body ?? "",
      responseHeaders: route?.headers ?? {},
      status: route?.status ?? 200,
      url,
    });
    return response;
  }

  const headers = new Headers(init.headers ?? {});
  for (const [key, value] of Object.entries(state.settings.headers)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  if (
    state.settings.credentials &&
    !headers.has("Authorization") &&
    state.settings.credentials.username
  ) {
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(
        `${state.settings.credentials.username}:${state.settings.credentials.password}`,
      ).toString("base64")}`,
    );
  }

  const response = await browserWorkspacePageFetch(url, {
    ...init,
    headers,
    redirect: init.redirect ?? "follow",
    signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  let responseBody: string | null = null;
  if (resourceType !== "document") {
    const clone = response.clone();
    try {
      responseBody = await clone.text();
    } catch {
      responseBody = null;
    }
  }
  recordBrowserWorkspaceNetworkRequest(state, {
    matchedRoute: null,
    method: String(init.method ?? "GET").toUpperCase(),
    resourceType,
    responseBody,
    responseHeaders: Object.fromEntries(response.headers.entries()),
    status: response.status,
    url: response.url || url,
  });
  return response;
}

function escapeBrowserWorkspacePdfText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function createBrowserWorkspacePdfBuffer(
  title: string,
  bodyText: string,
): Buffer {
  const lines = [
    title.trim() || "Eliza Browser Workspace",
    "",
    ...bodyText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 32),
  ];
  const contentLines = lines.map((line, index) => {
    const offset = index === 0 ? "50 750 Td" : "0 -18 Td";
    return `${offset} (${escapeBrowserWorkspacePdfText(line)}) Tj`;
  });
  const stream = `BT\n/F1 12 Tf\n${contentLines.join("\n")}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

function createBrowserWorkspaceSyntheticScreenshotData(
  title: string,
  url: string,
  bodyText: string,
  viewport?: { height: number; width: number },
): string {
  const width = viewport?.width ?? 1280;
  const height = viewport?.height ?? 720;
  const lines = [
    title || "Eliza Browser Workspace",
    url,
    "",
    ...bodyText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 18),
  ];
  const escapedLines = lines.map((line) =>
    line
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;"),
  );
  const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#faf7f1"/><rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="18" fill="#ffffff" stroke="#d8d1c4"/><text x="48" y="72" font-family="Menlo, Monaco, monospace" font-size="20" fill="#111111">${escapedLines.map((line, index) => `<tspan x="48" dy="${index === 0 ? 0 : 28}">${line}</tspan>`).join("")}</text></svg>`;
  return Buffer.from(svg, "utf8").toString("base64");
}

function createBrowserWorkspaceSnapshotRecord(
  title: string,
  url: string,
  bodyText: string,
): BrowserWorkspaceSnapshotRecord {
  return {
    bodyText: normalizeBrowserWorkspaceText(bodyText),
    title: normalizeBrowserWorkspaceText(title),
    url: normalizeBrowserWorkspaceText(url),
  };
}

function buildBrowserWorkspaceDocumentSnapshotText(document: Document): string {
  const bodyText = normalizeBrowserWorkspaceText(document.body?.textContent);
  const controlText = Array.from(
    document.querySelectorAll("input, textarea, select, option:checked"),
  )
    .map((element) => {
      const name =
        element.getAttribute("name") ||
        element.getAttribute("id") ||
        element.tagName.toLowerCase();
      const value =
        element.tagName === "SELECT"
          ? (element as HTMLSelectElement).value
          : "value" in (element as HTMLInputElement | HTMLTextAreaElement)
            ? (element as HTMLInputElement | HTMLTextAreaElement).value
            : (element.textContent ?? "");
      return `${name}:${normalizeBrowserWorkspaceText(value)}`;
    })
    .filter(Boolean)
    .join(" ");
  return normalizeBrowserWorkspaceText(`${bodyText} ${controlText}`);
}

function diffBrowserWorkspaceSnapshots(
  before: BrowserWorkspaceSnapshotRecord | null,
  after: BrowserWorkspaceSnapshotRecord,
): Record<string, unknown> {
  return {
    changed:
      !before ||
      before.bodyText !== after.bodyText ||
      before.title !== after.title ||
      before.url !== after.url,
    previous: before,
    current: after,
  };
}

async function writeBrowserWorkspaceFile(
  filePath: string,
  contents: string | Uint8Array,
): Promise<string> {
  const resolved = path.resolve(filePath);
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  await fsp.writeFile(resolved, contents);
  return resolved;
}

function resolveBrowserWorkspaceFindElement(
  document: Document,
  command: BrowserWorkspaceCommand,
): Element | null {
  switch (command.findBy) {
    case "alt":
      return (
        Array.from(document.querySelectorAll("[alt]")).find((element) =>
          browserWorkspaceTextMatches(
            element.getAttribute("alt") ?? "",
            command.text ?? "",
            command.exact,
          ),
        ) ?? null
      );
    case "first":
      return command.selector?.trim()
        ? queryBrowserWorkspaceSelector(document, command.selector)
        : null;
    case "label":
      return command.text?.trim()
        ? findBrowserWorkspaceElementByLabel(
            document,
            command.text,
            command.exact,
          )
        : null;
    case "last":
      return command.selector?.trim()
        ? (queryAllBrowserWorkspaceSelector(document, command.selector).at(
            -1,
          ) ?? null)
        : null;
    case "nth":
      if (!command.selector?.trim()) {
        return null;
      }
      if (
        typeof command.index !== "number" ||
        !Number.isInteger(command.index)
      ) {
        return null;
      }
      return (
        queryAllBrowserWorkspaceSelector(document, command.selector).at(
          command.index,
        ) ?? null
      );
    case "placeholder":
      return (
        Array.from(document.querySelectorAll("[placeholder]")).find((element) =>
          browserWorkspaceTextMatches(
            element.getAttribute("placeholder") ?? "",
            command.text ?? "",
            command.exact,
          ),
        ) ?? null
      );
    case "role":
      return command.role?.trim()
        ? findBrowserWorkspaceElementByRole(
            document,
            command.role,
            command.name,
            command.exact,
          )
        : null;
    case "testid":
      return command.text?.trim()
        ? document.querySelector(
            `[data-testid=${buildBrowserWorkspaceCssStringLiteral(command.text)}]`,
          )
        : null;
    case "text":
      return command.text?.trim()
        ? findBrowserWorkspaceElementByText(document, command.text)
        : null;
    case "title":
      return (
        Array.from(document.querySelectorAll("[title]")).find((element) =>
          browserWorkspaceTextMatches(
            element.getAttribute("title") ?? "",
            command.text ?? "",
            command.exact,
          ),
        ) ?? null
      );
    default:
      return null;
  }
}

function findBrowserWorkspaceElementByText(
  document: Document,
  needle: string,
): Element | null {
  const wanted = normalizeBrowserWorkspaceText(needle).toLowerCase();
  if (!wanted) {
    return null;
  }

  const candidates = Array.from(
    document.querySelectorAll(
      "a, button, input, textarea, select, option, label, h1, h2, h3, [role='button'], [data-testid]",
    ),
  );

  for (const element of candidates) {
    const haystacks = [
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("title"),
      element.getAttribute("name"),
      (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)
        .value,
    ]
      .map((value) => normalizeBrowserWorkspaceText(value))
      .filter(Boolean)
      .map((value) => value.toLowerCase());

    if (haystacks.some((value) => value.includes(wanted))) {
      return element;
    }
  }

  return null;
}

function resolveBrowserWorkspaceElement(
  document: Document,
  selector?: string,
  text?: string,
  command?: BrowserWorkspaceCommand,
): Element | null {
  const normalizedSelector = selector
    ? normalizeBrowserWorkspaceSelectorSyntax(selector)
    : undefined;
  if (normalizedSelector) {
    const selectorChain = normalizedSelector
      .split(/\s*>>\s*/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (selectorChain.length > 1) {
      let current = resolveBrowserWorkspaceElement(
        document,
        selectorChain[0],
        undefined,
        command,
      );
      for (let index = 1; current && index < selectorChain.length; index += 1) {
        const segment = selectorChain[index];
        if (!segment) {
          continue;
        }
        if (
          typeof (current as Element).matches === "function" &&
          (current as Element).matches(segment)
        ) {
          continue;
        }
        if (
          /^(input|textarea|select)(?:\[[^\]]+\])?$/i.test(segment) &&
          (current.tagName === "INPUT" ||
            current.tagName === "TEXTAREA" ||
            current.tagName === "SELECT")
        ) {
          continue;
        }
        current = queryBrowserWorkspaceSelector(current, segment);
      }
      return current;
    }
    const semanticCommand = mergeBrowserWorkspaceSelectorCommand(
      command,
      normalizedSelector,
    );
    if (semanticCommand) {
      return resolveBrowserWorkspaceFindElement(document, semanticCommand);
    }
    return queryBrowserWorkspaceSelector(document, normalizedSelector);
  }

  if (command?.findBy) {
    return resolveBrowserWorkspaceFindElement(document, command);
  }

  const normalizedText = text?.trim();
  if (normalizedText) {
    return findBrowserWorkspaceElementByText(document, normalizedText);
  }

  return null;
}

function ensureBrowserWorkspaceFormControlElement(
  element: Element,
  subaction:
    | "clipboard"
    | "fill"
    | "keyboardinserttext"
    | "keyboardtype"
    | "select"
    | "type",
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  if (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  ) {
    return element as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement;
  }

  throw new Error(
    `Eliza browser workspace ${subaction} requires an input, textarea, or select target.`,
  );
}

function ensureBrowserWorkspaceCheckboxElement(
  element: Element,
  subaction: "check" | "uncheck",
): HTMLInputElement {
  if (element.tagName === "INPUT") {
    const input = element as HTMLInputElement;
    const type = input.type.trim().toLowerCase();
    if (type === "checkbox" || type === "radio") {
      return input;
    }
  }

  throw new Error(
    `Eliza browser workspace ${subaction} requires a checkbox or radio input target.`,
  );
}

function getBrowserWorkspaceElementStyles(
  element: Element,
  window: Window,
): Record<string, string | null> {
  const computed = window.getComputedStyle(element);
  return {
    display: computed.display || null,
    visibility: computed.visibility || null,
    opacity: computed.opacity || null,
  };
}

function normalizeBrowserWorkspaceCommand(
  command: BrowserWorkspaceCommand,
): BrowserWorkspaceCommand {
  const raw = command as BrowserWorkspaceCommand & Record<string, unknown>;
  const normalizedSubaction =
    typeof raw.subaction === "string"
      ? raw.subaction.trim().toLowerCase()
      : typeof raw.operation === "string"
        ? raw.operation.trim().toLowerCase()
        : "";
  const subaction =
    normalizedSubaction === "goto"
      ? "navigate"
      : normalizedSubaction === "read"
        ? "get"
        : command.subaction;
  const timeoutMs =
    parseBrowserWorkspaceNumberLike(command.timeoutMs) ??
    parseBrowserWorkspaceNumberLike(raw.ms) ??
    parseBrowserWorkspaceNumberLike(raw.milliseconds);

  return {
    ...command,
    subaction,
    timeoutMs,
    steps: Array.isArray(command.steps)
      ? command.steps.map((step) => normalizeBrowserWorkspaceCommand(step))
      : command.steps,
  };
}

function getBrowserWorkspaceElementBox(element: Element): {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
  x: number;
  y: number;
} {
  const box =
    typeof (element as HTMLElement).getBoundingClientRect === "function"
      ? (element as HTMLElement).getBoundingClientRect()
      : {
          bottom: 0,
          height: 0,
          left: 0,
          right: 0,
          top: 0,
          width: 0,
          x: 0,
          y: 0,
        };
  return {
    bottom: box.bottom,
    height: box.height,
    left: box.left,
    right: box.right,
    top: box.top,
    width: box.width,
    x: box.x,
    y: box.y,
  };
}

function getBrowserWorkspaceElementValue(
  element: Element,
): string | boolean | null {
  if (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT"
  ) {
    const control = element as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement;
    if (element.tagName === "INPUT") {
      const input = control as HTMLInputElement;
      const type = input.type.trim().toLowerCase();
      if (type === "checkbox" || type === "radio") {
        return input.checked;
      }
    }
    return control.value;
  }
  return null;
}

function findClosestBrowserWorkspaceForm(
  element: Element | null,
): HTMLFormElement | null {
  if (!element) {
    return null;
  }
  return (
    element.tagName === "FORM" ? element : element.closest("form")
  ) as HTMLFormElement | null;
}

async function activateWebBrowserWorkspaceElement(
  tab: WebBrowserWorkspaceTabState,
  element: Element,
  subaction: "click" | "dblclick",
): Promise<BrowserWorkspaceCommandResult> {
  const tag = element.tagName.toLowerCase();
  if (tag === "a") {
    const href = element.getAttribute("href")?.trim();
    if (!href) {
      throw new Error("Target link does not have an href.");
    }
    const nextUrl = new URL(href, tab.url).toString();
    clearWebBrowserWorkspaceTabElementRefs(tab.id);
    tab.url = assertBrowserWorkspaceUrl(nextUrl);
    tab.title = inferBrowserWorkspaceTitle(tab.url);
    tab.dom = null;
    tab.loadedUrl = null;
    pushWebBrowserWorkspaceHistory(tab, tab.url);
    await loadWebBrowserWorkspaceTabDocument(tab);
    return {
      mode: "web",
      subaction,
      tab: cloneWebBrowserWorkspaceTabState(tab),
      value: {
        clickCount: subaction === "dblclick" ? 2 : 1,
        selector: buildBrowserWorkspaceElementSelector(element),
        url: tab.url,
      },
    };
  }

  const inputElement = tag === "input" ? (element as HTMLInputElement) : null;
  const inputType = inputElement?.type?.toLowerCase() ?? "";
  if (inputElement && (inputType === "checkbox" || inputType === "radio")) {
    inputElement.checked = inputType === "radio" ? true : !inputElement.checked;
    return {
      mode: "web",
      subaction,
      value: {
        checked: inputElement.checked,
        clickCount: subaction === "dblclick" ? 2 : 1,
        selector: buildBrowserWorkspaceElementSelector(element),
      },
    };
  }

  const submitForm = findClosestBrowserWorkspaceForm(element);
  if (
    submitForm &&
    (tag === "form" ||
      tag === "button" ||
      (tag === "input" &&
        ["button", "image", "submit"].includes(inputType || "submit")))
  ) {
    await submitWebBrowserWorkspaceForm(tab, submitForm);
    return {
      mode: "web",
      subaction,
      tab: cloneWebBrowserWorkspaceTabState(tab),
      value: {
        clickCount: subaction === "dblclick" ? 2 : 1,
        selector: buildBrowserWorkspaceElementSelector(element),
        url: tab.url,
      },
    };
  }

  return {
    mode: "web",
    subaction,
    value: {
      clickCount: subaction === "dblclick" ? 2 : 1,
      selector: buildBrowserWorkspaceElementSelector(element),
      text: normalizeBrowserWorkspaceText(element.textContent),
    },
  };
}

function setBrowserWorkspaceControlValue(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  nextValue: string,
): void {
  control.value = nextValue;
  if (control.tagName === "TEXTAREA") {
    control.textContent = nextValue;
  }
  control.setAttribute("value", nextValue);
}

function scrollWebBrowserWorkspaceTarget(
  dom: JSDOM,
  element: Element | null,
  direction: BrowserWorkspaceScrollDirection,
  pixels: number,
): {
  axis: "x" | "y";
  selector: string | null;
  value: number;
} {
  const resolvedPixels = Number.isFinite(pixels)
    ? Math.max(1, Math.abs(pixels))
    : 240;
  const axis = direction === "left" || direction === "right" ? "x" : "y";
  const delta =
    direction === "up" || direction === "left"
      ? -resolvedPixels
      : resolvedPixels;

  if (element && element instanceof dom.window.HTMLElement) {
    if (axis === "y") {
      element.scrollTop = (element.scrollTop || 0) + delta;
      return {
        axis,
        selector: buildBrowserWorkspaceElementSelector(element),
        value: element.scrollTop,
      };
    }
    element.scrollLeft = (element.scrollLeft || 0) + delta;
    return {
      axis,
      selector: buildBrowserWorkspaceElementSelector(element),
      value: element.scrollLeft,
    };
  }

  const key = axis === "y" ? "__elizaScrollY" : "__elizaScrollX";
  const current = Number(
    (dom.window as unknown as Record<string, unknown>)[key] ?? 0,
  );
  const next = current + delta;
  (dom.window as unknown as Record<string, unknown>)[key] = next;
  return {
    axis,
    selector: null,
    value: next,
  };
}

function ensureBrowserWorkspaceDom(tab: WebBrowserWorkspaceTabState): JSDOM {
  if (tab.dom && tab.loadedUrl === tab.url) {
    return tab.dom;
  }

  throw new Error(
    `Browser workspace tab ${tab.id} is not loaded yet. Reload or inspect the page first.`,
  );
}

async function loadWebBrowserWorkspaceTabDocument(
  tab: WebBrowserWorkspaceTabState,
): Promise<void> {
  const state = getBrowserWorkspaceRuntimeState("web", tab.id);
  if (tab.url === "about:blank") {
    tab.dom = createEmptyWebBrowserWorkspaceDom(tab.url);
    installBrowserWorkspaceWebRuntime(tab, tab.dom);
    tab.loadedUrl = tab.url;
    tab.title = "New Tab";
    tab.updatedAt = getBrowserWorkspaceTimestamp();
    return;
  }

  const response = await fetchBrowserWorkspaceTrackedResponse(
    state,
    tab.url,
    {},
    "document",
  );
  if (!response.ok) {
    throw new Error(
      `Browser workspace web load failed (${response.status}): ${tab.url}`,
    );
  }

  const html = await response.text();
  const finalUrl = assertBrowserWorkspaceUrl(response.url?.trim() || tab.url);
  const dom = new (getJSDOMClass())(html, {
    pretendToBeVisual: true,
    url: finalUrl,
  });
  installBrowserWorkspaceWebRuntime(tab, dom);
  resetBrowserWorkspaceRuntimeNavigationState(state);

  tab.dom = dom;
  tab.loadedUrl = finalUrl;
  tab.url = finalUrl;
  tab.title =
    normalizeBrowserWorkspaceText(dom.window.document.title) ||
    inferBrowserWorkspaceTitle(finalUrl);
  tab.updatedAt = getBrowserWorkspaceTimestamp();
  tab.history[tab.historyIndex] = finalUrl;
}

async function ensureLoadedWebBrowserWorkspaceTabDocument(
  tab: WebBrowserWorkspaceTabState,
): Promise<JSDOM> {
  if (!tab.dom || tab.loadedUrl !== tab.url) {
    await loadWebBrowserWorkspaceTabDocument(tab);
  }
  return ensureBrowserWorkspaceDom(tab);
}

function pushWebBrowserWorkspaceHistory(
  tab: WebBrowserWorkspaceTabState,
  nextUrl: string,
): void {
  const nextHistory = tab.history.slice(0, tab.historyIndex + 1);
  nextHistory.push(nextUrl);
  tab.history = nextHistory;
  tab.historyIndex = nextHistory.length - 1;
}

function findWebBrowserWorkspaceTargetTabId(
  command: BrowserWorkspaceCommand,
): string {
  if (command.id?.trim()) {
    return command.id.trim();
  }
  const current = getCurrentWebBrowserWorkspaceTabState();
  if (!current) {
    throw createBrowserWorkspaceCommandTargetError(command.subaction);
  }
  return current.id;
}

function resolveBrowserWorkspaceCurrentTab(
  tabs: BrowserWorkspaceTab[],
): BrowserWorkspaceTab | null {
  if (tabs.length === 0) {
    return null;
  }

  return (
    tabs.find((tab) => tab.visible) ??
    [...tabs].sort((left, right) => {
      const leftTime = left.lastFocusedAt ?? left.updatedAt;
      const rightTime = right.lastFocusedAt ?? right.updatedAt;
      return (
        rightTime.localeCompare(leftTime) || left.id.localeCompare(right.id)
      );
    })[0] ??
    null
  );
}

async function resolveDesktopBrowserWorkspaceTargetTabId(
  command: BrowserWorkspaceCommand,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (command.id?.trim()) {
    return command.id.trim();
  }

  const tabs = await listBrowserWorkspaceTabs(env);
  const current = resolveBrowserWorkspaceCurrentTab(tabs);
  if (!current) {
    throw createBrowserWorkspaceCommandTargetError(command.subaction);
  }
  return current.id;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 240);
  } catch {
    return "";
  }
}

async function requestBrowserWorkspace<T>(
  path: string,
  init?: RequestInit,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const config = resolveBrowserWorkspaceBridgeConfig(env);
  if (!config) {
    throw new Error(getBrowserWorkspaceUnavailableMessage());
  }

  const headers = new Headers(init?.headers ?? {});
  headers.set("Accept", "application/json");
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  if (config.token) {
    headers.set("Authorization", `Bearer ${config.token}`);
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const details = await readErrorBody(response);
    throw new Error(
      `Browser workspace request failed (${response.status})${details ? `: ${details}` : ""}`,
    );
  }

  return (await response.json()) as T;
}

function createDesktopBrowserWorkspaceCommandScript(
  command: BrowserWorkspaceCommand,
): string {
  return `
(() => {
  const command = ${JSON.stringify(command)};
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const textMatches = (candidate, wanted, exact = false) => {
    const left = normalize(candidate).toLowerCase();
    const right = normalize(wanted).toLowerCase();
    if (!left || !right) return false;
    return exact ? left === right : left.includes(right);
  };
  const selectorFor = (element) => {
    if (!element) return "";
    if (element.id) return "#" + element.id.replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
    const testId = element.getAttribute?.("data-testid");
    if (testId) return \`[data-testid="\${testId}"]\`;
    const name = element.getAttribute?.("name");
    if (name) return \`\${element.tagName.toLowerCase()}[name="\${name}"]\`;
    const type = element.getAttribute?.("type");
    if (type) return \`\${element.tagName.toLowerCase()}[type="\${type}"]\`;
    let index = 1;
    let previous = element.previousElementSibling;
    while (previous) {
      if (previous.tagName === element.tagName) index += 1;
      previous = previous.previousElementSibling;
    }
    return \`\${element.tagName.toLowerCase()}:nth-of-type(\${index})\`;
  };
  const serialize = (element) => {
    const value =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element.value
        : null;
    return {
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      text: normalize(value ?? element.textContent),
      type: element.getAttribute?.("type"),
      name: element.getAttribute?.("name"),
      href: element.getAttribute?.("href"),
      value: typeof value === "string" ? value : null,
    };
  };
  const searchTexts = (element) => {
    const labelText = element.id
      ? Array.from(document.querySelectorAll('label[for="' + element.id + '"]'))
          .map((label) => label.textContent)
          .join(" ")
      : "";
    return [
      element.textContent,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("placeholder"),
      element.getAttribute?.("title"),
      element.getAttribute?.("name"),
      element.getAttribute?.("alt"),
      element.getAttribute?.("data-testid"),
      labelText,
      element.value,
    ]
      .map((value) => normalize(value))
      .filter(Boolean);
  };
  const isVisible = (element) => {
    if (!element) return false;
    if (element.hasAttribute?.("hidden") || element.getAttribute?.("aria-hidden") === "true") {
      return false;
    }
    const style = element.style || {};
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const nativeRole = (element) => {
    const explicit = element.getAttribute?.("role")?.trim()?.toLowerCase();
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.getAttribute?.("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "option") return "option";
    if (tag === "textarea") return "textbox";
    if (tag === "form") return "form";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (element.type || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      return "textbox";
    }
    return null;
  };
  const findByText = (wanted) => {
    const needle = normalize(wanted).toLowerCase();
    if (!needle) return null;
    const elements = Array.from(document.querySelectorAll(
      "a, button, input, textarea, select, option, label, h1, h2, h3, [role='button'], [data-testid]"
    ));
    for (const element of elements) {
      const haystacks = [
        element.textContent,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("placeholder"),
        element.getAttribute?.("title"),
        element.getAttribute?.("name"),
        element.value,
      ]
        .map((value) => normalize(value))
        .filter(Boolean)
        .map((value) => value.toLowerCase());
      if (haystacks.some((value) => value.includes(needle))) {
        return element;
      }
    }
    return null;
  };
  const findByLabel = (wanted, exact = false) => {
    const labels = Array.from(document.querySelectorAll("label"));
    for (const label of labels) {
      if (!textMatches(label.textContent, wanted, exact)) continue;
      const forId = label.getAttribute("for");
      if (forId) {
        const explicit = document.getElementById(forId);
        if (explicit) return explicit;
      }
      const nested = label.querySelector("input, textarea, select, button");
      if (nested) return nested;
    }
    return null;
  };
  const findByRole = (role, name, exact = false) => {
    const candidates = Array.from(
      document.querySelectorAll(
        "a, button, input, textarea, select, option, form, h1, h2, h3, h4, h5, h6, [role], [data-testid]"
      )
    );
    for (const candidate of candidates) {
      if (nativeRole(candidate) !== role.trim().toLowerCase()) continue;
      if (!name) return candidate;
      if (searchTexts(candidate).some((value) => textMatches(value, name, exact))) {
        return candidate;
      }
    }
    return null;
  };
  const trimQuoted = (value) => {
    const trimmed = String(value || "").trim();
    const hasTextMatch = trimmed.match(/^has-text\\((?:"([^"]*)"|'([^']*)')\\)$/i);
    if (hasTextMatch?.[1] || hasTextMatch?.[2]) {
      return (hasTextMatch[1] || hasTextMatch[2] || "").trim();
    }
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1).trim();
    }
    return trimmed;
  };
  const normalizeSelectorSyntax = (selector) => {
    let normalized = String(selector || "").trim();
    normalized = normalized.replace(
      /^role\\s*[:=]\\s*([a-z0-9_-]+)\\s+name\\s*[:=]\\s*(.+)$/i,
      "role=$1[name=$2]"
    );
    normalized = normalized.replace(
      /^((?:label|text|placeholder|alt|title|testid|data-testid)\\s*[:=]\\s*(?:has-text\\((?:"[^"]*"|'[^']*')\\)|"[^"]+"|'[^']+'|[^>]+?))\\s+((?:input|textarea|select)[\\s\\S]*)$/i,
      "$1 >> $2"
    );
    return normalized;
  };
  const parseSemanticSelector = (selector) => {
    const trimmed = normalizeSelectorSyntax(selector);
    const match = trimmed.match(/^([a-z-]+)\\s*[:=]\\s*(.+)$/i);
    if (!match) return null;
    const kind = match[1]?.trim()?.toLowerCase();
    const rawValue = match[2]?.trim() || "";
    if (!kind || !rawValue) return null;
    switch (kind) {
      case "alt":
        return { findBy: "alt", text: trimQuoted(rawValue) };
      case "css":
        return { selector: trimQuoted(rawValue) };
      case "data-testid":
      case "testid":
        return { findBy: "testid", text: trimQuoted(rawValue) };
      case "label":
        return { findBy: "label", text: trimQuoted(rawValue) };
      case "placeholder":
        return { findBy: "placeholder", text: trimQuoted(rawValue) };
      case "role": {
        const roleMatch = rawValue.match(
          /^([a-z0-9_-]+)(?:\\s*\\[\\s*name\\s*[:=]\\s*(.+?)\\s*\\])?$/i
        );
        if (!roleMatch?.[1]) return null;
        return {
          findBy: "role",
          name: roleMatch[2] ? trimQuoted(roleMatch[2]) : undefined,
          role: roleMatch[1].trim().toLowerCase(),
        };
      }
      case "text":
        return { findBy: "text", text: trimQuoted(rawValue) };
      case "title":
        return { findBy: "title", text: trimQuoted(rawValue) };
      default:
        return null;
    }
  };
  const mergeSelectorCommand = (selector) => {
    const parsed = parseSemanticSelector(selector);
    if (!parsed) return null;
    return { ...command, ...parsed, selector: parsed.selector };
  };
  const queryOne = (selector) => {
    try {
      return document.querySelector(selector);
    } catch {
      throw new Error("Invalid selector " + selector);
    }
  };
  const queryAll = (selector) => {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch {
      throw new Error("Invalid selector " + selector);
    }
  };
  const findSemantic = (targetCommand = command) => {
    switch (targetCommand.findBy) {
      case "alt":
        return Array.from(document.querySelectorAll("[alt]")).find((element) =>
          textMatches(
            element.getAttribute("alt"),
            targetCommand.text,
            targetCommand.exact
          )
        ) || null;
      case "first":
        return targetCommand.selector ? queryOne(targetCommand.selector) : null;
      case "label":
        return targetCommand.text
          ? findByLabel(targetCommand.text, targetCommand.exact)
          : null;
      case "last":
        return targetCommand.selector
          ? queryAll(targetCommand.selector).at(-1) || null
          : null;
      case "nth":
        return targetCommand.selector && Number.isInteger(targetCommand.index)
          ? queryAll(targetCommand.selector).at(targetCommand.index) || null
          : null;
      case "placeholder":
        return Array.from(document.querySelectorAll("[placeholder]")).find((element) =>
          textMatches(
            element.getAttribute("placeholder"),
            targetCommand.text,
            targetCommand.exact
          )
        ) || null;
      case "role":
        return targetCommand.role
          ? findByRole(
              targetCommand.role,
              targetCommand.name,
              targetCommand.exact
            )
          : null;
      case "testid":
        return targetCommand.text
          ? document.querySelector('[data-testid="' + targetCommand.text + '"]')
          : null;
      case "text":
        return targetCommand.text ? findByText(targetCommand.text) : null;
      case "title":
        return Array.from(document.querySelectorAll("[title]")).find((element) =>
          textMatches(
            element.getAttribute("title"),
            targetCommand.text,
            targetCommand.exact
          )
        ) || null;
      default:
        return null;
    }
  };
  const findTarget = () => {
    if (command.selector) {
      const selectorChain = normalizeSelectorSyntax(command.selector)
        .split(/s*>>s*/)
        .map((segment) => segment.trim())
        .filter(Boolean);
      if (selectorChain.length > 1) {
        let current = queryTarget(selectorChain[0]);
        for (let index = 1; current && index < selectorChain.length; index += 1) {
          const segment = selectorChain[index];
          if (!segment) continue;
          if (typeof current.matches === "function" && current.matches(segment)) {
            continue;
          }
          if (
            /^(input|textarea|select)(?:[[^]]+])?$/i.test(segment) &&
            (current.tagName === "INPUT" ||
              current.tagName === "TEXTAREA" ||
              current.tagName === "SELECT")
          ) {
            continue;
          }
          current = queryOneWithin(current, segment);
        }
        return current;
      }
      return queryTarget(command.selector);
    }
    if (command.findBy) return findSemantic();
    if (command.text) return findByText(command.text);
    return null;
  };
  const queryOneWithin = (root, selector) => {
    try {
      return root.querySelector(selector);
    } catch {
      throw new Error("Invalid selector " + selector);
    }
  };
  const queryTarget = (selector) => {
    const semantic = mergeSelectorCommand(selector);
    if (semantic) return findSemantic(semantic);
    return queryOne(selector);
  };
  const inspect = () =>
    Array.from(
      document.querySelectorAll(
        "a, button, input, textarea, select, form, [role='button'], [data-testid]"
      )
    )
      .slice(0, 40)
      .map((element) => serialize(element));
  const snapshot = () => ({
    title: document.title,
    url: location.href,
    bodyText: normalize(document.body?.textContent).slice(0, 800),
    elements: inspect(),
  });
  const setInputValue = (appendMode, target) => {
    const element = target || findTarget();
    if (!element) {
      throw new Error("Target element was not found.");
    }
    if (
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      )
    ) {
      throw new Error("Target element is not an input, textarea, or select.");
    }
    const nextValue = appendMode ? \`\${element.value ?? ""}\${command.value ?? ""}\` : (command.value ?? "");
    element.value = nextValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { selector: selectorFor(element), value: element.value };
  };
  const setChecked = (targetValue) => {
    const element = findTarget();
    if (!element) throw new Error("Target element was not found.");
    if (!(element instanceof HTMLInputElement)) {
      throw new Error("Target element is not a checkbox or radio input.");
    }
    const type = (element.type || "").toLowerCase();
    if (type !== "checkbox" && type !== "radio") {
      throw new Error("Target element is not a checkbox or radio input.");
    }
    element.checked = targetValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { checked: element.checked, selector: selectorFor(element) };
  };
  const setSelectValue = () => {
    const element = findTarget();
    if (!element) throw new Error("Target element was not found.");
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error("Target element is not a select.");
    }
    const targetValue = command.value ?? "";
    const option = Array.from(element.options).find(
      (entry) =>
        entry.value === targetValue || textMatches(entry.textContent, targetValue, true)
    );
    if (!option) {
      throw new Error("Select option was not found.");
    }
    element.value = option.value;
    option.selected = true;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { selector: selectorFor(element), value: element.value };
  };
  const focusElement = (element) => {
    if (!element) throw new Error("Target element was not found.");
    if (typeof element.focus === "function") {
      element.focus();
    }
    return {
      focused: document.activeElement === element,
      selector: selectorFor(element),
    };
  };
  const hoverElement = (element) => {
    if (!element) throw new Error("Target element was not found.");
    element.setAttribute("data-eliza-hover", "true");
    return { hovered: true, selector: selectorFor(element) };
  };
  const activateElement = (subaction, element) => {
    if (!element) throw new Error("Target element was not found.");
    if (subaction === "dblclick") {
      element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }
    if (typeof element.click === "function") {
      element.click();
    }
    return {
      clickCount: subaction === "dblclick" ? 2 : 1,
      element: serialize(element),
      url: location.href,
    };
  };
  const keyboardTarget = () => findTarget() || document.activeElement || document.body;
  const keyboardWrite = (appendMode) => {
    const target = keyboardTarget();
    if (
      !(
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
    ) {
      throw new Error("Keyboard text input requires an input, textarea, or select target.");
    }
    return setInputValue(appendMode, target);
  };
  const keyPhase = (phase) => {
    const target = keyboardTarget();
    const key = command.key || "Enter";
    target.dispatchEvent(new KeyboardEvent(phase, { key, bubbles: true }));
    return { key, phase, selector: selectorFor(target) };
  };
  const scrollTarget = () => findTarget();
  const scroll = () => {
    const target = scrollTarget();
    const direction = command.direction || "down";
    const pixels = Math.max(1, Math.abs(Number(command.pixels) || 240));
    const axis = direction === "left" || direction === "right" ? "x" : "y";
    const delta = direction === "up" || direction === "left" ? -pixels : pixels;
    if (target instanceof HTMLElement) {
      if (axis === "y") {
        target.scrollTop = (target.scrollTop || 0) + delta;
        return { axis, selector: selectorFor(target), value: target.scrollTop };
      }
      target.scrollLeft = (target.scrollLeft || 0) + delta;
      return { axis, selector: selectorFor(target), value: target.scrollLeft };
    }
    if (axis === "y") {
      window.scrollBy(0, delta);
      return { axis, selector: null, value: window.scrollY };
    }
    window.scrollBy(delta, 0);
    return { axis, selector: null, value: window.scrollX };
  };
  const getResult = () => {
    if (command.getMode === "title") return document.title;
    if (command.getMode === "url") return location.href;
    if (command.getMode === "count") {
      if (!command.selector) throw new Error("count requires selector");
      const semantic = mergeSelectorCommand(command.selector);
      return semantic ? Number(Boolean(findSemantic(semantic))) : queryAll(command.selector).length;
    }
    const element = findTarget();
    if (!element) throw new Error("Target element was not found.");
    switch (command.getMode) {
      case "attr":
        if (!command.attribute) throw new Error("attr lookups require attribute");
        return element.getAttribute(command.attribute);
      case "box":
        return element.getBoundingClientRect();
      case "checked":
        return element instanceof HTMLInputElement
          ? Boolean(element.checked)
          : element instanceof HTMLOptionElement
            ? Boolean(element.selected)
            : false;
      case "enabled":
        return "disabled" in element ? !Boolean(element.disabled) : true;
      case "html":
        return element.innerHTML;
      case "styles": {
        const computed = getComputedStyle(element);
        return {
          display: computed.display || null,
          visibility: computed.visibility || null,
          opacity: computed.opacity || null,
        };
      }
      case "text":
        return normalize(element.textContent);
      case "value":
        return element.value ?? element.getAttribute?.("value");
      case "visible":
        return isVisible(element);
      default:
        return normalize(element.textContent);
    }
  };
  const waitForCondition = () =>
    new Promise((resolve, reject) => {
      if (
        !command.selector &&
        !command.findBy &&
        !command.text &&
        !command.url &&
        !command.script &&
        Number.isFinite(Number(command.timeoutMs))
      ) {
        const waitedMs = Math.max(0, Number(command.timeoutMs) || 0);
        setTimeout(() => resolve({ ok: true, waitedMs }), waitedMs);
        return;
      }
      const deadline = Date.now() + (Number(command.timeoutMs) || 4000);
      const check = () => {
        try {
          if (command.selector && findTarget()) {
            const found = findTarget();
            const visible =
              !command.state || command.state === "visible"
                ? found && isVisible(found)
                : !found || !isVisible(found);
            if (visible) {
              resolve({ ok: true, selector: command.selector, state: command.state || "visible" });
              return;
            }
          }
          if (
            command.findBy &&
            (!command.state || command.state === "visible") &&
            findSemantic()
          ) {
            resolve({ findBy: command.findBy, ok: true });
            return;
          }
          if (command.text && normalize(document.body?.textContent).includes(command.text)) {
            resolve({ ok: true, text: command.text });
            return;
          }
          if (command.url && location.href.includes(command.url)) {
            resolve({ ok: true, url: location.href });
            return;
          }
          if (command.script) {
            const fn = new Function("document", "window", "location", "return (" + command.script + ");");
            if (fn(document, window, location)) {
              resolve({ ok: true, script: true });
              return;
            }
          }
          if (Date.now() >= deadline) {
            reject(new Error("Timed out waiting for browser workspace condition."));
            return;
          }
          setTimeout(check, 100);
        } catch (error) {
          reject(error);
        }
      };
      check();
    });

  switch (command.subaction) {
    case "inspect":
      return { title: document.title, url: location.href, elements: inspect() };
    case "snapshot":
      return snapshot();
    case "get":
      return { value: getResult() };
    case "find": {
      const element = findTarget();
      if (!element) throw new Error("Target element was not found.");
      switch (command.action) {
        case "check":
          return setChecked(true);
        case "click":
          return activateElement("click", element);
        case "fill":
          return setInputValue(false, element);
        case "focus":
          return focusElement(element);
        case "hover":
          return hoverElement(element);
        case "text":
        case undefined:
          return { element: serialize(element), value: normalize(element.textContent) };
        case "type":
          return setInputValue(true, element);
        case "uncheck":
          return setChecked(false);
        default:
          throw new Error("Unsupported find action.");
      }
    }
    case "click": {
      const element = findTarget();
      return activateElement("click", element);
    }
    case "dblclick": {
      const element = findTarget();
      return activateElement("dblclick", element);
    }
    case "check":
      return setChecked(true);
    case "fill":
      return setInputValue(false);
    case "focus": {
      const element = findTarget();
      return focusElement(element);
    }
    case "hover": {
      const element = findTarget();
      return hoverElement(element);
    }
    case "keyboardinserttext":
      return keyboardWrite(false);
    case "keyboardtype":
      return keyboardWrite(true);
    case "keydown":
      return keyPhase("keydown");
    case "keyup":
      return keyPhase("keyup");
    case "type":
      return setInputValue(true);
    case "press": {
      const target = findTarget() ?? document.activeElement ?? document.body;
      const key = command.key || "Enter";
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
      return { key, url: location.href };
    }
    case "scroll":
      return scroll();
    case "scrollinto": {
      const element = findTarget();
      if (!element) throw new Error("Target element was not found.");
      if (typeof element.scrollIntoView === "function") {
        element.scrollIntoView();
      }
      return { scrolled: true, selector: selectorFor(element) };
    }
    case "select":
      return setSelectValue();
    case "uncheck":
      return setChecked(false);
    case "wait":
      return waitForCondition();
    case "back":
      history.back();
      return { url: location.href, title: document.title };
    case "forward":
      history.forward();
      return { url: location.href, title: document.title };
    case "reload":
      location.reload();
      return { url: location.href, title: document.title };
    default:
      throw new Error(\`Unsupported desktop browser subaction: \${command.subaction}\`);
  }
})()
`.trim();
}

function createDesktopBrowserWorkspaceUtilityScript(
  command: BrowserWorkspaceCommand,
): string {
  return `
(() => {
  const command = ${JSON.stringify(command)};
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const state =
    window.__elizaBrowserWorkspaceState ||
    (window.__elizaBrowserWorkspaceState = {
      clipboardText: "",
      consoleEntries: [],
      currentFrame: null,
      dialog: null,
      errors: [],
      highlightedSelector: null,
      mouse: { buttons: [], x: 0, y: 0 },
      networkHar: { active: false, entries: [], startedAt: null },
      networkNextRequestId: 1,
      networkRequests: [],
      networkRoutes: [],
      settings: {
        credentials: null,
        device: null,
        geo: null,
        headers: {},
        media: null,
        offline: false,
        viewport: null
      }
    });
  const patternMatches = (pattern, value) => {
    const trimmed = String(pattern ?? "").trim();
    if (!trimmed) return false;
    if (!trimmed.includes("*")) return String(value ?? "").includes(trimmed);
    let wildcard = "";
    for (let i = 0; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (char === "*") {
        if (trimmed[i + 1] === "*") {
          wildcard += ".*";
          i += 1;
        } else {
          wildcard += ".*";
        }
      } else {
        wildcard += char.replace(/[|\\\\{}()[\\]^$+?.]/g, "\\\\$&");
      }
    }
    return new RegExp("^" + wildcard + "$", "i").test(String(value ?? ""));
  };
  const buildSelector = (element) => {
    if (!element || !element.tagName) return null;
    const testId = element.getAttribute && element.getAttribute("data-testid");
    if (testId) return '[data-testid="' + testId + '"]';
    const name = element.getAttribute && element.getAttribute("name");
    if (name) return element.tagName.toLowerCase() + '[name="' + name + '"]';
    const title = element.getAttribute && element.getAttribute("title");
    if (title) return element.tagName.toLowerCase() + '[title="' + title + '"]';
    return element.tagName.toLowerCase();
  };
  const activeDocument = (() => {
    if (!state.currentFrame) return document;
    try {
      const frame = document.querySelector(state.currentFrame);
      return frame && frame.contentDocument ? frame.contentDocument : document;
    } catch {
      return document;
    }
  })();
  const queryOne = (selector, root = activeDocument) => {
    try {
      return root.querySelector(selector);
    } catch {
      throw new Error("Invalid selector " + selector);
    }
  };
  const findByText = (needle) => {
    const wanted = normalize(needle).toLowerCase();
    if (!wanted) return null;
    const candidates = Array.from(
      activeDocument.querySelectorAll(
        "a, button, input, textarea, select, option, label, h1, h2, h3, [role='button'], [data-testid]"
      )
    );
    return (
      candidates.find((element) => {
        const haystacks = [
          element.textContent,
          element.getAttribute("aria-label"),
          element.getAttribute("placeholder"),
          element.getAttribute("title"),
          element.getAttribute("name"),
          element.value
        ]
          .map((value) => normalize(value).toLowerCase())
          .filter(Boolean);
        return haystacks.some((value) => value.includes(wanted));
      }) || null
    );
  };
  const resolveTarget = () => {
    if (command.selector) return queryOne(command.selector);
    if (command.text) return findByText(command.text);
    return activeDocument.activeElement || activeDocument.body;
  };
  const recordRequest = (request) => {
    const entry = {
      ...request,
      id: "req_" + state.networkNextRequestId++,
      timestamp: new Date().toISOString()
    };
    state.networkRequests.push(entry);
    if (state.networkHar.active) state.networkHar.entries.push(entry);
    return entry;
  };
  if (!state.consoleWrapped) {
    for (const level of ["log", "info", "warn", "error"]) {
      console[level] = (...args) => {
        state.consoleEntries.push({
          level,
          message: args.map((value) => normalize(value)).join(" "),
          timestamp: new Date().toISOString()
        });
      };
    }
    state.consoleWrapped = true;
  }
  if (!state.dialogWrapped) {
    window.alert = (message) => {
      state.dialog = { defaultValue: null, message: String(message ?? ""), open: true, type: "alert" };
    };
    window.confirm = (message) => {
      state.dialog = { defaultValue: null, message: String(message ?? ""), open: true, type: "confirm" };
      return false;
    };
    window.prompt = (message, defaultValue) => {
      state.dialog = {
        defaultValue: defaultValue ?? null,
        message: String(message ?? ""),
        open: true,
        type: "prompt"
      };
      return null;
    };
    state.dialogWrapped = true;
  }
  if (!state.fetchWrapped) {
    state.originalFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = async (input, init = {}) => {
      const inputUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : typeof input?.url === "string"
              ? input.url
              : String(input);
      const url = new URL(inputUrl, location.href).toString();
      if (state.settings.offline) {
        recordRequest({
          matchedRoute: null,
          method: String(init.method || "GET").toUpperCase(),
          resourceType: "fetch",
          responseBody: null,
          responseHeaders: {},
          status: 0,
          url
        });
        throw new Error("Browser workspace is offline.");
      }
      const route = [...state.networkRoutes].reverse().find((entry) => patternMatches(entry.pattern, url)) || null;
      if (route && route.abort) {
        recordRequest({
          matchedRoute: route.pattern,
          method: String(init.method || "GET").toUpperCase(),
          resourceType: "fetch",
          responseBody: null,
          responseHeaders: route.headers || {},
          status: 0,
          url
        });
        throw new Error("Browser workspace network route aborted request: " + url);
      }
      if (route && (route.body !== null || route.status !== null || Object.keys(route.headers || {}).length > 0)) {
        const response = new Response(route.body || "", {
          headers: route.headers || {},
          status: route.status || 200
        });
        recordRequest({
          matchedRoute: route.pattern,
          method: String(init.method || "GET").toUpperCase(),
          resourceType: "fetch",
          responseBody: route.body || "",
          responseHeaders: route.headers || {},
          status: route.status || 200,
          url
        });
        return response;
      }
      const headers = new Headers(init.headers || {});
      for (const [key, value] of Object.entries(state.settings.headers || {})) {
        if (!headers.has(key)) headers.set(key, value);
      }
      if (state.settings.credentials && state.settings.credentials.username && !headers.has("Authorization")) {
        headers.set(
          "Authorization",
          "Basic " + btoa(state.settings.credentials.username + ":" + state.settings.credentials.password)
        );
      }
      const response = await state.originalFetch(url, { ...init, headers });
      recordRequest({
        matchedRoute: null,
        method: String(init.method || "GET").toUpperCase(),
        resourceType: "fetch",
        responseBody: null,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        status: response.status,
        url: response.url || url
      });
      return response;
    };
    state.fetchWrapped = true;
  }
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => !state.settings.offline
  });
  switch (command.subaction) {
    case "clipboard": {
      const action = command.clipboardAction || "read";
      if (action === "read") return state.clipboardText;
      if (action === "write") {
        state.clipboardText = command.value || command.text || "";
        return state.clipboardText;
      }
      if (action === "copy") {
        const target = resolveTarget();
        state.clipboardText =
          target && typeof target.value === "string"
            ? String(target.value || "")
            : normalize(target?.textContent || activeDocument.body?.textContent);
        return state.clipboardText;
      }
      const target = resolveTarget();
      if (target && typeof target.value === "string") {
        target.value = String(target.value || "") + state.clipboardText;
        target.setAttribute("value", target.value);
        return { selector: buildSelector(target), value: target.value };
      }
      return state.clipboardText;
    }
    case "mouse": {
      const action = command.mouseAction || "move";
      if (action === "move") {
        state.mouse.x = typeof command.x === "number" ? command.x : state.mouse.x;
        state.mouse.y = typeof command.y === "number" ? command.y : state.mouse.y;
        return state.mouse;
      }
      if (action === "down") {
        const button = command.button || "left";
        state.mouse.buttons = Array.from(new Set([...(state.mouse.buttons || []), button]));
        return state.mouse;
      }
      if (action === "up") {
        const button = command.button || "left";
        state.mouse.buttons = (state.mouse.buttons || []).filter((entry) => entry !== button);
        return state.mouse;
      }
      window.scrollBy(command.deltaX || 0, command.deltaY || command.pixels || 240);
      return { axis: Math.abs(command.deltaY || 0) >= Math.abs(command.deltaX || 0) ? "y" : "x", value: window.scrollY };
    }
    case "drag": {
      const source = resolveTarget();
      const target = command.value ? queryOne(command.value) : null;
      if (!source || !target) throw new Error("Eliza browser workspace drag requires source selector and target selector in value.");
      source.setAttribute("data-eliza-dragging", "true");
      target.setAttribute("data-eliza-drop-target", "true");
      return { source: buildSelector(source), target: buildSelector(target) };
    }
    case "upload": {
      const target = resolveTarget();
      if (!target || target.tagName !== "INPUT") throw new Error("Eliza browser workspace upload requires a file input target.");
      const files = Array.isArray(command.files) ? command.files.map((entry) => String(entry).split(/[\\\\/]/).pop()) : [];
      target.setAttribute("data-eliza-uploaded-files", files.join(","));
      return { files, selector: buildSelector(target) };
    }
    case "set": {
      const action = command.setAction || "viewport";
      if (action === "viewport") {
        state.settings.viewport = { width: command.width || 1280, height: command.height || 720, scale: command.scale || 1 };
      } else if (action === "device") {
        state.settings.device = command.device || null;
      } else if (action === "geo") {
        state.settings.geo =
          typeof command.latitude === "number" && typeof command.longitude === "number"
            ? { latitude: command.latitude, longitude: command.longitude }
            : null;
      } else if (action === "offline") {
        state.settings.offline = Boolean(command.offline);
      } else if (action === "headers") {
        state.settings.headers = command.headers || {};
      } else if (action === "credentials") {
        state.settings.credentials =
          command.username || command.password
            ? { username: command.username || "", password: command.password || "" }
            : null;
      } else if (action === "media") {
        state.settings.media = command.media || null;
      }
      return state.settings;
    }
    case "cookies": {
      const action = command.cookieAction || "get";
      if (action === "clear") {
        const current = document.cookie || "";
        current.split(/;\\s*/).forEach((entry) => {
          const name = entry.split("=")[0];
          if (name) document.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
        });
        return { cleared: true };
      }
      if (action === "set") {
        const name = command.name || command.entryKey;
        if (!name) throw new Error("Eliza browser workspace cookies set requires name.");
        document.cookie = name + "=" + (command.value || "") + "; path=/";
      }
      const cookieString = document.cookie || "";
      return Object.fromEntries(
        cookieString
          .split(/;\\s*/)
          .filter(Boolean)
          .map((entry) => {
            const [name, ...rest] = entry.split("=");
            return [name, rest.join("=")];
          })
      );
    }
    case "storage": {
      const storage = command.storageArea === "session" ? sessionStorage : localStorage;
      const action = command.storageAction || "get";
      if (action === "clear") {
        storage.clear();
        return { cleared: true };
      }
      if (action === "set") {
        const key = command.entryKey || command.name;
        if (!key) throw new Error("Eliza browser workspace storage set requires entryKey.");
        storage.setItem(key, command.value || "");
      }
      if (command.entryKey || command.name) {
        return storage.getItem(command.entryKey || command.name);
      }
      const out = {};
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key) out[key] = storage.getItem(key) || "";
      }
      return out;
    }
    case "network": {
      const action = command.networkAction || "requests";
      if (action === "route") {
        if (!command.url) throw new Error("Eliza browser workspace network route requires url pattern.");
        state.networkRoutes.push({
          abort: Boolean(command.offline),
          body: command.responseBody ?? null,
          headers: command.responseHeaders || {},
          pattern: command.url,
          status: typeof command.responseStatus === "number" ? command.responseStatus : null
        });
        return state.networkRoutes;
      }
      if (action === "unroute") {
        state.networkRoutes = command.url
          ? state.networkRoutes.filter((entry) => entry.pattern !== command.url)
          : [];
        return state.networkRoutes;
      }
      if (action === "request") {
        return state.networkRequests.find((entry) => entry.id === command.requestId) || null;
      }
      if (action === "harstart") {
        state.networkHar = { active: true, entries: [], startedAt: new Date().toISOString() };
        return state.networkHar;
      }
      if (action === "harstop") {
        state.networkHar.active = false;
        return { log: { entries: state.networkHar.entries, startedAt: state.networkHar.startedAt } };
      }
      let requests = [...state.networkRequests];
      if (command.filter) requests = requests.filter((entry) => entry.url.includes(command.filter));
      if (command.method) requests = requests.filter((entry) => entry.method === String(command.method).toUpperCase());
      if (command.status) requests = requests.filter((entry) => String(entry.status || "") === String(command.status));
      return requests;
    }
    case "dialog": {
      const action = command.dialogAction || "status";
      if (action === "status") return state.dialog;
      if (state.dialog) state.dialog.open = false;
      const result =
        action === "accept"
          ? { accepted: true, dialog: state.dialog, promptText: command.promptText || command.value || null }
          : { accepted: false, dialog: state.dialog };
      state.dialog = null;
      return result;
    }
    case "console":
      if (command.consoleAction === "clear") state.consoleEntries = [];
      return state.consoleEntries;
    case "errors":
      if (command.consoleAction === "clear") state.errors = [];
      return state.errors;
    case "highlight": {
      const target = resolveTarget();
      if (!target) throw new Error("Target element was not found.");
      target.setAttribute("data-eliza-highlight", "true");
      state.highlightedSelector = buildSelector(target);
      return { selector: state.highlightedSelector };
    }
    case "frame": {
      if ((command.frameAction || "select") === "main") {
        state.currentFrame = null;
        return { frame: null };
      }
      const frame = command.selector ? document.querySelector(command.selector) : null;
      if (!frame || frame.tagName !== "IFRAME") throw new Error("Eliza browser workspace frame select requires an iframe selector.");
      state.currentFrame = buildSelector(frame);
      return { frame: state.currentFrame };
    }
    default:
      throw new Error("Unsupported desktop browser workspace utility subaction: " + command.subaction);
  }
})()
`.trim();
}

async function executeDesktopBrowserWorkspaceUtilityCommand(
  command: BrowserWorkspaceCommand,
  env: NodeJS.ProcessEnv,
): Promise<BrowserWorkspaceCommandResult> {
  const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
  const startedAt = Date.now();
  const result = await evaluateBrowserWorkspaceTab(
    {
      id,
      script: createDesktopBrowserWorkspaceUtilityScript({
        ...command,
        id,
      }),
    },
    env,
  );
  const runtime = getBrowserWorkspaceRuntimeState("desktop", id);
  appendBrowserWorkspaceTraceEntry(runtime, {
    subaction: command.subaction,
    type: "utility",
  });
  appendBrowserWorkspaceProfilerEntry(runtime, {
    durationMs: Date.now() - startedAt,
    subaction: command.subaction,
    type: "utility",
  });
  return {
    mode: "desktop",
    subaction: command.subaction,
    value: result,
  };
}

async function getDesktopBrowserWorkspaceSnapshotRecord(
  command: BrowserWorkspaceCommand,
  env: NodeJS.ProcessEnv,
): Promise<BrowserWorkspaceSnapshotRecord> {
  const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
  const result = await evaluateBrowserWorkspaceTab(
    {
      id,
      script: `
(() => {
  const activeDocument = (() => {
    const state = window.__elizaBrowserWorkspaceState || {};
    if (!state.currentFrame) return document;
    try {
      const frame = document.querySelector(state.currentFrame);
      return frame && frame.contentDocument ? frame.contentDocument : document;
    } catch {
      return document;
    }
  })();
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const controlText = Array.from(activeDocument.querySelectorAll("input, textarea, select, option:checked"))
    .map((element) => {
      const name = element.getAttribute("name") || element.getAttribute("id") || element.tagName.toLowerCase();
      const value =
        element.tagName === "SELECT"
          ? element.value
          : typeof element.value === "string"
            ? element.value
            : element.textContent || "";
      return name + ":" + normalize(value);
    })
    .filter(Boolean)
    .join(" ");
  return {
    bodyText: normalize((activeDocument.body?.textContent || "") + " " + controlText),
    title: normalize(document.title),
    url: location.href
  };
})()
      `.trim(),
    },
    env,
  );
  return result as BrowserWorkspaceSnapshotRecord;
}

async function getDesktopBrowserWorkspaceSessionState(
  command: BrowserWorkspaceCommand,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
  const result = await evaluateBrowserWorkspaceTab(
    {
      id,
      script: `
(() => {
  const state = window.__elizaBrowserWorkspaceState || {};
  const readStorage = (storage) => {
    const out = {};
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key) out[key] = storage.getItem(key) || "";
    }
    return out;
  };
  const cookies = Object.fromEntries(
    String(document.cookie || "")
      .split(/;\\s*/)
      .filter(Boolean)
      .map((entry) => {
        const [name, ...rest] = entry.split("=");
        return [name, rest.join("=")];
      })
  );
  return {
    clipboard: state.clipboardText || "",
    cookies,
    localStorage: readStorage(localStorage),
    sessionStorage: readStorage(sessionStorage),
    settings: state.settings || {},
    url: location.href
  };
})()
      `.trim(),
    },
    env,
  );
  return result as Record<string, unknown>;
}

async function loadDesktopBrowserWorkspaceSessionState(
  command: BrowserWorkspaceCommand,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
  await evaluateBrowserWorkspaceTab(
    {
      id,
      script: `
(() => {
  const payload = ${JSON.stringify(payload)};
  const state =
    window.__elizaBrowserWorkspaceState ||
    (window.__elizaBrowserWorkspaceState = { settings: {} });
  localStorage.clear();
  for (const [key, value] of Object.entries(payload.localStorage || {})) {
    localStorage.setItem(key, String(value ?? ""));
  }
  sessionStorage.clear();
  for (const [key, value] of Object.entries(payload.sessionStorage || {})) {
    sessionStorage.setItem(key, String(value ?? ""));
  }
  for (const [key, value] of Object.entries(payload.cookies || {})) {
    document.cookie = key + "=" + String(value ?? "") + "; path=/";
  }
  state.clipboardText = typeof payload.clipboard === "string" ? payload.clipboard : "";
  state.settings = typeof payload.settings === "object" && payload.settings ? payload.settings : state.settings;
  return { loaded: true };
})()
      `.trim(),
    },
    env,
  );
}

async function executeDesktopBrowserWorkspaceDomCommand(
  command: BrowserWorkspaceCommand,
  env: NodeJS.ProcessEnv,
): Promise<BrowserWorkspaceCommandResult> {
  const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
  const startedAt = Date.now();
  command = resolveBrowserWorkspaceCommandElementRefs(command, "desktop", id);
  const result = await evaluateBrowserWorkspaceTab(
    {
      id,
      script: createDesktopBrowserWorkspaceCommandScript({
        ...command,
        id,
      }),
    },
    env,
  );

  if (command.subaction === "inspect" || command.subaction === "snapshot") {
    const value =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as {
            bodyText?: string;
            elements?: BrowserWorkspaceDomElementSummary[];
          })
        : null;
    const elements = registerBrowserWorkspaceElementRefs(
      "desktop",
      id,
      Array.isArray(value?.elements) ? value.elements : [],
    );
    return {
      mode: "desktop",
      subaction: command.subaction,
      elements,
      value: result,
    };
  }

  const runtime = getBrowserWorkspaceRuntimeState("desktop", id);
  appendBrowserWorkspaceTraceEntry(runtime, {
    subaction: command.subaction,
    type: "dom",
  });
  appendBrowserWorkspaceProfilerEntry(runtime, {
    durationMs: Date.now() - startedAt,
    subaction: command.subaction,
    type: "dom",
  });
  return {
    mode: "desktop",
    subaction: command.subaction,
    value:
      result && typeof result === "object" && !Array.isArray(result)
        ? ((result as { value?: unknown }).value ?? result)
        : result,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function submitWebBrowserWorkspaceForm(
  tab: WebBrowserWorkspaceTabState,
  form: HTMLFormElement,
): Promise<void> {
  const state = getBrowserWorkspaceRuntimeState("web", tab.id);
  const dom = ensureBrowserWorkspaceDom(tab);
  const action = form.getAttribute("action")?.trim() || tab.url;
  const method = (form.getAttribute("method")?.trim() || "get").toLowerCase();
  const submitUrl = new URL(action, tab.url).toString();
  const formData = new dom.window.FormData(form);
  const searchParams = new URLSearchParams();

  for (const [key, value] of formData.entries()) {
    searchParams.append(key, String(value));
  }

  if (method === "get") {
    const nextUrl = new URL(submitUrl);
    nextUrl.search = searchParams.toString();
    clearWebBrowserWorkspaceTabElementRefs(tab.id);
    tab.url = nextUrl.toString();
    tab.title = inferBrowserWorkspaceTitle(tab.url);
    tab.dom = null;
    tab.loadedUrl = null;
    pushWebBrowserWorkspaceHistory(tab, tab.url);
    await loadWebBrowserWorkspaceTabDocument(tab);
    return;
  }

  const response = await fetchBrowserWorkspaceTrackedResponse(
    state,
    submitUrl,
    {
      body: searchParams.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      method: method.toUpperCase(),
    },
    "document",
  );

  if (!response.ok) {
    throw new Error(
      `Browser workspace form submit failed (${response.status}): ${submitUrl}`,
    );
  }

  const html = await response.text();
  const finalUrl = assertBrowserWorkspaceUrl(response.url?.trim() || submitUrl);
  const nextDom = new (getJSDOMClass())(html, {
    pretendToBeVisual: true,
    url: finalUrl,
  });
  installBrowserWorkspaceWebRuntime(tab, nextDom);
  resetBrowserWorkspaceRuntimeNavigationState(state);
  clearWebBrowserWorkspaceTabElementRefs(tab.id);
  tab.url = finalUrl;
  tab.dom = nextDom;
  tab.loadedUrl = finalUrl;
  tab.title =
    normalizeBrowserWorkspaceText(nextDom.window.document.title) ||
    inferBrowserWorkspaceTitle(finalUrl);
  tab.updatedAt = getBrowserWorkspaceTimestamp();
  pushWebBrowserWorkspaceHistory(tab, finalUrl);
}

function readBrowserWorkspaceStorage(storage: Storage): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) {
      continue;
    }
    entries[key] = storage.getItem(key) ?? "";
  }
  return entries;
}

function readBrowserWorkspaceCookies(
  document: Document,
): Record<string, string> {
  const cookieString = document.cookie || "";
  if (!cookieString.trim()) {
    return {};
  }
  return Object.fromEntries(
    cookieString
      .split(/;\s*/)
      .map((entry) => {
        const [name, ...rest] = entry.split("=");
        return [name ?? "", rest.join("=")] as const;
      })
      .filter((entry) => entry[0].trim().length > 0),
  );
}

function applyBrowserWorkspaceStateToWebDocument(
  document: Document,
  snapshot: Record<string, unknown>,
): void {
  const localEntries =
    snapshot.localStorage && typeof snapshot.localStorage === "object"
      ? (snapshot.localStorage as Record<string, unknown>)
      : {};
  const sessionEntries =
    snapshot.sessionStorage && typeof snapshot.sessionStorage === "object"
      ? (snapshot.sessionStorage as Record<string, unknown>)
      : {};
  const cookies =
    snapshot.cookies && typeof snapshot.cookies === "object"
      ? (snapshot.cookies as Record<string, unknown>)
      : {};

  document.defaultView?.localStorage.clear();
  for (const [key, value] of Object.entries(localEntries)) {
    document.defaultView?.localStorage.setItem(key, String(value ?? ""));
  }
  document.defaultView?.sessionStorage.clear();
  for (const [key, value] of Object.entries(sessionEntries)) {
    document.defaultView?.sessionStorage.setItem(key, String(value ?? ""));
  }
  for (const [key, value] of Object.entries(cookies)) {
    document.cookie = `${key}=${String(value ?? "")}; path=/`;
  }
}

async function executeWebBrowserWorkspaceUtilityCommand(
  command: BrowserWorkspaceCommand,
): Promise<BrowserWorkspaceCommandResult | null> {
  return withWebStateLock(async () => {
    if (
      ![
        "clipboard",
        "console",
        "cookies",
        "diff",
        "dialog",
        "drag",
        "errors",
        "eval",
        "frame",
        "highlight",
        "mouse",
        "network",
        "pdf",
        "screenshot",
        "set",
        "state",
        "storage",
        "trace",
        "profiler",
        "upload",
      ].includes(command.subaction)
    ) {
      return null;
    }

    const id = findWebBrowserWorkspaceTargetTabId(command);
    const tab = getWebBrowserWorkspaceTabState(id);
    const dom = await ensureLoadedWebBrowserWorkspaceTabDocument(tab);
    const runtime = getBrowserWorkspaceRuntimeState("web", id);
    const frameContext = resolveWebBrowserWorkspaceCommandDocument(tab, dom);
    const document = frameContext.document;
    const resolveTarget = () =>
      resolveBrowserWorkspaceElement(
        document,
        command.selector,
        command.text,
        command,
      );

    switch (command.subaction) {
      case "eval": {
        if (!command.script?.trim()) {
          throw new Error("Eliza browser workspace eval requires script.");
        }
        try {
          let value: unknown;
          try {
            value = new Function(
              "document",
              "fetch",
              "alert",
              "confirm",
              "prompt",
              "window",
              "location",
              "navigator",
              "localStorage",
              "sessionStorage",
              "console",
              `return (${command.script});`,
            )(
              document,
              dom.window.fetch.bind(dom.window),
              dom.window.alert.bind(dom.window),
              dom.window.confirm.bind(dom.window),
              dom.window.prompt.bind(dom.window),
              dom.window,
              dom.window.location,
              dom.window.navigator,
              dom.window.localStorage,
              dom.window.sessionStorage,
              dom.window.console,
            );
          } catch {
            value = new Function(
              "document",
              "fetch",
              "alert",
              "confirm",
              "prompt",
              "window",
              "location",
              "navigator",
              "localStorage",
              "sessionStorage",
              "console",
              command.script,
            )(
              document,
              dom.window.fetch.bind(dom.window),
              dom.window.alert.bind(dom.window),
              dom.window.confirm.bind(dom.window),
              dom.window.prompt.bind(dom.window),
              dom.window,
              dom.window.location,
              dom.window.navigator,
              dom.window.localStorage,
              dom.window.sessionStorage,
              dom.window.console,
            );
          }
          if (
            value &&
            typeof value === "object" &&
            typeof (value as Promise<unknown>).then === "function"
          ) {
            value = await (value as Promise<unknown>);
          }
          return { mode: "web", subaction: command.subaction, value };
        } catch (error) {
          runtime.errors.push({
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? (error.stack ?? null) : null,
            timestamp: getBrowserWorkspaceTimestamp(),
          });
          throw error;
        }
      }
      case "screenshot": {
        const data = createBrowserWorkspaceSyntheticScreenshotData(
          tab.title,
          tab.url,
          buildBrowserWorkspaceDocumentSnapshotText(document),
          runtime.settings.viewport ?? undefined,
        );
        runtime.lastScreenshotData = data;
        if (command.filePath?.trim() || command.outputPath?.trim()) {
          const targetPath =
            command.filePath?.trim() || command.outputPath?.trim() || "";
          await writeBrowserWorkspaceFile(
            targetPath,
            Buffer.from(data, "base64"),
          );
          return {
            mode: "web",
            subaction: command.subaction,
            snapshot: { data },
            value: { path: path.resolve(targetPath) },
          };
        }
        return {
          mode: "web",
          subaction: command.subaction,
          snapshot: { data },
        };
      }
      case "clipboard": {
        const action = command.clipboardAction ?? "read";
        if (action === "read") {
          return {
            mode: "web",
            subaction: command.subaction,
            value: browserWorkspaceClipboardText,
          };
        }
        if (action === "write") {
          browserWorkspaceClipboardText = command.value ?? command.text ?? "";
          return {
            mode: "web",
            subaction: command.subaction,
            value: browserWorkspaceClipboardText,
          };
        }
        if (action === "copy") {
          const target = resolveTarget();
          browserWorkspaceClipboardText =
            target && "value" in (target as HTMLInputElement)
              ? String((target as HTMLInputElement).value ?? "")
              : normalizeBrowserWorkspaceText(
                  target?.textContent ?? document.body?.textContent,
                );
          return {
            mode: "web",
            subaction: command.subaction,
            value: browserWorkspaceClipboardText,
          };
        }
        const target = resolveTarget() ?? document.activeElement;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT")
        ) {
          const control = ensureBrowserWorkspaceFormControlElement(
            target,
            "clipboard",
          );
          setBrowserWorkspaceControlValue(
            control,
            `${control.value ?? ""}${browserWorkspaceClipboardText}`,
          );
          return {
            mode: "web",
            subaction: command.subaction,
            value: {
              selector: buildBrowserWorkspaceElementSelector(control),
              value: control.value,
            },
          };
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: browserWorkspaceClipboardText,
        };
      }
      case "mouse": {
        const action = command.mouseAction ?? "move";
        if (action === "move") {
          runtime.mouse.x = command.x ?? runtime.mouse.x;
          runtime.mouse.y = command.y ?? runtime.mouse.y;
        } else if (action === "down") {
          const button = command.button ?? "left";
          runtime.mouse.buttons = Array.from(
            new Set([...runtime.mouse.buttons, button]),
          );
        } else if (action === "up") {
          const button = command.button ?? "left";
          runtime.mouse.buttons = runtime.mouse.buttons.filter(
            (entry) => entry !== button,
          );
        } else {
          return {
            mode: "web",
            subaction: command.subaction,
            value: scrollWebBrowserWorkspaceTarget(
              dom,
              resolveTarget(),
              (command.deltaY ?? 0) < 0 ? "up" : "down",
              Math.abs(command.deltaY ?? command.pixels ?? 240),
            ),
          };
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: runtime.mouse,
        };
      }
      case "drag": {
        const source = resolveTarget();
        const target = command.value
          ? resolveBrowserWorkspaceElement(document, command.value)
          : null;
        if (!source || !target) {
          throw new Error(
            "Eliza browser workspace drag requires source selector and target selector in value.",
          );
        }
        source.setAttribute("data-eliza-dragging", "true");
        target.setAttribute("data-eliza-drop-target", "true");
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            source: buildBrowserWorkspaceElementSelector(source),
            target: buildBrowserWorkspaceElementSelector(target),
          },
        };
      }
      case "upload": {
        const target = resolveTarget();
        if (!target || target.tagName !== "INPUT") {
          throw new Error(
            "Eliza browser workspace upload requires a file input target.",
          );
        }
        const files = (command.files ?? []).map((entry) =>
          path.basename(entry),
        );
        target.setAttribute("data-eliza-uploaded-files", files.join(","));
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            files,
            selector: buildBrowserWorkspaceElementSelector(target),
          },
        };
      }
      case "set": {
        const action = command.setAction ?? "viewport";
        if (action === "viewport") {
          runtime.settings.viewport = {
            height: Math.max(1, Math.round(command.height ?? 720)),
            scale: Math.max(1, Number(command.scale ?? 1)),
            width: Math.max(1, Math.round(command.width ?? 1280)),
          };
        } else if (action === "device") {
          runtime.settings.device = command.device ?? null;
        } else if (action === "geo") {
          runtime.settings.geo =
            typeof command.latitude === "number" &&
            typeof command.longitude === "number"
              ? { latitude: command.latitude, longitude: command.longitude }
              : null;
        } else if (action === "offline") {
          runtime.settings.offline = Boolean(command.offline);
        } else if (action === "headers") {
          runtime.settings.headers = normalizeBrowserWorkspaceHeaders(
            command.headers,
          );
        } else if (action === "credentials") {
          runtime.settings.credentials =
            command.username || command.password
              ? {
                  password: command.password ?? "",
                  username: command.username ?? "",
                }
              : null;
        } else if (action === "media") {
          runtime.settings.media = command.media ?? null;
        }
        applyBrowserWorkspaceDomSettings(dom, runtime);
        return {
          mode: "web",
          subaction: command.subaction,
          value: runtime.settings,
        };
      }
      case "cookies": {
        const action = command.cookieAction ?? "get";
        if (action === "clear") {
          for (const key of Object.keys(
            readBrowserWorkspaceCookies(document),
          )) {
            document.cookie = `${key}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
          }
          return {
            mode: "web",
            subaction: command.subaction,
            value: { cleared: true },
          };
        }
        if (action === "set") {
          const cookieName = command.name?.trim() || command.entryKey?.trim();
          if (!cookieName) {
            throw new Error(
              "Eliza browser workspace cookies set requires name.",
            );
          }
          document.cookie = `${cookieName}=${command.value ?? ""}; path=/`;
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: readBrowserWorkspaceCookies(document),
        };
      }
      case "storage": {
        const area =
          command.storageArea === "session"
            ? dom.window.sessionStorage
            : dom.window.localStorage;
        const action = command.storageAction ?? "get";
        if (action === "clear") {
          area.clear();
          return {
            mode: "web",
            subaction: command.subaction,
            value: { cleared: true },
          };
        }
        if (action === "set") {
          const key = command.entryKey?.trim() || command.name?.trim();
          if (!key) {
            throw new Error(
              "Eliza browser workspace storage set requires entryKey.",
            );
          }
          area.setItem(key, command.value ?? "");
        }
        if (command.entryKey?.trim() || command.name?.trim()) {
          const key = command.entryKey?.trim() || command.name?.trim() || "";
          return {
            mode: "web",
            subaction: command.subaction,
            value: area.getItem(key),
          };
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: readBrowserWorkspaceStorage(area),
        };
      }
      case "network": {
        const action = command.networkAction ?? "requests";
        if (action === "route") {
          const pattern = command.url?.trim();
          if (!pattern) {
            throw new Error(
              "Eliza browser workspace network route requires url pattern.",
            );
          }
          runtime.networkRoutes.push({
            abort: Boolean(command.offline),
            body: command.responseBody ?? null,
            headers: normalizeBrowserWorkspaceHeaders(command.responseHeaders),
            pattern,
            status:
              typeof command.responseStatus === "number"
                ? command.responseStatus
                : null,
          });
          return {
            mode: "web",
            subaction: command.subaction,
            value: runtime.networkRoutes,
          };
        }
        if (action === "unroute") {
          runtime.networkRoutes = command.url?.trim()
            ? runtime.networkRoutes.filter(
                (route) => route.pattern !== command.url?.trim(),
              )
            : [];
          return {
            mode: "web",
            subaction: command.subaction,
            value: runtime.networkRoutes,
          };
        }
        if (action === "request") {
          const request = runtime.networkRequests.find(
            (entry) => entry.id === command.requestId,
          );
          return {
            mode: "web",
            subaction: command.subaction,
            value: request ?? null,
          };
        }
        if (action === "harstart") {
          runtime.networkHar = {
            active: true,
            entries: [],
            startedAt: getBrowserWorkspaceTimestamp(),
          };
          return {
            mode: "web",
            subaction: command.subaction,
            value: runtime.networkHar,
          };
        }
        if (action === "harstop") {
          runtime.networkHar.active = false;
          const har = {
            log: {
              entries: runtime.networkHar.entries,
              startedAt: runtime.networkHar.startedAt,
            },
          };
          if (command.filePath?.trim() || command.outputPath?.trim()) {
            const targetPath =
              command.filePath?.trim() || command.outputPath?.trim() || "";
            await writeBrowserWorkspaceFile(
              targetPath,
              JSON.stringify(har, null, 2),
            );
            return {
              mode: "web",
              subaction: command.subaction,
              value: { path: path.resolve(targetPath), ...har },
            };
          }
          return { mode: "web", subaction: command.subaction, value: har };
        }
        let requests = [...runtime.networkRequests];
        if (command.filter?.trim()) {
          requests = requests.filter((entry) =>
            entry.url.includes(command.filter ?? ""),
          );
        }
        if (command.method?.trim()) {
          requests = requests.filter(
            (entry) =>
              entry.method.toUpperCase() ===
              command.method?.trim().toUpperCase(),
          );
        }
        if (command.status?.trim()) {
          const statusFilter = command.status.trim();
          requests = requests.filter((entry) => {
            if (entry.status === null) {
              return false;
            }
            if (/^\dxx$/i.test(statusFilter)) {
              return String(entry.status).startsWith(statusFilter[0] ?? "");
            }
            return String(entry.status) === statusFilter;
          });
        }
        return { mode: "web", subaction: command.subaction, value: requests };
      }
      case "dialog": {
        const action = command.dialogAction ?? "status";
        if (action === "status") {
          return {
            mode: "web",
            subaction: command.subaction,
            value: runtime.dialog,
          };
        }
        if (runtime.dialog) {
          runtime.dialog.open = false;
        }
        const result =
          action === "accept"
            ? {
                accepted: true,
                dialog: runtime.dialog,
                promptText: command.promptText ?? command.value ?? null,
              }
            : { accepted: false, dialog: runtime.dialog };
        runtime.dialog = null;
        return { mode: "web", subaction: command.subaction, value: result };
      }
      case "console": {
        if (command.consoleAction === "clear") {
          runtime.consoleEntries = [];
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: runtime.consoleEntries,
        };
      }
      case "errors": {
        if (command.consoleAction === "clear") {
          runtime.errors = [];
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: runtime.errors,
        };
      }
      case "highlight": {
        const target = resolveTarget();
        if (!target) {
          throw new Error("Target element was not found.");
        }
        target.setAttribute("data-eliza-highlight", "true");
        runtime.highlightedSelector =
          buildBrowserWorkspaceElementSelector(target);
        return {
          mode: "web",
          subaction: command.subaction,
          value: { selector: runtime.highlightedSelector },
        };
      }
      case "frame": {
        const action = command.frameAction ?? "select";
        if (action === "main") {
          runtime.currentFrame = null;
          return {
            mode: "web",
            subaction: command.subaction,
            value: { frame: null },
          };
        }
        const frame = resolveBrowserWorkspaceElement(
          dom.window.document,
          command.selector,
        );
        if (!frame || frame.tagName !== "IFRAME") {
          throw new Error(
            "Eliza browser workspace frame select requires an iframe selector.",
          );
        }
        runtime.currentFrame = buildBrowserWorkspaceElementSelector(frame);
        return {
          mode: "web",
          subaction: command.subaction,
          value: { frame: runtime.currentFrame },
        };
      }
      case "diff": {
        const snapshot = createBrowserWorkspaceSnapshotRecord(
          tab.title,
          tab.url,
          buildBrowserWorkspaceDocumentSnapshotText(document),
        );
        if (command.diffAction === "url") {
          const leftUrl = command.url?.trim() || tab.url;
          const rightUrl = command.secondaryUrl?.trim();
          if (!rightUrl) {
            throw new Error(
              "Eliza browser workspace diff url requires secondaryUrl.",
            );
          }
          const left = await fetchBrowserWorkspaceTrackedResponse(
            runtime,
            leftUrl,
            {},
            "document",
          );
          const right = await fetchBrowserWorkspaceTrackedResponse(
            runtime,
            rightUrl,
            {},
            "document",
          );
          const leftSnapshot = createBrowserWorkspaceSnapshotRecord(
            leftUrl,
            left.url || leftUrl,
            await left.text(),
          );
          const rightSnapshot = createBrowserWorkspaceSnapshotRecord(
            rightUrl,
            right.url || rightUrl,
            await right.text(),
          );
          return {
            mode: "web",
            subaction: command.subaction,
            value: diffBrowserWorkspaceSnapshots(leftSnapshot, rightSnapshot),
          };
        }
        if (command.diffAction === "screenshot") {
          const currentData =
            runtime.lastScreenshotData ??
            createBrowserWorkspaceSyntheticScreenshotData(
              tab.title,
              tab.url,
              buildBrowserWorkspaceDocumentSnapshotText(document),
              runtime.settings.viewport ?? undefined,
            );
          const baseline = command.baselinePath?.trim()
            ? await fsp.readFile(
                path.resolve(command.baselinePath.trim()),
                "base64",
              )
            : runtime.lastScreenshotData;
          runtime.lastScreenshotData = currentData;
          return {
            mode: "web",
            subaction: command.subaction,
            value: {
              baselineLength: baseline?.length ?? 0,
              changed: baseline !== currentData,
              currentLength: currentData.length,
            },
          };
        }
        const baseline = command.baselinePath?.trim()
          ? (JSON.parse(
              await fsp.readFile(
                path.resolve(command.baselinePath.trim()),
                "utf8",
              ),
            ) as BrowserWorkspaceSnapshotRecord)
          : runtime.lastSnapshot;
        const diff = diffBrowserWorkspaceSnapshots(baseline, snapshot);
        runtime.lastSnapshot = snapshot;
        return { mode: "web", subaction: command.subaction, value: diff };
      }
      case "trace": {
        if (command.traceAction === "stop") {
          runtime.trace.active = false;
          const traceValue = { entries: runtime.trace.entries };
          if (command.filePath?.trim() || command.outputPath?.trim()) {
            const targetPath =
              command.filePath?.trim() || command.outputPath?.trim() || "";
            await writeBrowserWorkspaceFile(
              targetPath,
              JSON.stringify(traceValue, null, 2),
            );
            return {
              mode: "web",
              subaction: command.subaction,
              value: { path: path.resolve(targetPath), ...traceValue },
            };
          }
          return {
            mode: "web",
            subaction: command.subaction,
            value: traceValue,
          };
        }
        runtime.trace = { active: true, entries: [] };
        runtime.trace.entries.push({
          command: "trace:start",
          timestamp: getBrowserWorkspaceTimestamp(),
        });
        return {
          mode: "web",
          subaction: command.subaction,
          value: { active: true },
        };
      }
      case "profiler": {
        if (command.profilerAction === "stop") {
          runtime.profiler.active = false;
          const profileValue = { entries: runtime.profiler.entries };
          if (command.filePath?.trim() || command.outputPath?.trim()) {
            const targetPath =
              command.filePath?.trim() || command.outputPath?.trim() || "";
            await writeBrowserWorkspaceFile(
              targetPath,
              JSON.stringify(profileValue, null, 2),
            );
            return {
              mode: "web",
              subaction: command.subaction,
              value: { path: path.resolve(targetPath), ...profileValue },
            };
          }
          return {
            mode: "web",
            subaction: command.subaction,
            value: profileValue,
          };
        }
        runtime.profiler = {
          active: true,
          entries: [
            {
              command: "profiler:start",
              timestamp: getBrowserWorkspaceTimestamp(),
            },
          ],
        };
        return {
          mode: "web",
          subaction: command.subaction,
          value: { active: true },
        };
      }
      case "state": {
        if (command.stateAction === "load") {
          const filePath =
            command.filePath?.trim() || command.outputPath?.trim();
          if (!filePath) {
            throw new Error(
              "Eliza browser workspace state load requires filePath.",
            );
          }
          const payload = JSON.parse(
            await fsp.readFile(path.resolve(filePath), "utf8"),
          ) as Record<string, unknown>;
          applyBrowserWorkspaceStateToWebDocument(document, payload);
          if (payload.settings && typeof payload.settings === "object") {
            runtime.settings = {
              ...runtime.settings,
              ...(payload.settings as BrowserWorkspaceSettingsState),
            };
            applyBrowserWorkspaceDomSettings(dom, runtime);
          }
          browserWorkspaceClipboardText =
            typeof payload.clipboard === "string"
              ? payload.clipboard
              : browserWorkspaceClipboardText;
          return {
            mode: "web",
            subaction: command.subaction,
            value: { loaded: true },
          };
        }
        const payload = {
          clipboard: browserWorkspaceClipboardText,
          cookies: readBrowserWorkspaceCookies(document),
          localStorage: readBrowserWorkspaceStorage(dom.window.localStorage),
          sessionStorage: readBrowserWorkspaceStorage(
            dom.window.sessionStorage,
          ),
          settings: runtime.settings,
          url: tab.url,
        };
        const filePath = command.filePath?.trim() || command.outputPath?.trim();
        if (filePath) {
          await writeBrowserWorkspaceFile(
            filePath,
            JSON.stringify(payload, null, 2),
          );
          return {
            mode: "web",
            subaction: command.subaction,
            value: { path: path.resolve(filePath), ...payload },
          };
        }
        return { mode: "web", subaction: command.subaction, value: payload };
      }
      case "pdf": {
        const filePath = command.filePath?.trim() || command.outputPath?.trim();
        if (!filePath) {
          throw new Error("Eliza browser workspace pdf requires filePath.");
        }
        const pdf = createBrowserWorkspacePdfBuffer(
          tab.title,
          normalizeBrowserWorkspaceText(document.body?.textContent),
        );
        const resolved = await writeBrowserWorkspaceFile(filePath, pdf);
        return {
          mode: "web",
          subaction: command.subaction,
          value: { path: resolved, size: pdf.byteLength },
        };
      }
      default:
        return null;
    }
  });
}

async function executeWebBrowserWorkspaceDomCommand(
  command: BrowserWorkspaceCommand,
): Promise<BrowserWorkspaceCommandResult> {
  return withWebStateLock(async () => {
    const id = findWebBrowserWorkspaceTargetTabId(command);
    command = resolveBrowserWorkspaceCommandElementRefs(command, "web", id);
    const tab = getWebBrowserWorkspaceTabState(id);
    const dom = await ensureLoadedWebBrowserWorkspaceTabDocument(tab);
    const frameContext = resolveWebBrowserWorkspaceCommandDocument(tab, dom);
    const document = frameContext.document;
    const resolveTarget = () =>
      resolveBrowserWorkspaceElement(
        document,
        command.selector,
        command.text,
        command,
      );

    switch (command.subaction) {
      case "inspect":
        clearWebBrowserWorkspaceTabElementRefs(tab.id);
        return {
          mode: "web",
          subaction: command.subaction,
          elements: registerBrowserWorkspaceElementRefs(
            "web",
            tab.id,
            collectBrowserWorkspaceInspectElements(document),
          ),
          value: {
            title: tab.title,
            url: tab.url,
          },
        };
      case "snapshot":
        clearWebBrowserWorkspaceTabElementRefs(tab.id);
        return {
          mode: "web",
          subaction: command.subaction,
          elements: registerBrowserWorkspaceElementRefs(
            "web",
            tab.id,
            collectBrowserWorkspaceInspectElements(document),
          ),
          value: {
            bodyText: buildBrowserWorkspaceDocumentSnapshotText(document).slice(
              0,
              800,
            ),
            title: tab.title,
            url: tab.url,
          },
        };
      case "get": {
        if (command.getMode === "title") {
          return {
            mode: "web",
            subaction: command.subaction,
            value: tab.title,
          };
        }
        if (command.getMode === "url") {
          return { mode: "web", subaction: command.subaction, value: tab.url };
        }
        if (command.getMode === "count") {
          if (!command.selector?.trim()) {
            throw new Error(
              "Eliza browser workspace get count requires selector.",
            );
          }
          const semanticCommand = mergeBrowserWorkspaceSelectorCommand(
            command,
            command.selector,
          );
          return {
            mode: "web",
            subaction: command.subaction,
            value: semanticCommand
              ? Number(
                  Boolean(
                    resolveBrowserWorkspaceFindElement(
                      document,
                      semanticCommand,
                    ),
                  ),
                )
              : queryAllBrowserWorkspaceSelector(document, command.selector)
                  .length,
          };
        }

        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }

        let value: unknown;
        switch (command.getMode) {
          case "attr":
            if (!command.attribute?.trim()) {
              throw new Error(
                "Eliza browser workspace attr lookups require attribute.",
              );
            }
            value = element.getAttribute(command.attribute);
            break;
          case "box":
            value = getBrowserWorkspaceElementBox(element);
            break;
          case "checked":
            value =
              element.tagName === "INPUT"
                ? Boolean((element as HTMLInputElement).checked)
                : element.tagName === "OPTION"
                  ? Boolean((element as HTMLOptionElement).selected)
                  : false;
            break;
          case "enabled":
            value =
              "disabled" in element
                ? !(
                    element as
                      | HTMLButtonElement
                      | HTMLInputElement
                      | HTMLSelectElement
                      | HTMLTextAreaElement
                  ).disabled
                : true;
            break;
          case "html":
            value = element.innerHTML;
            break;
          case "styles":
            value = getBrowserWorkspaceElementStyles(element, dom.window);
            break;
          case "value":
            value = getBrowserWorkspaceElementValue(element);
            break;
          case "visible":
            value = isBrowserWorkspaceElementVisible(element);
            break;
          default:
            value = normalizeBrowserWorkspaceText(element.textContent);
            break;
        }

        return { mode: "web", subaction: command.subaction, value };
      }
      case "find": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }

        switch (command.action) {
          case "check": {
            const input = ensureBrowserWorkspaceCheckboxElement(
              element,
              "check",
            );
            input.checked = true;
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                checked: input.checked,
                selector: buildBrowserWorkspaceElementSelector(input),
              },
            };
          }
          case "click":
            return {
              ...(await activateWebBrowserWorkspaceElement(
                tab,
                element,
                "click",
              )),
              subaction: command.subaction,
            };
          case "fill": {
            const control = ensureBrowserWorkspaceFormControlElement(
              element,
              "fill",
            );
            setBrowserWorkspaceControlValue(control, command.value ?? "");
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                selector: buildBrowserWorkspaceElementSelector(control),
                value: control.value,
              },
            };
          }
          case "focus":
            if (typeof (element as HTMLElement).focus === "function") {
              (element as HTMLElement).focus();
            }
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                focused: document.activeElement === element,
                selector: buildBrowserWorkspaceElementSelector(element),
              },
            };
          case "hover":
            element.setAttribute("data-eliza-hover", "true");
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                hovered: true,
                selector: buildBrowserWorkspaceElementSelector(element),
              },
            };
          case "type": {
            const control = ensureBrowserWorkspaceFormControlElement(
              element,
              "type",
            );
            setBrowserWorkspaceControlValue(
              control,
              `${control.value ?? ""}${command.value ?? ""}`,
            );
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                selector: buildBrowserWorkspaceElementSelector(control),
                value: control.value,
              },
            };
          }
          case "uncheck": {
            const input = ensureBrowserWorkspaceCheckboxElement(
              element,
              "uncheck",
            );
            input.checked = false;
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                checked: input.checked,
                selector: buildBrowserWorkspaceElementSelector(input),
              },
            };
          }
          case "text":
          case undefined:
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                element: createBrowserWorkspaceElementSummary(element),
                text: normalizeBrowserWorkspaceText(element.textContent),
              },
            };
          default:
            throw new Error(
              `Unsupported browser workspace find action: ${command.action}`,
            );
        }
      }
      case "check": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        const input = ensureBrowserWorkspaceCheckboxElement(element, "check");
        input.checked = true;
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            checked: input.checked,
            selector: buildBrowserWorkspaceElementSelector(input),
          },
        };
      }
      case "fill":
      case "type": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        const control = ensureBrowserWorkspaceFormControlElement(
          element,
          command.subaction,
        );
        const nextValue =
          command.subaction === "type"
            ? `${control.value ?? ""}${command.value ?? ""}`
            : (command.value ?? "");
        setBrowserWorkspaceControlValue(control, nextValue);
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            selector: buildBrowserWorkspaceElementSelector(control),
            value: nextValue,
          },
        };
      }
      case "focus": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        if (typeof (element as HTMLElement).focus === "function") {
          (element as HTMLElement).focus();
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            focused: document.activeElement === element,
            selector: buildBrowserWorkspaceElementSelector(element),
          },
        };
      }
      case "hover": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        element.setAttribute("data-eliza-hover", "true");
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            hovered: true,
            selector: buildBrowserWorkspaceElementSelector(element),
          },
        };
      }
      case "keyboardinserttext":
      case "keyboardtype": {
        const active = document.activeElement;
        if (
          !active ||
          !(
            active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.tagName === "SELECT"
          )
        ) {
          throw new Error(
            "Eliza browser workspace keyboard text input requires a focused input target.",
          );
        }
        const control = ensureBrowserWorkspaceFormControlElement(
          active,
          command.subaction === "keyboardtype" ? "type" : "keyboardinserttext",
        );
        const nextValue =
          command.subaction === "keyboardtype"
            ? `${control.value ?? ""}${command.value ?? ""}`
            : (command.value ?? "");
        setBrowserWorkspaceControlValue(control, nextValue);
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            selector: buildBrowserWorkspaceElementSelector(control),
            value: control.value,
          },
        };
      }
      case "keydown":
      case "keyup":
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            key: command.key?.trim() || "Enter",
            selector:
              document.activeElement &&
              document.activeElement instanceof Element
                ? buildBrowserWorkspaceElementSelector(document.activeElement)
                : null,
          },
        };
      case "click": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        return activateWebBrowserWorkspaceElement(tab, element, "click");
      }
      case "dblclick": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        return activateWebBrowserWorkspaceElement(tab, element, "dblclick");
      }
      case "press": {
        const key = command.key?.trim() || "Enter";
        const element = resolveTarget();
        const form = findClosestBrowserWorkspaceForm(element);

        if (key === "Enter" && form) {
          await submitWebBrowserWorkspaceForm(tab, form);
          return {
            mode: "web",
            subaction: command.subaction,
            tab: cloneWebBrowserWorkspaceTabState(tab),
            value: { key, url: tab.url },
          };
        }

        return { mode: "web", subaction: command.subaction, value: { key } };
      }
      case "scroll": {
        return {
          mode: "web",
          subaction: command.subaction,
          value: scrollWebBrowserWorkspaceTarget(
            dom,
            resolveTarget(),
            command.direction ?? "down",
            command.pixels ?? 240,
          ),
        };
      }
      case "scrollinto": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        if (typeof (element as HTMLElement).focus === "function") {
          (element as HTMLElement).focus();
        }
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            scrolled: true,
            selector: buildBrowserWorkspaceElementSelector(element),
          },
        };
      }
      case "select": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        if (element.tagName !== "SELECT") {
          throw new Error(
            "Eliza browser workspace select requires a select target.",
          );
        }
        const select = ensureBrowserWorkspaceFormControlElement(
          element,
          "select",
        );
        const option = Array.from((select as HTMLSelectElement).options).find(
          (entry) =>
            entry.value === (command.value ?? "") ||
            browserWorkspaceTextMatches(
              entry.textContent ?? "",
              command.value ?? "",
              true,
            ),
        );
        if (!option) {
          throw new Error("Select option was not found.");
        }
        (select as HTMLSelectElement).value = option.value;
        option.selected = true;
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            selector: buildBrowserWorkspaceElementSelector(select),
            value: (select as HTMLSelectElement).value,
          },
        };
      }
      case "uncheck": {
        const element = resolveTarget();
        if (!element) {
          throw new Error("Target element was not found.");
        }
        const input = ensureBrowserWorkspaceCheckboxElement(element, "uncheck");
        input.checked = false;
        return {
          mode: "web",
          subaction: command.subaction,
          value: {
            checked: input.checked,
            selector: buildBrowserWorkspaceElementSelector(input),
          },
        };
      }
      case "wait": {
        if (
          !command.selector &&
          !command.findBy &&
          !command.text &&
          !command.url &&
          !command.script &&
          typeof command.timeoutMs === "number" &&
          Number.isFinite(command.timeoutMs)
        ) {
          const waitedMs = Math.max(0, command.timeoutMs);
          await sleep(waitedMs);
          return {
            mode: "web",
            subaction: command.subaction,
            value: { waitedMs },
          };
        }
        const timeoutMs =
          typeof command.timeoutMs === "number" &&
          Number.isFinite(command.timeoutMs)
            ? Math.max(100, command.timeoutMs)
            : DEFAULT_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() <= deadline) {
          await ensureLoadedWebBrowserWorkspaceTabDocument(tab);
          const currentDom = ensureBrowserWorkspaceDom(tab);
          const currentDocument = currentDom.window.document;

          const matchesSelector = command.selector?.trim()
            ? (() => {
                const found = resolveBrowserWorkspaceElement(
                  currentDocument,
                  command.selector,
                  undefined,
                  command,
                );
                if (!command.state || command.state === "visible") {
                  return found
                    ? isBrowserWorkspaceElementVisible(found)
                    : false;
                }
                return !found || !isBrowserWorkspaceElementVisible(found);
              })()
            : false;
          const matchesFind = command.findBy
            ? Boolean(
                resolveBrowserWorkspaceFindElement(currentDocument, command),
              )
            : false;
          const matchesText = command.text?.trim()
            ? normalizeBrowserWorkspaceText(
                currentDocument.body?.textContent,
              ).includes(command.text.trim())
            : false;
          const matchesUrl = command.url?.trim()
            ? tab.url.includes(command.url.trim())
            : false;
          const matchesScript = command.script?.trim()
            ? Boolean(
                new Function(
                  "document",
                  "window",
                  "location",
                  `return (${command.script});`,
                )(
                  currentDocument,
                  currentDom.window,
                  currentDom.window.location,
                ),
              )
            : false;

          if (
            matchesSelector ||
            matchesFind ||
            matchesText ||
            matchesUrl ||
            matchesScript ||
            (!command.selector &&
              !command.findBy &&
              !command.text &&
              !command.url &&
              !command.script)
          ) {
            return {
              mode: "web",
              subaction: command.subaction,
              value: {
                findBy: command.findBy ?? null,
                selector: command.selector ?? null,
                state: command.state ?? null,
                text: command.text ?? null,
                url: tab.url,
              },
            };
          }

          await sleep(DEFAULT_WAIT_INTERVAL_MS);
        }

        throw new Error("Timed out waiting for browser workspace condition.");
      }
      default:
        throw new Error(
          `Unsupported web browser workspace subaction: ${command.subaction}`,
        );
    }
  });
}

export function resolveBrowserWorkspaceBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): BrowserWorkspaceBridgeConfig | null {
  const baseUrl =
    normalizeEnvValue(env.ELIZA_BROWSER_WORKSPACE_URL) ??
    normalizeEnvValue(env.ELIZA_BROWSER_WORKSPACE_URL);
  if (!baseUrl) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token:
      normalizeEnvValue(env.ELIZA_BROWSER_WORKSPACE_TOKEN) ??
      normalizeEnvValue(env.ELIZA_BROWSER_WORKSPACE_TOKEN),
  };
}

export function isBrowserWorkspaceBridgeConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveBrowserWorkspaceBridgeConfig(env) !== null;
}

export function getBrowserWorkspaceMode(
  env: NodeJS.ProcessEnv = process.env,
): BrowserWorkspaceMode {
  return isBrowserWorkspaceBridgeConfigured(env) ? "desktop" : "web";
}

export function getBrowserWorkspaceUnavailableMessage(): string {
  return DESKTOP_BRIDGE_UNAVAILABLE_MESSAGE;
}

export async function getBrowserWorkspaceSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserWorkspaceSnapshot> {
  return {
    mode: getBrowserWorkspaceMode(env),
    tabs: await listBrowserWorkspaceTabs(env),
  };
}

export async function listBrowserWorkspaceTabs(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserWorkspaceTab[]> {
  if (!isBrowserWorkspaceBridgeConfigured(env)) {
    return cloneBrowserWorkspaceTabs(
      webWorkspaceState.tabs.map((tab) =>
        cloneWebBrowserWorkspaceTabState(tab),
      ),
    );
  }

  const payload = await requestBrowserWorkspace<{
    tabs?: BrowserWorkspaceTab[];
  }>("/tabs", undefined, env);
  return Array.isArray(payload.tabs) ? payload.tabs : [];
}

export async function openBrowserWorkspaceTab(
  request: OpenBrowserWorkspaceTabRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserWorkspaceTab> {
  if (!isBrowserWorkspaceBridgeConfigured(env)) {
    return withWebStateLock(() => {
      const tab = createWebBrowserWorkspaceTab(request);
      getBrowserWorkspaceRuntimeState("web", tab.id);
      clearWebBrowserWorkspaceTabElementRefs(tab.id);
      if (tab.visible) {
        webWorkspaceState.tabs = webWorkspaceState.tabs.map((entry) => ({
          ...entry,
          visible: false,
        }));
      }
      webWorkspaceState.tabs = [...webWorkspaceState.tabs, tab];
      return cloneWebBrowserWorkspaceTabState(tab);
    });
  }

  const payload = await requestBrowserWorkspace<{ tab: BrowserWorkspaceTab }>(
    "/tabs",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
    env,
  );
  return payload.tab;
}

export async function navigateBrowserWorkspaceTab(
  request: NavigateBrowserWorkspaceTabRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserWorkspaceTab> {
  const nextUrl = assertBrowserWorkspaceUrl(request.url);

  if (!isBrowserWorkspaceBridgeConfigured(env)) {
    return withWebStateLock(() => {
      const index = getWebBrowserWorkspaceTabIndex(request.id);
      if (index < 0) {
        throw createBrowserWorkspaceNotFoundError(request.id);
      }

      const existing = webWorkspaceState.tabs[index];
      const updatedAt = getBrowserWorkspaceTimestamp();
      const state = getBrowserWorkspaceRuntimeState("web", existing.id);
      clearWebBrowserWorkspaceTabElementRefs(existing.id);
      pushWebBrowserWorkspaceHistory(existing, nextUrl);
      const nextDom =
        nextUrl === "about:blank"
          ? createEmptyWebBrowserWorkspaceDom(nextUrl)
          : null;
      const nextTab: WebBrowserWorkspaceTabState = {
        ...existing,
        title: inferBrowserWorkspaceTitle(nextUrl),
        url: nextUrl,
        updatedAt,
        dom: nextDom,
        loadedUrl: nextUrl === "about:blank" ? nextUrl : null,
      };
      if (nextDom) {
        installBrowserWorkspaceWebRuntime(nextTab, nextDom);
      }
      resetBrowserWorkspaceRuntimeNavigationState(state);
      webWorkspaceState.tabs[index] = nextTab;
      return cloneWebBrowserWorkspaceTabState(nextTab);
    });
  }

  const payload = await requestBrowserWorkspace<{ tab: BrowserWorkspaceTab }>(
    `/tabs/${encodeURIComponent(request.id)}/navigate`,
    {
      method: "POST",
      body: JSON.stringify({ url: nextUrl }),
    },
    env,
  );
  return payload.tab;
}

export async function showBrowserWorkspaceTab(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserWorkspaceTab> {
  if (!isBrowserWorkspaceBridgeConfigured(env)) {
    return withWebStateLock(() => {
      getWebBrowserWorkspaceTabState(id);
      const lastFocusedAt = getBrowserWorkspaceTimestamp();
      webWorkspaceState.tabs = webWorkspaceState.tabs.map((tab) => ({
        ...tab,
        visible: tab.id === id,
        lastFocusedAt: tab.id === id ? lastFocusedAt : tab.lastFocusedAt,
        updatedAt: tab.id === id ? lastFocusedAt : tab.updatedAt,
      }));
      return cloneWebBrowserWorkspaceTabState(
        getWebBrowserWorkspaceTabState(id),
      );
    });
  }

  const payload = await requestBrowserWorkspace<{ tab: BrowserWorkspaceTab }>(
    `/tabs/${encodeURIComponent(id)}/show`,
    { method: "POST" },
    env,
  );
  return payload.tab;
}

export async function hideBrowserWorkspaceTab(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserWorkspaceTab> {
  if (!isBrowserWorkspaceBridgeConfigured(env)) {
    return withWebStateLock(() => {
      const index = getWebBrowserWorkspaceTabIndex(id);
      if (index < 0) {
        throw createBrowserWorkspaceNotFoundError(id);
      }

      const updatedAt = getBrowserWorkspaceTimestamp();
      const nextTab: WebBrowserWorkspaceTabState = {
        ...webWorkspaceState.tabs[index],
        visible: false,
        updatedAt,
      };
      webWorkspaceState.tabs[index] = nextTab;
      return cloneWebBrowserWorkspaceTabState(nextTab);
    });
  }

  const payload = await requestBrowserWorkspace<{ tab: BrowserWorkspaceTab }>(
    `/tabs/${encodeURIComponent(id)}/hide`,
    { method: "POST" },
    env,
  );
  return payload.tab;
}

export async function closeBrowserWorkspaceTab(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!isBrowserWorkspaceBridgeConfigured(env)) {
    return withWebStateLock(() => {
      const initialLength = webWorkspaceState.tabs.length;
      clearWebBrowserWorkspaceTabElementRefs(id);
      clearBrowserWorkspaceRuntimeState("web", id);
      webWorkspaceState.tabs = webWorkspaceState.tabs.filter(
        (tab) => tab.id !== id,
      );
      return webWorkspaceState.tabs.length !== initialLength;
    });
  }

  const payload = await requestBrowserWorkspace<{ closed?: boolean }>(
    `/tabs/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    env,
  );
  return payload.closed === true;
}

export async function evaluateBrowserWorkspaceTab(
  request: EvaluateBrowserWorkspaceTabRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  if (!isBrowserWorkspaceBridgeConfigured(env)) {
    throw new Error(createBrowserWorkspaceDesktopOnlyMessage("eval"));
  }

  const payload = await requestBrowserWorkspace<{ result: unknown }>(
    `/tabs/${encodeURIComponent(request.id)}/eval`,
    {
      method: "POST",
      body: JSON.stringify({ script: request.script }),
    },
    env,
  );
  return payload.result;
}

export async function snapshotBrowserWorkspaceTab(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ data: string }> {
  if (!isBrowserWorkspaceBridgeConfigured(env)) {
    throw new Error(createBrowserWorkspaceDesktopOnlyMessage("snapshot"));
  }

  return await requestBrowserWorkspace<{ data: string }>(
    `/tabs/${encodeURIComponent(id)}/snapshot`,
    undefined,
    env,
  );
}

export async function executeBrowserWorkspaceCommand(
  command: BrowserWorkspaceCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserWorkspaceCommandResult> {
  command = normalizeBrowserWorkspaceCommand(command);
  switch (command.subaction) {
    case "batch": {
      const steps = Array.isArray(command.steps) ? command.steps : [];
      if (steps.length === 0) {
        throw new Error(
          "Eliza browser workspace batch requires at least one step.",
        );
      }
      const results: BrowserWorkspaceCommandResult[] = [];
      for (const step of steps) {
        results.push(await executeBrowserWorkspaceCommand(step, env));
      }
      return {
        mode: getBrowserWorkspaceMode(env),
        subaction: command.subaction,
        steps: results,
        value: results.at(-1)?.value,
      };
    }
    case "list":
      return {
        mode: getBrowserWorkspaceMode(env),
        subaction: command.subaction,
        tabs: await listBrowserWorkspaceTabs(env),
      };
    case "open": {
      const tab = await openBrowserWorkspaceTab(
        {
          partition: command.partition,
          show: command.show,
          title: command.title,
          url: command.url,
        },
        env,
      );
      clearBrowserWorkspaceElementRefs(getBrowserWorkspaceMode(env), tab.id);
      return {
        mode: getBrowserWorkspaceMode(env),
        subaction: command.subaction,
        tab,
      };
    }
    case "navigate": {
      const id = isBrowserWorkspaceBridgeConfigured(env)
        ? await resolveDesktopBrowserWorkspaceTargetTabId(command, env)
        : findWebBrowserWorkspaceTargetTabId(command);
      clearBrowserWorkspaceElementRefs(getBrowserWorkspaceMode(env), id);
      return {
        mode: getBrowserWorkspaceMode(env),
        subaction: command.subaction,
        tab: await navigateBrowserWorkspaceTab(
          {
            id,
            url: command.url ?? "",
          },
          env,
        ),
      };
    }
    case "show": {
      const id = isBrowserWorkspaceBridgeConfigured(env)
        ? await resolveDesktopBrowserWorkspaceTargetTabId(command, env)
        : findWebBrowserWorkspaceTargetTabId(command);
      return {
        mode: getBrowserWorkspaceMode(env),
        subaction: command.subaction,
        tab: await showBrowserWorkspaceTab(id, env),
      };
    }
    case "hide": {
      const id = isBrowserWorkspaceBridgeConfigured(env)
        ? await resolveDesktopBrowserWorkspaceTargetTabId(command, env)
        : findWebBrowserWorkspaceTargetTabId(command);
      return {
        mode: getBrowserWorkspaceMode(env),
        subaction: command.subaction,
        tab: await hideBrowserWorkspaceTab(id, env),
      };
    }
    case "close": {
      const id = isBrowserWorkspaceBridgeConfigured(env)
        ? await resolveDesktopBrowserWorkspaceTargetTabId(command, env)
        : findWebBrowserWorkspaceTargetTabId(command);
      clearBrowserWorkspaceElementRefs(getBrowserWorkspaceMode(env), id);
      clearBrowserWorkspaceRuntimeState(getBrowserWorkspaceMode(env), id);
      return {
        mode: getBrowserWorkspaceMode(env),
        subaction: command.subaction,
        closed: await closeBrowserWorkspaceTab(id, env),
      };
    }
    case "eval": {
      if (!isBrowserWorkspaceBridgeConfigured(env)) {
        return (await executeWebBrowserWorkspaceUtilityCommand(
          command,
        )) as BrowserWorkspaceCommandResult;
      }
      const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
      return {
        mode: "desktop",
        subaction: command.subaction,
        value: await evaluateBrowserWorkspaceTab(
          {
            id,
            script: command.script ?? "",
          },
          env,
        ),
      };
    }
    case "screenshot": {
      if (!isBrowserWorkspaceBridgeConfigured(env)) {
        return (await executeWebBrowserWorkspaceUtilityCommand(
          command,
        )) as BrowserWorkspaceCommandResult;
      }
      const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
      return {
        mode: "desktop",
        subaction: command.subaction,
        snapshot: await snapshotBrowserWorkspaceTab(id, env),
      };
    }
    case "clipboard":
    case "console":
    case "cookies":
    case "dialog":
    case "drag":
    case "errors":
    case "frame":
    case "highlight":
    case "mouse":
    case "network":
    case "set":
    case "storage":
    case "upload": {
      if (!isBrowserWorkspaceBridgeConfigured(env)) {
        return (await executeWebBrowserWorkspaceUtilityCommand(
          command,
        )) as BrowserWorkspaceCommandResult;
      }
      return executeDesktopBrowserWorkspaceUtilityCommand(command, env);
    }
    case "diff": {
      if (!isBrowserWorkspaceBridgeConfigured(env)) {
        return (await executeWebBrowserWorkspaceUtilityCommand(
          command,
        )) as BrowserWorkspaceCommandResult;
      }
      const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
      const runtime = getBrowserWorkspaceRuntimeState("desktop", id);
      const snapshot = await getDesktopBrowserWorkspaceSnapshotRecord(
        command,
        env,
      );
      if (command.diffAction === "screenshot") {
        const screenshot = await snapshotBrowserWorkspaceTab(id, env);
        const currentData = screenshot.data;
        const baseline = command.baselinePath?.trim()
          ? await fsp.readFile(
              path.resolve(command.baselinePath.trim()),
              "base64",
            )
          : runtime.lastScreenshotData;
        runtime.lastScreenshotData = currentData;
        return {
          mode: "desktop",
          subaction: command.subaction,
          value: {
            baselineLength: baseline?.length ?? 0,
            changed: baseline !== currentData,
            currentLength: currentData.length,
          },
        };
      }
      if (command.diffAction === "url") {
        const leftUrl = command.url?.trim() || snapshot.url;
        const rightUrl = command.secondaryUrl?.trim();
        if (!rightUrl) {
          throw new Error(
            "Eliza browser workspace diff url requires secondaryUrl.",
          );
        }
        const left = await browserWorkspacePageFetch(leftUrl);
        const right = await browserWorkspacePageFetch(rightUrl);
        return {
          mode: "desktop",
          subaction: command.subaction,
          value: diffBrowserWorkspaceSnapshots(
            createBrowserWorkspaceSnapshotRecord(
              leftUrl,
              left.url || leftUrl,
              await left.text(),
            ),
            createBrowserWorkspaceSnapshotRecord(
              rightUrl,
              right.url || rightUrl,
              await right.text(),
            ),
          ),
        };
      }
      const baseline = command.baselinePath?.trim()
        ? (JSON.parse(
            await fsp.readFile(
              path.resolve(command.baselinePath.trim()),
              "utf8",
            ),
          ) as BrowserWorkspaceSnapshotRecord)
        : runtime.lastSnapshot;
      const diff = diffBrowserWorkspaceSnapshots(baseline, snapshot);
      runtime.lastSnapshot = snapshot;
      return { mode: "desktop", subaction: command.subaction, value: diff };
    }
    case "trace":
    case "profiler": {
      if (!isBrowserWorkspaceBridgeConfigured(env)) {
        return (await executeWebBrowserWorkspaceUtilityCommand(
          command,
        )) as BrowserWorkspaceCommandResult;
      }
      const id = await resolveDesktopBrowserWorkspaceTargetTabId(command, env);
      const runtime = getBrowserWorkspaceRuntimeState("desktop", id);
      const target =
        command.subaction === "trace" ? runtime.trace : runtime.profiler;
      const stop =
        command.subaction === "trace"
          ? command.traceAction === "stop"
          : command.profilerAction === "stop";
      if (stop) {
        target.active = false;
        const payload = { entries: target.entries };
        const filePath = command.filePath?.trim() || command.outputPath?.trim();
        if (filePath) {
          await writeBrowserWorkspaceFile(
            filePath,
            JSON.stringify(payload, null, 2),
          );
          return {
            mode: "desktop",
            subaction: command.subaction,
            value: { path: path.resolve(filePath), ...payload },
          };
        }
        return {
          mode: "desktop",
          subaction: command.subaction,
          value: payload,
        };
      }
      target.active = true;
      target.entries = [
        {
          command: `${command.subaction}:start`,
          timestamp: getBrowserWorkspaceTimestamp(),
        },
      ];
      return {
        mode: "desktop",
        subaction: command.subaction,
        value: { active: true },
      };
    }
    case "state": {
      if (!isBrowserWorkspaceBridgeConfigured(env)) {
        return (await executeWebBrowserWorkspaceUtilityCommand(
          command,
        )) as BrowserWorkspaceCommandResult;
      }
      if (command.stateAction === "load") {
        const filePath = command.filePath?.trim() || command.outputPath?.trim();
        if (!filePath) {
          throw new Error(
            "Eliza browser workspace state load requires filePath.",
          );
        }
        const payload = JSON.parse(
          await fsp.readFile(path.resolve(filePath), "utf8"),
        ) as Record<string, unknown>;
        await loadDesktopBrowserWorkspaceSessionState(command, payload, env);
        return {
          mode: "desktop",
          subaction: command.subaction,
          value: { loaded: true },
        };
      }
      const payload = await getDesktopBrowserWorkspaceSessionState(
        command,
        env,
      );
      const filePath = command.filePath?.trim() || command.outputPath?.trim();
      if (filePath) {
        await writeBrowserWorkspaceFile(
          filePath,
          JSON.stringify(payload, null, 2),
        );
        return {
          mode: "desktop",
          subaction: command.subaction,
          value: { path: path.resolve(filePath), ...payload },
        };
      }
      return { mode: "desktop", subaction: command.subaction, value: payload };
    }
    case "pdf": {
      if (!isBrowserWorkspaceBridgeConfigured(env)) {
        return (await executeWebBrowserWorkspaceUtilityCommand(
          command,
        )) as BrowserWorkspaceCommandResult;
      }
      const filePath = command.filePath?.trim() || command.outputPath?.trim();
      if (!filePath) {
        throw new Error("Eliza browser workspace pdf requires filePath.");
      }
      const snapshot = await getDesktopBrowserWorkspaceSnapshotRecord(
        command,
        env,
      );
      const pdf = createBrowserWorkspacePdfBuffer(
        snapshot.title,
        snapshot.bodyText,
      );
      const resolved = await writeBrowserWorkspaceFile(filePath, pdf);
      return {
        mode: "desktop",
        subaction: command.subaction,
        value: { path: resolved, size: pdf.byteLength },
      };
    }
    case "tab": {
      const action = command.tabAction ?? "list";
      if (action === "list") {
        return {
          mode: getBrowserWorkspaceMode(env),
          subaction: command.subaction,
          tabs: await listBrowserWorkspaceTabs(env),
        };
      }
      if (action === "new") {
        return {
          mode: getBrowserWorkspaceMode(env),
          subaction: command.subaction,
          tab: await openBrowserWorkspaceTab(
            {
              partition: command.partition,
              show: command.show ?? true,
              title: command.title,
              url: command.url,
              width: command.width,
              height: command.height,
            },
            env,
          ),
        };
      }
      if (action === "switch") {
        const tabs = await listBrowserWorkspaceTabs(env);
        const target = command.id?.trim()
          ? tabs.find((tab) => tab.id === command.id?.trim())
          : typeof command.index === "number"
            ? (tabs[command.index] ?? null)
            : null;
        if (!target) {
          throw new Error(
            "Eliza browser workspace tab switch requires a valid id or index.",
          );
        }
        return {
          mode: getBrowserWorkspaceMode(env),
          subaction: command.subaction,
          tab: await showBrowserWorkspaceTab(target.id, env),
        };
      }
      const targetId =
        command.id?.trim() ||
        (await listBrowserWorkspaceTabs(env))[command.index ?? -1]?.id;
      if (!targetId) {
        throw new Error(
          "Eliza browser workspace tab close requires a valid id or index.",
        );
      }
      return {
        mode: getBrowserWorkspaceMode(env),
        subaction: command.subaction,
        closed: await closeBrowserWorkspaceTab(targetId, env),
      };
    }
    case "window":
      return {
        mode: getBrowserWorkspaceMode(env),
        subaction: command.subaction,
        tab: await openBrowserWorkspaceTab(
          {
            partition: command.partition,
            show: true,
            title: command.title,
            url: command.url,
            width: command.width,
            height: command.height,
          },
          env,
        ),
      };
    case "back":
    case "forward":
    case "reload": {
      if (isBrowserWorkspaceBridgeConfigured(env)) {
        const id = await resolveDesktopBrowserWorkspaceTargetTabId(
          command,
          env,
        );
        clearBrowserWorkspaceElementRefs("desktop", id);
        return executeDesktopBrowserWorkspaceDomCommand(command, env);
      }

      return withWebStateLock(async () => {
        const id = findWebBrowserWorkspaceTargetTabId(command);
        const tab = getWebBrowserWorkspaceTabState(id);

        if (command.subaction === "reload") {
          clearWebBrowserWorkspaceTabElementRefs(tab.id);
          tab.dom = null;
          tab.loadedUrl = null;
          await loadWebBrowserWorkspaceTabDocument(tab);
          return {
            mode: "web",
            subaction: command.subaction,
            tab: cloneWebBrowserWorkspaceTabState(tab),
            value: { url: tab.url, title: tab.title },
          };
        }

        const delta = command.subaction === "back" ? -1 : 1;
        const nextIndex = tab.historyIndex + delta;
        if (nextIndex < 0 || nextIndex >= tab.history.length) {
          return {
            mode: "web",
            subaction: command.subaction,
            tab: cloneWebBrowserWorkspaceTabState(tab),
            value: { url: tab.url, title: tab.title, changed: false },
          };
        }

        tab.historyIndex = nextIndex;
        tab.url = tab.history[nextIndex] ?? tab.url;
        tab.title = inferBrowserWorkspaceTitle(tab.url);
        clearWebBrowserWorkspaceTabElementRefs(tab.id);
        tab.dom = null;
        tab.loadedUrl = null;
        await loadWebBrowserWorkspaceTabDocument(tab);
        return {
          mode: "web",
          subaction: command.subaction,
          tab: cloneWebBrowserWorkspaceTabState(tab),
          value: { url: tab.url, title: tab.title, changed: true },
        };
      });
    }
    case "inspect":
    case "snapshot":
    case "check":
    case "click":
    case "dblclick":
    case "find":
    case "fill":
    case "focus":
    case "get":
    case "hover":
    case "keydown":
    case "keyup":
    case "keyboardinserttext":
    case "keyboardtype":
    case "press":
    case "scroll":
    case "scrollinto":
    case "select":
    case "type":
    case "uncheck":
    case "wait":
      if (
        command.subaction === "wait" &&
        !command.selector &&
        !command.findBy &&
        !command.text &&
        !command.url &&
        !command.script &&
        typeof command.timeoutMs === "number" &&
        Number.isFinite(command.timeoutMs)
      ) {
        const waitedMs = Math.max(0, command.timeoutMs);
        await sleep(waitedMs);
        return {
          mode: getBrowserWorkspaceMode(env),
          subaction: command.subaction,
          value: { waitedMs },
        };
      }
      if (isBrowserWorkspaceBridgeConfigured(env)) {
        return executeDesktopBrowserWorkspaceDomCommand(command, env);
      }
      return executeWebBrowserWorkspaceDomCommand(command);
    default: {
      const exhaustive: never = command.subaction;
      throw new Error(`Unsupported browser workspace subaction: ${exhaustive}`);
    }
  }
}
