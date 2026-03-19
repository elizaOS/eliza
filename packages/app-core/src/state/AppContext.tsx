/**
 * Global application state via React Context.
 *
 * Children access state and actions through the useApp() hook.
 */

import type { OnboardingConnection } from "@elizaos/autonomous/contracts/onboarding";
import { ONBOARDING_PROVIDER_CATALOG } from "@elizaos/autonomous/contracts/onboarding";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { prepareDraftForSave } from "../actions/character";
import { BrandingContext, DEFAULT_BRANDING } from "../config/branding";
import {
  type AgentStartupDiagnostics,
  type AgentStatus,
  type BscTradeExecuteRequest,
  type BscTradeExecuteResponse,
  type BscTradePreflightResponse,
  type BscTradeQuoteRequest,
  type BscTradeQuoteResponse,
  type BscTradeTxStatusResponse,
  type BscTransferExecuteRequest,
  type BscTransferExecuteResponse,
  type CatalogSkill,
  type CharacterData,
  type CodingAgentSession,
  type Conversation,
  type ConversationChannelType,
  type ConversationMessage,
  type ConversationMode,
  type CreateTriggerRequest,
  type CustomActionDef,
  client,
  type DropStatus,
  type ExtensionStatus,
  type ImageAttachment,
  type LogEntry,
  type McpMarketplaceResult,
  type McpRegistryServerDetail,
  type McpServerConfig,
  type McpServerStatus,
  MiladyClient,
  type MintResult,
  type OnboardingOptions,
  type PluginInfo,
  type RegistryPlugin,
  type RegistryStatus,
  type ReleaseChannel,
  type SkillInfo,
  type SkillMarketplaceResult,
  type SkillScanReportSummary,
  type StreamEventEnvelope,
  type StylePreset,
  type TriggerHealthSnapshot,
  type TriggerRunRecord,
  type TriggerSummary,
  type UpdateStatus,
  type UpdateTriggerRequest,
  type WalletAddresses,
  type WalletBalancesResponse,
  type WalletConfigStatus,
  type WalletConfigUpdateRequest,
  type WalletExportResult,
  type WalletNftsResponse,
  type WalletTradingProfileResponse,
  type WalletTradingProfileSourceFilter,
  type WalletTradingProfileWindow,
  type WhitelistStatus,
  type WorkbenchOverview,
} from "../api";
import {
  type AutonomyEventStore,
  type AutonomyRunHealthMap,
  buildAutonomyGapReplayRequests,
  hasPendingAutonomyGaps,
  markPendingAutonomyGapsPartial,
  mergeAutonomyEvents,
} from "../autonomy";
import {
  getBackendStartupTimeoutMs,
  invokeDesktopBridgeRequest,
  scanProviderCredentials,
} from "../bridge";
import {
  expandSavedCustomCommand,
  isRoutineCodingAgentMessage,
  loadSavedCustomCommands,
  normalizeSlashCommandName,
} from "../chat";
import { mapServerTasksToSessions } from "../coding";
import { type AppEmoteEventDetail, dispatchAppEmoteEvent } from "../events";
import {
  createTranslator,
  normalizeLanguage,
  t as translateText,
  type UiLanguage,
} from "../i18n";
import { COMPANION_ENABLED, pathForTab, type Tab, tabFromPath } from "../navigation";
import { buildOnboardingConnectionConfig } from "../onboarding-config";
import { getMissingOnboardingPermissions } from "../platform";
import {
  alertDesktopMessage,
  confirmDesktopAction,
  copyTextToClipboard,
  openExternalUrl,
  resolveApiUrl,
} from "../utils";
import {
  type ActionNotice,
  AGENT_READY_TIMEOUT_MS,
  AGENT_TRANSFER_MIN_PASSWORD_LENGTH,
  AppContext,
  type AppContextValue,
  type AppState,
  applyUiTheme,
  asApiLikeError,
  type ChatTurnUsage,
  clearPersistedOnboardingStep,
  deriveOnboardingResumeConnection,
  deriveOnboardingResumeFields,
  formatSearchBullet,
  formatStartupErrorDetail,
  type GamePostMessageAuthPayload,
  inferOnboardingResumeStep,
  LIFECYCLE_MESSAGES,
  type LifecycleAction,
  type LoadConversationMessagesResult,
  loadActiveConversationId,
  loadAvatarIndex,
  loadChatAvatarVisible,
  loadChatMode,
  loadChatVoiceMuted,
  loadCompanionMessageCutoffTs,
  loadLastNativeTab,
  loadPersistedConnectionMode,
  loadPersistedOnboardingStep,
  loadUiLanguage,
  loadUiTheme,
  mergeStreamingText,
  normalizeAvatarIndex,
  normalizeCustomActionName,
  normalizeUiShellMode,
  normalizeUiTheme,
  ONBOARDING_PERMISSION_LABELS,
  type OnboardingNextOptions,
  type OnboardingStep,
  parseAgentStatusEvent,
  parseCustomActionParams,
  parseProactiveMessageEvent,
  parseSlashCommandInput,
  parseStreamEventEnvelopeEvent,
  type ShellView,
  type StartupErrorState,
  type StartupPhase,
  saveActiveConversationId,
  saveAvatarIndex,
  saveChatAvatarVisible,
  saveChatMode,
  saveChatVoiceMuted,
  saveCompanionMessageCutoffTs,
  saveLastNativeTab,
  saveOnboardingStep,
  savePersistedConnectionMode,
  saveUiLanguage,
  saveUiShellMode,
  saveUiTheme,
  shouldApplyFinalStreamText,
  type UiShellMode,
  type UiTheme,
} from "./internal";
import {
  deriveUiShellModeForTab,
  getTabForShellView,
  shouldStartAtCharacterSelectOnLaunch,
} from "./shell-routing";

const AGENT_STATUS_POLL_INTERVAL_MS = 500;
const ONBOARDING_GREETING_READY_TIMEOUT_MS = 15_000;

export {
  type ActionNotice,
  AGENT_READY_TIMEOUT_MS,
  AGENT_STATES,
  AGENT_TRANSFER_MIN_PASSWORD_LENGTH,
  type AppActions,
  AppContext,
  type AppContextValue,
  type AppState,
  applyUiTheme,
  asApiLikeError,
  type ChatTurnUsage,
  computeStreamingDelta,
  formatSearchBullet,
  formatStartupErrorDetail,
  type GamePostMessageAuthPayload,
  getCompanionBackgroundUrl,
  getVrmBackgroundUrl,
  getVrmPreviewUrl,
  getVrmTitle,
  getVrmUrl,
  isOfficialVrmIndex,
  LIFECYCLE_MESSAGES,
  type LifecycleAction,
  type LoadConversationMessagesResult,
  loadAvatarIndex,
  loadChatAvatarVisible,
  loadChatMode,
  loadChatVoiceMuted,
  loadUiLanguage,
  loadUiShellMode,
  loadUiTheme,
  mergeStreamingText,
  normalizeAvatarIndex,
  normalizeCustomActionName,
  normalizeStreamComparisonText,
  normalizeUiShellMode,
  normalizeUiTheme,
  ONBOARDING_PERMISSION_LABELS,
  type OnboardingNextOptions,
  type OnboardingStep,
  parseAgentStartupDiagnostics,
  parseAgentStatusEvent,
  parseConversationMessageEvent,
  parseCustomActionParams,
  parseProactiveMessageEvent,
  parseSlashCommandInput,
  parseStreamEventEnvelopeEvent,
  type ShellView,
  type SlashCommandInput,
  type StartupErrorReason,
  type StartupErrorState,
  type StartupPhase,
  saveAvatarIndex,
  saveChatAvatarVisible,
  saveChatMode,
  saveChatVoiceMuted,
  saveUiLanguage,
  saveUiShellMode,
  saveUiTheme,
  shouldApplyFinalStreamText,
  type UiShellMode,
  type UiTheme,
  useApp,
  VRM_COUNT,
} from "./internal";

import {
  ConfirmModal,
  PromptModal,
  useConfirm,
  usePrompt,
} from "../components/ConfirmModal";
import { buildWalletRpcUpdateRequest } from "../wallet-rpc";

const GREETING_EMOTE_DELAY_MS = 1400;
const GREETING_WAVE_EMOTE: AppEmoteEventDetail = {
  emoteId: "wave",
  path: "/animations/emotes/waving-both-hands.glb",
  duration: 2.5,
  loop: false,
  showOverlay: false,
};
const ELIZA_CLOUD_LOGIN_POLL_INTERVAL_MS = 1000;
const ELIZA_CLOUD_LOGIN_TIMEOUT_MS = 300_000;
const ELIZA_CLOUD_LOGIN_MAX_CONSECUTIVE_ERRORS = 3;

function normalizeAppEmoteEvent(
  data: Record<string, unknown>,
): AppEmoteEventDetail | null {
  const emoteId = typeof data.emoteId === "string" ? data.emoteId : null;
  const path =
    typeof data.path === "string"
      ? data.path
      : typeof data.glbPath === "string"
        ? data.glbPath
        : null;
  if (!emoteId || !path) return null;
  return {
    emoteId,
    path,
    duration:
      typeof data.duration === "number" && Number.isFinite(data.duration)
        ? data.duration
        : 3,
    loop: data.loop === true,
    showOverlay: data.showOverlay !== false,
  };
}

function shouldKeepConversationMessage(message: ConversationMessage): boolean {
  if (message.role !== "assistant") return true;
  if (message.text.trim().length > 0) return true;
  return Boolean(message.blocks?.length);
}

function filterRenderableConversationMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  return messages.filter((message) => shouldKeepConversationMessage(message));
}

const COMPANION_STALE_THREAD_MAX_AGE_MS = 30 * 60 * 1000;
const COMPANION_STALE_THREAD_VISIBLE_MESSAGE_LIMIT = 2;

function isPersistedGreetingMessage(message: ConversationMessage): boolean {
  return (
    message.role === "assistant" &&
    message.source === "agent_greeting" &&
    message.text.trim().length > 0
  );
}

function shouldStartFreshCompanionConversation(
  messages: ConversationMessage[],
  now = Date.now(),
): boolean {
  const visibleMessages = messages
    .filter((message) => shouldKeepConversationMessage(message))
    .filter((message) => !isRoutineCodingAgentMessage(message))
    .slice(-COMPANION_STALE_THREAD_VISIBLE_MESSAGE_LIMIT);

  if (visibleMessages.length === 0) {
    return false;
  }

  if (
    visibleMessages.length === 1 &&
    isPersistedGreetingMessage(visibleMessages[0])
  ) {
    return false;
  }

  return visibleMessages.every((message) => {
    if (!Number.isFinite(message.timestamp)) {
      return false;
    }
    return now - message.timestamp > COMPANION_STALE_THREAD_MAX_AGE_MS;
  });
}

function isPrivateNetworkHost(host: string): boolean {
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return true;
  }
  return false;
}

