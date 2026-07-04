/** Implements Electrobun desktop index ts behavior for app-core shell integration. */
import fs from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  formatError,
  resolveApiToken,
  resolveDesktopApiPort,
} from "@elizaos/shared";
import type { BrowserWindow } from "electrobun/bun";
import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BuildConfig,
  Screen,
  Updater,
  Utils,
  WGPU,
  webgpu,
} from "electrobun/bun";
import {
  resolveDesktopRuntimeModeWithDeployment,
  resolveInitialApiBase,
  resolveRendererFacingApiBase,
} from "./api-base";
import {
  buildApplicationMenu,
  findAppMenuEntryBySlug,
  findViewMenuEntryById,
  parseSettingsWindowAction,
  parseViewWindowAction,
} from "./application-menu";
import { setApplicationMenuActionHandler } from "./application-menu-action-registry";
import { showBackgroundNoticeOnce } from "./background-notice";
import { getBrandConfig } from "./brand-config";
import { startBrowserWorkspaceBridgeServer } from "./browser-workspace-bridge-server";
import { readNavigationEventUrl } from "./cloud-auth-window";
import {
  appendChatOverlayShellModeParam,
  computeBottomBarFrame,
  resolveDesktopShellWindowPresentation,
} from "./desktop-bottom-bar-config";
import {
  classifyDeepLinkRoute,
  readOpenUrlEventUrl,
} from "./desktop-deep-link-events";
import { startDesktopTestBridgeServer } from "./desktop-test-bridge-server";
import {
  shouldCreateDesktopTray,
  shouldEnableTrayPopover,
  shouldStartTrayFirst,
} from "./desktop-tray-config";
import { scheduleDevtoolsLayoutRefresh } from "./devtools-layout";
import { createElectrobunBrowserWindow } from "./electrobun-window-options";
import { seedFirstPartyRemotePluginsForStartup } from "./first-party-remotes";
import {
  appendKioskShellModeParam,
  appendShellModeParam,
  isKioskShellMode,
  readRendererShellMode,
} from "./kiosk-mode";
import { publishAgentApiBase } from "./lifecycle/agent-ready-publish";
import * as apiBaseOwner from "./lifecycle/api-base-owner";
import {
  markDesktopSessionStale,
  primeDesktopSessionAuth,
} from "./lifecycle/desktop-session-prime";
import { logger } from "./logger";
import {
  resolveBootstrapShellRenderer,
  resolveBootstrapViewRenderer,
  resolveMainWindowPartition,
  shouldForceMainWindowCef,
  shouldUseIsolatedMainView,
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
  getHealthPollTimeoutMs,
  getStartupDiagnosticLogTail,
  getStartupDiagnosticsSnapshot,
  getStartupStatusPath,
} from "./native/agent";
import { getDesktopManager } from "./native/desktop";
import { disposeNativeModules, initializeNativeModules } from "./native/index";
import {
  enableBackForwardNavigationGestures,
  ensureShadow,
  setNativeDragRegion,
  setTrafficLightsPosition,
} from "./native/mac-window-effects";
import { getPermissionManager } from "./native/permissions";
import { getRemotePluginHost } from "./native/remote-plugin-host";
import { checkWebGpuSupport } from "./native/webgpu-browser-support";
import { getPersistedDeployment } from "./persisted-deployment";
import { printElectrobunDevSettingsBanner } from "./print-electrobun-dev-settings-banner";
import {
  createRendererApiProxyRequestInit,
  isRendererApiProxyPath,
  resolveRendererProxyIdleTimeoutSeconds,
  shouldProxyToApiBase,
} from "./renderer-api-proxy";
import {
  getRendererAssetContentType,
  resolveRendererAsset,
  resolveRendererAssetByteRange,
} from "./renderer-static";
import {
  buildBunRpcHandlers,
  wireBrowserWorkspaceCaller,
} from "./rpc-handlers";
import type { ElizaDesktopRPCSchema } from "./rpc-schema";
import {
  readResolvedPreloadScript,
  resolveRendererAssetDir,
} from "./runtime-layout";
import { mergeRuntimePermissionStates } from "./runtime-permissions";
import { startScreenCaptureBridgeServer } from "./screen-capture-bridge-server";
import { startScreenshotDevServer } from "./screenshot-dev-server";
import { recordStartupPhase, resolveStartupBundlePath } from "./startup-trace";
import {
  type BoundsStore,
  isDetachedSurface,
  type ManagedWindowFrame,
  type ManagedWindowLike,
  SurfaceWindowManager,
} from "./surface-windows";
import type { SendToWebview } from "./types.js";
import {
  resolveDesktopBundleVersion,
  shouldResetWindowsCefProfile,
  shouldWriteWindowsCefProfileMarker,
} from "./windows-cef-profile";

const BRAND = getBrandConfig();
const CONFIG_EXPORT_FILE_NAME = BRAND.configExportFileName;
const STARTUP_CRASH_REPORT_FILE = "startup-crash-report-latest.md";
const STARTUP_CRASH_PROMPT_MARKER_FILE = "startup-crash-last-prompted.txt";

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
    detachedWindows: surfaceWindowManager?.listWindows() ?? [],
    agentReady: isAgentReady(),
  });
  ApplicationMenu.setApplicationMenu(
    menu as Parameters<typeof ApplicationMenu.setApplicationMenu>[0],
  );
}

onAgentReadyChange(() => setupApplicationMenu());

/**
 * Resolve the desktop runtime mode, consulting both the env vars and the
 * persisted deployment target (`eliza.json` `deploymentTarget.runtime`). A
 * topology-3 (cloud-hosted) agent target with a renderer-ready cloud agent
 * base resolves to `external` so the embedded agent is skipped; topology 1
 * (local agent → cloud inference) and topology 2 (all-local) keep `local`.
 */
function resolveDesktopRuntime(): ReturnType<
  typeof resolveDesktopRuntimeModeWithDeployment
> {
  return resolveDesktopRuntimeModeWithDeployment(
    process.env as Record<string, string | undefined>,
    getPersistedDeployment(),
  );
}

function summarizeDesktopActionError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  const trimmed = message.trim();
  if (!trimmed) return fallback;
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
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
    const rt = resolveDesktopRuntime();
    if (rt.mode === "local") {
      apiToken = configureDesktopLocalApiAuth().trim();
    }
  }
  if (apiToken) {
    headers.Authorization = `Bearer ${apiToken}`;
  }
  return headers;
}

function resolveLoopbackApiBase(): string | null {
  const port = getAgentManager().getStatus().port;
  if (typeof port === "number" && port > 0) {
    return `http://127.0.0.1:${port}`;
  }
  return resolveInitialApiBase(process.env);
}

/**
 * Picks a loopback API base the main process can actually reach.
 *
 * **WHY:** `resolveLoopbackApiBase()` falls back to `resolveInitialApiBase`,
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
    logger.info(
      `[Main][reset] Using reachable API base ${base} (tried: ${candidates.join(", ")})`,
    );
  } else {
    logger.warn(
      `[Main][reset] No reachable API base among candidates (tried: ${candidates.join(", ")})`,
    );
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
  logger.info(
    `[Main][reset] App menu: Reset ${BRAND.appName} — confirm + POST /api/agent/reset + restart (main process)`,
  );
  await getDesktopManager()
    .showWindow()
    .catch((err: unknown) => {
      logger.warn(
        `[Main][reset] showWindow failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    });

  const autoConfirm =
    process.env.ELIZA_DESKTOP_TEST_AUTO_CONFIRM_DIALOGS === "1" ||
    process.env.ELIZA_DESKTOP_TEST_AUTO_CONFIRM_RESET === "1";
  const response = autoConfirm
    ? 0
    : await Utils.showMessageBox({
        type: "warning",
        title: "Reset Agent",
        message:
          "This will reset the agent: config, cloud keys, and local agent database (conversations / memory).",
        detail:
          "Downloaded GGUF embedding models are kept. You will return to first-run runtime setup.",
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
    logger.info("[Main][reset] User cancelled native confirm");
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
    const runtimeMode = resolveDesktopRuntime();

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
            : (resolveLoopbackApiBase() ??
              resolveInitialApiBase(
                process.env as Record<string, string | undefined>,
              ) ??
              apiBase);
          if (base) {
            apiBaseOwner.notifyChange(currentWindow, base, apiToken);
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
      resolveApiBaseForStatusPoll: () => resolveLoopbackApiBase() ?? apiBase,
      sendMenuResetAppliedToRenderer: (payload) => {
        sendToActiveRenderer("desktopTrayMenuClick", payload);
      },
    });
    logger.info(
      "[Main][reset] Pushed menu-reset-app-applied to renderer with /api/status snapshot",
    );
  } catch (err) {
    logger.error(
      `[Main][reset] Main-process reset failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    Utils.showNotification({
      title: "Reset Failed",
      body: summarizeDesktopActionError(err, "Reset failed"),
    });
  }
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
 * Shadow, traffic lights, drag region, and native chrome layout. Re-calls
 * native layout whenever the window or webview subtree may have reordered so
 * the drag view stays above WKWebView.
 *
 * Deliberately applies NO vibrancy (#12184): a vibrancy NSVisualEffectView
 * behind a transparent window renders as a full-window frosted-glass sheet over
 * the desktop. Only the chromeless pill and the tray popover are transparent,
 * and each paints its own surface — the dashboard is a normal opaque window.
 */
