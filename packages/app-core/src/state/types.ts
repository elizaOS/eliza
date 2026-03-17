import type { Dispatch, SetStateAction } from "react";
import type {
  AgentStatus,
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
import type { UiShellMode, UiTheme } from "./ui-preferences";

export type { UiShellMode } from "./ui-preferences";
export type ShellView = "companion" | "character" | "desktop";

export type OnboardingStep =
  | "wakeUp"
  | "identity"
  | "connection"
  | "rpc"
  | "senses"
  | "activate";

export interface OnboardingStepMeta {
  id: OnboardingStep;
  name: string;
  subtitle: string;
}

export const ONBOARDING_STEPS: OnboardingStepMeta[] = [
  {
    id: "wakeUp",
    name: "onboarding.stepName.wakeUp",
    subtitle: "onboarding.stepSub.wakeUp",
  },
  {
    id: "identity",
    name: "onboarding.stepName.identity",
    subtitle: "onboarding.stepSub.identity",
  },
  {
    id: "connection",
    name: "onboarding.connect",
    subtitle: "onboarding.stepSub.connection",
  },
  {
    id: "rpc",
    name: "onboarding.stepName.rpc",
    subtitle: "onboarding.stepSub.rpc",
  },
  {
    id: "senses",
    name: "onboarding.stepName.senses",
    subtitle: "onboarding.stepSub.senses",
  },
  {
    id: "activate",
    name: "onboarding.stepName.activate",
    subtitle: "onboarding.readyTitle",
  },
];

export interface OnboardingNextOptions {
  allowPermissionBypass?: boolean;
}

export const ONBOARDING_PERMISSION_LABELS: Record<SystemPermissionId, string> =
  {
    accessibility: "Accessibility",
    "screen-recording": "Screen Recording",
    microphone: "Microphone",
    camera: "Camera",
    shell: "Shell Access",
  };

export interface ActionNotice {
  tone: string;
  text: string;
}

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
    progress: "Resetting agent...",
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
  | "asset-missing";

export interface StartupErrorState {
  reason: StartupErrorReason;
  phase: StartupPhase;
  message: string;
  detail?: string;
  status?: number;
  path?: string;
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

export interface AppState {
  // Core
  tab: Tab;
  uiShellMode: UiShellMode;
  uiLanguage: UiLanguage;
  uiTheme: UiTheme;
  connected: boolean;
  agentStatus: AgentStatus | null;
  onboardingComplete: boolean;
  onboardingLoading: boolean;
  startupPhase: StartupPhase;
  startupError: StartupErrorState | null;
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
  // biome-ignore lint/suspicious/noExplicitAny: app-core keeps this app-owned replay map structural without importing app-local types.
  autonomousRunHealthByRunId: Record<string, any>; // defined in autonomy-events.ts in app
  /** Active PTY coding agent sessions from the SwarmCoordinator. */
  ptySessions: CodingAgentSession[];
  /** Conversation IDs with unread proactive messages from the agent. */
  unreadConversations: Set<string>;

  // Triggers
  triggers: TriggerSummary[];
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

  // Wallet / Inventory
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
  inventoryChainFocus: string;
  walletError: string | null;

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

  // Whitelist
  whitelistStatus: WhitelistStatus | null;
  whitelistLoading: boolean;
  twitterVerifyMessage: string | null;
  twitterVerifyUrl: string;
  twitterVerifying: boolean;

  // Character
  characterData: CharacterData | null;
  characterLoading: boolean;
  characterSaving: boolean;
  characterSaveSuccess: string | null;
  characterSaveError: string | null;
  characterDraft: CharacterData;
  selectedVrmIndex: number;
  customVrmUrl: string;
  customBackgroundUrl: string;

  // Eliza Cloud
  elizaCloudEnabled: boolean;
  elizaCloudConnected: boolean;
  elizaCloudCredits: number | null;
  elizaCloudCreditsLow: boolean;
  elizaCloudCreditsCritical: boolean;
  elizaCloudTopUpUrl: string;
  elizaCloudUserId: string | null;
  cloudDashboardView: "billing" | "agents";
  elizaCloudLoginBusy: boolean;
  elizaCloudLoginError: string | null;
  elizaCloudDisconnecting: boolean;

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

  // Onboarding
  onboardingStep: OnboardingStep;
  onboardingOptions: OnboardingOptions | null;
  onboardingName: string;
  onboardingOwnerName: string;
  onboardingStyle: string;
  onboardingRunMode: "local" | "cloud" | "";
  onboardingCloudProvider: string;
  onboardingSmallModel: string;
  onboardingLargeModel: string;
  onboardingProvider: string;
  onboardingApiKey: string;
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
  onboardingRestarting: boolean;

  // Command palette
  commandPaletteOpen: boolean;
  commandQuery: string;
  commandActiveIndex: number;
  closeCommandPalette: () => void;

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
  activeGameApp: string;
  activeGameDisplayName: string;
  activeGameViewerUrl: string;
  activeGameSandbox: string;
  activeGamePostMessageAuth: boolean;
  activeGamePostMessagePayload: GamePostMessageAuthPayload | null;

  /** When true, the game iframe persists as a floating overlay across all tabs. */
  gameOverlayEnabled: boolean;

  // Sub-tabs
  appsSubTab: "browse" | "games";
  agentSubTab: "character" | "inventory" | "knowledge";
  pluginsSubTab: "features" | "connectors" | "plugins";
  databaseSubTab: "tables" | "media" | "vectors";

  // Config text
  configRaw: Record<string, unknown>;
  configText: string;
}

export type LoadConversationMessagesResult =
  | { ok: true }
  | { ok: false; status?: number; message: string };

export const AGENT_TRANSFER_MIN_PASSWORD_LENGTH = 4;
export const AGENT_READY_TIMEOUT_MS = 90_000;

export interface AppActions {
  // Navigation
  setTab: (tab: Tab) => void;
  setUiShellMode: (mode: UiShellMode) => void;
  switchUiShellMode: (mode: UiShellMode) => void;
  switchShellView: (view: ShellView) => void;
  setUiLanguage: (language: UiLanguage) => void;
  setUiTheme: (theme: UiTheme) => void;

  // Lifecycle
  handleStart: () => Promise<void>;
  handleStop: () => Promise<void>;

  handleRestart: () => Promise<void>;
  handleReset: () => Promise<void>;
  retryStartup: () => void;
  dismissRestartBanner: () => void;
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
  handleNewConversation: (title?: string) => Promise<void>;
  setChatPendingImages: Dispatch<SetStateAction<ImageAttachment[]>>;
  handleSelectConversation: (id: string) => Promise<void>;
  handleDeleteConversation: (id: string) => Promise<void>;
  handleRenameConversation: (id: string, title: string) => Promise<void>;
  /** Send a programmatic message (e.g. from a UiSpec action) without touching chatInput. */
  sendActionMessage: (text: string) => Promise<void>;

  // Triggers
  loadTriggers: () => Promise<void>;
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
  loadPlugins: () => Promise<void>;
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

  // Logs
  loadLogs: () => Promise<void>;

  // Inventory
  loadInventory: () => Promise<void>;
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
  loadWalletTradingProfile: (
    window?: WalletTradingProfileWindow,
    source?: WalletTradingProfileSourceFilter,
  ) => Promise<WalletTradingProfileResponse>;
  handleWalletApiKeySave: (config: WalletConfigUpdateRequest) => Promise<void>;
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
  handleOnboardingRemoteConnect: () => Promise<void>;
  handleOnboardingUseLocalBackend: () => void;

  // Cloud
  handleCloudLogin: () => Promise<void>;
  handleCloudDisconnect: () => Promise<void>;

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
  ) => void;

  // Generic state setter
  setState: <K extends keyof AppState>(key: K, value: AppState[K]) => void;

  // Clipboard
  copyToClipboard: (text: string) => Promise<void>;

  // Translations
  // biome-ignore lint/suspicious/noExplicitAny: translation interpolation values are intentionally open-ended.
  t: (key: string, values?: Record<string, any>) => string;
}

export type AppContextValue = AppState & AppActions;
