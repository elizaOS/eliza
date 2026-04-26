import fs from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  resolveApiToken,
  resolveDesktopApiPort,
} from "@elizaos/shared";
import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  BuildConfig,
  Session,
  Updater,
  Utils,
  WGPU,
  webgpu,
} from "electrobun/bun";
import {
  pushApiBaseToRenderer,
  resolveDesktopRuntimeMode,
  resolveInitialApiBase,
  resolveRendererFacingApiBase,
} from "./api-base";
import {
  buildApplicationMenu,
  EMPTY_HEARTBEAT_MENU_SNAPSHOT,
  type HeartbeatMenuSnapshot,
  parseSettingsWindowAction,
} from "./application-menu";
import { setApplicationMenuActionHandler } from "./application-menu-action-registry";
import { showBackgroundNoticeOnce } from "./background-notice";
import { getBrandConfig } from "./brand-config";
import { startBrowserWorkspaceBridgeServer } from "./browser-workspace-bridge-server";
import { readNavigationEventUrl } from "./cloud-auth-window";
import { startDesktopTestBridgeServer } from "./desktop-test-bridge-server";
import { scheduleDevtoolsLayoutRefresh } from "./devtools-layout";
import { getFloatingChatManager } from "./floating-chat-window";
import {
  resolveBootstrapShellRenderer,
  resolveBootstrapViewRenderer,
  resolveMainWindowPartition,
  shouldForceMainWindowCef,
} from "./main-window-session";
import {
  buildMainMenuResetApiCandidates,
  pickReachableMenuResetApiBase,
  runMainMenuResetAfterApiBaseResolved,
} from "./menu-reset-from-main";
import {
  configureDesktopLocalApiAuth,
  getAgentManager,
  getDiagnosticLogPath,
  getStartupDiagnosticLogTail,
  getStartupDiagnosticsSnapshot,
  getStartupStatusPath,
} from "./native/agent";
import {
  type DesktopSession,
  installDesktopSessionCookies,
  loadOrCreateDesktopSession,
} from "./native/auth-bridge";
import { getDesktopManager } from "./native/desktop";
import { disposeNativeModules, initializeNativeModules } from "./native/index";
import {
  enableVibrancy,
  ensureShadow,
  setNativeDragRegion,
  setTrafficLightsPosition,
} from "./native/mac-window-effects";
import { getPermissionManager } from "./native/permissions";
import { checkWebGpuSupport } from "./native/webgpu-browser-support";
import { printElectrobunDevSettingsBanner } from "./print-electrobun-dev-settings-banner";
import { resolveRendererAsset } from "./renderer-static";
import { registerRpcHandlers } from "./rpc-handlers";
import {
  readResolvedPreloadScript,
  resolveRendererAssetDir,
} from "./runtime-layout";
import { mergeRuntimePermissionStates } from "./runtime-permissions";
import { startScreenshotDevServer } from "./screenshot-dev-server";
import { recordStartupPhase, resolveStartupBundlePath } from "./startup-trace";
import {
  isDetachedSurface,
  type ManagedWindowLike,
  SurfaceWindowManager,
} from "./surface-windows";
import type { SendToWebview } from "./types.js";
import {
  resolveDesktopBundleVersion,
  shouldResetWindowsCefProfile,
  shouldWriteWindowsCefProfileMarker,
} from "./windows-cef-profile";

type HeartbeatMenuTriggerSummary = {
  enabled: boolean;
  nextRunAtMs?: number;
  lastRunAtIso?: string;
};

type HeartbeatMenuHealthResponse = {
  activeTriggers?: number;
  totalExecutions?: number;
  totalFailures?: number;
  lastExecutionAt?: number;
};

const HEARTBEAT_MENU_REFRESH_MS = 30_000;
const BRAND = getBrandConfig();
const CONFIG_EXPORT_FILE_NAME = BRAND.configExportFileName;
const STARTUP_CRASH_REPORT_FILE = "startup-crash-report-latest.md";
const STARTUP_CRASH_PROMPT_MARKER_FILE = "startup-crash-last-prompted.txt";
let heartbeatMenuSnapshot: HeartbeatMenuSnapshot =
  EMPTY_HEARTBEAT_MENU_SNAPSHOT;
let heartbeatMenuRefreshTimer: ReturnType<typeof setInterval> | null = null;

import {
  isAgentReady,
  onAgentReadyChange,
  setAgentReady,
} from "./agent-ready-state";
import {
  clearCurrentMainWindow,
  setCurrentMainWindow,
  updateCurrentMainWindowEffectsState,
} from "./main-window-runtime";
import {
  isStewardLocalEnabled,
  onStewardStatusChange,
  resetSteward,
  restartSteward,
  setStewardSendToWebview,
  startSteward,
  stopSteward,
} from "./native/steward";

function resolveDesktopAppIconPath(): string {
  return path.join(
    import.meta.dir,
    process.platform === "win32"
      ? "../assets/appIcon.ico"
      : "../assets/appIcon.png",
  );
}

function shouldUseBrowserDevtoolsFallback(): boolean {
  return false;
}

function setupApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const menu = buildApplicationMenu({
    isMac,
    browserEnabled: false,
    heartbeatSnapshot: heartbeatMenuSnapshot,
    detachedWindows: surfaceWindowManager?.listWindows() ?? [],
    agentReady: isAgentReady(),
  });
  ApplicationMenu.setApplicationMenu(
    menu as unknown as Parameters<typeof ApplicationMenu.setApplicationMenu>[0],
  );
}

onAgentReadyChange(() => setupApplicationMenu());

function summarizeDesktopActionError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  const trimmed = message.trim();
  if (!trimmed) return fallback;
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

function summarizeHeartbeatMenuError(error: unknown): string {
  return summarizeDesktopActionError(error, "Heartbeat status unavailable");
}

function buildApiRequestHeaders(contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  let apiToken = resolveApiToken(process.env);
  if (!apiToken) {
    const rt = resolveDesktopRuntimeMode(
      process.env as Record<string, string | undefined>,
    );
    if (rt.mode === "local") {
      apiToken = configureDesktopLocalApiAuth().trim();
    }
  }
  if (apiToken) {
    headers.Authorization = `Bearer ${apiToken}`;
  }
  return headers;
}

function resolveHeartbeatMenuApiBase(): string | null {
  const port = getAgentManager().getStatus().port;
  if (typeof port === "number" && port > 0) {
    return `http://127.0.0.1:${port}`;
  }
  return resolveInitialApiBase(process.env);
}

/**
 * Picks a loopback API base the main process can actually reach.
 *
 * **WHY:** `resolveHeartbeatMenuApiBase()` falls back to `resolveInitialApiBase`,
 * which in **external** mode is `ELIZA_DESKTOP_API_BASE` (often :31337). If that
 * dev server is down but the **embedded** agent is still running on a dynamic
 * port, menu Reset must not blindly POST to the dead env URL.
 */
async function resolveReachableApiBaseForMainReset(): Promise<string | null> {
  const candidates = buildMainMenuResetApiCandidates({
    embeddedPort: getAgentManager().getStatus().port,
    configuredBase: resolveInitialApiBase(process.env),
  });
  if (candidates.length === 0) {
    return null;
  }
  const base = await pickReachableMenuResetApiBase({
    candidates,
    fetchImpl: fetch,
    buildHeaders: buildApiRequestHeaders,
  });
  if (base) {
    console.info("[Main][reset] Using reachable API base", {
      base,
      tried: candidates,
    });
  } else {
    console.warn("[Main][reset] No reachable API base among candidates", {
      tried: candidates,
    });
  }
  return base;
}

/**
 * App menu "Reset the app…" — confirm + HTTP reset + restart in the **main process**.
 *
 * **WHY not renderer `fetch`:** after native `showMessageBox`, WKWebView may not run
 * network/bridge work on the same turn, so reset appeared hung. **WHY push
 * `menu-reset-app-applied`:** renderer must still run the same local wipe as
 * Settings (`completeResetLocalStateAfterServerWipe`); main only supplies a fresh
 * `/api/status` snapshot as `agentStatus`. Orchestration core: `menu-reset-from-main.ts`.
 *
 * @see `docs/apps/desktop-main-process-reset.md`
 */
