import "@elizaos/app-core/styles/styles.css";
import "@elizaos/app-core/styles/brand-gold.css";

import "@elizaos/app-core/platform/native-plugin-entrypoints";

import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import { StatusBar, Style } from "@capacitor/status-bar";
import {
  AGENT_READY_EVENT,
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  App,
  type AppBootConfig,
  applyForceFreshOnboardingReset,
  applyLaunchConnectionFromUrl,
  type BrandingConfig,
  CharacterEditor,
  COMMAND_PALETTE_EVENT,
  CONNECT_EVENT,
  client,
  dispatchAppEvent,
  getBootConfig,
  initializeCapacitorBridge,
  initializeStorageBridge,
  installDesktopPermissionsClientPatch,
  installForceFreshOnboardingClientPatch,
  installLocalProviderCloudPreferencePatch,
  isDetachedWindowShell,
  isElectrobunRuntime,
  resolveWindowShellRoute,
  SHARE_TARGET_EVENT,
  setBootConfig,
  shouldInstallMainWindowOnboardingPatches,
  shouldUseCloudOnlyBranding,
  subscribeDesktopBridgeEvent,
  syncDetachedShellLocation,
  TRAY_ACTION_EVENT,
} from "@elizaos/app-core";
import { dispatchQueuedLifeOpsGithubCallbackFromUrl } from "@elizaos/app-lifeops";
import { LifeOpsActivitySignalsEffect } from "@elizaos/app-lifeops/ui";
// Side-effect: register LifeOps sidebar widgets into the app-core widget registry.
import "@elizaos/app-lifeops/widgets";
// Side-effect: register coding-agent (task-coordinator) slots so app-core
// slot wrappers (CodingAgentControlChip, PtyConsoleBase, etc.) render the
// real components instead of nulls.
import "@elizaos/app-task-coordinator/register-slots";
// Side-effect: register game operator surfaces + detail extensions.
import "@elizaos/app-babylon/ui";
import "@elizaos/app-scape/ui";
import "@elizaos/app-hyperscape/ui";
import "@elizaos/app-2004scape/ui";
import "@elizaos/app-defense-of-the-agents/ui";
import {
  AppProvider,
  applyUiTheme,
  DESKTOP_TRAY_MENU_ITEMS,
  DesktopOnboardingRuntime,
  DesktopSurfaceNavigationRuntime,
  DesktopTrayRuntime,
  DetachedShellRoot,
  loadUiTheme,
} from "@elizaos/app-core";
import { Agent } from "@elizaos/capacitor-agent";
import { Desktop } from "@elizaos/capacitor-desktop";
import { ErrorBoundary } from "@elizaos/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ELIZA_ENV_ALIASES } from "./brand-env";
import { ELIZA_CHARACTER_CATALOG } from "./character-catalog";

const ELIZA_BRANDING: Partial<BrandingConfig> = {
  appName: "__APP_NAME__",
  orgName: "__ORG_NAME__",
  repoName: "__REPO_NAME__",
  docsUrl: "__DOCS_URL__",
  appUrl: "__APP_URL__",
  bugReportUrl: "__BUG_REPORT_URL__",
  hashtag: "__HASHTAG__",
  fileExtension: "__FILE_EXTENSION__",
  packageScope: "__PACKAGE_SCOPE__",
  // The hosted web bundle stays cloud-only in production. Desktop shells and
  // other hosts inject an explicit API base before React boots, and that host
  // backend should control onboarding capabilities instead.
  cloudOnly: shouldUseCloudOnlyBranding({
    isDev: import.meta.env.DEV ?? false,
    injectedApiBase:
      typeof window === "undefined" ? undefined : window.__ELIZA_API_BASE__,
    isNativePlatform: Capacitor.isNativePlatform(),
  }),
};

/**
 * Platform detection utilities
 */
const platform = Capacitor.getPlatform();
const isNative = Capacitor.isNativePlatform();
const isIOS = platform === "ios";
const isAndroid = platform === "android";

function isDesktopPlatform(): boolean {
  return isElectrobunRuntime();
}

function isWebPlatform(): boolean {
  return platform === "web" && !isElectrobunRuntime();
}

interface ShareTargetFile {
  name: string;
  path?: string;
}

interface ShareTargetPayload {
  source?: string;
  title?: string;
  text?: string;
  url?: string;
  files?: ShareTargetFile[];
}

