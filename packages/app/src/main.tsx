import { ErrorBoundary } from "@elizaos/ui";
import "@elizaos/ui/styles";
import "@elizaos/app-core";

import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import { Preferences } from "@capacitor/preferences";
import { BackgroundRunner } from "@capacitor-community/background-runner";
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
import { ELIZA_DEFAULT_THEME } from "@elizaos/shared";
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
  DesktopSurfaceNavigationRuntime,
  DesktopTrayRuntime,
  DetachedShellRoot,
  dispatchAppEvent,
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
  NETWORK_STATUS_CHANGE_EVENT,
  type NetworkStatusChangeDetail,
  normalizeMobileRuntimeMode,
  preSeedAndroidLocalRuntimeIfFresh,
  resolveWindowShellRoute,
  routeOnboardingDeepLink,
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
import "@elizaos/app-clawville";
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
import "@elizaos/app-hyperliquid";
import "@elizaos/app-polymarket";
// Side-effect: register the wallet UI plugin (route loader, /inventory shell
// page, and chat sidebar wallet-status widget) with the app shell registries.
// Must precede the first shell render.
import "@elizaos/app-wallet";
// Side-effect: register the AOSP-only Phone / Contacts / Messages / Device
// Settings / WiFi overlay apps.
// Each `register` module gates itself on `isElizaOS()` so stock Android, iOS,
// desktop, and web bundles bring the modules in without registering anything.
// On Eliza-derived AOSP images (ElizaOS or a white-label fork) the corresponding
// overlay app shows up in the apps catalog and is launchable as a system
// surface. `@elizaos/app-phone` already side-effect-registers via the
// `PhoneCompanionApp` named import above, but the explicit imports here keep
// these apps symmetric and survive a future barrel cleanup that drops
// `register.js` from the package index.
import "@elizaos/app-contacts/register";
import "@elizaos/app-device-settings/register";
import "@elizaos/app-messages/register";
import "@elizaos/app-phone/register";
import "@elizaos/app-wifi/register";
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
  theme: ELIZA_DEFAULT_THEME,
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
const BACKGROUND_RUNNER_LABEL = "eliza-tasks";
const BACKGROUND_RUNNER_CONFIG_RETRY_MS = 5_000;
const IOS_FULL_BUN_SMOKE_REQUEST_KEY = "eliza:ios-full-bun-smoke:request";
const IOS_FULL_BUN_SMOKE_RESULT_KEY = "eliza:ios-full-bun-smoke:result";

let mobileDeviceBridgeClient: DeviceBridgeClient | null = null;
let mobileDeviceBridgeStartPromise: Promise<void> | null = null;
let mobileRuntimeModeListenerInstalled = false;
let keyboardListenersRegistered = false;
let lifecycleListenersRegistered = false;
let networkStatusListenerRegistered = false;

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
  // Companion public assets are shipped as eliza-*.vrm.gz even in the Eliza
  // branded shell; keep the boot roster aligned with files in dist/vrms.
  .map((p) => ({ title: p.name, slug: `eliza-${p.avatarIndex}` }));

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