async function resetTheAppFromApplicationMenu(): Promise<void> {
  console.info(
    `[Main][reset] App menu: Reset ${BRAND.appName} — confirm + POST /api/agent/reset + restart (main process)`,
  );
  await getDesktopManager()
    .showWindow()
    .catch((err: unknown) => {
      console.warn(
        "[Main][reset] showWindow failed (continuing):",
        err instanceof Error ? err.message : err,
      );
    });

  const autoConfirm =
    process.env.MILADY_DESKTOP_TEST_AUTO_CONFIRM_DIALOGS === "1" ||
    process.env.MILADY_DESKTOP_TEST_AUTO_CONFIRM_RESET === "1";
  const response = autoConfirm
    ? 0
    : await Utils.showMessageBox({
        type: "warning",
        title: "Reset Agent",
        message:
          "This will reset the agent: config, cloud keys, and local agent database (conversations / memory).",
        detail:
          "Downloaded GGUF embedding models are kept. You will return to the onboarding wizard.",
        buttons: ["Reset", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      }).then((box) =>
        box && typeof box === "object" && "response" in box
          ? (box as { response: number }).response
          : typeof box === "number"
            ? box
            : 1,
      );
  if (response !== 0) {
    console.info("[Main][reset] User cancelled native confirm");
    return;
  }

  const apiBase = await resolveReachableApiBaseForMainReset();
  if (!apiBase) {
    Utils.showNotification({
      title: "Reset Failed",
      body: `Could not reach the ${BRAND.appName} API (tried embedded port and ELIZA_DESKTOP_API_BASE / defaults). Start the agent or dev server, or fix your API base env.`,
    });
    return;
  }

  try {
    const runtimeMode = resolveDesktopRuntimeMode(
      process.env as Record<string, string | undefined>,
    );

    await runMainMenuResetAfterApiBaseResolved({
      apiBase,
      fetchImpl: fetch,
      buildHeaders: buildApiRequestHeaders,
      useEmbeddedRestart: runtimeMode.mode === "local",
      restartEmbeddedClearingLocalDb: async () => {
        const status = await getAgentManager().restartClearingLocalDb();
        return { port: status.port ?? undefined };
      },
      pushEmbeddedApiBaseToRenderer: (port, apiToken) => {
        if (currentWindow) {
          const base = port
            ? resolveRendererFacingApiBase(
                process.env as Record<string, string | undefined>,
                port,
              )
            : (resolveHeartbeatMenuApiBase() ??
              resolveInitialApiBase(
                process.env as Record<string, string | undefined>,
              ) ??
              apiBase);
          if (base) {
            pushApiBaseToRenderer(currentWindow, base, apiToken);
          }
        }
      },
      getLocalApiAuthToken: () => configureDesktopLocalApiAuth(),
      postExternalAgentRestart: async () => {
        try {
          await fetch(`${apiBase}/api/agent/restart`, {
            method: "POST",
            headers: buildApiRequestHeaders(),
          });
        } catch {
          /* 409 / race while restarting — poll below */
        }
      },
      resolveApiBaseForStatusPoll: () =>
        resolveHeartbeatMenuApiBase() ?? apiBase,
      sendMenuResetAppliedToRenderer: (payload) => {
        sendToActiveRenderer("desktopTrayMenuClick", payload);
      },
    });
    console.info(
      "[Main][reset] Pushed menu-reset-app-applied to renderer with /api/status snapshot",
    );
  } catch (err) {
    console.error("[Main][reset] Main-process reset failed:", err);
    Utils.showNotification({
      title: "Reset Failed",
      body: summarizeDesktopActionError(err, "Reset failed"),
    });
  }
}

async function fetchHeartbeatMenuSnapshot(
  apiBase: string,
): Promise<HeartbeatMenuSnapshot> {
  const headers = buildApiRequestHeaders();

  const [triggersResponse, healthResponse] = await Promise.all([
    fetch(`${apiBase}/api/triggers`, { headers }),
    fetch(`${apiBase}/api/triggers/health`, { headers }),
  ]);

  if (!triggersResponse.ok) {
    throw new Error(`Trigger list failed (${triggersResponse.status})`);
  }
  if (!healthResponse.ok) {
    throw new Error(`Trigger health failed (${healthResponse.status})`);
  }

  const triggersPayload = (await triggersResponse.json()) as {
    triggers?: HeartbeatMenuTriggerSummary[];
  };
  const healthPayload =
    (await healthResponse.json()) as HeartbeatMenuHealthResponse;

  const triggers = Array.isArray(triggersPayload.triggers)
    ? triggersPayload.triggers
    : [];
  const enabledTriggers = triggers.filter((trigger) => trigger.enabled);

  const nextRunCandidates = enabledTriggers
    .map((trigger) =>
      typeof trigger.nextRunAtMs === "number" ? trigger.nextRunAtMs : null,
    )
    .filter((value): value is number => typeof value === "number");

  const lastRunCandidates = triggers
    .map((trigger) => {
      if (!trigger.lastRunAtIso) return null;
      const parsed = Date.parse(trigger.lastRunAtIso);
      return Number.isNaN(parsed) ? null : parsed;
    })
    .filter((value): value is number => typeof value === "number");

  return {
    loading: false,
    error: null,
    totalHeartbeats: triggers.length,
    activeHeartbeats:
      typeof healthPayload.activeTriggers === "number"
        ? healthPayload.activeTriggers
        : enabledTriggers.length,
    totalExecutions:
      typeof healthPayload.totalExecutions === "number"
        ? healthPayload.totalExecutions
        : 0,
    totalFailures:
      typeof healthPayload.totalFailures === "number"
        ? healthPayload.totalFailures
        : 0,
    lastRunAtMs:
      typeof healthPayload.lastExecutionAt === "number"
        ? healthPayload.lastExecutionAt
        : lastRunCandidates.length > 0
          ? Math.max(...lastRunCandidates)
          : null,
    nextRunAtMs:
      nextRunCandidates.length > 0 ? Math.min(...nextRunCandidates) : null,
  };
}
let heartbeatRefreshInProgress = false;

async function refreshHeartbeatMenuSnapshot(): Promise<void> {
  if (heartbeatRefreshInProgress) {
    return;
  }
  heartbeatRefreshInProgress = true;

  try {
    const apiBase = resolveHeartbeatMenuApiBase();
    if (!apiBase) {
      heartbeatMenuSnapshot = {
        ...heartbeatMenuSnapshot,
        loading: false,
        error: "Agent unavailable",
      };
      setupApplicationMenu();
      return;
    }

    try {
      heartbeatMenuSnapshot = await fetchHeartbeatMenuSnapshot(apiBase);
    } catch (error) {
      heartbeatMenuSnapshot = {
        ...heartbeatMenuSnapshot,
        loading: false,
        error: summarizeHeartbeatMenuError(error),
      };
    }

    setupApplicationMenu();
  } finally {
    heartbeatRefreshInProgress = false;
  }
}

function startHeartbeatMenuRefresh(): void {
  if (heartbeatMenuRefreshTimer) return;
  void refreshHeartbeatMenuSnapshot();
  heartbeatMenuRefreshTimer = setInterval(() => {
    void refreshHeartbeatMenuSnapshot();
  }, HEARTBEAT_MENU_REFRESH_MS);
}

const MAC_TRAFFIC_LIGHTS_X = 14;
const MAC_TRAFFIC_LIGHTS_Y = 12;
/** Left inset of the drag strip so it clears the traffic lights. */
const MAC_NATIVE_DRAG_REGION_X = 92;
/**
 * Native titlebar drag height. The native layer keeps resize bands thin
 * separately and only installs drag views in safe title/empty zones so
 * titlebar buttons continue to receive clicks.
 */
const MAC_NATIVE_DRAG_REGION_HEIGHT = 38;

/**
 * Vibrancy, shadow, traffic lights, and native chrome layout. Re-calls native
 * layout whenever the window or webview subtree may have reordered so the drag
 * view stays above WKWebView.
 */
function applyMacOSWindowEffects(win: BrowserWindow): void {
  if (process.platform !== "darwin") return;

  const ptr = (win as { ptr?: unknown }).ptr;
  if (!ptr) {
    console.warn("[MacEffects] win.ptr unavailable — skipping native effects");
    return;
  }

  const vibrancyEnabled = enableVibrancy(
    ptr as Parameters<typeof enableVibrancy>[0],
  );
  const shadowEnabled = ensureShadow(ptr as Parameters<typeof ensureShadow>[0]);
  updateCurrentMainWindowEffectsState({
    vibrancyEnabled,
    shadowEnabled,
  });

  const alignButtons = () =>
    setTrafficLightsPosition(
      ptr as Parameters<typeof setTrafficLightsPosition>[0],
      MAC_TRAFFIC_LIGHTS_X,
      MAC_TRAFFIC_LIGHTS_Y,
    );
  const alignDragRegion = () =>
    setNativeDragRegion(
      ptr as Parameters<typeof setNativeDragRegion>[0],
      MAC_NATIVE_DRAG_REGION_X,
      MAC_NATIVE_DRAG_REGION_HEIGHT,
    );

  const alignChrome = () => {
    alignButtons();
    alignDragRegion();
  };

  alignChrome();
  setTimeout(alignChrome, 120);
  const chromeRefreshTimer = setInterval(alignChrome, 1000);

  win.on("resize", alignChrome);
  win.on("focus", alignChrome);
  win.on("blur", () => {
    alignChrome();
    setTimeout(alignChrome, 80);
    setTimeout(alignChrome, 240);
    setTimeout(alignChrome, 700);
  });
  // Display (NSScreen) changes without a resize edge case — depth uses window.screen.
  win.on("move", alignChrome);
  win.on("close", () => clearInterval(chromeRefreshTimer));

  // WKWebView is often inserted or reordered after first layout; restack native
  // views so drag/resize strips stay hit-testable above the page.
  try {
    win.webview.on("dom-ready", () => {
      alignChrome();
      setTimeout(alignChrome, 50);
      setTimeout(alignChrome, 300);
    });
  } catch {
    // webview may not accept listeners yet in some embed paths
  }
}

interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Fresh-install default: a generous 1440x900 window centered-ish
 * near the top-left of the primary display. Maximize-on-launch (see
 * createMainWindow) then expands this to fill the screen on every
 * boot, so this default only matters for brand-new installs on
 * systems where maximize() hasn't registered yet.
 */
const DEFAULT_WINDOW_STATE: WindowState = {
  x: 60,
  y: 60,
  width: 1440,
  height: 900,
};

/**
 * Marker value we stamp into the saved state when we'd like the next
 * launch to open maximized. Kept as a synthetic "pending-maximize" flag
 * rather than a real bool so it piggybacks on the existing
 * width/height/x/y schema without a migration.
 */
const MAXIMIZE_ON_LAUNCH_SENTINEL = 1;

interface PersistedWindowState extends WindowState {
  /** When truthy, call win.maximize() right after creation. */
  shouldMaximize?: number;
}

function loadWindowState(statePath: string): PersistedWindowState {
  try {
    if (fs.existsSync(statePath)) {
      const data = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (typeof data.width === "number" && typeof data.height === "number") {
        const state = { ...DEFAULT_WINDOW_STATE, ...data };
        // Discard state saved while the window was minimized.  On Windows,
        // minimized windows report position (-32000, -32000) and a tiny
        // size, which makes the window invisible on next launch.
        if (state.width < 200 || state.height < 200 || state.x < -16000) {
          return {
            ...DEFAULT_WINDOW_STATE,
            shouldMaximize: MAXIMIZE_ON_LAUNCH_SENTINEL,
          };
        }
        return state;
      }
    }
  } catch {}
  // No saved state → first launch. Open maximized so the user gets a
  // usable workspace immediately instead of a small window in the
  // corner they have to resize themselves.
  return {
    ...DEFAULT_WINDOW_STATE,
    shouldMaximize: MAXIMIZE_ON_LAUNCH_SENTINEL,
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleStateSave(statePath: string, win: BrowserWindow): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const { x, y } = win.getPosition();
      const { width, height } = win.getSize();
      // Skip saving when the window is minimized — Windows reports
      // position (-32000, -32000) and a collapsed size, which would make
      // the window invisible on next launch.
      if (width < 200 || height < 200 || x < -16000) return;
      const dir = path.dirname(statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify({ x, y, width, height }),
        "utf8",
      );
    } catch {}
  }, 500);
}

