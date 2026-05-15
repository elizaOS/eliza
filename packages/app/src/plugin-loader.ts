// === Phase 5D: extracted from main.tsx ===
// Plugin composition layer for the white-label app shell. Declares the full
// roster of `@elizaos/app-*` modules, parallel-loads them on boot, caches the
// promises so React.lazy() consumers and subsequent boot phases share one
// resolution per module, and wires the resolved exports into the canonical
// `AppBootConfig` via `setBootConfig`.
import type {
  AppBlockerSettingsCardProps,
  WebsiteBlockerSettingsCardProps,
} from "@elizaos/shared";
import type {
  BrandingConfig,
  CodingAgentTasksPanelProps,
  CompanionInferenceNotice,
  CompanionSceneStatus,
  CompanionShellComponentProps,
  FineTuningViewProps,
  ResolveCompanionInferenceNoticeArgs,
  StewardApprovalQueueProps,
  StewardLogoProps,
  StewardTransactionHistoryProps,
  VincentStateHookArgs,
  VincentStateHookResult,
} from "@elizaos/ui";
import {
  type AppBootConfig,
  CharacterEditor,
  setBootConfig,
} from "@elizaos/ui";
import { type ComponentType, lazy } from "react";

// ---------------------------------------------------------------------------
// Declarative plugin spec map.
// ---------------------------------------------------------------------------

export const APP_PLUGIN_SPECS = {
  "@elizaos/app-core": () => import("@elizaos/app-core"),
  "@elizaos/app-companion": () => import("@elizaos/app-companion"),
  "@elizaos/app-lifeops": () => import("@elizaos/app-lifeops"),
  "@elizaos/app-phone": () => import("@elizaos/app-phone"),
  "@elizaos/app-steward": () => import("@elizaos/app-steward"),
  "@elizaos/app-task-coordinator": () =>
    import("@elizaos/app-task-coordinator"),
  "@elizaos/app-training": () => import("@elizaos/app-training"),
  "@elizaos/app-vincent": () => import("@elizaos/app-vincent"),
  "@elizaos/app-babylon": () => import("@elizaos/app-babylon"),
  "@elizaos/app-scape": () => import("@elizaos/app-scape"),
  "@elizaos/app-hyperscape": () => import("@elizaos/app-hyperscape"),
  "@elizaos/app-2004scape": () => import("@elizaos/app-2004scape"),
  "@elizaos/app-defense-of-the-agents": () =>
    import("@elizaos/app-defense-of-the-agents"),
  "@elizaos/app-clawville": () => import("@elizaos/app-clawville"),
  "@elizaos/app-trajectory-logger": () =>
    import("@elizaos/app-trajectory-logger"),
  "@elizaos/app-shopify": () => import("@elizaos/app-shopify"),
  "@elizaos/app-hyperliquid": () => import("@elizaos/app-hyperliquid"),
  "@elizaos/app-polymarket": () => import("@elizaos/app-polymarket"),
  "@elizaos/app-wallet": () => import("@elizaos/app-wallet"),
  "@elizaos/app-contacts/register": () =>
    import("@elizaos/app-contacts/register"),
  "@elizaos/app-device-settings/register": () =>
    import("@elizaos/app-device-settings/register"),
  "@elizaos/app-messages/register": () =>
    import("@elizaos/app-messages/register"),
  "@elizaos/app-phone/register": () => import("@elizaos/app-phone/register"),
  "@elizaos/app-wifi/register": () => import("@elizaos/app-wifi/register"),
} as const;

export type AppPluginId = keyof typeof APP_PLUGIN_SPECS;

const moduleCache = new Map<AppPluginId, Promise<unknown>>();

function loadPlugin<K extends AppPluginId>(
  id: K,
): ReturnType<(typeof APP_PLUGIN_SPECS)[K]> {
  const existing = moduleCache.get(id);
  if (existing) return existing as ReturnType<(typeof APP_PLUGIN_SPECS)[K]>;
  const promise = APP_PLUGIN_SPECS[id]() as ReturnType<
    (typeof APP_PLUGIN_SPECS)[K]
  >;
  moduleCache.set(id, promise);
  return promise;
}

function lazyNamedComponent<TProps>(
  load: () => Promise<ComponentType<TProps>>,
): ComponentType<TProps> {
  return lazy(async () => ({ default: await load() })) as ComponentType<TProps>;
}

// ---------------------------------------------------------------------------
// Lazy component handles consumed by buildAppBootConfig below.
// ---------------------------------------------------------------------------