function applyMacOSWindowEffects(win: BrowserWindow): void {
  if (process.platform !== "darwin") return;

  const ptr = (win as { ptr?: unknown }).ptr;
  if (!ptr) {
    logger.warn("[MacEffects] win.ptr unavailable — skipping native effects");
    return;
  }

  const shadowEnabled = ensureShadow(ptr as Parameters<typeof ensureShadow>[0]);
  updateCurrentMainWindowEffectsState({
    vibrancyEnabled: false,
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
  // WKWebView defaults allowsBackForwardNavigationGestures to NO and
  // Electrobun never sets it, so the macOS two-finger swipe-back gesture is
  // dead without this. The webview is often inserted after the first pass, so
  // the call rides the same restack cadence as the drag region (idempotent).
  const enableSwipeBackGesture = () =>
    enableBackForwardNavigationGestures(
      ptr as Parameters<typeof enableBackForwardNavigationGestures>[0],
    );

  const alignChrome = () => {
    alignButtons();
    alignDragRegion();
    enableSwipeBackGesture();
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
  } catch (err) {
    // The existsSync guard above means we only reach here when the file exists
    // but is unreadable or corrupt JSON — worth surfacing before we discard it.
    // error-policy:J4 corrupt/unreadable window-state → default bounds (degrade)
    logger.warn(`[Main][window-state] load failed for ${statePath}`, err);
  }
  // No saved state → first launch. Open at the default 1440×900 window
  // size (centered-ish near top-left) instead of maximizing. Maximizing on
  // first launch buries the welcome content in a vast empty workspace and
  // gives a "this is overwhelming" impression. The user can always
  // maximize themselves; subsequent launches restore their last size.
  return { ...DEFAULT_WINDOW_STATE };
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
    } catch (err) {
      // error-policy:J6 best-effort window-bounds persistence; a failed write
      // only costs default bounds next launch, but surface it so a broken
      // state dir is not perpetually silent.
      logger.warn(`[Main][window-state] save failed for ${statePath}`, err);
    }
  }, 500);
}

/**
 * Per-slug app-window bounds persistence. Survives across launches so an
 * app re-opened later restores to the user's last position+size.
 *
 * **WHY a separate file from `window-state.json`**: the main window is
 * singleton (one record); app windows are slug-keyed (one record per app).
 * Mixing them would couple unrelated lifecycles.
 */
function createAppWindowBoundsStore(): BoundsStore {
  const storePath = path.join(Utils.paths.userData, "app-window-bounds.json");
  type Blob = Record<string, ManagedWindowFrame>;
  let cache: Blob | null = null;

  function isFrame(value: unknown): value is ManagedWindowFrame {
    if (!value || typeof value !== "object") return false;
    const f = value as Record<string, unknown>;
    return (
      typeof f.x === "number" &&
      typeof f.y === "number" &&
      typeof f.width === "number" &&
      typeof f.height === "number" &&
      f.width >= 200 &&
      f.height >= 200 &&
      f.x > -16000 &&
      f.y > -16000
    );
  }

  function readCache(): Blob {
    if (cache) return cache;
    try {
      if (fs.existsSync(storePath)) {
        const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as unknown;
        if (raw && typeof raw === "object") {
          const next: Blob = {};
          for (const [slug, frame] of Object.entries(raw)) {
            if (isFrame(frame)) next[slug] = frame;
          }
          cache = next;
          return next;
        }
      }
    } catch {
      /* ignore — corrupt or missing file just yields empty cache */
    }
    cache = {};
    return cache;
  }

  function writeCache(): void {
    if (!cache) return;
    try {
      const dir = path.dirname(storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify(cache), "utf8");
    } catch {
      /* ignore — bounds save must never break the window */
    }
  }

  return {
    load: (slug) => {
      const blob = readCache();
      return blob[slug] ?? null;
    },
    save: (slug, frame) => {
      if (!isFrame(frame)) return;
      const blob = readCache();
      blob[slug] = frame;
      writeCache();
    },
  };
}

let currentWindow: BrowserWindow | null = null;
let currentSendToWebview: SendToWebview | null = null;
let surfaceWindowManager: SurfaceWindowManager | null = null;
let rendererUrlPromise: Promise<string> | null = null;
let backgroundWindowPromise: Promise<void> | null = null;
let isQuitting = false;
let quitRequestPromise: Promise<void> | null = null;

function requestAppQuit(): Promise<void> {
  if (quitRequestPromise) {
    return quitRequestPromise;
  }

  isQuitting = true;
  quitRequestPromise = (async () => {
    await runShutdownCleanup("explicit-quit").catch((err) => {
      logger.warn(
        `[Main] Shutdown cleanup failed before explicit quit: ${formatError(err)}`,
      );
    });
    Utils.quit();
  })();
  return quitRequestPromise;
}

/**
 * True for packaged desktop builds, false for the in-repo dev runtime.
 * The compiled bundle no longer runs out of a `/src/` directory, so its
 * absence is the dev/prod signal already used by loadTheAppEnvFilesForMain.
 * Normalize Windows separators first so dev paths containing `\src\` are not
 * misclassified as packaged (which would make dev builds fatal on Windows).
 */
function isPackagedDesktopBuild(): boolean {
  return !import.meta.dir.replaceAll("\\", "/").includes("/src/");
}

