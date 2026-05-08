import type {
  WalletChainKind,
  WalletEntry,
  WalletPrimaryMap,
  WalletSource,
} from "@elizaos/shared";
import type { Dispatch, SetStateAction } from "react";
import type {
  AgentStatus,
  AppRunSummary,
  AppSessionState,
  AppViewerAuthMessage,
  BscTradeExecuteRequest,
  BscTradeExecuteResponse,
  BscTradePreflightResponse,
  BscTradeQuoteRequest,
  BscTradeQuoteResponse,
  BscTradeTxStatusResponse,
  BscTransferExecuteRequest,
  BscTransferExecuteResponse,
  CatalogSkill,
  CharacterData,
  ChatTokenUsage,
  CodingAgentSession,
  Conversation,
  ConversationChannelType,
  ConversationMessage,
  ConversationMode,
  CreateTriggerRequest,
  DropStatus,
  ExtensionStatus,
  ImageAttachment,
  LogEntry,
  McpMarketplaceResult,
  McpRegistryServerDetail,
  McpServerConfig,
  McpServerStatus,
  MintResult,
  OnboardingOptions,
  PluginInfo,
  RegistryPlugin,
  RegistryStatus,
  ReleaseChannel,
  SkillInfo,
  SkillMarketplaceResult,
  SkillScanReportSummary,
  StewardApprovalActionResponse,
  StewardBalanceResponse,
  StewardHistoryResponse,
  StewardPendingResponse,
  StewardStatusResponse,
  StewardTokenBalancesResponse,
  StewardWalletAddressesResponse,
  StewardWebhookEventsResponse,
  StewardWebhookEventType,
  StreamEventEnvelope,
  SystemPermissionId,
  TriggerHealthSnapshot,
  TriggerRunRecord,
  TriggerSummary,
  UpdateStatus,
  UpdateTriggerRequest,
  WalletAddresses,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletConfigUpdateRequest,
  WalletExportResult,
  WalletNftsResponse,
  WalletTradingProfileResponse,
  WalletTradingProfileSourceFilter,
  WalletTradingProfileWindow,
  WhitelistStatus,
  WorkbenchOverview,
} from "../api/client";
import type { UiLanguage } from "../i18n";
import type { Tab } from "../navigation";
import type { OnboardingServerTarget } from "../onboarding/server-target";
import type { AgentProfile } from "./agent-profile-types";
import type { UiShellMode, UiTheme } from "./ui-preferences";

export type { UiShellMode } from "./ui-preferences";

/** 3D companion render power: full quality, OS/battery-aware default, or always efficient. */
export type CompanionVrmPowerMode = "quality" | "balanced" | "efficiency";

/** When to cap the companion VRM loop at ~half the display refresh rate. */
export type CompanionHalfFramerateMode = "off" | "when_saving_power" | "always";
export type ShellView = "companion" | "character" | "desktop";

/** Emitted after each tab/shell-related layout commit (see `navigation` on app context). */
export interface TabCommittedDetail {
  tab: Tab;
  previousTab: Tab | null;
  uiShellMode: UiShellMode;
}

/**
 * Optional flags for {@link AppActions.completeOnboarding} when finishing the
 * full onboarding wizard (not RuntimeGate).
 */
export interface CompleteOnboardingOptions {
  /**
   * When true, opens the `@elizaos/app-companion` overlay and syncs the URL to
   * `/apps/companion`. Ignored when companion mode or the apps surface is disabled.
   */
  launchCompanionOverlay?: boolean;
}

/** Tab commit subscription + deferred work (for multi-step navigation). */
export interface NavigationEventsApi {
  subscribeTabCommitted: (
    listener: (detail: TabCommittedDetail) => void,
  ) => () => void;
  /**
   * Run `fn` after the next layout commit where `tab` has been applied.
   * Use to chain `switchShellView` → `setTab` without the second call losing
   * to batched `setTab(lastNativeTab)`.
   */
  scheduleAfterTabCommit: (fn: () => void) => void;
}

export type OnboardingStep = "deployment" | "providers" | "features";

export interface OnboardingStepMeta {
  id: OnboardingStep;
  name: string;
  subtitle: string;
}