const CompanionShell = lazyNamedComponent<CompanionShellComponentProps>(
  async () => (await loadPlugin("@elizaos/app-companion")).CompanionShell,
);
const GlobalEmoteOverlay = lazyNamedComponent<Record<string, never>>(
  async () => (await loadPlugin("@elizaos/app-companion")).GlobalEmoteOverlay,
);
const InferenceCloudAlertButton = lazyNamedComponent<{
  notice: CompanionInferenceNotice;
  onClick: () => void;
  onPointerDown?: (...args: unknown[]) => unknown;
}>(
  async () =>
    (await loadPlugin("@elizaos/app-companion")).InferenceCloudAlertButton,
);
const PhoneCompanionApp = lazyNamedComponent<Record<string, never>>(
  async () => (await loadPlugin("@elizaos/app-phone")).PhoneCompanionApp,
);
const LifeOpsPageView = lazyNamedComponent<Record<string, never>>(
  async () => (await loadPlugin("@elizaos/app-lifeops")).LifeOpsPageView,
);
const BrowserBridgeSetupPanel = lazyNamedComponent<Record<string, never>>(
  async () =>
    (await loadPlugin("@elizaos/app-lifeops")).LifeOpsBrowserSetupPanel,
);
const LifeOpsActivitySignalsEffect = lazyNamedComponent<Record<string, never>>(
  async () =>
    (await loadPlugin("@elizaos/app-lifeops")).LifeOpsActivitySignalsEffect,
);
const AppBlockerSettingsCard = lazyNamedComponent<AppBlockerSettingsCardProps>(
  async () => (await loadPlugin("@elizaos/app-lifeops")).AppBlockerSettingsCard,
);
const WebsiteBlockerSettingsCard =
  lazyNamedComponent<WebsiteBlockerSettingsCardProps>(
    async () =>
      (await loadPlugin("@elizaos/app-lifeops")).WebsiteBlockerSettingsCard,
  );
const StewardLogo = lazyNamedComponent<StewardLogoProps>(
  async () => (await loadPlugin("@elizaos/app-steward")).StewardLogo,
);
const ApprovalQueue = lazyNamedComponent<StewardApprovalQueueProps>(
  async () => (await loadPlugin("@elizaos/app-steward")).ApprovalQueue,
);
const TransactionHistory = lazyNamedComponent<StewardTransactionHistoryProps>(
  async () => (await loadPlugin("@elizaos/app-steward")).TransactionHistory,
);
const CodingAgentControlChip = lazyNamedComponent<Record<string, never>>(
  async () =>
    (await loadPlugin("@elizaos/app-task-coordinator")).CodingAgentControlChip,
);
const CodingAgentSettingsSection = lazyNamedComponent<Record<string, never>>(
  async () =>
    (await loadPlugin("@elizaos/app-task-coordinator"))
      .CodingAgentSettingsSection,
);
const CodingAgentTasksPanel = lazyNamedComponent<CodingAgentTasksPanelProps>(
  async () =>
    (await loadPlugin("@elizaos/app-task-coordinator")).CodingAgentTasksPanel,
);
const FineTuningView = lazyNamedComponent<FineTuningViewProps>(
  async () => (await loadPlugin("@elizaos/app-training")).FineTuningView,
);

export { LifeOpsActivitySignalsEffect, PhoneCompanionApp };

// ---------------------------------------------------------------------------
// Hook proxies. Companion/Vincent expose hook factories that are only known
// after their modules load; consumers call useLoadedX during render and we
// route to the resolved hook or a safe default.
// ---------------------------------------------------------------------------

const DEFAULT_LAZY_VINCENT_STATE: VincentStateHookResult = {
  vincentConnected: false,
  vincentLoginBusy: false,
  vincentLoginError: null,
  vincentConnectedAt: null,
  handleVincentLogin: async () => {},
  handleVincentDisconnect: async () => {},
  pollVincentStatus: async () => false,
};

let loadedCompanionSceneStatusHook: (() => CompanionSceneStatus) | null = null;
let loadedVincentStateHook:
  | ((args: VincentStateHookArgs) => VincentStateHookResult)
  | null = null;
let dispatchQueuedLifeOpsGithubCallback: ((url: string) => void) | null = null;

export function useLoadedCompanionSceneStatus(): CompanionSceneStatus {
  return (
    loadedCompanionSceneStatusHook?.() ?? {
      avatarReady: false,
      teleportKey: "",
    }
  );
}

export function useLoadedVincentState(
  args: VincentStateHookArgs,
): VincentStateHookResult {
  return loadedVincentStateHook?.(args) ?? DEFAULT_LAZY_VINCENT_STATE;
}

export function dispatchLifeOpsGithubCallbackIfReady(url: string): void {
  dispatchQueuedLifeOpsGithubCallback?.(url);
}

// ---------------------------------------------------------------------------
// initializeAppPlugins — top-level entrypoint for boot. Parallel-loads every
// declared plugin, wires hook proxies, and pushes the assembled AppBootConfig
// into `@elizaos/ui`'s global boot state.
// ---------------------------------------------------------------------------

