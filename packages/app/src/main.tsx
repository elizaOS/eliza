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
import type {
  IosLocalAgentNativeRequestOptions,
  IosLocalAgentNativeRequestResult,
} from "@elizaos/ui/api/ios-local-agent-transport";
import {
  installIosLocalAgentFetchBridge,
  installIosLocalAgentNativeRequestBridge,
  primeIosFullBunRuntime,
} from "@elizaos/ui/api/ios-local-agent-transport";
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
    __ELIZA_IOS_LOCAL_AGENT_REQUEST__?: (
      options: IosLocalAgentNativeRequestOptions,
    ) => Promise<IosLocalAgentNativeRequestResult>;
    __ELIZA_IOS_LOCAL_AGENT_DEBUG__?: (
      event: Record<string, unknown>,
    ) => void;
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
const IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS = 300_000;
const IOS_FULL_BUN_SMOKE_MESSAGE_TIMEOUT_MS = 600_000;

let mobileDeviceBridgeClient: DeviceBridgeClient | null = null;
let mobileDeviceBridgeStartPromise: Promise<void> | null = null;
let mobileRuntimeModeListenerInstalled = false;
let keyboardListenersRegistered = false;
let lifecycleListenersRegistered = false;
let networkStatusListenerRegistered = false;
let iosFullBunSmokeStarted = false;

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

async function writeIosFullBunSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  const value = JSON.stringify({
    ...result,
    updatedAt: new Date().toISOString(),
  });
  try {
    Storage.prototype.setItem.call(
      window.localStorage,
      IOS_FULL_BUN_SMOKE_RESULT_KEY,
      value,
    );
  } catch {
    // Ignore localStorage failures; Preferences is the simulator harness source of truth.
  }
  await boundedPreferenceWrite(() =>
    Preferences.set({
      key: IOS_FULL_BUN_SMOKE_RESULT_KEY,
      value,
    }),
  );
}

async function boundedPreferenceWrite(
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await Promise.race([
      operation(),
      new Promise((resolve) => window.setTimeout(resolve, 2_000)),
    ]);
  } catch {
    // The storage bridge also issued a fire-and-forget Preferences write from
    // localStorage.setItem. The simulator smoke will keep polling the native
    // defaults domain, but the WebView must not block forever on persistence.
  }
}

async function boundedPreferenceGet(key: string): Promise<string | null> {
  try {
    const result = await Promise.race([
      Preferences.get({ key }),
      new Promise<null>((resolve) => window.setTimeout(resolve, 2_000)),
    ]);
    return result?.value ?? null;
  } catch {
    return null;
  }
}

function renderIosFullBunSmokeStatus(message: string): void {
  try {
    document.body.innerHTML = "";
    const container = document.createElement("main");
    container.style.cssText =
      "min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f8fa;color:#101114;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;text-align:center;";
    const text = document.createElement("div");
    text.style.cssText = "max-width:360px;font-size:16px;line-height:1.45;";
    text.textContent = message;
    container.appendChild(text);
    document.body.appendChild(container);
  } catch {
    // Smoke diagnostics are best-effort.
  }
}

async function fetchIosFullBunSmokeJson<T>(
  label: string,
  path: string,
  init?: RequestInit,
  timeoutMs = IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const method = (init?.method ?? "GET").toString().trim().toUpperCase();
  const body =
    method === "GET" || method === "HEAD"
      ? null
      : typeof init?.body === "string"
        ? init.body
        : init?.body == null
          ? null
          : String(init.body);
  const nativeRequest = window.__ELIZA_IOS_LOCAL_AGENT_REQUEST__;
  let status: number | undefined;
  let text: string | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  await Promise.race([
    (async () => {
      if (typeof nativeRequest === "function") {
        const nativeResponse = await nativeRequest({
          method,
          path,
          headers: Object.fromEntries(headers.entries()),
          body,
          timeoutMs,
        });
        status = nativeResponse.status;
        text = nativeResponse.body;
      } else {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(`${MOBILE_LOCAL_AGENT_API_BASE}${path}`, {
            ...init,
            headers,
            signal: init?.signal ?? controller.signal,
          });
          status = response.status;
          text = await response.text();
        } finally {
          window.clearTimeout(timer);
        }
      }
    })(),
    timeout,
  ]);
  if (typeof status !== "number" || typeof text !== "string") {
    throw new Error(`${label} did not return a complete response`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`${label} returned HTTP ${status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseIosFullBunSmokeHttpJson<T>(label: string, value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return an object`);
  }
  const response = value as { status?: unknown; body?: unknown };
  const status = typeof response.status === "number" ? response.status : 0;
  const body = typeof response.body === "string" ? response.body : "";
  if (status < 200 || status >= 300) {
    throw new Error(`${label} returned HTTP ${status}: ${body.slice(0, 500)}`);
  }
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function withIosFullBunSmokeTimeout<T>(
  label: string,
  timeoutMs: number,
  operation: Promise<T>,
): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      window.setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