/** 3-step onboarding flow — setup, provider connection, then optional features. */
export const ONBOARDING_STEPS: OnboardingStepMeta[] = [
  {
    id: "deployment",
    name: "onboarding.stepName.deployment",
    subtitle: "onboarding.stepSub.deployment",
  },
  {
    id: "providers",
    name: "onboarding.stepName.providers",
    subtitle: "onboarding.stepSub.providers",
  },
  {
    id: "features",
    name: "onboarding.stepName.features",
    subtitle: "onboarding.stepSub.features",
  },
];

export type OnboardingMode = "basic" | "advanced" | "elizacloudonly";

export type FlaminaGuideTopic =
  | "provider"
  | "rpc"
  | "permissions"
  | "voice"
  | "features";

export interface OnboardingNextOptions {
  allowPermissionBypass?: boolean;
  omitRuntimeProvider?: boolean;
  skipTask?: string;
}

export const ONBOARDING_PERMISSION_LABELS: Record<SystemPermissionId, string> =
  {
    accessibility: "Accessibility",
    "screen-recording": "Screen Recording",
    microphone: "Microphone",
    camera: "Camera",
    shell: "Full Disk Access",
    "website-blocking": "Website Blocking",
    location: "Location",
  };

import type { ActionNotice } from "./action-notice";

export type { ActionNotice };

export type LifecycleAction = "start" | "stop" | "restart" | "reset";

export const LIFECYCLE_MESSAGES: Record<
  LifecycleAction,
  {
    inProgress: string;
    progress: string;
    success: string;
    verb: string;
  }
> = {
  start: {
    inProgress: "starting",
    progress: "Starting agent...",
    success: "Agent started.",
    verb: "start",
  },
  stop: {
    inProgress: "stopping",
    progress: "Stopping agent...",
    success: "Agent stopped.",
    verb: "stop",
  },

  restart: {
    inProgress: "restarting",
    progress: "Restarting agent...",
    success: "Agent restarted.",
    verb: "restart",
  },
  reset: {
    inProgress: "resetting",
    progress:
      "Resetting agent (server wipe + restart). This can take 1–2 minutes — keep the app open.",
    success: "Agent reset. Returning to onboarding.",
    verb: "reset",
  },
};

export type GamePostMessageAuthPayload = AppViewerAuthMessage;

export const AGENT_STATES: ReadonlySet<AgentStatus["state"]> = new Set([
  "not_started",
  "starting",
  "running",
  "stopped",
  "restarting",
  "error",
]);

export type SlashCommandInput = {
  name: string;
  argsRaw: string;
};

export type StartupPhase = "starting-backend" | "initializing-agent" | "ready";

export type StartupErrorReason =
  | "backend-timeout"
  | "backend-unreachable"
  | "agent-timeout"
  | "agent-error"
  | "asset-missing"
  | "unknown";

export interface StartupErrorState {
  reason: StartupErrorReason;
  phase: StartupPhase;
  message: string;
  detail?: string;
  status?: number;
  path?: string;
}

export interface StartupCoordinatorView {
  state: {
    phase:
      | "splash"
      | "restoring-session"
      | "resolving-target"
      | "polling-backend"
      | "pairing-required"
      | "onboarding-required"
      | "starting-runtime"
      | "hydrating"
      | "ready"
      | "error";
    [key: string]: unknown;
  };
  dispatch: (event: { type: string; [key: string]: unknown }) => void;
  retry: () => void;
  reset: () => void;
  pairingSuccess: () => void;
  onboardingComplete: () => void;
  policy: {
    supportsLocalRuntime: boolean;
    backendTimeoutMs: number;
    agentReadyTimeoutMs: number;
    probeForExistingInstall: boolean;
    defaultTarget: "embedded-local" | "remote-backend" | "cloud-managed" | null;
  };
  legacyPhase: StartupPhase;
  loading: boolean;
  terminal: boolean;
  target: "embedded-local" | "remote-backend" | "cloud-managed" | null;
  phase: StartupCoordinatorView["state"]["phase"];
}

export interface ApiLikeError {
  kind?: string;
  status?: number;
  path?: string;
  message?: string;
}

export interface ChatTurnUsage extends ChatTokenUsage {
  updatedAt: number;
}

// ── Context value type ─────────────────────────────────────────────────

/** One toggle per primary chain in the wallet inventory filter strip. */
export type InventoryChainFilters = {
  ethereum: boolean;
  base: boolean;
  bsc: boolean;
  avax: boolean;
  solana: boolean;
};