export interface InitializeAppPluginsArgs {
  branding: Partial<BrandingConfig>;
  defaultApps: AppBootConfig["defaultApps"];
  assetBaseUrl: string | undefined;
  cloudApiBase: string | undefined;
  vrmAssets: AppBootConfig["vrmAssets"];
  onboardingStyles: AppBootConfig["onboardingStyles"];
  characterCatalog: AppBootConfig["characterCatalog"];
  envAliases: AppBootConfig["envAliases"];
  clientMiddleware: AppBootConfig["clientMiddleware"];
}

let initializeAppPluginsPromise: Promise<void> | null = null;

export function initializeAppPlugins(
  args: InitializeAppPluginsArgs,
): Promise<void> {
  initializeAppPluginsPromise ??= (async () => {
    // app-core must resolve first; it owns the shared boot config singleton.
    await loadPlugin("@elizaos/app-core");

    const [companionModule, lifeOpsModule, vincentModule] = await Promise.all([
      loadPlugin("@elizaos/app-companion"),
      loadPlugin("@elizaos/app-lifeops"),
      loadPlugin("@elizaos/app-vincent"),
      loadPlugin("@elizaos/app-task-coordinator"),
      loadPlugin("@elizaos/app-phone"),
      loadPlugin("@elizaos/app-steward"),
      loadPlugin("@elizaos/app-training"),
      loadPlugin("@elizaos/app-babylon"),
      loadPlugin("@elizaos/app-scape"),
      loadPlugin("@elizaos/app-hyperscape"),
      loadPlugin("@elizaos/app-2004scape"),
      loadPlugin("@elizaos/app-defense-of-the-agents"),
      loadPlugin("@elizaos/app-clawville"),
      loadPlugin("@elizaos/app-trajectory-logger"),
      loadPlugin("@elizaos/app-shopify"),
      loadPlugin("@elizaos/app-hyperliquid"),
      loadPlugin("@elizaos/app-polymarket"),
      loadPlugin("@elizaos/app-wallet"),
      loadPlugin("@elizaos/app-contacts/register"),
      loadPlugin("@elizaos/app-device-settings/register"),
      loadPlugin("@elizaos/app-messages/register"),
      loadPlugin("@elizaos/app-phone/register"),
      loadPlugin("@elizaos/app-wifi/register"),
    ]);

    companionModule.registerCompanionApp();
    loadedCompanionSceneStatusHook = companionModule.useCompanionSceneStatus;
    loadedVincentStateHook = vincentModule.useVincentState;
    dispatchQueuedLifeOpsGithubCallback =
      lifeOpsModule.dispatchQueuedLifeOpsGithubCallbackFromUrl;

    const bootConfig: AppBootConfig = {
      branding: args.branding,
      defaultApps: args.defaultApps,
      assetBaseUrl: args.assetBaseUrl,
      cloudApiBase: args.cloudApiBase,
      vrmAssets: args.vrmAssets,
      onboardingStyles: args.onboardingStyles,
      characterEditor: CharacterEditor,
      companionShell: CompanionShell,
      resolveCompanionInferenceNotice: ((
        a: ResolveCompanionInferenceNoticeArgs,
      ) =>
        companionModule.resolveCompanionInferenceNotice(
          a,
        )) as AppBootConfig["resolveCompanionInferenceNotice"],
      companionInferenceAlertButton: InferenceCloudAlertButton,
      companionGlobalOverlay: GlobalEmoteOverlay,
      useCompanionSceneStatus: useLoadedCompanionSceneStatus,
      companionVectorBrowser: {
        THREE: companionModule.THREE,
        createVectorBrowserRenderer:
          companionModule.createVectorBrowserRenderer,
      },
      codingAgentTasksPanel: CodingAgentTasksPanel,
      codingAgentSettingsSection: CodingAgentSettingsSection,
      codingAgentControlChip: CodingAgentControlChip,
      fineTuningView: FineTuningView,
      useVincentState: useLoadedVincentState,
      stewardLogo: StewardLogo,
      stewardApprovalQueue: ApprovalQueue,
      stewardTransactionHistory: TransactionHistory,
      characterCatalog: args.characterCatalog,
      envAliases: args.envAliases,
      lifeOpsPageView: LifeOpsPageView,
      lifeOpsBrowserSetupPanel: BrowserBridgeSetupPanel,
      appBlockerSettingsCard: AppBlockerSettingsCard,
      websiteBlockerSettingsCard: WebsiteBlockerSettingsCard,
      clientMiddleware: args.clientMiddleware,
    };

    setBootConfig(bootConfig);
  })();
  return initializeAppPluginsPromise;
}