function parseSmokeJsonBody(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = (value as { body?: unknown }).body;
  if (typeof body !== "string") return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function assertSmokeHttpOk(label: string, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return an object`);
  }
  const status = (value as { status?: unknown }).status;
  if (typeof status !== "number" || status < 200 || status >= 300) {
    throw new Error(`${label} returned HTTP ${String(status ?? "unknown")}`);
  }
}

async function writeIosFullBunSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  const value = JSON.stringify({
    ...result,
    updatedAt: new Date().toISOString(),
  });
  try {
    window.localStorage.setItem(IOS_FULL_BUN_SMOKE_RESULT_KEY, value);
  } catch {
    // Ignore localStorage failures; Preferences is the simulator harness source of truth.
  }
  await Preferences.set({
    key: IOS_FULL_BUN_SMOKE_RESULT_KEY,
    value,
  });
}

async function runIosFullBunSmokeIfRequested(): Promise<void> {
  let requested = false;
  try {
    const request = await Preferences.get({
      key: IOS_FULL_BUN_SMOKE_REQUEST_KEY,
    });
    requested = request.value === "1";
  } catch {
    requested = false;
  }
  if (!requested) {
    try {
      requested =
        window.localStorage.getItem(IOS_FULL_BUN_SMOKE_REQUEST_KEY) === "1";
    } catch {
      requested = false;
    }
  }
  if (!requested) return;

  await writeIosFullBunSmokeResult({
    ok: false,
    phase: "running",
    startedAt: new Date().toISOString(),
  });

  try {
    const { ElizaBunRuntime } = await import("@elizaos/capacitor-bun-runtime");
    const started = await ElizaBunRuntime.start({
      engine: "bun",
      argv: ["bun", "public/agent/agent-bundle.js", "ios-bridge", "--stdio"],
      env: {
        ELIZA_PLATFORM: "ios",
        ELIZA_MOBILE_PLATFORM: "ios",
        ELIZA_IOS_LOCAL_BACKEND: "1",
        ELIZA_IOS_FULL_BUN_SMOKE: "1",
        ELIZA_HEADLESS: "1",
        ELIZA_API_BIND: "127.0.0.1",
        LOG_LEVEL: "error",
      },
    });
    if (!started.ok) {
      throw new Error(
        started.error ?? "ElizaBunRuntime.start returned ok=false",
      );
    }

    const status = await ElizaBunRuntime.getStatus();
    if (!status.ready || status.engine !== "bun") {
      throw new Error(
        `ElizaBunRuntime status was ready=${String(status.ready)} engine=${status.engine ?? "unknown"}`,
      );
    }

    const bridgeStatus = await ElizaBunRuntime.call({
      method: "status",
      args: { timeoutMs: 60_000 },
    });
    const health = await ElizaBunRuntime.call({
      method: "http_request",
      args: {
        method: "GET",
        path: "/api/health",
        headers: { accept: "application/json" },
        timeoutMs: 120_000,
      },
    });
    assertSmokeHttpOk("full Bun /api/health", health.result);
    const healthJson = parseSmokeJsonBody(health.result) as {
      ready?: unknown;
      runtime?: unknown;
    } | null;
    if (
      !healthJson ||
      healthJson.ready !== true ||
      healthJson.runtime !== "ok"
    ) {
      throw new Error(
        `full Bun /api/health returned unexpected body: ${JSON.stringify(healthJson)}`,
      );
    }

    const fetchHealthResponse = await fetch(
      `${MOBILE_LOCAL_AGENT_API_BASE}/api/health`,
      { headers: { accept: "application/json" } },
    );
    if (!fetchHealthResponse.ok) {
      throw new Error(
        `WebView fetch bridge /api/health returned HTTP ${fetchHealthResponse.status}`,
      );
    }
    const fetchHealth = (await fetchHealthResponse.json()) as {
      ready?: unknown;
      runtime?: unknown;
    };
    if (fetchHealth.ready !== true || fetchHealth.runtime !== "ok") {
      throw new Error(
        `WebView fetch bridge /api/health returned unexpected body: ${JSON.stringify(fetchHealth)}`,
      );
    }

    const created = await ElizaBunRuntime.call({
      method: "http_request",
      args: {
        method: "POST",
        path: "/api/conversations",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "iOS Full Bun Smoke" }),
        timeoutMs: 120_000,
      },
    });
    assertSmokeHttpOk("full Bun POST /api/conversations", created.result);
    const createdJson = parseSmokeJsonBody(created.result) as {
      conversation?: { id?: unknown };
    } | null;
    const conversationId = createdJson?.conversation?.id;
    if (typeof conversationId !== "string" || !conversationId) {
      throw new Error("full Bun conversation create did not return an id");
    }

    const sendMessage = await ElizaBunRuntime.call({
      method: "send_message",
      args: {
        message: "iOS full Bun simulator smoke",
        conversationId,
        metadata: { smoke: "ios-full-bun" },
        timeoutMs: 180_000,
      },
    });

    await writeIosFullBunSmokeResult({
      ok: true,
      phase: "complete",
      finishedAt: new Date().toISOString(),
      runtimeStatus: status,
      bridgeStatus: bridgeStatus.result,
      health: healthJson,
      fetchHealth,
      conversationId,
      sendMessage: sendMessage.result,
    });
  } catch (error) {
    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      window.localStorage.removeItem(IOS_FULL_BUN_SMOKE_REQUEST_KEY);
    } catch {
      // Ignore localStorage failures; Preferences removal below is authoritative.
    }
    await Preferences.remove({ key: IOS_FULL_BUN_SMOKE_REQUEST_KEY });
  }
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
  void runIosFullBunSmokeIfRequested();

  if (isIOS || isAndroid) {
    await initializeStatusBar();
    await initializeKeyboard();
    initializeAppLifecycle();
    initializeMobileRuntimeModeListener();
    void initializeNetworkListener();
    void initializeMobileDeviceBridge();
  }

  if (isDesktopPlatform()) {
    await initializeDesktopShell();
  } else if (isNative) {
    await initializeAgent();
  }

  if (isIOS || isAndroid) {
    void configureMobileBackgroundRunner();
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
  if (keyboardListenersRegistered) return;

  if (isIOS) {
    await Keyboard.setResizeMode({ mode: KeyboardResize.None });
    await Keyboard.setScroll({ isDisabled: true });
    await Keyboard.setAccessoryBarVisible({ isVisible: true });
  }

  keyboardListenersRegistered = true;
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
  // Each Capacitor listener fires its handler N times if added N times.
  // Vite HMR and any redundant initialization paths re-invoke this function,
  // so guard against duplicate registrations.
  if (lifecycleListenersRegistered) return;
  lifecycleListenersRegistered = true;

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

/**
 * Listen to {@link Network.addListener "networkStatusChange"} and bridge it
 * to {@link NETWORK_STATUS_CHANGE_EVENT} so renderer-side consumers (notably
 * the WebSocket reconnect scheduler in `client-base.ts`) can stop burning
 * backoff attempts during airplane mode.
 *
 * Idempotent: HMR or repeated `initializePlatform()` invocations no-op past
 * the first call (each Capacitor listener fires its handler N times if added
 * N times).
 */
async function initializeNetworkListener(): Promise<void> {
  if (networkStatusListenerRegistered) return;
  networkStatusListenerRegistered = true;
  try {
    const { Network } = await import("@capacitor/network");
    await Network.addListener("networkStatusChange", (status) => {
      const detail: NetworkStatusChangeDetail = { connected: status.connected };
      dispatchAppEvent(NETWORK_STATUS_CHANGE_EVENT, detail);
    });
  } catch (error) {
    networkStatusListenerRegistered = false;
    logNativePluginUnavailable("Network", error);
  }
}

function handleDeepLink(url: string): void {
  if (routeOnboardingDeepLink(url, APP_URL_SCHEME)) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }

  if (parsed.protocol !== `${APP_URL_SCHEME}:`) return;
  const path = getDeepLinkPath(parsed);

  // eliza://settings/connectors/<provider> — open Settings → Connectors.
  // The new Connectors section renders one inline expansion per connector;
  // we no longer scroll/highlight a specific provider panel.
  const connectorMatch = path.match(/^settings\/connectors\/([a-z0-9-]+)$/i);
  if (connectorMatch) {
    window.location.hash = "#connectors";
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
          if (!isTrustedApiBaseUrl(validatedUrl)) {
            console.warn(
              `${APP_LOG_PREFIX} Rejected untrusted gateway URL host:`,
              validatedUrl.hostname,
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

function isTrustedPrivateHttpHost(host: string): boolean {
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".ts.net")
  );
}

function isTrustedApiBaseUrl(parsed: URL): boolean {
  const host = parsed.hostname;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host === window.location.hostname ||
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && isTrustedPrivateHttpHost(host))
  );
}

/**
 * Validates an apiBase string and applies it to the boot config.
 * Allows localhost, loopback, HTTPS, and private-network HTTP hosts.
 */
function validateAndSetApiBase(apiBase: string): void {
  try {
    const parsed = new URL(apiBase);
    if (isTrustedApiBaseUrl(parsed)) {
      setBootConfig({ ...getBootConfig(), apiBase });
    } else {
      console.warn(
        `${APP_LOG_PREFIX} Rejected non-local apiBase:`,
        parsed.hostname,
      );
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

async function readAndroidLocalAgentToken(): Promise<string | undefined> {
  if (!isAndroid) return undefined;
  try {
    const result = await Agent.getLocalAgentToken?.();
    const token = result?.token?.trim();
    return token ? token : undefined;
  } catch {
    return undefined;
  }
}

async function configureMobileBackgroundRunner(retry = 0): Promise<void> {
  if (!isNative || (!isIOS && !isAndroid)) return;

  const runtimeConfig = getCurrentIosRuntimeConfig();
  const bootConfig = getBootConfig();
  const bootApiBase = bootConfig.apiBase?.trim();
  let authToken =
    bootConfig.apiToken?.trim() || runtimeConfig.apiToken?.trim() || undefined;

  if (isAndroid && runtimeConfig.mode === "local") {
    authToken = (await readAndroidLocalAgentToken()) ?? authToken;
  }

  const details: Record<string, unknown> = {
    platform,
    mode: runtimeConfig.mode,
  };
  const apiBase = bootApiBase || runtimeConfig.apiBase?.trim();
  if (apiBase) details.apiBase = apiBase;
  if (authToken) details.authToken = authToken;
  if (isAndroid && runtimeConfig.mode === "local") {
    details.localApiBase = MOBILE_LOCAL_AGENT_API_BASE;
  }
  if (isIOS && runtimeConfig.mode === "local") {
    details.localRouteKernel = "ittp";
  }

  try {
    await BackgroundRunner.dispatchEvent({
      label: BACKGROUND_RUNNER_LABEL,
      event: "configure",
      details,
    });
  } catch (error) {
    console.warn(
      `${APP_LOG_PREFIX} Background runner unavailable:`,
      error instanceof Error ? error.message : error,
    );
  }

  if (isAndroid && runtimeConfig.mode === "local" && !authToken && retry < 2) {
    window.setTimeout(
      () => void configureMobileBackgroundRunner(retry + 1),
      BACKGROUND_RUNNER_CONFIG_RETRY_MS * (retry + 1),
    );
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
      void configureMobileBackgroundRunner();
      return;
    }
    stopMobileDeviceBridge();
    void configureMobileBackgroundRunner();
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

  await initializeStorageBridge();
  mountReactApp();
  await initializePlatform();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}

export { isAndroid, isDesktopPlatform as isDesktop, isIOS, isNative, platform };
