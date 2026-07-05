// FIRST side-effect: repair the same-origin WebSocket base for the plain-web
// served bundle before the `client` singleton can dial its socket. The dev
// server injects a desktop-loopback `__ELIZA_WS_BASE__` (ws://127.0.0.1:31337)
// that client-base reads first; on a reverse-proxied web page the socket must
// be same-origin (wss://<host>/ws). No-op on desktop / native. See module.
import "./web-ws-base-fix";
/**
 * Renderer boot entry and composition root for the cross-platform Eliza app
 * shell (web browser, Electrobun desktop, and Capacitor iOS/Android). Runs
 * before React mounts: starts cold-start telemetry, registers host-external
 * view importers, and resolves cloud-only branding from the injected API base
 * / desktop runtime mode.
 *
 * `main()` drives the boot pipeline — embed-iframe session handshake, app-window
 * and model-tester route shortcuts, managed cloud launch connection, the
 * headless iOS full-Bun backend smoke gate, popout and detached/overlay window
 * shells, then the per-platform bridge stack (storage + Capacitor bridges, iOS
 * local-agent fetch/native-request bridges, Android native agent fetch bridge,
 * screen-capture / OCR / voice harnesses) — before mounting the React tree
 * (`@elizaos/ui` App, optionally wrapped by the web-only CloudRouterShell) and
 * running `initializePlatform()` concurrently after paint.
 *
 * Also owns deep-link handling (custom `<scheme>://` + `eliza.app` universal
 * links → hash routes, navigate-view events, or first-run remote connect), the
 * trusted-apiBase / native-WebSocket URL policy (tightened for iOS store + cloud
 * builds; a bearer token is never accepted from an OS deep link), the mobile
 * device bridge + agent tunnel + background runner, and the desktop tray /
 * global-shortcut / chat-overlay wiring. Modules not needed for first paint are
 * deferred onto the idle path. Exports the resolved platform flags.
 */
import { ErrorBoundary } from "@elizaos/ui/components/ui/error-boundary";
import "@elizaos/ui/styles";
// Native-only (ios/android/desktop): register the Eliza Cloud Applications
// dashboard as an in-process app-shell page (`/cloud-apps`) that mounts the
// self-contained NativeAppsStudio. No-op on web, where CloudRouterShell serves
// the same surfaces.
import "./cloud-apps-view";
// Surfaces the renderer build stamp on window.__ELIZA_RENDERER_BUILD__ so the
// running build's identity is observable in-app and assertable on-device (#9309).
import "./renderer-build-stamp";

import { BackgroundRunner } from "@capacitor/background-runner";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import { Preferences } from "@capacitor/preferences";
import {
  buildLocalizedTrayMenu,
  DesktopSurfaceNavigationRuntime,
  DesktopTrayRuntime,
  DetachedShellRoot,
  IOS_FULL_BUN_SMOKE_FAILURE_RE,
} from "@elizaos/app-core";
import {
  installIosLocalAgentFetchBridge,
  installIosLocalAgentNativeRequestBridge,
  primeIosFullBunRuntime,
} from "@elizaos/app-core/api/ios-local-agent-transport";
import { Agent } from "@elizaos/capacitor-agent";
import { Desktop } from "@elizaos/capacitor-desktop";
import type { DeviceBridgeClient } from "@elizaos/capacitor-llama";
import type {
  AppBlockerSettingsCardProps,
  WebsiteBlockerSettingsCardProps,
} from "@elizaos/shared";
import { getStylePresets } from "@elizaos/shared";
import { App } from "@elizaos/ui/App";
import { client } from "@elizaos/ui/api";
import { installAndroidNativeAgentFetchBridge } from "@elizaos/ui/api/android-native-agent-transport";
import {
  isElectrobunRuntime,
  subscribeDesktopBridgeEvent,
} from "@elizaos/ui/bridge";
import { initializeCapacitorBridge } from "@elizaos/ui/bridge/capacitor-bridge";
import {
  initializeStorageBridge,
  setStorageValue,
} from "@elizaos/ui/bridge/storage-bridge";
import { RenderTelemetryProfiler } from "@elizaos/ui/cloud-ui/runtime/render-telemetry";
import { AppWindowRenderer } from "@elizaos/ui/components/apps/AppWindowRenderer";
import { ShellModalityProvider } from "@elizaos/ui/components/ShellModalityProvider";
import { ShellRoleProvider } from "@elizaos/ui/components/ShellRoleProvider";
import type {
  BrandingConfig,
  CodingAgentTasksPanelProps,
  FineTuningViewProps,
} from "@elizaos/ui/config";
import {
  type AppBootConfig,
  getBootConfig,
  setBootConfig,
  shouldUseCloudOnlyBranding,
} from "@elizaos/ui/config";
import {
  AGENT_READY_EVENT,
  COMMAND_PALETTE_EVENT,
  CONNECT_EVENT,
  createNavigateViewEvent,
  dispatchAppEvent,
  MOBILE_RUNTIME_MODE_CHANGED_EVENT,
  SHARE_TARGET_EVENT,
  TRAY_ACTION_EVENT,
} from "@elizaos/ui/events";
import {
  parseFirstRunRemoteConnectDeepLink,
  routeFirstRunDeepLink,
} from "@elizaos/ui/first-run/deep-link-handler";
import {
  IOS_LOCAL_AGENT_IPC_BASE,
  MOBILE_LOCAL_AGENT_API_BASE,
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  normalizeMobileRuntimeMode,
} from "@elizaos/ui/first-run/mobile-runtime-mode";
import { preSeedAndroidLocalRuntimeIfFresh } from "@elizaos/ui/first-run/pre-seed-local-runtime";
import { createTranslator } from "@elizaos/ui/i18n";
import {
  getWindowNavigationPath,
  isAppWindowRoute,
} from "@elizaos/ui/navigation";
import type { ShareTargetPayload } from "@elizaos/ui/platform";
import {
  applyLaunchConnection,
  applyLaunchConnectionFromUrl,
} from "@elizaos/ui/platform/browser-launch";
import { installLocalProviderCloudPreferencePatch } from "@elizaos/ui/platform/cloud-preference-patch";
import { installDesktopPermissionsClientPatch } from "@elizaos/ui/platform/desktop-permissions-client";
import {
  applyForceFreshFirstRunReset,
  installForceFreshFirstRunClientPatch,
} from "@elizaos/ui/platform/first-run-reset";
import {
  isChatOverlayWindowShell,
  isDetachedWindowShell,
  isStandaloneWindowShell,
  resolveWindowShellRoute,
  shouldInstallMainWindowFirstRunPatches,
  syncDetachedShellLocation,
} from "@elizaos/ui/platform/window-shell";
import { AppProvider } from "@elizaos/ui/state";
import { initOcrBridge } from "@elizaos/ui/state/ocr-bridge";
import {
  applyUiTheme,
  loadUiLanguage,
  loadUiThemeMode,
  resolveUiTheme,
} from "@elizaos/ui/state/persistence";
import { initScreenCaptureBridge } from "@elizaos/ui/state/screen-capture-bridge";
import {
  initStartupTrace,
  markStartup,
  measureStartup,
} from "@elizaos/ui/state/startup-telemetry";
import { getChatOverlayHotkey } from "@elizaos/ui/state/useChatOverlayHotkey";
import { ELIZA_DEFAULT_THEME } from "@elizaos/ui/themes";
// biome-ignore lint/correctness/noUnusedImports: classic JSX output in this app bundle expects React in module scope.
import * as React from "react";
import { type ComponentType, lazy, StrictMode, Suspense } from "react";
import ReactDomClient from "react-dom/client";
import {
  APP_BRANDING_BASE,
  APP_CONFIG,
  APP_LOG_PREFIX,
  APP_NAMESPACE,
  APP_URL_SCHEME,
} from "./app-config";
import { renderBootFailure } from "./boot-failure";
import { APP_ENV_ALIASES, APP_ENV_PREFIX } from "./brand-env";
import { APP_CHARACTER_CATALOG } from "./character-catalog";
import { isTrustedAppLink } from "./deep-link-handler";
import {
  buildAssistantLaunchHashRoute,
  type DeepLinkNavigationIntent,
  resolveDeepLinkNavigationIntent,
} from "./deep-link-routing";
import { decideChatOverlayToggle } from "./desktop-hotkey";
import { runEmbedHandshake } from "./embed-bootstrap";
import { registerAppHostExternalImporters } from "./host-externals";
import { runIosAttachmentSmokeIfRequested } from "./ios-attachment-smoke";
import {
  apiBaseToDeviceBridgeUrl,
  type IosRuntimeConfig,
  resolveIosRuntimeConfig,
} from "./ios-runtime";
import { startKeyboardDictationSession } from "./keyboard-dictation";
import {
  createMobileLifecycle,
  type MobileLifecycle,
} from "./mobile-lifecycle";
import {
  SIDE_EFFECT_APP_MODULE_LOADERS,
  type SideEffectAppModuleLoader,
} from "./plugin-registrations";
import { registerViewServiceWorker } from "./sw-registration";

declare const __ELIZA_BUILD_VARIANT__: string | undefined;
// Set by vite.config.ts `define`. `true` for the web/desktop bundle, `false`
// for Capacitor mobile builds so the entire cloud router shell + Steward/wallet
// + public-page chunks tree-shake out of the native bundle.
declare const __ELIZA_WEB_SHELL__: boolean | undefined;

declare global {
  interface Window {
    __ELIZA_APP_SHARE_QUEUE__?: ShareTargetPayload[];
    __ELIZA_APP_API_BASE__?: string;
    __ELIZA_IOS_LOCAL_AGENT_DEBUG__?: (event: Record<string, unknown>) => void;
  }
}

const appModuleCache = new Map<string, Promise<unknown>>();
const { createRoot } = ReactDomClient;
let deferredAppModuleLoadsScheduled = false;

// Renderer cold-start telemetry (#9565). The trace adopts a native-host-injected
// id when present (Electrobun/Capacitor) so one device launch shares a single
// id across the native host trace + this renderer trace + backend boot
// telemetry; otherwise it derives a renderer-local id. `module-eval` is the
// earliest renderer-JS checkpoint after the import graph evaluates.
initStartupTrace();
markStartup("module-eval", { platform: Capacitor.getPlatform() });

// Contribute this build's plugin-owned host-external importers to
// DynamicViewLoader before any view can load. Synchronous + idempotent, so it
// is safe to run at the earliest renderer checkpoint.
registerAppHostExternalImporters();

function cachedDynamicImport<T>(
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const existing = appModuleCache.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = loader();
  appModuleCache.set(key, promise);
  return promise;
}

function importPersonalAssistant() {
  return cachedDynamicImport(
    "@elizaos/plugin-personal-assistant",
    () => import("@elizaos/plugin-personal-assistant"),
  );
}

function importAppPhone() {
  return cachedDynamicImport(
    "@elizaos/plugin-phone",
    () => import("@elizaos/plugin-phone"),
  );
}

function importAppTaskCoordinator() {
  return cachedDynamicImport(
    "@elizaos/plugin-task-coordinator",
    () => import("@elizaos/plugin-task-coordinator"),
  );
}

function importAppTaskCoordinatorRegister() {
  return cachedDynamicImport(
    "@elizaos/plugin-task-coordinator/register",
    () => import("@elizaos/plugin-task-coordinator/register"),
  );
}

function importAppTraining() {
  return cachedDynamicImport(
    "@elizaos/plugin-training",
    () => import("@elizaos/plugin-training"),
  );
}

function lazyNamedComponent<TProps>(
  load: () => Promise<ComponentType<TProps>>,
): ComponentType<TProps> {
  return lazy(async () => ({ default: await load() })) as ComponentType<TProps>;
}

const PhoneCompanionApp = lazyNamedComponent<Record<string, never>>(
  async () => (await importAppPhone()).PhoneCompanionApp,
);
const AppBlockerSettingsCard = lazyNamedComponent<AppBlockerSettingsCardProps>(
  async () => (await importPersonalAssistant()).AppBlockerSettingsCard,
);
const WebsiteBlockerSettingsCard =
  lazyNamedComponent<WebsiteBlockerSettingsCardProps>(
    async () => (await importPersonalAssistant()).WebsiteBlockerSettingsCard,
  );