let currentWindow: BrowserWindow | null = null;
let currentSendToWebview: SendToWebview | null = null;
let surfaceWindowManager: SurfaceWindowManager | null = null;
let rendererUrlPromise: Promise<string> | null = null;
let backgroundWindowPromise: Promise<void> | null = null;
let isQuitting = false;

function requestAppQuit(): void {
  isQuitting = true;
  Utils.quit();
}

const cleanupFns: Array<() => void | Promise<void>> = [];
let lastFocusedWindow: ManagedWindowLike | null = null;
const macOpenedDevtoolsWindowIds = new Set<number>();

async function openBrowserDevtoolsFallback(
  targetWindow: ManagedWindowLike | BrowserWindow | null,
): Promise<void> {
  const currentUrl = (
    targetWindow?.webview as { url?: string | null } | undefined
  )?.url;
  const url = currentUrl?.trim() || (await resolveRendererUrl());

  if (!/^https?:\/\//i.test(url)) {
    Utils.showNotification({
      title: "Developer Tools Unavailable",
      body: "Native macOS Electrobun devtools are disabled, and the renderer URL is not browser-openable.",
    });
    return;
  }

  Utils.openExternal(url);
  Utils.showNotification({
    title: "Opened Renderer in Browser",
    body: "Native macOS Electrobun devtools are disabled due to a WKWebView crash/layout bug. Use browser devtools instead.",
  });
}

function sendToActiveRenderer(message: string, payload?: unknown): void {
  currentSendToWebview?.(message, payload);
  if (!currentSendToWebview) {
    const level =
      message === "desktopTrayMenuClick" ? console.warn : console.debug;
    level.call(
      console,
      "[Main] Dropped renderer message (no window):",
      message,
    );
  }
}

function sendManagedWindowsChanged(): void {
  sendToActiveRenderer("desktopManagedWindowsChanged", {
    windows: surfaceWindowManager?.listWindows() ?? [],
  });
}

function shouldRestoreWindowBeforeMenuAction(
  action: string | undefined,
): boolean {
  if (!action || action.startsWith("focus-window:")) {
    return false;
  }
  return action !== "quit";
}

/**
 * Serve the renderer dist over HTTP so WKWebView can load it without
 * file:// CORS restrictions (crossorigin ES modules break over file://).
 * Returns the base URL e.g. "http://localhost:5174".
 */
async function startRendererServer(): Promise<string> {
  const rendererDir = resolveRendererAssetDir(import.meta.dir);
  if (!fs.existsSync(rendererDir)) {
    console.warn("[Renderer] renderer dir not found:", rendererDir);
    return "";
  }

  // Find a free port starting at 5174 (5173 reserved for Vite dev)
  const getPort = (start: number): Promise<number> =>
    new Promise((resolve) => {
      const srv = createNetServer();
      srv.listen(start, "127.0.0.1", () => {
        const { port } = srv.address() as { port: number };
        srv.close(() => resolve(port));
      });
      srv.on("error", () => resolve(getPort(start + 1)));
    });

  const port = await getPort(5174);

  const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".css": "text/css",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".json": "application/json",
    ".gz": "application/octet-stream",
    ".wasm": "application/wasm",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".vrm": "model/gltf-binary",
  };

  // Determine the expected agent API base URL so we can inject it into the
  // HTML before the renderer JS runs. This prevents a 404 fatal-error loop
  // where the renderer fetches /api/auth/status relative to the static server.
  // If the agent falls back to a dynamic port, apiBaseUpdate messages will
  // update window.__ELIZA_API_BASE__ and the client will pick it up lazily.
  const initialApiBase = resolveInitialApiBase(
    process.env as Record<string, string | undefined>,
  );
  const initialApiToken =
    resolveDesktopRuntimeMode(process.env as Record<string, string | undefined>)
      .mode === "local"
      ? configureDesktopLocalApiAuth()
      : (resolveApiToken(process.env) ?? "");

  // Inject the API base into index.html so it's available before React mounts.
  function injectApiBaseIntoHtml(html: string): string {
    if (!initialApiBase) {
      return html;
    }
    const script = `<script>window.__ELIZA_API_BASE__=${JSON.stringify(initialApiBase)};${initialApiToken ? `Object.defineProperty(window,"__ELIZA_API_TOKEN__",{value:${JSON.stringify(initialApiToken)},configurable:true,writable:true,enumerable:false});` : ""}</script>`;
    // Inject before </head> if present, otherwise before <body>
    if (html.includes("</head>")) {
      return html.replace("</head>", `${script}</head>`);
    }
    if (html.includes("<body")) {
      return html.replace("<body", `${script}<body`);
    }
    return script + html;
  }

  const resolveRendererCacheControl = (
    pathname: string,
    mimeExt: string,
  ): string => {
    if (pathname.startsWith("/assets/")) {
      return "public, max-age=31536000, immutable";
    }
    if (
      mimeExt === ".vrm" ||
      pathname.endsWith(".vrm.gz") ||
      pathname.startsWith("/vrms/previews/") ||
      pathname.startsWith("/vrms/backgrounds/") ||
      [
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".avif",
        ".svg",
        ".mp3",
        ".wav",
        ".ogg",
        ".m4a",
        ".aac",
        ".flac",
        ".glb",
      ].includes(mimeExt)
    ) {
      return "public, max-age=86400";
    }
    return "public, max-age=0, must-revalidate";
  };

  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const { filePath, isGzipped, mimeExt } = resolveRendererAsset({
        rendererDir,
        urlPath: new URL(req.url).pathname,
        existsSync: fs.existsSync,
        statSync: fs.statSync,
      });

      try {
        const content = fs.readFileSync(filePath);
        // Inject API base into HTML responses
        if (mimeExt === ".html" || filePath.endsWith("index.html")) {
          const html = injectApiBaseIntoHtml(content.toString("utf8"));
          return new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=0, must-revalidate",
            },
          });
        }

        const headers: Record<string, string> = {
          "Content-Type": mimeTypes[mimeExt] ?? "application/octet-stream",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": resolveRendererCacheControl(
            new URL(req.url).pathname,
            mimeExt,
          ),
        };

        if (isGzipped) {
          headers["Content-Encoding"] = "gzip";
        }

        return new Response(content, { headers });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  });

  console.log(`[Renderer] Static server on http://127.0.0.1:${port}`);
  return `http://127.0.0.1:${port}`;
}

async function resolveRendererUrl(): Promise<string> {
  // Prefer ELIZA_RENDERER_URL / VITE_DEV_SERVER_URL when set (e.g. dev-platform.mjs watch mode).
  // Why: Vite HMR only works against the dev server; serving pre-built dist from this static
  // server would force a full rebuild for every UI change.
  let rendererUrl =
    process.env.ELIZA_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL ?? "";

  if (!rendererUrl) {
    rendererUrlPromise ??= startRendererServer();
    rendererUrl = await rendererUrlPromise;
  }

  if (!rendererUrl) {
    // Last resort: file:// (may have CORS issues with crossorigin module scripts)
    rendererUrl = `file://${path.join(resolveRendererAssetDir(import.meta.dir), "index.html")}`;
    console.warn(
      "[Main] Falling back to file:// renderer URL — CORS issues possible",
    );
  }

  return rendererUrl;
}