async function runIosFullBunSmokeIfRequested(): Promise<boolean> {
  if (iosFullBunSmokeStarted) return true;
  let requested = false;
  try {
    requested =
      window.localStorage.getItem(IOS_FULL_BUN_SMOKE_REQUEST_KEY) === "1";
  } catch {
    requested = false;
  }
  try {
    if (!requested) {
      requested =
        (await boundedPreferenceGet(IOS_FULL_BUN_SMOKE_REQUEST_KEY)) === "1";
    }
  } catch {
    // Keep the localStorage result from the storage bridge hydration.
  }
  if (!requested) return false;
  iosFullBunSmokeStarted = true;
  renderIosFullBunSmokeStatus("Running iOS full Bun backend smoke...");
  window.__ELIZA_IOS_LOCAL_AGENT_DEBUG__ = (event) => {
    void writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      ...event,
    });
  };

  await writeIosFullBunSmokeResult({
    ok: false,
    phase: "running",
    startedAt: new Date().toISOString(),
  });

  try {
    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "bridge-installed",
      hasNativeRequest:
        typeof window.__ELIZA_IOS_LOCAL_AGENT_REQUEST__ === "function",
    });

    const { ElizaBunRuntime } = await import("@elizaos/capacitor-bun-runtime");
    primeIosFullBunRuntime(ElizaBunRuntime);
    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "plugin-imported",
      hasNativeRequest:
        typeof window.__ELIZA_IOS_LOCAL_AGENT_REQUEST__ === "function",
    });

    const started = await withIosFullBunSmokeTimeout(
      "ElizaBunRuntime.start",
      IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
      ElizaBunRuntime.start({
        engine: "bun",
        argv: [
          "bun",
          "--no-install",
          "public/agent/agent-bundle.js",
          "ios-bridge",
          "--stdio",
        ],
        env: {
          ELIZA_PLATFORM: "ios",
          ELIZA_MOBILE_PLATFORM: "ios",
          ELIZA_IOS_LOCAL_BACKEND: "1",
          ELIZA_IOS_BUN_STARTUP_TIMEOUT_MS: "300000",
          ELIZA_IOS_FULL_BUN_SMOKE: "1",
          ELIZA_PGLITE_DISABLE_EXTENSIONS: "0",
          ELIZA_VAULT_BACKEND: "file",
          ELIZA_DISABLE_VAULT_PROFILE_RESOLVER: "1",
          ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP: "1",
          ELIZA_HEADLESS: "1",
          ELIZA_API_BIND: "127.0.0.1",
          LOG_LEVEL: "error",
        },
      }),
    );
    if (!started.ok) {
      throw new Error(started.error ?? "ElizaBunRuntime.start returned ok=false");
    }

    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "runtime-started",
      start: started,
    });

    const status = await withIosFullBunSmokeTimeout(
      "ElizaBunRuntime.getStatus",
      IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
      ElizaBunRuntime.getStatus(),
    );
    if (!status.ready || status.engine !== "bun") {
      throw new Error(
        `ElizaBunRuntime status was ready=${String(status.ready)} engine=${status.engine ?? "unknown"}`,
      );
    }

    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "status-ok",
      runtimeStatus: status,
    });

    const bridgeStatus = await withIosFullBunSmokeTimeout(
      "ElizaBunRuntime.call(status)",
      IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
      ElizaBunRuntime.call({
        method: "status",
        args: { timeoutMs: 120_000 },
      }),
    );

    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "bridge-status-ok",
      runtimeStatus: status,
      bridgeStatus: bridgeStatus.result,
    });

    const directHealthResponse = await withIosFullBunSmokeTimeout(
      "ElizaBunRuntime.call(http_request /api/health)",
      60_000,
      ElizaBunRuntime.call({
        method: "http_request",
        args: {
          method: "GET",
          path: "/api/health",
          headers: { accept: "application/json" },
          timeoutMs: 60_000,
        },
      }),
    );
    const directHealth = parseIosFullBunSmokeHttpJson<{
      ready?: unknown;
      runtime?: unknown;
    }>(
      "Direct full Bun bridge /api/health",
      directHealthResponse.result,
    );
    if (directHealth.ready !== true || directHealth.runtime !== "ok") {
      throw new Error(
        `Direct full Bun bridge /api/health returned unexpected body: ${JSON.stringify(directHealth)}`,
      );
    }

    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "direct-health-ok",
      runtimeStatus: status,
      bridgeStatus: bridgeStatus.result,
      directHealth,
    });

    const fetchHealth = await fetchIosFullBunSmokeJson<{
      ready?: unknown;
      runtime?: unknown;
    }>("WebView fetch bridge /api/health", "/api/health");
    if (fetchHealth.ready !== true || fetchHealth.runtime !== "ok") {
      throw new Error(
        `WebView fetch bridge /api/health returned unexpected body: ${JSON.stringify(fetchHealth)}`,
      );
    }

    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "health-ok",
      runtimeStatus: status,
      bridgeStatus: bridgeStatus.result,
      fetchHealth,
    });

    const created = await fetchIosFullBunSmokeJson<{
      conversation?: { id?: unknown };
    }>("WebView fetch bridge POST /api/conversations", "/api/conversations", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "iOS Full Bun Smoke" }),
    });
    const conversationId = created.conversation?.id;
    if (typeof conversationId !== "string" || !conversationId) {
      throw new Error("full Bun conversation create did not return an id");
    }

    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "conversation-created",
      runtimeStatus: status,
      bridgeStatus: bridgeStatus.result,
      fetchHealth,
      conversationId,
    });

    const sendMessage = await fetchIosFullBunSmokeJson<Record<string, unknown>>(
      "WebView fetch bridge POST /api/conversations/:id/messages",
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "iOS full Bun simulator smoke",
          channelType: "DM",
          source: "ios-local",
          metadata: { smoke: "ios-full-bun" },
        }),
      },
      IOS_FULL_BUN_SMOKE_MESSAGE_TIMEOUT_MS,
    );

    await writeIosFullBunSmokeResult({
      ok: true,
      phase: "complete",
      finishedAt: new Date().toISOString(),
      runtimeStatus: status,
      bridgeStatus: bridgeStatus.result,
      fetchHealth,
      conversationId,
      sendMessage,
    });
  } catch (error) {
    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    delete window.__ELIZA_IOS_LOCAL_AGENT_DEBUG__;
    try {
      window.localStorage.removeItem(IOS_FULL_BUN_SMOKE_REQUEST_KEY);
    } catch {
      // Ignore localStorage failures; Preferences removal below is authoritative.
    }
    await boundedPreferenceWrite(() =>
      Preferences.remove({ key: IOS_FULL_BUN_SMOKE_REQUEST_KEY }),
    );
  }
  return true;
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
          if (!isTrustedDeepLinkApiBaseUrl(validatedUrl)) {
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
            allowPublicHttps: true,
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

function isLoopbackApiHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

function isCurrentOriginHost(host: string): boolean {
  return typeof window !== "undefined" && host === window.location.hostname;
}

function isConfiguredCloudApiHost(host: string): boolean {
  const configured = IOS_RUNTIME_ENV_CONFIG.cloudApiBase;
  if (!configured) return false;
  try {
    return host === new URL(configured).hostname;
  } catch {
    return false;
  }
}

function isTrustedApiBaseUrl(parsed: URL): boolean {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  if (isPopoutWindow() && parsed.protocol === "https:") return true;
  return (
    isLoopbackApiHost(host) ||
    isCurrentOriginHost(host) ||
    (parsed.protocol === "https:" && isConfiguredCloudApiHost(host)) ||
    isTrustedPrivateHttpHost(host)
  );
}

function isTrustedDeepLinkApiBaseUrl(parsed: URL): boolean {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  return (
    isLoopbackApiHost(host) ||
    isCurrentOriginHost(host) ||
    (parsed.protocol === "https:" && isConfiguredCloudApiHost(host)) ||
    isTrustedPrivateHttpHost(host)
  );
}

/**
 * Validates an apiBase string and applies it to the boot config.
 * Allows localhost, loopback, configured cloud, current-origin, and private-network hosts.
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
  if (isIOS) {
    initializeCapacitorBridge();
    installIosLocalAgentNativeRequestBridge();
    installIosLocalAgentFetchBridge();
    if (await runIosFullBunSmokeIfRequested()) {
      return;
    }
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