declare global {
  interface Window {
    __ELIZA_SHARE_QUEUE__?: ShareTargetPayload[];
    __ELIZA_CHARACTER_EDITOR__?: typeof CharacterEditor;
    __ELIZA_API_BASE__?: string;
  }
}

const windowShellRoute = resolveWindowShellRoute();

/**
 * Adds `eliza-electrobun-frameless` for CSS `-webkit-app-region` (Chromium/CEF).
 * macOS WKWebView move/resize are still driven by native overlays in
 * window-effects.mm; this class mainly marks the shell and helps non-WK engines.
 */
function shouldEnableElectrobunMacWindowDrag(): boolean {
  if (!isElectrobunRuntime() || typeof document === "undefined") return false;
  if (isDetachedWindowShell(windowShellRoute)) return false;
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Mac/i.test(ua) && !/(iPhone|iPad|iPod)/i.test(ua);
}

if (shouldEnableElectrobunMacWindowDrag()) {
  document.documentElement.classList.add("eliza-electrobun-frameless");
}

// Dev escape hatch: ?reset forces a truly fresh onboarding session by clearing
// persisted state and temporarily suppressing stale backend resume config.
if (shouldInstallMainWindowOnboardingPatches(windowShellRoute)) {
  applyForceFreshOnboardingReset();
  installForceFreshOnboardingClientPatch(client as never);
}
installLocalProviderCloudPreferencePatch(client as never);
installDesktopPermissionsClientPatch(client as never);

// Register custom character editor for app-core's ViewRouter to pick up
window.__ELIZA_CHARACTER_EDITOR__ = CharacterEditor;

import { getStylePresets } from "@elizaos/shared";

// Derive VRM roster from STYLE_PRESETS so character names stay in one place.
const ELIZA_STYLE_PRESETS = getStylePresets();

const ELIZA_VRM_ASSETS = ELIZA_STYLE_PRESETS.slice()
  .sort((a, b) => a.avatarIndex - b.avatarIndex)
  .map((p) => ({ title: p.name, slug: `eliza-${p.avatarIndex}` }));

const elizaBootConfig: AppBootConfig = {
  branding: ELIZA_BRANDING,
  assetBaseUrl:
    (import.meta.env.VITE_ASSET_BASE_URL as string | undefined)?.trim() ||
    undefined,
  cloudApiBase:
    (import.meta.env.VITE_CLOUD_BASE as string) ?? "https://www.elizacloud.ai",
  vrmAssets: ELIZA_VRM_ASSETS,
  onboardingStyles: ELIZA_STYLE_PRESETS,
  characterEditor: CharacterEditor,
  characterCatalog: ELIZA_CHARACTER_CATALOG,
  envAliases: ELIZA_ENV_ALIASES,
  clientMiddleware: {
    forceFreshOnboarding:
      shouldInstallMainWindowOnboardingPatches(windowShellRoute),
    preferLocalProvider: true,
    desktopPermissions: isDesktopPlatform(),
  },
};

setBootConfig(elizaBootConfig);

function dispatchShareTarget(payload: ShareTargetPayload): void {
  if (!window.__ELIZA_SHARE_QUEUE__) {
    window.__ELIZA_SHARE_QUEUE__ = [];
  }
  window.__ELIZA_SHARE_QUEUE__.push(payload);
  dispatchAppEvent(SHARE_TARGET_EVENT, payload);
}

