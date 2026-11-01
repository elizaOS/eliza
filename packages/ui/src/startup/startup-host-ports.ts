/** Methods consumed by the existing phase algorithms; no client singleton is captured. */
export type StartupRuntimeClient = Pick<
  import("../api/client.js").ElizaClient,
  | "apiAvailable"
  | "connectWs"
  | "disconnectWs"
  | "fetch"
  | "getAuthStatus"
  | "getBaseUrl"
  | "getBootProgress"
  | "getCloudCompatAgent"
  | "getCloudCompatAgents"
  | "getCodingAgentStatus"
  | "getConfig"
  | "getFirstRunOptions"
  | "getFirstRunStatus"
  | "getLaunchProgress"
  | "getRestAuthToken"
  | "getStatus"
  | "getStreamSettings"
  | "getWalletAddresses"
  | "hasToken"
  | "listConversations"
  | "onWsEvent"
  | "sendWsMessage"
  | "setBaseUrl"
  | "setToken"
  | "startAgent"
>;

/** Native progress is an observation, not admission or authenticated readiness. */
export type NativeStartupBootState = {
  state: "booting" | "listening" | "restarting" | "dead" | "unknown";
  reason?: string;
  ageMs?: number;
  attempt?: number;
};

/** Explicit dependencies for the existing startup coordinator and phase algorithms. */
export interface StartupHostPorts {
  readonly platform: {
    readonly isElectrobunRuntime: typeof import("../bridge/electrobun-runtime.js").isElectrobunRuntime;
    readonly isAndroid: typeof import("../platform/init.js").isAndroid;
    readonly isIOS: typeof import("../platform/init.js").isIOS;
    readonly isNative: typeof import("../platform/init.js").isNative;
    readonly isCapacitorNative: typeof import("../platform/native-probe.js").isCapacitorNativeRuntime;
    readonly isElizaOS: typeof import("../platform/init.js").isElizaOS;
  };
  readonly transport: {
    readonly client: StartupRuntimeClient;
    readonly invokeDesktopBridgeRequestWithTimeout: typeof import("../bridge/electrobun-rpc.js").invokeDesktopBridgeRequestWithTimeout;
    readonly primeAuthStatusProbe: typeof import("../hooks/useAuthStatus.js").primeAuthStatusProbe;
    readonly getAndroidLocalAgentBootStateForUrl: (
      url: string | null | undefined,
    ) => Promise<NativeStartupBootState>;
    readonly requestAndroidLocalAgentStartForUrl: (
      url: string | null | undefined,
      signal?: AbortSignal,
    ) => Promise<boolean>;
    /** Admit and bind the selected native owner before any start or readiness probe. */
    readonly prepareNativeRuntimeForUrl?: (
      url: string,
      signal: AbortSignal,
    ) => Promise<void>;
    readonly appendIosBootTrace: (
      stage: string,
      detail?: Record<string, unknown>,
    ) => void;
    readonly isIosInProcessLocalAgentBase: (
      baseUrl: string | null | undefined,
    ) => boolean;
    readonly isIosNativeAgentBootInProgress: (now?: number) => boolean;
    readonly isTerminalIosNativeAgentBootErrorMessage: (
      message: string | null | undefined,
    ) => boolean;
    readonly fetchWithCsrf: typeof import("../api/csrf-client.js").fetchWithCsrf;
  };
  readonly configuration: {
    readonly supportsFullAppShellRoutes: (
      value: string | null | undefined,
    ) => boolean;
    readonly isDirectCloudSharedAgentBase: (
      url: string | null | undefined,
    ) => boolean;
    readonly cloudTokenSecsRemaining: (token: string) => number | null;
    readonly getElizaApiBase: typeof import("@elizaos/host/protocol").getElizaApiBase;
    readonly getElizaApiToken: typeof import("@elizaos/host/protocol").getElizaApiToken;
    readonly clearStoredStewardToken: typeof import("@elizaos/plugin-elizacloud/steward-session-client").clearStoredStewardToken;
    readonly hasStewardAuthedCookie: typeof import("@elizaos/plugin-elizacloud/steward-session-client").hasStewardAuthedCookie;
    readonly readStoredStewardToken: typeof import("@elizaos/plugin-elizacloud/steward-session-client").readStoredStewardToken;
    readonly writeStoredStewardToken: typeof import("@elizaos/plugin-elizacloud/steward-session-client").writeStoredStewardToken;
    readonly isCommittedOnDeviceMobileRuntimeMode: typeof import("../first-run/mobile-runtime-mode.js").isCommittedOnDeviceMobileRuntimeMode;
    readonly readPersistedMobileRuntimeMode: typeof import("../first-run/mobile-runtime-mode.js").readPersistedMobileRuntimeMode;
    readonly resolveCloudEnvironmentBase: typeof import("../utils/cloud-agent-base.js").resolveCloudEnvironmentBase;
    readonly clearForceFreshFirstRun: typeof import("../platform/first-run-reset.js").clearForceFreshFirstRun;
    readonly isForceFreshFirstRunEnabled: typeof import("../platform/first-run-reset.js").isForceFreshFirstRunEnabled;
    readonly wasForceFreshResetApplied: typeof import("../platform/first-run-reset.js").wasForceFreshResetApplied;
    readonly clearPersistedActiveServer: typeof import("../state/persistence.js").clearPersistedActiveServer;
    readonly hydratePersistedFirstRunCompleteFromNativeStore: typeof import("../state/persistence.js").hydratePersistedFirstRunCompleteFromNativeStore;
    readonly loadPersistedActiveServer: typeof import("../state/persistence.js").loadPersistedActiveServer;
    readonly loadPersistedFirstRunComplete: typeof import("../state/persistence.js").loadPersistedFirstRunComplete;
    readonly savePersistedActiveServer: typeof import("../state/persistence.js").savePersistedActiveServer;
    readonly savePersistedFirstRunComplete: typeof import("../state/persistence.js").savePersistedFirstRunComplete;
    readonly clearSharedCloudAccountBinding: typeof import("../state/shared-cloud-account-binding.js").clearSharedCloudAccountBinding;
    readonly refreshCloudStewardSession: typeof import("../api/client-cloud.js").refreshCloudStewardSession;
    readonly detectExistingFirstRunConnection: typeof import("../state/first-run-bootstrap.js").detectExistingFirstRunConnection;
    readonly getBootConfig: typeof import("../config/boot-config-store.js").getBootConfig;
    readonly isTrustedCloudApiBaseUrl: typeof import("../state/runtime-url-trust.js").isTrustedCloudApiBaseUrl;
    readonly isTrustedRestoreApiBaseUrl: typeof import("../state/runtime-url-trust.js").isTrustedRestoreApiBaseUrl;
    readonly isOnboardingReplayRequested: typeof import("../platform/onboarding-replay.js").isOnboardingReplayRequested;
    readonly persistMobileRuntimeMode: typeof import("../first-run/mobile-runtime-mode.js").persistMobileRuntimeMode;
    readonly getCloudAuthToken: typeof import("../api/client-cloud.js").getCloudAuthToken;
    readonly isPasswordAuthTransportConfidential: typeof import("../api/password-auth-transport-policy.js").isPasswordAuthTransportConfidential;
    readonly isViteDevUiShell: typeof import("../platform/vite-dev-ui-shell.js").isViteDevUiShell;
    readonly readMobileRuntimeBuildTruth: typeof import("../first-run/reconcile-mobile-runtime-mode.js").readMobileRuntimeBuildTruth;
    readonly resumePendingCloudHandoff: typeof import("../cloud/handoff/resume-pending-handoff.js").resumePendingCloudHandoff;
    readonly getWindowNavigationPath: typeof import("../navigation/index.js").getWindowNavigationPath;
    readonly shouldUseHashNavigation: typeof import("../navigation/index.js").shouldUseHashNavigation;
    readonly enforceDeviceRamPolicyOnPersistedRuntimeModeAtBoot: typeof import("../first-run/device-ram-gate.js").enforceDeviceRamPolicyOnPersistedRuntimeModeAtBoot;
    readonly reconcilePersistedMobileRuntimeModeAtBoot: typeof import("../first-run/reconcile-mobile-runtime-mode.js").reconcilePersistedMobileRuntimeModeAtBoot;
  };
  readonly services: {
    readonly normalizeAvatarIndex: typeof import("../state/vrm.js").normalizeAvatarIndex;
    readonly executeRuntimeManagementCommand: (
      request: import("@elizaos/contracts").RuntimeManagementRequest,
    ) => Promise<import("@elizaos/contracts").RuntimeManagementResult>;
    readonly loadViewInteractRegistry: typeof import("../view-loaders.js").loadViewInteractRegistry;
    readonly dispatchAppEmoteEvent: typeof import("../events/index.js").dispatchAppEmoteEvent;
    readonly dispatchVoiceControl: typeof import("../events/index.js").dispatchVoiceControl;
    readonly dispatchCompletedActionNavigation: typeof import("../completed-action-navigation.js").dispatchCompletedActionNavigation;
    readonly dispatchConversationResync: typeof import("../state/AppContext.hooks.js").dispatchConversationResync;
    readonly emitViewEvent: typeof import("../events/view-events.js").emitViewEvent;
    readonly resolveDefaultLandingTab: typeof import("../navigation/index.js").resolveDefaultLandingTab;
    readonly loadAgentProfileRegistry: typeof import("../state/agent-profiles.js").loadAgentProfileRegistry;
    readonly resolveAgentProfileByQuery: typeof import("../state/agent-profiles.js").resolveAgentProfileByQuery;
    readonly loadAvatarIndex: typeof import("../state/persistence.js").loadAvatarIndex;
    readonly prefetchAppsCatalog: typeof import("../components/apps/load-apps-catalog.js").prefetchAppsCatalog;
    readonly recoverMissedCurrentView: typeof import("../view-action-handoff.js").recoverMissedCurrentView;
    readonly switchRuntimeNonDestructive: typeof import("../state/switch-runtime.js").switchRuntimeNonDestructive;
    readonly markStartup: typeof import("../state/startup-telemetry.js").markStartup;
  };
}
