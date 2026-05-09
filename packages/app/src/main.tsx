import { ErrorBoundary } from "@elizaos/ui";
import "@elizaos/app-core";

import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import { Preferences } from "@capacitor/preferences";
import {
  CompanionShell,
  createVectorBrowserRenderer,
  GlobalEmoteOverlay,
  InferenceCloudAlertButton,
  registerCompanionApp,
  resolveCompanionInferenceNotice,
  THREE,
  useCompanionSceneStatus,
} from "@elizaos/app-companion";
import { PhoneCompanionApp } from "@elizaos/app-phone";
import { Agent } from "@elizaos/capacitor-agent";
import { Desktop } from "@elizaos/capacitor-desktop";
import type { DeviceBridgeClient } from "@elizaos/capacitor-llama";
import type { BrandingConfig } from "@elizaos/ui";
import {
  AGENT_READY_EVENT,
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  App,
  type AppBootConfig,
  AppProvider,
  AppWindowRenderer,
  applyForceFreshOnboardingReset,
  applyLaunchConnection,
  applyLaunchConnectionFromUrl,
  applyUiTheme,
  CharacterEditor,
  COMMAND_PALETTE_EVENT,
  CONNECT_EVENT,
  client,
  DESKTOP_TRAY_MENU_ITEMS,
  DesktopOnboardingRuntime,
  DesktopSurfaceNavigationRuntime,
  DesktopTrayRuntime,
  DetachedShellRoot,
  dispatchAppEvent,
  dispatchFocusConnector,
  getBootConfig,
  getWindowNavigationPath,
  initializeCapacitorBridge,
  initializeStorageBridge,
  installDesktopPermissionsClientPatch,
  installForceFreshOnboardingClientPatch,
  installLocalProviderCloudPreferencePatch,
  isAppWindowRoute,
  isDetachedWindowShell,
  isElectrobunRuntime,
  isElizaOS,
  loadUiTheme,
  MOBILE_LOCAL_AGENT_API_BASE,
  MOBILE_RUNTIME_MODE_CHANGED_EVENT,
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  normalizeMobileRuntimeMode,
  preSeedAndroidLocalRuntimeIfFresh,
  resolveWindowShellRoute,
  SHARE_TARGET_EVENT,
  type ShareTargetPayload,
  setBootConfig,
  shouldInstallMainWindowOnboardingPatches,
  subscribeDesktopBridgeEvent,
  syncDetachedShellLocation,
  TRAY_ACTION_EVENT,
} from "@elizaos/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Side-effect: register LifeOps sidebar widgets + client methods on ElizaClient.
import "@elizaos/app-lifeops";
// Side-effect: register coding-agent (task-coordinator) slots so app-core
// slot wrappers (CodingAgentControlChip, PtyConsoleBase, etc.) render the
// real components instead of nulls.
import "@elizaos/app-task-coordinator";
// Side-effect: register game operator surfaces + detail extensions.
import "@elizaos/app-babylon";
import "@elizaos/app-scape";
import "@elizaos/app-hyperscape";
import "@elizaos/app-2004scape";
import "@elizaos/app-defense-of-the-agents";
import "@clawville/app-clawville";
import {
  AppBlockerSettingsCard,
  LifeOpsBrowserSetupPanel as BrowserBridgeSetupPanel,
  dispatchQueuedLifeOpsGithubCallbackFromUrl as dispatchQueuedLifeOpsGithubCallback,
  LifeOpsActivitySignalsEffect,
  LifeOpsPageView,
  WebsiteBlockerSettingsCard,
} from "@elizaos/app-lifeops";
import {
  ApprovalQueue,
  StewardLogo,
  TransactionHistory,
} from "@elizaos/app-steward";
import {
  CodingAgentControlChip,
  CodingAgentSettingsSection,
  CodingAgentTasksPanel,
  PtyConsoleDrawer,
} from "@elizaos/app-task-coordinator";
import { FineTuningView } from "@elizaos/app-training";
import "@elizaos/app-trajectory-logger";
import "@elizaos/app-shopify";
import "@elizaos/app-vincent";
import { useVincentState } from "@elizaos/app-vincent";
import "@elizaos/app-vincent";
// Side-effect: register the wallet UI plugin (route loader, /inventory shell
// page, and chat sidebar wallet-status widget) with the app shell registries.
// Must precede the first shell render.
import "@elizaos/app-wallet/register";
import { shouldUseCloudOnlyBranding } from "@elizaos/ui";
import {
  APP_BRANDING_BASE,
  APP_CONFIG,
  APP_LOG_PREFIX,
  APP_NAMESPACE,
  APP_URL_SCHEME,
} from "./app-config";
import { APP_ENV_ALIASES, APP_ENV_PREFIX } from "./brand-env";
import { APP_CHARACTER_CATALOG } from "./character-catalog";
import {
  apiBaseToDeviceBridgeUrl,
  type IosRuntimeConfig,
  resolveIosRuntimeConfig,
} from "./ios-runtime";