const cleanupFns: Array<() => void | Promise<void>> = [];
let shutdownCleanupPromise: Promise<void> | null = null;
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
    logger.warn("[Renderer] renderer dir not found:", rendererDir);
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

  // Seed the api-base-owner singleton with the initial value so the
  // HTML-inject path and the RPC push path both read the same source of
  // truth. Without this seeding, the static server would inject one value
  // into HTML before the renderer mounts and the RPC bridge would push a
  // different value moments later — the renderer racing two answers is
  // what produced the port-shift disconnect documented in MASTER.md §0.
  const initialRuntime = resolveDesktopRuntime();
  // External mode (env-forced OR a cloud-hosted deployment target) seeds the
  // resolved external base directly; local mode keeps the loopback agent port.
  const initialApiBase =
    initialRuntime.mode === "external" && initialRuntime.externalApi.base
      ? initialRuntime.externalApi.base
      : resolveInitialApiBase(
          process.env as Record<string, string | undefined>,
        );
  const initialApiToken =
    initialRuntime.mode === "local"
      ? configureDesktopLocalApiAuth()
      : (resolveApiToken(process.env) ?? "");
  apiBaseOwner.setCurrent(initialApiBase, initialApiToken);

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
        ".mp4",
        ".webm",
        ".glb",
        ".gltf",
        ".vrm",
        ".woff",
        ".woff2",
        ".ttf",
        ".otf",
      ].includes(mimeExt)
    ) {
      return "public, max-age=86400";
    }
    return "public, max-age=0, must-revalidate";
  };

  const rendererProxyIdleTimeoutSeconds =
    resolveRendererProxyIdleTimeoutSeconds(process.env);

  Bun.serve({
    port,
    hostname: "127.0.0.1",
    // The renderer fetches long-lived chat/SSE endpoints through this
    // same-origin proxy. Bun's default 10s idle timeout cuts those streams
    // while local inference is still pre-filling; keep it aligned with the
    // API server's long request budget, capped to Bun.serve's accepted range.
    idleTimeout: rendererProxyIdleTimeoutSeconds,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // Proxy /api/*, /ws, /music-player to the agent port. Mirrors the Vite
      // dev-server proxy in apps/app/vite.config.ts so the renderer can rely
      // on same-origin /api fetches whether it's loaded via Vite (watch mode)
      // or this static server (non-watch dev:desktop). Without this, every
      // /api/* call returned SPA HTML and Settings sat on "Loading…" forever.
      const apiBase = apiBaseOwner.getCurrent().base ?? initialApiBase;
      if (shouldProxyToApiBase(apiBase) && isRendererApiProxyPath(pathname)) {
        const target = new URL(pathname + url.search, apiBase);
        try {
          const upstreamRequest = createRendererApiProxyRequestInit(
            req,
            target,
          );
          const upstream = await fetch(target, upstreamRequest);
          return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: upstream.headers,
          });
        } catch (err) {
          return new Response(
            JSON.stringify({
              error: "API server unavailable",
              detail: err instanceof Error ? err.message : String(err),
            }),
            {
              status: 502,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }

      const { filePath, isGzipped, mimeExt } = resolveRendererAsset({
        rendererDir,
        urlPath: pathname,
        existsSync: fs.existsSync,
        statSync: fs.statSync,
      });

      try {
        const content = fs.readFileSync(filePath);
        // Inject API base into HTML responses
        if (mimeExt === ".html" || filePath.endsWith("index.html")) {
          const html = apiBaseOwner.injectIntoHtml(content.toString("utf8"));
          return new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=0, must-revalidate",
            },
          });
        }

        const headers: Record<string, string> = {
          "Content-Type": getRendererAssetContentType(mimeExt),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": resolveRendererCacheControl(pathname, mimeExt),
          "Accept-Ranges": "bytes",
          "Content-Length": String(content.byteLength),
        };

        if (isGzipped) {
          headers["Content-Encoding"] = "gzip";
        }

        const byteRange = isGzipped
          ? null
          : resolveRendererAssetByteRange(
              req.headers.get("range"),
              content.byteLength,
            );
        if (byteRange) {
          const body = content.subarray(byteRange.start, byteRange.end + 1);
          headers["Content-Length"] = String(body.byteLength);
          headers["Content-Range"] =
            `bytes ${byteRange.start}-${byteRange.end}/${content.byteLength}`;
          return new Response(body, {
            status: 206,
            headers,
          });
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
    // Last resort: file:// (may have CORS issues with crossorigin module scripts).
    // pathToFileURL builds a valid file:///C:/… URL on Windows; `file://${winPath}`
    // would be malformed (backslashes, drive letter parsed as host) and not load.
    rendererUrl = pathToFileURL(
      path.join(resolveRendererAssetDir(import.meta.dir), "index.html"),
    ).href;
    logger.warn(
      "[Main] Falling back to file:// renderer URL — CORS issues possible",
    );
  }

  return rendererUrl;
}

function appendApiBaseParam(rendererUrl: string, apiBase: string): string {
  try {
    const url = new URL(rendererUrl);
    if (!url.searchParams.has("apiBase")) {
      url.searchParams.set("apiBase", apiBase);
    }
    return url.toString();
  } catch {
    return rendererUrl;
  }
}

async function resolveRendererUrlForCurrentRuntime(): Promise<string> {
  const rendererUrl = await resolveRendererUrl();
  const runtime = resolveDesktopRuntime();
  if (runtime.mode === "external" && runtime.externalApi.base) {
    return appendApiBaseParam(rendererUrl, runtime.externalApi.base);
  }
  return rendererUrl;
}

/**
 * Resolve the chromeless bottom-bar window frame from the primary display's
 * usable work area. Falls back to a 1080p estimate if the Screen API is
 * unavailable (the user-visible bar still opens; only the width estimate is off).
 */