async function createMainWindow(): Promise<BrowserWindow> {
  const rendererUrl = await resolveRendererUrl();
  const mainWindowPartition = resolveMainWindowPartition(process.env);
  if (mainWindowPartition) {
    console.log(
      `[Main] Using isolated main window partition ${mainWindowPartition}`,
    );
  }

  const statePath = path.join(Utils.paths.userData, "window-state.json");
  const state = loadWindowState(statePath);

  let preload: string;
  try {
    preload = readResolvedPreloadScript(import.meta.dir);
  } catch (err) {
    console.error("[Main] Failed to read preload script:", err);
    preload = "// preload unavailable";
  }

  const windowFrame = {
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
  };
  const titleBarStyle =
    process.platform === "darwin" ? "hiddenInset" : "default";
  const transparent = process.platform === "darwin";
  const buildInfo = await BuildConfig.get();
  const forceMainWindowCef = shouldForceMainWindowCef(process.env);
  const canUseCefView = buildInfo.availableRenderers.includes("cef");
  const useIsolatedMainView =
    (process.platform === "win32" && mainWindowPartition) ||
    (forceMainWindowCef && canUseCefView && !!mainWindowPartition);

  if (forceMainWindowCef && !canUseCefView) {
    console.warn(
      "[Main] ELIZA_DESKTOP_FORCE_CEF=1 requested, but this Electrobun build does not bundle the CEF renderer. Falling back to the native renderer.",
    );
  }

  let win: BrowserWindow;
  if (useIsolatedMainView) {
    win = new BrowserWindow({
      title: BRAND.appName,
      // @ts-expect-error: Electrobun doesn't expose icon in JS typings yet
      icon: resolveDesktopAppIconPath(),
      url: null,
      preload: null,
      frame: windowFrame,
      renderer: resolveBootstrapShellRenderer(buildInfo),
      titleBarStyle,
      transparent,
    });
    win.webview.remove();
    const mainView = new BrowserView({
      url: rendererUrl,
      preload,
      renderer: forceMainWindowCef
        ? "cef"
        : resolveBootstrapViewRenderer(buildInfo),
      partition: mainWindowPartition,
      frame: {
        x: 0,
        y: 0,
        width: state.width,
        height: state.height,
      },
      windowId: win.id,
    });
    win.webviewId = mainView.id;
    if (forceMainWindowCef) {
      console.log(
        `[Main] Using CEF main-window workaround with persistent partition ${mainWindowPartition}`,
      );
    }
  } else {
    win = new BrowserWindow({
      title: BRAND.appName,
      // @ts-expect-error: Electrobun doesn't expose icon in JS typings yet
      icon: resolveDesktopAppIconPath(),
      url: rendererUrl,
      preload,
      frame: windowFrame,
      titleBarStyle,
      transparent,
    });
  }

  applyMacOSWindowEffects(win);
  win.on("resize", () => scheduleStateSave(statePath, win));
  win.on("move", () => scheduleStateSave(statePath, win));

  // First-launch ergonomics: when there's no saved state (or the
  // saved state was garbage and we're falling back to defaults), open
  // the window maximized so the user gets a full workspace instead of
  // a 1440x900 rectangle in the corner they have to resize by hand.
  // Subsequent launches skip this because loadWindowState returns the
  // real persisted dimensions without the shouldMaximize sentinel.
  if (state.shouldMaximize === MAXIMIZE_ON_LAUNCH_SENTINEL) {
    try {
      (win as unknown as { maximize?: () => void }).maximize?.();
    } catch (err) {
      // Non-fatal — if maximize() isn't available on this electrobun
      // build, the window still opens at the default dimensions.
      console.warn(
        `[main-window] maximize() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return win;
}

function attachMainWindow(win: BrowserWindow): BrowserWindow {
  const sendToWebview = wireRpcAndModules(win);
  currentWindow = win;
  currentSendToWebview = sendToWebview;
  setCurrentMainWindow(win, {
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    transparent: process.platform === "darwin",
  });
  trackFocusedWindow(win);

  win.webview.on("dom-ready", () => {
    injectApiBase(win);
  });

  // Prevent the main webview from navigating to external URLs.
  // The renderer is always served from localhost — any other navigation
  // (e.g. from a compromised plugin) should open in the default browser.
  win.webview.on("will-navigate", (event: unknown) => {
    const e = event as {
      url?: string;
      data?: { detail?: string };
      preventDefault?: () => void;
    };
    const url = readNavigationEventUrl(e);
    try {
      const parsed = new URL(url);
      const isAllowed =
        parsed.protocol === "file:" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.protocol === "views:";
      if (!isAllowed) {
        e.preventDefault?.();
        void import("electrobun/bun")
          .then(({ Utils }) => {
            try {
              Utils.openExternal(url);
            } catch {
              // Ignore external open failures during navigation blocking.
            }
          })
          .catch(() => {});
      }
    } catch {
      // Unparseable URL — block it.
      e.preventDefault?.();
    }
  });

  win.on("close", () => {
    if (currentWindow?.id === win.id) {
      currentWindow = null;
      currentSendToWebview = null;
    }
    clearCurrentMainWindow(win);
    getDesktopManager().clearMainWindow(win);

    if (!isQuitting) {
      void ensureBackgroundWindow();
    }
  });

  return win;
}

async function ensureBackgroundWindow(): Promise<void> {
  if (isQuitting || currentWindow) {
    return;
  }

  // Don't recreate the window — just keep the process alive in the
  // background (exitOnLastWindowClosed is false in electrobun.config.ts).
  // The dock icon click fires the "reopen" event which restores the window.
  console.log("[Main] Window closed — agent continues in background");
  showBackgroundRunNoticeOnce();
}

/** Restore or recreate the main window (called on dock icon click). */
async function restoreWindow(): Promise<void> {
  if (currentWindow) {
    try {
      currentWindow.unminimize();
      currentWindow.focus();
    } catch {
      // unminimize/focus may not be available
    }
    return;
  }
  if (backgroundWindowPromise) {
    await backgroundWindowPromise;
    return;
  }
  backgroundWindowPromise = (async () => {
    const win = attachMainWindow(await createMainWindow());
    injectApiBase(win);
    console.log("[Main] Restored window from dock click");
  })().finally(() => {
    backgroundWindowPromise = null;
  });
  await backgroundWindowPromise;
}

function showBackgroundRunNoticeOnce(): void {
  try {
    showBackgroundNoticeOnce({
      fileSystem: fs,
      userDataDir: Utils.paths.userData,
      showNotification: (options) => {
        Utils.showNotification(options);
      },
    });
  } catch (error) {
    console.warn("[Main] Failed to persist background notice marker:", error);
  }
}

async function createSettingsWindow(tabHint?: string): Promise<void> {
  if (!surfaceWindowManager) return;
  await surfaceWindowManager.openSettingsWindow(tabHint);
}

async function showMainSurface(surface: string): Promise<void> {
  if (!currentWindow) {
    await restoreWindow();
  }
  void getDesktopManager().showWindow();
  sendToActiveRenderer("desktopTrayMenuClick", {
    itemId: `show-main:${surface}`,
  });
}

function resolveDefaultDialogPath(): string {
  const downloadsPath = path.join(os.homedir(), "Downloads");
  return fs.existsSync(downloadsPath) ? downloadsPath : os.homedir();
}

async function exportConfigFromMenu(): Promise<void> {
  const apiBase = resolveHeartbeatMenuApiBase();
  if (!apiBase) {
    Utils.showNotification({
      title: "Config Export Failed",
      body: "Agent unavailable",
    });
    return;
  }

  try {
    const response = await fetch(`${apiBase}/api/config`, {
      headers: buildApiRequestHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Config fetch failed (${response.status})`);
    }

    const config = await response.json();
    const dialog = await getDesktopManager().showSaveDialog({
      defaultPath: resolveDefaultDialogPath(),
      allowedFileTypes: "json",
    });
    if (dialog.canceled || dialog.filePaths.length === 0) {
      return;
    }

    const outputPath = path.join(dialog.filePaths[0], CONFIG_EXPORT_FILE_NAME);
    fs.writeFileSync(
      outputPath,
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );

    Utils.showNotification({
      title: "Config Exported",
      body: `Saved to ${outputPath}`,
    });
  } catch (error) {
    Utils.showNotification({
      title: "Config Export Failed",
      body: summarizeDesktopActionError(error, "Config export failed"),
    });
  }
}

async function importConfigFromMenu(): Promise<void> {
  const apiBase = resolveHeartbeatMenuApiBase();
  if (!apiBase) {
    Utils.showNotification({
      title: "Config Import Failed",
      body: "Agent unavailable",
    });
    return;
  }

  try {
    const dialog = await getDesktopManager().showOpenDialog({
      defaultPath: resolveDefaultDialogPath(),
      allowedFileTypes: "json",
      canChooseFiles: true,
      canChooseDirectory: false,
      allowsMultipleSelection: false,
    });
    if (dialog.canceled || dialog.filePaths.length === 0) {
      return;
    }

    const inputPath = dialog.filePaths[0];
    const rawConfig = fs.readFileSync(inputPath, "utf8");
    const parsedConfig = JSON.parse(rawConfig) as unknown;
    if (
      typeof parsedConfig !== "object" ||
      parsedConfig === null ||
      Array.isArray(parsedConfig)
    ) {
      throw new Error("Config file must contain a JSON object");
    }

    const response = await fetch(`${apiBase}/api/config`, {
      method: "PUT",
      headers: buildApiRequestHeaders("application/json"),
      body: JSON.stringify(parsedConfig),
    });
    if (!response.ok) {
      throw new Error(`Config import failed (${response.status})`);
    }

    Utils.showNotification({
      title: "Config Imported",
      body: `Loaded ${path.basename(inputPath)}`,
    });
  } catch (error) {
    Utils.showNotification({
      title: "Config Import Failed",
      body: summarizeDesktopActionError(error, "Config import failed"),
    });
  }
}