export interface AppState {
  // Core
  tab: Tab;
  uiShellMode: UiShellMode;
  uiLanguage: UiLanguage;
  uiTheme: UiTheme;
  /** Active visual theme ID (e.g. "bsc-gold", "neon-cyber") */
  themeId: string;
  ownerName: string | null;
  /** VRM quality vs GPU use: always full quality, battery-aware (default), or always efficient. */
  companionVrmPowerMode: CompanionVrmPowerMode;
  /**
   * When true and the document is hidden, keep the VRM render loop alive
   * but hide the 3D environment (lower GPU than full scene).
   */
  companionAnimateWhenHidden: boolean;
  /** When to cap companion at ~half display Hz (independent of DPR/shadows). */
  companionHalfFramerateMode: CompanionHalfFramerateMode;
  connected: boolean;
  agentStatus: AgentStatus | null;
  onboardingComplete: boolean;
  /** Incremented on agent reset so onboarding UI shows immediately (not stuck behind VRM reveal). */
  onboardingUiRevealNonce: number;
  onboardingLoading: boolean;
  startupPhase: StartupPhase;
  startupError: StartupErrorState | null;
  /** StartupCoordinator handle — the sole startup authority. */
  startupCoordinator: StartupCoordinatorView;
  authRequired: boolean;
  actionNotice: ActionNotice | null;
  lifecycleBusy: boolean;
  lifecycleAction: LifecycleAction | null;

  // Deferred restart
  pendingRestart: boolean;
  pendingRestartReasons: string[];
  restartBannerDismissed: boolean;

  // Backend connection state (for crash handling)
  backendConnection: {
    state: "connected" | "disconnected" | "reconnecting" | "failed";
    reconnectAttempt: number;
    maxReconnectAttempts: number;
    showDisconnectedUI: boolean;
  };
  backendDisconnectedBannerDismissed: boolean;

  // System warnings
  systemWarnings: string[];

  // Pairing
  pairingEnabled: boolean;
  pairingExpiresAt: number | null;
  pairingCodeInput: string;
  pairingError: string | null;
  pairingBusy: boolean;

  // Chat
  chatInput: string;
  chatSending: boolean;
  chatFirstTokenReceived: boolean;
  chatLastUsage: ChatTurnUsage | null;
  chatAvatarVisible: boolean;
  chatAgentVoiceMuted: boolean;
  chatMode: ConversationMode;
  chatAvatarSpeaking: boolean;
  conversations: Conversation[];
  activeConversationId: string | null;
  companionMessageCutoffTs: number;
  conversationMessages: ConversationMessage[];
  autonomousEvents: StreamEventEnvelope[];
  autonomousLatestEventId: string | null;
  autonomousRunHealthByRunId: import("./autonomy").AutonomyRunHealthMap;
  /** Active PTY coding agent sessions from the SwarmCoordinator. */
  ptySessions: CodingAgentSession[];
  /** Conversation IDs with unread proactive messages from the agent. */
  unreadConversations: Set<string>;

  // Triggers
  triggers: TriggerSummary[];
  triggersLoaded: boolean;
  triggersLoading: boolean;
  triggersSaving: boolean;
  triggerRunsById: Record<string, TriggerRunRecord[]>;
  triggerHealth: TriggerHealthSnapshot | null;
  triggerError: string | null;

  // Plugins
  plugins: PluginInfo[];
  pluginFilter: "all" | "ai-provider" | "connector" | "feature" | "streaming";
  pluginStatusFilter: "all" | "enabled" | "disabled";
  pluginSearch: string;
  pluginSettingsOpen: Set<string>;
  pluginAdvancedOpen: Set<string>;
  pluginSaving: Set<string>;
  pluginSaveSuccess: Set<string>;

  // Skills
  skills: SkillInfo[];
  skillsSubTab: "my" | "browse";
  skillCreateFormOpen: boolean;
  skillCreateName: string;
  skillCreateDescription: string;
  skillCreating: boolean;
  skillReviewReport: SkillScanReportSummary | null;
  skillReviewId: string;
  skillReviewLoading: boolean;
  skillToggleAction: string;
  skillsMarketplaceQuery: string;
  skillsMarketplaceResults: SkillMarketplaceResult[];
  skillsMarketplaceError: string;
  skillsMarketplaceLoading: boolean;
  skillsMarketplaceAction: string;
  skillsMarketplaceManualGithubUrl: string;