declare global {
  interface Window {
    __ELIZA_APP_SHARE_QUEUE__?: ShareTargetPayload[];
    __ELIZA_APP_CHARACTER_EDITOR__?: typeof CharacterEditor;
    __ELIZA_APP_API_BASE__?: string;
  }
}

const BRANDED_WINDOW_KEYS = {
  apiBase: `__${APP_ENV_PREFIX}_API_BASE__`,
  characterEditor: `__${APP_ENV_PREFIX}_CHARACTER_EDITOR__`,
  shareQueue: `__${APP_ENV_PREFIX}_SHARE_QUEUE__`,
} as const;

function isShareTargetQueue(value: unknown): value is ShareTargetPayload[] {
  return Array.isArray(value);
}

function getInjectedAppApiBase(): string | undefined {
  const brandedApiBase: unknown = Reflect.get(
    window,
    BRANDED_WINDOW_KEYS.apiBase,
  );
  return (
    window.__ELIZA_APP_API_BASE__ ??
    (typeof brandedApiBase === "string" ? brandedApiBase : undefined)
  );
}

const APP_BRANDING: Partial<BrandingConfig> = {
  ...APP_BRANDING_BASE,
  // The hosted web bundle stays cloud-only in production. Desktop shells and
  // other hosts inject an explicit API base before React boots, and that host
  // backend should control onboarding capabilities instead.
  cloudOnly: shouldUseCloudOnlyBranding({
    isDev: import.meta.env.DEV ?? false,
    injectedApiBase:
      typeof window === "undefined" ? undefined : getInjectedAppApiBase(),
    isNativePlatform: Capacitor.isNativePlatform(),
  }),
};

registerCompanionApp();

/**
 * Platform detection utilities
 */
const platform = Capacitor.getPlatform();
const isNative = Capacitor.isNativePlatform();
const isIOS = platform === "ios";
const isAndroid = platform === "android";
const IOS_RUNTIME_ENV_CONFIG = resolveIosRuntimeConfig(import.meta.env);
const DEVICE_BRIDGE_ID_KEY = `${APP_NAMESPACE}_device_bridge_id`;

let mobileDeviceBridgeClient: DeviceBridgeClient | null = null;
let mobileDeviceBridgeStartPromise: Promise<void> | null = null;
let mobileRuntimeModeListenerInstalled = false;

function isDesktopPlatform(): boolean {
  return isElectrobunRuntime();
}

const windowShellRoute = resolveWindowShellRoute();

function hasRuntimePickerOverride(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return getWindowUrlSearchParams().get("runtime") === "picker";
  } catch {
    return false;
  }
}

function getWindowUrlSearchParams(): URLSearchParams {
  const search = window.location?.search ?? "";
  const hashSearch = window.location?.hash?.split("?")[1] ?? "";
  return new URLSearchParams(search || hashSearch);
}

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
  document.documentElement.classList.add(
    "eliza-electrobun-frameless",
    "eliza-electrobun-macos-titlebar",
  );
}

// Dev escape hatch: ?reset forces a truly fresh onboarding session by clearing
// persisted state and temporarily suppressing stale backend resume config.
if (shouldInstallMainWindowOnboardingPatches(windowShellRoute)) {
  applyForceFreshOnboardingReset();
  installForceFreshOnboardingClientPatch(client);
}
installLocalProviderCloudPreferencePatch(client);
installDesktopPermissionsClientPatch(client);