function trackFocusedWindow(window: ManagedWindowLike): void {
  lastFocusedWindow = window;
  window.on("focus", () => {
    lastFocusedWindow = window;
    const windowId = (window as { id?: number }).id;
    if (
      process.platform === "darwin" &&
      typeof windowId === "number" &&
      macOpenedDevtoolsWindowIds.has(windowId)
    ) {
      scheduleDevtoolsLayoutRefresh(
        window as Parameters<typeof scheduleDevtoolsLayoutRefresh>[0],
      );
    }
  });
  window.on("close", () => {
    const windowId = (window as { id?: number }).id;
    if (typeof windowId === "number") {
      macOpenedDevtoolsWindowIds.delete(windowId);
    }
  });
}

function toggleFocusedWindowDevTools(): void {
  const targetWindow = lastFocusedWindow ?? currentWindow;
  const webview = targetWindow?.webview as
    | {
        toggleDevTools?: () => void;
        openDevTools?: () => void;
      }
    | undefined;

  if (shouldUseBrowserDevtoolsFallback()) {
    void openBrowserDevtoolsFallback(targetWindow);
    return;
  }

  if (typeof webview?.toggleDevTools === "function") {
    webview.toggleDevTools();
    scheduleDevtoolsLayoutRefresh(
      targetWindow as Parameters<typeof scheduleDevtoolsLayoutRefresh>[0],
    );
    return;
  }

  if (typeof webview?.openDevTools === "function") {
    webview.openDevTools();
    scheduleDevtoolsLayoutRefresh(
      targetWindow as Parameters<typeof scheduleDevtoolsLayoutRefresh>[0],
    );
    return;
  }

  Utils.showNotification({
    title: "Developer Tools Unavailable",
    body: "The focused window does not expose Electrobun devtools controls.",
  });
}

type RpcSendProxy = Record<string, ((payload: unknown) => void) | undefined>;

/**
 * Structural type for the Electrobun RPC instance.
 * The actual runtime object returned by createRPC exposes `send` and
 * `setRequestHandler`, but the base RPCWithTransport interface only has
 * `setTransport`. We use a structural type to avoid casts.
 *
 * `(params: never) => unknown` for handler values: any typed handler
 * `(p: T) => R` satisfies this via TypeScript's function contravariance
 * (`never extends T` is always true).
 */
type ElectrobunRpcInstance = {
  send?: RpcSendProxy;
  setRequestHandler?: (
    handlers: Record<string, (params: never) => unknown>,
  ) => void;
};

function wireRpcAndModules(
  win: BrowserWindow,
): (message: string, payload?: unknown) => void {
  const rpc = win.webview.rpc as ElectrobunRpcInstance | undefined;

  const sendToWebview = (message: string, payload?: unknown): void => {
    if (rpc?.send) {
      const sender = rpc?.send?.[message];
      if (sender) {
        sender(payload ?? null);
        return;
      }
    }
    console.warn(`[sendToWebview] No RPC method for message: ${message}`);
  };

  initializeNativeModules(win, sendToWebview);
  setStewardSendToWebview(sendToWebview);
  registerRpcHandlers(rpc, sendToWebview);

  return sendToWebview;
}

/**
 * Wire RPC handlers on a secondary window (e.g. settings) without calling
 * initializeNativeModules — avoids overwriting the main window reference on
 * DesktopManager and other singletons.
 */
function wireSettingsRpc(win: BrowserWindow): void {
  const rpc = win.webview.rpc as unknown as ElectrobunRpcInstance | undefined;

  const sendToWebview = (message: string, payload?: unknown): void => {
    if (rpc?.send) {
      const sender = rpc?.send?.[message];
      if (sender) {
        sender(payload ?? null);
        return;
      }
    }
    console.warn(
      `[sendToWebview:settings] No RPC method for message: ${message}`,
    );
  };

  // Register request handlers on the settings window's RPC — reuses the same
  // handler registry but does not touch native module singletons.
  registerRpcHandlers(rpc, sendToWebview);
}

function injectApiBase(win: BrowserWindow): void {
  const runtimeResolution = resolveDesktopRuntimeMode(
    process.env as Record<string, string | undefined>,
  );

  if (runtimeResolution.externalApi.invalidSources.length > 0) {
    console.warn(
      `[Main] Invalid API base env vars: ${runtimeResolution.externalApi.invalidSources.join(", ")}`,
    );
  }

  if (
    runtimeResolution.mode === "external" &&
    runtimeResolution.externalApi.base
  ) {
    pushApiBaseToRenderer(
      win,
      runtimeResolution.externalApi.base,
      resolveApiToken(process.env) ?? undefined,
    );
    setAgentReady(true);
    return;
  }

  const agent = getAgentManager();
  const port = agent.getPort() ?? resolveDesktopApiPort(process.env);
  const apiToken = configureDesktopLocalApiAuth();
  pushApiBaseToRenderer(
    win,
    resolveRendererFacingApiBase(
      process.env as Record<string, string | undefined>,
      port,
    ),
    apiToken,
  );
  setAgentReady(true);
}

/**
 * Push real OS permission states into the agent REST API so the renderer's
 * PermissionsSection shows correct statuses and capability toggles unlock.
 */
async function syncPermissionsToRestApi(
  port: number,
  startup = false,
): Promise<void> {
  try {
    const permissions = await mergeRuntimePermissionStates(
      port,
      await getPermissionManager().checkAllPermissions(),
    );
    await fetch(`http://127.0.0.1:${port}/api/permissions/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissions, startup }),
    });
  } catch (err) {
    console.warn("[Main] Permission sync failed:", err);
  }
}

// Tracks whether the desktop loopback session has already been primed for the
// current process lifetime. The bridge is idempotent on disk, but cookie jar
// writes are cheap and we don't need to repeat them on every status tick.
let desktopSessionPrimed = false;

/**
 * Best-effort: mint (or reuse) a loopback-only desktop session and install the
 * cookies into the main window's session jar so the renderer's first /api
 * request is already authenticated. Failure is silent — the renderer falls
 * back to the standard login flow.
 *
 * Loopback-only enforcement is implemented server-side: the auth-context
 * resolver MUST refuse a session marked loopback-only on a non-loopback
 * request. The bridge does not — and cannot — be that boundary.
 */
async function primeDesktopSessionAuth(
  apiBase: string,
  rendererOrigin: string,
): Promise<void> {
  if (desktopSessionPrimed) return;
  let session: DesktopSession | null;
  try {
    session = await loadOrCreateDesktopSession({ apiBase });
  } catch (err) {
    console.warn(
      "[Main] Desktop auth bridge failed:",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  if (!session) {
    console.log(
      "[Main] Desktop auth bridge produced no session; renderer will use the standard login flow.",
    );
    return;
  }

  try {
    const partition = resolveMainWindowPartition(process.env);
    const electrobunSession =
      partition !== null
        ? Session.fromPartition(partition)
        : Session.defaultSession;
    const installer = electrobunSession.cookies as {
      set: Parameters<typeof installDesktopSessionCookies>[0]["set"];
    };
    const touched = installDesktopSessionCookies(installer, session, {
      apiOrigin: apiBase,
      rendererOrigin,
    });
    desktopSessionPrimed = true;
    console.log(
      `[Main] Desktop loopback session primed on ${touched.join(", ") || "<no targets>"}`,
    );
  } catch (err) {
    console.warn(
      "[Main] Desktop auth cookie install failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function _startAgent(win: BrowserWindow): Promise<void> {
  const runtimeResolution = resolveDesktopRuntimeMode(
    process.env as Record<string, string | undefined>,
  );

  if (runtimeResolution.mode !== "local") {
    console.log(
      `[Main] Skipping embedded agent startup (${runtimeResolution.mode} mode)`,
    );
    injectApiBase(win);
    return;
  }

  const agent = getAgentManager();
  recordStartupPhase("autostart_requested", {
    pid: process.pid,
    exec_path: process.execPath,
    bundle_path: resolveStartupBundlePath(process.execPath),
  });

  try {
    const status = await agent.start();

    if (status.state === "running" && status.port) {
      const apiBase = `http://127.0.0.1:${status.port}`;
      const rendererBase = resolveRendererFacingApiBase(
        process.env as Record<string, string | undefined>,
        status.port,
      );
      // Mint or reload the loopback desktop session and install the
      // session+csrf cookies on the webview's cookie jar BEFORE we tell the
      // renderer to start hitting /api. This is the desktop trust path: if
      // the bridge succeeds, the renderer skips the login UI; if it fails,
      // the renderer behaves like a remote browser (password-required).
      await primeDesktopSessionAuth(apiBase, rendererBase);
      const apiToken = resolveApiToken(process.env) ?? undefined;
      pushApiBaseToRenderer(win, rendererBase, apiToken);
      setAgentReady(true);
      // Sync real OS permission states to the REST API so the renderer
      // can display them and capability toggles can unlock.
      // Pass startup=true so the backend skips scheduling a restart for
      // capabilities that are being auto-enabled for the first time.
      syncPermissionsToRestApi(status.port, true);
    }
  } catch (err) {
    console.error("[Main] Agent start failed:", err);
  }
}