const CodingAgentControlChip = lazyNamedComponent<Record<string, never>>(
  async () => (await importAppTaskCoordinator()).CodingAgentControlChip,
);
const CodingAgentSettingsSection = lazyNamedComponent<Record<string, never>>(
  async () => (await importAppTaskCoordinator()).CodingAgentSettingsSection,
);
const CodingAgentTasksPanel = lazyNamedComponent<CodingAgentTasksPanelProps>(
  async () => (await importAppTaskCoordinator()).CodingAgentTasksPanel,
);
const FineTuningView = lazyNamedComponent<FineTuningViewProps>(
  async () => (await importAppTraining()).FineTuningView,
);

const BRANDED_WINDOW_KEYS = {
  apiBase: `__${APP_ENV_PREFIX}_API_BASE__`,
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

// Resolve the desktop "cloud-only" runtime-mode signal from whichever path is
// available before React boots. Undefined on web/mobile and on default desktop.
//   - Packaged desktop (electrobun static server): a window global is injected
//     ahead of renderer JS by api-base-owner.injectIntoHtml.
//   - Dev (`dev:desktop`, Vite) and cloud-only renderer builds: exposed as the
//     `VITE_ELIZA_DESKTOP_RUNTIME_MODE` build env, since Vite serves index.html
//     directly and the static-server inject never runs.
function getInjectedDesktopRuntimeMode(): string | undefined {
  if (typeof window !== "undefined") {
    const injected: unknown = Reflect.get(
      window,
      "__ELIZA_DESKTOP_RUNTIME_MODE__",
    );
    if (typeof injected === "string" && injected) return injected;
  }
  const fromEnv = (import.meta.env as Record<string, string | undefined>)
    .VITE_ELIZA_DESKTOP_RUNTIME_MODE;
  return typeof fromEnv === "string" && fromEnv ? fromEnv : undefined;
}

const APP_BRANDING: Partial<BrandingConfig> = {
  ...APP_BRANDING_BASE,
  theme: ELIZA_DEFAULT_THEME,
  // The hosted web bundle stays cloud-only in production. Desktop shells and
  // other hosts inject an explicit API base before React boots, and that host
  // backend should control first-run capabilities instead — UNLESS the desktop
  // shell explicitly opted into cloud-only mode (desktopRuntimeMode === "cloud"),
  // which forces cloud-only regardless of the injected loopback proxy base.
  cloudOnly: shouldUseCloudOnlyBranding({
    isDev: import.meta.env.DEV ?? false,
    injectedApiBase:
      typeof window === "undefined" ? undefined : getInjectedAppApiBase(),
    isNativePlatform: Capacitor.isNativePlatform(),
    desktopRuntimeMode: getInjectedDesktopRuntimeMode(),
  }),
};

const platform = Capacitor.getPlatform();
const isNative = Capacitor.isNativePlatform();
const isIOS = platform === "ios";
const isAndroid = platform === "android";
const isStoreBuild =
  typeof __ELIZA_BUILD_VARIANT__ === "string" &&
  __ELIZA_BUILD_VARIANT__ === "store";
const IOS_RUNTIME_ENV_CONFIG = resolveIosRuntimeConfig(import.meta.env);
const DEVICE_BRIDGE_ID_KEY = `${APP_NAMESPACE}_device_bridge_id`;
const BACKGROUND_RUNNER_LABEL = "eliza-tasks";
const BACKGROUND_RUNNER_CONFIG_RETRY_MS = 5_000;
const IOS_FULL_BUN_SMOKE_REQUEST_KEY = "eliza:ios-full-bun-smoke:request";
const IOS_FULL_BUN_SMOKE_RESULT_KEY = "eliza:ios-full-bun-smoke:result";
const IOS_ONBOARDING_SMOKE_REQUEST_KEY = "eliza:ios-onboarding-smoke:request";
const IOS_ONBOARDING_SMOKE_RESULT_KEY = "eliza:ios-onboarding-smoke:result";
const IOS_AUTH_CALLBACK_SMOKE_REQUEST_KEY = "eliza:auth-callback-smoke:request";
const IOS_AUTH_CALLBACK_SMOKE_RESULT_KEY = "eliza:auth-callback-smoke:result";
const IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY =
  "eliza:ios-onboarding-relaunch-smoke:request";
const IOS_ONBOARDING_RELAUNCH_SMOKE_RESULT_KEY =
  "eliza:ios-onboarding-relaunch-smoke:result";
const IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY =
  "eliza:ios-mixed-content-smoke:request";
const IOS_MIXED_CONTENT_SMOKE_RESULT_KEY =
  "eliza:ios-mixed-content-smoke:result";
const IOS_ONBOARDING_SMOKE_TIMEOUT_MS = 120_000;
const IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS = 300_000;
const IOS_FULL_BUN_SMOKE_MESSAGE_TIMEOUT_MS = 600_000;
const IOS_FULL_BUN_SMOKE_CHAT_TEXT =
  "In one short sentence, confirm the iOS full Bun local backend is running.";
const CLOUD_PAIR_SESSION_TOKEN_KEY = "eliza:cloud-pair:api-token";

let mobileDeviceBridgeClient: DeviceBridgeClient | null = null;
let mobileDeviceBridgeStartPromise: Promise<void> | null = null;
let mobileAgentTunnelListener: PluginListenerHandle | null = null;
let mobileAgentTunnelStartPromise: Promise<void> | null = null;
let mobileRuntimeModeListenerInstalled = false;
let keyboardListenersRegistered = false;
let iosFullBunSmokeStarted = false;
let iosOnboardingSmokeStarted = false;
let iosOnboardingRelaunchSmokeStarted = false;
let iosMixedContentSmokeStarted = false;

function isDesktopPlatform(): boolean {
  return isElectrobunRuntime();
}

const windowShellRoute = resolveWindowShellRoute();

function hasFirstRunRuntimeOverride(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const runtime = getWindowUrlSearchParams().get("runtime");
    return runtime === "first-run";
  } catch {
    // error-policy:J3 unparseable location params — no override requested
    return false;
  }
}

function getWindowUrlSearchParams(): URLSearchParams {
  const search = window.location?.search ?? "";
  const hashSearch = window.location?.hash?.split("?")[1] ?? "";
  return new URLSearchParams(search || hashSearch);
}

function applyRuntimeChooserOverrideFromUrl(): void {
  const params = getWindowUrlSearchParams();
  if (params.get("enableRuntimeChooser") !== "1") {
    return;
  }

  try {
    window.localStorage.setItem("eliza:enable-runtime-chooser", "1");
    removeUrlParameter("enableRuntimeChooser");
  } catch (error) {
    // error-policy:J3 storage/history can be unavailable in constrained webviews; keep booting.
    logger.warn("[App] Failed to persist runtime chooser override", { error });
  }
}

function applyCloudPairSessionToken(): void {
  if (typeof window === "undefined") return;
  try {
    const token = window.sessionStorage
      .getItem(CLOUD_PAIR_SESSION_TOKEN_KEY)
      ?.trim();
    if (!token) return;
    client.setToken(token);
  } catch {
    // error-policy:J4 sessionStorage can be unavailable in hardened browser
    // contexts — the pairing token is simply not adopted
  }
}

/**
 * Adds `eliza-electrobun-frameless` for CSS `-webkit-app-region` (Chromium/CEF).
 * macOS WKWebView move/resize are still driven by native overlays in
 * window-effects.mm; this class mainly marks the shell and helps non-WK engines.
 */
function shouldEnableElectrobunMacWindowDrag(): boolean {
  if (!isElectrobunRuntime() || typeof document === "undefined") return false;
  if (isStandaloneWindowShell(windowShellRoute)) return false;
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

// Dev escape hatch: ?reset forces a truly fresh first-run session by clearing
// persisted state and temporarily suppressing stale backend resume config.
if (shouldInstallMainWindowFirstRunPatches(windowShellRoute)) {
  applyForceFreshFirstRunReset();
  installForceFreshFirstRunClientPatch(client);
}
installLocalProviderCloudPreferencePatch(client);
installDesktopPermissionsClientPatch(client);
applyCloudPairSessionToken();
applyRuntimeChooserOverrideFromUrl();

// NOTE: do not gate on isElizaOS() here — that requires the `ElizaOS/` UA
// marker which only AOSP/branded device images carry, so it excluded the
// stock-phone local sideload build (the on-device-agent APK) and left it stuck
// on cloud onboarding. preSeedAndroidLocalRuntimeIfFresh() self-gates to the
// local Android build (native android + non-cloud build), so it's safe to call
// unconditionally here; it no-ops on iOS/desktop/web and cloud builds.
if (!hasFirstRunRuntimeOverride()) {
  preSeedAndroidLocalRuntimeIfFresh();
}

const APP_STYLE_PRESETS = getStylePresets();

const APP_VRM_ASSETS = APP_STYLE_PRESETS.slice()
  .sort((a, b) => a.avatarIndex - b.avatarIndex)
  .map((p) => ({ title: p.name, slug: `eliza-${p.avatarIndex}` }));

let appModulesInitialized: Promise<void> | null = null;
const SIDE_EFFECT_APP_MODULE_LOAD_CONCURRENCY = 2;

function importSideEffectAppModule(
  key: string,
  loader: () => Promise<unknown>,
) {
  return cachedDynamicImport(key, loader);
}

function scheduleAppModuleIdleWork(work: () => void): void {
  if (typeof window === "undefined") {
    work();
    return;
  }
  const w = window as Window & {
    requestIdleCallback?: (
      cb: () => void,
      options?: { timeout?: number },
    ) => number;
  };
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(work, { timeout: 3_000 });
    return;
  }
  window.setTimeout(work, 50);
}

function scheduleAfterReactPaint(work: () => void): void {
  if (typeof window === "undefined") {
    work();
    return;
  }

  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(work);
    });
    return;
  }

  window.setTimeout(work, 0);
}

function scheduleAppModuleIdleLoads(
  loaders: readonly SideEffectAppModuleLoader[],
): void {
  if (loaders.length === 0) return;
  let nextIndex = 0;
  let activeCount = 0;

  const pump = () => {
    while (
      activeCount < SIDE_EFFECT_APP_MODULE_LOAD_CONCURRENCY &&
      nextIndex < loaders.length
    ) {
      const registration = loaders[nextIndex];
      if (!registration) break;
      const { key, load } = registration;
      nextIndex += 1;
      activeCount += 1;
      void importSideEffectAppModule(key, load)
        // error-policy:J4 deferred enhancement modules — a load failure is
        // logged and the app stays usable without that module
        .catch((error) => {
          console.warn(`${APP_LOG_PREFIX} Failed to load ${key}:`, error);
        })
        .finally(() => {
          activeCount -= 1;
          if (nextIndex < loaders.length) {
            scheduleAppModuleIdleWork(pump);
          }
        });
    }
  };

  scheduleAppModuleIdleWork(pump);
}

function scheduleDeferredAppModuleLoadsAfterPaint(): void {
  if (deferredAppModuleLoadsScheduled) return;
  deferredAppModuleLoadsScheduled = true;

  scheduleAfterReactPaint(() => {
    // These modules register routes, tabs, overlay apps, and feature surfaces,
    // but no component from them is needed to paint the startup shell. Schedule
    // them only after React has had a paint opportunity so idle imports cannot
    // compete with the first visible boot surface.
    scheduleAppModuleIdleLoads(BOOT_CONFIG_DEFERRED_MODULE_LOADERS);
    scheduleAppModuleIdleLoads(SIDE_EFFECT_APP_MODULE_LOADERS);
  });
}