  // Logs
  logs: LogEntry[];
  logSources: string[];
  logTags: string[];
  logTagFilter: string;
  logLevelFilter: string;
  logSourceFilter: string;
  logLoadError: string | null;

  // Capabilities (feature toggles)
  browserEnabled: boolean;
  computerUseEnabled: boolean;

  // Wallet / Inventory
  walletEnabled: boolean;
  walletAddresses: WalletAddresses | null;
  walletConfig: WalletConfigStatus | null;
  walletBalances: WalletBalancesResponse | null;
  walletNfts: WalletNftsResponse | null;
  walletLoading: boolean;
  walletNftsLoading: boolean;
  inventoryView: "tokens" | "nfts";
  walletExportData: WalletExportResult | null;
  walletExportVisible: boolean;
  walletApiKeySaving: boolean;
  inventorySort: "chain" | "symbol" | "value";
  /** Ascending vs descending for the active `inventorySort` key. */
  inventorySortDirection: "asc" | "desc";
  inventoryChainFilters: InventoryChainFilters;
  walletError: string | null;
  wallets: WalletEntry[];
  walletPrimary: WalletPrimaryMap | null;
  walletPrimaryRestarting: Partial<Record<WalletChainKind, boolean>>;
  walletPrimaryPending: Partial<Record<WalletChainKind, boolean>>;
  cloudRefreshing: boolean;

  // ERC-8004 Registry
  registryStatus: RegistryStatus | null;
  registryLoading: boolean;
  registryRegistering: boolean;
  registryError: string | null;

  // Drop / Mint
  dropStatus: DropStatus | null;
  dropLoading: boolean;
  mintInProgress: boolean;
  mintResult: MintResult | null;
  mintError: string | null;
  mintShiny: boolean;

  whitelistStatus: WhitelistStatus | null;
  whitelistLoading: boolean;

  // Character
  characterData: CharacterData | null;
  characterLoading: boolean;
  characterSaving: boolean;
  characterSaveSuccess: string | null;
  characterSaveError: string | null;
  characterDraft: CharacterData;
  selectedVrmIndex: number;
  customVrmUrl: string;
  customVrmPreviewUrl: string;
  customBackgroundUrl: string;
  /** Active content pack ID, or null if no pack is selected. */
  activePackId: string | null;
  /** Active content pack custom catchphrase for voice preview override. */
  customCatchphrase: string;
  /** Active content pack voice preset ID override. */
  customVoicePresetId: string;
  /** Custom companion world URL from content pack (overrides day/night default). */
  customWorldUrl: string;

  // Eliza Cloud
  elizaCloudEnabled: boolean;
  elizaCloudVoiceProxyAvailable: boolean;
  elizaCloudConnected: boolean;
  elizaCloudHasPersistedKey: boolean;
  elizaCloudCredits: number | null;
  elizaCloudCreditsLow: boolean;
  elizaCloudCreditsCritical: boolean;
  /** Eliza Cloud returned 401 on balance check — inference will fail until the key is fixed. */
  elizaCloudAuthRejected: boolean;
  /** Non-fatal credits/API message from Eliza Cloud (e.g. unexpected response, network). */
  elizaCloudCreditsError: string | null;
  elizaCloudTopUpUrl: string;
  elizaCloudUserId: string | null;
  /** Last `reason` from GET /api/cloud/status (e.g. API-key-only vs OAuth). */
  elizaCloudStatusReason: string | null;
  cloudDashboardView: "overview" | "billing";
  elizaCloudLoginBusy: boolean;
  elizaCloudLoginError: string | null;
  elizaCloudDisconnecting: boolean;

  // Multi-agent profiles
  activeAgentProfile: AgentProfile | null;

  // Updates
  updateStatus: UpdateStatus | null;
  updateLoading: boolean;
  updateChannelSaving: boolean;

  // Extension
  extensionStatus: ExtensionStatus | null;
  extensionChecking: boolean;

  // Store
  storePlugins: RegistryPlugin[];
  storeSearch: string;
  storeFilter: "all" | "installed" | "ai-provider" | "connector" | "feature";
  storeLoading: boolean;
  storeInstalling: Set<string>;
  storeUninstalling: Set<string>;
  storeError: string | null;
  storeDetailPlugin: RegistryPlugin | null;
  storeSubTab: "plugins" | "skills";