async function setupUpdater(): Promise<void> {
  const runUpdateCheck = async (notifyOnNoUpdate = false): Promise<void> => {
    try {
      const updaterState = await getDesktopManager().getUpdaterState();
      if (!updaterState.canAutoUpdate) {
        if (updaterState.autoUpdateDisabledReason) {
          console.info(
            "[Updater] Skipping auto-update check:",
            updaterState.autoUpdateDisabledReason,
          );
          if (notifyOnNoUpdate) {
            Utils.showNotification({
              title: "Updates Unavailable",
              body: updaterState.autoUpdateDisabledReason,
            });
          }
        }
        return;
      }

      const updateResult = await Updater.checkForUpdate();
      if (updateResult?.updateAvailable) {
        Updater.downloadUpdate().catch((err: unknown) => {
          console.warn("[Updater] Download failed:", err);
        });
        return;
      }

      if (notifyOnNoUpdate) {
        Utils.showNotification({
          title: `${BRAND.appName} Up To Date`,
          body: "You already have the latest release installed.",
        });
      }
    } catch (err) {
      console.warn("[Updater] Update check failed:", err);
      if (notifyOnNoUpdate) {
        Utils.showNotification({
          title: "Update Check Failed",
          body: `${BRAND.appName} could not reach the update server.`,
        });
      }
    }
  };

  try {
    // Subscribe to update status changes so we can notify the renderer
    // at the right lifecycle points.
    Updater.onStatusChange((entry: { status: string; message?: string }) => {
      if (entry.status === "update-available") {
        // checkForUpdate found a new version — notify renderer
        const info = Updater.updateInfo();
        sendToActiveRenderer("desktopUpdateAvailable", {
          version: info.version,
        });
      } else if (entry.status === "download-complete") {
        // downloadUpdate finished — update is ready to apply
        const info = Updater.updateInfo();
        sendToActiveRenderer("desktopUpdateReady", { version: info.version });
        Utils.showNotification({
          title: `${BRAND.appName} Update Ready`,
          body: `Version ${info.version} is ready. Restart to apply.`,
        });
      }
    });

    const triggerManualUpdateCheck = () => {
      Utils.showNotification({
        title: "Checking for Updates",
        body: `${BRAND.appName} is checking for a newer release.`,
      });
      void runUpdateCheck(true);
    };

    const handleApplicationMenuAction = async (
      action: string | undefined,
    ): Promise<void> => {
      if (!currentWindow && shouldRestoreWindowBeforeMenuAction(action)) {
        await restoreWindow();
      }
      if (action === "check-for-updates") {
        triggerManualUpdateCheck();
      } else if (action === "open-about") {
        const updaterState = await getDesktopManager().getUpdaterState();
        const version = updaterState.currentVersion || "unknown";
        Utils.showNotification({
          title: `About ${BRAND.appName}`,
          body: `Version ${version} (${process.platform}/${process.arch})`,
        });
        void createSettingsWindow("updates");
      } else if (action === "export-config") {
        void exportConfigFromMenu();
      } else if (action === "import-config") {
        void importConfigFromMenu();
      } else if (action === "toggle-devtools") {
        toggleFocusedWindowDevTools();
      } else if (action === "refresh-heartbeats") {
        void refreshHeartbeatMenuSnapshot();
      } else if (action === "relaunch") {
        void getDesktopManager().relaunch();
      } else if (action === "reset-app") {
        void resetTheAppFromApplicationMenu();
      } else if (
        action === "open-settings" ||
        action?.startsWith("open-settings-")
      ) {
        void createSettingsWindow(parseSettingsWindowAction(action));
      } else if (action?.startsWith("new-window:")) {
        const surface = action.slice("new-window:".length);
        if (surfaceWindowManager && isDetachedSurface(surface)) {
          void surfaceWindowManager.openSurfaceWindow(surface);
        }
      } else if (action?.startsWith("focus-window:")) {
        const windowId = action.slice("focus-window:".length);
        surfaceWindowManager?.focusWindow(windowId);
      } else if (action?.startsWith("show-main:")) {
        const surface = action.slice("show-main:".length);
        showMainSurface(surface);
      } else if (action === "focus-main-window") {
        void getDesktopManager().focusWindow();
      } else if (action === "hide-main-window") {
        void getDesktopManager().hideWindow();
      } else if (action === "maximize-main-window") {
        void getDesktopManager().maximizeWindow();
      } else if (action === "restore-main-window") {
        void getDesktopManager().unmaximizeWindow();
      } else if (action === "desktop-notify") {
        void getDesktopManager().showNotification({
          title: `${BRAND.appName} Desktop`,
          body: `${BRAND.appName} native application menu actions are wired and responding.`,
          urgency: "normal",
        });
      } else if (action === "restart-steward") {
        if (isStewardLocalEnabled()) {
          restartSteward().catch((err: unknown) => {
            console.error("[Main] Steward restart failed:", err);
            Utils.showNotification({
              title: "Steward Restart Failed",
              body: err instanceof Error ? err.message : "Unknown error",
            });
          });
        }
      } else if (action === "reset-steward") {
        if (isStewardLocalEnabled()) {
          resetSteward().catch((err: unknown) => {
            console.error("[Main] Steward reset failed:", err);
            Utils.showNotification({
              title: "Steward Reset Failed",
              body: err instanceof Error ? err.message : "Unknown error",
            });
          });
        }
      } else if (action === "restart-agent") {
        getAgentManager()
          .restart()
          .catch((err: unknown) => {
            console.error("[Main] Agent restart failed:", err);
          });
      } else if (action === "quit") {
        void getDesktopManager().quit();
      } else if (action === "show") {
        void getDesktopManager().showWindow();
      } else if (action?.startsWith("navigate-")) {
        void getDesktopManager().showWindow();
        sendToActiveRenderer("desktopTrayMenuClick", { itemId: action });
      }
    };

    setApplicationMenuActionHandler(handleApplicationMenuAction);

    Electrobun.events.on(
      "application-menu-clicked",
      (e: { data?: { action?: string } }) => {
        void handleApplicationMenuAction(e?.data?.action);
      },
    );

    Electrobun.events.on("context-menu-clicked", (action: string) => {
      if (action === "check-for-updates") {
        triggerManualUpdateCheck();
      } else if (action === "refresh-heartbeats") {
        void refreshHeartbeatMenuSnapshot();
      } else if (action === "relaunch") {
        void getDesktopManager().relaunch();
      }
    });

    await runUpdateCheck(false);
  } catch (err) {
    console.warn("[Updater] Update check failed:", err);
  }
}

function setupDeepLinks(): void {
  Electrobun.events.on("open-url", (url: string) => {
    sendToActiveRenderer("shareTargetReceived", { url });
  });
}

function setupDockReopen(): void {
  Electrobun.events.on("reopen", () => {
    void restoreWindow();
  });
}

async function runShutdownCleanup(reason: string): Promise<void> {
  console.log(`[Main] App quitting (${reason}), disposing native modules...`);
  isQuitting = true;
  sendToActiveRenderer("desktopShutdownStarted", { reason });
  for (const cleanupFn of cleanupFns) {
    await Promise.resolve(cleanupFn());
  }
  await disposeNativeModules();
}

function setupShutdown(): void {
  Electrobun.events.on("before-quit", () => {
    void runShutdownCleanup("before-quit");
  });
}

/**
 * Load repo-root and ~/.eliza/.env into `process.env` (non-destructive) so the
 * main process can send the same `ELIZA_API_TOKEN` as `dev-server.ts` when
 * calling loopback APIs (app menu reset, export, etc.). The dev API child
 * already loads dotenv; Electrobun did not until this ran.
 *
 * Packaged desktop builds must not load these files. On machines that also
 * have a the app/Eliza dev checkout, ~/.eliza/.env can contain
 * ELIZA_DESKTOP_API_BASE and related overrides that switch the packaged app
 * into external mode and make launcher startup appear dead.
 */
async function loadTheAppEnvFilesForMain(): Promise<void> {
  const normalizedModuleDir = import.meta.dir.replaceAll("\\", "/");
  const isPackagedBuild = !normalizedModuleDir.includes("/src/");
  if (isPackagedBuild) {
    return;
  }

  try {
    const { config } = await import("dotenv");
    const repoRootGuess = path.resolve(
      normalizedModuleDir,
      "..",
      "..",
      "..",
      "..",
    );
    for (const envPath of [
      path.join(repoRootGuess, ".env"),
      path.join(os.homedir(), ".eliza", ".env"),
    ]) {
      if (fs.existsSync(envPath)) {
        config({ path: envPath, override: false });
      }
    }
  } catch {
    /* dotenv may be unavailable in minimal installs */
  }
}

function initializeBundledWebGPU(): void {
  if (!WGPU.native.available) {
    console.log(
      "[WebGPU] Native Dawn runtime not bundled for this run; renderer-side WebGPU remains available through the webview/browser path.",
    );
    return;
  }

  webgpu.install();
  console.log(`[WebGPU] Native Dawn runtime ready at ${WGPU.native.path}`);
}

/**
 * Check WebGPU availability in the webview browser and push status to renderer.
 *
 * **WHY not inline `os.release() - 9`:** that was wrong on macOS 26 (Darwin 25);
 * see `checkWebGpuSupport` / `getMacOSMajorVersion` in `webgpu-browser-support.ts`
 * and `docs/apps/electrobun-darwin-macos-webgpu-version.md`.
 *
 * On macOS 26+ with native renderer, WebGPU is expected via WKWebView.
 * On Linux/Windows with CEF, upstream Electrobun flag support is still needed.
 */