if (isElizaOS() && !hasRuntimePickerOverride()) {
  preSeedAndroidLocalRuntimeIfFresh();
}

// Register custom character editor for app-core's ViewRouter to pick up
window.__ELIZA_APP_CHARACTER_EDITOR__ = CharacterEditor;
Reflect.set(window, BRANDED_WINDOW_KEYS.characterEditor, CharacterEditor);

import { getStylePresets } from "@elizaos/shared";

// Derive VRM roster from STYLE_PRESETS so character names stay in one place.
const APP_STYLE_PRESETS = getStylePresets();

const APP_VRM_ASSETS = APP_STYLE_PRESETS.slice()
  .sort((a, b) => a.avatarIndex - b.avatarIndex)
  .map((p) => ({ title: p.name, slug: `${APP_NAMESPACE}-${p.avatarIndex}` }));

const appBootConfig: AppBootConfig = {
  branding: APP_BRANDING,
  defaultApps: APP_CONFIG.defaultApps,
  assetBaseUrl:
    (import.meta.env.VITE_ASSET_BASE_URL as string | undefined)?.trim() ||
    undefined,
  cloudApiBase: IOS_RUNTIME_ENV_CONFIG.cloudApiBase,
  vrmAssets: APP_VRM_ASSETS,
  onboardingStyles: APP_STYLE_PRESETS,
  characterEditor: CharacterEditor,
  companionShell: CompanionShell,
  resolveCompanionInferenceNotice,
  companionInferenceAlertButton: InferenceCloudAlertButton,
  companionGlobalOverlay: GlobalEmoteOverlay,
  useCompanionSceneStatus,
  companionVectorBrowser: {
    THREE,
    createVectorBrowserRenderer,
  },
  codingAgentTasksPanel: CodingAgentTasksPanel,
  codingAgentSettingsSection: CodingAgentSettingsSection,
  codingAgentControlChip: CodingAgentControlChip,
  ptyConsoleDrawer: PtyConsoleDrawer,
  fineTuningView: FineTuningView,
  useVincentState,
  stewardLogo: StewardLogo,
  stewardApprovalQueue: ApprovalQueue,
  stewardTransactionHistory: TransactionHistory,
  characterCatalog: APP_CHARACTER_CATALOG,
  envAliases: APP_ENV_ALIASES,
  lifeOpsPageView: LifeOpsPageView,
  lifeOpsBrowserSetupPanel: BrowserBridgeSetupPanel,
  appBlockerSettingsCard: AppBlockerSettingsCard,
  websiteBlockerSettingsCard: WebsiteBlockerSettingsCard,
  clientMiddleware: {
    forceFreshOnboarding:
      shouldInstallMainWindowOnboardingPatches(windowShellRoute),
    preferLocalProvider: true,
    desktopPermissions: isDesktopPlatform(),
  },
};

setBootConfig(appBootConfig);

function getShareQueue(): ShareTargetPayload[] {
  const brandedQueue: unknown = Reflect.get(
    window,
    BRANDED_WINDOW_KEYS.shareQueue,
  );
  const existing =
    window.__ELIZA_APP_SHARE_QUEUE__ ??
    (isShareTargetQueue(brandedQueue) ? brandedQueue : undefined);
  if (existing) {
    window.__ELIZA_APP_SHARE_QUEUE__ = existing;
    Reflect.set(window, BRANDED_WINDOW_KEYS.shareQueue, existing);
    return existing;
  }
  const queue: ShareTargetPayload[] = [];
  window.__ELIZA_APP_SHARE_QUEUE__ = queue;
  Reflect.set(window, BRANDED_WINDOW_KEYS.shareQueue, queue);
  return queue;
}

function dispatchShareTarget(payload: ShareTargetPayload): void {
  getShareQueue().push(payload);
  dispatchAppEvent(SHARE_TARGET_EVENT, payload);
}

function logNativePluginUnavailable(pluginName: string, error: unknown): void {
  console.warn(
    `${APP_LOG_PREFIX} ${pluginName} plugin not available:`,
    error instanceof Error ? error.message : error,
  );
}