function resolveBottomBarFrame(): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  let workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  try {
    const display = Screen.getPrimaryDisplay();
    if (display?.workArea) {
      workArea = display.workArea;
    }
  } catch (err) {
    logger.warn(
      `[main-window] bottom-bar Screen.getPrimaryDisplay() failed; using default geometry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return computeBottomBarFrame(workArea);
}

async function createMainWindow(rpc: ElizaDesktopRpc): Promise<BrowserWindow> {
  const presentation = resolveDesktopShellWindowPresentation();
  const kiosk = presentation.mode === "kiosk";
  // Chromeless bottom-bar shell (#9953): a frameless, transparent, always-on-top
  // bar pinned to the screen bottom that renders the chat-overlay shell only.
  // Opt-in and mutually exclusive with kiosk.
  const bottomBar = presentation.mode === "bottom-bar";
  const baseRendererUrl = await resolveRendererUrlForCurrentRuntime();
  const requestedShellMode = readRendererShellMode();
  const rendererUrl = kiosk
    ? appendKioskShellModeParam(baseRendererUrl)
    : bottomBar
      ? appendChatOverlayShellModeParam(baseRendererUrl)
      : requestedShellMode && requestedShellMode !== "full"
        ? appendShellModeParam(baseRendererUrl, requestedShellMode)
        : baseRendererUrl;
  const buildInfo = await BuildConfig.get();
  const mainWindowPartition = resolveMainWindowPartition(process.env, {
    platform: process.platform,
    buildInfo,
  });
  if (mainWindowPartition) {
    logger.info(`[Main] Using main window partition ${mainWindowPartition}`);
  }

  const statePath = path.join(Utils.paths.userData, "window-state.json");
  const state = loadWindowState(statePath);

  let preload: string;
  try {
    preload = readResolvedPreloadScript(import.meta.dir);
  } catch (err) {
    // A missing/stale/empty preload means the main window has no API bridge —
    // the renderer boots into a white screen. In packaged builds that is a
    // fatal misbuild, so surface it (the error already names `build:preload`)
    // instead of silently shipping a broken window. Keep the soft fallback in
    // the dev runtime so an unbuilt preload doesn't block iterating on the UI.
    if (isPackagedDesktopBuild()) {
      throw err;
    }
    logger.error(
      `[Main] Failed to read preload script (dev fallback): ${err instanceof Error ? err.message : String(err)}`,
    );
    preload = "// preload unavailable";
  }

  const windowFrame = bottomBar
    ? resolveBottomBarFrame()
    : {
        width: state.width,
        height: state.height,
        x: state.x,
        y: state.y,
      };
  const titleBarStyle = presentation.titleBarStyle;
  // Only the chromeless bottom bar is transparent (macOS), so the desktop shows
  // through the empty region above the pill. The full dashboard stays opaque —
  // transparency there reads as a frosted-glass sheet (#12184). Win/Linux
  // transparency support varies, so the bar stays opaque there for now.
  const transparent = presentation.transparent;
  // The pill spans the full work-area width but only the small bar is visible;
  // OS-level click-through (passthrough) lets clicks on the transparent region
  // land on the app underneath instead of being eaten by the invisible window.
  const passthrough = bottomBar;
  const forceMainWindowCef = shouldForceMainWindowCef(
    process.env,
    process.platform,
  );
  const canUseCefView = buildInfo.availableRenderers.includes("cef");
  const useIsolatedMainView = shouldUseIsolatedMainView({
    platform: process.platform,
    mainWindowPartition,
    forceMainWindowCef,
    buildInfo,
  });

  if (forceMainWindowCef && !canUseCefView) {
    logger.warn(
      "[Main] ELIZA_DESKTOP_FORCE_CEF=1 requested, but this Electrobun build does not bundle the CEF renderer. Falling back to the native renderer.",
    );
  }

  let win: BrowserWindow;
  if (useIsolatedMainView) {
    // Shell window with the empty default webview. The actual content
    // (and therefore the RPC channel) is hosted on the separate mainView
    // BrowserView constructed below — that's what we attach `rpc` to.
    win = createElectrobunBrowserWindow({
      title: BRAND.appName,
      icon: resolveDesktopAppIconPath(),
      url: null,
      preload: null,
      frame: windowFrame,
      renderer: resolveBootstrapShellRenderer(buildInfo),
      titleBarStyle,
      transparent,
      passthrough,
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
        width: windowFrame.width,
        height: windowFrame.height,
      },
      windowId: win.id,
      rpc,
      // Mirror the window's click-through onto the hosted view so the isolated
      // (CEF) main-view path passes clicks through its transparent region too.
      startPassthrough: passthrough,
    });
    win.webviewId = mainView.id;
    if (forceMainWindowCef) {
      logger.info(
        `[Main] Using CEF main-window workaround with persistent partition ${mainWindowPartition}`,
      );
    }
  } else {
    win = createElectrobunBrowserWindow({
      title: BRAND.appName,
      icon: resolveDesktopAppIconPath(),
      url: rendererUrl,
      preload,
      frame: windowFrame,
      titleBarStyle,
      transparent,
      passthrough,
      rpc,
      ...(mainWindowPartition ? { partition: mainWindowPartition } : {}),
    });
  }

  // Kiosk mode: the app IS the GUI. Go fullscreen and skip the bounds
  // persistence + maximize ergonomics — the window is fixed fullscreen and
  // must never restore to a smaller frame.
  if (kiosk) {
    try {
      win.setFullScreen(true);
    } catch (err) {
      logger.warn(
        `[main-window] kiosk setFullScreen() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return win;
  }

  // Bottom-bar shell: pin always-on-top and apply the macOS chrome (shadow,
  // drag region — no vibrancy, so the pill is the only painted surface). The bar
  // has fixed, display-derived geometry, so skip bounds persistence + the
  // first-launch maximize entirely.
  if (bottomBar) {
    try {
      (
        win as typeof win & { setAlwaysOnTop?: (flag: boolean) => void }
      ).setAlwaysOnTop?.(true);
    } catch (err) {
      logger.warn(
        `[main-window] bottom-bar setAlwaysOnTop() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Join the pill to every Space/desktop (macOS) so it follows the user
    // across Space switches instead of stranding on the Space it was created
    // on. No-op on Windows/Linux (the pill is per-desktop there — fork gap G4).
    if (process.platform === "darwin") {
      try {
        (
          win as typeof win & {
            setVisibleOnAllWorkspaces?: (flag: boolean) => void;
          }
        ).setVisibleOnAllWorkspaces?.(true);
      } catch (err) {
        logger.warn(
          `[main-window] bottom-bar setVisibleOnAllWorkspaces() failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    applyMacOSWindowEffects(win);
    // Keep the bar pinned to the primary display's bottom edge across display
    // plug/unplug + resolution changes (recompute on showWindow() + 5s poll).
    getDesktopManager().enableBottomBarReanchor();
    return win;
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
      (win as typeof win & { maximize?: () => void }).maximize?.();
    } catch (err) {
      // Non-fatal — if maximize() isn't available on this electrobun
      // build, the window still opens at the default dimensions.
      logger.warn(
        `[main-window] maximize() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return win;
}

function attachMainWindow(
  win: BrowserWindow,
  rpc: ElizaDesktopRpc,
  sendToWebview: SendToWebview,
): BrowserWindow {
  wireMainWindowAfterCreate(win, rpc, sendToWebview);
  currentWindow = win;
  currentSendToWebview = sendToWebview;
  const presentation = resolveDesktopShellWindowPresentation();
  setCurrentMainWindow(win, {
    titleBarStyle: presentation.titleBarStyle,
    transparent: presentation.transparent,
  });
  trackFocusedWindow(win);
  // Dockless mode: only a FULL main window (dashboard/kiosk) reveals the Dock
  // icon — the chromeless bottom-bar pill never does. Declare which this is,
  // regardless of how it was opened (boot, tray "Show Window", Dock reopen, or
  // a direct restoreWindow() from a deep link that bypasses showWindow()).
  getDesktopManager().setMainWindowFullWindow(
    presentation.mode !== "bottom-bar",
  );

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
              // error-policy:J6 best-effort hand-off of a blocked URL to the OS
              // browser; the in-app navigation is already blocked either way.
            }
          })
          // error-policy:J6 dynamic import of the electrobun host shim failing
          // is non-actionable here — navigation stays blocked.
          .catch(() => {});
      }
    } catch {
      // error-policy:J3 unparseable URL → block the navigation (fail closed).
      e.preventDefault?.();
    }
  });

  win.on("close", (event: unknown) => {
    // Kiosk mode: the app is the entire GUI under a single-window compositor.
    // The window must never close — block every close request and keep it up.
    if (isKioskShellMode() && !isQuitting) {
      const closeEvent = event as { preventDefault?: () => void } | undefined;
      closeEvent?.preventDefault?.();
      logger.info("[Main] Kiosk window close blocked — staying fullscreen");
      return;
    }

    // On Linux with no tray configured, minimizing-to-tray (or running in the
    // background) strands an invisible process: there is no dock reopen like
    // macOS and no StatusNotifier item to restore from. Quit cleanly in that
    // case so closing the last window can't leave the agent unreachable. The
    // tray decision is read from the environment up front — not from a flag set
    // after createTray() resolves — so closing during startup, before the tray
    // icon appears, doesn't spuriously quit. macOS/Windows and the
    // Linux-with-tray path keep their existing behavior.
    if (
      !isQuitting &&
      process.platform === "linux" &&
      !shouldCreateDesktopTray(process.env)
    ) {
      logger.info(
        "[Main] Window close on Linux with no tray — quitting (no surface to restore from)",
      );
      void requestAppQuit();
      return;
    }

    if (!isQuitting && process.env.ELIZAOS_CLOSE_MINIMIZES_TO_TRAY !== "0") {
      const closeEvent = event as { preventDefault?: () => void } | undefined;
      if (typeof closeEvent?.preventDefault === "function") {
        closeEvent.preventDefault();
        void getDesktopManager()
          .hideWindow()
          .catch((err: unknown) => {
            logger.warn(
              `[Main] Failed to minimize window on close: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        logger.info("[Main] Window close requested - minimized to tray");
        showBackgroundRunNoticeOnce();
        return;
      }
      logger.info(
        "[Main] Window close requested - agent continues in background",
      );
    }

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
  logger.info("[Main] Window closed — agent continues in background");
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
    // Re-reveal the Dock icon for an already-open window (tray-first only).
    getDesktopManager().markMainWindowShown();
    return;
  }
  if (backgroundWindowPromise) {
    await backgroundWindowPromise;
    return;
  }
  backgroundWindowPromise = (async () => {
    const { rpc, sendToWebview } = createDesktopRpc("main");
    const win = attachMainWindow(
      await createMainWindow(rpc),
      rpc,
      sendToWebview,
    );
    injectApiBase(win);
    logger.info("[Main] Restored window from dock click");
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
    logger.warn(
      `[Main] Failed to persist background notice marker: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  const apiBase = resolveLoopbackApiBase();
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
  const apiBase = resolveLoopbackApiBase();
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

/**
 * The exact rpc object that BrowserView.defineRPC<ElizaDesktopRPCSchema>
 * returns. Carries the schema generic so call sites get typed `request`
 * and `send` proxies.
 */
type ElizaDesktopRpc = ReturnType<
  typeof BrowserView.defineRPC<ElizaDesktopRPCSchema>
>;

/**
 * Internal: type-erased view of the rpc shape that
 * `wireBrowserWorkspaceCaller` consumes. The handler module declares its
 * own structural type with `params: any`, so we widen here at the
 * boundary instead of forcing every consumer to import that internal.
 */
// biome-ignore lint/suspicious/noExplicitAny: bridges typed rpc.request to the handler-module's any-params signature
type RpcRequestProxy = Record<string, (params: any) => Promise<any>>;

function asRpcRequestProxy(request: unknown): RpcRequestProxy {
  return request as RpcRequestProxy;
}

function asRpcSend(
  send: unknown,
): (message: string, payload?: unknown) => void {
  return send as (message: string, payload?: unknown) => void;
}

const MAX_RPC_REQUEST_TIME_MS = 600_000;

/**
 * Build a typed RPC instance plus its `sendToWebview` companion, ready to
 * be passed to a `BrowserWindow` / `BrowserView` constructor via the `rpc`
 * option.
 *
 * This is the constructor-time injection pattern required by the
 * Electrobun rules: handlers are declared up front and bound when the
 * webview is created, not patched in post-hoc via `setRequestHandler`.
 *
 * `sendToWebview` closes over the RPC by reference so it can be passed
 * into `buildBunRpcHandlers` before `defineRPC` returns — we only need
 * the actual `send` proxy at call time, after the webview is alive.
 *
 * @param label  Diagnostic tag included in the "no RPC method" warning so
 *               main / settings / surface windows are distinguishable.
 */
function createDesktopRpc(label: string): {
  rpc: ElizaDesktopRpc;
  sendToWebview: SendToWebview;
} {
  let rpc: ElizaDesktopRpc | undefined;

  const sendToWebview: SendToWebview = (message, payload) => {
    if (!rpc) {
      logger.warn(
        `[sendToWebview:${label}] RPC not yet initialised; dropping message: ${message}`,
      );
      return;
    }
    try {
      // `rpc.send` is a Proxy<sendFn> from defineElectrobunRPC: both
      // `rpc.send(message, payload)` and `rpc.send.<message>(payload)`
      // dispatch through the same underlying sendFn. Cast to a plain
      // function signature to call it dynamically by name without the
      // schema-typed overloads narrowing the message string.
      asRpcSend(rpc.send)(message, payload ?? null);
    } catch (err) {
      logger.warn(
        `[sendToWebview:${label}] send(${message}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  type BunRpcRequestsHandlers = NonNullable<
    Parameters<
      typeof BrowserView.defineRPC<ElizaDesktopRPCSchema>
    >[0]["handlers"]
  >["requests"];

  rpc = BrowserView.defineRPC<ElizaDesktopRPCSchema>({
    maxRequestTime: MAX_RPC_REQUEST_TIME_MS,
    handlers: {
      requests: buildBunRpcHandlers({
        sendToWebview,
      }) as BunRpcRequestsHandlers,
    },
  });

  return { rpc, sendToWebview };
}

/**
 * Wire main-window-only side effects after the BrowserWindow has been
 * constructed with its pre-built RPC.
 *
 * Does NOT register request handlers — those are baked into the rpc by
 * `createDesktopRpc` at construction time. This function only wires
 * post-hoc concerns that need a live `win` and `rpc.request` proxy:
 *
 *   - native module singletons (DesktopManager, AgentManager, …) get
 *     bound to the main window + sendToWebview
 *   - browser workspace's renderer-side caller is set so bun-side tab
 *     code can `rpc.request.browserWorkspaceRendererEvaluate(...)`
 *   - steward sidecar's send-to-webview is wired
 */
function wireMainWindowAfterCreate(
  win: BrowserWindow,
  rpc: ElizaDesktopRpc,
  sendToWebview: SendToWebview,
): void {
  initializeNativeModules(win, sendToWebview);
  setStewardSendToWebview(sendToWebview);
  wireBrowserWorkspaceCaller({
    request: asRpcRequestProxy(rpc.request),
  });
}

/**
 * Wire RPC for a secondary window (e.g. settings) after constructor-time
 * injection. Does NOT call `initializeNativeModules` — that would
 * overwrite the main window reference on DesktopManager and other
 * singletons.
 *
 * This keeps the call site symmetric with the main window even though
 * settings windows don't need most of the wiring.
 */
function wireSettingsRpcAfterCreate(rpc: ElizaDesktopRpc): void {
  wireBrowserWorkspaceCaller({
    request: asRpcRequestProxy(rpc.request),
  });
}

function injectApiBase(win: BrowserWindow): void {
  const runtimeResolution = resolveDesktopRuntime();

  if (runtimeResolution.externalApi.invalidSources.length > 0) {
    logger.warn(
      `[Main] Invalid API base env vars: ${runtimeResolution.externalApi.invalidSources.join(", ")}`,
    );
  }

  if (
    runtimeResolution.mode === "external" &&
    runtimeResolution.externalApi.base
  ) {
    apiBaseOwner.notifyChange(
      win,
      runtimeResolution.externalApi.base,
      resolveApiToken(process.env) ?? "",
    );
    setAgentReady(true);
    return;
  }

  const agent = getAgentManager();
  const port = agent.getPort() ?? resolveDesktopApiPort(process.env);
  const apiToken = configureDesktopLocalApiAuth();
  apiBaseOwner.notifyChange(
    win,
    resolveRendererFacingApiBase(
      process.env as Record<string, string | undefined>,
      port,
    ),
    apiToken,
  );
  setAgentReady(true);
}

function injectApiBaseIntoOpenRendererWindows(): void {
  if (currentWindow) {
    injectApiBase(currentWindow);
  }

  surfaceWindowManager?.forEachWindow((w) => {
    injectApiBase(w as BrowserWindow);
  });

  getDesktopManager().forEachTrayPopoverWindow((w) => {
    injectApiBase(w);
  });
}

/**
 * Snapshot of every currently-open renderer window the agent API base should
 * be pushed to. Mirrors the window set in injectApiBaseIntoOpenRendererWindows.
 * Returns an empty array when no window exists yet (headless boot).
 */
function collectOpenRendererWindows(): BrowserWindow[] {
  const windows: BrowserWindow[] = [];
  if (currentWindow) {
    windows.push(currentWindow);
  }
  surfaceWindowManager?.forEachWindow((w) => {
    windows.push(w as BrowserWindow);
  });
  getDesktopManager().forEachTrayPopoverWindow((w) => {
    windows.push(w);
  });
  return windows;
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
    logger.warn(
      `[Main] Permission sync failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function _startAgent(): Promise<void> {
  const runtimeResolution = resolveDesktopRuntime();

  if (runtimeResolution.mode !== "local") {
    logger.info(
      `[Main] Skipping embedded agent startup (${runtimeResolution.mode} mode)`,
    );
    injectApiBaseIntoOpenRendererWindows();
    return;
  }

  recordStartupPhase("autostart_requested", {
    pid: process.pid,
    exec_path: process.execPath,
    bundle_path: resolveStartupBundlePath(process.execPath),
  });

  try {
    const remotePluginHost = getRemotePluginHost();
    remotePluginHost.startWorker("eliza.runtime");
    await remotePluginHost.invokeWorker({
      id: "eliza.runtime",
      method: "runtime.start",
      timeoutMs: getHealthPollTimeoutMs() + 5_000,
    });
    const status = getAgentManager().getStatus();

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
      const apiToken = resolveApiToken(process.env) ?? "";
      // Set the source-of-truth API base FIRST (correct even with zero open
      // windows), then push to every open window.
      publishAgentApiBase(rendererBase, apiToken, collectOpenRendererWindows());
      setAgentReady(true);
      // Sync real OS permission states to the REST API so the renderer
      // can display them and capability toggles can unlock.
      // Pass startup=true so the backend skips scheduling a restart for
      // capabilities that are being auto-enabled for the first time.
      syncPermissionsToRestApi(status.port, true);
    }
  } catch (err) {
    logger.error(
      `[Main] Agent start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function setupUpdater(): Promise<void> {
  const runUpdateCheck = async (notifyOnNoUpdate = false): Promise<void> => {
    try {
      const updaterState = await getDesktopManager().getUpdaterState();
      if (!updaterState.canAutoUpdate) {
        if (updaterState.autoUpdateDisabledReason) {
          logger.info(
            `[Updater] Skipping auto-update check: ${updaterState.autoUpdateDisabledReason}`,
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
      if (updateResult.updateAvailable) {
        Updater.downloadUpdate().catch((err: unknown) => {
          logger.warn(
            `[Updater] Download failed: ${err instanceof Error ? err.message : String(err)}`,
          );
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
      logger.warn(
        `[Updater] Update check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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

    const handleUpdateAndConfigMenuAction = async (
      action: string | undefined,
    ): Promise<boolean> => {
      if (action === "check-for-updates") {
        triggerManualUpdateCheck();
        return true;
      }
      if (action === "open-about") {
        const updaterState = await getDesktopManager().getUpdaterState();
        const version = updaterState.currentVersion || "unknown";
        Utils.showNotification({
          title: `About ${BRAND.appName}`,
          body: `Version ${version} (${process.platform}/${process.arch})`,
        });
        void createSettingsWindow("updates");
        return true;
      }
      if (action === "export-config") {
        void exportConfigFromMenu();
        return true;
      }
      if (action === "import-config") {
        void importConfigFromMenu();
        return true;
      }
      return false;
    };

    const handleMainWindowMenuAction = (
      action: string | undefined,
    ): boolean => {
      if (action === "toggle-devtools") {
        toggleFocusedWindowDevTools();
        return true;
      }
      if (action === "focus-main-window") {
        void getDesktopManager().focusWindow();
        return true;
      }
      if (action === "hide-main-window") {
        void getDesktopManager().hideWindow();
        return true;
      }
      if (action === "maximize-main-window") {
        void getDesktopManager().maximizeWindow();
        return true;
      }
      if (action === "restore-main-window") {
        void getDesktopManager().unmaximizeWindow();
        return true;
      }
      if (action === "show") {
        void getDesktopManager().showWindow();
        return true;
      }
      return false;
    };

    const handleSettingsMenuAction = (action: string | undefined): boolean => {
      if (action === "open-secrets-manager") {
        void restoreWindow();
        sendToActiveRenderer("openSecretsManager", {});
        return true;
      }
      if (action === "open-settings" || action?.startsWith("open-settings-")) {
        void createSettingsWindow(parseSettingsWindowAction(action));
        return true;
      }
      return false;
    };

    const handleSurfaceMenuAction = (action: string | undefined): boolean => {
      // "Views" submenu (#10716): `new-window:view-<id>` opens a builtin view in
      // its own window via the same app-window path detached surfaces use.
      // Checked before the generic `new-window:` surface branch because that
      // prefix also matches.
      const viewId = parseViewWindowAction(action);
      if (viewId) {
        const entry = findViewMenuEntryById(viewId);
        if (entry) {
          void getDesktopManager().openAppWindow({
            slug: `view-${entry.id}`,
            title: entry.label,
            path: entry.path,
            alwaysOnTop: false,
          });
        }
        return true;
      }
      if (action?.startsWith("new-window:")) {
        const surface = action.slice("new-window:".length);
        if (surfaceWindowManager && isDetachedSurface(surface)) {
          void surfaceWindowManager.openSurfaceWindow(surface);
        }
        return true;
      }
      if (action?.startsWith("focus-window:")) {
        const windowId = action.slice("focus-window:".length);
        surfaceWindowManager?.focusWindow(windowId);
        return true;
      }
      if (action?.startsWith("show-main:")) {
        showMainSurface(action.slice("show-main:".length));
        return true;
      }
      return false;
    };

    const handleStewardMenuAction = (action: string | undefined): boolean => {
      if (action === "restart-steward" && isStewardLocalEnabled()) {
        restartSteward().catch((err: unknown) => {
          logger.error(
            `[Main] Steward restart failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          Utils.showNotification({
            title: "Steward Restart Failed",
            body: err instanceof Error ? err.message : "Unknown error",
          });
        });
        return true;
      }
      if (action === "reset-steward" && isStewardLocalEnabled()) {
        resetSteward().catch((err: unknown) => {
          logger.error(
            `[Main] Steward reset failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          Utils.showNotification({
            title: "Steward Reset Failed",
            body: err instanceof Error ? err.message : "Unknown error",
          });
        });
        return true;
      }
      return false;
    };

    const handleAppEntryMenuAction = (action: string | undefined): boolean => {
      if (!action?.startsWith("apps:") && !action?.startsWith("tray-app-")) {
        return false;
      }
      const slug = action.startsWith("apps:")
        ? action.slice("apps:".length)
        : action.slice("tray-app-".length);
      const entry = findAppMenuEntryBySlug(slug);
      if (!entry) return true;
      if (entry.hasDetailsPage) {
        void restoreWindow();
        sendToActiveRenderer("desktopAppDetailsRequested", {
          slug: entry.slug,
        });
        return true;
      }
      void getDesktopManager().openAppWindow({
        slug: entry.slug,
        title: entry.displayName,
        path: entry.windowPath,
        alwaysOnTop: false,
      });
      return true;
    };

    const handleRuntimeMenuAction = (action: string | undefined): boolean => {
      if (action === "relaunch") {
        void getDesktopManager().relaunch();
        return true;
      }
      if (action === "reset-app") {
        void resetTheAppFromApplicationMenu();
        return true;
      }
      if (action === "desktop-notify") {
        void getDesktopManager().showNotification({
          title: `${BRAND.appName} Desktop`,
          body: `${BRAND.appName} native application menu actions are wired and responding.`,
          urgency: "normal",
        });
        return true;
      }
      if (action === "restart-agent") {
        getAgentManager()
          .restart()
          .catch((err: unknown) => {
            logger.error(
              `[Main] Agent restart failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        return true;
      }
      if (action === "quit") {
        void getDesktopManager().quit();
        return true;
      }
      if (action?.startsWith("navigate-") || action === "open-notifications") {
        // `open-notifications` (#10706): the desktop-native "Notifications"
        // menu/tray item. Reuses the same renderer channel as `navigate-*`;
        // DesktopSurfaceNavigationRuntime opens the notification center in place
        // rather than switching tabs.
        void getDesktopManager().showWindow();
        sendToActiveRenderer("desktopTrayMenuClick", { itemId: action });
        return true;
      }
      return false;
    };

    const handleApplicationMenuAction = async (
      action: string | undefined,
    ): Promise<void> => {
      if (!currentWindow && shouldRestoreWindowBeforeMenuAction(action)) {
        await restoreWindow();
      }
      if (await handleUpdateAndConfigMenuAction(action)) return;
      if (handleMainWindowMenuAction(action)) return;
      if (handleSettingsMenuAction(action)) return;
      if (handleSurfaceMenuAction(action)) return;
      if (handleStewardMenuAction(action)) return;
      if (handleAppEntryMenuAction(action)) return;
      handleRuntimeMenuAction(action);
    };

    setApplicationMenuActionHandler(handleApplicationMenuAction);

    Electrobun.events.on(
      "application-menu-clicked",
      (e: { data?: { action?: string } }) => {
        void handleApplicationMenuAction(e.data?.action);
      },
    );

    // Route tray app entries (`tray-app-<slug>`) into the same handler as the
    // OS menu bar. WHY: the desktop manager forwards every tray click to the
    // renderer, but spawning native windows must happen on the bun side.
    Electrobun.events.on(
      "tray-clicked",
      (e: { data?: { action?: string } }) => {
        const action = e.data?.action;
        if (typeof action === "string" && action.startsWith("tray-app-")) {
          void handleApplicationMenuAction(action);
        }
      },
    );

    Electrobun.events.on("context-menu-clicked", (action: string) => {
      if (action === "check-for-updates") {
        triggerManualUpdateCheck();
      } else if (action === "relaunch") {
        void getDesktopManager().relaunch();
      }
    });

    await runUpdateCheck(false);
  } catch (err) {
    logger.warn(
      `[Updater] Update check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Handle a `<scheme>://...` deep link. Recognized routes:
 *   - `<scheme>://apps/<slug>` → open or focus the matching app window
 *   - anything else → forward to renderer as a generic share target so
 *     in-app handlers (share-into-chat, etc.) can react.
 *
 * The URL scheme itself is configured at build time (electrobun.config.ts:
 * `urlSchemes`, sourced from `ELIZA_URL_SCHEME`) — this handler does not
 * care which scheme is used; it only routes by host + pathname.
 */
async function handleDeepLink(url: string): Promise<void> {
  const route = classifyDeepLinkRoute(url);
  if (route.kind === "app") {
    const entry = findAppMenuEntryBySlug(route.slug);
    if (entry) {
      // Mirror the menu/tray handler: apps with a details page get a config
      // review screen instead of a direct window so deep links and clicks
      // produce identical UX.
      if (entry.hasDetailsPage) {
        void restoreWindow();
        sendToActiveRenderer("desktopAppDetailsRequested", {
          slug: entry.slug,
        });
      } else {
        void getDesktopManager().openAppWindow({
          slug: entry.slug,
          title: entry.displayName,
          path: entry.windowPath,
          alwaysOnTop: false,
        });
      }
      return;
    }
  }

  await forwardDeepLinkToRenderer(url);
}

async function forwardDeepLinkToRenderer(url: string): Promise<void> {
  await restoreWindow();
  // Assistant/Siri/Shortcuts links deliberately stay renderer-owned. LifeOps
  // requests must go through the normal chat/runtime planner, which persists
  // ScheduledTask records instead of creating native macOS-only state.
  sendToActiveRenderer("shareTargetReceived", { url });
}

function setupDeepLinks(): void {
  Electrobun.events.on("open-url", (event: unknown) => {
    const url = readOpenUrlEventUrl(event);
    if (!url) {
      logger.warn("[Main] Ignoring open-url event without a URL payload");
      return;
    }
    void handleDeepLink(url);
  });
}

function setupDockReopen(): void {
  Electrobun.events.on("reopen", () => {
    void restoreWindow();
  });
}

async function runShutdownCleanup(reason: string): Promise<void> {
  if (shutdownCleanupPromise) {
    return shutdownCleanupPromise;
  }

  shutdownCleanupPromise = (async () => {
    logger.info(`[Main] App quitting (${reason}), disposing native modules...`);
    isQuitting = true;
    sendToActiveRenderer("desktopShutdownStarted", { reason });
    const cleanupFnsToRun = cleanupFns.splice(0);
    const cleanupResults = await Promise.allSettled(
      cleanupFnsToRun.map((cleanupFn) => Promise.resolve().then(cleanupFn)),
    );
    for (const result of cleanupResults) {
      if (result.status === "rejected") {
        logger.warn(
          `[Main] Shutdown cleanup callback failed: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`,
        );
      }
    }
    try {
      await disposeNativeModules();
    } catch (error) {
      logger.warn(
        `[Main] Native module disposal failed during shutdown: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  })();

  return shutdownCleanupPromise;
}

function setupShutdown(): void {
  Electrobun.events.on("before-quit", () => {
    void runShutdownCleanup("before-quit");
  });
}

/**
 * Load repo-root and state-dir `.env` into `process.env` (non-destructive) so the
 * main process can send the same `ELIZA_API_TOKEN` as `dev-server.ts` when
 * calling loopback APIs (app menu reset, export, etc.). The dev API child
 * already loads dotenv; Electrobun did not until this ran.
 *
 * Packaged desktop builds must not load these files. On machines that also
 * have an app/Eliza dev checkout, the state-dir `.env` can contain
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
    const namespace = process.env.ELIZA_NAMESPACE?.trim() || BRAND.namespace;
    const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
    const stateHome = xdgStateHome
      ? path.isAbsolute(xdgStateHome)
        ? xdgStateHome
        : path.join(os.homedir(), xdgStateHome)
      : path.join(os.homedir(), ".local", "state");
    for (const envPath of [
      path.join(repoRootGuess, ".env"),
      path.join(stateHome, namespace, ".env"),
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
    logger.info(
      "[WebGPU] Native Dawn runtime not bundled for this run; renderer-side WebGPU remains available through the webview/browser path.",
    );
    return;
  }

  webgpu.install();
  logger.info(`[WebGPU] Native Dawn runtime ready at ${WGPU.native.path}`);
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
function checkWebGpuBrowserSupport(rendererType: "native" | "cef"): void {
  const status = checkWebGpuSupport(rendererType);
  if (status.available) {
    logger.info(`[WebGPU Browser] ${status.reason}`);
  } else {
    logger.warn(`[WebGPU Browser] ${status.reason}`);
    if (status.chromeBetaPath) {
      logger.info(
        `[WebGPU Browser] Chrome Beta found at: ${status.chromeBetaPath}`,
      );
    } else if (status.downloadUrl) {
      logger.info(
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
  recordStartupPhase("env_loaded", {
    pid: process.pid,
  });
  // Start the static renderer server in parallel with the rest of pre-window
  // work — first paint needs the renderer URL, so kicking it off now overlaps
  // the server bind/port-scan with crash-prompt checks, WebGPU init, and bridge
  // startup below. resolveRendererUrl() is idempotent (memoises this promise),
  // so later callers reuse it. Errors surface when the promise is awaited.
  void resolveRendererUrl();
  console.log(`[Main] Starting ${BRAND.appName} (Electrobun)`);
  const normalizedModuleDir = import.meta.dir.replaceAll("\\", "/");
  const runtimeResolution = resolveDesktopRuntime();
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

  // Don't block first paint on the crash-recovery prompt. The common path is a
  // couple of stat reads that early-return; the only blocking case is a modal
  // shown after a *prior* launch crashed, which can safely overlap the window.
  void maybePromptStartupCrashReport()
    .then(() => {
      recordStartupPhase("crash_prompt_checked", {
        pid: process.pid,
      });
    })
    .catch((err) => {
      logger.warn(
        `[Main] Startup crash prompt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
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
        logger.info(
          `[Main] CEF version mismatch (${previousVersion ?? "none"} → ${currentVersion}), clearing stale CEF profile`,
        );
        // Remove everything except the version marker we're about to write.
        for (const entry of fs.readdirSync(cefDir)) {
          if (entry === BRAND.cefVersionMarkerFileName) continue;
          const entryPath = path.join(cefDir, entry);
          try {
            fs.rmSync(entryPath, { recursive: true, force: true });
          } catch (err) {
            logger.warn(
              `[Main] Could not remove ${entryPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
      // Write/update version marker so we don't clear again on next launch.
      if (shouldWriteWindowsCefProfileMarker(currentVersion)) {
        fs.mkdirSync(cefDir, { recursive: true });
        fs.writeFileSync(cefVersionMarker, currentVersion);
      }
    } catch (err) {
      logger.warn(
        `[Main] CEF profile cleanup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  initializeBundledWebGPU();
  recordStartupPhase("webgpu_initialized", {
    pid: process.pid,
  });
  const buildInfo = await BuildConfig.get();
  checkWebGpuBrowserSupport(buildInfo.defaultRenderer);
  cleanupFns.length = 0;
  // Start the browser-workspace bridge without blocking first paint. The
  // renderer reaches it lazily (browser-workspace RPC), so it does not need to
  // be listening before the window opens. Register a cleanup that awaits the
  // resolved stop fn so shutdown still tears it down.
  const browserWorkspaceBridgeStop = startBrowserWorkspaceBridgeServer()
    .then((stop) => {
      recordStartupPhase("browser_workspace_bridge_ready", {
        pid: process.pid,
      });
      return stop;
    })
    .catch((err) => {
      logger.warn(
        `[Main] Browser-workspace bridge startup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    });
  cleanupFns.push(async () => {
    const stop = await browserWorkspaceBridgeStop;
    await stop?.();
  });
  try {
    const stopScreenCaptureBridgeServer =
      await startScreenCaptureBridgeServer();
    recordStartupPhase("screen_capture_bridge_ready", {
      pid: process.pid,
    });
    cleanupFns.push(stopScreenCaptureBridgeServer);
  } catch (err) {
    logger.warn(
      `[Main] Screen-capture bridge startup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const stopDesktopTestBridgeServer = await startDesktopTestBridgeServer();
  recordStartupPhase("desktop_test_bridge_ready", {
    pid: process.pid,
  });
  if (stopDesktopTestBridgeServer) {
    cleanupFns.push(stopDesktopTestBridgeServer);
  }

  // WHY push API base on every status tick with a port: embedded startup can
  // settle on a different loopback port than env/static HTML (allocation + stdout).
  // Detached surfaces must not keep a stale boot-config apiBase while the main
  // window was already updated—menu reset, chat, and settings each own a webview.
  cleanupFns.push(
    getAgentManager().onStatusChange((status) => {
      if (status.port) {
        // The agent rebound to a different loopback port (or recovered from a
        // crash) — the cookies we installed during _startAgent were scoped to
        // the old origin. Re-prime so every renderer's next /api request stays
        // authenticated, including any open secondary renderer windows.
        markDesktopSessionStale();
        const apiBase = `http://127.0.0.1:${status.port}`;
        const rendererBase = resolveRendererFacingApiBase(
          process.env as Record<string, string | undefined>,
          status.port,
        );
        void primeDesktopSessionAuth(apiBase, rendererBase);
        injectApiBaseIntoOpenRendererWindows();
      }
    }),
  );

  // Create window first — on Windows (CEF) the UI message loop must be
  // running before any synchronous FFI calls like setApplicationMenu().
  // Calling setupApplicationMenu() before createMainWindow() deadlocks.
  // Dockless (tray-first) mode is the macOS default (#12184): the resting
  // experience is the pill + menu-bar icon with NO Dock icon. Unlike the old
  // tray-first behavior we STILL create the pill window at boot — the pill is
  // not a "full window" for Dock purposes, so setTrayFirstMode keeps the Dock
  // icon hidden until a full window (dashboard/surface/settings/app) opens.
  const dockless = shouldStartTrayFirst();
  if (dockless) {
    logger.info(
      "[Main] Dockless startup — pill only, Dock icon hidden at rest",
    );
    getDesktopManager().setTrayFirstMode(true);
  }
  recordStartupPhase("creating_window", {
    pid: process.pid,
  });
  const { rpc: mainRpc, sendToWebview: mainSendToWebview } =
    createDesktopRpc("main");
  const mainWin: BrowserWindow | null = attachMainWindow(
    await createMainWindow(mainRpc),
    mainRpc,
    mainSendToWebview,
  );
  recordStartupPhase("window_ready", {
    pid: process.pid,
  });
  seedFirstPartyRemotePluginsForStartup();

  // Per-window RPC tracking: surface windows each get their own typed
  // RPC built up front via createDesktopRpc, baked into the BrowserWindow
  // constructor, then "wired" post-hoc by wireSettingsRpcAfterCreate.
  const surfaceRpcs = new WeakMap<ManagedWindowLike, ElizaDesktopRpc>();

  surfaceWindowManager = new SurfaceWindowManager({
    createWindow: (options) => {
      const { rpc } = createDesktopRpc("surface");
      const window = createElectrobunBrowserWindow({
        ...options,
        rpc,
      }) as BrowserWindow & ManagedWindowLike;
      surfaceRpcs.set(window, rpc);
      return window;
    },
    resolveRendererUrl,
    readPreload: () => readResolvedPreloadScript(import.meta.dir),
    wireRpc: (window) => {
      const rpc = surfaceRpcs.get(window);
      if (!rpc) {
        logger.warn(
          "[surface-windows] wireRpc called for window with no tracked rpc; skipping browser-workspace caller setup",
        );
        return;
      }
      wireSettingsRpcAfterCreate(rpc);
    },
    injectApiBase: (window) =>
      injectApiBase(window as BrowserWindow & ManagedWindowLike),
    onWindowFocused: (window) => {
      lastFocusedWindow = window;
    },
    onRegistryChanged: () => {
      sendManagedWindowsChanged();
      setupApplicationMenu();
      // Dockless mode: any open managed window (dashboard/surface/settings/app)
      // reveals the Dock icon; closing the last one hides it again.
      getDesktopManager().setManagedWindowsPresent(
        (surfaceWindowManager?.listWindows().length ?? 0) > 0,
      );
    },
    boundsStore: createAppWindowBoundsStore(),
  });
  // Set up app menu after the window (and its message loop) exists.
  setupApplicationMenu();
  const stopScreenshotDevServer = startScreenshotDevServer();
  if (stopScreenshotDevServer) {
    cleanupFns.push(stopScreenshotDevServer);
  }

  // Wire detached window callbacks so menus and RPC can open them.
  getDesktopManager().setOpenSettingsCallback((tabHint) => {
    void createSettingsWindow(tabHint);
  });
  getDesktopManager().setRestoreMainWindowCallback(() => restoreWindow());
  getDesktopManager().setRequestQuitCallback(() => {
    void requestAppQuit();
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
  // In tray-first mode there is no window yet (mainWin is null) — nothing to minimize.
  if (mainWin && process.argv.includes("--hidden")) {
    try {
      mainWin.minimize();
    } catch (err) {
      logger.warn(
        `[Main] Failed to minimize window on --hidden startup: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  setupDeepLinks();
  setupDockReopen();

  const desktop = getDesktopManager();
  if (shouldCreateDesktopTray(process.env)) {
    try {
      // Tray is created here so the icon appears at startup, but the menu is
      // owned by the renderer (DesktopTrayRuntime + main.tsx → Desktop.setTrayMenu).
      // That keeps a single source of truth for tray items and their handlers.
      await desktop.createTray({
        icon: resolveDesktopAppIconPath(),
        tooltip: BRAND.appName,
        title: BRAND.appName,
      });
    } catch (err) {
      logger.warn(
        `[Main] Tray creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Tray popover (#9953 Phase 4): when enabled, a tray click opens a widget
    // popover instead of restoring the full window. macOS-only today (see
    // shouldEnableTrayPopover); Win/Linux keep the text context menu.
    if (shouldEnableTrayPopover()) {
      try {
        const base = await resolveRendererUrlForCurrentRuntime();
        const popoverUrl = new URL(base);
        popoverUrl.searchParams.set("shellMode", "tray-popover");
        const { rpc } = createDesktopRpc("tray-popover");
        const buildInfo = await BuildConfig.get();
        const mainWindowPartition = resolveMainWindowPartition(process.env, {
          platform: process.platform,
          buildInfo,
        });
        desktop.configureTrayPopover({
          url: popoverUrl.href,
          preload: readResolvedPreloadScript(import.meta.dir),
          partition: mainWindowPartition,
          rpc,
          wireRpc: () => wireSettingsRpcAfterCreate(rpc),
          injectApiBase,
          onWindowFocused: (window) => {
            lastFocusedWindow = window;
          },
        });
        logger.info("[Main] Tray popover enabled");
      } catch (err) {
        logger.warn(
          `[Main] Tray popover configuration failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else {
    logger.info("[Main] Desktop tray disabled by environment");
  }

  // ── Steward sidecar startup (must happen BEFORE agent) ────────────
  // When STEWARD_LOCAL=true, start the steward sidecar first so it can
  // set STEWARD_API_URL / STEWARD_AGENT_TOKEN env vars. The the app agent's
  // steward-bridge.ts reads these on boot to discover local steward.
  if (isStewardLocalEnabled()) {
    logger.info("[Main] STEWARD_LOCAL=true — starting steward sidecar...");
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
        logger.info(
          `[Main] Steward sidecar ready on port ${stewardResult.port}, wallet: ${stewardResult.walletAddress ?? "pending"}`,
        );
      } else {
        logger.warn(
          `[Main] Steward sidecar in state "${stewardResult.state}": ${stewardResult.error ?? "unknown"}`,
        );
        sendToActiveRenderer("stewardStartupFailed", {
          error: stewardResult.error ?? "Steward failed to start",
          canRetry: true,
        });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`[Main] Steward sidecar startup failed: ${error}`);
      sendToActiveRenderer("stewardStartupFailed", {
        error,
        canRetry: true,
      });
      // Don't block agent startup — steward is optional
    }
  }

  // Agent startup: in external mode, push the API base via the
  // api-base-owner (the agent is already running externally). In local
  // mode, start the embedded agent first — apiBaseOwner.injectIntoHtml()
  // already seeded the initial boot-config apiBase from the seed value
  // in main(), but _startAgent will push the actual port once the agent
  // reports it.
  const rt = resolveDesktopRuntime();
  if (rt.mode === "external") {
    injectApiBaseIntoOpenRendererWindows();
  } else if (rt.mode === "local") {
    logger.info("[Main] Starting embedded agent (local mode).");
    _startAgent().catch((err) => {
      logger.error(
        `[Main] Agent auto-start failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const error = err instanceof Error ? err.message : String(err);
      sendToActiveRenderer("agentStartupFailed", { error });
      console.error(`title: "${BRAND.appName} startup failed"`);
    });
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
    logger.warn(
      `[Main] Failed to write startup crash report: ${err instanceof Error ? err.message : String(err)}`,
    );
    try {
      fs.mkdirSync(path.dirname(fallbackReportPath), { recursive: true });
      fs.writeFileSync(fallbackReportPath, report, "utf8");
      reportPath = fallbackReportPath;
    } catch (fallbackErr) {
      logger.warn(
        `[Main] Failed to write fallback startup crash report: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
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
  } catch (err) {
    // error-policy:J6 best-effort dedupe marker; a failed write at worst
    // re-prompts the crash report once more, but surface the write failure.
    logger.warn("[Main][startup-crash] failed to persist prompt marker", err);
  }
}

async function maybePromptStartupCrashReport(): Promise<void> {
  if (
    process.env.ELIZA_DESKTOP_SKIP_STARTUP_CRASH_PROMPT === "1" ||
    process.env.ELIZA_DESKTOP_TEST_AUTO_CONFIRM_DIALOGS === "1"
  ) {
    return;
  }

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
      logger.warn(
        `[Main] Failed to copy startup crash report: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (response === 1) {
    try {
      Utils.openPath(path.dirname(reportPath));
    } catch (err) {
      logger.warn(
        `[Main] Failed to open startup logs folder: ${err instanceof Error ? err.message : String(err)}`,
      );
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
  } catch (writeErr) {
    // error-policy:J7 already inside the fatal-startup handler; a failed
    // diagnostic write must not preempt the shutdown below, but log it.
    logger.warn("[Main] failed to persist fatal-startup diagnostics", writeErr);
  }
  void runShutdownCleanup("fatal-startup").finally(shutdownAfterFatalError);
});

import { shutdownAfterFatalError } from "./fatal-shutdown";

export { shutdownAfterFatalError };