  // Catalog
  catalogSkills: CatalogSkill[];
  catalogTotal: number;
  catalogPage: number;
  catalogTotalPages: number;
  catalogSort: "downloads" | "stars" | "updated" | "name";
  catalogSearch: string;
  catalogLoading: boolean;
  catalogError: string | null;
  catalogDetailSkill: CatalogSkill | null;
  catalogInstalling: Set<string>;
  catalogUninstalling: Set<string>;

  // Workbench
  workbenchLoading: boolean;
  workbench: WorkbenchOverview | null;
  workbenchTasksAvailable: boolean;
  workbenchTriggersAvailable: boolean;
  workbenchTodosAvailable: boolean;

  // Agent export/import
  exportBusy: boolean;
  exportPassword: string;
  exportIncludeLogs: boolean;
  exportError: string | null;
  exportSuccess: string | null;
  importBusy: boolean;
  importPassword: string;
  importFile: File | null;
  importError: string | null;
  importSuccess: string | null;

  // Startup
  startupStatus: string | null;

  // Onboarding
  onboardingStep: OnboardingStep;
  onboardingMode: OnboardingMode;
  onboardingActiveGuide: string | null;
  onboardingDeferredTasks: string[];
  postOnboardingChecklistDismissed: boolean;
  onboardingOptions: OnboardingOptions | null;
  onboardingName: string;
  onboardingOwnerName: string;
  onboardingStyle: string;
  onboardingServerTarget: OnboardingServerTarget;
  onboardingCloudApiKey: string;
  onboardingSmallModel: string;
  onboardingLargeModel: string;
  onboardingProvider: string;
  onboardingApiKey: string;
  onboardingVoiceProvider: string;
  onboardingVoiceApiKey: string;
  onboardingExistingInstallDetected: boolean;
  onboardingDetectedProviders: Array<{
    id: string;
    source: string;
    apiKey?: string;
    authMode?: string;
    status?: "valid" | "invalid" | "unchecked" | "error";
    cliInstalled: boolean;
  }>;
  onboardingRemoteApiBase: string;
  onboardingRemoteToken: string;
  onboardingRemoteConnecting: boolean;
  onboardingRemoteError: string | null;
  onboardingRemoteConnected: boolean;
  onboardingOpenRouterModel: string;
  onboardingPrimaryModel: string;
  onboardingTelegramToken: string;
  onboardingDiscordToken: string;
  onboardingWhatsAppSessionPath: string;
  onboardingTwilioAccountSid: string;
  onboardingTwilioAuthToken: string;
  onboardingTwilioPhoneNumber: string;
  onboardingBlooioApiKey: string;
  onboardingBlooioPhoneNumber: string;
  onboardingGithubToken: string;
  onboardingSubscriptionTab: "token" | "oauth";
  onboardingElizaCloudTab: "login" | "apikey";
  onboardingSelectedChains: Set<string>;
  onboardingRpcSelections: Record<string, string>;
  onboardingRpcKeys: Record<string, string>;
  onboardingAvatar: number;

  // Onboarding feature toggles (features step)
  onboardingFeatureTelegram: boolean;
  onboardingFeatureDiscord: boolean;
  onboardingFeaturePhone: boolean;
  onboardingFeatureCrypto: boolean;
  onboardingFeatureBrowser: boolean;
  onboardingFeatureComputerUse: boolean;
  /** Which feature is currently mid-OAuth flow, or null. */
  onboardingFeatureOAuthPending: string | null;
  onboardingCloudProvisionedContainer: boolean;

  // Command palette
  commandPaletteOpen: boolean;
  commandQuery: string;
  commandActiveIndex: number;
  closeCommandPalette: () => void;

  // Analysis Mode
  analysisMode: boolean;

  // Emote picker
  emotePickerOpen: boolean;

  // MCP
  mcpConfiguredServers: Record<string, McpServerConfig>;
  mcpServerStatuses: McpServerStatus[];
  mcpMarketplaceQuery: string;
  mcpMarketplaceResults: McpMarketplaceResult[];
  mcpMarketplaceLoading: boolean;
  mcpAction: string;
  mcpAddingServer: McpRegistryServerDetail | null;
  mcpAddingResult: McpMarketplaceResult | null;
  mcpEnvInputs: Record<string, string>;
  mcpHeaderInputs: Record<string, string>;

  // Share ingest
  droppedFiles: string[];
  shareIngestNotice: string;

