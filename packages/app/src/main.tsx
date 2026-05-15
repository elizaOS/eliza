// === Phase 5D ===
// Slim shell entrypoint. Three responsibilities:
//   1. Platform detection + branding boot.
//   2. React mount with shell-route routing (main / detached / popout /
//      app-window / phone-companion).
//   3. Top-level orchestration of plugin load, bootstrap patches, deep-link
//      dispatch, and mobile lifecycle wiring.
// Everything else lives in dedicated modules: plugin composition in
// `./plugin-loader`, URL trust policy in `./url-trust-policy`, mobile device
// bridge / agent tunnel in `./mobile-bridges`, mobile lifecycle wiring in
// `./mobile-lifecycle`, deep-link dispatcher in `./deep-link-handler`,
// platform bootstrap patches + iOS full-Bun smoke in
// `@elizaos/app-core/platform/*`.
import { ErrorBoundary } from "@elizaos/ui";
import "@elizaos/ui/styles";

import { Capacitor } from "@capacitor/core";
import { Agent } from "@elizaos/capacitor-agent";
import {
  AppWindowRenderer,
  DESKTOP_TRAY_MENU_ITEMS,
  DesktopSurfaceNavigationRuntime,
  DesktopTrayRuntime,
  DetachedShellRoot,
  initializeAppBootstrapBridges,
  installAppBootstrapClientPatches,
  runIosFullBunSmokeIfRequested,
} from "@elizaos/app-core";
import { Desktop } from "@elizaos/capacitor-desktop";
import { ELIZA_DEFAULT_THEME, getStylePresets } from "@elizaos/shared";
import type { BrandingConfig } from "@elizaos/ui";
import {
  AGENT_READY_EVENT,
  App,
  type AppBootConfig,
  AppProvider,
  applyLaunchConnectionFromUrl,
  applyUiTheme,
  CharacterEditor,
  COMMAND_PALETTE_EVENT,
  dispatchAppEvent,
  getBootConfig,
  getWindowNavigationPath,
  IOS_LOCAL_AGENT_IPC_BASE,
  installIosLocalAgentFetchBridge,
  installIosLocalAgentNativeRequestBridge,
  isAppWindowRoute,
  isDetachedWindowShell,
  isElectrobunRuntime,
  loadUiTheme,
  MOBILE_RUNTIME_MODE_CHANGED_EVENT,
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  normalizeMobileRuntimeMode,
  resolveWindowShellRoute,
  SHARE_TARGET_EVENT,
  type ShareTargetPayload,
  setBootConfig,
  shouldInstallMainWindowOnboardingPatches,
  shouldUseCloudOnlyBranding,
  subscribeDesktopBridgeEvent,
  syncDetachedShellLocation,
  TRAY_ACTION_EVENT,
} from "@elizaos/ui";
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  APP_BRANDING_BASE,
  APP_CONFIG,
  APP_LOG_PREFIX,
  APP_NAMESPACE,
  APP_URL_SCHEME,
} from "./app-config";
import { APP_ENV_ALIASES, APP_ENV_PREFIX } from "./brand-env";
import { APP_CHARACTER_CATALOG } from "./character-catalog";
import { createDeepLinkHandler } from "./deep-link-handler";
import {
  type IosRuntimeConfig,
  resolveIosRuntimeConfig,
} from "./ios-runtime";
import { createMobileBridges } from "./mobile-bridges";
import { createMobileLifecycle } from "./mobile-lifecycle";
import {
  dispatchLifeOpsGithubCallbackIfReady,
  initializeAppPlugins,
  LifeOpsActivitySignalsEffect,
  PhoneCompanionApp,
} from "./plugin-loader";
import { createUrlTrustPolicy } from "./url-trust-policy";