function buildAppBootConfig(): AppBootConfig {
  const current = getBootConfig();

  return {
    ...current,
    branding: APP_BRANDING,
    defaultApps: APP_CONFIG.defaultApps,
    assetBaseUrl:
      (import.meta.env.VITE_ASSET_BASE_URL as string | undefined)?.trim() ||
      undefined,
    cloudApiBase: IOS_RUNTIME_ENV_CONFIG.cloudApiBase,
    vrmAssets: APP_VRM_ASSETS,
    firstRunStyles: APP_STYLE_PRESETS,
    codingAgentTasksPanel: CodingAgentTasksPanel,
    codingAgentSettingsSection: CodingAgentSettingsSection,
    codingAgentControlChip: CodingAgentControlChip,
    fineTuningView: FineTuningView,
    characterCatalog: APP_CHARACTER_CATALOG,
    envAliases: APP_ENV_ALIASES,
    appBlockerSettingsCard: AppBlockerSettingsCard,
    websiteBlockerSettingsCard: WebsiteBlockerSettingsCard,
    clientMiddleware: {
      forceFreshFirstRun:
        shouldInstallMainWindowFirstRunPatches(windowShellRoute),
      preferLocalProvider: true,
      desktopPermissions: isDesktopPlatform(),
    },
  };
}

// App plugins imported for their self-registration side effects (PA HTTP client
// + Blocker cards, task-coordinator surfaces, phone, steward, training) and to
// pre-warm their React.lazy chunks. The boot config
// only references these as React.lazy handles (see buildAppBootConfig), so NONE
// is read synchronously while assembling the config — they must not gate the
// first visible shell (#9565). Deferred onto the idle path like
// SIDE_EFFECT_APP_MODULE_LOADERS; on-demand render still triggers the cached
// import if idle work has not run yet, so no surface can be missed.
const BOOT_CONFIG_DEFERRED_MODULE_LOADERS: readonly SideEffectAppModuleLoader[] =
  [
    {
      key: "@elizaos/plugin-personal-assistant",
      load: importPersonalAssistant,
    },
    { key: "@elizaos/plugin-task-coordinator", load: importAppTaskCoordinator },
    {
      key: "@elizaos/plugin-task-coordinator/register",
      load: importAppTaskCoordinatorRegister,
    },
    { key: "@elizaos/plugin-phone", load: importAppPhone },
    { key: "@elizaos/plugin-training", load: importAppTraining },
  ];

function initializeAppModules(): Promise<void> {
  appModulesInitialized ??= (() => {
    // app-core owns the AppBootConfig singleton and is already evaluated: this
    // module statically imports its desktop bindings, so the whole package
    // loads with the entry chunk before main() runs. A dynamic
    // import("@elizaos/app-core") here would be a runtime no-op, but its
    // escaping namespace would force Rollup to retain every export of the
    // barrel (`export * from "@elizaos/ui/browser"`) in the startup-critical
    // entry chunk (#13187). Everything else exposed through the boot config is
    // a React.lazy handle that loads on render, so its import is deferred onto
    // the idle path instead of gating the first visible shell (#9565).
    setBootConfig(buildAppBootConfig());
    return Promise.resolve();
  })();

  return appModulesInitialized;
}

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
  await writeIosPreferenceSmokeResult(IOS_FULL_BUN_SMOKE_RESULT_KEY, result);
}

async function writeIosOnboardingSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  await writeIosPreferenceSmokeResult(IOS_ONBOARDING_SMOKE_RESULT_KEY, result);
}

async function writeIosOnboardingRelaunchSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  await writeIosPreferenceSmokeResult(
    IOS_ONBOARDING_RELAUNCH_SMOKE_RESULT_KEY,
    result,
  );
}

async function writeIosMixedContentSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  await writeIosPreferenceSmokeResult(
    IOS_MIXED_CONTENT_SMOKE_RESULT_KEY,
    result,
  );
}

async function writeIosAuthCallbackSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  await writeIosPreferenceSmokeResult(
    IOS_AUTH_CALLBACK_SMOKE_RESULT_KEY,
    result,
  );
}

interface AuthCallbackDeepLinkOutcome {
  accepted: boolean;
  classification: "synthetic_callback_rejected";
  reason: string;
}

function rejectOsDeliveredAuthCallback(): AuthCallbackDeepLinkOutcome {
  return {
    accepted: false,
    classification: "synthetic_callback_rejected",
    reason: "os_delivered_auth_callback_rejected",
  };
}

function readActiveServerSessionSnapshot(): string {
  return window.localStorage.getItem("elizaos:active-server") ?? "";
}