  // Chat image attachments queued for the next message
  chatPendingImages: ImageAttachment[];

  // Game
  appRuns: AppRunSummary[];
  activeGameRunId: string;
  activeGameApp: string;
  activeGameDisplayName: string;
  activeGameViewerUrl: string;
  activeGameSandbox: string;
  activeGamePostMessageAuth: boolean;
  activeGamePostMessagePayload: GamePostMessageAuthPayload | null;
  activeGameSession: AppSessionState | null;

  /** When true, the game iframe persists as a floating overlay across all tabs. */
  gameOverlayEnabled: boolean;

  /** When true, the companion app is actively running (full-screen VRM scene). */
  companionAppRunning: boolean;
  /** Name of the active full-screen overlay app, or null if none. */
  activeOverlayApp: string | null;

  /**
   * Currently-selected connector chat in the messages sidebar.
   * When non-null, the Chat view swaps its main panel out for a
   * read-only view of that room's inbox messages. Mutually exclusive
   * with an active dashboard conversation.
   */
  activeInboxChat: {
    avatarUrl?: string;
    canSend?: boolean;
    id: string;
    source: string;
    transportSource?: string;
    title: string;
    worldId?: string;
    worldLabel?: string;
  } | null;

  /**
   * Currently-selected PTY session in the Terminal channel. When
   * non-null, ChatView renders a full-window terminal bound to this
   * session id. Mutually exclusive with `activeInboxChat` and a live
   * dashboard conversation.
   */
  activeTerminalSessionId: string | null;

  // Sub-tabs
  appsSubTab: "browse" | "running" | "games";
  agentSubTab: "character" | "inventory" | "documents";
  pluginsSubTab: "features" | "connectors" | "plugins";
  databaseSubTab: "tables" | "media" | "vectors";

  // Favorite apps
  favoriteApps: string[];

  // Recently launched apps, most recent first (capped)
  recentApps: string[];

  // Config text
  configRaw: Record<string, unknown>;
  configText: string;
}

export type LoadConversationMessagesResult =
  | { ok: true }
  | { ok: false; status?: number; message: string };

export const AGENT_TRANSFER_MIN_PASSWORD_LENGTH = 4;
export const AGENT_READY_TIMEOUT_MS = 120_000;

export interface AppActions {
  // Navigation
  setTab: (tab: Tab) => void;
  setUiShellMode: (mode: UiShellMode) => void;
  switchUiShellMode: (mode: UiShellMode) => void;
  switchShellView: (view: ShellView) => void;
  navigation: NavigationEventsApi;
  setUiLanguage: (language: UiLanguage) => void;
  setUiTheme: (theme: UiTheme) => void;
  setThemeId: (themeId: string) => void;
  setCompanionVrmPowerMode: (mode: CompanionVrmPowerMode) => void;
  setCompanionAnimateWhenHidden: (enabled: boolean) => void;
  setCompanionHalfFramerateMode: (mode: CompanionHalfFramerateMode) => void;

  // Lifecycle
  handleStart: () => Promise<void>;
  handleStop: () => Promise<void>;

  handleRestart: () => Promise<void>;
  handleReset: () => Promise<void>;
  /** After main-process app-menu reset (Electrobun): sync local React state + client. */
  handleResetAppliedFromMain: (payload: unknown) => Promise<void>;
  retryStartup: () => void;
  dismissRestartBanner: () => void;
  showRestartBanner: () => void;
  relaunchDesktop: () => Promise<void>;
  triggerRestart: () => Promise<void>;
  dismissBackendDisconnectedBanner: () => void;
  retryBackendConnection: () => void;
  restartBackend: () => Promise<void>;
  dismissSystemWarning: (message: string) => void;

  // Chat
  handleChatSend: (channelType?: ConversationChannelType) => Promise<void>;
  handleChatStop: () => void;
  handleChatRetry: (assistantMsgId: string) => void;
  handleChatEdit: (messageId: string, text: string) => Promise<boolean>;
  handleChatClear: () => Promise<void>;
  handleStartDraftConversation: () => Promise<void>;
  handleNewConversation: (title?: string) => Promise<void>;
  setChatPendingImages: Dispatch<SetStateAction<ImageAttachment[]>>;
  handleSelectConversation: (id: string) => Promise<void>;
  handleDeleteConversation: (id: string) => Promise<void>;
  handleRenameConversation: (id: string, title: string) => Promise<void>;
  /** LLM title from recent messages; persists on the server and updates local list. */
  suggestConversationTitle: (id: string) => Promise<string | null>;
  /** Send a programmatic message (e.g. from a UiSpec action) without touching chatInput. */
  sendActionMessage: (text: string) => Promise<void>;
  /** Send a chat message with optional metadata (e.g. task creation intent). */
  sendChatText: (
    rawInput: string,
    options?: {
      channelType?: ConversationChannelType;
      conversationId?: string | null;
      images?: ImageAttachment[];
      metadata?: Record<string, unknown>;
    },
  ) => Promise<void>;