function checkWebGpuBrowserSupport(): void {
  const status = checkWebGpuSupport();
  if (status.available) {
    console.log(`[WebGPU Browser] ${status.reason}`);
  } else {
    console.warn(`[WebGPU Browser] ${status.reason}`);
    if (status.chromeBetaPath) {
      console.log(
        `[WebGPU Browser] Chrome Beta found at: ${status.chromeBetaPath}`,
      );
    } else if (status.downloadUrl) {
      console.log(
        `[WebGPU Browser] Download Chrome Beta: ${status.downloadUrl}`,
      );
    }
  }

  // Push status to renderer after a short delay to allow window creation.
  setTimeout(() => {
    sendToActiveRenderer("webgpu:browserStatus", status);
  }, 2000);
}

async function main(): Promise<void> {
  recordStartupPhase("main_start", {
    pid: process.pid,
    exec_path: process.execPath,
    bundle_path: resolveStartupBundlePath(process.execPath),
  });
  await loadTheAppEnvFilesForMain();
  console.log(`[Main] Starting ${BRAND.appName} (Electrobun)`);
  const normalizedModuleDir = import.meta.dir.replaceAll("\\", "/");
  const runtimeResolution = resolveDesktopRuntimeMode(
    process.env as Record<string, string | undefined>,
  );
  // Structured startup environment block — visible in CI logs and eliza-startup.log
  console.log(
    `[Env] platform=${process.platform} arch=${process.arch} bun=${Bun.version} ` +
      `execPath=${process.execPath} cwd=${process.cwd()} moduleDir=${import.meta.dir} ` +
      `packaged=${!normalizedModuleDir.includes("/src/")} argv=${process.argv.slice(1).join(" ")}`,
  );
  console.log(
    `[Env] desktopRuntimeMode=${runtimeResolution.mode} externalApi=${runtimeResolution.externalApi.base ?? "none"}`,
  );

  printElectrobunDevSettingsBanner(
    process.env as Record<string, string | undefined>,
  );

  await maybePromptStartupCrashReport();
  // On Windows (CEF renderer), clear stale CEF profile data when the app
  // version changes.  A leftover Partitions/default profile from a previous
  // install causes "Cannot create profile at path" errors that cascade into
  // GPU process crashes, rendering the UI unusable.  Clearing the CEF cache
  // is safe — it only contains browser session state (cookies, caches,
  // LevelDB stores) that CEF recreates on next launch.
  if (process.platform === "win32") {
    try {
      const cefDir = path.join(Utils.paths.userData, "CEF");
      const cefVersionMarker = path.join(
        cefDir,
        BRAND.cefVersionMarkerFileName,
      );
      const currentVersion =
        resolveDesktopBundleVersion(import.meta.dir) ?? "unknown";
      let previousVersion: string | null = null;
      try {
        previousVersion = fs.readFileSync(cefVersionMarker, "utf-8").trim();
      } catch {
        // No marker — first run or pre-fix install.
      }
      if (
        shouldResetWindowsCefProfile({
          currentVersion,
          previousVersion,
          cefDirExists: fs.existsSync(cefDir),
        })
      ) {
        console.log(
          `[Main] CEF version mismatch (${previousVersion ?? "none"} → ${currentVersion}), clearing stale CEF profile`,
        );
        // Remove everything except the version marker we're about to write.
        for (const entry of fs.readdirSync(cefDir)) {
          if (entry === BRAND.cefVersionMarkerFileName) continue;
          const entryPath = path.join(cefDir, entry);
          try {
            fs.rmSync(entryPath, { recursive: true, force: true });
          } catch (err) {
            console.warn(`[Main] Could not remove ${entryPath}:`, err);
          }
        }
      }
      // Write/update version marker so we don't clear again on next launch.
      if (shouldWriteWindowsCefProfileMarker(currentVersion)) {
        fs.mkdirSync(cefDir, { recursive: true });
        fs.writeFileSync(cefVersionMarker, currentVersion);
      }
    } catch (err) {
      console.warn("[Main] CEF profile cleanup failed (non-fatal):", err);
    }
  }

  initializeBundledWebGPU();
  checkWebGpuBrowserSupport();
  cleanupFns.length = 0;
  cleanupFns.push(await startBrowserWorkspaceBridgeServer());
  const stopDesktopTestBridgeServer = await startDesktopTestBridgeServer();
  if (stopDesktopTestBridgeServer) {
    cleanupFns.push(stopDesktopTestBridgeServer);
  }

  // WHY push API base on every status tick with a port: embedded startup can
  // settle on a different loopback port than env/static HTML (allocation + stdout).
  // Detached surfaces must not keep a stale __ELIZA_API_BASE__ while the main
  // window was already updated—menu reset, chat, and settings each own a webview.
  cleanupFns.push(
    getAgentManager().onStatusChange((status) => {
      if (status.port) {
        // The agent rebound to a different loopback port (or recovered from a
        // crash) — the cookies we installed during _startAgent were scoped to
        // the old origin. Re-prime so the renderer's next /api request stays
        // authenticated.
        desktopSessionPrimed = false;
        const apiBase = `http://127.0.0.1:${status.port}`;
        const rendererBase = resolveRendererFacingApiBase(
          process.env as Record<string, string | undefined>,
          status.port,
        );
        void primeDesktopSessionAuth(apiBase, rendererBase);
        if (currentWindow) {
          injectApiBase(currentWindow);
        }
        surfaceWindowManager?.forEachWindow((w) => {
          injectApiBase(w as BrowserWindow);
        });
      }
      void refreshHeartbeatMenuSnapshot();
    }),
  );

  // Create window first — on Windows (CEF) the UI message loop must be
  // running before any synchronous FFI calls like setApplicationMenu().
  // Calling setupApplicationMenu() before createMainWindow() deadlocks.
  const mainWin = attachMainWindow(await createMainWindow());
  recordStartupPhase("window_ready", {
    pid: process.pid,
  });

  // Configure the floating chat manager now that the renderer URL is resolved.
  // This must run after createMainWindow() so rendererUrlPromise is already set.
  void resolveRendererUrl().then((url) => {
    let preload = "";
    try {
      preload = readResolvedPreloadScript(import.meta.dir);
    } catch {
      /* non-fatal */
    }
    getFloatingChatManager().configure(url, preload);
  });

  surfaceWindowManager = new SurfaceWindowManager({
    createWindow: (options) =>
      new BrowserWindow(options) as unknown as ManagedWindowLike,
    resolveRendererUrl,
    readPreload: () => readResolvedPreloadScript(import.meta.dir),
    wireRpc: (window) => wireSettingsRpc(window as unknown as BrowserWindow),
    injectApiBase: (window) =>
      injectApiBase(window as unknown as BrowserWindow),
    onWindowFocused: (window) => {
      lastFocusedWindow = window;
    },
    onRegistryChanged: () => {
      sendManagedWindowsChanged();
      setupApplicationMenu();
    },
  });
  // Set up app menu after the window (and its message loop) exists.
  setupApplicationMenu();
  const stopScreenshotDevServer = startScreenshotDevServer();
  if (stopScreenshotDevServer) {
    cleanupFns.push(stopScreenshotDevServer);
  }
  startHeartbeatMenuRefresh();
  cleanupFns.push(() => {
    if (heartbeatMenuRefreshTimer) {
      clearInterval(heartbeatMenuRefreshTimer);
      heartbeatMenuRefreshTimer = null;
    }
  });

  // Wire detached window callbacks so menus and RPC can open them.
  getDesktopManager().setOpenSettingsCallback((tabHint) => {
    void createSettingsWindow(tabHint);
  });
  getDesktopManager().setRestoreMainWindowCallback(() => restoreWindow());
  getDesktopManager().setRequestQuitCallback(() => {
    requestAppQuit();
  });
  getDesktopManager().setOpenSurfaceWindowCallback(
    (surface, browse, alwaysOnTop) => {
      if (!surfaceWindowManager) {
        throw new Error("Surface window manager is not ready.");
      }
      return surfaceWindowManager.openSurfaceWindow(
        surface,
        browse,
        alwaysOnTop === true,
      );
    },
  );
  getDesktopManager().setOpenAppWindowCallback((options) => {
    if (!surfaceWindowManager) {
      throw new Error("Surface window manager is not ready.");
    }
    return surfaceWindowManager.openAppWindow(options);
  });
  getDesktopManager().setManagedWindowAlwaysOnTopCallback((id, flag) => {
    return surfaceWindowManager?.setWindowAlwaysOnTop(id, flag) ?? false;
  });

  // If launched with --hidden (e.g. auto-launch with openAsHidden), minimize immediately.
  if (process.argv.includes("--hidden")) {
    try {
      mainWin.minimize();
    } catch (err) {
      console.warn(
        "[Main] Failed to minimize window on --hidden startup:",
        err,
      );
    }
  }

  setupDeepLinks();
  setupDockReopen();

  const desktop = getDesktopManager();
  try {
    await desktop.createTray({
      icon: resolveDesktopAppIconPath(),
      tooltip: BRAND.appName,
      title: BRAND.appName,
      menu: [
        { id: "tray-open-chat", label: "Open Chat", type: "normal" },
        { id: "tray-open-plugins", label: "Open Plugins", type: "normal" },
        {
          id: "tray-open-desktop-workspace",
          label: "Open Desktop Workspace",
          type: "normal",
        },
        {
          id: "tray-open-voice-controls",
          label: "Open Voice Controls",
          type: "normal",
        },
        { id: "sep1", type: "separator" },
        {
          id: "tray-toggle-lifecycle",
          label: "Start/Stop Agent",
          type: "normal",
        },
        {
          id: "tray-restart",
          label: "Restart Agent",
          type: "normal",
        },
        {
          id: "tray-notify",
          label: "Send Test Notification",
          type: "normal",
        },
        { id: "sep2", type: "separator" },
        { id: "tray-show-window", label: "Show Window", type: "normal" },
        { id: "tray-hide-window", label: "Hide Window", type: "normal" },
        {
          id: "tray-floating-chat",
          label: "Floating Chat",
          type: "normal",
        },
        { id: "sep3", type: "separator" },
        { id: "quit", label: "Quit", type: "normal" },
      ],
    });
  } catch (err) {
    console.warn("[Main] Tray creation failed:", err);
  }

  // ── Steward sidecar startup (must happen BEFORE agent) ────────────
  // When STEWARD_LOCAL=true, start the steward sidecar first so it can
  // set STEWARD_API_URL / STEWARD_AGENT_TOKEN env vars. The the app agent's
  // steward-bridge.ts reads these on boot to discover local steward.
  if (isStewardLocalEnabled()) {
    console.log("[Main] STEWARD_LOCAL=true — starting steward sidecar...");
    cleanupFns.push(() => stopSteward());

    // Listen for steward status changes and push to renderer
    cleanupFns.push(
      onStewardStatusChange((status) => {
        sendToActiveRenderer("stewardStatusUpdate", status);
      }),
    );

    try {
      const stewardResult = await startSteward();
      if (stewardResult.state === "running") {
        console.log(
          `[Main] Steward sidecar ready on port ${stewardResult.port}, wallet: ${stewardResult.walletAddress ?? "pending"}`,
        );
      } else {
        console.warn(
          `[Main] Steward sidecar in state "${stewardResult.state}": ${stewardResult.error ?? "unknown"}`,
        );
        sendToActiveRenderer("stewardStartupFailed", {
          error: stewardResult.error ?? "Steward failed to start",
          canRetry: true,
        });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error("[Main] Steward sidecar startup failed:", error);
      sendToActiveRenderer("stewardStartupFailed", {
        error,
        canRetry: true,
      });
      // Don't block agent startup — steward is optional
    }
  }

  // Agent startup: in external mode, push the API base via injectApiBase
  // (the agent is already running externally). In local mode, start the
  // embedded agent first — injectApiBaseIntoHtml already set the initial
  // window.__ELIZA_API_BASE__ but _startAgent will push the actual port
  // once the agent reports it.
  if (currentWindow) {
    const rt = resolveDesktopRuntimeMode(
      process.env as Record<string, string | undefined>,
    );
    if (rt.mode === "external") {
      injectApiBase(currentWindow);
    } else if (rt.mode === "local") {
      console.log("[Main] Starting embedded agent (local mode).");
      _startAgent(currentWindow).catch((err) => {
        console.error("[Main] Agent auto-start failed:", err);
        const error = err instanceof Error ? err.message : String(err);
        sendToActiveRenderer("agentStartupFailed", { error });
        console.error(`title: "${BRAND.appName} startup failed"`);
      });
    }
  }

  void setupUpdater();
  cleanupFns.push(() => getAgentManager().stop());
  setupShutdown();
}

function resolveStartupCrashReportPath(): string {
  return path.join(
    path.dirname(getDiagnosticLogPath()),
    STARTUP_CRASH_REPORT_FILE,
  );
}

function resolveStartupCrashPromptMarkerPath(): string {
  return path.join(
    path.dirname(getDiagnosticLogPath()),
    STARTUP_CRASH_PROMPT_MARKER_FILE,
  );
}

function buildStartupCrashDiscordReport(options: {
  source: "startup-recovery" | "fatal-startup";
  error: string | null;
}): string {
  const diagnostics = getStartupDiagnosticsSnapshot();
  const startupLogTail = getStartupDiagnosticLogTail(8_000).trim();
  const appVersion = process.env.npm_package_version?.trim() || "unknown";
  const appRuntime = `electrobun/${Bun.version}`;
  const reportLines = [
    `${BRAND.appName} startup crash report`,
    "",
    "Share this report in Discord and ping @iono.",
    "",
    `Source: ${options.source}`,
    `Timestamp: ${new Date().toISOString()}`,
    `App Version: ${appVersion}`,
    `Runtime: ${appRuntime}`,
    `Platform: ${process.platform} ${process.arch}`,
    `State: ${diagnostics.state}`,
    `Phase: ${diagnostics.phase}`,
    `Last Error: ${options.error ?? diagnostics.lastError ?? "unknown"}`,
    `Updated At: ${diagnostics.updatedAt}`,
    `Log Path: ${diagnostics.logPath}`,
    `Status Path: ${diagnostics.statusPath}`,
    "",
    startupLogTail ? "Startup Log Tail:" : "Startup Log Tail: unavailable",
  ];

  if (startupLogTail) {
    reportLines.push("```");
    reportLines.push(startupLogTail);
    reportLines.push("```");
  }
  return `${reportLines.join("\n")}\n`;
}

function persistStartupCrashReport(options: {
  source: "startup-recovery" | "fatal-startup";
  error: string | null;
}): { report: string; reportPath: string } {
  const report = buildStartupCrashDiscordReport(options);
  const primaryReportPath = resolveStartupCrashReportPath();
  const fallbackReportPath = path.join(os.tmpdir(), STARTUP_CRASH_REPORT_FILE);
  let reportPath = primaryReportPath;
  try {
    fs.mkdirSync(path.dirname(primaryReportPath), { recursive: true });
    fs.writeFileSync(primaryReportPath, report, "utf8");
  } catch (err) {
    console.warn("[Main] Failed to write startup crash report:", err);
    try {
      fs.mkdirSync(path.dirname(fallbackReportPath), { recursive: true });
      fs.writeFileSync(fallbackReportPath, report, "utf8");
      reportPath = fallbackReportPath;
    } catch (fallbackErr) {
      console.warn(
        "[Main] Failed to write fallback startup crash report:",
        fallbackErr,
      );
    }
  }
  return { report, reportPath };
}

function wasStartupCrashAlreadyPrompted(updatedAt: string): boolean {
  try {
    const markerPath = resolveStartupCrashPromptMarkerPath();
    return fs.readFileSync(markerPath, "utf8").trim() === updatedAt;
  } catch {
    return false;
  }
}

function markStartupCrashPrompted(updatedAt: string): void {
  try {
    fs.writeFileSync(resolveStartupCrashPromptMarkerPath(), updatedAt, "utf8");
  } catch {}
}

async function maybePromptStartupCrashReport(): Promise<void> {
  const diagnostics = getStartupDiagnosticsSnapshot();
  const looksLikeStartupFailure =
    diagnostics.state === "error" &&
    diagnostics.phase !== "ready" &&
    diagnostics.phase !== "stopped";
  if (!looksLikeStartupFailure) {
    return;
  }
  if (wasStartupCrashAlreadyPrompted(diagnostics.updatedAt)) {
    return;
  }

  const { report, reportPath } = persistStartupCrashReport({
    source: "startup-recovery",
    error: diagnostics.lastError,
  });
  markStartupCrashPrompted(diagnostics.updatedAt);

  const dialog = await Utils.showMessageBox({
    type: "warning",
    title: `${BRAND.appName} recovered after a startup failure`,
    message:
      "The previous launch failed. A crash report is ready to share with support.",
    detail:
      "Choose Copy Report, paste into Discord, and ping @iono. You can also open logs.",
    buttons: ["Copy Report", "Open Logs Folder", "Continue"],
    defaultId: 0,
    cancelId: 2,
  });
  const response =
    dialog && typeof dialog === "object" && "response" in dialog
      ? (dialog as { response: number }).response
      : typeof dialog === "number"
        ? dialog
        : 2;

  if (response === 0) {
    try {
      Utils.clipboardWriteText(report);
      Utils.showNotification({
        title: "Crash report copied",
        body: "Paste in Discord and ping @iono.",
      });
    } catch (err) {
      console.warn("[Main] Failed to copy startup crash report:", err);
    }
  } else if (response === 1) {
    try {
      Utils.openPath(path.dirname(reportPath));
    } catch (err) {
      console.warn("[Main] Failed to open startup logs folder:", err);
    }
  }
}

main().catch((err) => {
  const msg = `[Main] Fatal error during startup: ${err?.stack ?? err}`;
  console.error(msg);
  recordStartupPhase("fatal", {
    pid: process.pid,
    exec_path: process.execPath,
    bundle_path: resolveStartupBundlePath(process.execPath),
    error: err instanceof Error ? err.stack || err.message : String(err),
  });
  persistStartupCrashReport({
    source: "fatal-startup",
    error: msg,
  });
  recordStartupPhase("fatal", {
    pid: process.pid,
    exec_path: process.execPath,
    bundle_path: resolveStartupBundlePath(process.execPath),
    error: err instanceof Error ? err.stack || err.message : String(err),
  });
  // Write to startup log so it's visible even without a console
  try {
    const logPath = getDiagnosticLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
    fs.writeFileSync(
      getStartupStatusPath(),
      `${JSON.stringify(
        {
          state: "error",
          phase: "fatal_startup",
          updatedAt: new Date().toISOString(),
          lastError: msg,
          platform: process.platform,
          arch: process.arch,
          logPath,
          statusPath: getStartupStatusPath(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch {}
  void runShutdownCleanup("fatal-startup").finally(() => {
    process.exit(1);
  });
});