async function writeIosPreferenceSmokeResult(
  key: string,
  result: Record<string, unknown>,
): Promise<void> {
  const value = JSON.stringify({
    ...result,
    updatedAt: new Date().toISOString(),
  });
  try {
    Storage.prototype.setItem.call(window.localStorage, key, value);
  } catch {
    // error-policy:J6 best-effort echo — Preferences is the simulator
    // harness source of truth
  }
  await boundedPreferenceWrite(() =>
    Preferences.set({
      key,
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
    // error-policy:J7 smoke-harness diagnostics write — the storage bridge
    // also issued a fire-and-forget Preferences write from
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
    // error-policy:J7 smoke-harness preference probe — a blocked Preferences
    // bridge must not wedge the smoke; the poll loop retries
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
    // error-policy:J7 smoke diagnostics are best-effort — a failed status
    // render must not kill the smoke run
  }
}

function parseIosOnboardingSmokeRequest(raw: string | null): {
  apiBase: string;
} {
  const fallback = { apiBase: "http://127.0.0.1:31338" };
  if (!raw || raw === "1") return fallback;
  try {
    const parsed = JSON.parse(raw) as { apiBase?: unknown };
    return {
      apiBase:
        typeof parsed.apiBase === "string" && parsed.apiBase.trim()
          ? parsed.apiBase.trim()
          : fallback.apiBase,
    };
  } catch {
    // error-policy:J3 corrupt smoke-request blob — run with the defaults
    return fallback;
  }
}

async function readIosMixedContentSmokeRequest(
  fallbackApiBase?: string,
): Promise<{ apiBase: string } | null> {
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(
      IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY,
    );
  } catch {
    // error-policy:J3 unavailable storage reads as "no request"; the
    // Preferences fallback below still serves the simulator harness
    rawRequest = null;
  }
  if (!rawRequest) {
    rawRequest = await boundedPreferenceGet(
      IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY,
    );
  }
  if (!rawRequest && !fallbackApiBase) return null;
  return parseIosOnboardingSmokeRequest(
    rawRequest ?? JSON.stringify({ apiBase: fallbackApiBase }),
  );
}

async function waitForIosOnboardingElement<T extends Element>(
  selector: string,
  options?: { timeoutMs?: number; visible?: boolean },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? IOS_ONBOARDING_SMOKE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastElement: Element | null = null;
  while (Date.now() < deadline) {
    lastElement = document.querySelector(selector);
    if (lastElement) {
      const visible =
        !options?.visible ||
        (lastElement instanceof HTMLElement &&
          lastElement.offsetParent !== null);
      if (visible) return lastElement as T;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for iOS onboarding selector ${selector}${lastElement ? " to become visible" : ""}`,
  );
}

function readIosOnboardingSmokeStorageSnapshot(): Record<
  string,
  string | null
> {
  const keys = [
    "eliza:first-run-complete",
    "eliza:setup:step",
    "eliza:mobile-runtime-mode",
    "elizaos:active-server",
  ];
  return Object.fromEntries(
    keys.map((key) => {
      try {
        return [key, window.localStorage.getItem(key)];
      } catch {
        // error-policy:J7 diagnostics snapshot — an unreadable key reports null
        return [key, null];
      }
    }),
  );
}

async function waitForIosOnboardingSmokeStorageSnapshot(
  apiBase: string,
): Promise<Record<string, string | null>> {
  const deadline = Date.now() + IOS_ONBOARDING_SMOKE_TIMEOUT_MS;
  let snapshot = readIosOnboardingSmokeStorageSnapshot();
  while (Date.now() < deadline) {
    const activeServer = snapshot["elizaos:active-server"];
    if (typeof activeServer === "string" && activeServer.includes(apiBase)) {
      return snapshot;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    snapshot = readIosOnboardingSmokeStorageSnapshot();
  }
  throw new Error(
    `Timed out waiting for iOS onboarding active server ${apiBase}: ${JSON.stringify(snapshot)}`,
  );
}

async function fetchIosMixedContentHealth(apiBase: string): Promise<
  | {
      ok: boolean;
      status: number;
      url: string;
      body: unknown;
    }
  | {
      ok: false;
      status?: number;
      url: string;
      error: string;
    }
> {
  const url = new URL("/api/health", apiBase).href;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await response.clone().json();
    } catch {
      // error-policy:J7 diagnostics preserve status even when body is not JSON
      try {
        body = await response.text();
      } catch {
        // error-policy:J7 diagnostics preserve the health failure without a body
        body = null;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      url,
      body,
    };
  } catch (error) {
    // error-policy:J7 diagnostics preserve the failed health probe for the harness
    return {
      ok: false,
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

async function runIosMixedContentSmokeIfRequested(options?: {
  apiBase?: string;
}): Promise<boolean> {
  if (!isIOS || iosMixedContentSmokeStarted) {
    return iosMixedContentSmokeStarted;
  }
  const request = await readIosMixedContentSmokeRequest(options?.apiBase);
  if (!request) return false;

  iosMixedContentSmokeStarted = true;
  await writeIosMixedContentSmokeResult({
    ok: false,
    phase: "running",
    startedAt: new Date().toISOString(),
    apiBase: request.apiBase,
  });

  const wsConstructorCalls: string[] = [];
  const originalWebSocket = window.WebSocket;
  const clientBaseUrl =
    typeof client.getBaseUrl === "function" ? client.getBaseUrl() : "";
  try {
    window.WebSocket = new Proxy(originalWebSocket, {
      construct(target, args) {
        wsConstructorCalls.push(String(args[0] ?? ""));
        return Reflect.construct(target, args);
      },
    }) as typeof WebSocket;

    client.connectWs();
    const connectionState =
      typeof client.getConnectionState === "function"
        ? client.getConnectionState()
        : null;
    const restHealth = await fetchIosMixedContentHealth(request.apiBase);
    const bodyText = document.body?.innerText ?? "";
    const lostBackendOverlayAbsent =
      !/Lost backend connection/i.test(bodyText) &&
      !document.querySelector('[data-testid="connection-lost-overlay"]');

    await writeIosMixedContentSmokeResult({
      ok:
        restHealth.ok === true &&
        wsConstructorCalls.length === 0 &&
        connectionState?.state === "connected" &&
        lostBackendOverlayAbsent,
      phase: "complete",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      webViewOrigin: window.location.origin,
      webViewProtocol: window.location.protocol,
      clientBaseUrl,
      expectedInsecureWebSocketUrl: new URL(
        "/ws",
        request.apiBase,
      ).href.replace(/^http:/, "ws:"),
      mixedContentWouldBlockWebSocket:
        window.location.protocol === "https:" &&
        request.apiBase.startsWith("http://"),
      webSocketConstructorCalls: wsConstructorCalls,
      connectionState,
      lostBackendOverlayAbsent,
      restHealth,
      storage: readIosOnboardingSmokeStorageSnapshot(),
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the
    // harness result sink
    await writeIosMixedContentSmokeResult({
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      webViewOrigin: window.location.origin,
      clientBaseUrl,
      webSocketConstructorCalls: wsConstructorCalls,
      connectionState:
        typeof client.getConnectionState === "function"
          ? client.getConnectionState()
          : null,
      error: error instanceof Error ? error.message : String(error),
      storage: readIosOnboardingSmokeStorageSnapshot(),
    });
  } finally {
    window.WebSocket = originalWebSocket;
    try {
      window.localStorage.removeItem(IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY);
    } catch {
      // error-policy:J6 best-effort cleanup — Preferences removal below is
      // authoritative for the simulator harness
    }
    await boundedPreferenceWrite(() =>
      Preferences.remove({ key: IOS_MIXED_CONTENT_SMOKE_REQUEST_KEY }),
    );
  }
  return true;
}

async function runIosOnboardingSmokeIfRequested(): Promise<boolean> {
  if (!isIOS || iosOnboardingSmokeStarted) return iosOnboardingSmokeStarted;
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(IOS_ONBOARDING_SMOKE_REQUEST_KEY);
  } catch {
    // error-policy:J3 unavailable storage reads as "no request"; the
    // Preferences fallback below still serves the simulator harness
    rawRequest = null;
  }
  if (!rawRequest) {
    rawRequest = await boundedPreferenceGet(IOS_ONBOARDING_SMOKE_REQUEST_KEY);
  }
  if (!rawRequest) return false;

  iosOnboardingSmokeStarted = true;
  const request = parseIosOnboardingSmokeRequest(rawRequest);
  await writeIosOnboardingSmokeResult({
    ok: false,
    phase: "running",
    startedAt: new Date().toISOString(),
    apiBase: request.apiBase,
  });
  try {
    // WKWebView is not CDP-drivable, and recent iOS simulators can stop
    // `simctl openurl` behind a system "Open in <app>?" confirmation. Drive the
    // same hardened remote-connect handler that the OS deep-link route uses,
    // after React has had a chance to install its CONNECT_EVENT listener.
    await new Promise((resolve) => window.setTimeout(resolve, 750));
    connectFirstRunRemoteDeepLink(request.apiBase);

    // Prove the post-connect surface, decoupled from the onboarding DOM — no
    // remote-address field to fill, resilient to the in-chat redesign.
    const home = await waitForIosOnboardingElement<HTMLElement>(
      '[data-testid="home-launcher-surface"][data-page="home"]',
      { visible: true },
    );
    const composer = await waitForIosOnboardingElement<HTMLElement>(
      '[data-testid="chat-composer-textarea"]',
      { visible: true },
    );

    const onboardingHidden = !document.querySelector(
      '[data-testid="first-run-chat"], [data-testid="startup-first-run-background"]',
    );
    const storage = await waitForIosOnboardingSmokeStorageSnapshot(
      request.apiBase,
    );
    await runIosMixedContentSmokeIfRequested({ apiBase: request.apiBase });

    await writeIosOnboardingSmokeResult({
      ok: true,
      phase: "complete",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      homeVisible: Boolean(home),
      composerVisible: Boolean(composer),
      onboardingHidden,
      storage,
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the
    // harness result sink
    await writeIosOnboardingSmokeResult({
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      error: error instanceof Error ? error.message : String(error),
      storage: readIosOnboardingSmokeStorageSnapshot(),
    });
  } finally {
    try {
      window.localStorage.removeItem(IOS_ONBOARDING_SMOKE_REQUEST_KEY);
    } catch {
      // error-policy:J6 best-effort cleanup — Preferences removal below is
      // authoritative for the simulator harness
    }
    await boundedPreferenceWrite(() =>
      Preferences.remove({ key: IOS_ONBOARDING_SMOKE_REQUEST_KEY }),
    );
  }
  return true;
}

async function runIosOnboardingRelaunchSmokeIfRequested(): Promise<boolean> {
  if (!isIOS || iosOnboardingRelaunchSmokeStarted) {
    return iosOnboardingRelaunchSmokeStarted;
  }
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(
      IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY,
    );
  } catch {
    // error-policy:J3 unavailable storage reads as "no request"; the
    // Preferences fallback below still serves the simulator harness
    rawRequest = null;
  }
  if (!rawRequest) {
    rawRequest = await boundedPreferenceGet(
      IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY,
    );
  }
  if (!rawRequest) return false;

  iosOnboardingRelaunchSmokeStarted = true;
  const request = parseIosOnboardingSmokeRequest(rawRequest);
  await writeIosOnboardingRelaunchSmokeResult({
    ok: false,
    phase: "running",
    startedAt: new Date().toISOString(),
    apiBase: request.apiBase,
  });
  try {
    const home = await waitForIosOnboardingElement<HTMLElement>(
      '[data-testid="home-launcher-surface"][data-page="home"]',
      { visible: true },
    );
    const composer = await waitForIosOnboardingElement<HTMLElement>(
      '[data-testid="chat-composer-textarea"]',
      { visible: true },
    );
    const onboardingHidden = !document.querySelector(
      '[data-testid="first-run-chat"], [data-testid="startup-first-run-background"]',
    );
    const storage = await waitForIosOnboardingSmokeStorageSnapshot(
      request.apiBase,
    );

    await writeIosOnboardingRelaunchSmokeResult({
      ok: true,
      phase: "complete",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      homeVisible: Boolean(home),
      composerVisible: Boolean(composer),
      onboardingHidden,
      storage,
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the
    // harness result sink
    await writeIosOnboardingRelaunchSmokeResult({
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      apiBase: request.apiBase,
      error: error instanceof Error ? error.message : String(error),
      storage: readIosOnboardingSmokeStorageSnapshot(),
    });
  } finally {
    try {
      window.localStorage.removeItem(IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY);
    } catch {
      // error-policy:J6 best-effort cleanup — Preferences removal below is
      // authoritative for the simulator harness
    }
    await boundedPreferenceWrite(() =>
      Preferences.remove({ key: IOS_ONBOARDING_RELAUNCH_SMOKE_REQUEST_KEY }),
    );
  }
  return true;
}

async function fetchIosFullBunSmokeJson<T>(
  label: string,
  path: string,
  init?: RequestInit,
  timeoutMs = IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  let status: number | undefined;
  let text: string | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  await Promise.race([
    (async () => {
      const response = await fetch(path, { ...init, headers });
      status = response.status;
      text = await response.text();
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
    // error-policy:J2 context-adding rethrow
    throw new Error(
      `${label} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function fetchIosFullBunSmokeText(
  label: string,
  path: string,
  init?: RequestInit,
  timeoutMs = IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
): Promise<string> {
  const headers = new Headers(init?.headers);
  let status: number | undefined;
  let text: string | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  await Promise.race([
    (async () => {
      const response = await fetch(path, { ...init, headers });
      status = response.status;
      text = await response.text();
    })(),
    timeout,
  ]);
  if (typeof status !== "number" || typeof text !== "string") {
    throw new Error(`${label} did not return a complete response`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`${label} returned HTTP ${status}: ${text.slice(0, 500)}`);
  }
  return text;
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
    // error-policy:J2 context-adding rethrow
    throw new Error(
      `${label} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function assertSmokeObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return an object`);
  }
  return value as Record<string, unknown>;
}

function assertSmokeArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} did not return an array`);
  }
  return value;
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
    // error-policy:J3 unavailable storage reads as "not requested"; the
    // Preferences read below still serves the simulator harness
    requested = false;
  }
  try {
    if (!requested) {
      requested =
        (await boundedPreferenceGet(IOS_FULL_BUN_SMOKE_REQUEST_KEY)) === "1";
    }
  } catch {
    // error-policy:J4 Preferences unavailable — keep the localStorage
    // result from the storage bridge hydration
  }
  if (!requested) return false;
  iosFullBunSmokeStarted = true;
  try {
    window.localStorage.setItem(IOS_FULL_BUN_SMOKE_REQUEST_KEY, "1");
  } catch {
    // error-policy:J6 best-effort echo — Preferences can request the smoke
    // before localStorage is hydrated
  }
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
        typeof window.__ELIZA_BRIDGE__?.iosLocalAgentRequest === "function",
    });

    const { ElizaBunRuntime } = await import("@elizaos/capacitor-bun-runtime");
    primeIosFullBunRuntime(ElizaBunRuntime);
    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "plugin-imported",
      hasNativeRequest:
        typeof window.__ELIZA_BRIDGE__?.iosLocalAgentRequest === "function",
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
          ELIZA_IOS_BRIDGE_TRANSPORT: "bun-host-ipc",
          LOG_LEVEL: "error",
        },
      }),
    );
    if (!started.ok) {
      throw new Error(
        started.error ?? "ElizaBunRuntime.start returned ok=false",
      );
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
    }>("Direct full Bun bridge /api/health", directHealthResponse.result);
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

    const localInferenceHub = await fetchIosFullBunSmokeJson<
      Record<string, unknown>
    >(
      "WebView fetch bridge /api/local-inference/hub",
      "/api/local-inference/hub",
      undefined,
      IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
    );
    assertSmokeArray(localInferenceHub.catalog, "local-inference hub catalog");
    const hubInstalled = assertSmokeArray(
      localInferenceHub.installed,
      "local-inference hub installed",
    );
    assertSmokeObject(localInferenceHub.active, "local-inference hub active");
    assertSmokeObject(
      localInferenceHub.assignments,
      "local-inference hub assignments",
    );

    const localInferenceProviders = await fetchIosFullBunSmokeJson<
      Record<string, unknown>
    >(
      "WebView fetch bridge /api/local-inference/providers",
      "/api/local-inference/providers",
    );
    const providerList = assertSmokeArray(
      localInferenceProviders.providers,
      "local-inference providers",
    );
    const capacitorProvider = providerList
      .map((provider) =>
        assertSmokeObject(provider, "local-inference provider"),
      )
      .find((provider) => provider.id === "capacitor-llama");
    if (!capacitorProvider) {
      throw new Error(
        "local-inference providers did not include capacitor-llama",
      );
    }
    const slots = assertSmokeArray(
      capacitorProvider.registeredSlots,
      "capacitor-llama registeredSlots",
    );
    if (!slots.includes("TEXT_SMALL") || !slots.includes("TEXT_LARGE")) {
      throw new Error("capacitor-llama did not register TEXT_SMALL/TEXT_LARGE");
    }

    const localInferenceDevice = await fetchIosFullBunSmokeJson<
      Record<string, unknown>
    >(
      "WebView fetch bridge /api/local-inference/device",
      "/api/local-inference/device",
      undefined,
      30_000,
    );
    if (
      localInferenceDevice.enabled !== true ||
      localInferenceDevice.connected !== true ||
      localInferenceDevice.transport !== "bun-host-ipc"
    ) {
      throw new Error(
        `local-inference native bridge returned unexpected status: ${JSON.stringify(localInferenceDevice)}`,
      );
    }
    assertSmokeArray(
      localInferenceDevice.devices,
      "local-inference device list",
    );

    if (hubInstalled.length === 0) {
      throw new Error(
        "local-inference hub had no installed Eliza-1 GGUF model; full-Bun smoke requires a staged local model",
      );
    }

    const firstInstalled = assertSmokeObject(
      hubInstalled[0],
      "local-inference installed model",
    );
    if (typeof firstInstalled.id !== "string" || !firstInstalled.id) {
      throw new Error("local-inference installed model was missing id");
    }
    const activatedModel = await fetchIosFullBunSmokeJson<
      Record<string, unknown>
    >(
      "WebView fetch bridge POST /api/local-inference/active",
      "/api/local-inference/active",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ modelId: firstInstalled.id }),
      },
      IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
    );
    if (
      activatedModel.status !== "ready" ||
      typeof activatedModel.modelPath !== "string" ||
      !activatedModel.modelPath
    ) {
      throw new Error(
        `local-inference active model did not become ready: ${JSON.stringify(activatedModel)}`,
      );
    }

    const [
      localInferenceActive,
      localInferenceInstalled,
      localInferenceRouting,
    ] = await Promise.all([
      fetchIosFullBunSmokeJson<Record<string, unknown>>(
        "WebView fetch bridge /api/local-inference/active",
        "/api/local-inference/active",
      ),
      fetchIosFullBunSmokeJson<Record<string, unknown>>(
        "WebView fetch bridge /api/local-inference/installed",
        "/api/local-inference/installed",
      ),
      fetchIosFullBunSmokeJson<Record<string, unknown>>(
        "WebView fetch bridge /api/local-inference/routing",
        "/api/local-inference/routing",
      ),
    ]);
    assertSmokeArray(
      localInferenceInstalled.models,
      "local-inference installed models",
    );
    assertSmokeArray(
      localInferenceRouting.registrations,
      "local-inference routing registrations",
    );
    assertSmokeObject(
      localInferenceRouting.preferences,
      "local-inference routing preferences",
    );

    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "local-inference-ok",
      runtimeStatus: status,
      bridgeStatus: bridgeStatus.result,
      directHealth,
      fetchHealth,
      localInference: {
        hub: localInferenceHub,
        providers: localInferenceProviders,
        device: localInferenceDevice,
        activatedModel,
        active: localInferenceActive,
        installed: localInferenceInstalled,
        routing: localInferenceRouting,
      },
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
          text: IOS_FULL_BUN_SMOKE_CHAT_TEXT,
          channelType: "DM",
          source: "ios-local",
          metadata: { smoke: "ios-full-bun" },
        }),
      },
      IOS_FULL_BUN_SMOKE_MESSAGE_TIMEOUT_MS,
    );
    const streamMessage = await fetchIosFullBunSmokeText(
      "WebView fetch bridge POST /api/conversations/:id/messages/stream",
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
      {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: IOS_FULL_BUN_SMOKE_CHAT_TEXT,
          channelType: "DM",
          source: "ios-local",
          metadata: { smoke: "ios-full-bun-stream" },
        }),
      },
      IOS_FULL_BUN_SMOKE_MESSAGE_TIMEOUT_MS,
    );
    if (
      !streamMessage.includes('"type":"done"') ||
      IOS_FULL_BUN_SMOKE_FAILURE_RE.test(streamMessage)
    ) {
      throw new Error(
        `full Bun conversation stream returned unusable SSE: ${streamMessage.slice(0, 500)}`,
      );
    }

    await writeIosFullBunSmokeResult({
      ok: true,
      phase: "complete",
      finishedAt: new Date().toISOString(),
      runtimeStatus: status,
      bridgeStatus: bridgeStatus.result,
      fetchHealth,
      localInference: {
        hub: localInferenceHub,
        providers: localInferenceProviders,
        device: localInferenceDevice,
        activatedModel,
        active: localInferenceActive,
        installed: localInferenceInstalled,
        routing: localInferenceRouting,
      },
      conversationId,
      sendMessage,
      streamMessage,
    });
  } catch (error) {
    // error-policy:J1 smoke boundary — the failure is written to the
    // harness result sink
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
      // error-policy:J6 best-effort cleanup — Preferences removal below is
      // authoritative
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
    // error-policy:J4 the native agent plugin is optional (absent on web) —
    // the app runs against a remote agent instead; logged for triage
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
  void runIosOnboardingSmokeIfRequested();
  void runIosOnboardingRelaunchSmokeIfRequested();
  void runIosAttachmentSmokeIfRequested({
    isIOS,
    getApiBaseUrl: () => client.getBaseUrl(),
    getPreference: boundedPreferenceGet,
    removePreference: (key) =>
      boundedPreferenceWrite(() => Preferences.remove({ key })),
    writeResult: writeIosPreferenceSmokeResult,
    waitForElement: waitForIosOnboardingElement,
    readStorageSnapshot: readIosOnboardingSmokeStorageSnapshot,
  });
  // Lazy + iOS-gated: the voice self-test pulls the whole @elizaos/ui/voice
  // graph, which a static import anchors into every web/desktop entry chunk.
  // Non-iOS platforms never ran the smoke anyway (the module self-gates), so
  // they now skip fetching the chunk entirely.
  if (isIOS) {
    void import("./ios-voice-selftest-smoke").then(
      ({ runIosVoiceSelfTestSmokeIfRequested }) =>
        runIosVoiceSelfTestSmokeIfRequested({
          isIOS,
          client,
          getPreference: boundedPreferenceGet,
          removePreference: (key) =>
            boundedPreferenceWrite(() => Preferences.remove({ key })),
          writeResult: writeIosPreferenceSmokeResult,
          readStorageSnapshot: readIosOnboardingSmokeStorageSnapshot,
        }),
    );
  }

  if (isIOS || isAndroid) {
    await initializeStatusBar();
    await initializeKeyboard();
    getMobileLifecycle().initializeAppLifecycle();
    initializeMobileRuntimeModeListener();
    void getMobileLifecycle().initializeNetworkListener();
    void initializeMobileDeviceBridge();
    void initializeMobileAgentTunnel();
    void registerMobileBlockerBackends();
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

/**
 * Register the Capacitor website/app blocker plugins as the native backends of
 * the `@elizaos/plugin-blocker` engine instance loaded in this WebView realm.
 *
 * Without this, the engine falls back to its system hosts-file path, which
 * cannot work inside the iOS/Android app sandbox, so BLOCK is a no-op. The
 * adapters wrap the Capacitor plugins (Safari content blocker / VPN DNS on iOS
 * and Android) and map the engine's call/return shapes onto the plugin API.
 *
 * Process boundary: this wires the engine instance that runs in the WebView's
 * JS realm (the web/PWA build, and any in-WebView engine consumer). On stock
 * native builds the elizaOS runtime — and the engine instance the agent's BLOCK
 * action calls — runs in a SEPARATE bun process, which this registration does
 * not reach; that path still flows WebView→engine over the HTTP route.
 */
async function registerMobileBlockerBackends(): Promise<void> {
  try {
    // MUST be the /native subpath: renderer builds alias the bare
    // `@elizaos/plugin-blocker` specifier to src/register.ts (side-effect
    // only, zero exports), so importing the root here would make both
    // register calls throw and leave mobile BLOCK enforcement dead.
    const [blocker, websiteNative, appNative] = await Promise.all([
      import("@elizaos/plugin-blocker/native"),
      import("@elizaos/capacitor-websiteblocker"),
      import("@elizaos/capacitor-appblocker"),
    ]);
    blocker.registerNativeWebsiteBlockerBackend(
      websiteNative.createNativeWebsiteBlockerBackend(
        websiteNative.WebsiteBlocker,
      ),
    );
    blocker.registerNativeAppBlockerBackend(
      appNative.createNativeAppBlockerBackend(appNative.AppBlocker),
    );
  } catch (error) {
    // error-policy:J4 optional native plugin — absence is a designed degrade
    logNativePluginUnavailable("Blocker backends", error);
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
  // plugin's named exports through the vite native compatibility module.
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Dark });
    if (isAndroid) {
      await StatusBar.setOverlaysWebView({ overlay: true });
      await StatusBar.setBackgroundColor({ color: "#00000000" });
    }
  } catch (error) {
    // error-policy:J4 optional native plugin — absence is a designed degrade
    logNativePluginUnavailable("StatusBar", error);
  }
}

async function initializeKeyboard(): Promise<void> {
  if (keyboardListenersRegistered) return;

  // A Keyboard-bridge throw (pod/plugin skew) must not reject and strand the
  // rest of bootstrap (deep links, hardware back, pause/resume, network) —
  // guard it exactly like the sibling initializeStatusBar.
  try {
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
  } catch (error) {
    // error-policy:J4 optional native plugin — absence is a designed degrade
    logNativePluginUnavailable("Keyboard", error);
  }
}

/**
 * Live Android/Capacitor lifecycle helper. `main.tsx` keeps its own
 * status-bar / keyboard wiring, but the app-lifecycle path (foreground/
 * background events + the `visibilitychange` fallback, the hardware-back
 * contract — `dispatchBackIntent()` first, then `history.back()` /
 * `minimizeApp()` when unhandled (#9148) — and the deep-link bootstrap) and
 * the network listener are delegated here so the extracted module IS the
 * shipped behavior, not a stale duplicate. The network delegation carries the
 * #10472 window `online`/`offline` fallback: before it, the fallback lived
 * only in `mobile-lifecycle.ts` and had zero importers, so on Android — where
 * the Capacitor `Network` plugin can be absent from the WebView bridge — the
 * `networkStatusChange` listener never registered and NETWORK_STATUS_CHANGE_EVENT
 * (consumed by the WebSocket reconnect scheduler) never fired on a connectivity
 * change. Constructed once, lazily, so the factory's per-instance idempotency
 * guard holds across repeated `initializePlatform()` calls.
 */
let mobileLifecycleInstance: MobileLifecycle | null = null;
function getMobileLifecycle(): MobileLifecycle {
  if (!mobileLifecycleInstance) {
    mobileLifecycleInstance = createMobileLifecycle({
      isNative,
      isIOS,
      isAndroid,
      logPrefix: APP_LOG_PREFIX,
      handleDeepLink,
    });
  }
  return mobileLifecycleInstance;
}

// Universal/App-Link hosts whose `https://<host>/<path>` links route into the
// app (paired with the iOS associated-domains entitlement + the Android/web
// `assetlinks.json` + `apple-app-site-association` served from eliza.app).
const APP_LINK_HOSTS = ["eliza.app"];

// Device/desktop "connect to a remote agent at a URL" first-run onboarding:
// `<scheme>://first-run/runtime/remote?api=<url>`. The host (a desktop/cloud
// agent) emits this as a link/QR; opening it on a fresh device connects to that
// remote and lands on home. Routed through the same hardened CONNECT_EVENT path
// as `<scheme>://connect?url=` (trust-policy gated, token never accepted from a
// deep link) but with `completeFirstRun` so it also finishes onboarding.
function connectFirstRunRemoteDeepLink(rawApiBase: string): void {
  let validatedUrl: URL;
  try {
    validatedUrl = new URL(rawApiBase);
  } catch {
    // error-policy:J3 untrusted deep-link input — rejected loudly
    console.error(`${APP_LOG_PREFIX} Invalid first-run remote URL format`);
    return;
  }
  if (validatedUrl.protocol !== "https:" && validatedUrl.protocol !== "http:") {
    console.error(
      `${APP_LOG_PREFIX} Invalid first-run remote URL protocol:`,
      validatedUrl.protocol,
    );
    return;
  }
  if (!isTrustedDeepLinkApiBaseUrl(validatedUrl)) {
    console.warn(
      `${APP_LOG_PREFIX} Rejected untrusted first-run remote host:`,
      validatedUrl.hostname,
    );
    return;
  }
  // SECURITY: never accept a bearer token from an OS-delivered deep link (see
  // the `connect` case below). A pairing-disabled remote that needs a token is
  // connected via the trusted in-app Settings entry instead.
  const connection = applyLaunchConnection({
    kind: "remote",
    apiBase: validatedUrl.href,
    token: null,
  });
  const dispatchConnect = () => {
    dispatchAppEvent(CONNECT_EVENT, {
      gatewayUrl: connection.apiBase,
      completeFirstRun: true,
    });
  };
  const activeServer = JSON.stringify({
    id: `remote:${connection.apiBase}`,
    kind: "remote",
    label: validatedUrl.hostname || "Remote agent",
    apiBase: connection.apiBase,
  });
  // error-policy:J6 best-effort persist — the connect below still lands;
  // only re-selection after restart is lost, and the failure is logged
  void setStorageValue("elizaos:active-server", activeServer).catch((error) => {
    console.warn(
      `${APP_LOG_PREFIX} Failed to persist first-run remote active server:`,
      error,
    );
  });
  dispatchConnect();
}

async function recordIosAuthCallbackSmoke(
  parsed: URL,
  path: string,
  url: string,
  outcome: AuthCallbackDeepLinkOutcome,
  activeServerBefore: string,
): Promise<void> {
  // Record the auth-callback end state on ANY native platform. Pre-#13693 this
  // was iOS-only, so the Android smoke leg had no in-app readback at all (pure
  // `am start` fire-and-forget). Broadening to `isNative` lets the Android
  // smoke read the same Capacitor-Preferences handshake (backed by
  // SharedPreferences) and assert the same end state instead of trusting intent
  // resolution alone. This is a smoke seam: the body no-ops unless the harness
  // has armed the request key, so real users' deep-link handling is unchanged.
  if (!isNative) return;
  let rawRequest: string | null = null;
  try {
    rawRequest = window.localStorage.getItem(
      IOS_AUTH_CALLBACK_SMOKE_REQUEST_KEY,
    );
  } catch {
    rawRequest = null;
  }
  rawRequest ??= await boundedPreferenceGet(
    IOS_AUTH_CALLBACK_SMOKE_REQUEST_KEY,
  );
  if (!rawRequest) return;

  let request: Record<string, unknown> = {};
  try {
    const parsedRequest = JSON.parse(rawRequest);
    if (parsedRequest && typeof parsedRequest === "object") {
      request = parsedRequest as Record<string, unknown>;
    }
  } catch {
    request = { malformedRequest: rawRequest };
  }

  // #13693: assert the AUTH OUTCOME, not just delivery. The security invariant
  // for this handler (see the `connect`/first-run-remote cases above) is that
  // an OS-delivered deep link NEVER establishes or swaps an authenticated
  // session. Compare the real active-server key before/after handling the
  // callback so a pre-authenticated simulator passes when the callback leaves
  // the session untouched, while a regression that authenticates from the deep
  // link flips `sessionChanged=true`.
  let activeServerAfter = "";
  try {
    activeServerAfter = readActiveServerSessionSnapshot();
  } catch (error) {
    // error-policy:J7 diagnostics readback — the smoke must fail closed when it
    // cannot observe the auth outcome it is supposed to prove.
    await writeIosAuthCallbackSmokeResult({
      ok: false,
      phase: "failed",
      classification: outcome.classification,
      accepted: outcome.accepted,
      reason: outcome.reason,
      error:
        error instanceof Error
          ? error.message
          : `active-server readback failed: ${String(error)}`,
      path,
      url,
      state: parsed.searchParams.get("state") ?? "",
      code: parsed.searchParams.get("code") ?? "",
      query: Object.fromEntries(parsed.searchParams.entries()),
      request,
    });
    return;
  }

  await writeIosAuthCallbackSmokeResult({
    ok: true,
    phase: "handled",
    classification: outcome.classification,
    accepted: outcome.accepted,
    reason: outcome.reason,
    sessionEstablished: activeServerAfter.length > 0,
    sessionChanged: activeServerAfter !== activeServerBefore,
    activeServerBeforePresent: activeServerBefore.length > 0,
    activeServerAfterPresent: activeServerAfter.length > 0,
    path,
    url,
    state: parsed.searchParams.get("state") ?? "",
    code: parsed.searchParams.get("code") ?? "",
    query: Object.fromEntries(parsed.searchParams.entries()),
    request,
  });
}

async function handleAuthCallbackDeepLink(
  parsed: URL,
  path: string,
  url: string,
): Promise<void> {
  const outcome = rejectOsDeliveredAuthCallback();
  let activeServerBefore = "";
  try {
    activeServerBefore = readActiveServerSessionSnapshot();
  } catch (error) {
    await writeIosAuthCallbackSmokeResult({
      ok: false,
      phase: "failed",
      classification: outcome.classification,
      accepted: outcome.accepted,
      reason: outcome.reason,
      error:
        error instanceof Error
          ? error.message
          : `active-server pre-readback failed: ${String(error)}`,
      path,
      url,
      state: parsed.searchParams.get("state") ?? "",
      code: parsed.searchParams.get("code") ?? "",
      query: Object.fromEntries(parsed.searchParams.entries()),
    });
    return;
  }

  await recordIosAuthCallbackSmoke(
    parsed,
    path,
    url,
    outcome,
    activeServerBefore,
  );
}

function handleDeepLink(url: string): void {
  const firstRunRemote = parseFirstRunRemoteConnectDeepLink(
    url,
    APP_URL_SCHEME,
  );
  if (firstRunRemote) {
    connectFirstRunRemoteDeepLink(firstRunRemote.apiBase);
    return;
  }
  if (routeFirstRunDeepLink(url, APP_URL_SCHEME)) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // error-policy:J3 untrusted deep-link input — unparseable links are
    // dropped loudly so a broken link is diagnosable
    console.warn(`${APP_LOG_PREFIX} Ignoring unparseable deep link`);
    return;
  }

  // Accept both the custom `<scheme>://` links and `https://eliza.app/<path>`
  // universal/App links (iOS associated-domains + Android assetlinks hand these
  // to the installed app); both route into the same hash routes below.
  const isAppLink = isTrustedAppLink(parsed, APP_LINK_HOSTS);
  if (parsed.protocol !== `${APP_URL_SCHEME}:` && !isAppLink) return;
  const path = isAppLink
    ? parsed.pathname.replace(/^\/+|\/+$/g, "")
    : getDeepLinkPath(parsed);
  if (path === "auth/callback") {
    void handleAuthCallbackDeepLink(parsed, path, url);
    return;
  }

  if (path === "first-run/runtime/remote") {
    const rawApiBase =
      parsed.searchParams.get("api")?.trim() ||
      parsed.searchParams.get("apiBase")?.trim() ||
      parsed.searchParams.get("url")?.trim() ||
      parsed.searchParams.get("host")?.trim();
    if (rawApiBase) {
      connectFirstRunRemoteDeepLink(rawApiBase);
    }
    return;
  }

  // Top-level-surface deep links (settings, wallet, browser, connectors, and
  // the https://eliza.app/<path> universal links that map to them). Dispatched
  // on the in-app `eliza:navigate:view` bus rather than written to
  // `window.location.hash`: on the mobile/Capacitor entrypoint the app is not
  // served over file: and is not an app-window, so the hash is never read for
  // tab navigation (`getWindowNavigationPath` returns `location.pathname`) and
  // the target tab never opened. (Chat-launch deep links below stay on the
  // hash — the always-mounted ContinuousChatOverlay claims the launch payload
  // from the hash directly.)
  const navigationIntent = resolveDeepLinkNavigationIntent(path);
  if (navigationIntent) {
    dispatchDeepLinkNavigation(navigationIntent);
    return;
  }

  const assistantLaunchHashRoute = buildAssistantLaunchHashRoute(
    path,
    parsed.searchParams,
  );
  if (assistantLaunchHashRoute) {
    window.location.hash = assistantLaunchHashRoute;
    return;
  }

  switch (path) {
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
    case "aec-loop":
      // On-device AEC acoustic-loop evidence harness (#11373): the hash route
      // is consumed by installAecLoopHarness's hashchange watcher.
      setHashRoute("aec-loop", parsed.searchParams);
      break;
    case "keyboard-dictation":
      // iOS keyboard app-handoff dictation (#12185): extensions have no mic,
      // so the ElizaKeyboard extension opens the app; record + transcribe
      // here, publish the transcript to the App Group, keyboard inserts it.
      startKeyboardDictationSession(parsed.searchParams);
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
          // SECURITY: never accept a bearer token from an OS-delivered deep
          // link. A crafted `<scheme>://connect?url=…&token=…` would otherwise
          // authenticate the session with an ATTACKER-supplied token against an
          // attacker gateway (full MITM of subsequent agent traffic). No
          // legitimate flow passes a token this way — remote auth goes through
          // the cloudLaunchSession exchange. The host repoint is preserved for
          // the legitimate local-agent connect feature.
          const connection = applyLaunchConnection({
            kind: "remote",
            apiBase: validatedUrl.href,
            token: null,
          });
          dispatchAppEvent(CONNECT_EVENT, {
            gatewayUrl: connection.apiBase,
            token: connection.token ?? undefined,
          });
        } catch {
          // error-policy:J3 untrusted deep-link input — rejected loudly
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
  if (host === APP_CONFIG.appId || host === APP_CONFIG.desktop?.bundleId) {
    return pathname;
  }
  return [host, pathname].filter(Boolean).join("/");
}

function setHashRoute(route: string, params: URLSearchParams): void {
  const query = params.toString();
  window.location.hash = query ? `#${route}?${query}` : `#${route}`;
}

/**
 * Dispatch a top-level-surface deep link on the in-app `eliza:navigate:view`
 * bus (consumed in packages/ui App.tsx: `viewPath` → `tabFromPath` → `setTab`,
 * `subview` → Settings section). This is the platform-agnostic navigation path
 * the rest of the app uses; a raw `window.location.hash` write does not open a
 * tab on the mobile/Capacitor entrypoint (see `resolveDeepLinkNavigationIntent`).
 */
function dispatchDeepLinkNavigation(intent: DeepLinkNavigationIntent): void {
  window.dispatchEvent(createNavigateViewEvent(intent));
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

  // Programmable chat-overlay summon hotkey (#10716). The command palette keeps
  // CommandOrControl+K; this is a distinct, user-configurable global shortcut
  // (default CommandOrControl+Shift+C) that brings the floating chat surface —
  // which on desktop is the main window — to the foreground. Registered only
  // when enabled in Desktop settings.
  const chatOverlayHotkey = getChatOverlayHotkey();
  if (chatOverlayHotkey.enabled) {
    await Desktop.registerShortcut({
      id: "chat-overlay",
      accelerator: chatOverlayHotkey.accelerator,
    });
  }

  // Toggle semantics (#12184): a focused + visible overlay is dismissed
  // (focus returns to the previously active app via the macOS orderOut path);
  // otherwise summon + focus it. Blur does NOT hide the pill — it is a resting
  // surface (unlike the tray popover).
  const summonChatOverlay = async (): Promise<void> => {
    const [{ focused }, { visible }] = await Promise.all([
      Desktop.isWindowFocused(),
      Desktop.isWindowVisible(),
    ]);
    if (decideChatOverlayToggle({ focused, visible }) === "hide") {
      await Desktop.hideWindow();
      return;
    }
    await Desktop.showWindow();
    await Desktop.focusWindow();
  };

  subscribeDesktopBridgeEvent({
    rpcMessage: "desktopShortcutPressed",
    ipcChannel: "desktop:shortcutPressed",
    listener: (payload: unknown) => {
      const id = (payload as { id?: string } | null | undefined)?.id;
      if (id === "command-palette") {
        dispatchAppEvent(COMMAND_PALETTE_EVENT);
      } else if (id === "chat-overlay") {
        void summonChatOverlay();
      }
    },
  });

  await Desktop.setTrayMenu({
    menu: buildLocalizedTrayMenu(createTranslator(loadUiLanguage())),
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

  const chatOverlayShell = isChatOverlayWindowShell(windowShellRoute);
  root.classList.toggle("eliza-chat-overlay-shell", chatOverlayShell);
  document.body.classList.toggle("eliza-chat-overlay-shell", chatOverlayShell);

  // Record the resolved window shell mode once at boot. Detached/overlay
  // windows route on `?shellMode=`; logging it makes a mis-routed surface
  // (e.g. an overlay window that fell back to the full dashboard) obvious in
  // the desktop dev console instead of only visible as a wrong-looking window.
  console.info(
    `[shell] window shell mode: ${windowShellRoute.mode} (search="${
      typeof window !== "undefined" ? window.location.search : ""
    }")`,
  );

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

function shouldLoadModelTesterShellRoute(): boolean {
  const path = getWindowNavigationPath().replace(/[?#].*$/, "");
  return path === "/model-tester" || path === "/model-tester/tui";
}

/**
 * Top-level cloud/public/auth router shell. Web build only — lazy so the chunk
 * (and its react-router / Steward / cloud-provider transitive deps) never lands
 * on the native critical path. The `__ELIZA_WEB_SHELL__` define is a literal
 * `false` in the Capacitor mobile build, so the guarded dynamic import below is
 * statically unreachable there and the bundler drops the whole shell chunk.
 */
const CloudRouterShell = lazy(async () => {
  if (__ELIZA_WEB_SHELL__ !== true) {
    throw new Error("CloudRouterShell is web-build-only");
  }
  // Populate the cloud-route + settings-section registries before the shell
  // mounts and reads `listCloudRoutes()`; without this the registry is empty and
  // no cloud/auth/payment route resolves. Cloud product surfaces come from two
  // sources that register into the SAME process-global registries: the trunk
  // `@elizaos/ui` cloud modules and the standalone `@elizaos/cloud-ui` package
  // (arch #12092 item 23 — the cloud UI's own home). Both imports live inside
  // this `__ELIZA_WEB_SHELL__`-guarded factory, so a cloud-free build drops
  // them statically with no stub alias.
  const [{ registerAllCloudSurfaces }, { registerCloudUiSurfaces }, mod] =
    await Promise.all([
      import("@elizaos/ui/cloud/register-all"),
      import("@elizaos/cloud-ui"),
      import("@elizaos/ui/cloud/shell/CloudRouterShell"),
    ]);
  registerAllCloudSurfaces();
  registerCloudUiSurfaces();
  return { default: mod.CloudRouterShell };
});

/**
 * The shell owns the parametric cloud / public / auth / payment routes and
 * renders the tab/view app as the catch-all. It applies only to the main
 * window on the web platform — native (Capacitor) and the desktop Electrobun
 * shell mount the tab/view app directly with no bundle growth, and the special
 * window shells (phone companion / detached / app window) are never cloud
 * surfaces.
 */
function shouldMountWebShell(): boolean {
  if (__ELIZA_WEB_SHELL__ !== true) return false;
  if (isNative) return false;
  if (isElectrobunRuntime()) return false;
  return true;
}

function mountReactApp(): void {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("Root element #root not found");

  const phoneCompanion = isPhoneCompanionMode();
  const detachedShell = isDetachedWindowShell(windowShellRoute);
  const appWindowSlug = detachedShell ? null : resolveAppWindowSlug();
  const isSpecialWindowShell =
    phoneCompanion || detachedShell || appWindowSlug !== null;

  // The normal main-window tab/view app subtree (the existing default render).
  // Kept verbatim so the tab system is untouched; on the web platform it
  // becomes the router shell's catch-all `appElement`.
  const appSubtree = (
    <>
      <DesktopSurfaceNavigationRuntime />
      <DesktopTrayRuntime />
      {/* #9946: this GUI shell is the single owner of the modality contract,
          so every leaf's detectDomModality() reads one authoritative source.
          #9948: provide the canonical role context once, under AppProvider, so
          any view can gate developer/owner surfaces with useRole/<RoleGate>. */}
      <ShellModalityProvider modality="gui">
        <ShellRoleProvider>
          <App />
        </ShellRoleProvider>
      </ShellModalityProvider>
    </>
  );

  const mainTree =
    shouldMountWebShell() && !isSpecialWindowShell ? (
      <CloudRouterShell
        appElement={
          <AppProvider branding={APP_BRANDING}>{appSubtree}</AppProvider>
        }
      />
    ) : (
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
          appSubtree
        )}
      </AppProvider>
    );

  markStartup("react-mount:start");
  createRoot(rootEl).render(
    <ErrorBoundary>
      <StrictMode>
        <Suspense fallback={null}>
          <RenderTelemetryProfiler id="AppRoot">
            {mainTree}
          </RenderTelemetryProfiler>
        </Suspense>
      </StrictMode>
    </ErrorBoundary>,
  );
  markStartup("react-mount:end");
  measureStartup("react-mount", "react-mount:start", "react-mount:end");
}

function isPopoutWindow(): boolean {
  if (typeof window === "undefined") return false;
  return getWindowUrlSearchParams().has("popout");
}

function isTrustedPrivateHttpHost(host: string): boolean {
  return (
    host === "0.0.0.0" ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "local" ||
    host === "internal" ||
    host === "lan" ||
    host === "ts.net" ||
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
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

/**
 * Dedicated Cloud agents serve their full runtime at a per-agent subdomain
 * (`https://<agentId>.elizacloud.ai`). Trust those HTTPS subdomains so the join
 * flow can connect to a dedicated container's real `/ws` + `/api/conversations`
 * (the full Eliza experience) — the apex `elizacloud.ai` / `api.elizacloud.ai`
 * control-plane hosts are already trusted via `isConfiguredCloudApiHost` /
 * `isCurrentOriginHost`. Caller enforces `protocol === "https:"`.
 */
function isElizaCloudAgentSubdomain(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized.endsWith(".elizacloud.ai") &&
    normalized !== "www.elizacloud.ai" &&
    normalized !== "api.elizacloud.ai" &&
    normalized !== "dev.elizacloud.ai"
  );
}

function isNativeIosStoreBuild(): boolean {
  return isNative && isIOS && isStoreBuild;
}

function isIosLocalAgentIpcUrl(parsed: URL): boolean {
  return parsed.protocol === "eliza-local-agent:" && parsed.hostname === "ipc";
}

function isPrivateOrLoopbackApiHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    isLoopbackApiHost(normalized) ||
    (normalized.includes(":") &&
      (normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        normalized.startsWith("fe80:"))) ||
    isTrustedPrivateHttpHost(normalized)
  );
}

function isNativeIosCloudRuntimeMode(): boolean {
  if (!isNative || !isIOS) return false;
  const mode = getCurrentIosRuntimeConfig().mode;
  return mode === "cloud" || mode === "cloud-hybrid";
}

function usesStrictIosNetworkPolicy(): boolean {
  return isNativeIosStoreBuild() || isNativeIosCloudRuntimeMode();
}

function isTruthyBuildFlag(value: string | boolean | undefined): boolean {
  return value === true || value === "1" || value === "true";
}

function allowsIosSimulatorLoopbackApiBase(parsed: URL): boolean {
  return (
    isNative &&
    isIOS &&
    !isNativeIosStoreBuild() &&
    isTruthyBuildFlag(
      import.meta.env.VITE_ELIZA_IOS_ALLOW_SIMULATOR_LOOPBACK,
    ) &&
    isLoopbackApiHost(parsed.hostname)
  );
}

function canUseIosLocalAgentIpc(): boolean {
  return isNative && isIOS && getCurrentIosRuntimeConfig().mode === "local";
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
    // error-policy:J3 unparseable configured base — fail closed (untrusted)
    return false;
  }
}

function isTrustedApiBaseUrl(parsed: URL): boolean {
  if (isIosLocalAgentIpcUrl(parsed)) return canUseIosLocalAgentIpc();
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  if (usesStrictIosNetworkPolicy()) {
    if (allowsIosSimulatorLoopbackApiBase(parsed)) return true;
    if (parsed.protocol !== "https:" || isPrivateOrLoopbackApiHost(host)) {
      return false;
    }
    return (
      isCurrentOriginHost(host) ||
      isConfiguredCloudApiHost(host) ||
      isElizaCloudAgentSubdomain(host)
    );
  }
  if (isPopoutWindow() && parsed.protocol === "https:") return true;
  return (
    isLoopbackApiHost(host) ||
    isCurrentOriginHost(host) ||
    (parsed.protocol === "https:" && isConfiguredCloudApiHost(host)) ||
    (parsed.protocol === "https:" && isElizaCloudAgentSubdomain(host)) ||
    isTrustedPrivateHttpHost(host)
  );
}

function isTrustedDeepLinkApiBaseUrl(parsed: URL): boolean {
  if (isIosLocalAgentIpcUrl(parsed)) return canUseIosLocalAgentIpc();
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  if (usesStrictIosNetworkPolicy()) {
    if (allowsIosSimulatorLoopbackApiBase(parsed)) return true;
    if (parsed.protocol !== "https:" || isPrivateOrLoopbackApiHost(host)) {
      return false;
    }
    return (
      isCurrentOriginHost(host) ||
      (parsed.protocol === "https:" && isConfiguredCloudApiHost(host)) ||
      (parsed.protocol === "https:" && isElizaCloudAgentSubdomain(host))
    );
  }
  return (
    isLoopbackApiHost(host) ||
    isCurrentOriginHost(host) ||
    (parsed.protocol === "https:" && isConfiguredCloudApiHost(host)) ||
    (parsed.protocol === "https:" && isElizaCloudAgentSubdomain(host)) ||
    isTrustedPrivateHttpHost(host)
  );
}

function isTrustedNativeWebSocketUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return false;
    if (!usesStrictIosNetworkPolicy()) return true;
    return (
      parsed.protocol === "wss:" && !isPrivateOrLoopbackApiHost(parsed.hostname)
    );
  } catch {
    // error-policy:J3 unparseable bridge URL — fail closed (untrusted)
    return false;
  }
}

/**
 * Validates an apiBase string and applies it to the boot config.
 * Allows local dev hosts outside store iOS, configured cloud/current-origin
 * HTTPS, and the iOS in-app local-agent IPC identity.
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
    // error-policy:J3 not an absolute URL — accept only a same-origin
    // relative path, otherwise reject loudly
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
  const params = getWindowUrlSearchParams();
  const apiBase = params.get("apiBase");
  if (apiBase) validateAndSetApiBase(apiBase);
}

function injectWaifuChatAccessToken(): void {
  const params = getWindowUrlSearchParams();
  const waifuAccessToken = params.get("waifu_access_token")?.trim();
  if (waifuAccessToken) {
    setBootConfig({ ...getBootConfig(), apiToken: waifuAccessToken });
    window.history.replaceState(
      window.history.state,
      "",
      removeUrlParameter(window.location.href, "waifu_access_token"),
    );
  }
}

function removeUrlParameter(href: string, parameter: string): URL {
  const nextUrl = new URL(href);
  nextUrl.searchParams.delete(parameter);
  const hashQueryIndex = nextUrl.hash.indexOf("?");
  if (hashQueryIndex >= 0) {
    const hashPath = nextUrl.hash.slice(0, hashQueryIndex);
    const hashParams = new URLSearchParams(
      nextUrl.hash.slice(hashQueryIndex + 1),
    );
    hashParams.delete(parameter);
    const serializedHashParams = hashParams.toString();
    nextUrl.hash = serializedHashParams
      ? `${hashPath}?${serializedHashParams}`
      : hashPath;
  }
  return nextUrl;
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
    // error-policy:J3 unavailable storage — build-time runtime config
    return IOS_RUNTIME_ENV_CONFIG;
  }
}

function applyBuildTimeIosConnection(): void {
  if (!isNative) return;

  const current = getBootConfig();
  const next: AppBootConfig = {
    ...current,
    ...(isIOS && IOS_RUNTIME_ENV_CONFIG.mode === "local"
      ? { apiBase: IOS_LOCAL_AGENT_IPC_BASE }
      : {}),
    ...(IOS_RUNTIME_ENV_CONFIG.apiToken
      ? { apiToken: IOS_RUNTIME_ENV_CONFIG.apiToken }
      : {}),
  };
  setBootConfig(next);

  if (isIOS && IOS_RUNTIME_ENV_CONFIG.mode === "local") return;
  if (!IOS_RUNTIME_ENV_CONFIG.apiBase && !IOS_RUNTIME_ENV_CONFIG.apiToken)
    return;

  if (IOS_RUNTIME_ENV_CONFIG.apiBase) {
    validateAndSetApiBase(IOS_RUNTIME_ENV_CONFIG.apiBase);
  }
}

async function getOrCreateDeviceBridgeId(): Promise<string> {
  // The device-bridge id is a stable per-install identifier, not durable native
  // config. On Android sideloads the Capacitor `Preferences` plugin can report
  // "not implemented on android" — the same condition `mobile-runtime-mode.ts`
  // already tolerates for the runtime-mode store. A hard Preferences dependency
  // here previously rejected the whole device-bridge startup ("Device bridge
  // unavailable: Preferences plugin is not implemented on android"), which left
  // on-device local inference with no connected device to route to. Read and
  // persist through Preferences when it works, but fall back to localStorage,
  // which is always present in the WebView origin and persists across restarts.
  const readPersisted = async (): Promise<string | undefined> => {
    try {
      const fromPrefs = (
        await Preferences.get({ key: DEVICE_BRIDGE_ID_KEY })
      ).value?.trim();
      if (fromPrefs) return fromPrefs;
    } catch {
      // error-policy:J4 Preferences unavailable on this platform — fall
      // through to localStorage
    }
    return (
      globalThis.localStorage?.getItem(DEVICE_BRIDGE_ID_KEY)?.trim() ||
      undefined
    );
  };

  const existing = await readPersisted();
  if (existing) return existing;

  const prefix = isAndroid ? "android" : isIOS ? "ios" : "mobile";
  const generated =
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  try {
    await Preferences.set({ key: DEVICE_BRIDGE_ID_KEY, value: generated });
  } catch {
    // error-policy:J6 Preferences unavailable — localStorage below is the
    // durable fallback
  }
  try {
    globalThis.localStorage?.setItem(DEVICE_BRIDGE_ID_KEY, generated);
  } catch {
    // error-policy:J6 no persistent store available — the id is still
    // usable for this session
  }
  return generated;
}

function resolveDeviceBridgeUrl(config: IosRuntimeConfig): string | null {
  if (config.deviceBridgeUrl) {
    return isTrustedNativeWebSocketUrl(config.deviceBridgeUrl)
      ? config.deviceBridgeUrl
      : null;
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
    const bridgeUrl = apiBaseToDeviceBridgeUrl(apiBase);
    return isTrustedNativeWebSocketUrl(bridgeUrl) ? bridgeUrl : null;
  } catch {
    // error-policy:J3 underivable/untrusted bridge URL — fail closed (no bridge)
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
    // error-policy:J4 bridge probe — tokenless config proceeds and the local
    // agent's 401 surfaces through the request path
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
    details.localApiBase = IOS_LOCAL_AGENT_IPC_BASE;
    details.localRouteKernel =
      runtimeConfig.fullBun || isNativeIosStoreBuild()
        ? "bun-host-ipc"
        : "ittp";
  }

  try {
    await BackgroundRunner.dispatchEvent({
      label: BACKGROUND_RUNNER_LABEL,
      event: "configure",
      details,
    });
  } catch (error) {
    // error-policy:J4 optional native module — absence logged, app degrades
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
      const pairingToken =
        runtimeConfig.deviceBridgeToken?.trim() ||
        (isAndroid && runtimeConfig.mode === "local"
          ? await readAndroidLocalAgentToken()
          : undefined);
      if (isAndroid && runtimeConfig.mode === "local" && !pairingToken) {
        window.setTimeout(
          () => void initializeMobileDeviceBridge(),
          BACKGROUND_RUNNER_CONFIG_RETRY_MS,
        );
        return;
      }
      mobileDeviceBridgeClient = startDeviceBridgeClient({
        agentUrl,
        ...(pairingToken ? { pairingToken } : {}),
        deviceId,
        onStateChange: (state, detail) => {
          console.info(
            `${APP_LOG_PREFIX} Device bridge ${state}`,
            detail ?? "",
          );
        },
      });
    } catch (error) {
      // error-policy:J4 optional native module — absence logged, app degrades
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

async function initializeMobileAgentTunnel(): Promise<void> {
  const runtimeConfig = getCurrentIosRuntimeConfig();
  if (!isNative || (!isIOS && !isAndroid)) return;
  if (runtimeConfig.mode !== "tunnel-to-mobile") return;
  if (mobileAgentTunnelStartPromise) return;
  const relayUrl = runtimeConfig.tunnelRelayUrl;
  if (!relayUrl) {
    console.warn(
      `${APP_LOG_PREFIX} tunnel-to-mobile mode requires VITE_ELIZA_TUNNEL_RELAY_URL`,
    );
    return;
  }
  if (!isTrustedNativeWebSocketUrl(relayUrl)) {
    console.warn(`${APP_LOG_PREFIX} Rejected unsafe mobile tunnel relay URL`);
    return;
  }

  mobileAgentTunnelStartPromise = (async () => {
    try {
      const [{ MobileAgentBridge }, deviceId] = await Promise.all([
        import("@elizaos/capacitor-mobile-agent-bridge"),
        getOrCreateDeviceBridgeId(),
      ]);

      if (!mobileAgentTunnelListener) {
        mobileAgentTunnelListener = await MobileAgentBridge.addListener(
          "stateChange",
          (event) => {
            console.info(
              `${APP_LOG_PREFIX} Mobile agent tunnel ${event.state}`,
              event.reason ?? "",
            );
          },
        );
      }

      const status = await MobileAgentBridge.startInboundTunnel({
        relayUrl,
        deviceId,
        ...(runtimeConfig.tunnelPairingToken
          ? { pairingToken: runtimeConfig.tunnelPairingToken }
          : {}),
        ...(isAndroid
          ? { localAgentApiBase: MOBILE_LOCAL_AGENT_API_BASE }
          : {}),
      });
      console.info(
        `${APP_LOG_PREFIX} Mobile agent tunnel ${status.state}`,
        status.lastError ?? "",
      );
    } catch (error) {
      // error-policy:J4 optional native module — absence logged, app degrades
      console.warn(
        `${APP_LOG_PREFIX} Mobile agent tunnel unavailable:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      mobileAgentTunnelStartPromise = null;
    }
  })();

  await mobileAgentTunnelStartPromise;
}

async function stopMobileAgentTunnel(): Promise<void> {
  mobileAgentTunnelStartPromise = null;
  try {
    const { MobileAgentBridge } = await import(
      "@elizaos/capacitor-mobile-agent-bridge"
    );
    await MobileAgentBridge.stopInboundTunnel();
  } catch (error) {
    // error-policy:J6 teardown — stop failure is logged
    console.warn(
      `${APP_LOG_PREFIX} Mobile agent tunnel stop failed:`,
      error instanceof Error ? error.message : error,
    );
  }
  try {
    await mobileAgentTunnelListener?.remove();
  } catch {
    // error-policy:J6 teardown — the native tunnel stop above is
    // authoritative
  }
  mobileAgentTunnelListener = null;
}

function initializeMobileRuntimeModeListener(): void {
  if (!isNative || mobileRuntimeModeListenerInstalled) return;
  mobileRuntimeModeListenerInstalled = true;
  document.addEventListener(MOBILE_RUNTIME_MODE_CHANGED_EVENT, () => {
    const mode = getCurrentIosRuntimeConfig().mode;
    if (mode === "cloud-hybrid" || mode === "local") {
      stopMobileDeviceBridge();
      void stopMobileAgentTunnel();
      void initializeMobileDeviceBridge();
      void configureMobileBackgroundRunner();
      return;
    }
    if (mode === "tunnel-to-mobile") {
      stopMobileDeviceBridge();
      void initializeMobileAgentTunnel();
      void configureMobileBackgroundRunner();
      return;
    }
    stopMobileDeviceBridge();
    void stopMobileAgentTunnel();
    void configureMobileBackgroundRunner();
  });
}

function applyStoredDetachedShellTheme(): void {
  applyUiTheme(resolveUiTheme(loadUiThemeMode()));
}

async function main(): Promise<void> {
  markStartup("main-start");
  registerViewServiceWorker();

  // #9947: when served at /embed inside a Telegram Mini App / Discord Activity
  // iframe, exchange the platform's signed launch payload for a scoped session
  // token and install it on the ElizaClient BEFORE any authenticated agent API
  // call is made. No-op (and never throws) off the /embed route.
  await runEmbedHandshake({ client });

  const appWindowSlug = window.location.pathname.startsWith("/apps/")
    ? window.location.pathname.slice("/apps/".length).split("/")[0]
    : resolveAppWindowSlug();
  if (appWindowSlug === "model-tester") {
    await importSideEffectAppModule(
      "@elizaos/app-model-tester",
      () => import("@elizaos/app-model-tester"),
    );
    setupPlatformStyles();
    mountReactApp();
    return;
  }

  if (shouldLoadModelTesterShellRoute()) {
    await importSideEffectAppModule(
      "@elizaos/app-model-tester",
      () => import("@elizaos/app-model-tester"),
    );
  }

  markStartup("app-modules:start");
  await initializeAppModules();
  markStartup("app-modules:end");
  measureStartup("app-modules", "app-modules:start", "app-modules:end");
  setupPlatformStyles();
  applyBuildTimeIosConnection();

  try {
    await applyLaunchConnectionFromUrl();
  } catch (err) {
    // error-policy:J4 the launch-URL session apply is best-effort — the
    // failure is logged and normal boot (with its own auth flows) proceeds
    console.error(
      `${APP_LOG_PREFIX} Failed to apply managed cloud launch session:`,
      err instanceof Error ? err.message : err,
    );
  }

  injectWaifuChatAccessToken();

  // The iOS full-Bun backend smoke is a headless QA gate that must run BEFORE
  // any window-shell / popout routing — some shell routes return before the
  // main boot path, so wiring the smoke only into the main path left it
  // structurally unreachable on those routes and its request flag silently
  // no-op'd. Run it (and the iOS local-agent bridges it needs) up front; when
  // requested it takes over the WebView and returns.
  if (isIOS) {
    await initializeStorageBridge();
    initializeCapacitorBridge();
    installIosLocalAgentNativeRequestBridge();
    installIosLocalAgentFetchBridge();
    if (await runIosFullBunSmokeIfRequested()) {
      return;
    }
  }

  if (isPopoutWindow()) {
    injectPopoutApiBase();
    mountReactApp();
    scheduleDeferredAppModuleLoadsAfterPaint();
    return;
  }

  if (isStandaloneWindowShell(windowShellRoute)) {
    injectDetachedShellApiBase();
    applyStoredDetachedShellTheme();
    if (isDetachedWindowShell(windowShellRoute)) {
      syncDetachedShellLocation(windowShellRoute);
    }
    await initializeStorageBridge();
    initializeCapacitorBridge();
    mountReactApp();
    scheduleDeferredAppModuleLoadsAfterPaint();
    return;
  }

  markStartup("bridges:start", { platform });
  await initializeStorageBridge();
  if (isIOS) {
    initializeCapacitorBridge();
    installIosLocalAgentNativeRequestBridge();
    installIosLocalAgentFetchBridge();
    // Renderer-pulled screen-capture bridge (#9105): poll the agent for
    // capture requests and serve frames via the Capacitor ScreenCapture
    // plugin. Idempotent + native-gated; runs only after the local-agent
    // fetch bridge is installed so `/api/...` routes resolve to the agent.
    initScreenCaptureBridge();
    initOcrBridge();
    // On-device AEC acoustic-loop evidence harness (#11373): exposes
    // window.__aecLoop and the tap-free `elizaos://aec-loop?...` trigger so
    // the real speaker→mic echo loop can be driven + captured on hardware.
    const { installAecLoopHarness } = await import("@elizaos/ui/voice");
    installAecLoopHarness();
  } else if (isAndroid) {
    initializeCapacitorBridge();
    installAndroidNativeAgentFetchBridge();
    // Renderer-pulled screen-capture bridge (#9105): poll the agent for
    // capture requests and serve frames via the Capacitor ScreenCapture
    // plugin. Idempotent + native-gated; runs only after the Android fetch
    // bridge is installed so `/api/...` routes resolve to the agent.
    initScreenCaptureBridge();
    initOcrBridge();
    // Expose window.__diarizationPump (WebView→bun-agent PCM pump) and
    // window.__jniVoice (the in-process JNI voice pipeline — the four fused
    // voice classifiers running IN the bionic app process via the ElizaVoice
    // host, replacing the musl bun-agent transport) so both can be driven +
    // read on-device via CDP.
    const {
      installAecLoopHarness,
      installDiarizationPumpHarness,
      installJniVoiceHarness,
    } = await import("@elizaos/ui/voice");
    installDiarizationPumpHarness();
    installJniVoiceHarness();
    // On-device AEC acoustic-loop evidence harness (#11373): window.__aecLoop
    // plus the `elizaos://aec-loop?...` tap-free trigger.
    installAecLoopHarness();
  }
  // Desktop fused on-device wake (#10351): forward native libwakeword fires from
  // the agent process to the renderer's `eliza:fused-wake` bridge so the
  // battery-efficient on-device path drives the bottom bar — not just the
  // Swabble fallback. No-op off-desktop (no electrobun RPC). Awaited before
  // mountReactApp so `window.__ELIZA_FUSED_WAKE__` is set for the wake
  // controller's first-render capability probe.
  // A separate hashed lazy chunk that runs on ALL platforms before first
  // paint. Never let a voice-chunk load failure (e.g. a stale index.html
  // pointing at a purged hash during a redeploy) gate mounting the app.
  try {
    const { registerDesktopFusedWake } = await import("@elizaos/ui/voice");
    registerDesktopFusedWake();
  } catch (error) {
    // error-policy:J4 never let a voice-chunk load failure (e.g. a stale
    // index.html pointing at a purged hash) gate mounting the app
    console.warn("[boot] fused-wake voice module unavailable", error);
  }
  markStartup("bridges:end", { platform });
  measureStartup("bridges", "bridges:start", "bridges:end");
  mountReactApp();
  scheduleDeferredAppModuleLoadsAfterPaint();
  await initializePlatform();
}

// main() awaits fallible pre-mount chunks; a bare invocation would leave any
// rejection unhandled and the page permanently blank. Route every boot failure
// to an actionable reload card instead.
function boot(): void {
  // error-policy:J1 boot boundary — every rejection renders the reload card
  void main().catch(renderBootFailure);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

export { isAndroid, isDesktopPlatform as isDesktop, isIOS, isNative, platform };