async function initializeAgent(): Promise<void> {
  try {
    const status = await Agent.getStatus();
    dispatchAppEvent(AGENT_READY_EVENT, status);
  } catch (err) {
    console.warn(
      `${APP_LOG_PREFIX} Agent not available:`,
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
    initializeMobileRuntimeModeListener();
    void initializeMobileDeviceBridge();
  }

  if (isDesktopPlatform()) {
    await initializeDesktopShell();
  } else if (isNative) {
    await initializeAgent();
  }
}

async function initializeStatusBar(): Promise<void> {
  if (!isNative) return;
  // Make the status bar overlay the WebView so the app can render
  // edge-to-edge and `env(safe-area-inset-top)` reports the real status-bar
  // height on both platforms (iOS already does this via the
  // `apple-mobile-web-app-status-bar-style: black-translucent` meta tag;
  // Android needs an explicit opt-in via `setOverlaysWebView`). Imported
  // dynamically so non-mobile bundles don't try to resolve the native
  // plugin's named exports through the vite native stub.
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Dark });
    if (isAndroid) {
      await StatusBar.setOverlaysWebView({ overlay: true });
      await StatusBar.setBackgroundColor({ color: "#00000000" });
    }
  } catch (error) {
    logNativePluginUnavailable("StatusBar", error);
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
  void Promise.resolve(
    CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) {
        dispatchAppEvent(APP_RESUME_EVENT);
      } else {
        dispatchAppEvent(APP_PAUSE_EVENT);
      }
    }),
  ).catch((error) => {
    logNativePluginUnavailable("App", error);
  });

  void Promise.resolve(
    CapacitorApp.addListener("backButton", ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
      }
    }),
  ).catch((error) => {
    logNativePluginUnavailable("App", error);
  });

  void Promise.resolve(
    CapacitorApp.addListener("appUrlOpen", ({ url }) => {
      handleDeepLink(url);
    }),
  ).catch((error) => {
    logNativePluginUnavailable("App", error);
  });

  void CapacitorApp.getLaunchUrl()
    .then((result) => {
      if (result?.url) {
        handleDeepLink(result.url);
      }
    })
    .catch((error) => {
      logNativePluginUnavailable("App", error);
    });
}

function handleDeepLink(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }

  if (parsed.protocol !== `${APP_URL_SCHEME}:`) return;
  const path = getDeepLinkPath(parsed);

  // eliza://settings/connectors/<provider> — open Settings and ask SettingsView
  // to scroll the matching connector panel into view.
  const connectorMatch = path.match(/^settings\/connectors\/([a-z0-9-]+)$/i);
  if (connectorMatch) {
    window.location.hash = "#settings";
    const provider = connectorMatch[1].toLowerCase();
    // Fires the focus event immediately AND stashes `provider` in a module
    // ref. SettingsView drains the stash on mount, so this works whether the
    // settings tab is already mounted (event delivery) or is mounting in
    // response to the hash change above (drain-on-mount).
    dispatchFocusConnector(provider);
    return;
  }

  switch (path) {
    case "chat":
      window.location.hash = "#chat";
      break;
    case "phone":
    case "phone/call":
      setHashRoute("phone", parsed.searchParams);
      break;
    case "messages":
    case "messages/compose":
      setHashRoute("messages", parsed.searchParams);
      break;
    case "contacts":
      setHashRoute("contacts", parsed.searchParams);
      break;
    case "wallet":
    case "inventory":
      setHashRoute("wallet", parsed.searchParams);
      break;
    case "browser":
      setHashRoute("browser", parsed.searchParams);
      break;
    case "lifeops":
      window.location.hash = "#lifeops";
      dispatchQueuedLifeOpsGithubCallback(url);
      break;
    case "settings":
      window.location.hash = "#settings";
      dispatchQueuedLifeOpsGithubCallback(url);
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
              `${APP_LOG_PREFIX} Invalid gateway URL protocol:`,
              validatedUrl.protocol,
            );
            break;
          }
          const token =
            parsed.searchParams.get("token") ??
            parsed.searchParams.get("accessToken") ??
            null;
          const connection = applyLaunchConnection({
            kind: "remote",
            apiBase: validatedUrl.href,
            token,
          });
          dispatchAppEvent(CONNECT_EVENT, {
            gatewayUrl: connection.apiBase,
            token: connection.token ?? undefined,
          });
        } catch {
          console.error(`${APP_LOG_PREFIX} Invalid gateway URL format`);
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
      console.warn(`${APP_LOG_PREFIX} Unknown deep link path:`, path);
      break;
  }
}