  // Triggers
  loadTriggers: (options?: { silent?: boolean }) => Promise<void>;
  ensureTriggersLoaded: () => Promise<void>;
  createTrigger: (
    request: CreateTriggerRequest,
  ) => Promise<TriggerSummary | null>;
  updateTrigger: (
    id: string,
    request: UpdateTriggerRequest,
  ) => Promise<TriggerSummary | null>;
  deleteTrigger: (id: string) => Promise<boolean>;
  runTriggerNow: (id: string) => Promise<boolean>;
  loadTriggerRuns: (id: string) => Promise<void>;
  loadTriggerHealth: () => Promise<void>;

  // Pairing
  handlePairingSubmit: () => Promise<void>;

  // Plugins
  loadPlugins: (options?: { silent?: boolean }) => Promise<void>;
  ensurePluginsLoaded: () => Promise<void>;
  handlePluginToggle: (pluginId: string, enabled: boolean) => Promise<void>;
  handlePluginConfigSave: (
    pluginId: string,
    config: Record<string, string>,
  ) => Promise<void>;

  // Skills
  loadSkills: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  handleSkillToggle: (skillId: string, enabled: boolean) => Promise<void>;
  handleCreateSkill: () => Promise<void>;
  handleOpenSkill: (skillId: string) => Promise<void>;
  handleDeleteSkill: (skillId: string, name: string) => Promise<void>;
  handleReviewSkill: (skillId: string) => Promise<void>;
  handleAcknowledgeSkill: (skillId: string) => Promise<void>;
  searchSkillsMarketplace: () => Promise<void>;
  installSkillFromMarketplace: (item: SkillMarketplaceResult) => Promise<void>;
  uninstallMarketplaceSkill: (skillId: string, name: string) => Promise<void>;
  installSkillFromGithubUrl: () => Promise<void>;
  enableMarketplaceSkill: (skillId: string, name: string) => Promise<void>;
  disableMarketplaceSkill: (skillId: string, name: string) => Promise<void>;
  copyMarketplaceSkillSource: (skillId: string, name: string) => Promise<void>;

  // Logs
  loadLogs: () => Promise<void>;

  // Inventory
  loadInventory: () => Promise<void>;
  loadWalletConfig: () => Promise<void>;
  loadBalances: () => Promise<void>;
  loadNfts: () => Promise<void>;
  executeBscTrade: (
    request: BscTradeExecuteRequest,
  ) => Promise<BscTradeExecuteResponse>;
  executeBscTransfer: (
    request: BscTransferExecuteRequest,
  ) => Promise<BscTransferExecuteResponse>;
  getBscTradePreflight: (
    tokenAddress?: string,
  ) => Promise<BscTradePreflightResponse>;
  getBscTradeQuote: (
    request: BscTradeQuoteRequest,
  ) => Promise<BscTradeQuoteResponse>;
  getBscTradeTxStatus: (hash: string) => Promise<BscTradeTxStatusResponse>;
  getStewardStatus: () => Promise<StewardStatusResponse>;
  getStewardAddresses: () => Promise<StewardWalletAddressesResponse>;
  getStewardBalance: (chainId?: number) => Promise<StewardBalanceResponse>;
  getStewardTokens: (chainId?: number) => Promise<StewardTokenBalancesResponse>;
  getStewardWebhookEvents: (opts?: {
    event?: StewardWebhookEventType;
    since?: number;
  }) => Promise<StewardWebhookEventsResponse>;
  getStewardHistory: (opts?: {
    status?: string;
    limit?: number;
    offset?: number;
  }) => Promise<{
    records: StewardHistoryResponse;
    total: number;
    offset: number;
    limit: number;
  }>;
  getStewardPending: () => Promise<StewardPendingResponse>;
  approveStewardTx: (txId: string) => Promise<StewardApprovalActionResponse>;
  rejectStewardTx: (
    txId: string,
    reason?: string,
  ) => Promise<StewardApprovalActionResponse>;
  loadWalletTradingProfile: (
    window?: WalletTradingProfileWindow,
    source?: WalletTradingProfileSourceFilter,
  ) => Promise<WalletTradingProfileResponse>;
  handleWalletApiKeySave: (
    config: WalletConfigUpdateRequest,
  ) => Promise<boolean>;
  setWalletPrimary: (
    chain: WalletChainKind,
    source: WalletSource,
  ) => Promise<void>;
  refreshCloudWallets: () => Promise<void>;
  handleExportKeys: () => Promise<void>;