declare const __ELIZA_BUILD_VARIANT__: string | undefined;

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
  // other hosts inject an explicit API base before React boots, and that
  // host backend should control onboarding capabilities instead.
  cloudOnly: shouldUseCloudOnlyBranding({
    isDev: import.meta.env.DEV ?? false,
    injectedApiBase:
      typeof window === "undefined" ? undefined : getInjectedAppApiBase(),
    isNativePlatform: Capacitor.isNativePlatform(),
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

function isDesktopPlatform(): boolean {
  return isElectrobunRuntime();
}

const windowShellRoute = resolveWindowShellRoute();

function getWindowUrlSearchParams(): URLSearchParams {
  const search = window.location?.search ?? "";
  const hashSearch = window.location?.hash?.split("?")[1] ?? "";
  return new URLSearchParams(search || hashSearch);
}

function hasRuntimePickerOverride(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return getWindowUrlSearchParams().get("runtime") === "picker";
  } catch {
    return false;
  }
}

function isPopoutWindow(): boolean {
  if (typeof window === "undefined") return false;
  return getWindowUrlSearchParams().has("popout");
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

const trustPolicy = createUrlTrustPolicy({
  isNative,
  isIOS,
  isStoreBuild,
  cloudApiBase: IOS_RUNTIME_ENV_CONFIG.cloudApiBase,
  isPopoutWindow: isPopoutWindow(),
  getIosRuntimeMode: () => getCurrentIosRuntimeConfig().mode,
});

const mobileBridges = createMobileBridges({
  isNative,
  isIOS,
  isAndroid,
  platform,
  logPrefix: APP_LOG_PREFIX,
  deviceBridgeIdKey: DEVICE_BRIDGE_ID_KEY,
  trustPolicy,
  getIosRuntimeConfig: getCurrentIosRuntimeConfig,
});

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

const handleDeepLink = createDeepLinkHandler({
  urlScheme: APP_URL_SCHEME,
  appId: APP_CONFIG.appId,
  desktopBundleId: APP_CONFIG.desktop?.bundleId,
  logPrefix: APP_LOG_PREFIX,
  trustPolicy,
  dispatchShareTarget,
  dispatchLifeOpsCallback: dispatchLifeOpsGithubCallbackIfReady,
});

const mobileLifecycle = createMobileLifecycle({
  isNative,
  isIOS,
  isAndroid,
  logPrefix: APP_LOG_PREFIX,
  handleDeepLink,
});

/**
 * Adds `eliza-electrobun-frameless` for CSS `-webkit-app-region` (Chromium/CEF).
 * macOS WKWebView move/resize are still driven by native overlays in
 * window-effects.mm; this class mainly marks the shell and helps non-WK
 * engines.
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

// Pre-React bootstrap patches: force-fresh onboarding reset, cloud preference,
// desktop permissions, Android local-runtime seed. Storage + Capacitor bridges
// are async and install later in `main()`.
installAppBootstrapClientPatches({
  windowShellRoute,
  isDesktopPlatform: isDesktopPlatform(),
  skipAndroidLocalRuntimeSeed: hasRuntimePickerOverride(),
});

// Register custom character editor for app-core's ViewRouter to pick up.
window.__ELIZA_APP_CHARACTER_EDITOR__ = CharacterEditor;
Reflect.set(window, BRANDED_WINDOW_KEYS.characterEditor, CharacterEditor);

// Derive VRM roster from STYLE_PRESETS so character names stay in one place.
const APP_STYLE_PRESETS = getStylePresets();
const APP_VRM_ASSETS = APP_STYLE_PRESETS.slice()
  .sort((a, b) => a.avatarIndex - b.avatarIndex)
  // Companion public assets ship as eliza-*.vrm.gz even in the Eliza-branded
  // shell; keep the boot roster aligned with files in dist/vrms.
  .map((p) => ({ title: p.name, slug: `eliza-${p.avatarIndex}` }));

function initializeAppModules(): Promise<void> {
  return initializeAppPlugins({
    branding: APP_BRANDING,
    defaultApps: APP_CONFIG.defaultApps,
    assetBaseUrl:
      (import.meta.env.VITE_ASSET_BASE_URL as string | undefined)?.trim() ||
      undefined,
    cloudApiBase: IOS_RUNTIME_ENV_CONFIG.cloudApiBase,
    vrmAssets: APP_VRM_ASSETS,
    onboardingStyles: APP_STYLE_PRESETS,
    characterCatalog: APP_CHARACTER_CATALOG,
    envAliases: APP_ENV_ALIASES,
    clientMiddleware: {
      forceFreshOnboarding:
        shouldInstallMainWindowOnboardingPatches(windowShellRoute),
      preferLocalProvider: true,
      desktopPermissions: isDesktopPlatform(),
    },
  });
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
  await initializeAppBootstrapBridges();
  void runIosFullBunSmokeIfRequested();

  if (isIOS || isAndroid) {
    await mobileLifecycle.initializeStatusBar();
    await mobileLifecycle.initializeKeyboard();
    mobileLifecycle.initializeAppLifecycle();
    mobileBridges.initializeRuntimeModeListener(
      MOBILE_RUNTIME_MODE_CHANGED_EVENT,
    );
    void mobileLifecycle.initializeNetworkListener();
    void mobileBridges.initializeDeviceBridge();
    void mobileBridges.initializeAgentTunnel();
  }

  if (isDesktopPlatform()) {
    await initializeDesktopShell();
  } else if (isNative) {
    await initializeAgent();
  }

  if (isIOS || isAndroid) {
    void mobileBridges.configureBackgroundRunner();
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

  // Global shortcuts are pushed from the Electrobun host via the RPC bridge.
  // The Capacitor Desktop plugin's `addListener` web impl never fires those
  // events, so we subscribe through the bridge directly.
  subscribeDesktopBridgeEvent({
    rpcMessage: "desktopShortcutPressed",
    ipcChannel: "desktop:shortcutPressed",
    listener: (payload) => {
      const id = (payload as { id?: string } | null | undefined)?.id;
      if (id === "command-palette") {
        dispatchAppEvent(COMMAND_PALETTE_EVENT);
      }
    },
  });

  await Desktop.setTrayMenu({ menu: [...DESKTOP_TRAY_MENU_ITEMS] });

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
  if (isNative) document.body.classList.add("native");
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
  // Take only the first path segment after /apps/ so `/apps/plugins/extra`
  // doesn't yield a malformed slug.
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
        <Suspense fallback={null}>
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
        </Suspense>
      </StrictMode>
    </ErrorBoundary>,
  );
}

function validateAndSetApiBase(apiBase: string): void {
  try {
    const parsed = new URL(apiBase);
    if (trustPolicy.isTrustedApiBaseUrl(parsed)) {
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

function injectUrlApiBase(): void {
  const apiBase = getWindowUrlSearchParams().get("apiBase");
  if (apiBase) validateAndSetApiBase(apiBase);
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
  if (!IOS_RUNTIME_ENV_CONFIG.apiBase && !IOS_RUNTIME_ENV_CONFIG.apiToken) {
    return;
  }
  if (IOS_RUNTIME_ENV_CONFIG.apiBase) {
    validateAndSetApiBase(IOS_RUNTIME_ENV_CONFIG.apiBase);
  }
}

async function main(): Promise<void> {
  await initializeAppModules();
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
    injectUrlApiBase();
    mountReactApp();
    return;
  }

  if (isDetachedWindowShell(windowShellRoute)) {
    injectUrlApiBase();
    applyUiTheme(loadUiTheme());
    syncDetachedShellLocation(windowShellRoute);
    await initializeAppBootstrapBridges();
    mountReactApp();
    return;
  }

  await initializeAppBootstrapBridges();
  if (isIOS) {
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