async function initializeAgent(): Promise<void> {
  try {
    const status = await Agent.getStatus();
    dispatchAppEvent(AGENT_READY_EVENT, status);
  } catch (err) {
    console.warn(
      "[Eliza] Agent not available:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function initializePlatform(): Promise<void> {
  await initializeStorageBridge();
  initializeCapacitorBridge();

  if (isIOS || isAndroid) {
    await initializeStatusBar();
    await initializeKeyboard();
    initializeAppLifecycle();
  }

  if (isDesktopPlatform()) {
    await initializeDesktopShell();
  } else {
    await initializeAgent();
  }
}

async function initializeStatusBar(): Promise<void> {
  await StatusBar.setStyle({ style: Style.Dark });

  if (isAndroid) {
    await StatusBar.setOverlaysWebView({ overlay: true });
    await StatusBar.setBackgroundColor({ color: "#0a0a0a" });
  }
}

async function initializeKeyboard(): Promise<void> {
  if (isIOS) {
    await Keyboard.setResizeMode({ mode: KeyboardResize.None });
    await Keyboard.setScroll({ isDisabled: true });
    await Keyboard.setAccessoryBarVisible({ isVisible: true });
  }

  Keyboard.addListener("keyboardWillShow", (info) => {
    document.body.style.setProperty(
      "--keyboard-height",
      `${info.keyboardHeight}px`,
    );
    document.body.classList.add("keyboard-open");
  });

  Keyboard.addListener("keyboardWillHide", () => {
    document.body.style.setProperty("--keyboard-height", "0px");
    document.body.classList.remove("keyboard-open");
  });
}

function initializeAppLifecycle(): void {
  CapacitorApp.addListener("appStateChange", ({ isActive }) => {
    if (isActive) {
      dispatchAppEvent(APP_RESUME_EVENT);
    } else {
      dispatchAppEvent(APP_PAUSE_EVENT);
    }
  });

  CapacitorApp.addListener("backButton", ({ canGoBack }) => {
    if (canGoBack) {
      window.history.back();
    }
  });

  CapacitorApp.addListener("appUrlOpen", ({ url }) => {
    handleDeepLink(url);
  });

  CapacitorApp.getLaunchUrl().then((result) => {
    if (result?.url) {
      handleDeepLink(result.url);
    }
  });
}

function handleDeepLink(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }

  if (parsed.protocol !== "eliza:") return;
  const path = (parsed.pathname || parsed.host || "").replace(/^\/+/, "");

  switch (path) {
    case "chat":
      window.location.hash = "#chat";
      break;
    case "lifeops":
      window.location.hash = "#lifeops";
      dispatchQueuedLifeOpsGithubCallbackFromUrl(url);
      break;
    case "settings":
      window.location.hash = "#settings";
      dispatchQueuedLifeOpsGithubCallbackFromUrl(url);
      break;
    case "connect": {
      const gatewayUrl = parsed.searchParams.get("url");
      if (gatewayUrl) {
        try {
          const validatedUrl = new URL(gatewayUrl);
          if (
            validatedUrl.protocol !== "https:" &&
            validatedUrl.protocol !== "http:"
          ) {
            console.error(
              "[Eliza] Invalid gateway URL protocol:",
              validatedUrl.protocol,
            );
            break;
          }
          dispatchAppEvent(CONNECT_EVENT, {
            gatewayUrl: validatedUrl.href,
          });
        } catch {
          console.error("[Eliza] Invalid gateway URL format");
        }
      }
      break;
    }
    case "share": {
      const title = parsed.searchParams.get("title")?.trim() || undefined;
      const text = parsed.searchParams.get("text")?.trim() || undefined;
      const sharedUrl = parsed.searchParams.get("url")?.trim() || undefined;
      const files = parsed.searchParams
        .getAll("file")
        .map((filePath) => filePath.trim())
        .filter((filePath) => filePath.length > 0)
        .map((filePath) => {
          const slash = Math.max(
            filePath.lastIndexOf("/"),
            filePath.lastIndexOf("\\"),
          );
          const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
          return { name, path: filePath };
        });

      dispatchShareTarget({
        source: "deep-link",
        title,
        text,
        url: sharedUrl,
        files,
      });
      break;
    }
    default:
      console.warn("[Eliza] Unknown deep link path:", path);
      break;
  }
}

async function initializeDesktopShell(): Promise<void> {
  document.body.classList.add("desktop");

  const version = await Desktop.getVersion();
  const desktopNativeReady =
    typeof version.runtime === "string" &&
    version.runtime !== "N/A" &&
    version.runtime !== "unknown";
  if (!desktopNativeReady) return;

  await Desktop.registerShortcut({
    id: "command-palette",
    accelerator: "CommandOrControl+K",
  });

  await Desktop.addListener("shortcutPressed", (event: { id: string }) => {
    if (event.id === "command-palette") {
      dispatchAppEvent(COMMAND_PALETTE_EVENT);
    }
  });

  await Desktop.setTrayMenu({
    menu: [...DESKTOP_TRAY_MENU_ITEMS],
  });

  await Desktop.addListener(
    "trayMenuClick",
    (event: { itemId: string; checked?: boolean }) => {
      dispatchAppEvent(TRAY_ACTION_EVENT, event);
    },
  );

  subscribeDesktopBridgeEvent({
    rpcMessage: "shareTargetReceived",
    ipcChannel: "desktop:shareTargetReceived",
    listener: (payload: unknown) => {
      const url = (payload as { url?: string } | null | undefined)?.url;
      if (typeof url !== "string" || url.trim().length === 0) {
        return;
      }
      handleDeepLink(url);
    },
  });
}

function setupPlatformStyles(): void {
  const root = document.documentElement;
  document.body.classList.add(`platform-${platform}`);

  if (isNative) {
    document.body.classList.add("native");
  }

  root.style.setProperty("--safe-area-top", "env(safe-area-inset-top, 0px)");
  root.style.setProperty(
    "--safe-area-bottom",
    "env(safe-area-inset-bottom, 0px)",
  );
  root.style.setProperty("--safe-area-left", "env(safe-area-inset-left, 0px)");
  root.style.setProperty(
    "--safe-area-right",
    "env(safe-area-inset-right, 0px)",
  );
  root.style.setProperty("--keyboard-height", "0px");
}

function mountReactApp(): void {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("Root element #root not found");

  createRoot(rootEl).render(
    <ErrorBoundary>
      <StrictMode>
        <AppProvider branding={ELIZA_BRANDING}>
          {isDetachedWindowShell(windowShellRoute) ? (
            <div className="flex h-[100dvh] min-h-0 w-full max-w-full flex-col overflow-hidden">
              <DetachedShellRoot route={windowShellRoute} />
            </div>
          ) : (
            <>
              <DesktopOnboardingRuntime />
              <DesktopSurfaceNavigationRuntime />
              <DesktopTrayRuntime />
              <LifeOpsActivitySignalsEffect />
              <App />
            </>
          )}
        </AppProvider>
      </StrictMode>
    </ErrorBoundary>,
  );
}

function isPopoutWindow(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(
    window.location.search || window.location.hash.split("?")[1] || "",
  );
  return params.has("popout");
}

/**
 * Validates an apiBase string and applies it to the boot config.
 * Allows localhost, loopback, HTTPS, and private-network HTTP hosts.
 */
function validateAndSetApiBase(apiBase: string): void {
  try {
    const parsed = new URL(apiBase);
    const host = parsed.hostname;
    const allowPrivateHttp =
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host) ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host.endsWith(".ts.net");
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === window.location.hostname ||
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && allowPrivateHttp)
    ) {
      setBootConfig({ ...getBootConfig(), apiBase });
    } else {
      console.warn("[Eliza] Rejected non-local apiBase:", host);
    }
  } catch {
    if (apiBase.startsWith("/") && !apiBase.startsWith("//")) {
      setBootConfig({ ...getBootConfig(), apiBase });
    } else {
      console.warn("[Eliza] Rejected invalid relative apiBase:", apiBase);
    }
  }
}