  // Registry / Drop
  loadRegistryStatus: () => Promise<void>;
  registerOnChain: () => Promise<void>;
  syncRegistryProfile: () => Promise<void>;
  loadDropStatus: () => Promise<void>;
  mintFromDrop: (shiny: boolean) => Promise<void>;
  loadWhitelistStatus: () => Promise<void>;

  // Character
  loadCharacter: () => Promise<void>;
  handleSaveCharacter: () => Promise<void>;
  handleCharacterFieldInput: <K extends keyof CharacterData>(
    field: K,
    value: CharacterData[K],
  ) => void;
  handleCharacterArrayInput: (
    field: "adjectives" | "postExamples",
    value: string,
  ) => void;
  handleCharacterStyleInput: (
    subfield: "all" | "chat" | "post",
    value: string,
  ) => void;
  handleCharacterMessageExamplesInput: (value: string) => void;

  // Onboarding
  handleOnboardingNext: (options?: OnboardingNextOptions) => Promise<void>;
  handleOnboardingBack: () => void;
  /** Jump to an earlier step in the active track (sidebar); backward-only. */
  handleOnboardingJumpToStep: (step: OnboardingStep) => void;
  /** Set onboarding step and sync Flamina guide (e.g. deployment → providers). */
  goToOnboardingStep: (step: OnboardingStep) => void;
  handleOnboardingRemoteConnect: () => Promise<void>;
  handleOnboardingUseLocalBackend: () => void;
  /**
   * Finalize onboarding without running the chat handoff.
   * Used by RuntimeGate: the gate only picks a runtime target; it does
   * not collect provider/character info, so there is no submit payload.
   * Dispatches ONBOARDING_COMPLETE to the startup coordinator.
   *
   * The full wizard passes `{ launchCompanionOverlay: true }` so first-time
   * setup lands in `@elizaos/app-companion` at `/apps/companion`. RuntimeGate
   * omits options and lands on chat only.
   */
  completeOnboarding: (
    landingTab?: Tab,
    options?: CompleteOnboardingOptions,
  ) => void;

  // Cloud
  handleCloudLogin: (prePoppedWindow?: Window | null) => Promise<void>;
  handleCloudDisconnect: (opts?: {
    skipConfirmation?: boolean;
  }) => Promise<void>;

  // Multi-agent
  switchAgentProfile: (profileId: string) => void;
  handleCloudOnboardingFinish: () => Promise<void>;

  // Vincent
  vincentConnected: boolean;
  vincentLoginBusy: boolean;
  vincentLoginError: string | null;
  handleVincentLogin: () => Promise<void>;
  handleVincentDisconnect: () => Promise<void>;

  // Updates
  loadUpdateStatus: (force?: boolean) => Promise<void>;
  handleChannelChange: (channel: ReleaseChannel) => Promise<void>;

  // Extension
  checkExtensionStatus: () => Promise<void>;

  // Emote picker
  openEmotePicker: () => void;
  closeEmotePicker: () => void;

  // Workbench
  loadWorkbench: () => Promise<void>;

  // Agent export/import
  handleAgentExport: () => Promise<void>;
  handleAgentImport: () => Promise<void>;

  // Action notice
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
    once?: boolean,
    busy?: boolean,
  ) => void;

  // Generic state setter
  setState: <K extends keyof AppState>(key: K, value: AppState[K]) => void;

  setAnalysisMode: (mode: boolean) => void;

  // Clipboard
  copyToClipboard: (text: string) => Promise<void>;

  // Translations
  t: (key: string, values?: Record<string, unknown>) => string;
}

export type AppContextValue = AppState & AppActions;