function getDeepLinkPath(parsed: URL): string {
  const host = parsed.host.replace(/^\/+|\/+$/g, "");
  const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
  return [host, pathname].filter(Boolean).join("/");
}

function setHashRoute(route: string, params: URLSearchParams): void {
  const query = params.toString();
  window.location.hash = query ? `#${route}?${query}` : `#${route}`;
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
    listener: (payload) => {
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

function isPhoneCompanionMode(): boolean {
  if (typeof window === "undefined") return false;
  return getWindowUrlSearchParams().get("mode") === "companion";
}

function resolveAppWindowSlug(): string | null {
  if (!isAppWindowRoute()) return null;
  const path = getWindowNavigationPath();
  if (!path.startsWith("/apps/")) return null;
  // Take only the first path segment after /apps/. URLs like
  // `/apps/plugins/extra` would otherwise yield a malformed slug
  // ("plugins/extra") that no descriptor can match.
  const slug = path
    .slice("/apps/".length)
    .replace(/[?#].*$/, "")
    .split("/")[0];
  return slug.length > 0 ? slug : null;
}

function mountReactApp(): void {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("Root element #root not found");

  const phoneCompanion = isPhoneCompanionMode();
  const detachedShell = isDetachedWindowShell(windowShellRoute);
  const appWindowSlug = detachedShell ? null : resolveAppWindowSlug();

  createRoot(rootEl).render(
    <ErrorBoundary>
      <StrictMode>
        <AppProvider branding={APP_BRANDING}>
          {phoneCompanion ? (
            <PhoneCompanionApp />
          ) : detachedShell ? (
            <div className="flex h-[100dvh] min-h-0 w-full max-w-full flex-col overflow-hidden">
              <DetachedShellRoot route={windowShellRoute} />
            </div>
          ) : appWindowSlug ? (
            <div className="flex h-[100dvh] min-h-0 w-full max-w-full flex-col overflow-hidden">
              <AppWindowRenderer slug={appWindowSlug} />
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
  return getWindowUrlSearchParams().has("popout");
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
      console.warn(`${APP_LOG_PREFIX} Rejected non-local apiBase:`, host);
    }
  } catch {
    if (apiBase.startsWith("/") && !apiBase.startsWith("//")) {
      setBootConfig({ ...getBootConfig(), apiBase });
    } else {
      console.warn(
        `${APP_LOG_PREFIX} Rejected invalid relative apiBase:`,
        apiBase,
      );
    }
  }
}

function injectPopoutApiBase(): void {
  const apiBase = getWindowUrlSearchParams().get("apiBase");
  if (apiBase) validateAndSetApiBase(apiBase);
}

function injectDetachedShellApiBase(): void {
  const apiBase = getWindowUrlSearchParams().get("apiBase");
  if (apiBase) validateAndSetApiBase(apiBase);
}

function getCurrentIosRuntimeConfig(): IosRuntimeConfig {
  if (typeof window === "undefined") return IOS_RUNTIME_ENV_CONFIG;
  try {
    const mode = normalizeMobileRuntimeMode(
      window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY),
    );
    if (!mode) return IOS_RUNTIME_ENV_CONFIG;
    return { ...IOS_RUNTIME_ENV_CONFIG, mode };
  } catch {
    return IOS_RUNTIME_ENV_CONFIG;
  }
}

function applyBuildTimeIosConnection(): void {
  if (!isNative) return;
  if (!IOS_RUNTIME_ENV_CONFIG.apiBase && !IOS_RUNTIME_ENV_CONFIG.apiToken)
    return;

  const current = getBootConfig();
  const next: AppBootConfig = {
    ...current,
    ...(IOS_RUNTIME_ENV_CONFIG.apiToken
      ? { apiToken: IOS_RUNTIME_ENV_CONFIG.apiToken }
      : {}),
  };
  setBootConfig(next);

  if (IOS_RUNTIME_ENV_CONFIG.apiBase) {
    validateAndSetApiBase(IOS_RUNTIME_ENV_CONFIG.apiBase);
  }
}

async function getOrCreateDeviceBridgeId(): Promise<string> {
  const existing = await Preferences.get({ key: DEVICE_BRIDGE_ID_KEY });
  if (existing.value?.trim()) return existing.value.trim();

  const prefix = isAndroid ? "android" : isIOS ? "ios" : "mobile";
  const generated =
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  await Preferences.set({ key: DEVICE_BRIDGE_ID_KEY, value: generated });
  return generated;
}

function resolveDeviceBridgeUrl(config: IosRuntimeConfig): string | null {
  if (config.deviceBridgeUrl) {
    return config.deviceBridgeUrl;
  }
  // cloud-hybrid: paired phone dials a remote agent via the cloud apiBase.
  // Android local: the foreground agent service owns the loopback API and the
  // WebView dials its device bridge for native llama.cpp calls.
  // iOS local: requests are handled by the in-process ITTP route kernel, so a
  // loopback WebSocket bridge is both unnecessary and unsafe in simulator runs
  // where host-level adb port forwarding can expose another device's agent.
  if (config.mode === "local" && isIOS) return null;
  if (config.mode === "local" && isAndroid) {
    return apiBaseToDeviceBridgeUrl(MOBILE_LOCAL_AGENT_API_BASE);
  }
  if (config.mode !== "cloud-hybrid" && config.mode !== "local") return null;
  const apiBase = getBootConfig().apiBase?.trim();
  if (!apiBase) return null;
  try {
    return apiBaseToDeviceBridgeUrl(apiBase);
  } catch {
    return null;
  }
}

async function initializeMobileDeviceBridge(): Promise<void> {
  const runtimeConfig = getCurrentIosRuntimeConfig();
  if (
    !isNative ||
    (runtimeConfig.mode !== "cloud-hybrid" && runtimeConfig.mode !== "local")
  ) {
    return;
  }
  if (mobileDeviceBridgeClient) return;
  if (mobileDeviceBridgeStartPromise) return;

  const agentUrl = resolveDeviceBridgeUrl(runtimeConfig);
  if (!agentUrl) return;

  mobileDeviceBridgeStartPromise = (async () => {
    try {
      const [{ startDeviceBridgeClient }, deviceId] = await Promise.all([
        import("@elizaos/capacitor-llama"),
        getOrCreateDeviceBridgeId(),
      ]);
      mobileDeviceBridgeClient = startDeviceBridgeClient({
        agentUrl,
        ...(runtimeConfig.deviceBridgeToken
          ? { pairingToken: runtimeConfig.deviceBridgeToken }
          : {}),
        deviceId,
        onStateChange: (state, detail) => {
          console.info(
            `${APP_LOG_PREFIX} Device bridge ${state}`,
            detail ?? "",
          );
        },
      });
    } catch (error) {
      console.warn(
        `${APP_LOG_PREFIX} Device bridge unavailable:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      mobileDeviceBridgeStartPromise = null;
    }
  })();

  await mobileDeviceBridgeStartPromise;
}

function stopMobileDeviceBridge(): void {
  mobileDeviceBridgeClient?.stop();
  mobileDeviceBridgeClient = null;
}

function initializeMobileRuntimeModeListener(): void {
  if (!isNative || mobileRuntimeModeListenerInstalled) return;
  mobileRuntimeModeListenerInstalled = true;
  document.addEventListener(MOBILE_RUNTIME_MODE_CHANGED_EVENT, () => {
    const mode = getCurrentIosRuntimeConfig().mode;
    if (mode === "cloud-hybrid" || mode === "local") {
      stopMobileDeviceBridge();
      void initializeMobileDeviceBridge();
      return;
    }
    stopMobileDeviceBridge();
  });
}

function applyStoredDetachedShellTheme(): void {
  applyUiTheme(loadUiTheme());
}

async function main(): Promise<void> {
  setupPlatformStyles();
  applyBuildTimeIosConnection();

  try {
    await applyLaunchConnectionFromUrl();
  } catch (err) {
    console.error(
      `${APP_LOG_PREFIX} Failed to apply managed cloud launch session:`,
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

export { isAndroid, isDesktopPlatform as isDesktop, isIOS, isNative, platform };