function injectPopoutApiBase(): void {
  const params = new URLSearchParams(
    window.location.search || window.location.hash.split("?")[1] || "",
  );
  const apiBase = params.get("apiBase");
  if (apiBase) validateAndSetApiBase(apiBase);
}

function injectDetachedShellApiBase(): void {
  const apiBase = new URLSearchParams(window.location.search).get("apiBase");
  if (apiBase) validateAndSetApiBase(apiBase);
}

function applyStoredDetachedShellTheme(): void {
  applyUiTheme(loadUiTheme());
}

async function main(): Promise<void> {
  setupPlatformStyles();

  try {
    await applyLaunchConnectionFromUrl();
  } catch (err) {
    console.error(
      "[Eliza] Failed to apply managed cloud launch session:",
      err instanceof Error ? err.message : err,
    );
  }

  if (isPopoutWindow()) {
    injectPopoutApiBase();
    mountReactApp();
    return;
  }

  if (isDetachedWindowShell(windowShellRoute)) {
    injectDetachedShellApiBase();
    applyStoredDetachedShellTheme();
    syncDetachedShellLocation(windowShellRoute);
    await initializeStorageBridge();
    initializeCapacitorBridge();
    mountReactApp();
    return;
  }

  mountReactApp();
  await initializePlatform();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}

export {
  isAndroid,
  isDesktopPlatform as isDesktop,
  isIOS,
  isNative,
  isWebPlatform as isWeb,
  platform,
};