function normalizeRemoteApiBaseInput(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Enter a backend address.");
  }
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed);
  const hostGuess = trimmed.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//, "");
  const guessedHost = hostGuess.split("/")[0]?.replace(/:\d+$/, "") ?? "";
  const defaultProtocol = isPrivateNetworkHost(guessedHost) ? "http" : "https";
  const candidate = hasScheme ? trimmed : `${defaultProtocol}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid backend address.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Remote backends must use http:// or https://.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function loadSessionApiBase(): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem("milady_api_base")?.trim() ?? "";
}

function isRemoteApiBase(baseUrl: string): boolean {
  if (!baseUrl || typeof window === "undefined") return false;
  try {
    const parsed = new URL(baseUrl);
    return (
      parsed.hostname !== window.location.hostname &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "::1"
    );
  } catch {
    return false;
  }
}

function getFlaminaTopicForOnboardingStep(
  step: OnboardingStep,
): AppState["onboardingActiveGuide"] {
  switch (step) {
    case "connection":
      return "provider";
    case "rpc":
      return "rpc";
    case "senses":
      return "permissions";
    default:
      return null;
  }
}

// ── Provider ───────────────────────────────────────────────────────────

export function AppProvider({
  children,
  branding: brandingOverride,
}: {
  children: ReactNode;
  branding?: Partial<import("../config/branding").BrandingConfig>;
}) {
  const [lastNativeTab, setLastNativeTabState] =
    useState<Tab>(loadLastNativeTab);
  // --- Core state ---
  const [tab, setTabRaw] = useState<Tab>("chat");
  const [uiLanguage, setUiLanguageState] = useState<UiLanguage>(loadUiLanguage);
  const [uiTheme, setUiThemeState] = useState<UiTheme>(loadUiTheme);
  const [connected, setConnected] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [onboardingLoading, setOnboardingLoading] = useState(true);
  const [startupPhase, setStartupPhase] =
    useState<StartupPhase>("starting-backend");
  const [startupError, setStartupError] = useState<StartupErrorState | null>(
    null,
  );
  const [startupRetryNonce, setStartupRetryNonce] = useState(0);
  const [authRequired, setAuthRequired] = useState(false);
  const [actionNotice, setActionNoticeState] = useState<ActionNotice | null>(
    null,
  );
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleAction, setLifecycleAction] =
    useState<LifecycleAction | null>(null);

  // --- Deferred restart ---
  const [pendingRestart, setPendingRestart] = useState(false);
  const [pendingRestartReasons, setPendingRestartReasons] = useState<string[]>(
    [],
  );
  const [restartBannerDismissed, setRestartBannerDismissed] = useState(false);

  // --- Backend connection state (for crash handling) ---
  const [backendConnection, setBackendConnection] = useState<{
    state: "connected" | "disconnected" | "reconnecting" | "failed";
    reconnectAttempt: number;
    maxReconnectAttempts: number;
    showDisconnectedUI: boolean;
  }>({
    state: "disconnected",
    reconnectAttempt: 0,
    maxReconnectAttempts: 15,
    showDisconnectedUI: false,
  });
  const [
    backendDisconnectedBannerDismissed,
    setBackendDisconnectedBannerDismissed,
  ] = useState(false);
  const [systemWarnings, setSystemWarnings] = useState<string[]>([]);
  const uiShellMode = deriveUiShellModeForTab(tab);

  // --- Pairing ---
  const [pairingEnabled, setPairingEnabled] = useState(false);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number | null>(null);
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);

  // --- Chat ---
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [chatFirstTokenReceived, setChatFirstTokenReceived] = useState(false);
  const [chatLastUsage, setChatLastUsage] = useState<ChatTurnUsage | null>(
    null,
  );
  const [chatAvatarVisible, setChatAvatarVisible] = useState(
    loadChatAvatarVisible,
  );
  const [chatAgentVoiceMuted, setChatAgentVoiceMuted] =
    useState(loadChatVoiceMuted);
  const [chatMode, setChatMode] = useState<ConversationMode>(loadChatMode);
  const [chatAvatarSpeaking, setChatAvatarSpeaking] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [companionMessageCutoffTs, setCompanionMessageCutoffTs] = useState(
    loadCompanionMessageCutoffTs,
  );
  const [conversationMessages, setConversationMessages] = useState<
    ConversationMessage[]
  >([]);
  const [autonomousEvents, setAutonomousEvents] = useState<
    StreamEventEnvelope[]
  >([]);
  const [autonomousLatestEventId, setAutonomousLatestEventId] = useState<
    string | null
  >(null);
  const [autonomousRunHealthByRunId, setAutonomousRunHealthByRunId] =
    useState<AutonomyRunHealthMap>({});
  const [ptySessions, setPtySessions] = useState<CodingAgentSession[]>([]);
  const [unreadConversations, setUnreadConversations] = useState<Set<string>>(
    new Set(),
  );
  const autonomousStoreRef = useRef<AutonomyEventStore>({
    eventsById: {},
    eventOrder: [],
    runIndex: {},
    watermark: null,
  });
  const autonomousEventsRef = useRef<StreamEventEnvelope[]>([]);
  const autonomousLatestEventIdRef = useRef<string | null>(null);
  const autonomousRunHealthByRunIdRef = useRef<AutonomyRunHealthMap>({});
  const autonomousReplayInFlightRef = useRef(false);
  const activeConversationIdRef = useRef<string | null>(null);
  const conversationMessagesRef = useRef<ConversationMessage[]>([]);
  const conversationsRef = useRef<Conversation[]>([]);
  const conversationHydrationEpochRef = useRef(0);

  useEffect(() => {
    autonomousEventsRef.current = autonomousEvents;
  }, [autonomousEvents]);

  useEffect(() => {
    autonomousLatestEventIdRef.current = autonomousLatestEventId;
  }, [autonomousLatestEventId]);

  useEffect(() => {
    autonomousRunHealthByRunIdRef.current = autonomousRunHealthByRunId;
  }, [autonomousRunHealthByRunId]);

  useEffect(() => {
    conversationMessagesRef.current = conversationMessages;
  }, [conversationMessages]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    saveChatAvatarVisible(chatAvatarVisible);
  }, [chatAvatarVisible]);

  useEffect(() => {
    saveChatVoiceMuted(chatAgentVoiceMuted);
  }, [chatAgentVoiceMuted]);

  useEffect(() => {
    saveChatMode(chatMode);
  }, [chatMode]);

  useEffect(() => {
    saveActiveConversationId(activeConversationId);
  }, [activeConversationId]);

  useEffect(() => {
    saveCompanionMessageCutoffTs(companionMessageCutoffTs);
  }, [companionMessageCutoffTs]);

  // --- Triggers ---
  const [triggers, setTriggers] = useState<TriggerSummary[]>([]);
  const [triggersLoading, setTriggersLoading] = useState(false);
  const [triggersSaving, setTriggersSaving] = useState(false);
  const [triggerRunsById, setTriggerRunsById] = useState<
    Record<string, TriggerRunRecord[]>
  >({});
  const [triggerHealth, setTriggerHealth] =
    useState<TriggerHealthSnapshot | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  // --- Plugins ---
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginFilter, setPluginFilter] = useState<
    "all" | "ai-provider" | "connector" | "feature" | "streaming"
  >("all");
  const [pluginStatusFilter, setPluginStatusFilter] = useState<
    "all" | "enabled" | "disabled"
  >("all");
  const [pluginSearch, setPluginSearch] = useState("");
  const [pluginSettingsOpen, setPluginSettingsOpen] = useState<Set<string>>(
    new Set(),
  );
  const [pluginAdvancedOpen, setPluginAdvancedOpen] = useState<Set<string>>(
    new Set(),
  );
  const [pluginSaving, setPluginSaving] = useState<Set<string>>(new Set());
  const [pluginSaveSuccess, setPluginSaveSuccess] = useState<Set<string>>(
    new Set(),
  );

  // --- Skills ---
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsSubTab, setSkillsSubTab] = useState<"my" | "browse">("my");
  const [skillCreateFormOpen, setSkillCreateFormOpen] = useState(false);
  const [skillCreateName, setSkillCreateName] = useState("");
  const [skillCreateDescription, setSkillCreateDescription] = useState("");
  const [skillCreating, setSkillCreating] = useState(false);
  const [skillReviewReport, setSkillReviewReport] =
    useState<SkillScanReportSummary | null>(null);
  const [skillReviewId, setSkillReviewId] = useState("");
  const [skillReviewLoading, setSkillReviewLoading] = useState(false);
  const [skillToggleAction, setSkillToggleAction] = useState("");
  const [skillsMarketplaceQuery, setSkillsMarketplaceQuery] = useState("");
  const [skillsMarketplaceResults, setSkillsMarketplaceResults] = useState<
    SkillMarketplaceResult[]
  >([]);
  const [skillsMarketplaceError, setSkillsMarketplaceError] = useState("");
  const [skillsMarketplaceLoading, setSkillsMarketplaceLoading] =
    useState(false);
  const [skillsMarketplaceAction, setSkillsMarketplaceAction] = useState("");
  const [
    skillsMarketplaceManualGithubUrl,
    setSkillsMarketplaceManualGithubUrl,
  ] = useState("");

  // --- Logs ---
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logSources, setLogSources] = useState<string[]>([]);
  const [logTags, setLogTags] = useState<string[]>([]);
  const [logTagFilter, setLogTagFilter] = useState("");
  const [logLevelFilter, setLogLevelFilter] = useState("");
  const [logSourceFilter, setLogSourceFilter] = useState("");

  // --- Wallet / Inventory ---
  const [walletAddresses, setWalletAddresses] =
    useState<WalletAddresses | null>(null);
  const [walletConfig, setWalletConfig] = useState<WalletConfigStatus | null>(
    null,
  );
  const [walletBalances, setWalletBalances] =
    useState<WalletBalancesResponse | null>(null);
  const [walletNfts, setWalletNfts] = useState<WalletNftsResponse | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletNftsLoading, setWalletNftsLoading] = useState(false);
  const [inventoryView, setInventoryView] = useState<"tokens" | "nfts">(
    "tokens",
  );
  const [walletExportData, setWalletExportData] =
    useState<WalletExportResult | null>(null);
  const [walletExportVisible, setWalletExportVisible] = useState(false);
  const [walletApiKeySaving, setWalletApiKeySaving] = useState(false);
  const [inventorySort, setInventorySort] = useState<
    "chain" | "symbol" | "value"
  >("value");
  const [inventoryChainFocus, setInventoryChainFocus] = useState<string>("all");
  const [walletError, setWalletError] = useState<string | null>(null);

  // --- ERC-8004 Registry ---
  const [registryStatus, setRegistryStatus] = useState<RegistryStatus | null>(
    null,
  );
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryRegistering, setRegistryRegistering] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);

  // --- Drop / Mint ---
  const [dropStatus, setDropStatus] = useState<DropStatus | null>(null);
  const [dropLoading, setDropLoading] = useState(false);
  const [mintInProgress, setMintInProgress] = useState(false);
  const [mintResult, setMintResult] = useState<MintResult | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [mintShiny, setMintShiny] = useState(false);

  // --- Whitelist ---
  const [whitelistStatus, setWhitelistStatus] =
    useState<WhitelistStatus | null>(null);
  const [whitelistLoading, setWhitelistLoading] = useState(false);
  const [twitterVerifyMessage] = useState<string | null>(null);
  const [twitterVerifyUrl] = useState("");
  const [twitterVerifying] = useState(false);

  // --- Character ---
  const [characterData, setCharacterData] = useState<CharacterData | null>(
    null,
  );
  const [characterLoading, setCharacterLoading] = useState(false);
  const [characterSaving, setCharacterSaving] = useState(false);
  const [characterSaveSuccess, setCharacterSaveSuccess] = useState<
    string | null
  >(null);
  const [characterSaveError, setCharacterSaveError] = useState<string | null>(
    null,
  );
  const [characterDraft, setCharacterDraft] = useState<CharacterData>({});
  const [selectedVrmIndex, setSelectedVrmIndexRaw] = useState(loadAvatarIndex);
  const [customVrmUrl, setCustomVrmUrl] = useState("");
  const [customBackgroundUrl, setCustomBackgroundUrl] = useState("");

  // Wrap setter to also persist to localStorage
  const setSelectedVrmIndex = useCallback((v: number) => {
    const normalized = normalizeAvatarIndex(v);
    setSelectedVrmIndexRaw(normalized);
    saveAvatarIndex(normalized);
    // Sync to server so headless stream capture uses the same avatar
    client.saveStreamSettings({ avatarIndex: normalized }).catch(() => { });
  }, []);

  // --- Eliza Cloud ---
  const [elizaCloudEnabled, setElizaCloudEnabled] = useState(false);
  const [elizaCloudConnected, setElizaCloudConnected] = useState(false);
  const [elizaCloudCredits, setElizaCloudCredits] = useState<number | null>(
    null,
  );
  const [elizaCloudCreditsLow, setElizaCloudCreditsLow] = useState(false);
  const [elizaCloudCreditsCritical, setElizaCloudCreditsCritical] =
    useState(false);
  const [elizaCloudTopUpUrl, setElizaCloudTopUpUrl] =
    useState("/cloud/billing");
  const [elizaCloudUserId, setElizaCloudUserId] = useState<string | null>(null);
  const [cloudDashboardView, setCloudDashboardView] = useState<
    "billing" | "agents"
  >("billing");
  const [elizaCloudLoginBusy, setElizaCloudLoginBusy] = useState(false);
  const [elizaCloudLoginError, setElizaCloudLoginError] = useState<
    string | null
  >(null);
  const [elizaCloudDisconnecting, setElizaCloudDisconnecting] = useState(false);

  // --- Updates ---
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateChannelSaving, setUpdateChannelSaving] = useState(false);

  // --- Extension ---
  const [extensionStatus, setExtensionStatus] =
    useState<ExtensionStatus | null>(null);
  const [extensionChecking, setExtensionChecking] = useState(false);

  // --- Store ---
  const [storePlugins, setStorePlugins] = useState<RegistryPlugin[]>([]);
  const [storeSearch, setStoreSearch] = useState("");
  const [storeFilter, setStoreFilter] = useState<
    "all" | "installed" | "ai-provider" | "connector" | "feature"
  >("all");
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeInstalling, setStoreInstalling] = useState<Set<string>>(
    new Set(),
  );
  const [storeUninstalling, setStoreUninstalling] = useState<Set<string>>(
    new Set(),
  );
  const [storeError, setStoreError] = useState<string | null>(null);
  const [storeDetailPlugin, setStoreDetailPlugin] =
    useState<RegistryPlugin | null>(null);
  const [storeSubTab, setStoreSubTab] = useState<"plugins" | "skills">(
    "plugins",
  );

  // --- Catalog ---
  const [catalogSkills, setCatalogSkills] = useState<CatalogSkill[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogTotalPages, setCatalogTotalPages] = useState(1);
  const [catalogSort, setCatalogSort] = useState<
    "downloads" | "stars" | "updated" | "name"
  >("downloads");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogDetailSkill, setCatalogDetailSkill] =
    useState<CatalogSkill | null>(null);
  const [catalogInstalling, setCatalogInstalling] = useState<Set<string>>(
    new Set(),
  );
  const [catalogUninstalling, setCatalogUninstalling] = useState<Set<string>>(
    new Set(),
  );

  // --- Workbench ---
  const [workbenchLoading, setWorkbenchLoading] = useState(false);
  const [workbench, setWorkbench] = useState<WorkbenchOverview | null>(null);
  const [workbenchTasksAvailable, setWorkbenchTasksAvailable] = useState(false);
  const [workbenchTriggersAvailable, setWorkbenchTriggersAvailable] =
    useState(false);
  const [workbenchTodosAvailable, setWorkbenchTodosAvailable] = useState(false);

  // --- Agent export/import ---
  const [exportBusy, setExportBusy] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [exportIncludeLogs, setExportIncludeLogs] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importPassword, setImportPassword] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  // --- Onboarding ---
  const [onboardingStep, setOnboardingStepRaw] = useState<OnboardingStep>(
    () =>
      loadPersistedOnboardingStep() ??
      (brandingOverride?.cloudOnly ? "identity" : "wakeUp"),
  );
  const [onboardingMode, setOnboardingMode] =
    useState<AppState["onboardingMode"]>("basic");
  const [onboardingActiveGuide, setOnboardingActiveGuide] = useState<
    AppState["onboardingActiveGuide"]
  >(null);
  const [onboardingDeferredTasks, setOnboardingDeferredTasks] = useState<
    AppState["onboardingDeferredTasks"]
  >([]);
  const [
    postOnboardingChecklistDismissed,
    setPostOnboardingChecklistDismissed,
  ] = useState(false);
  const [onboardingOptions, setOnboardingOptions] =
    useState<OnboardingOptions | null>(null);
  const [onboardingName, setOnboardingName] = useState("Eliza");
  const [onboardingOwnerName, setOnboardingOwnerName] = useState("anon");

  const [onboardingStyle, setOnboardingStyle] = useState("");
  const [onboardingRunMode, setOnboardingRunMode] = useState<
    "local" | "cloud" | ""
  >(brandingOverride?.cloudOnly ? "cloud" : "");
  const [onboardingCloudProvider, setOnboardingCloudProvider] = useState(
    brandingOverride?.cloudOnly ? "elizacloud" : "",
  );
  const [onboardingSmallModel, setOnboardingSmallModel] = useState(
    "moonshotai/kimi-k2-turbo",
  );
  const [onboardingLargeModel, setOnboardingLargeModel] = useState(
    "moonshotai/kimi-k2-0905",
  );
  const [onboardingProvider, setOnboardingProvider] = useState("");
  const [onboardingApiKey, setOnboardingApiKey] = useState("");
  const [onboardingDetectedProviders, setOnboardingDetectedProviders] =
    useState<
      Array<{
        id: string;
        source: string;
        apiKey?: string;
        authMode?: string;
        cliInstalled: boolean;
      }>
    >([]);
  const [onboardingRemoteApiBase, setOnboardingRemoteApiBase] =
    useState(loadSessionApiBase);
  const [onboardingRemoteToken, setOnboardingRemoteToken] = useState("");
  const [onboardingRemoteConnecting, setOnboardingRemoteConnecting] =
    useState(false);
  const [onboardingRemoteError, setOnboardingRemoteError] = useState<
    string | null
  >(null);
  const [onboardingRemoteConnected, setOnboardingRemoteConnected] = useState(
    () => isRemoteApiBase(loadSessionApiBase()),
  );
  const [onboardingOpenRouterModel, setOnboardingOpenRouterModel] =
    useState("");
  const [onboardingPrimaryModel, setOnboardingPrimaryModel] = useState("");
  const [onboardingTelegramToken, setOnboardingTelegramToken] = useState("");
  const [onboardingDiscordToken, setOnboardingDiscordToken] = useState("");
  const [onboardingWhatsAppSessionPath, setOnboardingWhatsAppSessionPath] =
    useState("");
  const [onboardingTwilioAccountSid, setOnboardingTwilioAccountSid] =
    useState("");
  const [onboardingTwilioAuthToken, setOnboardingTwilioAuthToken] =
    useState("");
  const [onboardingTwilioPhoneNumber, setOnboardingTwilioPhoneNumber] =
    useState("");
  const [onboardingBlooioApiKey, setOnboardingBlooioApiKey] = useState("");
  const [onboardingBlooioPhoneNumber, setOnboardingBlooioPhoneNumber] =
    useState("");
  const [onboardingGithubToken, setOnboardingGithubToken] = useState("");
  const [onboardingSubscriptionTab, setOnboardingSubscriptionTab] = useState<
    "token" | "oauth"
  >("token");
  const [onboardingElizaCloudTab, setOnboardingElizaCloudTab] = useState<
    "login" | "apikey"
  >("login");
  const [onboardingSelectedChains, setOnboardingSelectedChains] = useState<
    Set<string>
  >(new Set(["evm", "solana"]));
  const [onboardingRpcSelections, setOnboardingRpcSelections] = useState<
    Record<string, string>
  >({});
  const [onboardingRpcKeys, setOnboardingRpcKeys] = useState<
    Record<string, string>
  >({});
  const [onboardingAvatar, setOnboardingAvatar] = useState(1);
  const [onboardingRestarting, setOnboardingRestarting] = useState(false);

  const setOnboardingStep = useCallback((step: OnboardingStep) => {
    setOnboardingStepRaw(step);
    saveOnboardingStep(step);
  }, []);

  const startupStatus = useMemo<AppState["startupStatus"]>(() => {
    if (startupError) return "recoverable-error";
    if (authRequired) return "auth-blocked";
    if (onboardingLoading || startupPhase !== "ready") return "loading";
    if (!onboardingComplete) return "onboarding";
    return "ready";
  }, [
    authRequired,
    onboardingComplete,
    onboardingLoading,
    startupError,
    startupPhase,
  ]);

  const addDeferredOnboardingTask = useCallback(
    (task: NonNullable<AppState["onboardingActiveGuide"]>) => {
      setOnboardingDeferredTasks((current) =>
        current.includes(task) ? current : [...current, task],
      );
      setPostOnboardingChecklistDismissed(false);
    },
    [],
  );

  // --- Command palette ---
  const [commandPaletteOpen, _setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandActiveIndex, setCommandActiveIndex] = useState(0);

  // --- Emote picker ---
  const [emotePickerOpen, setEmotePickerOpen] = useState(false);

  // --- MCP ---
  const [mcpConfiguredServers, setMcpConfiguredServers] = useState<
    Record<string, McpServerConfig>
  >({});
  const [mcpServerStatuses, setMcpServerStatuses] = useState<McpServerStatus[]>(
    [],
  );
  const [mcpMarketplaceQuery, setMcpMarketplaceQuery] = useState("");
  const [mcpMarketplaceResults, setMcpMarketplaceResults] = useState<
    McpMarketplaceResult[]
  >([]);
  const [mcpMarketplaceLoading, setMcpMarketplaceLoading] = useState(false);
  const [mcpAction, setMcpAction] = useState("");
  const [mcpAddingServer, setMcpAddingServer] =
    useState<McpRegistryServerDetail | null>(null);
  const [mcpAddingResult, setMcpAddingResult] =
    useState<McpMarketplaceResult | null>(null);
  const [mcpEnvInputs, setMcpEnvInputs] = useState<Record<string, string>>({});
  const [mcpHeaderInputs, setMcpHeaderInputs] = useState<
    Record<string, string>
  >({});

  // --- Share ingest ---
  const [droppedFiles, setDroppedFiles] = useState<string[]>([]);
  const [shareIngestNotice, setShareIngestNotice] = useState("");

  // --- Chat pending images ---
  const [chatPendingImages, setChatPendingImages] = useState<ImageAttachment[]>(
    [],
  );

  // --- Game ---
  const [activeGameApp, setActiveGameApp] = useState("");
  const [activeGameDisplayName, setActiveGameDisplayName] = useState("");
  const [activeGameViewerUrl, setActiveGameViewerUrl] = useState("");
  const [activeGameSandbox, setActiveGameSandbox] = useState(
    "allow-scripts allow-same-origin allow-popups",
  );
  const [activeGamePostMessageAuth, setActiveGamePostMessageAuth] =
    useState(false);
  const [activeGamePostMessagePayload, setActiveGamePostMessagePayload] =
    useState<GamePostMessageAuthPayload | null>(null);
  const [gameOverlayEnabled, setGameOverlayEnabled] = useState(false);

  // --- Admin ---
  const [appsSubTab, setAppsSubTab] = useState<"browse" | "games">("browse");
  const [agentSubTab, setAgentSubTab] = useState<
    "character" | "inventory" | "knowledge"
  >("character");
  const [pluginsSubTab, setPluginsSubTab] = useState<
    "features" | "connectors" | "plugins"
  >("features");
  const [databaseSubTab, setDatabaseSubTab] = useState<
    "tables" | "media" | "vectors"
  >("tables");

  // --- Config ---
  const [configRaw, setConfigRaw] = useState<Record<string, unknown>>({});
  const [configText, setConfigText] = useState("");

  // --- Refs for timers ---
  const actionNoticeTimer = useRef<number | null>(null);
  /** Session-scoped set of notice texts that have been shown with once=true. */
  const shownOnceNotices = useRef<Set<string>>(new Set());
  const elizaCloudPollInterval = useRef<number | null>(null);
  const elizaCloudLoginPollTimer = useRef<number | null>(null);
  const prevAgentStateRef = useRef<string | null>(null);
  /** Tracks last agent status to skip no-op updates from WS heartbeats. */
  const agentStatusRef = useRef<AgentStatus | null>(null);
  const restartNotificationSignatureRef = useRef<string | null>(null);
  const heartbeatNotificationKeyRef = useRef<string | null>(null);
  /** Only call setAgentStatus when the payload has materially changed. */
  const setAgentStatusIfChanged = useCallback((next: AgentStatus | null) => {
    const prev = agentStatusRef.current;
    if (
      prev &&
      next &&
      prev.state === next.state &&
      prev.agentName === next.agentName &&
      prev.model === next.model &&
      prev.startedAt === next.startedAt
    ) {
      return; // identical — skip re-render
    }
    agentStatusRef.current = next;
    setAgentStatus(next);
  }, []);
  const lifecycleBusyRef = useRef(false);
  const lifecycleActionRef = useRef<LifecycleAction | null>(null);
  /** Synchronous lock for onboarding finish to prevent duplicate same-tick submits. */
  const onboardingFinishBusyRef = useRef(false);
  const onboardingResumeConnectionRef = useRef<OnboardingConnection | null>(
    null,
  );
  const pairingBusyRef = useRef(false);
  /** Guards against double-greeting when both init and state-transition paths fire. */
  const greetingFiredRef = useRef(false);
  const greetingInFlightConversationRef = useRef<string | null>(null);
  const greetingEmoteTimerRef = useRef<number | null>(null);
  const companionStaleConversationRefreshRef = useRef<string | null>(null);
  const onboardingCompletionCommittedRef = useRef(false);
  const chatAbortRef = useRef<AbortController | null>(null);
  /** Synchronous lock so same-tick chat submits cannot double-send. */
  const chatSendBusyRef = useRef(false);
  const chatSendNonceRef = useRef(0);
  /** Synchronous lock for export action to prevent duplicate clicks in the same tick. */
  const exportBusyRef = useRef(false);
  /** Synchronous lock for import action to prevent duplicate clicks in the same tick. */
  const importBusyRef = useRef(false);
  /** Synchronous lock for wallet API key save to prevent duplicate clicks in the same tick. */
  const walletApiKeySavingRef = useRef(false);
  /** Synchronous lock for cloud login action to prevent duplicate clicks in the same tick. */
  const elizaCloudLoginBusyRef = useRef(false);
  /** Synchronous lock for update channel changes to prevent duplicate submits. */
  const updateChannelSavingRef = useRef(false);
  /** Synchronous lock for onboarding completion submit to prevent duplicate clicks. */
  const onboardingFinishSavingRef = useRef(false);

  // --- Confirm Modal ---
  const { modalProps } = useConfirm();
  const { prompt: promptModal, modalProps: promptModalProps } = usePrompt();

  // ── Action notice ──────────────────────────────────────────────────

  const setActionNotice = useCallback(
    (
      text: string,
      tone: "info" | "success" | "error" = "info",
      ttlMs = 2800,
      once = false,
    ) => {
      if (once && shownOnceNotices.current.has(text)) return;
      if (once) shownOnceNotices.current.add(text);
      setActionNoticeState({ tone, text });
      if (actionNoticeTimer.current != null) {
        window.clearTimeout(actionNoticeTimer.current);
      }
      actionNoticeTimer.current = window.setTimeout(() => {
        setActionNoticeState(null);
        actionNoticeTimer.current = null;
      }, ttlMs);
    },
    [],
  );

  const scheduleGreetingWave = useCallback((showOverlay = false) => {
    if (typeof window === "undefined") return;
    if (greetingEmoteTimerRef.current != null) {
      window.clearTimeout(greetingEmoteTimerRef.current);
    }
    greetingEmoteTimerRef.current = window.setTimeout(() => {
      dispatchAppEmoteEvent({
        ...GREETING_WAVE_EMOTE,
        showOverlay,
      });
      greetingEmoteTimerRef.current = null;
    }, GREETING_EMOTE_DELAY_MS);
  }, []);

  const scheduleGreetingWaveForCompanion = useCallback(
    (showOverlay = false) => {
      if (uiShellMode !== "companion") {
        return;
      }
      scheduleGreetingWave(showOverlay);
    },
    [scheduleGreetingWave, uiShellMode],
  );

  useEffect(() => {
    return () => {
      if (greetingEmoteTimerRef.current != null) {
        window.clearTimeout(greetingEmoteTimerRef.current);
        greetingEmoteTimerRef.current = null;
      }
    };
  }, []);

  // ── Clipboard ──────────────────────────────────────────────────────

  const copyToClipboard = useCallback(async (text: string) => {
    await copyTextToClipboard(text);
  }, []);

  // ── Language ────────────────────────────────────────────────────────

  const setUiLanguage = useCallback(
    (language: UiLanguage) => {
      const nextLanguage = normalizeLanguage(language);
      setUiLanguageState(nextLanguage);
      void client.updateConfig({ ui: { language: nextLanguage } }).catch(() => {
        setActionNotice(
          translateText(nextLanguage, "settings.languageSyncFailed"),
          "error",
          3200,
        );
      });
    },
    [setActionNotice],
  );

  useEffect(() => {
    saveUiLanguage(uiLanguage);
    if (
      typeof (client as unknown as { setUiLanguage?: unknown })
        .setUiLanguage === "function"
    ) {
      (
        client as unknown as { setUiLanguage: (lang: string) => void }
      ).setUiLanguage(uiLanguage);
    }
  }, [uiLanguage]);

  useEffect(() => {
    saveUiShellMode(uiShellMode);
  }, [uiShellMode]);

  useEffect(() => {
    saveLastNativeTab(lastNativeTab);
  }, [lastNativeTab]);

  // ── Theme ──────────────────────────────────────────────────────────

  const setUiTheme = useCallback((theme: UiTheme) => {
    setUiThemeState(normalizeUiTheme(theme));
  }, []);

  useEffect(() => {
    saveUiTheme(uiTheme);
    applyUiTheme(uiTheme);
  }, [uiTheme]);

  // Apply theme on initial mount
  useEffect(() => {
    applyUiTheme(uiTheme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiTheme]);

  // ── Navigation ─────────────────────────────────────────────────────

  const setTab = useCallback(
    (newTab: Tab) => {
      setTabRaw(newTab);
      if (newTab === "apps") {
        setAppsSubTab(activeGameViewerUrl.trim() ? "games" : "browse");
      }
      const path = pathForTab(newTab);
      try {
        // In packaged desktop builds (file:// URLs), use hash routing to avoid
        // "Not allowed to load local resource: file:///..." errors.
        if (window.location.protocol === "file:") {
          window.location.hash = path;
        } else {
          window.history.pushState(null, "", path);
        }
      } catch (err) {
        console.warn("[milady][nav] failed to update browser location", err);
      }
    },
    [activeGameViewerUrl],
  );

  const setUiShellMode = useCallback(
    (mode: UiShellMode) => {
      const nextMode = normalizeUiShellMode(mode);
      if (nextMode === "companion") {
        setTab("companion");
        return;
      }
      setTab(lastNativeTab);
    },
    [lastNativeTab, setTab],
  );

  useEffect(() => {
    const shouldRememberTab =
      tab !== "companion" && tab !== "character" && tab !== "character-select";
    if (!shouldRememberTab) {
      return;
    }
    setLastNativeTabState((prev) => (prev === tab ? prev : tab));
  }, [tab]);

  const switchUiShellMode = useCallback(
    (mode: UiShellMode) => {
      const nextMode = normalizeUiShellMode(mode);
      if (nextMode === uiShellMode) {
        return;
      }

      if (nextMode === "native") {
        setTab(lastNativeTab);
        return;
      }

      setTab("companion");
    },
    [lastNativeTab, setTab, uiShellMode],
  );

  const switchShellView = useCallback(
    (view: ShellView) => {
      setTab(getTabForShellView(view, lastNativeTab));
    },
    [lastNativeTab, setTab],
  );

  const sortTriggersByNextRun = useCallback(
    (items: TriggerSummary[]): TriggerSummary[] => {
      return [...items].sort((a: TriggerSummary, b: TriggerSummary) => {
        const aNext = a.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
        const bNext = b.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
        if (aNext !== bNext) return aNext - bNext;
        return a.displayName.localeCompare(b.displayName);
      });
    },
    [],
  );

  // ── Data loading ───────────────────────────────────────────────────

  const loadPlugins = useCallback(async () => {
    try {
      const { plugins: p } = await client.getPlugins();
      setPlugins(p);
    } catch {
      /* ignore */
    }
  }, []);

  const loadSkills = useCallback(async () => {
    try {
      const { skills: s } = await client.getSkills();
      setSkills(s);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshSkills = useCallback(async () => {
    try {
      const { skills: s } = await client.refreshSkills();
      setSkills(s);
    } catch {
      try {
        const { skills: s } = await client.getSkills();
        setSkills(s);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const loadLogs = useCallback(async () => {
    try {
      const filter: Record<string, string> = {};
      if (logTagFilter) filter.tag = logTagFilter;
      if (logLevelFilter) filter.level = logLevelFilter;
      if (logSourceFilter) filter.source = logSourceFilter;
      const data = await client.getLogs(
        Object.keys(filter).length > 0 ? filter : undefined,
      );
      setLogs(data.entries);
      if (data.sources?.length) setLogSources(data.sources);
      if (data.tags?.length) setLogTags(data.tags);
    } catch {
      /* ignore */
    }
  }, [logTagFilter, logLevelFilter, logSourceFilter]);

  const loadTriggerHealth = useCallback(async () => {
    try {
      const health = await client.getTriggerHealth();
      setTriggerHealth(health);
    } catch {
      setTriggerHealth(null);
    }
  }, []);

  const loadTriggers = useCallback(async () => {
    setTriggersLoading(true);
    try {
      const data = await client.getTriggers();
      setTriggers(sortTriggersByNextRun(data.triggers));
      setTriggerError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load triggers";
      setTriggerError(message);
      setTriggers([]);
    } finally {
      setTriggersLoading(false);
    }
  }, [sortTriggersByNextRun]);

  const loadTriggerRuns = useCallback(async (id: string) => {
    try {
      const data = await client.getTriggerRuns(id);
      setTriggerRunsById((prev: Record<string, TriggerRunRecord[]>) => ({
        ...prev,
        [id]: data.runs,
      }));
      setTriggerError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load trigger runs";
      setTriggerError(message);
    }
  }, []);

  const createTrigger = useCallback(
    async (request: CreateTriggerRequest): Promise<TriggerSummary | null> => {
      setTriggersSaving(true);
      try {
        const response = await client.createTrigger(request);
        const created = response.trigger;
        setTriggers((prev: TriggerSummary[]) => {
          const merged = prev.filter(
            (item: TriggerSummary) => item.id !== created.id,
          );
          merged.push(created);
          return sortTriggersByNextRun(merged);
        });
        setTriggerError(null);
        void loadTriggerHealth();
        return created;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to create trigger";
        setTriggerError(message);
        return null;
      } finally {
        setTriggersSaving(false);
      }
    },
    [loadTriggerHealth, sortTriggersByNextRun],
  );

  const updateTrigger = useCallback(
    async (
      id: string,
      request: UpdateTriggerRequest,
    ): Promise<TriggerSummary | null> => {
      setTriggersSaving(true);
      try {
        const response = await client.updateTrigger(id, request);
        const updated = response.trigger;
        setTriggers((prev: TriggerSummary[]) => {
          const merged = prev.map((item: TriggerSummary) =>
            item.id === updated.id ? updated : item,
          );
          return sortTriggersByNextRun(merged);
        });
        setTriggerError(null);
        void loadTriggerHealth();
        return updated;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to update trigger";
        setTriggerError(message);
        return null;
      } finally {
        setTriggersSaving(false);
      }
    },
    [loadTriggerHealth, sortTriggersByNextRun],
  );

  const deleteTrigger = useCallback(
    async (id: string): Promise<boolean> => {
      setTriggersSaving(true);
      try {
        await client.deleteTrigger(id);
        setTriggers((prev: TriggerSummary[]) =>
          prev.filter((item: TriggerSummary) => item.id !== id),
        );
        setTriggerRunsById((prev: Record<string, TriggerRunRecord[]>) => {
          const next: Record<string, TriggerRunRecord[]> = {};
          for (const [key, runs] of Object.entries(prev)) {
            if (key !== id) next[key] = runs;
          }
          return next;
        });
        setTriggerError(null);
        void loadTriggerHealth();
        return true;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to delete trigger";
        setTriggerError(message);
        return false;
      } finally {
        setTriggersSaving(false);
      }
    },
    [loadTriggerHealth],
  );

  const runTriggerNow = useCallback(
    async (id: string): Promise<boolean> => {
      setTriggersSaving(true);
      try {
        const response = await client.runTriggerNow(id);
        if (response.trigger) {
          const trigger = response.trigger;
          setTriggers((prev: TriggerSummary[]) => {
            const idx = prev.findIndex(
              (item: TriggerSummary) => item.id === id,
            );
            if (idx === -1) {
              return sortTriggersByNextRun([...prev, trigger]);
            }
            const updated = [...prev];
            updated[idx] = trigger;
            return sortTriggersByNextRun(updated);
          });
        } else {
          await loadTriggers();
        }
        await loadTriggerRuns(id);
        void loadTriggerHealth();
        setTriggerError(null);
        return response.ok;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to run trigger";
        setTriggerError(message);
        return false;
      } finally {
        setTriggersSaving(false);
      }
    },
    [loadTriggerHealth, loadTriggerRuns, loadTriggers, sortTriggersByNextRun],
  );

  const applyAutonomyEventMerge = useCallback(
    (incomingEvents: StreamEventEnvelope[], replay = false) => {
      const merged = mergeAutonomyEvents({
        store: autonomousStoreRef.current,
        incomingEvents,
        runHealthByRunId: autonomousRunHealthByRunIdRef.current,
        replay,
      });
      autonomousStoreRef.current = merged.store;
      autonomousEventsRef.current = merged.events;
      autonomousLatestEventIdRef.current = merged.latestEventId;
      autonomousRunHealthByRunIdRef.current = merged.runHealthByRunId;

      setAutonomousEvents(merged.events);
      setAutonomousLatestEventId(merged.latestEventId);
      setAutonomousRunHealthByRunId(merged.runHealthByRunId);

      return merged;
    },
    [],
  );

  const fetchAutonomyReplay = useCallback(async () => {
    if (autonomousReplayInFlightRef.current) return;
    autonomousReplayInFlightRef.current = true;
    try {
      const afterEventId = autonomousStoreRef.current.watermark ?? undefined;
      const replay = await client.getAgentEvents({
        afterEventId,
        limit: 300,
      });

      if (replay.events.length > 0) {
        applyAutonomyEventMerge(replay.events);
      }

      const gapReplays = buildAutonomyGapReplayRequests(
        autonomousRunHealthByRunIdRef.current,
        autonomousStoreRef.current,
      ).slice(0, 4);

      for (const request of gapReplays) {
        const gapReplay = await client.getAgentEvents({
          runId: request.runId,
          fromSeq: request.fromSeq,
          limit: 300,
        });
        if (gapReplay.events.length > 0) {
          applyAutonomyEventMerge(gapReplay.events);
        }
      }

      if (hasPendingAutonomyGaps(autonomousRunHealthByRunIdRef.current)) {
        const partial = markPendingAutonomyGapsPartial(
          autonomousRunHealthByRunIdRef.current,
          Date.now(),
        );
        autonomousRunHealthByRunIdRef.current = partial;
        setAutonomousRunHealthByRunId(partial);
      }
    } catch (err) {
      if (hasPendingAutonomyGaps(autonomousRunHealthByRunIdRef.current)) {
        const partial = markPendingAutonomyGapsPartial(
          autonomousRunHealthByRunIdRef.current,
          Date.now(),
        );
        autonomousRunHealthByRunIdRef.current = partial;
        setAutonomousRunHealthByRunId(partial);
      }
      console.warn("[milady] Failed to fetch autonomous event replay", err);
    } finally {
      autonomousReplayInFlightRef.current = false;
    }
  }, [applyAutonomyEventMerge]);

  const appendAutonomousEvent = useCallback(
    (event: StreamEventEnvelope) => {
      const merged = applyAutonomyEventMerge([event]);
      if (merged.runsWithNewGaps.length > 0) {
        void fetchAutonomyReplay();
      }
    },
    [applyAutonomyEventMerge, fetchAutonomyReplay],
  );

  const loadConversations = useCallback(async (): Promise<
    Conversation[] | null
  > => {
    try {
      const { conversations: c } = await client.listConversations();
      setConversations(c);
      return c;
    } catch {
      return null;
    }
  }, []);

  const loadConversationMessages = useCallback(
    async (convId: string): Promise<LoadConversationMessagesResult> => {
      try {
        const { messages } = await client.getConversationMessages(convId);
        const nextMessages = filterRenderableConversationMessages(messages);
        greetingFiredRef.current = nextMessages.length > 0;
        conversationMessagesRef.current = nextMessages;
        setConversationMessages(nextMessages);
        return { ok: true };
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          const refreshed = await client.listConversations().catch(() => null);
          if (refreshed) {
            setConversations(refreshed.conversations);
            if (activeConversationIdRef.current === convId) {
              const fallbackId = refreshed.conversations[0]?.id ?? null;
              setActiveConversationId(fallbackId);
              activeConversationIdRef.current = fallbackId;
            }
          } else if (activeConversationIdRef.current === convId) {
            setActiveConversationId(null);
            activeConversationIdRef.current = null;
          }
        }
        greetingFiredRef.current = false;
        conversationMessagesRef.current = [];
        setConversationMessages([]);
        return {
          ok: false,
          status,
          message:
            err instanceof Error
              ? err.message
              : "Failed to load conversation messages",
        };
      }
    },
    [],
  );

  const loadWalletConfig = useCallback(async () => {
    try {
      const cfg = await client.getWalletConfig();
      setWalletConfig(cfg);
      setWalletAddresses({
        evmAddress: cfg.evmAddress,
        solanaAddress: cfg.solanaAddress,
      });
      setWalletError(null);
    } catch (err) {
      setWalletError(
        `Failed to load wallet config: ${err instanceof Error ? err.message : "network error"}`,
      );
    }
  }, []);

  const loadBalances = useCallback(async () => {
    setWalletLoading(true);
    setWalletError(null);
    try {
      const b = await client.getWalletBalances();
      setWalletBalances(b);
    } catch (err) {
      setWalletError(
        `Failed to fetch balances: ${err instanceof Error ? err.message : "network error"}`,
      );
    }
    setWalletLoading(false);
  }, []);

  const loadNfts = useCallback(async () => {
    setWalletNftsLoading(true);
    setWalletError(null);
    try {
      const n = await client.getWalletNfts();
      setWalletNfts(n);
    } catch (err) {
      setWalletError(
        `Failed to fetch NFTs: ${err instanceof Error ? err.message : "network error"}`,
      );
    }
    setWalletNftsLoading(false);
  }, []);

  const getBscTradePreflight = useCallback(
    async (tokenAddress?: string): Promise<BscTradePreflightResponse> =>
      client.getBscTradePreflight(tokenAddress),
    [],
  );

  const getBscTradeQuote = useCallback(
    async (request: BscTradeQuoteRequest): Promise<BscTradeQuoteResponse> =>
      client.getBscTradeQuote(request),
    [],
  );

  const getBscTradeTxStatus = useCallback(
    async (hash: string): Promise<BscTradeTxStatusResponse> =>
      client.getBscTradeTxStatus(hash),
    [],
  );

  const loadWalletTradingProfile = useCallback(
    async (
      window: WalletTradingProfileWindow = "30d",
      source: WalletTradingProfileSourceFilter = "all",
    ): Promise<WalletTradingProfileResponse> =>
      client.getWalletTradingProfile(window, source),
    [],
  );

  const executeBscTrade = useCallback(
    async (request: BscTradeExecuteRequest): Promise<BscTradeExecuteResponse> =>
      client.executeBscTrade(request),
    [],
  );

  const executeBscTransfer = useCallback(
    async (
      request: BscTransferExecuteRequest,
    ): Promise<BscTransferExecuteResponse> =>
      client.executeBscTransfer(request),
    [],
  );

  const loadInventory = useCallback(async () => {
    await loadWalletConfig();
  }, [loadWalletConfig]);

  const loadCharacter = useCallback(async () => {
    setCharacterLoading(true);
    setCharacterSaveError(null);
    setCharacterSaveSuccess(null);
    try {
      const { character } = await client.getCharacter();
      setCharacterData(character);
      setCharacterDraft({
        name: character.name ?? "",
        username: character.username ?? "",
        bio: Array.isArray(character.bio)
          ? character.bio.join("\n")
          : (character.bio ?? ""),
        system: character.system ?? "",
        adjectives: character.adjectives ?? [],
        topics: character.topics ?? [],
        style: {
          all: character.style?.all ?? [],
          chat: character.style?.chat ?? [],
          post: character.style?.post ?? [],
        },
        messageExamples: character.messageExamples ?? [],
        postExamples: character.postExamples ?? [],
      });
    } catch {
      setCharacterData(null);
      setCharacterDraft({});
    }
    setCharacterLoading(false);
  }, []);

  const loadWorkbench = useCallback(async () => {
    setWorkbenchLoading(true);
    try {
      const result = await client.getWorkbenchOverview();
      setWorkbench(result);
      setWorkbenchTasksAvailable(result.tasksAvailable ?? false);
      setWorkbenchTriggersAvailable(result.triggersAvailable ?? false);
      setWorkbenchTodosAvailable(result.todosAvailable ?? false);
    } catch {
      setWorkbench(null);
      setWorkbenchTasksAvailable(false);
      setWorkbenchTriggersAvailable(false);
      setWorkbenchTodosAvailable(false);
    } finally {
      setWorkbenchLoading(false);
    }
  }, []);

  const loadUpdateStatus = useCallback(async (force = false) => {
    setUpdateLoading(true);
    try {
      const status = await client.getUpdateStatus(force);
      setUpdateStatus(status);
    } catch {
      /* ignore */
    }
    setUpdateLoading(false);
  }, []);

  const checkExtensionStatus = useCallback(async () => {
    setExtensionChecking(true);
    try {
      const ext = await client.getExtensionStatus();
      setExtensionStatus(ext);
    } catch {
      setExtensionStatus({
        relayReachable: false,
        relayPort: 18792,
        extensionPath: null,
      });
    }
    setExtensionChecking(false);
  }, []);

  const pollCloudCredits = useCallback(async (): Promise<boolean> => {
    const cloudStatus = await client.getCloudStatus().catch(() => null);
    if (!cloudStatus) {
      setElizaCloudConnected(false);
      setElizaCloudCredits(null);
      setElizaCloudCreditsLow(false);
      setElizaCloudCreditsCritical(false);
      return false;
    }
    // A cached cloud API key represents a completed login and should be shared
    // across all views, even before runtime CLOUD_AUTH fully initializes.
    const isConnected = Boolean(cloudStatus.connected || cloudStatus.hasApiKey);
    setElizaCloudEnabled(Boolean(cloudStatus.enabled ?? false));
    setElizaCloudConnected(isConnected);
    setElizaCloudUserId(cloudStatus.userId ?? null);
    if (cloudStatus.topUpUrl) setElizaCloudTopUpUrl(cloudStatus.topUpUrl);
    if (isConnected) {
      const credits = await client.getCloudCredits().catch(() => null);
      if (credits && typeof credits.balance === "number") {
        setElizaCloudCredits(credits.balance);
        setElizaCloudCreditsLow(credits.low ?? false);
        setElizaCloudCreditsCritical(credits.critical ?? false);
        if (credits.topUpUrl) setElizaCloudTopUpUrl(credits.topUpUrl);
      } else {
        setElizaCloudCredits(null);
        setElizaCloudCreditsLow(false);
        setElizaCloudCreditsCritical(false);
        if (credits?.topUpUrl) setElizaCloudTopUpUrl(credits.topUpUrl);
      }
    } else {
      setElizaCloudCredits(null);
      setElizaCloudCreditsLow(false);
      setElizaCloudCreditsCritical(false);
    }
    return isConnected;
  }, []);

  // ── Lifecycle actions ──────────────────────────────────────────────

  const beginLifecycleAction = useCallback(
    (action: LifecycleAction): boolean => {
      if (lifecycleBusyRef.current) {
        const activeAction =
          lifecycleActionRef.current ?? lifecycleAction ?? action;
        setActionNotice(
          `Agent action already in progress (${LIFECYCLE_MESSAGES[activeAction].inProgress}). Please wait.`,
          "info",
          2800,
        );
        return false;
      }
      lifecycleBusyRef.current = true;
      lifecycleActionRef.current = action;
      setLifecycleBusy(true);
      setLifecycleAction(action);
      return true;
    },
    [lifecycleAction, setActionNotice],
  );

  const finishLifecycleAction = useCallback(() => {
    lifecycleBusyRef.current = false;
    lifecycleActionRef.current = null;
    setLifecycleBusy(false);
    setLifecycleAction(null);
  }, []);

  // ── Chat ───────────────────────────────────────────────────────────

  /** Request an agent greeting for a conversation and add it to messages. */
  const fetchGreeting = useCallback(
    async (
      convId: string,
      options?: {
        showOverlay?: boolean;
      },
    ): Promise<boolean> => {
      if (greetingInFlightConversationRef.current === convId) {
        return false;
      }
      greetingInFlightConversationRef.current = convId;
      try {
        const data = await client.requestGreeting(convId, uiLanguage);
        if (data.text) {
          greetingFiredRef.current = true;
          if (data.persisted === true) {
            scheduleGreetingWaveForCompanion(options?.showOverlay === true);
          }
          if (activeConversationIdRef.current === convId) {
            setConversationMessages((prev: ConversationMessage[]) => {
              if (
                prev.some(
                  (message) =>
                    message.role === "assistant" &&
                    message.source === "agent_greeting" &&
                    message.text === data.text,
                )
              ) {
                return prev;
              }
              return [
                ...prev,
                {
                  id: `greeting-${Date.now()}`,
                  role: "assistant",
                  text: data.text,
                  timestamp: Date.now(),
                  source: "agent_greeting",
                },
              ];
            });
          }
          return true;
        }
        greetingFiredRef.current = false;
      } catch {
        greetingFiredRef.current = false;
        /* greeting failed silently — user can still chat */
      } finally {
        if (greetingInFlightConversationRef.current === convId) {
          greetingInFlightConversationRef.current = null;
        }
      }
      return false;
    },
    [scheduleGreetingWaveForCompanion, uiLanguage],
  );

  const requestGreetingWhenRunning = useCallback(
    async (
      convId: string | null,
      options?: {
        showOverlay?: boolean;
      },
    ): Promise<void> => {
      if (!convId || greetingFiredRef.current) {
        return;
      }
      try {
        const status = await client.getStatus();
        if (status.state === "running" && !greetingFiredRef.current) {
          await fetchGreeting(convId, options);
        }
      } catch (err) {
        console.warn(
          "[milady][chat:init] failed to confirm runtime state for greeting",
          err,
        );
      }
    },
    [fetchGreeting],
  );

  const waitForOnboardingGreetingBootstrap = useCallback(async () => {
    const deadlineAt = Date.now() + ONBOARDING_GREETING_READY_TIMEOUT_MS;

    while (Date.now() < deadlineAt) {
      try {
        const status = await client.getStatus();
        setAgentStatus(status);
        setConnected(true);

        if (status.pendingRestart) {
          setPendingRestart(true);
          setPendingRestartReasons(status.pendingRestartReasons ?? []);
        }

        if (status.state === "running" || status.state === "error") {
          return;
        }
      } catch {
        setConnected(false);
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, AGENT_STATUS_POLL_INTERVAL_MS);
      });
    }
  }, []);

  const hydrateInitialConversationState = useCallback(async (): Promise<
    string | null
  > => {
    const hydrationEpoch = ++conversationHydrationEpochRef.current;
    const isCurrentHydration = () =>
      conversationHydrationEpochRef.current === hydrationEpoch;

    try {
      const { conversations: c } = await client.listConversations();
      if (!isCurrentHydration()) {
        return null;
      }
      setConversations(c);
      if (c.length > 0) {
        const savedConversationId = loadActiveConversationId();
        const restoredConversation =
          c.find((conversation) => conversation.id === savedConversationId) ??
          c[0];
        if (!isCurrentHydration()) {
          return null;
        }
        setActiveConversationId(restoredConversation.id);
        activeConversationIdRef.current = restoredConversation.id;
        client.sendWsMessage({
          type: "active-conversation",
          conversationId: restoredConversation.id,
        });
        try {
          const { messages } = await client.getConversationMessages(
            restoredConversation.id,
          );
          if (!isCurrentHydration()) {
            return null;
          }
          const nextMessages = filterRenderableConversationMessages(messages);
          greetingFiredRef.current = nextMessages.length > 0;
          conversationMessagesRef.current = nextMessages;
          setConversationMessages(nextMessages);
          return nextMessages.length === 0 ? restoredConversation.id : null;
        } catch (err) {
          if (!isCurrentHydration()) {
            return null;
          }
          console.warn(
            "[milady][chat:init] failed to load restored conversation messages",
            err,
          );
          greetingFiredRef.current = false;
          conversationMessagesRef.current = [];
          setConversationMessages([]);
          return restoredConversation.id;
        }
      }

      if (!isCurrentHydration()) {
        return null;
      }
      greetingFiredRef.current = false;
      conversationMessagesRef.current = [];
      setConversationMessages([]);
      setActiveConversationId(null);
      activeConversationIdRef.current = null;
      return null;
    } catch (err) {
      console.warn("[milady][chat:init] failed to hydrate conversations", err);
      return null;
    }
  }, []);

  const resetConversationDraftState = useCallback(() => {
    conversationHydrationEpochRef.current += 1;
    greetingFiredRef.current = false;
    greetingInFlightConversationRef.current = null;
    setChatInput("");
    setChatPendingImages([]);
    setChatSending(false);
    setChatFirstTokenReceived(false);
    conversationMessagesRef.current = [];
    setConversationMessages([]);
    setActiveConversationId(null);
    activeConversationIdRef.current = null;
    setCompanionMessageCutoffTs(Date.now());
  }, []);

  const handleStartDraftConversation = useCallback(async () => {
    resetConversationDraftState();
  }, [resetConversationDraftState]);

  const handleStart = useCallback(async () => {
    if (!beginLifecycleAction("start")) return;
    setActionNotice(LIFECYCLE_MESSAGES.start.progress, "info", 3000);
    try {
      const s = await client.startAgent();
      setAgentStatus(s);
      setActionNotice(LIFECYCLE_MESSAGES.start.success, "success", 2400);
    } catch (err) {
      setActionNotice(
        `Failed to ${LIFECYCLE_MESSAGES.start.verb} agent: ${err instanceof Error ? err.message : "unknown error"
        }`,
        "error",
        4200,
      );
    } finally {
      finishLifecycleAction();
    }
  }, [beginLifecycleAction, finishLifecycleAction, setActionNotice]);

  const handleStop = useCallback(async () => {
    if (!beginLifecycleAction("stop")) return;
    setActionNotice(LIFECYCLE_MESSAGES.stop.progress, "info", 3000);
    try {
      const s = await client.stopAgent();
      setAgentStatus(s);
      setActionNotice(LIFECYCLE_MESSAGES.stop.success, "success", 2400);
    } catch (err) {
      setActionNotice(
        `Failed to ${LIFECYCLE_MESSAGES.stop.verb} agent: ${err instanceof Error ? err.message : "unknown error"
        }`,
        "error",
        4200,
      );
    } finally {
      finishLifecycleAction();
    }
  }, [beginLifecycleAction, finishLifecycleAction, setActionNotice]);

  const handleRestart = useCallback(async () => {
    if (!beginLifecycleAction("restart")) return;
    setActionNotice(LIFECYCLE_MESSAGES.restart.progress, "info", 3200);
    try {
      setAgentStatus({
        ...(agentStatus ?? {
          agentName: "Milady",
          model: undefined,
          uptime: undefined,
          startedAt: undefined,
        }),
        state: "restarting",
      });
      // Server restart clears in-memory conversations — reset client state
      setActiveConversationId(null);
      setConversationMessages([]);
      setConversations([]);
      const s = await client.restartAgent();
      setAgentStatus(s);
      const greetConvId = await hydrateInitialConversationState();
      await requestGreetingWhenRunning(greetConvId, { showOverlay: true });
      setPendingRestart(false);
      setPendingRestartReasons([]);
      void loadPlugins();
      setActionNotice(LIFECYCLE_MESSAGES.restart.success, "success", 2400);
    } catch (err) {
      setActionNotice(
        `Failed to ${LIFECYCLE_MESSAGES.restart.verb} agent: ${err instanceof Error ? err.message : "unknown error"
        }`,
        "error",
        4200,
      );
      setTimeout(async () => {
        try {
          setAgentStatus(await client.getStatus());
        } catch {
          /* ignore */
        }
      }, 3000);
    } finally {
      finishLifecycleAction();
    }
  }, [
    agentStatus,
    beginLifecycleAction,
    finishLifecycleAction,
    setActionNotice,
    hydrateInitialConversationState,
    loadPlugins,
    requestGreetingWhenRunning,
  ]);

  const dismissRestartBanner = useCallback(() => {
    setRestartBannerDismissed(true);
  }, []);

  const showRestartBanner = useCallback(() => {
    setRestartBannerDismissed(false);
  }, []);

  const triggerRestart = useCallback(async () => {
    await handleRestart();
  }, [handleRestart]);

  // Backend disconnection banner actions
  const dismissBackendDisconnectedBanner = useCallback(() => {
    setBackendDisconnectedBannerDismissed(true);
  }, []);

  const retryBackendConnection = useCallback(() => {
    setBackendDisconnectedBannerDismissed(false);
    client.resetConnection();
  }, []);

  const dismissSystemWarning = useCallback((message: string) => {
    setSystemWarnings((prev) => prev.filter((m) => m !== message));
  }, []);

  const restartBackend = useCallback(async () => {
    const restarted = await invokeDesktopBridgeRequest({
      rpcMethod: "agentRestart",
      ipcChannel: "agent:restart",
    });
    if (restarted === null) {
      // Fallback for web: call API restart endpoint
      await client.restart();
    }
    // Reset connection state after restart
    setBackendConnection((prev) => ({
      ...prev,
      state: "disconnected",
      reconnectAttempt: 0,
      showDisconnectedUI: false,
    }));
    setBackendDisconnectedBannerDismissed(false);
  }, []);

  const relaunchDesktop = useCallback(async () => {
    const relaunched = await invokeDesktopBridgeRequest<void>({
      rpcMethod: "desktopRelaunch",
      ipcChannel: "desktop:relaunch",
    });
    if (relaunched === null) {
      await handleRestart();
    }
  }, [handleRestart]);

  const showDesktopNotification = useCallback(
    async (options: {
      title: string;
      body?: string;
      urgency?: "normal" | "critical" | "low";
      silent?: boolean;
    }) => {
      try {
        await invokeDesktopBridgeRequest<{ id: string }>({
          rpcMethod: "desktopShowNotification",
          ipcChannel: "desktop:showNotification",
          params: options,
        });
      } catch {
        /* ignore desktop notification failures */
      }
    },
    [],
  );

  const notifyHeartbeatEvent = useCallback(
    (event: StreamEventEnvelope) => {
      // biome-ignore lint/suspicious/noExplicitAny: heartbeat payloads are loosely typed
      const payload = event.payload as any;
      const status =
        typeof payload.status === "string"
          ? payload.status.trim().toLowerCase()
          : "ok";
      const silent = payload.silent === true;
      const isFailure = status === "error" || status === "failed";
      const isSkipped = status === "skipped";
      if (!isFailure && !isSkipped && silent) {
        return;
      }

      const eventTs =
        typeof payload.ts === "number"
          ? payload.ts
          : typeof event.ts === "number"
            ? event.ts
            : Date.now();
      const target =
        [
          typeof payload.channel === "string" ? payload.channel.trim() : "",
          typeof payload.to === "string" ? payload.to.trim() : "",
        ]
          .filter(Boolean)
          .join(" · ") || "background trigger";
      const notificationKey = `${eventTs}:${status}:${target}`;
      if (heartbeatNotificationKeyRef.current === notificationKey) {
        return;
      }
      heartbeatNotificationKeyRef.current = notificationKey;

      const preview =
        typeof payload.preview === "string" ? payload.preview.trim() : "";
      const reason =
        typeof payload.reason === "string" ? payload.reason.trim() : "";
      const duration =
        typeof payload.durationMs === "number"
          ? `Duration: ${Math.round(payload.durationMs)}ms`
          : "";

      const body = [target, preview, reason !== preview ? reason : "", duration]
        .filter(Boolean)
        .join("\n");

      void showDesktopNotification({
        title: isFailure
          ? "Heartbeat failed"
          : isSkipped
            ? "Heartbeat skipped"
            : "Heartbeat ran",
        body,
        urgency: isFailure ? "critical" : isSkipped ? "normal" : "low",
        silent: false,
      });
    },
    [showDesktopNotification],
  );

  useEffect(() => {
    if (!pendingRestart) {
      restartNotificationSignatureRef.current = null;
      return;
    }

    const signature =
      pendingRestartReasons.length > 0
        ? pendingRestartReasons.join("\n")
        : "restart-required";
    if (restartNotificationSignatureRef.current === signature) {
      return;
    }
    restartNotificationSignatureRef.current = signature;

    const summary =
      pendingRestartReasons.length === 1
        ? pendingRestartReasons[0]
        : pendingRestartReasons.length > 1
          ? `${pendingRestartReasons.length} changes are waiting for restart.`
          : "Restart required to apply changes.";

    void showDesktopNotification({
      title: "Restart required",
      body: `${summary}\nUse Restart Now from the banner or Milady > Restart Agent. Use Milady > Relaunch Milady when the desktop shell itself needs a full relaunch.`,
      urgency: "normal",
      silent: false,
    });
  }, [pendingRestart, pendingRestartReasons, showDesktopNotification]);

  const retryStartup = useCallback(() => {
    setStartupError(null);
    setAuthRequired(false);
    setOnboardingLoading(true);
    setStartupPhase("starting-backend");
    setStartupRetryNonce((prev) => prev + 1);
  }, []);

  const handleReset = useCallback(async () => {
    if (lifecycleBusyRef.current) {
      const activeAction =
        lifecycleActionRef.current ?? lifecycleAction ?? "reset";
      setActionNotice(
        `Agent action already in progress (${LIFECYCLE_MESSAGES[activeAction].inProgress}). Please wait.`,
        "info",
        2800,
      );
      return;
    }
    const confirmed = await confirmDesktopAction({
      title: "Reset Agent",
      message:
        "This will completely reset the agent, wiping all config, memory, and data.",
      detail: "You will be taken back to the onboarding wizard.",
      confirmLabel: "Reset",
      cancelLabel: "Cancel",
      type: "warning",
    });
    if (!confirmed) return;
    if (!beginLifecycleAction("reset")) return;
    setActionNotice(LIFECYCLE_MESSAGES.reset.progress, "info", 3200);
    try {
      await client.resetAgent();
      setAgentStatus(null);
      onboardingCompletionCommittedRef.current = false;
      setOnboardingComplete(false);
      onboardingResumeConnectionRef.current = null;
      setOnboardingStep("wakeUp");
      setConversationMessages([]);
      setActiveConversationId(null);
      activeConversationIdRef.current = null;
      setConversations([]);
      setPlugins([]);
      setSkills([]);
      setLogs([]);
      try {
        const options = await client.getOnboardingOptions();
        setOnboardingOptions(options);
      } catch {
        /* ignore */
      }
      setActionNotice(LIFECYCLE_MESSAGES.reset.success, "success", 3200);
    } catch (err) {
      setActionNotice(
        `Failed to ${LIFECYCLE_MESSAGES.reset.verb} agent: ${err instanceof Error ? err.message : "unknown error"
        }`,
        "error",
        4200,
      );
      await alertDesktopMessage({
        title: "Reset Failed",
        message: "Reset failed. Check the console for details.",
        type: "error",
      });
    } finally {
      finishLifecycleAction();
    }
  }, [
    lifecycleAction,
    beginLifecycleAction,
    finishLifecycleAction,
    setActionNotice,
    setOnboardingStep,
  ]);

  const handleNewConversation = useCallback(
    async (title?: string) => {
      const previousConversationId = activeConversationIdRef.current;
      const previousMessages = conversationMessagesRef.current;
      const previousCutoffTs = companionMessageCutoffTs;

      resetConversationDraftState();

      try {
        const { conversation, greeting } = await client.createConversation(
          title,
          {
            bootstrapGreeting: true,
            lang: uiLanguage,
          },
        );
        const nextCutoffTs = Date.now();
        setConversations((prev) => [conversation, ...prev]);
        setActiveConversationId(conversation.id);
        activeConversationIdRef.current = conversation.id;
        setCompanionMessageCutoffTs(nextCutoffTs);
        const greetingText = greeting?.text?.trim() ?? "";
        if (greetingText) {
          greetingFiredRef.current = true;
          if (greeting?.persisted === true) {
            scheduleGreetingWaveForCompanion();
          }
          setConversationMessages([
            {
              id: `greeting-${Date.now()}`,
              role: "assistant",
              text: greetingText,
              timestamp: Date.now(),
              source: "agent_greeting",
            },
          ]);
        } else {
          greetingFiredRef.current = false;
          setConversationMessages([]);
          void requestGreetingWhenRunning(conversation.id);
        }
        client.sendWsMessage({
          type: "active-conversation",
          conversationId: conversation.id,
        });
      } catch {
        setActiveConversationId(previousConversationId);
        activeConversationIdRef.current = previousConversationId;
        setConversationMessages(previousMessages);
        setCompanionMessageCutoffTs(previousCutoffTs);
        greetingFiredRef.current = previousMessages.length > 0;
        if (previousConversationId) {
          client.sendWsMessage({
            type: "active-conversation",
            conversationId: previousConversationId,
          });
        }
      }
    },
    [
      companionMessageCutoffTs,
      requestGreetingWhenRunning,
      resetConversationDraftState,
      scheduleGreetingWaveForCompanion,
      uiLanguage,
    ],
  );

  useEffect(() => {
    if (uiShellMode !== "companion" || tab !== "companion") {
      companionStaleConversationRefreshRef.current = null;
      return;
    }

    if (!activeConversationId) {
      return;
    }

    if (!shouldStartFreshCompanionConversation(conversationMessages)) {
      companionStaleConversationRefreshRef.current = null;
      return;
    }

    if (companionStaleConversationRefreshRef.current === activeConversationId) {
      return;
    }

    companionStaleConversationRefreshRef.current = activeConversationId;
    void handleNewConversation();
  }, [
    activeConversationId,
    conversationMessages,
    handleNewConversation,
    tab,
    uiShellMode,
  ]);

  const appendLocalCommandTurn = useCallback(
    (userText: string, assistantText: string) => {
      const now = Date.now();
      const nonce = Math.random().toString(36).slice(2, 8);
      setConversationMessages((prev: ConversationMessage[]) => [
        ...prev,
        {
          id: `local-user-${now}-${nonce}`,
          role: "user",
          text: userText,
          timestamp: now,
        },
        {
          id: `local-assistant-${now}-${nonce}`,
          role: "assistant",
          text: assistantText,
          timestamp: now,
          source: "local_command",
        },
      ]);
    },
    [],
  );

  const tryHandlePrefixedChatCommand = useCallback(
    async (
      rawText: string,
    ): Promise<{ handled: boolean; rewrittenText?: string }> => {
      const slash = parseSlashCommandInput(rawText);
      if (slash) {
        const savedCommand = loadSavedCustomCommands().find(
          (command) => normalizeSlashCommandName(command.name) === slash.name,
        );
        if (savedCommand) {
          const rewrittenText = expandSavedCustomCommand(
            savedCommand.text,
            slash.argsRaw,
          );
          if (!rewrittenText.trim()) {
            appendLocalCommandTurn(
              rawText,
              `Saved command "/${slash.name}" is empty.`,
            );
            return { handled: true };
          }
          return { handled: false, rewrittenText };
        }

        if (slash.name === "commands") {
          const customActions = (await client.listCustomActions()).filter(
            (action) => action.enabled,
          );
          const customCommandNames = customActions
            .map((action) => `/${action.name.toLowerCase()}`)
            .sort();
          const savedCommandNames = loadSavedCustomCommands()
            .map((command) => `/${normalizeSlashCommandName(command.name)}`)
            .sort();
          const lines = [
            formatSearchBullet("Saved / commands", savedCommandNames),
            formatSearchBullet("Custom action / commands", customCommandNames),
            "Use #remember ... to save memory notes. Use #memory or #knowledge to target retrieval.",
            "Use $query for a quick, non-persistent context answer.",
          ];
          appendLocalCommandTurn(rawText, lines.join("\n\n"));
          return { handled: true };
        }

        let customActions: CustomActionDef[] = [];
        try {
          customActions = (await client.listCustomActions()).filter(
            (action) => action.enabled,
          );
        } catch {
          // If custom actions can't be loaded, fall back to normal slash routing.
          return { handled: false };
        }

        const customAction = customActions.find(
          (action) =>
            `/${normalizeCustomActionName(action.name).toLowerCase()}` ===
            slash.name,
        );
        if (customAction) {
          const { params, missingRequired } = parseCustomActionParams(
            customAction,
            slash.argsRaw,
          );
          if (missingRequired.length > 0) {
            appendLocalCommandTurn(
              rawText,
              `Missing required parameter(s): ${missingRequired.join(", ")}`,
            );
            return { handled: true };
          }

          const result = await client.testCustomAction(customAction.id, params);
          if (!result.ok) {
            appendLocalCommandTurn(
              rawText,
              `Custom action "${customAction.name}" failed: ${result.error ?? "unknown error"
              }`,
            );
            return { handled: true };
          }

          appendLocalCommandTurn(
            rawText,
            result.output?.trim() || `(no output from ${customAction.name})`,
          );
          return { handled: true };
        }
      }

      if (rawText.startsWith("#")) {
        const commandBody = rawText.slice(1).trim();
        if (!commandBody) {
          appendLocalCommandTurn(
            rawText,
            "Usage: #remember <text>, #memory <query>, #knowledge <query>, or #<query>.",
          );
          return { handled: true };
        }

        const lower = commandBody.toLowerCase();
        if (
          lower.startsWith("remember ") ||
          lower.startsWith("remmeber ") ||
          lower.startsWith("save ")
        ) {
          const memoryText = commandBody
            .replace(/^(remember|remmeber|save)\s+/i, "")
            .trim();
          if (!memoryText) {
            appendLocalCommandTurn(rawText, "Nothing to remember.");
            return { handled: true };
          }
          await client.rememberMemory(memoryText);
          appendLocalCommandTurn(rawText, `Saved memory note: "${memoryText}"`);
          return { handled: true };
        }

        let scope: "memory" | "knowledge" | "all" = "all";
        let query = commandBody;
        if (lower.startsWith("memory ")) {
          scope = "memory";
          query = commandBody.slice("memory ".length).trim();
        } else if (lower.startsWith("knowledge ")) {
          scope = "knowledge";
          query = commandBody.slice("knowledge ".length).trim();
        } else if (lower.startsWith("all ")) {
          scope = "all";
          query = commandBody.slice("all ".length).trim();
        }

        if (!query) {
          appendLocalCommandTurn(rawText, "Search query cannot be empty.");
          return { handled: true };
        }

        const [memoryResult, knowledgeResult] = await Promise.all([
          scope === "knowledge"
            ? Promise.resolve(null)
            : client.searchMemory(query, { limit: 6 }),
          scope === "memory"
            ? Promise.resolve(null)
            : client.searchKnowledge(query, { threshold: 0.2, limit: 6 }),
        ]);

        const memoryLines =
          memoryResult?.results.map(
            (item, index) =>
              `${index + 1}. ${item.text.replace(/\s+/g, " ").trim()}`,
          ) ?? [];
        const knowledgeLines =
          knowledgeResult?.results.map(
            (item, index) =>
              `${index + 1}. ${item.text.replace(/\s+/g, " ").trim()} (sim ${item.similarity.toFixed(2)})`,
          ) ?? [];

        appendLocalCommandTurn(
          rawText,
          [
            scope === "memory"
              ? "Memory search"
              : scope === "knowledge"
                ? "Knowledge search"
                : "Memory + knowledge search",
            "",
            scope === "knowledge"
              ? ""
              : formatSearchBullet("Memories", memoryLines),
            scope === "memory"
              ? ""
              : formatSearchBullet("Knowledge", knowledgeLines),
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        return { handled: true };
      }

      if (rawText.startsWith("$")) {
        const queryRaw = rawText.slice(1).trim();
        if (queryRaw) {
          appendLocalCommandTurn(
            rawText,
            "Use bare `$` only. `$ <text>` is not supported.",
          );
          return { handled: true };
        }
        const query =
          "What is most relevant from memory and knowledge right now?";

        const quick = await client.quickContext(query, { limit: 6 });
        const memoryLines = quick.memories.map(
          (item, index) =>
            `${index + 1}. ${item.text.replace(/\s+/g, " ").trim()}`,
        );
        const knowledgeLines = quick.knowledge.map(
          (item, index) =>
            `${index + 1}. ${item.text.replace(/\s+/g, " ").trim()} (sim ${item.similarity.toFixed(2)})`,
        );
        appendLocalCommandTurn(
          rawText,
          [
            quick.answer,
            "",
            formatSearchBullet("Memories used", memoryLines),
            formatSearchBullet("Knowledge used", knowledgeLines),
          ].join("\n"),
        );
        return { handled: true };
      }

      return { handled: false };
    },
    [appendLocalCommandTurn],
  );

  const sendChatText = useCallback(
    async (
      rawInput: string,
      options?: {
        channelType?: ConversationChannelType;
        conversationId?: string | null;
        images?: ImageAttachment[];
        clearChatInput?: boolean;
      },
    ) => {
      const hasAttachedImages = Boolean(options?.images?.length);
      const rawText = rawInput.trim();
      if (!rawText && !hasAttachedImages) return;
      if (chatSendBusyRef.current) return;
      chatSendBusyRef.current = true;
      const sendNonce = ++chatSendNonceRef.current;
      const channelType = options?.channelType ?? "DM";
      const conversationMode: ConversationMode =
        channelType === "VOICE_DM" || channelType === "VOICE_GROUP"
          ? "simple"
          : chatMode;
      const imagesToSend = options?.images;
      let controller: AbortController | null = null;

      try {
        let text = hasAttachedImages
          ? rawText || "Please review the attached image."
          : rawText;
        if (rawText) {
          let commandResult: { handled: boolean; rewrittenText?: string };
          try {
            commandResult = await tryHandlePrefixedChatCommand(rawText);
          } catch (err) {
            appendLocalCommandTurn(
              rawText,
              `Command failed: ${err instanceof Error ? err.message : "unknown error"}`,
            );
            if (options?.clearChatInput) {
              setChatInput("");
            }
            return;
          }
          if (commandResult.handled) {
            if (options?.clearChatInput) {
              setChatInput("");
            }
            return;
          }
          if (
            typeof commandResult.rewrittenText === "string" &&
            commandResult.rewrittenText.trim()
          ) {
            text = commandResult.rewrittenText.trim();
          }
        }

        let convId: string =
          options?.conversationId ?? activeConversationId ?? "";
        if (!convId) {
          try {
            const { conversation } = await client.createConversation();
            const nextCutoffTs = Date.now();
            setConversations((prev) => [conversation, ...prev]);
            setActiveConversationId(conversation.id);
            activeConversationIdRef.current = conversation.id;
            setCompanionMessageCutoffTs(nextCutoffTs);
            convId = conversation.id;
          } catch {
            return;
          }
        }

        client.sendWsMessage({
          type: "active-conversation",
          conversationId: convId,
        });

        const now = Date.now();
        const userMsgId = `temp-${now}`;
        const assistantMsgId = `temp-resp-${now}`;

        setCompanionMessageCutoffTs(now);
        setConversationMessages((prev: ConversationMessage[]) => [
          ...prev,
          { id: userMsgId, role: "user", text, timestamp: now },
          { id: assistantMsgId, role: "assistant", text: "", timestamp: now },
        ]);
        if (options?.clearChatInput) {
          setChatInput("");
        }
        setChatSending(true);
        setChatFirstTokenReceived(false);

        controller = new AbortController();
        chatAbortRef.current = controller;
        let streamedAssistantText = "";

        try {
          const data = await client.sendConversationMessageStream(
            convId,
            text,
            (token, accumulatedText) => {
              const nextText =
                typeof accumulatedText === "string"
                  ? accumulatedText
                  : mergeStreamingText(streamedAssistantText, token);
              if (nextText === streamedAssistantText) return;
              streamedAssistantText = nextText;
              setChatFirstTokenReceived(true);
              setConversationMessages((prev) =>
                prev.map((message) =>
                  message.id !== assistantMsgId
                    ? message
                    : message.text === nextText
                      ? message
                      : { ...message, text: nextText },
                ),
              );
            },
            channelType,
            controller.signal,
            imagesToSend,
            conversationMode,
          );

          if (!data.text.trim()) {
            setConversationMessages((prev) =>
              prev.filter((message) => message.id !== assistantMsgId),
            );
          } else if (
            shouldApplyFinalStreamText(streamedAssistantText, data.text)
          ) {
            setConversationMessages((prev) => {
              let changed = false;
              const next = prev.map((message) => {
                if (message.id !== assistantMsgId) return message;
                if (message.text === data.text) return message;
                changed = true;
                return { ...message, text: data.text };
              });
              return changed ? next : prev;
            });
          }
          if (data.usage) {
            setChatLastUsage({
              promptTokens: data.usage.promptTokens,
              completionTokens: data.usage.completionTokens,
              totalTokens: data.usage.totalTokens,
              model: data.usage.model,
              updatedAt: Date.now(),
            });
          }

          if (!data.completed && streamedAssistantText.trim()) {
            setConversationMessages((prev) =>
              prev.map((message) =>
                message.id === assistantMsgId
                  ? { ...message, interrupted: true }
                  : message,
              ),
            );
          }
          void loadConversations();
        } catch (err) {
          const abortError = err as Error;
          if (abortError.name === "AbortError") {
            setConversationMessages((prev) =>
              prev.filter(
                (message) =>
                  !(message.id === assistantMsgId && !message.text.trim()),
              ),
            );
            return;
          }

          const status = (err as { status?: number }).status;
          if (status === 404) {
            try {
              const { conversation } = await client.createConversation();
              const nextCutoffTs = Date.now();
              setConversations((prev) => [conversation, ...prev]);
              setActiveConversationId(conversation.id);
              activeConversationIdRef.current = conversation.id;
              setCompanionMessageCutoffTs(nextCutoffTs);
              client.sendWsMessage({
                type: "active-conversation",
                conversationId: conversation.id,
              });

              const retryData = await client.sendConversationMessage(
                conversation.id,
                text,
                channelType,
                imagesToSend,
                conversationMode,
              );
              setConversationMessages(
                filterRenderableConversationMessages([
                  {
                    id: `temp-${Date.now()}`,
                    role: "user",
                    text,
                    timestamp: Date.now(),
                  },
                  {
                    id: `temp-resp-${Date.now()}`,
                    role: "assistant",
                    text: retryData.text,
                    timestamp: Date.now(),
                  },
                ]),
              );
            } catch {
              setConversationMessages((prev) =>
                prev.filter(
                  (message) =>
                    !(message.id === assistantMsgId && !message.text.trim()),
                ),
              );
            }
          } else {
            await loadConversationMessages(convId);
          }
        } finally {
          if (chatAbortRef.current === controller) {
            chatAbortRef.current = null;
          }
          if (chatSendNonceRef.current === sendNonce) {
            chatSendBusyRef.current = false;
            setChatSending(false);
            setChatFirstTokenReceived(false);
          }
        }
      } finally {
        if (controller == null && chatSendNonceRef.current === sendNonce) {
          chatSendBusyRef.current = false;
        }
      }
    },
    [
      activeConversationId,
      appendLocalCommandTurn,
      chatMode,
      loadConversationMessages,
      loadConversations,
      tryHandlePrefixedChatCommand,
    ],
  );

  const handleChatSend = useCallback(
    async (channelType: ConversationChannelType = "DM") => {
      const imagesToSend = chatPendingImages.length
        ? chatPendingImages
        : undefined;
      setChatPendingImages([]);
      await sendChatText(chatInput, {
        channelType,
        images: imagesToSend,
        clearChatInput: true,
      });
    },
    [chatInput, chatPendingImages, sendChatText],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: t is stable but defined later
  const sendActionMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (chatSendBusyRef.current) return;
      chatSendBusyRef.current = true;
      const sendNonce = ++chatSendNonceRef.current;
      const conversationMode: ConversationMode = chatMode;
      let controller: AbortController | null = null;

      try {
        let convId: string = activeConversationId ?? "";
        if (!convId) {
          try {
            const { conversation } = await client.createConversation(
              t("conversations.newChatTitle"),
            );
            const nextCutoffTs = Date.now();
            setConversations((prev) => [conversation, ...prev]);
            setActiveConversationId(conversation.id);
            activeConversationIdRef.current = conversation.id;
            setCompanionMessageCutoffTs(nextCutoffTs);
            convId = conversation.id;
          } catch {
            return;
          }
        }

        client.sendWsMessage({
          type: "active-conversation",
          conversationId: convId,
        });

        const now = Date.now();
        const userMsgId = `temp-action-${now}`;
        const assistantMsgId = `temp-action-resp-${now}`;

        setCompanionMessageCutoffTs(now);
        setConversationMessages((prev: ConversationMessage[]) => [
          ...prev,
          { id: userMsgId, role: "user", text: trimmed, timestamp: now },
          { id: assistantMsgId, role: "assistant", text: "", timestamp: now },
        ]);
        setChatSending(true);
        setChatFirstTokenReceived(false);

        controller = new AbortController();
        chatAbortRef.current = controller;
        let streamedAssistantText = "";

        try {
          const data = await client.sendConversationMessageStream(
            convId,
            trimmed,
            (token, accumulatedText) => {
              const nextText =
                typeof accumulatedText === "string"
                  ? accumulatedText
                  : mergeStreamingText(streamedAssistantText, token);
              if (nextText === streamedAssistantText) return;
              streamedAssistantText = nextText;
              setChatFirstTokenReceived(true);
              setConversationMessages((prev) =>
                prev.map((message) =>
                  message.id !== assistantMsgId
                    ? message
                    : message.text === nextText
                      ? message
                      : { ...message, text: nextText },
                ),
              );
            },
            "DM",
            controller.signal,
            undefined,
            conversationMode,
          );

          if (!data.text.trim()) {
            setConversationMessages((prev) =>
              prev.filter((message) => message.id !== assistantMsgId),
            );
          } else if (
            shouldApplyFinalStreamText(streamedAssistantText, data.text)
          ) {
            setConversationMessages((prev) => {
              let changed = false;
              const next = prev.map((message) => {
                if (message.id !== assistantMsgId) return message;
                if (message.text === data.text) return message;
                changed = true;
                return { ...message, text: data.text };
              });
              return changed ? next : prev;
            });
          }
          void loadConversations();
        } catch (err) {
          const abortError = err as Error;
          if (abortError.name === "AbortError") {
            setConversationMessages((prev) =>
              prev.filter(
                (message) =>
                  !(message.id === assistantMsgId && !message.text.trim()),
              ),
            );
            return;
          }
          await loadConversationMessages(convId);
        } finally {
          if (chatAbortRef.current === controller) {
            chatAbortRef.current = null;
          }
          if (chatSendNonceRef.current === sendNonce) {
            chatSendBusyRef.current = false;
            setChatSending(false);
            setChatFirstTokenReceived(false);
          }
        }
      } finally {
        if (controller == null && chatSendNonceRef.current === sendNonce) {
          chatSendBusyRef.current = false;
        }
      }
    },
    [
      chatMode,
      activeConversationId,
      loadConversationMessages,
      loadConversations,
    ],
  );

  const handleChatStop = useCallback(() => {
    chatSendBusyRef.current = false;
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    setChatSending(false);
    setChatFirstTokenReceived(false);

    // Also stop any active PTY sessions — the user wants everything to halt
    for (const session of ptySessions) {
      client.stopCodingAgent(session.sessionId).catch(() => { });
    }
  }, [ptySessions]);

  const handleChatRetry = useCallback(
    (assistantMsgId: string) => {
      let retryText: string | null = null;
      setConversationMessages((prev) => {
        // Find the interrupted assistant message
        const assistantIdx = prev.findIndex(
          (m) => m.id === assistantMsgId && m.role === "assistant",
        );
        if (assistantIdx < 0) return prev;

        // Find the preceding user message
        let userMsg: ConversationMessage | null = null;
        for (let i = assistantIdx - 1; i >= 0; i--) {
          if (prev[i].role === "user") {
            userMsg = prev[i];
            break;
          }
        }
        if (!userMsg) return prev;

        // Remove the interrupted assistant message
        const next = prev.filter((m) => m.id !== assistantMsgId);

        retryText = userMsg.text;

        return next;
      });
      if (retryText) {
        void sendChatText(retryText);
      }
    },
    [sendChatText],
  );

  const handleChatEdit = useCallback(
    async (messageId: string, text: string): Promise<boolean> => {
      const convId = activeConversationIdRef.current;
      const nextText = text.trim();
      if (!convId || !nextText) {
        return false;
      }

      let currentMessages = conversationMessagesRef.current;
      let messageIndex = currentMessages.findIndex(
        (message) => message.id === messageId && message.role === "user",
      );
      if (messageIndex < 0) {
        const loaded = await loadConversationMessages(convId);
        if (!loaded.ok) {
          return false;
        }
        currentMessages = conversationMessagesRef.current;
        messageIndex = currentMessages.findIndex(
          (message) => message.id === messageId && message.role === "user",
        );
      }
      if (messageIndex < 0) {
        return false;
      }

      const targetMessage = currentMessages[messageIndex];
      if (
        targetMessage.source === "local_command" ||
        targetMessage.id.startsWith("temp-")
      ) {
        return false;
      }

      chatSendBusyRef.current = false;
      chatAbortRef.current?.abort();
      chatAbortRef.current = null;
      setChatSending(false);
      setChatFirstTokenReceived(false);
      setChatInput("");

      const preservedMessages = currentMessages.slice(0, messageIndex);
      conversationMessagesRef.current = preservedMessages;
      setConversationMessages(preservedMessages);

      try {
        await client.truncateConversationMessages(convId, messageId, {
          inclusive: true,
        });
        await sendChatText(nextText, { conversationId: convId });
        return true;
      } catch (err) {
        await loadConversationMessages(convId);
        setActionNotice(
          `Failed to edit message: ${err instanceof Error ? err.message : "network error"}`,
          "error",
          4200,
        );
        return false;
      }
    },
    [loadConversationMessages, sendChatText, setActionNotice],
  );

  const handleChatClear = useCallback(async () => {
    const convId = activeConversationId;
    if (!convId) {
      setActionNotice("No active conversation to clear.", "info", 2200);
      return;
    }
    try {
      await client.deleteConversation(convId);
      setActiveConversationId(null);
      activeConversationIdRef.current = null;
      setConversationMessages([]);
      setUnreadConversations((prev) => {
        const next = new Set(prev);
        next.delete(convId);
        return next;
      });
      await loadConversations();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        setActiveConversationId(null);
        activeConversationIdRef.current = null;
        setConversationMessages([]);
        setUnreadConversations((prev) => {
          const next = new Set(prev);
          next.delete(convId);
          return next;
        });
        await loadConversations();
        setActionNotice("Conversation was already cleared.", "info", 2600);
        return;
      }
      setActionNotice(
        `Failed to clear conversation: ${err instanceof Error ? err.message : "network error"}`,
        "error",
        4200,
      );
    }
  }, [activeConversationId, loadConversations, setActionNotice]);

  const handleSelectConversation = useCallback(
    async (id: string) => {
      conversationHydrationEpochRef.current += 1;
      if (
        id === activeConversationId &&
        conversationMessagesRef.current.length > 0
      )
        return;

      // Clean up empty conversations: if the previous conversation has only
      // system/greeting messages and no user messages, delete it silently.
      const prevId = activeConversationId;
      if (prevId && prevId !== id) {
        const prevMessages = conversationMessagesRef.current;
        const hasUserMessage = prevMessages.some((m) => m.role === "user");
        if (!hasUserMessage && prevMessages.length <= 1) {
          void client.deleteConversation(prevId).catch(() => { });
          setConversations((prev) => prev.filter((c) => c.id !== prevId));
          setUnreadConversations((prev) => {
            const next = new Set(prev);
            next.delete(prevId);
            return next;
          });
        }
      }

      const previousActive = activeConversationId;
      setActiveConversationId(id);
      activeConversationIdRef.current = id;
      client.sendWsMessage({ type: "active-conversation", conversationId: id });
      setUnreadConversations((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      const loaded = await loadConversationMessages(id);
      if (loaded.ok) return;

      if (loaded.status === 404) {
        const refreshed = await loadConversations();
        const fallbackId = refreshed?.[0]?.id ?? null;
        if (fallbackId) {
          setActiveConversationId(fallbackId);
          activeConversationIdRef.current = fallbackId;
          client.sendWsMessage({
            type: "active-conversation",
            conversationId: fallbackId,
          });
          const fallbackLoaded = await loadConversationMessages(fallbackId);
          if (!fallbackLoaded.ok) {
            setActionNotice(
              `Failed to load fallback conversation: ${fallbackLoaded.message}`,
              "error",
              4200,
            );
          }
        } else {
          setActiveConversationId(null);
          activeConversationIdRef.current = null;
          setConversationMessages([]);
        }
        setActionNotice(
          "Conversation was not found. Refreshed the conversation list.",
          "info",
          3200,
        );
        return;
      }

      setActiveConversationId(previousActive);
      activeConversationIdRef.current = previousActive;
      if (previousActive) {
        client.sendWsMessage({
          type: "active-conversation",
          conversationId: previousActive,
        });
        const restored = await loadConversationMessages(previousActive);
        if (!restored.ok) {
          setActionNotice(
            `Failed to restore previous conversation: ${restored.message}`,
            "error",
            4200,
          );
        }
      } else {
        setConversationMessages([]);
      }
      setActionNotice(
        `Failed to load conversation: ${loaded.message}`,
        "error",
        4200,
      );
    },
    [
      activeConversationId,
      loadConversationMessages,
      loadConversations,
      setActionNotice,
    ],
  );

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      const deletingActive = activeConversationId === id;
      try {
        await client.deleteConversation(id);
        setConversations((prev) =>
          prev.filter((conversation) => conversation.id !== id),
        );
        setUnreadConversations((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        if (deletingActive) {
          setActiveConversationId(null);
          activeConversationIdRef.current = null;
          setConversationMessages([]);
        }
        const refreshed = await loadConversations();
        if (deletingActive) {
          const fallbackId = refreshed?.[0]?.id ?? null;
          if (fallbackId) {
            setActiveConversationId(fallbackId);
            activeConversationIdRef.current = fallbackId;
            client.sendWsMessage({
              type: "active-conversation",
              conversationId: fallbackId,
            });
            const fallbackLoaded = await loadConversationMessages(fallbackId);
            if (!fallbackLoaded.ok) {
              setActionNotice(
                `Failed to load fallback conversation: ${fallbackLoaded.message}`,
                "error",
                4200,
              );
            }
          }
        }
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          setConversations((prev) =>
            prev.filter((conversation) => conversation.id !== id),
          );
          setUnreadConversations((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          if (deletingActive) {
            setActiveConversationId(null);
            activeConversationIdRef.current = null;
            setConversationMessages([]);
          }
          await loadConversations();
          setActionNotice(
            "Conversation was already deleted. Refreshed the conversation list.",
            "info",
            3200,
          );
          return;
        }
        setActionNotice(
          `Failed to delete conversation: ${err instanceof Error ? err.message : "network error"}`,
          "error",
          4200,
        );
      }
    },
    [
      activeConversationId,
      loadConversationMessages,
      loadConversations,
      setActionNotice,
    ],
  );

  const handleRenameConversation = useCallback(
    async (id: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) {
        setActionNotice("Conversation title cannot be empty.", "error", 2800);
        return;
      }
      try {
        const { conversation } = await client.renameConversation(id, trimmed);
        setConversations((prev) =>
          prev.map((existing) =>
            existing.id === id ? conversation : existing,
          ),
        );
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          await loadConversations();
          setActionNotice(
            "Conversation was not found. Refreshed the conversation list.",
            "info",
            3200,
          );
          return;
        }
        setActionNotice(
          `Failed to rename conversation: ${err instanceof Error ? err.message : "network error"}`,
          "error",
          4200,
        );
      }
    },
    [loadConversations, setActionNotice],
  );

  // ── Pairing ────────────────────────────────────────────────────────

  const handlePairingSubmit = useCallback(async () => {
    if (pairingBusyRef.current || pairingBusy) return;
    const code = pairingCodeInput.trim();
    if (!code) {
      setPairingError("Enter the pairing code from the server logs.");
      return;
    }
    setPairingError(null);
    pairingBusyRef.current = true;
    setPairingBusy(true);
    try {
      const { token } = await client.pair(code);
      client.setToken(token);
      window.location.reload();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 410)
        setPairingError("Pairing code expired. Check logs for a new code.");
      else if (status === 429)
        setPairingError("Too many attempts. Try again later.");
      else setPairingError("Pairing failed. Check the code and try again.");
    } finally {
      pairingBusyRef.current = false;
      setPairingBusy(false);
    }
  }, [pairingBusy, pairingCodeInput]);

  // ── Plugin actions ─────────────────────────────────────────────────

  const handlePluginToggle = useCallback(
    async (pluginId: string, enabled: boolean) => {
      const plugin = plugins.find((p: PluginInfo) => p.id === pluginId);
      const pluginName = plugin?.name ?? pluginId;
      if (
        enabled &&
        plugin?.validationErrors &&
        plugin.validationErrors.length > 0
      ) {
        setPluginSettingsOpen((prev) => new Set([...prev, pluginId]));
        setActionNotice(
          `${pluginName} has required settings. Configure them after enabling.`,
          "info",
          3400,
        );
      }
      try {
        setActionNotice(
          `${enabled ? "Enabling" : "Disabling"} ${pluginName}...`,
          "info",
          4200,
        );
        await client.updatePlugin(pluginId, { enabled });
        await loadPlugins();
        setActionNotice(
          `${pluginName} ${enabled ? "enabled" : "disabled"}. Restart required to apply.`,
          "success",
          2800,
        );
      } catch (err) {
        await loadPlugins().catch(() => {
          /* ignore */
        });
        setActionNotice(
          `Failed to ${enabled ? "enable" : "disable"} ${pluginName}: ${err instanceof Error ? err.message : "unknown error"
          }`,
          "error",
          4200,
        );
      }
    },
    [plugins, loadPlugins, setActionNotice],
  );

  const handlePluginConfigSave = useCallback(
    async (pluginId: string, config: Record<string, string>) => {
      if (Object.keys(config).length === 0) return;
      setPluginSaving((prev) => new Set([...prev, pluginId]));
      try {
        await client.updatePlugin(pluginId, { config });

        // Check if this is an AI provider plugin
        const plugin = plugins.find((p) => p.id === pluginId);
        const isAiProvider = plugin?.category === "ai-provider";

        await loadPlugins();
        setActionNotice(
          isAiProvider
            ? "Provider settings saved. Restart required to apply."
            : "Plugin settings saved.",
          "success",
        );
        setPluginSaveSuccess((prev) => new Set([...prev, pluginId]));
        setTimeout(() => {
          setPluginSaveSuccess((prev) => {
            const next = new Set(prev);
            next.delete(pluginId);
            return next;
          });
        }, 2000);
      } catch (err) {
        setActionNotice(
          `Save failed: ${err instanceof Error ? err.message : "unknown error"}`,
          "error",
          3800,
        );
      } finally {
        setPluginSaving((prev) => {
          const next = new Set(prev);
          next.delete(pluginId);
          return next;
        });
      }
    },
    [loadPlugins, setActionNotice, plugins],
  );

  // ── Skill actions ──────────────────────────────────────────────────

  const handleSkillToggle = useCallback(
    async (skillId: string, enabled: boolean) => {
      setSkillToggleAction(skillId);
      try {
        const { skill } = await client.updateSkill(skillId, enabled);
        setSkills((prev) =>
          prev.map((s) =>
            s.id === skillId ? { ...s, enabled: skill.enabled } : s,
          ),
        );
        setActionNotice(
          `${skill.name} ${skill.enabled ? "enabled" : "disabled"}.`,
          "success",
        );
      } catch (err) {
        setActionNotice(
          `Failed to update skill: ${err instanceof Error ? err.message : "unknown error"}`,
          "error",
          4200,
        );
      } finally {
        setSkillToggleAction("");
      }
    },
    [setActionNotice],
  );

  const handleCreateSkill = useCallback(async () => {
    const name = skillCreateName.trim();
    if (!name) return;
    setSkillCreating(true);
    try {
      const result = await client.createSkill(
        name,
        skillCreateDescription.trim() || "",
      );
      setSkillCreateName("");
      setSkillCreateDescription("");
      setSkillCreateFormOpen(false);
      setActionNotice(`Skill "${name}" created.`, "success");
      await refreshSkills();
      if (result.path)
        await client.openSkill(result.skill?.id ?? name).catch(() => undefined);
    } catch (err) {
      setActionNotice(
        `Failed to create skill: ${err instanceof Error ? err.message : "error"}`,
        "error",
        4200,
      );
    } finally {
      setSkillCreating(false);
    }
  }, [skillCreateName, skillCreateDescription, refreshSkills, setActionNotice]);

  const handleOpenSkill = useCallback(
    async (skillId: string) => {
      try {
        await client.openSkill(skillId);
        setActionNotice("Opening skill folder...", "success", 2000);
      } catch (err) {
        setActionNotice(
          `Failed to open: ${err instanceof Error ? err.message : "error"}`,
          "error",
          4200,
        );
      }
    },
    [setActionNotice],
  );

  const handleDeleteSkill = useCallback(
    async (skillId: string, skillName: string) => {
      const confirmed = await confirmDesktopAction({
        title: "Delete Skill",
        message: `Delete skill "${skillName}"?`,
        detail: "This cannot be undone.",
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        type: "warning",
      });
      if (!confirmed) return;
      try {
        await client.deleteSkill(skillId);
        setActionNotice(`Skill "${skillName}" deleted.`, "success");
        await refreshSkills();
      } catch (err) {
        setActionNotice(
          `Failed to delete: ${err instanceof Error ? err.message : "error"}`,
          "error",
          4200,
        );
      }
    },
    [refreshSkills, setActionNotice],
  );

  const handleReviewSkill = useCallback(async (skillId: string) => {
    setSkillReviewId(skillId);
    setSkillReviewLoading(true);
    setSkillReviewReport(null);
    try {
      const { report } = await client.getSkillScanReport(skillId);
      setSkillReviewReport(report);
    } catch {
      setSkillReviewReport(null);
    } finally {
      setSkillReviewLoading(false);
    }
  }, []);

  const handleAcknowledgeSkill = useCallback(
    async (skillId: string) => {
      try {
        await client.acknowledgeSkill(skillId, true);
        setActionNotice(
          `Skill "${skillId}" acknowledged and enabled.`,
          "success",
        );
        setSkillReviewReport(null);
        setSkillReviewId("");
        await refreshSkills();
      } catch (err) {
        setActionNotice(
          `Failed: ${err instanceof Error ? err.message : "error"}`,
          "error",
          4200,
        );
      }
    },
    [refreshSkills, setActionNotice],
  );

  const searchSkillsMarketplace = useCallback(async () => {
    const query = skillsMarketplaceQuery.trim();
    if (!query) {
      setSkillsMarketplaceResults([]);
      setSkillsMarketplaceError("");
      return;
    }
    setSkillsMarketplaceLoading(true);
    setSkillsMarketplaceError("");
    try {
      const { results } = await client.searchSkillsMarketplace(
        query,
        false,
        20,
      );
      setSkillsMarketplaceResults(results);
    } catch (err) {
      setSkillsMarketplaceResults([]);
      setSkillsMarketplaceError(
        err instanceof Error ? err.message : "unknown error",
      );
    } finally {
      setSkillsMarketplaceLoading(false);
    }
  }, [skillsMarketplaceQuery]);

  const installSkillFromMarketplace = useCallback(
    async (item: SkillMarketplaceResult) => {
      setSkillsMarketplaceAction(`install:${item.id}`);
      try {
        await client.installMarketplaceSkill({
          slug: item.slug ?? item.id,
          githubUrl: item.githubUrl,
          repository: item.repository,
          path: item.path ?? undefined,
          name: item.name,
          description: item.description,
          source: item.source ?? "clawhub",
          autoRefresh: true,
        });
        await refreshSkills();
        setActionNotice(`Installed skill: ${item.name}`, "success");
      } catch (err) {
        setActionNotice(
          `Skill install failed: ${err instanceof Error ? err.message : "unknown error"}`,
          "error",
          4200,
        );
      } finally {
        setSkillsMarketplaceAction("");
      }
    },
    [refreshSkills, setActionNotice],
  );

  const installSkillFromGithubUrl = useCallback(async () => {
    const githubUrl = skillsMarketplaceManualGithubUrl.trim();
    if (!githubUrl) return;
    setSkillsMarketplaceAction("install:manual");
    try {
      let repository: string | undefined;
      let skillPath: string | undefined;
      let inferredName: string | undefined;
      try {
        const parsed = new URL(githubUrl);
        if (parsed.hostname === "github.com") {
          const parts = parsed.pathname.split("/").filter(Boolean);
          if (parts.length >= 2) repository = `${parts[0]}/${parts[1]}`;
          if (parts[2] === "tree" && parts.length >= 5) {
            skillPath = parts.slice(4).join("/");
            inferredName = parts[parts.length - 1];
          }
        }
      } catch {
        /* keep raw URL */
      }
      await client.installMarketplaceSkill({
        githubUrl,
        repository,
        path: skillPath,
        name: inferredName,
        source: "manual",
        autoRefresh: true,
      });
      setSkillsMarketplaceManualGithubUrl("");
      await refreshSkills();
      setActionNotice("Skill installed from GitHub URL.", "success");
    } catch (err) {
      setActionNotice(
        `GitHub install failed: ${err instanceof Error ? err.message : "unknown error"}`,
        "error",
        4200,
      );
    } finally {
      setSkillsMarketplaceAction("");
    }
  }, [skillsMarketplaceManualGithubUrl, refreshSkills, setActionNotice]);

  const uninstallMarketplaceSkill = useCallback(
    async (skillId: string, name: string) => {
      setSkillsMarketplaceAction(`uninstall:${skillId}`);
      try {
        await client.deleteSkill(skillId);
        await refreshSkills();
        setActionNotice(`Uninstalled skill: ${name}`, "success");
      } catch (err) {
        setActionNotice(
          `Skill uninstall failed: ${err instanceof Error ? err.message : "unknown error"}`,
          "error",
          4200,
        );
      } finally {
        setSkillsMarketplaceAction("");
      }
    },
    [refreshSkills, setActionNotice],
  );

  // ── Inventory actions ──────────────────────────────────────────────

  const handleWalletApiKeySave = useCallback(
    async (config: WalletConfigUpdateRequest) => {
      if (
        Object.keys(config.credentials ?? {}).length === 0 &&
        Object.keys(config.selections ?? {}).length === 0
      ) {
        return;
      }
      if (walletApiKeySavingRef.current || walletApiKeySaving) return;
      walletApiKeySavingRef.current = true;
      setWalletApiKeySaving(true);
      setWalletError(null);
      try {
        await client.updateWalletConfig(config);
        await loadWalletConfig();
        await loadBalances();
        setActionNotice(
          "Wallet RPC settings saved. Restart required to apply.",
          "success",
        );
      } catch (err) {
        setWalletError(
          `Failed to save API keys: ${err instanceof Error ? err.message : "network error"}`,
        );
      } finally {
        walletApiKeySavingRef.current = false;
        setWalletApiKeySaving(false);
      }
    },
    [walletApiKeySaving, loadWalletConfig, loadBalances, setActionNotice],
  );

  const handleExportKeys = useCallback(async () => {
    if (walletExportVisible) {
      setWalletExportVisible(false);
      setWalletExportData(null);
      return;
    }
    const confirmed = await confirmDesktopAction({
      title: "Reveal Private Keys",
      message: "This will reveal your private keys.",
      detail:
        "NEVER share your private keys with anyone. Anyone with your private keys can steal all funds in your wallets.",
      confirmLabel: "Continue",
      cancelLabel: "Cancel",
      type: "warning",
    });
    if (!confirmed) return;
    const exportToken = await promptModal({
      title: "Wallet Export Token",
      message: "Enter your wallet export token (MILADY_WALLET_EXPORT_TOKEN):",
      placeholder: "MILADY_WALLET_EXPORT_TOKEN",
      confirmLabel: "Export",
      cancelLabel: "Cancel",
    });
    if (exportToken === null) return;
    if (!exportToken.trim()) {
      setWalletError("Wallet export token is required.");
      return;
    }
    try {
      const data = await client.exportWalletKeys(exportToken.trim());
      setWalletExportData(data);
      setWalletExportVisible(true);
      setTimeout(() => {
        setWalletExportVisible(false);
        setWalletExportData(null);
      }, 60_000);
    } catch (err) {
      setWalletError(
        `Failed to export keys: ${err instanceof Error ? err.message : "network error"}`,
      );
    }
  }, [promptModal, walletExportVisible]);

  // ── Registry / Drop / Whitelist actions ─────────────────────────────

  const loadRegistryStatus = useCallback(async () => {
    setRegistryLoading(true);
    setRegistryError(null);
    try {
      const status = await client.getRegistryStatus();
      setRegistryStatus(status);
    } catch (err) {
      setRegistryError(
        err instanceof Error ? err.message : "Failed to load registry status",
      );
    } finally {
      setRegistryLoading(false);
    }
  }, []);

  const registerOnChain = useCallback(async () => {
    setRegistryRegistering(true);
    setRegistryError(null);
    try {
      await client.registerAgent({
        name: characterDraft?.name || agentStatus?.agentName,
      });
      await loadRegistryStatus();
    } catch (err) {
      setRegistryError(
        err instanceof Error ? err.message : "Registration failed",
      );
    } finally {
      setRegistryRegistering(false);
    }
  }, [characterDraft?.name, agentStatus?.agentName, loadRegistryStatus]);

  const syncRegistryProfile = useCallback(async () => {
    setRegistryRegistering(true);
    setRegistryError(null);
    try {
      await client.syncRegistryProfile({
        name: characterDraft?.name || agentStatus?.agentName,
      });
      await loadRegistryStatus();
    } catch (err) {
      setRegistryError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setRegistryRegistering(false);
    }
  }, [characterDraft?.name, agentStatus?.agentName, loadRegistryStatus]);

  const loadDropStatus = useCallback(async () => {
    setDropLoading(true);
    try {
      const status = await client.getDropStatus();
      setDropStatus(status);
    } catch {
      // Non-critical -- drop may not be configured
    } finally {
      setDropLoading(false);
    }
  }, []);

  const mintFromDrop = useCallback(
    async (shiny: boolean) => {
      setMintInProgress(true);
      setMintShiny(shiny);
      setMintError(null);
      setMintResult(null);
      try {
        const result = await client.mintAgent({
          name: characterDraft?.name || agentStatus?.agentName,
          shiny,
        });
        setMintResult(result);
        await loadRegistryStatus();
        await loadDropStatus();
      } catch (err) {
        setMintError(err instanceof Error ? err.message : "Mint failed");
      } finally {
        setMintInProgress(false);
        setMintShiny(false);
      }
    },
    [
      characterDraft?.name,
      agentStatus?.agentName,
      loadRegistryStatus,
      loadDropStatus,
    ],
  );

  const loadWhitelistStatus = useCallback(async () => {
    setWhitelistLoading(true);
    try {
      const status = await client.getWhitelistStatus();
      setWhitelistStatus(status);
    } catch {
      // Non-critical
    } finally {
      setWhitelistLoading(false);
    }
  }, []);

  // ── Character actions ──────────────────────────────────────────────

  const handleSaveCharacter = useCallback(async () => {
    setCharacterSaving(true);
    setCharacterSaveError(null);
    setCharacterSaveSuccess(null);
    try {
      const draft = prepareDraftForSave(characterDraft);
      if (!(draft.name as string | undefined)?.trim()) {
        throw new Error("Character name is required before saving.");
      }
      const { agentName } = await client.updateCharacter(draft);
      // Also persist avatar selection to config (under "ui" which is allowlisted)
      try {
        await client.updateConfig({
          ui: { avatarIndex: selectedVrmIndex },
        });
      } catch {
        /* non-fatal */
      }
      setCharacterSaveSuccess("Character saved successfully.");
      if (agentName && agentStatus) {
        setAgentStatus({ ...agentStatus, agentName });
      }
      await loadCharacter();
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      const finalMessage =
        message === "Character name is required before saving."
          ? message
          : `Failed to save: ${message}`;
      setCharacterSaveError(finalMessage);
      setCharacterSaving(false);
      throw new Error(finalMessage);
    }
    setCharacterSaving(false);
  }, [characterDraft, agentStatus, loadCharacter, selectedVrmIndex]);

  const handleCharacterFieldInput = useCallback(
    <K extends keyof CharacterData>(field: K, value: CharacterData[K]) => {
      setCharacterDraft((prev: CharacterData) => ({ ...prev, [field]: value }));
    },
    [],
  );

  const handleCharacterArrayInput = useCallback(
    (field: "adjectives" | "postExamples", value: string) => {
      const items = value
        .split("\n")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
      setCharacterDraft((prev: CharacterData) => ({ ...prev, [field]: items }));
    },
    [],
  );

  const handleCharacterStyleInput = useCallback(
    (subfield: "all" | "chat" | "post", value: string) => {
      const items = value
        .split("\n")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
      setCharacterDraft((prev: CharacterData) => ({
        ...prev,
        style: { ...(prev.style ?? {}), [subfield]: items },
      }));
    },
    [],
  );

  const handleCharacterMessageExamplesInput = useCallback((value: string) => {
    if (!value.trim()) {
      setCharacterDraft((prev: CharacterData) => ({
        ...prev,
        messageExamples: [],
      }));
      return;
    }
    const blocks = value.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
    const parsed = blocks.map((block) => {
      const lines = block.split("\n").filter((l) => l.trim().length > 0);
      const examples = lines.map((line) => {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          return {
            name: line.slice(0, colonIdx).trim(),
            content: { text: line.slice(colonIdx + 1).trim() },
          };
        }
        return { name: "User", content: { text: line.trim() } };
      });
      return { examples };
    });
    setCharacterDraft((prev: CharacterData) => ({
      ...prev,
      messageExamples: parsed,
    }));
  }, []);

  // ── Onboarding ─────────────────────────────────────────────────────

  const handleOnboardingFinish = useCallback(async () => {
    if (onboardingFinishBusyRef.current || onboardingRestarting) return;
    if (!onboardingOptions) return;
    if (onboardingFinishSavingRef.current || onboardingRestarting) return;
    const style = onboardingOptions.styles.find(
      (s: StylePreset) => s.catchphrase === onboardingStyle,
    );
    const systemPrompt = style?.system
      ? style.system.replace(/\{\{name\}\}/g, onboardingName)
      : `You are ${onboardingName}, an autonomous AI agent powered by elizaOS. ${onboardingOptions.sharedStyleRules}`;
    onboardingFinishBusyRef.current = true;
    setOnboardingRestarting(true);
    onboardingFinishSavingRef.current = true;

    try {
      let connection =
        buildOnboardingConnectionConfig({
          onboardingRunMode,
          onboardingCloudProvider,
          onboardingProvider,
          onboardingApiKey,
          onboardingPrimaryModel,
          onboardingOpenRouterModel,
          onboardingRemoteConnected,
          onboardingRemoteApiBase,
          onboardingRemoteToken,
          onboardingSmallModel,
          onboardingLargeModel,
        }) ?? onboardingResumeConnectionRef.current;

      // If connection is still null (e.g. after a permissions restart wiped
      // form state), try one more time by re-deriving from the server config.
      if (!connection) {
        try {
          const freshConfig = await client.getConfig();
          connection = deriveOnboardingResumeConnection(freshConfig);
          if (connection) {
            onboardingResumeConnectionRef.current = connection;
          }
        } catch {
          /* config fetch failed — fall through to the error below */
        }
      }

      if (!connection) {
        const startOver = await confirmDesktopAction({
          title: "Setup Incomplete",
          message:
            "Your connection settings could not be restored after restart.",
          detail: 'Choose "Start Over" to begin setup again.',
          type: "warning",
          confirmLabel: "Start Over",
          cancelLabel: "Cancel",
        });
        if (startOver) {
          clearPersistedOnboardingStep();
          onboardingResumeConnectionRef.current = null;
          setOnboardingStep("wakeUp");
          setOnboardingMode("basic");
          setOnboardingActiveGuide(null);
          setOnboardingDeferredTasks([]);
          setPostOnboardingChecklistDismissed(false);
          setOnboardingName("Eliza");
          setOnboardingStyle("");
          setOnboardingRunMode("cloud");
          setOnboardingCloudProvider("");
          setOnboardingProvider("");
          setOnboardingApiKey("");
          setOnboardingPrimaryModel("");
          setOnboardingOpenRouterModel("");
          setOnboardingRemoteConnected(false);
          setOnboardingRemoteApiBase("");
          setOnboardingRemoteToken("");
          setOnboardingSmallModel("");
          setOnboardingLargeModel("");
        }
        return;
      }
      const rpcSel = onboardingRpcSelections as Record<string, string>;
      const rpcK = onboardingRpcKeys as Record<string, string>;
      const nextWalletConfig = buildWalletRpcUpdateRequest({
        walletConfig,
        rpcFieldValues: rpcK,
        selectedProviders: {
          evm: rpcSel.evm,
          bsc: rpcSel.bsc,
          solana: rpcSel.solana,
        },
      });

      // For local mode: start the embedded agent first, then submit onboarding.
      // For cloud/remote modes: the backend is already available via the cloud
      // or remote connection.
      const isSandboxMode =
        onboardingRunMode === "cloud" &&
        onboardingCloudProvider === "elizacloud";
      const isLocalMode = onboardingRunMode === "local" || !onboardingRunMode;

      if (isSandboxMode) {
        // Provision a sandbox agent on Eliza Cloud
        const cloudApiBase = (
          (window as unknown as Record<string, unknown>).__ELIZA_CLOUD_API_BASE__ ??
          "https://www.elizacloud.ai"
        ) as string;

        // Get the auth token from the cloud login state
        const authToken = (
          (window as unknown as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ ?? ""
        ) as string;

        if (!authToken) {
          throw new Error(
            "Eliza Cloud authentication required. Please log in first.",
          );
        }

        await client.provisionCloudSandbox({
          cloudApiBase,
          authToken,
          name: onboardingName,
          bio: style?.bio ?? ["An autonomous AI agent."],
          onProgress: (status, detail) => {
            console.log(`[Sandbox] ${status}: ${detail ?? ""}`);
          },
        });

        // Point the client at the cloud API (which proxies to the bridge)
        client.setBaseUrl(cloudApiBase);
        client.setToken(authToken);

        // Persist connection for future restarts
        savePersistedConnectionMode({
          runMode: "cloud",
          cloudApiBase,
          cloudAuthToken: authToken,
        });
      } else if (isLocalMode) {
        // Start the embedded agent via desktop RPC (Electrobun) or native plugin
        try {
          await invokeDesktopBridgeRequest({
            rpcMethod: "agentStart",
            ipcChannel: "agent:start",
          });
        } catch {
          // May not be on desktop — try the Capacitor agent plugin fallback.
          // Use a variable to prevent Vite static analysis from failing on
          // this optional peer dependency (only available in milady app builds).
          try {
            const agentPluginId = "@miladyai/capacitor-agent";
            const { Agent } = await import(/* @vite-ignore */ agentPluginId);
            await Agent.start();
          } catch {
            // Not on desktop or native — dev mode where agent is already running
          }
        }

        // Wait for the local backend to become reachable
        const localDeadline = Date.now() + 120_000;
        while (Date.now() < localDeadline) {
          try {
            await client.getAuthStatus();
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 500));
          }
        }

        savePersistedConnectionMode({ runMode: "local" });
      } else if (
        onboardingRunMode === "cloud" &&
        onboardingCloudProvider === "remote"
      ) {
        // Remote mode — user provided a custom backend URL
        savePersistedConnectionMode({
          runMode: "remote",
          remoteApiBase: onboardingRemoteApiBase,
          remoteAccessToken: onboardingRemoteToken || undefined,
        });
      }

      const sandboxMode = isSandboxMode ? "standard" : "off";

      await client.submitOnboarding({
        name: onboardingName,
        sandboxMode: sandboxMode as "off",
        bio: style?.bio ?? ["An autonomous AI agent."],
        systemPrompt,
        style: style?.style,
        adjectives: style?.adjectives,
        postExamples: style?.postExamples,
        messageExamples: style?.messageExamples,
        connection,
        walletConfig: nextWalletConfig,
      });
      try {
        setAgentStatus(await client.restartAgent());
      } catch {
        /* ignore */
      }
      await waitForOnboardingGreetingBootstrap();
      const greetConvId = await hydrateInitialConversationState();
      if (greetConvId) {
        void requestGreetingWhenRunning(greetConvId, { showOverlay: true });
      }
      clearPersistedOnboardingStep();
      onboardingResumeConnectionRef.current = null;
      onboardingCompletionCommittedRef.current = true;
      setOnboardingMode("basic");
      setOnboardingActiveGuide(null);
      setPostOnboardingChecklistDismissed(false);
      setOnboardingDetectedProviders((providers) =>
        providers.map((provider) => {
          const nextProvider = { ...provider };
          delete nextProvider.apiKey;
          return nextProvider;
        }),
      );
      setOnboardingComplete(true);
      setTab("chat");
    } catch (err) {
      const startOver = await confirmDesktopAction({
        title: "Setup Failed",
        message: `${err instanceof Error ? err.message : "network error"
          }`,
        detail:
          'You can retry, or choose "Start Over" to begin setup from scratch.',
        type: "warning",
        confirmLabel: "Start Over",
        cancelLabel: "Retry",
      });
      if (startOver) {
        clearPersistedOnboardingStep();
        onboardingResumeConnectionRef.current = null;
        setOnboardingStep("wakeUp");
        setOnboardingMode("basic");
        setOnboardingActiveGuide(null);
        setOnboardingDeferredTasks([]);
        setPostOnboardingChecklistDismissed(false);
        setOnboardingName("Eliza");
        setOnboardingStyle("");
        setOnboardingRunMode("cloud");
        setOnboardingCloudProvider("");
        setOnboardingProvider("");
        setOnboardingApiKey("");
        setOnboardingPrimaryModel("");
        setOnboardingOpenRouterModel("");
        setOnboardingRemoteConnected(false);
        setOnboardingRemoteApiBase("");
        setOnboardingRemoteToken("");
        setOnboardingSmallModel("");
        setOnboardingLargeModel("");
      }
    } finally {
      onboardingFinishSavingRef.current = false;
      onboardingFinishBusyRef.current = false;
      setOnboardingRestarting(false);
    }
  }, [
    onboardingRestarting,
    onboardingOptions,
    onboardingStyle,
    onboardingName,
    onboardingRunMode,
    onboardingCloudProvider,
    onboardingSmallModel,
    onboardingLargeModel,
    onboardingProvider,
    onboardingApiKey,
    onboardingDetectedProviders,
    onboardingRemoteApiBase,
    onboardingRemoteConnected,
    onboardingRemoteToken,
    onboardingOpenRouterModel,
    onboardingPrimaryModel,
    onboardingRpcSelections,
    onboardingRpcKeys,
    walletConfig,
    hydrateInitialConversationState,
    setTab,
    requestGreetingWhenRunning,
    waitForOnboardingGreetingBootstrap,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: t is stable but defined later
  const handleOnboardingNext = useCallback(
    async (options?: OnboardingNextOptions) => {
      const STEP_ORDER: OnboardingStep[] = [
        "wakeUp",
        "identity",
        "connection",
        "rpc",
        "senses",
        "activate",
      ];

      // Auto-select first style if none chosen (identity step will let user change)
      if (
        onboardingStep === "wakeUp" &&
        !onboardingStyle &&
        onboardingOptions?.styles?.length
      ) {
        setState("onboardingStyle", onboardingOptions.styles[0].catchphrase);
      }

      // Default agent name to Rin if none set after identity step
      if (onboardingStep === "identity" && !onboardingName) {
        setState("onboardingName", "Rin");
      }

      if (
        onboardingStep === "connection" &&
        onboardingRunMode === "local" &&
        !onboardingProvider
      ) {
        const detectedProvider = onboardingDetectedProviders[0];
        const fallbackProvider =
          detectedProvider?.id ??
          onboardingOptions?.providers?.find(
            (provider) => provider.id !== "elizacloud",
          )?.id ??
          "";

        if (fallbackProvider) {
          setOnboardingProvider(fallbackProvider);
          if (
            detectedProvider?.id === fallbackProvider &&
            detectedProvider.apiKey
          ) {
            setOnboardingApiKey(detectedProvider.apiKey);
          }
        }
      }

      // At activate step, finish onboarding
      if (onboardingStep === "activate") {
        await handleOnboardingFinish();
        return;
      }

      // At senses step, check permissions unless bypass
      if (onboardingStep === "senses") {
        if (options?.allowPermissionBypass) {
          if (options.skipTask) {
            addDeferredOnboardingTask(options.skipTask);
          }
          await handleOnboardingFinish();
          return;
        }
        try {
          const permissions = await client.getPermissions();
          const missingPermissions =
            getMissingOnboardingPermissions(permissions);
          if (missingPermissions.length > 0) {
            const missingLabels = missingPermissions
              .map((id) => ONBOARDING_PERMISSION_LABELS[id] ?? id)
              .join(", ");
            setActionNotice(
              `Missing required permissions: ${missingLabels}. Grant them or use "Skip for Now".`,
              "error",
              5200,
            );
            return;
          }
        } catch (err) {
          setActionNotice(
            `Could not verify permissions (${err instanceof Error ? err.message : "unknown error"}). Use "Skip for Now" to continue.`,
            "error",
            5200,
          );
          return;
        }
      }

      // Advance to next step
      const currentIndex = STEP_ORDER.indexOf(onboardingStep);
      if (currentIndex < STEP_ORDER.length - 1) {
        if (options?.skipTask) {
          addDeferredOnboardingTask(options.skipTask);
        }
        let nextStep = STEP_ORDER[currentIndex + 1];
        if (nextStep === "identity" && !COMPANION_ENABLED) {
          nextStep = STEP_ORDER[currentIndex + 2];
        }
        setOnboardingStep(nextStep);
        setOnboardingActiveGuide(
          onboardingMode === "advanced"
            ? getFlaminaTopicForOnboardingStep(nextStep)
            : null,
        );
      }
    },
    [
      addDeferredOnboardingTask,
      onboardingDetectedProviders,
      onboardingMode,
      onboardingName,
      onboardingOptions,
      onboardingProvider,
      onboardingRunMode,
      onboardingStep,
      onboardingStyle,
      setOnboardingApiKey,
      setOnboardingProvider,
      setActionNotice,
      handleOnboardingFinish,
    ],
  );

  const handleOnboardingBack = useCallback(() => {
    const STEP_ORDER: OnboardingStep[] = [
      "wakeUp",
      "identity",
      "connection",
      "rpc",
      "senses",
      "activate",
    ];

    const currentIndex = STEP_ORDER.indexOf(onboardingStep);
    if (currentIndex > 0) {
      let previousStep = STEP_ORDER[currentIndex - 1];
      if (previousStep === "identity" && !COMPANION_ENABLED) {
        previousStep = STEP_ORDER[currentIndex - 2];
      }
      setOnboardingStep(previousStep);
      setOnboardingActiveGuide(
        onboardingMode === "advanced"
          ? getFlaminaTopicForOnboardingStep(previousStep)
          : null,
      );
    }
  }, [onboardingMode, onboardingStep, setOnboardingStep]);

  const handleOnboardingUseLocalBackend = useCallback(() => {
    client.setBaseUrl(null);
    client.setToken(null);
    setOnboardingRemoteConnecting(false);
    setOnboardingRemoteError(null);
    setOnboardingRemoteConnected(false);
    setOnboardingRemoteApiBase("");
    setOnboardingRemoteToken("");
    setOnboardingCloudProvider("");
    setOnboardingRunMode("");
    retryStartup();
  }, [retryStartup]);

  const handleOnboardingRemoteConnect = useCallback(async () => {
    if (onboardingRemoteConnecting) return;
    let normalizedBase = "";
    try {
      normalizedBase = normalizeRemoteApiBaseInput(onboardingRemoteApiBase);
    } catch (err) {
      setOnboardingRemoteError(
        err instanceof Error ? err.message : "Enter a valid backend address.",
      );
      return;
    }

    const accessKey = onboardingRemoteToken.trim();
    const probe = new MiladyClient(normalizedBase, accessKey || undefined);
    setOnboardingRemoteConnecting(true);
    setOnboardingRemoteError(null);
    try {
      const auth = await probe.getAuthStatus();
      if (auth.required && !accessKey) {
        throw new Error("This backend requires an access key.");
      }
      await probe.getOnboardingStatus();
      client.setBaseUrl(normalizedBase);
      client.setToken(accessKey || null);
      setOnboardingRunMode("cloud");
      setOnboardingCloudProvider("remote");
      setOnboardingRemoteApiBase(normalizedBase);
      setOnboardingRemoteToken(accessKey);
      setOnboardingRemoteConnected(true);
      setActionNotice("Connected to remote Milady backend.", "success", 4200);
      retryStartup();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to reach remote backend.";
      const normalizedMessage =
        /401|unauthorized|forbidden/i.test(message) && accessKey
          ? "Access key rejected. Check the address and try again."
          : message;
      setOnboardingRemoteError(normalizedMessage);
    } finally {
      setOnboardingRemoteConnecting(false);
    }
  }, [
    onboardingRemoteApiBase,
    onboardingRemoteConnecting,
    onboardingRemoteToken,
    retryStartup,
    setActionNotice,
  ]);

  // ── Cloud ──────────────────────────────────────────────────────────

  const handleCloudLogin = useCallback(async () => {
    if (elizaCloudLoginBusyRef.current || elizaCloudLoginBusy) return;
    elizaCloudLoginBusyRef.current = true;
    setElizaCloudLoginBusy(true);
    setElizaCloudLoginError(null);

    // Determine if we should use direct cloud auth (no local backend) or
    // go through the local agent's proxy. During sandbox onboarding there is
    // no local backend, so we talk to Eliza Cloud directly.
    const hasBackend = Boolean(client.getBaseUrl());
    const cloudApiBase =
      ((typeof window !== "undefined" &&
        (window as unknown as Record<string, unknown>).__ELIZA_CLOUD_API_BASE__) as string) ||
      "https://www.elizacloud.ai";
    const useDirectAuth = !hasBackend;

    try {
      let resp: { ok: boolean; browserUrl?: string; sessionId?: string; error?: string };
      if (useDirectAuth) {
        resp = await client.cloudLoginDirect(cloudApiBase);
      } else {
        resp = await client.cloudLogin();
      }
      if (!resp.ok) {
        setElizaCloudLoginError(
          resp.error || "Failed to start Eliza Cloud login",
        );
        elizaCloudLoginBusyRef.current = false;
        setElizaCloudLoginBusy(false);
        return;
      }

      // Try to open the login URL in the system browser (uses desktop bridge
      // in Electrobun, falls back to window.open in web contexts).
      if (resp.browserUrl) {
        try {
          await openExternalUrl(resp.browserUrl);
        } catch {
          // Popup was blocked (common when window.open runs after an async
          // gap and loses user-gesture context). Surface the URL so the user
          // can open it manually — the polling loop below still runs.
          setElizaCloudLoginError(
            `Open this link to log in: ${resp.browserUrl}`,
          );
        }
      }

      const sessionId = resp.sessionId ?? "";

      let pollInFlight = false;
      let consecutivePollErrors = 0;
      const pollDeadline = Date.now() + ELIZA_CLOUD_LOGIN_TIMEOUT_MS;
      const stopCloudLoginPolling = (error: string | null = null) => {
        if (elizaCloudLoginPollTimer.current !== null) {
          clearInterval(elizaCloudLoginPollTimer.current);
          elizaCloudLoginPollTimer.current = null;
        }
        elizaCloudLoginBusyRef.current = false;
        setElizaCloudLoginBusy(false);
        if (error !== null) {
          setElizaCloudLoginError(error);
        }
      };

      // Start polling
      elizaCloudLoginPollTimer.current = window.setInterval(async () => {
        if (!elizaCloudLoginPollTimer.current || pollInFlight) return;
        if (Date.now() >= pollDeadline) {
          stopCloudLoginPolling(
            "Eliza Cloud login timed out. Please try again.",
          );
          return;
        }

        pollInFlight = true;
        try {
          if (!elizaCloudLoginPollTimer.current) return;
          let poll: {
            status: string;
            token?: string;
            userId?: string;
            error?: string;
          };
          if (useDirectAuth) {
            poll = await client.cloudLoginPollDirect(cloudApiBase, sessionId);
          } else {
            poll = await client.cloudLoginPoll(sessionId);
          }
          if (!elizaCloudLoginPollTimer.current) return;

          consecutivePollErrors = 0;
          if (poll.status === "authenticated") {
            stopCloudLoginPolling();
            setElizaCloudConnected(true);
            setElizaCloudEnabled(true);
            setElizaCloudLoginError(null);

            // Store the cloud auth token for provisioning
            if (poll.token && typeof window !== "undefined") {
              (window as unknown as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ =
                poll.token;
              (window as unknown as Record<string, unknown>).__ELIZA_CLOUD_API_BASE__ =
                cloudApiBase;
            }

            setActionNotice(
              "Logged in to Eliza Cloud successfully.",
              "success",
              6000,
            );
            if (!useDirectAuth) {
              void loadWalletConfig();
              // Delay the credit fetch slightly so the backend has time to
              // persist the API key before we query cloud status / credits.
              setTimeout(() => void pollCloudCredits(), 2000);
            }
          } else if (poll.status === "expired" || poll.status === "error") {
            stopCloudLoginPolling(
              poll.error ?? "Login session expired. Please try again.",
            );
          }
        } catch (pollErr) {
          console.error("Eliza Cloud login poll error:", pollErr);
          if (!elizaCloudLoginPollTimer.current) return;

          consecutivePollErrors += 1;
          if (
            consecutivePollErrors >= ELIZA_CLOUD_LOGIN_MAX_CONSECUTIVE_ERRORS
          ) {
            const detail =
              pollErr instanceof Error && pollErr.message
                ? ` Last error: ${pollErr.message}`
                : "";
            stopCloudLoginPolling(
              `Eliza Cloud login check failed after repeated errors.${detail}`,
            );
          }
        } finally {
          pollInFlight = false;
        }
      }, ELIZA_CLOUD_LOGIN_POLL_INTERVAL_MS);
    } catch (err) {
      setElizaCloudLoginError(
        err instanceof Error ? err.message : "Eliza Cloud login failed",
      );
      elizaCloudLoginBusyRef.current = false;
      setElizaCloudLoginBusy(false);
    }
  }, [
    elizaCloudLoginBusy,
    setActionNotice,
    pollCloudCredits,
    loadWalletConfig,
  ]);

  const handleCloudDisconnect = useCallback(async () => {
    if (
      !(await confirmDesktopAction({
        title: "Disconnect from Eliza Cloud",
        message: "The agent will need a local AI provider to continue working.",
        confirmLabel: "Disconnect",
        cancelLabel: "Cancel",
        type: "warning",
      }))
    )
      return;
    setElizaCloudDisconnecting(true);
    try {
      await client.cloudDisconnect();
      setElizaCloudEnabled(false);
      setElizaCloudConnected(false);
      setElizaCloudCredits(null);
      setElizaCloudUserId(null);
      setActionNotice("Disconnected from Eliza Cloud.", "success");
    } catch (err) {
      setActionNotice(
        `Failed to disconnect: ${err instanceof Error ? err.message : err}`,
        "error",
      );
    } finally {
      setElizaCloudDisconnecting(false);
    }
  }, [setActionNotice]);

  const handleCloudOnboardingFinish = useCallback(() => {
    setOnboardingComplete(true);
    setTab("chat");
  }, []);

  // ── Updates ────────────────────────────────────────────────────────

  const handleChannelChange = useCallback(
    async (channel: ReleaseChannel) => {
      if (updateChannelSavingRef.current || updateChannelSaving) return;
      if (updateStatus?.channel === channel) return;
      updateChannelSavingRef.current = true;
      setUpdateChannelSaving(true);
      try {
        await client.setUpdateChannel(channel);
        await loadUpdateStatus(true);
      } catch {
        /* ignore */
      } finally {
        updateChannelSavingRef.current = false;
        setUpdateChannelSaving(false);
      }
    },
    [updateChannelSaving, updateStatus, loadUpdateStatus],
  );

  // ── Agent export/import ────────────────────────────────────────────

  const handleAgentExport = useCallback(async () => {
    if (exportBusyRef.current || exportBusy) return;
    if (!exportPassword) {
      setExportError("Password is required.");
      setExportSuccess(null);
      return;
    }
    if (exportPassword.length < AGENT_TRANSFER_MIN_PASSWORD_LENGTH) {
      setExportError(
        `Password must be at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters.`,
      );
      setExportSuccess(null);
      return;
    }
    try {
      exportBusyRef.current = true;
      setExportBusy(true);
      setExportError(null);
      setExportSuccess(null);
      const resp = await client.exportAgent(exportPassword, exportIncludeLogs);
      const blob = await resp.blob();
      const disposition = resp.headers.get("Content-Disposition") ?? "";
      const filenameMatch = /filename="?([^"]+)"?/.exec(disposition);
      const filename = filenameMatch?.[1] ?? "agent-export.eliza-agent";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportSuccess(
        `Exported successfully (${(blob.size / 1024).toFixed(0)} KB)`,
      );
      setExportPassword("");
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      exportBusyRef.current = false;
      setExportBusy(false);
    }
  }, [exportBusy, exportPassword, exportIncludeLogs]);

  const handleAgentImport = useCallback(async () => {
    if (importBusyRef.current || importBusy) return;
    if (!importFile) {
      setImportError("Select an export file before importing.");
      setImportSuccess(null);
      return;
    }
    if (!importPassword) {
      setImportError("Password is required.");
      setImportSuccess(null);
      return;
    }
    if (importPassword.length < AGENT_TRANSFER_MIN_PASSWORD_LENGTH) {
      setImportError(
        `Password must be at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters.`,
      );
      setImportSuccess(null);
      return;
    }
    try {
      importBusyRef.current = true;
      setImportBusy(true);
      setImportError(null);
      setImportSuccess(null);
      const fileBuffer = await importFile.arrayBuffer();
      const result = await client.importAgent(importPassword, fileBuffer);
      const counts = result.counts;
      const summary = [
        counts.memories ? `${counts.memories} memories` : null,
        counts.entities ? `${counts.entities} entities` : null,
        counts.rooms ? `${counts.rooms} rooms` : null,
      ]
        .filter(Boolean)
        .join(", ");
      setImportSuccess(
        `Imported "${result.agentName}" successfully: ${summary || "no data"}. Restart the agent to activate.`,
      );
      setImportPassword("");
      setImportFile(null);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    } finally {
      importBusyRef.current = false;
      setImportBusy(false);
    }
  }, [importBusy, importFile, importPassword]);

  // ── Emote picker ────────────────────────────────────────────────────

  const closeCommandPalette = useCallback(() => {
    _setCommandPaletteOpen(false);
    setCommandQuery("");
    setCommandActiveIndex(0);
  }, []);

  const openEmotePicker = useCallback(() => {
    setEmotePickerOpen(true);
  }, []);

  const closeEmotePicker = useCallback(() => {
    setEmotePickerOpen(false);
  }, []);

  // ── Generic state setter ───────────────────────────────────────────

  const setState = useCallback(
    <K extends keyof AppState>(key: K, value: AppState[K]) => {
      const setterMap: Partial<{
        [S in keyof AppState]: (v: AppState[S]) => void;
      }> = {
        tab: setTabRaw,
        onboardingStep: setOnboardingStep,
        chatInput: setChatInput,
        chatAvatarVisible: setChatAvatarVisible,
        chatAgentVoiceMuted: setChatAgentVoiceMuted,
        chatLastUsage: setChatLastUsage,
        chatMode: setChatMode,
        chatAvatarSpeaking: setChatAvatarSpeaking,
        companionMessageCutoffTs: setCompanionMessageCutoffTs,
        uiShellMode: setUiShellMode,
        uiLanguage: setUiLanguageState,
        autonomousRunHealthByRunId: setAutonomousRunHealthByRunId,
        startupError: setStartupError,
        pairingCodeInput: setPairingCodeInput,
        pluginFilter: setPluginFilter,
        pluginStatusFilter: setPluginStatusFilter,
        pluginSearch: setPluginSearch,
        pluginSettingsOpen: setPluginSettingsOpen,
        pluginAdvancedOpen: setPluginAdvancedOpen,
        skillsSubTab: setSkillsSubTab,
        skillCreateFormOpen: setSkillCreateFormOpen,
        skillCreateName: setSkillCreateName,
        skillCreateDescription: setSkillCreateDescription,
        skillsMarketplaceQuery: setSkillsMarketplaceQuery,
        skillsMarketplaceManualGithubUrl: setSkillsMarketplaceManualGithubUrl,
        logTagFilter: setLogTagFilter,
        logLevelFilter: setLogLevelFilter,
        logSourceFilter: setLogSourceFilter,
        inventoryView: setInventoryView,
        inventorySort: setInventorySort,
        inventoryChainFocus: setInventoryChainFocus,
        exportPassword: setExportPassword,
        exportIncludeLogs: setExportIncludeLogs,
        exportError: setExportError,
        exportSuccess: setExportSuccess,
        importPassword: setImportPassword,
        importFile: setImportFile,
        importError: setImportError,
        importSuccess: setImportSuccess,
        onboardingName: setOnboardingName,
        onboardingOwnerName: setOnboardingOwnerName,
        onboardingStyle: setOnboardingStyle,
        onboardingRunMode: setOnboardingRunMode,
        onboardingCloudProvider: setOnboardingCloudProvider,
        onboardingSmallModel: setOnboardingSmallModel,
        onboardingLargeModel: setOnboardingLargeModel,
        onboardingProvider: setOnboardingProvider,
        onboardingApiKey: setOnboardingApiKey,
        onboardingDetectedProviders: setOnboardingDetectedProviders,
        onboardingRemoteApiBase: setOnboardingRemoteApiBase,
        onboardingRemoteToken: setOnboardingRemoteToken,
        onboardingRemoteConnecting: setOnboardingRemoteConnecting,
        onboardingRemoteError: setOnboardingRemoteError,
        onboardingRemoteConnected: setOnboardingRemoteConnected,
        onboardingSelectedChains: setOnboardingSelectedChains,
        onboardingRpcSelections: setOnboardingRpcSelections,
        onboardingOpenRouterModel: setOnboardingOpenRouterModel,
        onboardingPrimaryModel: setOnboardingPrimaryModel,
        onboardingTelegramToken: setOnboardingTelegramToken,
        onboardingDiscordToken: setOnboardingDiscordToken,
        onboardingWhatsAppSessionPath: setOnboardingWhatsAppSessionPath,
        onboardingTwilioAccountSid: setOnboardingTwilioAccountSid,
        onboardingTwilioAuthToken: setOnboardingTwilioAuthToken,
        onboardingTwilioPhoneNumber: setOnboardingTwilioPhoneNumber,
        onboardingBlooioApiKey: setOnboardingBlooioApiKey,
        onboardingBlooioPhoneNumber: setOnboardingBlooioPhoneNumber,
        onboardingGithubToken: setOnboardingGithubToken,
        onboardingSubscriptionTab: setOnboardingSubscriptionTab,
        onboardingElizaCloudTab: setOnboardingElizaCloudTab,
        onboardingRpcKeys: setOnboardingRpcKeys,
        onboardingAvatar: setOnboardingAvatar,
        onboardingRestarting: setOnboardingRestarting,
        elizaCloudEnabled: setElizaCloudEnabled,
        cloudDashboardView: setCloudDashboardView,
        selectedVrmIndex: setSelectedVrmIndex,
        customVrmUrl: setCustomVrmUrl,
        customBackgroundUrl: setCustomBackgroundUrl,
        commandQuery: setCommandQuery,
        commandActiveIndex: setCommandActiveIndex,
        emotePickerOpen: setEmotePickerOpen,
        storeSearch: setStoreSearch,
        storeFilter: setStoreFilter,
        storeSubTab: setStoreSubTab,
        catalogSearch: setCatalogSearch,
        catalogSort: setCatalogSort,
        catalogPage: setCatalogPage,
        skillReviewId: setSkillReviewId,
        skillReviewReport: setSkillReviewReport,
        activeGameApp: setActiveGameApp,
        activeGameDisplayName: setActiveGameDisplayName,
        activeGameViewerUrl: setActiveGameViewerUrl,
        activeGameSandbox: setActiveGameSandbox,
        activeGamePostMessageAuth: setActiveGamePostMessageAuth,
        activeGamePostMessagePayload: setActiveGamePostMessagePayload,
        gameOverlayEnabled: setGameOverlayEnabled,
        storePlugins: setStorePlugins,
        storeLoading: setStoreLoading,
        storeInstalling: setStoreInstalling,
        storeUninstalling: setStoreUninstalling,
        storeError: setStoreError,
        storeDetailPlugin: setStoreDetailPlugin,
        catalogSkills: setCatalogSkills,
        catalogTotal: setCatalogTotal,
        catalogTotalPages: setCatalogTotalPages,
        catalogLoading: setCatalogLoading,
        catalogError: setCatalogError,
        catalogDetailSkill: setCatalogDetailSkill,
        catalogInstalling: setCatalogInstalling,
        catalogUninstalling: setCatalogUninstalling,
        mcpConfiguredServers: setMcpConfiguredServers,
        mcpServerStatuses: setMcpServerStatuses,
        mcpMarketplaceQuery: setMcpMarketplaceQuery,
        mcpMarketplaceResults: setMcpMarketplaceResults,
        mcpMarketplaceLoading: setMcpMarketplaceLoading,
        mcpAction: setMcpAction,
        mcpAddingServer: setMcpAddingServer,
        mcpAddingResult: setMcpAddingResult,
        mcpEnvInputs: setMcpEnvInputs,
        mcpHeaderInputs: setMcpHeaderInputs,
        droppedFiles: setDroppedFiles,
        shareIngestNotice: setShareIngestNotice,
        appsSubTab: setAppsSubTab,
        agentSubTab: setAgentSubTab,
        pluginsSubTab: setPluginsSubTab,
        databaseSubTab: setDatabaseSubTab,
        configRaw: setConfigRaw,
        configText: setConfigText,
      };
      const setter = setterMap[key];
      if (setter) setter(value);
    },
    [setOnboardingStep, setSelectedVrmIndex, setUiShellMode],
  );

  // ── Initialization ─────────────────────────────────────────────────

  // biome-ignore lint/correctness/useExhaustiveDependencies: t is stable but defined later
  useEffect(() => {
    const startupRunId = startupRetryNonce;
    let unbindStatus: (() => void) | null = null;
    let unbindAgentEvents: (() => void) | null = null;
    let unbindHeartbeatEvents: (() => void) | null = null;
    let unbindEmotes: (() => void) | null = null;
    let unbindProactiveMessages: (() => void) | null = null;
    let handleVisibilityRef: (() => void) | null = null;
    let unbindWsReconnect: (() => void) | null = null;
    let unbindSystemWarnings: (() => void) | null = null;
    let unbindRestartRequired: (() => void) | null = null;
    let cancelled = false;
    const describeBackendFailure = (
      err: unknown,
      timedOut: boolean,
    ): StartupErrorState => {
      const apiErr = asApiLikeError(err);
      if (apiErr?.kind === "http" && apiErr.status === 404) {
        return {
          reason: "backend-unreachable",
          phase: "starting-backend",
          message:
            "Backend API routes are unavailable on this origin (received 404).",
          detail: formatStartupErrorDetail(err),
          status: apiErr.status,
          path: apiErr.path,
        };
      }
      if (timedOut || apiErr?.kind === "timeout") {
        return {
          reason: "backend-timeout",
          phase: "starting-backend",
          message: `Backend did not become reachable within ${Math.round(
            getBackendStartupTimeoutMs() / 1000,
          )}s.`,
          detail: formatStartupErrorDetail(err),
          status: apiErr?.status,
          path: apiErr?.path,
        };
      }
      return {
        reason: "backend-unreachable",
        phase: "starting-backend",
        message: "Failed to reach backend during startup.",
        detail: formatStartupErrorDetail(err),
        status: apiErr?.status,
        path: apiErr?.path,
      };
    };
    const describeAgentFailure = (
      err: unknown,
      timedOut: boolean,
      diagnostics?: AgentStartupDiagnostics,
    ): StartupErrorState => {
      const detail =
        diagnostics?.lastError ||
        formatStartupErrorDetail(err) ||
        "Agent runtime did not report a reason.";
      const isAssetMissing =
        /required companion assets could not be loaded|bundled avatar .* could not be loaded/i.test(
          detail,
        );
      if (!timedOut && isAssetMissing) {
        return {
          reason: "asset-missing",
          phase: "initializing-agent",
          message: "Required companion assets could not be loaded.",
          detail,
        };
      }
      if (timedOut) {
        return {
          reason: "agent-timeout",
          phase: "initializing-agent",
          message: `Agent did not reach running or paused within ${Math.round(
            AGENT_READY_TIMEOUT_MS / 1000,
          )}s.`,
          detail,
        };
      }
      return {
        reason: "agent-error",
        phase: "initializing-agent",
        message: "Agent runtime reported a startup error.",
        detail,
      };
    };
    const STARTUP_WARN_PREFIX = "[milady][startup:init]";
    const logStartupWarning = (scope: string, err: unknown) => {
      console.warn(`${STARTUP_WARN_PREFIX} ${scope}`, err);
    };

    const initApp = async () => {
      if (import.meta.env.DEV && startupRunId > 0) {
        console.debug(`[milady] Retrying startup run #${startupRunId}`);
      }
      const BASE_DELAY_MS = 250;
      const MAX_DELAY_MS = 1000;
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));
      let onboardingNeedsOptions = false;
      let requiresAuth = false;
      let latestAuth: {
        required: boolean;
        pairingEnabled: boolean;
        expiresAt: number | null;
      } = {
        required: false,
        pairingEnabled: false,
        expiresAt: null,
      };
      setStartupError(null);
      setStartupPhase("starting-backend");
      setAuthRequired(false);
      setConnected(false);

      // If onboarding hasn't been completed yet (no persisted connection),
      // skip all backend polling and go straight to onboarding with static
      // data. The agent will be started (local mode) or provisioned (sandbox
      // mode) only after onboarding completes. This ensures the entire
      // onboarding flow — character selection, editing, provider config —
      // works with zero server calls.
      const persistedConnection = loadPersistedConnectionMode();

      if (!persistedConnection) {
        // Onboarding not completed — show it immediately without waiting
        // for a backend. Populate onboardingOptions with static frontend
        // data so handleOnboardingFinish doesn't early-return on null options.
        const injectedStyles =
          (typeof window !== "undefined" &&
            (window as unknown as Record<string, unknown>)
              .__APP_ONBOARDING_STYLES__) ||
          [];
        setOnboardingOptions({
          names: [],
          styles: injectedStyles as StylePreset[],
          providers: [...ONBOARDING_PROVIDER_CATALOG] as OnboardingOptions["providers"],
          cloudProviders: [],
          models: { small: [], large: [] },
          inventoryProviders: [],
          sharedStyleRules: "",
        });
        setStartupPhase("ready");
        setOnboardingComplete(false);
        setOnboardingLoading(false);
        return;
      }

      // Restore connection from persisted state for returning users
      if (persistedConnection) {
        if (
          persistedConnection.runMode === "cloud" &&
          persistedConnection.cloudApiBase
        ) {
          client.setBaseUrl(persistedConnection.cloudApiBase);
          if (persistedConnection.cloudAuthToken) {
            client.setToken(persistedConnection.cloudAuthToken);
          }
        } else if (
          persistedConnection.runMode === "remote" &&
          persistedConnection.remoteApiBase
        ) {
          client.setBaseUrl(persistedConnection.remoteApiBase);
          if (persistedConnection.remoteAccessToken) {
            client.setToken(persistedConnection.remoteAccessToken);
          }
        } else if (
          persistedConnection.runMode === "local" &&
          !((typeof window !== "undefined" && (window as unknown as Record<string, unknown>).__MILADY_API_BASE__) ||
            (typeof window !== "undefined" && (window as unknown as Record<string, unknown>).__ELIZA_API_BASE__))
        ) {
          // Local mode but no API base — need to start the agent first.
          // Trigger agent start via RPC and then continue polling.
          try {
            await invokeDesktopBridgeRequest({
              rpcMethod: "agentStart",
              ipcChannel: "agent:start",
            });
          } catch {
            // Not on desktop or agent already running
          }
        }
      }

      const backendStartedAt = Date.now();
      let lastBackendError: unknown = null;

      // Keep the splash screen up until the backend is reachable.
      let backendAttempts = 0;
      while (!cancelled) {
        if (Date.now() - backendStartedAt >= getBackendStartupTimeoutMs()) {
          setStartupError(describeBackendFailure(lastBackendError, true));
          setOnboardingLoading(false);
          return;
        }
        try {
          const auth = await client.getAuthStatus();
          latestAuth = auth;
          if (auth.required && !client.hasToken()) {
            setAuthRequired(true);
            setPairingEnabled(auth.pairingEnabled);
            setPairingExpiresAt(auth.expiresAt);
            requiresAuth = true;
            break;
          }
          const { complete } = await client.getOnboardingStatus();
          const sessionOnboardingComplete =
            complete || onboardingCompletionCommittedRef.current;
          if (complete) {
            clearPersistedOnboardingStep();
            onboardingResumeConnectionRef.current = null;
          }
          setOnboardingComplete(sessionOnboardingComplete);
          onboardingNeedsOptions = !sessionOnboardingComplete;
          break;
        } catch (err) {
          const apiErr = asApiLikeError(err);
          if (apiErr?.status === 401 && client.hasToken()) {
            client.setToken(null);
            setAuthRequired(true);
            setPairingEnabled(latestAuth.pairingEnabled);
            setPairingExpiresAt(latestAuth.expiresAt);
            requiresAuth = true;
            break;
          }
          if (apiErr?.status === 404) {
            setStartupError(describeBackendFailure(err, false));
            setOnboardingLoading(false);
            return;
          }
          lastBackendError = err;
          backendAttempts += 1;
          const delay = Math.min(
            BASE_DELAY_MS * 2 ** Math.min(backendAttempts, 2),
            MAX_DELAY_MS,
          );
          await sleep(delay);
        }
      }
      if (cancelled) {
        return;
      }

      if (requiresAuth) {
        setStartupPhase("ready");
        setOnboardingLoading(false);
        return;
      }

      // On fresh installs, unblock to onboarding as soon as options are available.
      if (onboardingNeedsOptions) {
        const optionsStartedAt = Date.now();
        let optionsError: unknown = null;
        while (!cancelled) {
          if (Date.now() - optionsStartedAt >= getBackendStartupTimeoutMs()) {
            setStartupError(describeBackendFailure(optionsError, true));
            setOnboardingLoading(false);
            return;
          }
          try {
            const [options, config] = await Promise.all([
              client.getOnboardingOptions(),
              client.getConfig().catch(() => null),
            ]);
            if (onboardingCompletionCommittedRef.current) {
              setStartupPhase("ready");
              setOnboardingLoading(false);
              return;
            }
            const resumeConnection = deriveOnboardingResumeConnection(config);
            const resumeFields = deriveOnboardingResumeFields(resumeConnection);
            onboardingResumeConnectionRef.current = resumeConnection;
            setOnboardingOptions(options);

            // Auto-detect AI provider credentials from local CLI installs.
            // Only auto-fill if no existing connection config was found.
            if (!resumeConnection) {
              try {
                const detected = await scanProviderCredentials();
                if (detected.length > 0) {
                  setOnboardingDetectedProviders(detected);
                  // Auto-fill with the first detected provider
                  const first = detected[0];
                  if (first.apiKey) {
                    setOnboardingRunMode("local");
                    setOnboardingProvider(first.id);
                    setOnboardingApiKey(first.apiKey);
                  }
                }
              } catch {
                // Non-fatal — credential scan is best-effort
              }
            }

            if (resumeFields.onboardingRunMode !== undefined) {
              setOnboardingRunMode(resumeFields.onboardingRunMode);
            }
            if (resumeFields.onboardingCloudProvider !== undefined) {
              setOnboardingCloudProvider(resumeFields.onboardingCloudProvider);
            }
            if (resumeFields.onboardingProvider !== undefined) {
              setOnboardingProvider(resumeFields.onboardingProvider);
            }
            if (resumeFields.onboardingApiKey !== undefined) {
              setOnboardingApiKey(resumeFields.onboardingApiKey);
            }
            if (resumeFields.onboardingPrimaryModel !== undefined) {
              setOnboardingPrimaryModel(resumeFields.onboardingPrimaryModel);
            }
            if (resumeFields.onboardingOpenRouterModel !== undefined) {
              setOnboardingOpenRouterModel(
                resumeFields.onboardingOpenRouterModel,
              );
            }
            if (resumeFields.onboardingRemoteConnected !== undefined) {
              setOnboardingRemoteConnected(
                resumeFields.onboardingRemoteConnected,
              );
            }
            if (resumeFields.onboardingRemoteApiBase !== undefined) {
              setOnboardingRemoteApiBase(resumeFields.onboardingRemoteApiBase);
            }
            if (resumeFields.onboardingRemoteToken !== undefined) {
              setOnboardingRemoteToken(resumeFields.onboardingRemoteToken);
            }
            if (resumeFields.onboardingSmallModel !== undefined) {
              setOnboardingSmallModel(resumeFields.onboardingSmallModel);
            }
            if (resumeFields.onboardingLargeModel !== undefined) {
              setOnboardingLargeModel(resumeFields.onboardingLargeModel);
            }
            setOnboardingStep(
              inferOnboardingResumeStep({
                persistedStep: loadPersistedOnboardingStep(),
                config,
              }),
            );
            setStartupPhase("ready");
            setOnboardingLoading(false);
            return;
          } catch (err) {
            const apiErr = asApiLikeError(err);
            if (apiErr?.status === 401 && client.hasToken()) {
              client.setToken(null);
              setAuthRequired(true);
              setPairingEnabled(latestAuth.pairingEnabled);
              setPairingExpiresAt(latestAuth.expiresAt);
              setStartupPhase("ready");
              setOnboardingLoading(false);
              return;
            }
            if (apiErr?.status === 404) {
              setStartupError(describeBackendFailure(err, false));
              setOnboardingLoading(false);
              return;
            }
            optionsError = err;
            await sleep(500);
          }
        }
        return;
      }

      setStartupPhase("initializing-agent");

      // Existing installs: keep loading until the runtime reports ready.
      let agentReady = false;
      const agentDeadlineAt = Date.now() + AGENT_READY_TIMEOUT_MS;
      let lastAgentError: unknown = null;
      let lastAgentDiagnostics: AgentStartupDiagnostics | undefined;
      while (!cancelled) {
        if (Date.now() >= agentDeadlineAt) {
          setStartupError(
            describeAgentFailure(lastAgentError, true, lastAgentDiagnostics),
          );
          setOnboardingLoading(false);
          return;
        }
        try {
          let status = await client.getStatus();
          setAgentStatus(status);
          setConnected(true);
          lastAgentDiagnostics = status.startup;

          // Hydrate deferred restart state
          if (status.pendingRestart) {
            setPendingRestart(true);
            setPendingRestartReasons(status.pendingRestartReasons ?? []);
          }

          if (status.state === "not_started" || status.state === "stopped") {
            try {
              status = await client.startAgent();
              setAgentStatus(status);
              lastAgentDiagnostics = status.startup;
            } catch (err) {
              lastAgentError = err;
            }
          }

          if (status.state === "running") {
            agentReady = true;
            break;
          }

          if (status.state === "error") {
            setStartupError(
              describeAgentFailure(lastAgentError, false, status.startup),
            );
            setOnboardingLoading(false);
            return;
          }
        } catch (err) {
          const apiErr = asApiLikeError(err);
          if (apiErr?.status === 401 && client.hasToken()) {
            client.setToken(null);
            setAuthRequired(true);
            setPairingEnabled(latestAuth.pairingEnabled);
            setPairingExpiresAt(latestAuth.expiresAt);
            setOnboardingLoading(false);
            return;
          }
          lastAgentError = err;
          setConnected(false);
        }
        await sleep(500);
      }
      if (cancelled) return;

      if (!agentReady) {
        setStartupError(
          describeAgentFailure(lastAgentError, true, lastAgentDiagnostics),
        );
        setOnboardingLoading(false);
        return;
      }

      setStartupError(null);
      const greetConvId = await hydrateInitialConversationState();
      setStartupPhase("ready");
      setOnboardingLoading(false);
      if (greetConvId) {
        void requestGreetingWhenRunning(greetConvId, { showOverlay: true });
      }

      void loadWorkbench();
      void loadPlugins(); // Hydrate plugin state early so Nav sees streaming-base toggle

      // Hydrate coding agent sessions (also re-called on WS reconnect / server restart)
      const hydratePtySessions = () => {
        client
          .getCodingAgentStatus()
          .then((status) => {
            if (status?.tasks) {
              setPtySessions(mapServerTasksToSessions(status.tasks));
            }
          })
          .catch(() => { }); // non-critical
      };
      hydratePtySessions();
      let ptyHydratedViaWs = false;

      // Connect WebSocket
      client.connectWs();

      unbindEmotes = client.onWsEvent(
        "emote",
        (data: Record<string, unknown>) => {
          const emote = normalizeAppEmoteEvent(data);
          if (emote) {
            dispatchAppEmoteEvent(emote);
          }
        },
      );

      // Re-hydrate PTY sessions on WS reconnect — events sent during
      // the disconnect gap are lost, so we reconcile from the server.
      unbindWsReconnect = client.onWsEvent("ws-reconnected", () => {
        hydratePtySessions();
      });

      // Surface system-level warnings (connector failures, wiring exhaustion, etc.)
      unbindSystemWarnings = client.onWsEvent(
        "system-warning",
        (data: Record<string, unknown>) => {
          const message = typeof data.message === "string" ? data.message : "";
          if (message) {
            setSystemWarnings((prev) => {
              if (prev.includes(message)) return prev;
              const next = [...prev, message];
              if (next.length > 50) next.splice(0, next.length - 50);
              return next;
            });
          }
        },
      );

      // Re-hydrate when the tab becomes visible — browsers may throttle
      // or drop WS messages for background tabs.
      handleVisibilityRef = () => {
        if (document.visibilityState === "visible") {
          hydratePtySessions();
        }
      };
      document.addEventListener("visibilitychange", handleVisibilityRef);

      unbindStatus = client.onWsEvent(
        "status",
        (data: Record<string, unknown>) => {
          const nextStatus = parseAgentStatusEvent(data);
          if (nextStatus) {
            setAgentStatusIfChanged(nextStatus);
            // Auto-refresh plugins when agent reports a restart
            if (data.restarted) {
              setPendingRestart(false);
              setPendingRestartReasons([]);
              void loadPlugins();
              hydratePtySessions();
              ptyHydratedViaWs = true;
            }
          }
          // Re-hydrate PTY sessions on first WS status event to close
          // the race between initial REST fetch and WS connection.
          if (!ptyHydratedViaWs) {
            ptyHydratedViaWs = true;
            hydratePtySessions();
          }
          // Sync pending restart state from periodic broadcasts
          // Guard with value comparison to avoid no-op re-renders
          if (typeof data.pendingRestart === "boolean") {
            setPendingRestart((prev) =>
              prev === data.pendingRestart
                ? prev
                : (data.pendingRestart as boolean),
            );
          }
          if (Array.isArray(data.pendingRestartReasons)) {
            const nextReasons = data.pendingRestartReasons.filter(
              (el): el is string => typeof el === "string",
            );
            setPendingRestartReasons((prev) => {
              if (
                prev.length === nextReasons.length &&
                prev.every((r, i) => r === nextReasons[i])
              ) {
                return prev; // identical — skip re-render
              }
              return nextReasons;
            });
          }
        },
      );
      unbindRestartRequired = client.onWsEvent(
        "restart-required",
        (data: Record<string, unknown>) => {
          if (Array.isArray(data.reasons)) {
            setPendingRestartReasons(
              data.reasons.filter((el): el is string => typeof el === "string"),
            );
            setPendingRestart(true);
            setRestartBannerDismissed(false);
          }
        },
      );
      unbindAgentEvents = client.onWsEvent(
        "agent_event",
        (data: Record<string, unknown>) => {
          const event = parseStreamEventEnvelopeEvent(data);
          if (event) {
            appendAutonomousEvent(event);
          }
        },
      );
      unbindHeartbeatEvents = client.onWsEvent(
        "heartbeat_event",
        (data: Record<string, unknown>) => {
          const event = parseStreamEventEnvelopeEvent(data);
          if (event) {
            appendAutonomousEvent(event);
            notifyHeartbeatEvent(event);
          }
        },
      );

      await fetchAutonomyReplay();

      // Handle proactive messages from autonomy
      unbindProactiveMessages = client.onWsEvent(
        "proactive-message",
        (data: Record<string, unknown>) => {
          const parsed = parseProactiveMessageEvent(data);
          if (!parsed) return;
          const { conversationId: convId, message: msg } = parsed;

          if (convId === activeConversationIdRef.current) {
            // Active conversation — append in real-time (deduplicate by id)
            setConversationMessages((prev) => {
              if (prev.some((m) => m.id === msg.id)) return prev;
              return [...prev, msg];
            });
          } else {
            // Non-active — mark unread
            setUnreadConversations((prev) => new Set([...prev, convId]));
          }

          // Synthesize agent_event for non-retake sources (e.g. discord)
          // so they appear in the StreamView activity feed
          if (
            msg.source &&
            msg.source !== "retake" &&
            msg.source !== "client_chat" &&
            msg.role === "user"
          ) {
            appendAutonomousEvent({
              type: "agent_event",
              version: 1,
              eventId: `synth-${msg.id}`,
              ts: msg.timestamp,
              stream: "message",
              payload: {
                text: msg.text,
                from: msg.from,
                source: msg.source,
                direction: "inbound",
                channel: msg.source,
              },
            });
          }

          // Bump conversation to top of list
          setConversations((prev) => {
            const updated = prev.map((c) =>
              c.id === convId
                ? { ...c, updatedAt: new Date().toISOString() }
                : c,
            );
            return updated.sort(
              (a, b) =>
                new Date(b.updatedAt).getTime() -
                new Date(a.updatedAt).getTime(),
            );
          });
        },
      );

      // Handle conversation updates (e.g. title changes)
      client.onWsEvent(
        "conversation-updated",
        (data: Record<string, unknown>) => {
          const conv = data.conversation as Conversation;
          if (conv?.id) {
            setConversations((prev) => {
              const updated = prev.map((c) => (c.id === conv.id ? conv : c));
              return updated.sort(
                (a, b) =>
                  new Date(b.updatedAt).getTime() -
                  new Date(a.updatedAt).getTime(),
              );
            });
          }
        },
      );

      // Handle PTY session events from SwarmCoordinator
      client.onWsEvent("pty-session-event", (data: Record<string, unknown>) => {
        const eventType = (data.eventType ?? data.type) as string;
        const sessionId = data.sessionId as string;
        if (!sessionId) return;

        if (eventType === "task_registered") {
          const d = data.data as Record<string, unknown> | undefined;
          setPtySessions((prev) => [
            ...prev.filter((s) => s.sessionId !== sessionId),
            {
              sessionId,
              agentType: (d?.agentType as string) ?? "claude",
              label: (d?.label as string) ?? sessionId,
              originalTask: (d?.originalTask as string) ?? "",
              workdir: (d?.workdir as string) ?? "",
              status: "active",
              decisionCount: 0,
              autoResolvedCount: 0,
              lastActivity: "Starting",
            },
          ]);
        } else if (eventType === "task_complete" || eventType === "stopped") {
          setPtySessions((prev) =>
            prev.filter((s) => s.sessionId !== sessionId),
          );
        } else {
          // Status update — apply to known session, or full re-hydrate if unknown
          const applyUpdate = (
            prev: CodingAgentSession[],
          ): CodingAgentSession[] => {
            const known = prev.some((s) => s.sessionId === sessionId);
            if (!known) return prev; // will trigger hydration below

            if (eventType === "blocked" || eventType === "escalation") {
              const activity =
                eventType === "escalation"
                  ? "Escalated — needs attention"
                  : "Waiting for input";
              return prev.map((s) =>
                s.sessionId === sessionId
                  ? { ...s, status: "blocked" as const, lastActivity: activity }
                  : s,
              );
            }
            if (eventType === "tool_running") {
              const d = data.data as Record<string, unknown> | undefined;
              const toolDesc =
                (d?.description as string) ??
                (d?.toolName as string) ??
                "external tool";
              return prev.map((s) =>
                s.sessionId === sessionId
                  ? {
                    ...s,
                    status: "tool_running" as const,
                    toolDescription: toolDesc,
                    lastActivity: `Running ${toolDesc}`.slice(0, 60),
                  }
                  : s,
              );
            }
            if (eventType === "blocked_auto_resolved") {
              const d = data.data as Record<string, unknown> | undefined;
              const prompt =
                (d?.prompt as string) ?? (d?.reasoning as string) ?? "";
              const excerpt = prompt
                ? `Approved: ${prompt}`.slice(0, 60)
                : "Approved";
              return prev.map((s) =>
                s.sessionId === sessionId
                  ? {
                    ...s,
                    status: "active" as const,
                    toolDescription: undefined,
                    lastActivity: excerpt,
                  }
                  : s,
              );
            }
            // coordination_decision — emitted by swarm decision loop.
            // d.action values: "approve" | "respond" | "escalate" | "continue"
            if (eventType === "coordination_decision") {
              const d = data.data as Record<string, unknown> | undefined;
              const reasoning =
                (d?.reasoning as string) ?? (d?.action as string) ?? "";
              const wasEscalation = (d?.action as string) === "escalate";
              const excerpt = wasEscalation
                ? `Escalated: ${reasoning}`.slice(0, 60)
                : reasoning
                  ? `Responded: ${reasoning}`.slice(0, 60)
                  : "Responded";
              return prev.map((s) =>
                s.sessionId === sessionId
                  ? {
                    ...s,
                    status: "active" as const,
                    toolDescription: undefined,
                    lastActivity: excerpt,
                  }
                  : s,
              );
            }
            if (eventType === "ready") {
              return prev.map((s) =>
                s.sessionId === sessionId
                  ? {
                    ...s,
                    status: "active" as const,
                    toolDescription: undefined,
                    lastActivity: "Running",
                  }
                  : s,
              );
            }
            if (eventType === "error") {
              const d = data.data as Record<string, unknown> | undefined;
              const errMsg = (d?.message as string) ?? "Unknown error";
              return prev.map((s) =>
                s.sessionId === sessionId
                  ? {
                    ...s,
                    status: "error" as const,
                    lastActivity: `Error: ${errMsg}`.slice(0, 60),
                  }
                  : s,
              );
            }
            return prev;
          };

          let needsHydrate = false;
          setPtySessions((prev) => {
            const next = applyUpdate(prev);
            if (next === prev && !prev.some((s) => s.sessionId === sessionId)) {
              // Unknown session — flag for re-hydration outside the updater
              needsHydrate = true;
              return prev;
            }
            return next;
          });
          if (needsHydrate) {
            // Re-hydrate from server to pick up missed registrations
            hydratePtySessions();
          }
        }
      });

      // Load wallet addresses for header
      try {
        setWalletAddresses(await client.getWalletAddresses());
      } catch (err) {
        logStartupWarning("failed to load wallet addresses", err);
      }

      // Restore avatar selection from config (server-persisted under "ui")
      let resolvedIndex = loadAvatarIndex();
      try {
        const cfg = await client.getConfig();
        const ui = cfg.ui as Record<string, unknown> | undefined;
        if (ui?.avatarIndex != null) {
          resolvedIndex = normalizeAvatarIndex(Number(ui.avatarIndex));
          setSelectedVrmIndex(resolvedIndex);
        }
      } catch (err) {
        logStartupWarning("failed to load config for avatar selection", err);
      }
      // If custom avatar selected, verify the file still exists on the server
      if (resolvedIndex === 0) {
        const hasVrm = await client.hasCustomVrm();
        if (hasVrm) {
          setCustomVrmUrl(resolveApiUrl(`/api/avatar/vrm?t=${Date.now()}`));
        } else {
          setSelectedVrmIndex(1);
        }
        // Restore custom background if one was uploaded
        const hasBg = await client.hasCustomBackground();
        if (hasBg) {
          setCustomBackgroundUrl(
            resolveApiUrl(`/api/avatar/background?t=${Date.now()}`),
          );
        }
      }

      // Cloud polling — always run the initial poll unconditionally so we can
      // discover a pre-existing API key / connection. If connected, start the
      // recurring interval too.
      pollCloudCredits().then((connected) => {
        if (connected) {
          elizaCloudPollInterval.current = window.setInterval(
            () => pollCloudCredits(),
            60_000,
          );
        }
      });

      // Load tab from URL — use hash in file:// mode (packaged desktop builds)
      const navPath =
        window.location.protocol === "file:"
          ? window.location.hash.replace(/^#/, "") || "/"
          : window.location.pathname;
      const urlTab = tabFromPath(navPath);
      const shouldStartAtCharacterSelect = shouldStartAtCharacterSelectOnLaunch(
        {
          onboardingNeedsOptions,
          onboardingMode,
          navPath,
          urlTab,
        },
      );
      if (shouldStartAtCharacterSelect) {
        setTab("character-select");
        void loadCharacter();
      } else if (urlTab) {
        setTabRaw(urlTab);
        if (urlTab === "plugins" || urlTab === "connectors") {
          void loadPlugins();
          if (urlTab === "plugins") {
            void loadSkills();
          }
        }
        if (urlTab === "settings") {
          void checkExtensionStatus();
          void loadWalletConfig();
          void loadCharacter();
          void loadUpdateStatus();
          void loadPlugins();
        }
        if (urlTab === "character") {
          void loadCharacter();
        }
        if (urlTab === "wallets") {
          void loadInventory();
        }
      }
    };

    void initApp();

    // Navigation listener — use hashchange in file:// mode (packaged desktop builds)
    const isFileProtocol = window.location.protocol === "file:";
    const handleNavChange = () => {
      const navPath = isFileProtocol
        ? window.location.hash.replace(/^#/, "") || "/"
        : window.location.pathname;
      const t = tabFromPath(navPath);
      if (t) setTabRaw(t);
    };
    const navEvent = isFileProtocol ? "hashchange" : "popstate";
    window.addEventListener(navEvent, handleNavChange);

    return () => {
      cancelled = true;
      window.removeEventListener(navEvent, handleNavChange);
      if (elizaCloudPollInterval.current) {
        clearInterval(elizaCloudPollInterval.current);
        elizaCloudPollInterval.current = null;
      }
      if (elizaCloudLoginPollTimer.current) {
        clearInterval(elizaCloudLoginPollTimer.current);
        elizaCloudLoginPollTimer.current = null;
      }
      unbindStatus?.();
      unbindAgentEvents?.();
      unbindHeartbeatEvents?.();
      unbindEmotes?.();
      unbindProactiveMessages?.();
      unbindWsReconnect?.();
      unbindSystemWarnings?.();
      unbindRestartRequired?.();
      if (handleVisibilityRef)
        document.removeEventListener("visibilitychange", handleVisibilityRef);
      client.disconnectWs();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    appendAutonomousEvent,
    checkExtensionStatus,
    fetchAutonomyReplay,
    hydrateInitialConversationState,
    loadCharacter,
    loadInventory,
    loadPlugins,
    loadSkills,
    loadUpdateStatus,
    loadWalletConfig,
    loadWorkbench, // Cloud polling
    pollCloudCredits,
    requestGreetingWhenRunning,
    setSelectedVrmIndex,
    startupRetryNonce,
    uiLanguage,
  ]);

  // When agent transitions to "running", send a greeting if conversation is empty
  useEffect(() => {
    const current = agentStatus?.state ?? null;
    const prev = prevAgentStateRef.current;
    prevAgentStateRef.current = current;

    if (current === "running" && prev !== "running") {
      void loadWorkbench();

      // Agent just started — greet if conversation is empty.
      // The greetingFiredRef guard prevents double-greeting when both the
      // init mount effect and this state-transition effect race to fire.
      if (
        activeConversationId &&
        conversationMessages.length === 0 &&
        !chatSending &&
        !greetingFiredRef.current &&
        greetingInFlightConversationRef.current !== activeConversationId
      ) {
        void fetchGreeting(activeConversationId);
      }
    }
  }, [
    agentStatus?.state,
    loadWorkbench,
    activeConversationId,
    conversationMessages.length,
    chatSending,
    fetchGreeting,
  ]);

  // ── Context value ──────────────────────────────────────────────────

  const t = useMemo(() => createTranslator(uiLanguage), [uiLanguage]);

  const value: AppContextValue = {
    // Translations
    t,
    // State
    tab,
    uiShellMode,
    uiLanguage,
    uiTheme,
    connected,
    agentStatus,
    onboardingComplete,
    onboardingLoading,
    startupPhase,
    startupStatus,
    startupError,
    authRequired,
    actionNotice,
    lifecycleBusy,
    lifecycleAction,
    pendingRestart,
    pendingRestartReasons,
    restartBannerDismissed,
    backendConnection,
    backendDisconnectedBannerDismissed,
    pairingEnabled,
    pairingExpiresAt,
    pairingCodeInput,
    pairingError,
    pairingBusy,
    chatInput,
    chatSending,
    chatFirstTokenReceived,
    chatLastUsage,
    chatAvatarVisible,
    chatAgentVoiceMuted,
    chatMode,
    chatAvatarSpeaking,
    conversations,
    activeConversationId,
    companionMessageCutoffTs,
    conversationMessages,
    autonomousEvents,
    autonomousLatestEventId,
    autonomousRunHealthByRunId,
    ptySessions,
    unreadConversations,
    triggers,
    triggersLoading,
    triggersSaving,
    triggerRunsById,
    triggerHealth,
    triggerError,
    plugins,
    pluginFilter,
    pluginStatusFilter,
    pluginSearch,
    pluginSettingsOpen,
    pluginAdvancedOpen,
    pluginSaving,
    pluginSaveSuccess,
    skills,
    skillsSubTab,
    skillCreateFormOpen,
    skillCreateName,
    skillCreateDescription,
    skillCreating,
    skillReviewReport,
    skillReviewId,
    skillReviewLoading,
    skillToggleAction,
    skillsMarketplaceQuery,
    skillsMarketplaceResults,
    skillsMarketplaceError,
    skillsMarketplaceLoading,
    skillsMarketplaceAction,
    skillsMarketplaceManualGithubUrl,
    logs,
    logSources,
    logTags,
    logTagFilter,
    logLevelFilter,
    logSourceFilter,
    walletAddresses,
    walletConfig,
    walletBalances,
    walletNfts,
    walletLoading,
    walletNftsLoading,
    inventoryView,
    walletExportData,
    walletExportVisible,
    walletApiKeySaving,
    inventorySort,
    inventoryChainFocus,
    walletError,
    registryStatus,
    registryLoading,
    registryRegistering,
    registryError,
    dropStatus,
    dropLoading,
    mintInProgress,
    mintResult,
    mintError,
    mintShiny,
    whitelistStatus,
    whitelistLoading,
    twitterVerifyMessage,
    twitterVerifyUrl,
    twitterVerifying,
    characterData,
    characterLoading,
    characterSaving,
    characterSaveSuccess,
    characterSaveError,
    characterDraft,
    selectedVrmIndex,
    customVrmUrl,
    customBackgroundUrl,
    elizaCloudEnabled,
    elizaCloudConnected,
    elizaCloudCredits,
    elizaCloudCreditsLow,
    elizaCloudCreditsCritical,
    elizaCloudTopUpUrl,
    elizaCloudUserId,
    cloudDashboardView,
    elizaCloudLoginBusy,
    elizaCloudLoginError,
    elizaCloudDisconnecting,
    updateStatus,
    updateLoading,
    updateChannelSaving,
    extensionStatus,
    extensionChecking,
    storePlugins,
    storeSearch,
    storeFilter,
    storeLoading,
    storeInstalling,
    storeUninstalling,
    storeError,
    storeDetailPlugin,
    storeSubTab,
    catalogSkills,
    catalogTotal,
    catalogPage,
    catalogTotalPages,
    catalogSort,
    catalogSearch,
    catalogLoading,
    catalogError,
    catalogDetailSkill,
    catalogInstalling,
    catalogUninstalling,
    workbenchLoading,
    workbench,
    workbenchTasksAvailable,
    workbenchTriggersAvailable,
    workbenchTodosAvailable,
    exportBusy,
    exportPassword,
    exportIncludeLogs,
    exportError,
    exportSuccess,
    importBusy,
    importPassword,
    importFile,
    importError,
    importSuccess,
    onboardingStep,
    onboardingMode,
    onboardingActiveGuide,
    onboardingDeferredTasks,
    postOnboardingChecklistDismissed,
    onboardingOptions,
    onboardingName,
    onboardingOwnerName,
    onboardingStyle,
    onboardingRunMode,
    onboardingCloudProvider,
    onboardingSmallModel,
    onboardingLargeModel,
    onboardingProvider,
    onboardingApiKey,
    onboardingDetectedProviders,
    onboardingRemoteApiBase,
    onboardingRemoteToken,
    onboardingRemoteConnecting,
    onboardingRemoteError,
    onboardingRemoteConnected,
    onboardingOpenRouterModel,
    onboardingPrimaryModel,
    onboardingTelegramToken,
    onboardingDiscordToken,
    onboardingWhatsAppSessionPath,
    onboardingTwilioAccountSid,
    onboardingTwilioAuthToken,
    onboardingTwilioPhoneNumber,
    onboardingBlooioApiKey,
    onboardingBlooioPhoneNumber,
    onboardingGithubToken,
    onboardingSubscriptionTab,
    onboardingElizaCloudTab,
    onboardingSelectedChains,
    onboardingRpcSelections,
    onboardingRpcKeys,
    onboardingAvatar,
    onboardingRestarting,
    commandPaletteOpen,
    commandQuery,
    commandActiveIndex,
    closeCommandPalette,
    emotePickerOpen,
    mcpConfiguredServers,
    mcpServerStatuses,
    mcpMarketplaceQuery,
    mcpMarketplaceResults,
    mcpMarketplaceLoading,
    mcpAction,
    mcpAddingServer,
    mcpAddingResult,
    mcpEnvInputs,
    mcpHeaderInputs,
    droppedFiles,
    shareIngestNotice,
    chatPendingImages,
    activeGameApp,
    activeGameDisplayName,
    activeGameViewerUrl,
    activeGameSandbox,
    activeGamePostMessageAuth,
    gameOverlayEnabled,
    appsSubTab,
    agentSubTab,
    pluginsSubTab,
    databaseSubTab,
    configRaw,
    configText,
    activeGamePostMessagePayload,

    // Actions
    setTab,
    setUiShellMode,
    switchUiShellMode,
    switchShellView,
    setUiLanguage,
    setUiTheme,
    handleStart,
    handleStop,

    handleRestart,
    handleReset,
    retryStartup,
    dismissRestartBanner,
    showRestartBanner,
    triggerRestart,
    relaunchDesktop,
    dismissBackendDisconnectedBanner,
    retryBackendConnection,
    restartBackend,
    systemWarnings,
    dismissSystemWarning,
    handleChatSend,
    handleChatStop,
    handleChatRetry,
    handleChatEdit,
    handleChatClear,
    handleStartDraftConversation,
    handleNewConversation,
    setChatPendingImages,
    handleSelectConversation,
    handleDeleteConversation,
    handleRenameConversation,
    sendActionMessage,
    loadTriggers,
    createTrigger,
    updateTrigger,
    deleteTrigger,
    runTriggerNow,
    loadTriggerRuns,
    loadTriggerHealth,
    handlePairingSubmit,
    loadPlugins,
    handlePluginToggle,
    handlePluginConfigSave,
    loadSkills,
    refreshSkills,
    handleSkillToggle,
    handleCreateSkill,
    handleOpenSkill,
    handleDeleteSkill,
    handleReviewSkill,
    handleAcknowledgeSkill,
    searchSkillsMarketplace,
    installSkillFromMarketplace,
    uninstallMarketplaceSkill,
    installSkillFromGithubUrl,
    loadLogs,
    loadInventory,
    loadBalances,
    loadNfts,
    executeBscTrade,
    executeBscTransfer,
    getBscTradePreflight,
    getBscTradeQuote,
    getBscTradeTxStatus,
    loadWalletTradingProfile,
    handleWalletApiKeySave,
    handleExportKeys,
    loadRegistryStatus,
    registerOnChain,
    syncRegistryProfile,
    loadDropStatus,
    mintFromDrop,
    loadWhitelistStatus,
    loadCharacter,
    handleSaveCharacter,
    handleCharacterFieldInput,
    handleCharacterArrayInput,
    handleCharacterStyleInput,
    handleCharacterMessageExamplesInput,
    handleOnboardingNext,
    handleOnboardingBack,
    handleOnboardingRemoteConnect,
    handleOnboardingUseLocalBackend,
    handleCloudLogin,
    handleCloudDisconnect,
    handleCloudOnboardingFinish,
    loadUpdateStatus,
    handleChannelChange,
    checkExtensionStatus,
    openEmotePicker,
    closeEmotePicker,
    loadWorkbench,
    handleAgentExport,
    handleAgentImport,
    setActionNotice,
    setState,
    copyToClipboard,
  };

  const mergedBranding = useMemo(
    () => ({ ...DEFAULT_BRANDING, ...brandingOverride }),
    [brandingOverride],
  );

  return (
    <BrandingContext.Provider value={mergedBranding}>
      <AppContext.Provider value={value}>
        {children}
        <ConfirmModal {...modalProps} />
        <PromptModal {...promptModalProps} />
      </AppContext.Provider>
    </BrandingContext.Provider>
  );
}
