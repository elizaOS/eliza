/**
 * Global application state via React Context.
 *
 * Children access state and actions through the useApp() hook.
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../api";
import {
  ConfirmDialog,
  PromptDialog,
  useConfirm,
  usePrompt,
} from "../components/ui/confirm-dialog";
import { AppBootContext } from "../config/boot-config-react";
import { getBootConfig } from "../config/boot-config-store";
import { BrandingContext, DEFAULT_BRANDING } from "../config/branding";
import type { FirstRunRuntimeTarget } from "../first-run/runtime-target";
import type { UiLanguage } from "../i18n";
import {
  getWindowNavigationPath,
  resolveDefaultLandingTab,
  resolveInitialTabForPath,
  type Tab,
} from "../navigation";
import { applyThemeToDocument } from "../themes/apply-theme";
import { copyTextToClipboard } from "../utils";
import {
  getActiveProfile,
  loadAgentProfileRegistry,
  setActiveProfileId,
} from "./agent-profiles";
import {
  ChatComposerCtx,
  ChatInputRefCtx,
  clearAllChatDrafts,
  useChatComposerDraftPersistence,
} from "./ChatComposerContext";
import { CompanionSceneConfigCtx } from "./CompanionSceneConfigContext";
import { AppContext, type AppContextValue, type AppState } from "./internal";
import { PtySessionsCtx } from "./PtySessionsContext";
import {
  createPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";
import { deriveUiShellModeForTab } from "./shell-routing";
import type { RuntimeTarget } from "./startup-coordinator";
import { TranslationProvider, useTranslation } from "./TranslationContext";
import { useAppLifecycleEvents } from "./useAppLifecycleEvents";
import {
  useAgentGreetingEffects,
  useBackendConnectionSync,
  useNavigationPathSync,
} from "./useAppProviderEffects";
import { useAppShellState } from "./useAppShellState";
import { useCharacterState } from "./useCharacterState";
import { useChatCallbacks } from "./useChatCallbacks";
import { useChatState } from "./useChatState";
import { useCloudState } from "./useCloudState";
import { useDataLoaders } from "./useDataLoaders";
import { useDisplayPreferences } from "./useDisplayPreferences";
import { useExportImportState } from "./useExportImportState";
import { useFirstRunCallbacks } from "./useFirstRunCallbacks";
import { useFirstRunState } from "./useFirstRunState";
import { useLifecycleState } from "./useLifecycleState";
import { useLogsState } from "./useLogsState";
import { useMiscUiState } from "./useMiscUiState";
import { useNavigationState } from "./useNavigationState";
import { usePairingState } from "./usePairingState";
import { usePluginsSkillsState } from "./usePluginsSkillsState";
import { useStartupCoordinator } from "./useStartupCoordinator";
import { useTriggersState } from "./useTriggersState";
import { useVincentState } from "./useVincentState";
import { useWalletState } from "./useWalletState";

export {
  type ActionNotice,
  AGENT_STATES,
  AGENT_TRANSFER_MIN_PASSWORD_LENGTH,
  type AppActions,
  AppContext,
  type AppContextValue,
  type AppState,
  applyUiTheme,
  asApiLikeError,
  type ChatTurnUsage,
  type CompanionHalfFramerateMode,
  type CompanionVrmPowerMode,
  computeStreamingDelta,
  FIRST_RUN_PERMISSION_LABELS,
  type FirstRunNextOptions,
  formatSearchBullet,
  formatStartupErrorDetail,
  type GamePostMessageAuthPayload,
  getCompanionBackgroundUrl,
  getVrmBackgroundUrl,
  getVrmCount,
  getVrmPreviewUrl,
  getVrmTitle,
  getVrmUrl,
  LIFECYCLE_MESSAGES,
  type LifecycleAction,
  type LoadConversationMessagesResult,
  loadAvatarIndex,
  loadChatAvatarVisible,
  loadChatVoiceMuted,
  loadCompanionAnimateWhenHidden,
  loadCompanionHalfFramerateMode,
  loadCompanionVrmPowerMode,
  loadUiLanguage,
  loadUiShellMode,
  loadUiTheme,
  mergeStreamingText,
  type NavigationEventsApi,
  normalizeAvatarIndex,
  normalizeCompanionHalfFramerateMode,
  normalizeCompanionVrmPowerMode,
  normalizeCustomActionName,
  normalizeStreamComparisonText,
  normalizeUiShellMode,
  normalizeUiTheme,
  parseAgentStartupDiagnostics,
  parseAgentStatusEvent,
  parseAgentStatusFromMainMenuResetPayload,
  parseConversationMessageEvent,
  parseCustomActionParams,
  parseProactiveMessageEvent,
  parseSlashCommandInput,
  parseStreamEventEnvelopeEvent,
  type SetupStep,
  type ShellView,
  type SlashCommandInput,
  type StartupErrorReason,
  type StartupErrorState,
  type StartupPhase,
  saveAvatarIndex,
  saveChatAvatarVisible,
  saveChatVoiceMuted,
  saveCompanionAnimateWhenHidden,
  saveCompanionHalfFramerateMode,
  saveCompanionVrmPowerMode,
  saveUiLanguage,
  saveUiShellMode,
  saveUiTheme,
  shouldApplyFinalStreamText,
  type TabCommittedDetail,
  type TranslationContextValue,
  type UiShellMode,
  type UiTheme,
  useApp,
  VRM_COUNT,
} from "./internal";
export { AGENT_READY_TIMEOUT_MS } from "./types";

/**
 * FirstRunShell and bare `completeFirstRun()` land on the discovered
 * main-tab app; callers can open the companion overlay separately.
 *
 * Resolved synchronously from the cached apps catalog at module load.
 * Falls back to "home" when no installed app declares
 * `elizaos.app.mainTab=true`, keeping the clouds/avatar assistant surface as
 * the default shell landing page.
 */
const DEFAULT_LANDING_TAB: Tab = resolveDefaultLandingTab();

// ── Provider ───────────────────────────────────────────────────────────

export function AppProvider({
  children,
  branding: brandingOverride,
}: {
  children: ReactNode;
  branding?: Partial<import("../config/branding").BrandingConfig>;
}) {
  const onLanguageSyncError = useCallback((_lang: UiLanguage) => {
    // Non-fatal: language change will be reflected on next mount.
  }, []);
  return (
    <TranslationProvider
      onLanguageSyncError={onLanguageSyncError}
      branding={brandingOverride}
    >
      <AppProviderInner branding={brandingOverride}>
        {children}
      </AppProviderInner>
    </TranslationProvider>
  );
}

function AppProviderInner({
  children,
  branding: brandingOverride,
}: {
  children: ReactNode;
  branding?: Partial<import("../config/branding").BrandingConfig>;
}) {
  // --- Core state ---
  const [tab, _setTabRawInner] = useState<Tab>(() =>
    resolveInitialTabForPath(getWindowNavigationPath(), DEFAULT_LANDING_TAB),
  );
  const initialTabSetRef = useRef(false);
  const setTabRaw = useCallback((t: Tab) => {
    _setTabRawInner(t);
  }, []);
  // uiLanguage + t live in TranslationContext; consumed via useTranslation()
  const { t, uiLanguage, setUiLanguage } = useTranslation();
  // --- Display preferences (extracted to useDisplayPreferences) ---
  const displayPrefs = useDisplayPreferences();
  const {
    state: {
      uiTheme,
      companionVrmPowerMode,
      companionAnimateWhenHidden,
      companionHalfFramerateMode,
    },
    setUiTheme,
    setCompanionVrmPowerMode,
    setCompanionAnimateWhenHidden,
    setCompanionHalfFramerateMode,
  } = displayPrefs;

  // Apply the host app's brand theme (set via BrandingConfig.theme).
  const brandTheme = brandingOverride?.theme;
  useEffect(() => {
    if (!brandTheme) return;
    return applyThemeToDocument(brandTheme, uiTheme);
  }, [brandTheme, uiTheme]);

  // ── Lifecycle state (consolidated from 20+ useState hooks) ──
  const lifecycle = useLifecycleState();

  const {
    state: {
      connected,
      agentStatus,
      firstRunComplete,
      firstRunUiRevealNonce,
      firstRunLoading,
      startupPhase,
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
      systemWarnings,
    },
    setConnected,
    setAgentStatus,
    setAgentStatusIfChanged,
    setFirstRunComplete,
    incrementFirstRunRevealNonce: setFirstRunUiRevealNonce_increment,
    setFirstRunLoading,
    setStartupPhase,
    setStartupError,
    setAuthRequired,
    setActionNotice,
    beginLifecycleAction,
    finishLifecycleAction,
    setPendingRestart: setPendingRestartAction,
    dismissRestartBanner,
    showRestartBanner,
    setBackendConnection,
    dismissBackendBanner: dismissBackendDisconnectedBanner,
    resetBackendConnection,
    dismissSystemWarning,
    startupStatus,
    lifecycleBusyRef,
    lifecycleActionRef,
  } = lifecycle;

  // Compatibility wrappers — old code calls these separately; lifecycle hook combines them.
  const setPendingRestart = useCallback(
    (v: boolean | ((prev: boolean) => boolean)) => {
      const resolved =
        typeof v === "function" ? v(lifecycle.state.pendingRestart) : v;
      setPendingRestartAction(resolved);
    },
    [lifecycle.state.pendingRestart, setPendingRestartAction],
  );
  const setPendingRestartReasons = useCallback(
    (v: string[] | ((prev: string[]) => string[])) => {
      const resolved =
        typeof v === "function" ? v(lifecycle.state.pendingRestartReasons) : v;
      setPendingRestartAction(lifecycle.state.pendingRestart, resolved);
    },
    [
      lifecycle.state.pendingRestart,
      lifecycle.state.pendingRestartReasons,
      setPendingRestartAction,
    ],
  );
  const setFirstRunUiRevealNonce = useCallback(
    (_fn: (n: number) => number) => setFirstRunUiRevealNonce_increment(),
    [setFirstRunUiRevealNonce_increment],
  );
  const setBackendDisconnectedBannerDismissed = useCallback(
    (v: boolean) => {
      if (v) dismissBackendDisconnectedBanner();
      // Note: only dismissal is supported via the reducer
    },
    [dismissBackendDisconnectedBanner],
  );
  const setSystemWarnings = useCallback(
    (v: string[] | ((prev: string[]) => string[])) => {
      const resolved =
        typeof v === "function" ? v(lifecycle.state.systemWarnings) : v;
      lifecycle.setSystemWarnings(resolved);
    },
    [lifecycle.state.systemWarnings, lifecycle.setSystemWarnings],
  );
  const triggerRestartRef = useRef<() => Promise<void>>(async () => {});
  const triggerRestartProxy = useCallback(async () => {
    await triggerRestartRef.current();
  }, []);
  // retryStartup resets lifecycle state AND dispatches RETRY to the coordinator.
  // The coordinator's phase effects will re-run from restoring-session.
  // We store a ref to the coordinator's retry since it's created after this line.
  const coordinatorRetryRef = useRef<(() => void) | null>(null);
  const coordinatorResetRef = useRef<(() => void) | null>(null);
  const coordinatorFirstRunCompleteRef = useRef<(() => void) | null>(null);
  const retryStartup = useCallback(() => {
    lifecycle.retryStartup();
    coordinatorRetryRef.current?.();
  }, [lifecycle.retryStartup]);
  const uiShellMode = deriveUiShellModeForTab(tab);

  // --- Pairing ---
  // --- Pairing (extracted to usePairingState) ---
  const pairingHook = usePairingState();
  const {
    state: {
      pairingEnabled,
      pairingExpiresAt,
      pairingCodeInput,
      pairingError,
      pairingBusy,
    },
    setPairingEnabled,
    setPairingExpiresAt,
    setPairingCodeInput,
    handlePairingSubmit,
  } = pairingHook;

  // NOTE: StartupCoordinator hook moved below (after all dependency hooks).
  // Search for "── StartupCoordinator (sole startup authority) ──" below.

  // ── Chat state (consolidated from 18+ useState + 10 useEffect hooks) ──
  const chatState = useChatState();
  const {
    state: {
      chatInput,
      chatSending,
      chatFirstTokenReceived,
      chatLastUsage,
      chatAvatarVisible,
      chatAgentVoiceMuted,
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
      chatPendingImages,
    },
    setChatInput,
    setChatSending,
    setChatFirstTokenReceived,
    setChatLastUsage,
    setChatAvatarVisible,
    setChatAgentVoiceMuted,
    setChatAvatarSpeaking,
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs,
    setConversationMessages,
    setAutonomousEvents,
    setAutonomousLatestEventId,
    setAutonomousRunHealthByRunId,
    setPtySessions,
    setChatPendingImages,
    resetDraftState: resetConversationDraftState,
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    conversationsRef,
    conversationMessagesRef,
    conversationHydrationEpochRef,
    chatAbortRef,
    chatSendBusyRef,
    chatSendNonceRef,
    greetingFiredRef,
    greetingInFlightConversationRef,
    companionStaleConversationRefreshRef,
    autonomousStoreRef,
    autonomousEventsRef,
    autonomousLatestEventIdRef,
    autonomousRunHealthByRunIdRef,
    autonomousReplayInFlightRef,
    addUnread,
  } = chatState;
  const _chatComposerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // addUnread / removeUnread wrappers for old setUnreadConversations patterns.
  // Read current unreadConversations through a ref so this callback stays
  // stable across renders — otherwise it cascades into handleChatClear /
  // handleSelectConversation / handleDeleteConversation and busts the
  // AppContext value memo on every keystroke.
  const unreadConversationsRef = useRef(unreadConversations);
  unreadConversationsRef.current = unreadConversations;
  const setUnreadConversations = useCallback(
    (v: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      if (typeof v === "function") {
        const nextVal = v(unreadConversationsRef.current);
        // Sync back through dispatch
        for (const id of nextVal) addUnread(id);
      } else {
        // Direct set not supported through reducer — use add/remove
      }
    },
    [addUnread],
  );

  // --- Triggers (extracted to useTriggersState) ---
  const triggersHook = useTriggersState();
  const {
    state: {
      triggers,
      triggersLoaded,
      triggersLoading,
      triggersSaving,
      triggerRunsById,
      triggerHealth,
      triggerError,
    },
    loadTriggers,
    loadTriggerHealth,
    loadTriggerRuns,
    ensureTriggersLoaded,
    createTrigger,
    updateTrigger,
    deleteTrigger,
    runTriggerNow,
  } = triggersHook;

  // --- Plugins / Skills / Store / Catalog (extracted to usePluginsSkillsState) ---
  const pluginsSkillsHook = usePluginsSkillsState({
    setActionNotice,
    setPendingRestart,
    setPendingRestartReasons,
    showRestartBanner,
    triggerRestart: triggerRestartProxy,
  });
  const {
    plugins,
    setPlugins,
    pluginFilter,
    setPluginFilter,
    pluginStatusFilter,
    setPluginStatusFilter,
    pluginSearch,
    setPluginSearch,
    pluginSettingsOpen,
    setPluginSettingsOpen,
    pluginAdvancedOpen,
    setPluginAdvancedOpen,
    pluginSaving,
    pluginSaveSuccess,
    loadPlugins,
    ensurePluginsLoaded,
    handlePluginToggle,
    handlePluginConfigSave,
    skills,
    setSkills,
    skillsSubTab,
    setSkillsSubTab,
    skillCreateFormOpen,
    setSkillCreateFormOpen,
    skillCreateName,
    setSkillCreateName,
    skillCreateDescription,
    setSkillCreateDescription,
    skillCreating,
    skillReviewReport,
    setSkillReviewReport,
    skillReviewId,
    setSkillReviewId,
    skillReviewLoading,
    skillToggleAction,
    skillsMarketplaceQuery,
    setSkillsMarketplaceQuery,
    skillsMarketplaceResults,
    skillsMarketplaceError,
    skillsMarketplaceLoading,
    skillsMarketplaceAction,
    skillsMarketplaceManualGithubUrl,
    setSkillsMarketplaceManualGithubUrl,
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
    installSkillFromGithubUrl,
    uninstallMarketplaceSkill,
    enableMarketplaceSkill,
    disableMarketplaceSkill,
    copyMarketplaceSkillSource,
    storePlugins,
    setStorePlugins,
    storeSearch,
    setStoreSearch,
    storeFilter,
    setStoreFilter,
    storeLoading,
    setStoreLoading,
    storeInstalling,
    setStoreInstalling,
    storeUninstalling,
    setStoreUninstalling,
    storeError,
    setStoreError,
    storeDetailPlugin,
    setStoreDetailPlugin,
    storeSubTab,
    setStoreSubTab,
    catalogSkills,
    setCatalogSkills,
    catalogTotal,
    setCatalogTotal,
    catalogPage,
    setCatalogPage,
    catalogTotalPages,
    setCatalogTotalPages,
    catalogSort,
    setCatalogSort,
    catalogSearch,
    setCatalogSearch,
    catalogLoading,
    setCatalogLoading,
    catalogError,
    setCatalogError,
    catalogDetailSkill,
    setCatalogDetailSkill,
    catalogInstalling,
    setCatalogInstalling,
    catalogUninstalling,
    setCatalogUninstalling,
  } = pluginsSkillsHook;

  // --- Logs (extracted to useLogsState) ---
  const logsHook = useLogsState();
  const {
    state: {
      logs,
      logSources,
      logTags,
      logTagFilter,
      logLevelFilter,
      logSourceFilter,
      logLoadError,
    },
    setLogs,
    setLogTagFilter,
    setLogLevelFilter,
    setLogSourceFilter,
    loadLogs,
  } = logsHook;

  // --- Character (extracted to useCharacterState) ---
  const characterHook = useCharacterState({ agentStatus, setAgentStatus });
  const {
    state: {
      characterData,
      characterLoading,
      characterSaving,
      characterSaveSuccess,
      characterSaveError,
      characterDraft,
      selectedVrmIndex,
      customVrmUrl,
      customVrmPreviewUrl,
      customBackgroundUrl,
      customCatchphrase,
      customVoicePresetId,
      activePackId,
      customWorldUrl,
    },
    setSelectedVrmIndex,
    setCustomVrmUrl,
    setCustomVrmPreviewUrl,
    setCustomBackgroundUrl,
    setCustomCatchphrase,
    setCustomVoicePresetId,
    setActivePackId,
    setCustomWorldUrl,
    loadCharacter,
    handleSaveCharacter,
    handleCharacterFieldInput,
    handleCharacterArrayInput,
    handleCharacterStyleInput,
    handleCharacterMessageExamplesInput,
  } = characterHook;

  // elizaCloud* state, refs, and callbacks are now provided by useCloudState (cloudHook above).
  const shellState = useAppShellState();
  const {
    state: {
      ownerName,
      appsSubTab,
      agentSubTab,
      pluginsSubTab,
      databaseSubTab,
      favoriteApps,
      recentApps,
      configRaw,
      configText,
    },
    setOwnerNameState,
    setAppsSubTab,
    setAgentSubTab,
    setPluginsSubTab,
    setDatabaseSubTab,
    setFavoriteApps,
    setRecentApps,
    setConfigRaw,
    setConfigText,
  } = shellState;

  // Updates, Extension, and Workbench state are now in useDataLoaders (dataLoaders).

  // --- Agent export/import (extracted to useExportImportState) ---
  const exportImportHook = useExportImportState();
  const {
    state: {
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
    },
    setExportPassword,
    setExportIncludeLogs,
    setExportError,
    setExportSuccess,
    setImportPassword,
    setImportFile,
    setImportError,
    setImportSuccess,
    handleAgentExport,
    handleAgentImport,
  } = exportImportHook;

  // ── First-run state (consolidated from 35+ useState hooks) ──
  const firstRun = useFirstRunState(brandingOverride?.cloudOnly);
  const {
    state: {
      step: setupStep,
      mode: firstRunMode,
      activeGuide: firstRunActiveGuide,
      deferredTasks: firstRunDeferredTasks,
      postChecklistDismissed: postFirstRunChecklistDismissed,
      options: firstRunOptions,
      name: firstRunName,
      ownerName: firstRunOwnerName,
      style: firstRunStyle,
      avatar: setupAvatar,
      serverTarget: firstRunRuntimeTarget,
      cloudApiKey: firstRunCloudApiKey,
      provider: firstRunProvider,
      apiKey: firstRunApiKey,
      voiceProvider: firstRunVoiceProvider,
      voiceApiKey: firstRunVoiceApiKey,
      smallModel: firstRunSmallModel,
      largeModel: firstRunLargeModel,
      openRouterModel: firstRunOpenRouterModel,
      primaryModel: firstRunPrimaryModel,
      existingInstallDetected: firstRunExistingInstallDetected,
      detectedProviders: firstRunDetectedProviders,
      remoteApiBase: firstRunRemoteApiBase,
      remoteToken: firstRunRemoteToken,
      subscriptionTab: firstRunSubscriptionTab,
      elizaCloudTab: firstRunElizaCloudTab,
      selectedChains: firstRunSelectedChains,
      rpcSelections: firstRunRpcSelections,
      rpcKeys: firstRunRpcKeys,
      featureTelegram: firstRunFeatureTelegram,
      featureDiscord: firstRunFeatureDiscord,
      featurePhone: firstRunFeaturePhone,
      featureCrypto: firstRunFeatureCrypto,
      featureBrowser: firstRunFeatureBrowser,
      featureComputerUse: firstRunFeatureComputerUse,
      featureOAuthPending: firstRunFeatureOAuthPending,
      cloudProvisionedContainer: firstRunCloudProvisionedContainer,
    },
    setStep: setSetupStep,
    setMode: setFirstRunMode,
    setActiveGuide: setFirstRunActiveGuide,
    addDeferredTask: addDeferredFirstRunTask,
    setOptions: setFirstRunOptions,
    setDetectedProviders: setFirstRunDetectedProviders,
    completionCommittedRef: firstRunCompletionCommittedRefFromHook,
    forceLocalBootstrapRef: forceLocalBootstrapRefFromHook,
  } = firstRun;

  const {
    firstRunRemoteConnecting,
    firstRunRemoteError,
    firstRunRemoteConnected,
    firstRunTelegramToken,
    firstRunDiscordToken,
    firstRunWhatsAppSessionPath,
    firstRunTwilioAccountSid,
    firstRunTwilioAuthToken,
    firstRunTwilioPhoneNumber,
    firstRunBlooioApiKey,
    firstRunBlooioPhoneNumber,
    firstRunGithubToken,
    setFirstRunName,
    setFirstRunOwnerName,
    setFirstRunStyle,
    setFirstRunRuntimeTarget,
    setFirstRunCloudApiKey,
    setFirstRunSmallModel,
    setFirstRunLargeModel,
    setFirstRunProvider,
    setFirstRunApiKey,
    setFirstRunVoiceProvider,
    setFirstRunVoiceApiKey,
    setFirstRunExistingInstallDetected,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteToken,
    setFirstRunRemoteConnecting,
    setFirstRunRemoteError,
    setFirstRunRemoteConnected,
    setFirstRunOpenRouterModel,
    setFirstRunPrimaryModel,
    setFirstRunTelegramToken,
    setFirstRunDiscordToken,
    setFirstRunWhatsAppSessionPath,
    setFirstRunTwilioAccountSid,
    setFirstRunTwilioAuthToken,
    setFirstRunTwilioPhoneNumber,
    setFirstRunBlooioApiKey,
    setFirstRunBlooioPhoneNumber,
    setFirstRunGithubToken,
    setFirstRunSubscriptionTab,
    setFirstRunElizaCloudTab,
    setFirstRunSelectedChains,
    setFirstRunRpcSelections,
    setFirstRunRpcKeys,
    setSetupAvatar,
    setFirstRunFeatureTelegram,
    setFirstRunFeatureDiscord,
    setFirstRunFeaturePhone,
    setFirstRunFeatureCrypto,
    setFirstRunFeatureBrowser,
    setFirstRunFeatureComputerUse,
    setFirstRunFeatureOAuthPending,
    setFirstRunCloudProvisionedContainer,
    setPostFirstRunChecklistDismissed,
    setFirstRunDeferredTasks,
  } = useMemo(() => {
    const {
      dispatch,
      setConnectorToken,
      setDeferredTasks,
      setField,
      setRemoteStatus,
    } = firstRun;
    const { connectorTokens, remote } = firstRun.state;
    const bindField =
      (field: string) =>
      (value: unknown): void => {
        setField(field, value);
      };
    const bindConnectorToken =
      (key: keyof typeof connectorTokens) =>
      (value: string): void => {
        setConnectorToken(key, value);
      };
    return {
      firstRunRemoteConnecting: remote.status === "connecting",
      firstRunRemoteError: remote.error,
      firstRunRemoteConnected: remote.status === "connected",
      firstRunTelegramToken: connectorTokens.telegramToken,
      firstRunDiscordToken: connectorTokens.discordToken,
      firstRunWhatsAppSessionPath: connectorTokens.whatsAppSessionPath,
      firstRunTwilioAccountSid: connectorTokens.twilioAccountSid,
      firstRunTwilioAuthToken: connectorTokens.twilioAuthToken,
      firstRunTwilioPhoneNumber: connectorTokens.twilioPhoneNumber,
      firstRunBlooioApiKey: connectorTokens.blooioApiKey,
      firstRunBlooioPhoneNumber: connectorTokens.blooioPhoneNumber,
      firstRunGithubToken: connectorTokens.githubToken,
      setFirstRunName: bindField("name") as (value: string) => void,
      setFirstRunOwnerName: bindField("ownerName") as (value: string) => void,
      setFirstRunStyle: bindField("style") as (value: string) => void,
      setFirstRunRuntimeTarget: bindField("serverTarget") as (
        value: FirstRunRuntimeTarget,
      ) => void,
      setFirstRunCloudApiKey: bindField("cloudApiKey") as (
        value: string,
      ) => void,
      setFirstRunSmallModel: bindField("smallModel") as (value: string) => void,
      setFirstRunLargeModel: bindField("largeModel") as (value: string) => void,
      setFirstRunProvider: bindField("provider") as (value: string) => void,
      setFirstRunApiKey: bindField("apiKey") as (value: string) => void,
      setFirstRunVoiceProvider: bindField("voiceProvider") as (
        value: string,
      ) => void,
      setFirstRunVoiceApiKey: bindField("voiceApiKey") as (
        value: string,
      ) => void,
      setFirstRunExistingInstallDetected: bindField(
        "existingInstallDetected",
      ) as (value: boolean) => void,
      setFirstRunRemoteApiBase: (value: string): void => {
        dispatch({ type: "SET_REMOTE_API_BASE", value });
      },
      setFirstRunRemoteToken: (value: string): void => {
        dispatch({ type: "SET_REMOTE_TOKEN", value });
      },
      setFirstRunRemoteConnecting: (value: boolean): void => {
        if (value) {
          setRemoteStatus("connecting");
          return;
        }
        if (remote.status === "connecting") {
          setRemoteStatus("idle");
        }
      },
      setFirstRunRemoteError: (value: string | null): void => {
        if (value) {
          setRemoteStatus("error", value);
          return;
        }
        if (remote.status === "error") {
          setRemoteStatus("idle");
        }
      },
      setFirstRunRemoteConnected: (value: boolean): void => {
        if (value) {
          setRemoteStatus("connected");
          return;
        }
        if (remote.status === "connected") {
          setRemoteStatus("idle");
        }
      },
      setFirstRunOpenRouterModel: bindField("openRouterModel") as (
        value: string,
      ) => void,
      setFirstRunPrimaryModel: bindField("primaryModel") as (
        value: string,
      ) => void,
      setFirstRunTelegramToken: bindConnectorToken("telegramToken"),
      setFirstRunDiscordToken: bindConnectorToken("discordToken"),
      setFirstRunWhatsAppSessionPath: bindConnectorToken("whatsAppSessionPath"),
      setFirstRunTwilioAccountSid: bindConnectorToken("twilioAccountSid"),
      setFirstRunTwilioAuthToken: bindConnectorToken("twilioAuthToken"),
      setFirstRunTwilioPhoneNumber: bindConnectorToken("twilioPhoneNumber"),
      setFirstRunBlooioApiKey: bindConnectorToken("blooioApiKey"),
      setFirstRunBlooioPhoneNumber: bindConnectorToken("blooioPhoneNumber"),
      setFirstRunGithubToken: bindConnectorToken("githubToken"),
      setFirstRunSubscriptionTab: bindField("subscriptionTab") as (
        value: "token" | "oauth",
      ) => void,
      setFirstRunElizaCloudTab: bindField("elizaCloudTab") as (
        value: "login" | "apikey",
      ) => void,
      setFirstRunSelectedChains: bindField("selectedChains") as (
        value: Set<string>,
      ) => void,
      setFirstRunRpcSelections: bindField("rpcSelections") as (
        value: Record<string, string>,
      ) => void,
      setFirstRunRpcKeys: bindField("rpcKeys") as (
        value: Record<string, string>,
      ) => void,
      setSetupAvatar: bindField("avatar") as (value: number) => void,
      setFirstRunFeatureTelegram: bindField("featureTelegram") as (
        value: boolean,
      ) => void,
      setFirstRunFeatureDiscord: bindField("featureDiscord") as (
        value: boolean,
      ) => void,
      setFirstRunFeaturePhone: bindField("featurePhone") as (
        value: boolean,
      ) => void,
      setFirstRunFeatureCrypto: bindField("featureCrypto") as (
        value: boolean,
      ) => void,
      setFirstRunFeatureBrowser: bindField("featureBrowser") as (
        value: boolean,
      ) => void,
      setFirstRunFeatureComputerUse: bindField("featureComputerUse") as (
        value: boolean,
      ) => void,
      setFirstRunFeatureOAuthPending: bindField("featureOAuthPending") as (
        value: string | null,
      ) => void,
      setFirstRunCloudProvisionedContainer: bindField(
        "cloudProvisionedContainer",
      ) as (value: boolean) => void,
      setPostFirstRunChecklistDismissed: (value: boolean): void => {
        dispatch({ type: "SET_POST_CHECKLIST_DISMISSED", value });
      },
      setFirstRunDeferredTasks: (tasks: string[]): void => {
        setDeferredTasks(tasks);
      },
    };
  }, [firstRun]);

  // startupStatus is now derived in useLifecycleState

  // --- Command palette / emote picker / MCP / game / dropped files (extracted to useMiscUiState) ---
  const miscUiHook = useMiscUiState();
  const {
    state: {
      analysisMode,
      commandPaletteOpen,
      commandQuery,
      commandActiveIndex,
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
      appRuns,
      activeGameRunId,
      activeGameApp,
      activeGameDisplayName,
      activeGameViewerUrl,
      activeGameSandbox,
      activeGamePostMessageAuth,
      activeGamePostMessagePayload,
      activeGameSession,
      gameOverlayEnabled,
      companionAppRunning,
      activeOverlayApp,
      activeInboxChat,
      activeTerminalSessionId,
    },
    setActiveInboxChat,
    setActiveTerminalSessionId,
    setAnalysisMode,
    setCommandQuery,
    setCommandActiveIndex,
    setEmotePickerOpen,
    setMcpConfiguredServers,
    setMcpServerStatuses,
    setMcpMarketplaceQuery,
    setMcpMarketplaceResults,
    setMcpMarketplaceLoading,
    setMcpAction,
    setMcpAddingServer,
    setMcpAddingResult,
    setMcpEnvInputs,
    setMcpHeaderInputs,
    setDroppedFiles,
    setShareIngestNotice,
    setAppRuns,
    setActiveGameRunId,
    setGameOverlayEnabled,
    setActiveOverlayApp,
    closeCommandPalette,
    openEmotePicker,
    closeEmotePicker,
  } = miscUiHook;

  // chatPendingImages now comes from useChatState

  // --- Refs for timers ---
  // actionNoticeTimer, shownOnceNotices, agentStatusRef, lifecycleBusyRef,
  // lifecycleActionRef, setAgentStatusIfChanged are now in useLifecycleState
  // elizaCloudPollInterval, elizaCloudDisconnectInFlightRef,
  // elizaCloudPreferDisconnectedUntilLoginRef, lastElizaCloudPollConnectedRef,
  // elizaCloudLoginPollTimer are now in useCloudState (cloudHook)
  const _restartNotificationSignatureRef = useRef<string | null>(null);
  const _heartbeatNotificationKeyRef = useRef<string | null>(null);
  // First-run refs now come from useFirstRunState
  const firstRunCompletionCommittedRef = firstRunCompletionCommittedRefFromHook;
  const forceLocalBootstrapRef = forceLocalBootstrapRefFromHook;
  // exportBusyRef and importBusyRef are now managed inside useExportImportState (exportImportHook)
  // walletApiKeySavingRef is now managed inside useWalletState (walletHook)
  // elizaCloudLoginBusyRef, elizaCloudAuthNoticeSentRef, handleCloudLoginRef
  // are now managed inside useCloudState (cloudHook)

  // --- Confirm Modal ---
  const { modalProps } = useConfirm();
  const { prompt: promptModal, modalProps: promptModalProps } = usePrompt();

  // --- Wallet / Inventory / Registry / Drop / Whitelist (extracted to useWalletState) ---
  // Placed after characterHook (characterDraft) and promptModal — both are required params.
  const walletHook = useWalletState({
    setActionNotice,
    promptModal,
    agentName: agentStatus?.agentName,
    characterName: characterDraft?.name,
  });
  const {
    state: {
      browserEnabled,
      computerUseEnabled,
      walletEnabled,
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
      inventorySortDirection,
      inventoryChainFilters,
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
      wallets,
      walletPrimary,
      walletPrimaryRestarting,
      walletPrimaryPending,
      cloudRefreshing,
    },
    setBrowserEnabled,
    setComputerUseEnabled,
    setWalletEnabled,
    setWalletAddresses,
    setInventoryView,
    setInventorySort,
    setInventorySortDirection,
    setInventoryChainFilters,
    loadWalletConfig,
    loadBalances,
    loadNfts,
    handleWalletApiKeySave,
    handleExportKeys,
    loadRegistryStatus,
    registerOnChain,
    syncRegistryProfile,
    loadDropStatus,
    mintFromDrop,
    loadWhitelistStatus,
    setPrimary: setWalletPrimary,
    refreshCloud: refreshCloudWallets,
  } = walletHook;

  // setActionNotice is now provided by useLifecycleState

  // ── Cloud state (extracted to useCloudState) ───────────────────────
  // Placed after walletHook so loadWalletConfig is available.
  const cloudHook = useCloudState({
    setActionNotice,
    loadWalletConfig,
    t,
    disconnectLocked: brandingOverride?.cloudOnly === true,
  });

  // ── Vincent state (extracted to useVincentState) ──────────────────
  const vincentHook = useVincentState({ setActionNotice, t });
  const {
    vincentConnected,
    vincentLoginBusy,
    vincentLoginError,
    handleVincentLogin,
    handleVincentDisconnect,
  } = vincentHook;
  const {
    elizaCloudEnabled,
    setElizaCloudEnabled,
    elizaCloudVoiceProxyAvailable,
    setElizaCloudVoiceProxyAvailable,
    elizaCloudConnected,
    setElizaCloudConnected,
    elizaCloudHasPersistedKey,
    setElizaCloudHasPersistedKey,
    elizaCloudCredits,
    setElizaCloudCredits,
    elizaCloudCreditsLow,
    setElizaCloudCreditsLow,
    elizaCloudCreditsCritical,
    setElizaCloudCreditsCritical,
    elizaCloudAuthRejected,
    setElizaCloudAuthRejected,
    elizaCloudCreditsError,
    setElizaCloudCreditsError,
    elizaCloudTopUpUrl,
    setElizaCloudTopUpUrl,
    elizaCloudUserId,
    setElizaCloudUserId,
    elizaCloudStatusReason,
    setElizaCloudStatusReason,
    cloudDashboardView,
    setCloudDashboardView,
    elizaCloudLoginBusy,
    elizaCloudLoginError,
    setElizaCloudLoginError,
    elizaCloudLoginFallbackUrl,
    elizaCloudDisconnecting,
    elizaCloudPollInterval,
    elizaCloudPreferDisconnectedUntilLoginRef,
    elizaCloudLoginPollTimer,
    pollCloudCredits,
    handleCloudLogin,
    handleCloudDisconnect,
  } = cloudHook;

  // ── Clipboard ──────────────────────────────────────────────────────

  const copyToClipboard = useCallback(async (text: string) => {
    await copyTextToClipboard(text);
  }, []);

  // Language is managed by TranslationProvider (see useTranslation() above)

  // ── Navigation (extracted to useNavigationState) ──────────────────
  const navHook = useNavigationState({
    tab,
    setTabRaw,
    uiShellMode,
    hasActiveGameRun: activeGameRunId.trim().length > 0,
    setAppsSubTab,
  });
  const {
    setTab,
    setUiShellMode,
    switchUiShellMode,
    switchShellView,
    navigation,
  } = navHook;

  useNavigationPathSync({ tab, setTabRaw });

  // loadLogs is now in useLogsState (logsHook)

  // ── Data loading (extracted to useDataLoaders) ────────────────────
  const dataLoaders = useDataLoaders({
    autonomousStoreRef,
    autonomousEventsRef,
    autonomousLatestEventIdRef,
    autonomousRunHealthByRunIdRef,
    autonomousReplayInFlightRef,
    setAutonomousEvents,
    setAutonomousLatestEventId,
    setAutonomousRunHealthByRunId,
    activeConversationIdRef,
    conversationMessagesRef,
    greetingFiredRef,
    setConversations,
    setActiveConversationId,
    setConversationMessages,
    loadWalletConfig,
    agentStatus,
    characterData,
    characterDraft,
    loadCharacter,
    selectedVrmIndex,
    firstRunComplete,
    uiLanguage,
    setOwnerNameState,
  });
  const {
    fetchAutonomyReplay,
    appendAutonomousEvent,
    loadConversations,
    loadConversationMessages,
    getBscTradePreflight,
    getBscTradeQuote,
    getBscTradeTxStatus,
    getStewardStatus,
    getStewardAddresses,
    getStewardBalance,
    getStewardTokens,
    getStewardWebhookEvents,
    getStewardHistory,
    getStewardPending,
    approveStewardTx,
    rejectStewardTx,
    loadWalletTradingProfile,
    executeBscTrade,
    executeBscTransfer,
    loadInventory,
    workbenchLoading,
    workbench,
    workbenchTasksAvailable,
    workbenchTriggersAvailable,
    workbenchTodosAvailable,
    loadWorkbench,
    updateStatus,
    updateLoading,
    updateChannelSaving,
    loadUpdateStatus,
    handleChannelChange,
    extensionStatus,
    extensionChecking,
    checkExtensionStatus,
  } = dataLoaders;

  // pollCloudCredits is now provided by useCloudState (cloudHook — wired below)

  // ── Lifecycle actions ──────────────────────────────────────────────

  // beginLifecycleAction / finishLifecycleAction are now provided by useLifecycleState

  // ── Chat callbacks (extracted to useChatCallbacks) ──────────────────
  const chatCallbacks = useChatCallbacks({
    t,
    uiLanguage,
    uiShellMode,
    tab,
    agentStatus,
    chatInput,
    conversations,
    activeConversationId,
    companionMessageCutoffTs,
    conversationMessages,
    ptySessions,
    setChatInput,
    setChatSending,
    setChatFirstTokenReceived,
    setChatLastUsage,
    setChatPendingImages,
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs,
    setConversationMessages,
    setUnreadConversations,
    resetConversationDraftState,
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    conversationsRef,
    conversationMessagesRef,
    conversationHydrationEpochRef,
    chatAbortRef,
    chatSendBusyRef,
    chatSendNonceRef,
    greetingFiredRef,
    greetingInFlightConversationRef,
    companionStaleConversationRefreshRef,
    lifecycleAction,
    beginLifecycleAction,
    finishLifecycleAction,
    lifecycleBusyRef,
    lifecycleActionRef,
    setAgentStatus,
    setActionNotice,
    pendingRestart,
    pendingRestartReasons,
    setPendingRestart,
    setPendingRestartReasons,
    setBackendDisconnectedBannerDismissed,
    resetBackendConnection,
    loadConversations,
    loadConversationMessages,
    loadPlugins,
    elizaCloudEnabled,
    elizaCloudConnected,
    pollCloudCredits,
    elizaCloudPreferDisconnectedUntilLoginRef,
    setElizaCloudEnabled,
    setElizaCloudConnected,
    setElizaCloudVoiceProxyAvailable,
    setElizaCloudHasPersistedKey,
    setElizaCloudCredits,
    setElizaCloudCreditsLow,
    setElizaCloudCreditsCritical,
    setElizaCloudAuthRejected,
    setElizaCloudCreditsError,
    setElizaCloudTopUpUrl,
    setElizaCloudUserId,
    setElizaCloudStatusReason,
    setElizaCloudLoginError,
    firstRunCompletionCommittedRef,
    setFirstRunUiRevealNonce,
    setFirstRunLoading,
    setFirstRunComplete,
    setSetupStep,
    setFirstRunMode,
    setFirstRunActiveGuide,
    setFirstRunDeferredTasks,
    setPostFirstRunChecklistDismissed,
    setFirstRunName,
    setFirstRunStyle,
    setFirstRunRuntimeTarget,
    setFirstRunProvider,
    setFirstRunApiKey,
    setFirstRunVoiceProvider: setFirstRunVoiceProvider as (v: string) => void,
    setFirstRunVoiceApiKey: setFirstRunVoiceApiKey as (v: string) => void,
    setFirstRunPrimaryModel,
    setFirstRunOpenRouterModel,
    setFirstRunRemoteConnected,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteToken,
    setFirstRunSmallModel,
    setFirstRunLargeModel,
    setFirstRunOptions,
    setSelectedVrmIndex,
    setCustomVrmUrl,
    setCustomBackgroundUrl,
    setPlugins: setPlugins as (v: never[]) => void,
    setSkills: setSkills as (v: never[]) => void,
    setLogs: setLogs as (v: never[]) => void,
    coordinatorResetRef,
  });
  const {
    fetchGreeting,
    requestGreetingWhenRunning,
    hydrateInitialConversationState,
    handleStartDraftConversation,
    handleStart,
    handleStop,
    handleRestart,
    triggerRestart,
    retryBackendConnection,
    restartBackend,
    relaunchDesktop,
    notifyAssistantEvent,
    notifyHeartbeatEvent,
    handleResetAppliedFromMain,
    handleReset,
    handleNewConversation,
    sendChatText,
    handleChatSend,
    sendActionMessage,
    handleChatStop,
    handleChatRetry,
    handleChatEdit,
    handleChatClear,
    handleSelectConversation,
    handleDeleteConversation,
    handleRenameConversation,
    suggestConversationTitle,
  } = chatCallbacks;

  useEffect(() => {
    triggerRestartRef.current = triggerRestart;
  }, [triggerRestart]);

  // ── Pairing ────────────────────────────────────────────────────────

  // ── Plugin / Skill / Store / Catalog actions are provided by usePluginsSkillsState (pluginsSkillsHook) ──
  // ── Inventory / Registry / Drop / Whitelist actions are provided by useWalletState (walletHook) ──
  // ── Character actions are provided by useCharacterState (characterHook) ──

  // ── First-run callbacks (extracted to useFirstRunCallbacks) ──────
  const firstRunCallbacks = useFirstRunCallbacks({
    firstRun,
    setActiveOverlayApp,
    setSetupStep,
    setFirstRunMode,
    setFirstRunActiveGuide,
    addDeferredFirstRunTask: addDeferredFirstRunTask,
    setFirstRunDetectedProviders,
    setFirstRunRuntimeTarget,
    setFirstRunCloudApiKey,
    setFirstRunProvider,
    setFirstRunApiKey,
    setFirstRunPrimaryModel,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteToken,
    setFirstRunRemoteConnecting,
    setFirstRunRemoteError,
    setFirstRunRemoteConnected,
    setPostFirstRunChecklistDismissed,
    setBrowserEnabled,
    setComputerUseEnabled,
    setFirstRunComplete,
    coordinatorFirstRunCompleteRef,
    initialTabSetRef,
    setTab,
    defaultLandingTab: DEFAULT_LANDING_TAB,
    loadCharacter,
    uiLanguage,
    selectedVrmIndex,
    walletConfig,
    elizaCloudConnected,
    setActionNotice,
    retryStartup,
    setWalletEnabled,
    forceLocalBootstrapRef,
    client,
  });
  const {
    handleFirstRunNext,
    handleFirstRunBack,
    handleFirstRunJumpToStep,
    goToFirstRunStep,
    handleFirstRunRemoteConnect,
    handleFirstRunUseLocalBackend,
    handleCloudFirstRunFinish,
    applyDetectedProviders,
    completeFirstRun,
  } = firstRunCallbacks;

  // handleAgentExport and handleAgentImport are now in useExportImportState (exportImportHook)

  // closeCommandPalette, openEmotePicker, closeEmotePicker are now in useMiscUiState (miscUiHook)

  // ── Generic state setter ───────────────────────────────────────────

  const setState = useCallback(
    <K extends keyof AppState>(key: K, value: AppState[K]) => {
      const setterMap: Partial<{
        [S in keyof AppState]: (v: AppState[S]) => void;
      }> = {
        tab: setTab,
        setupStep: setSetupStep,
        chatInput: setChatInput,
        chatAvatarVisible: setChatAvatarVisible,
        chatAgentVoiceMuted: setChatAgentVoiceMuted,
        chatLastUsage: setChatLastUsage,
        chatAvatarSpeaking: setChatAvatarSpeaking,
        companionMessageCutoffTs: setCompanionMessageCutoffTs,
        uiShellMode: setUiShellMode,
        uiLanguage: setUiLanguage as (v: AppState["uiLanguage"]) => void,
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
        browserEnabled: setBrowserEnabled,
        computerUseEnabled: setComputerUseEnabled,
        walletEnabled: setWalletEnabled,
        inventoryView: setInventoryView,
        inventorySort: setInventorySort,
        inventorySortDirection: setInventorySortDirection,
        inventoryChainFilters: setInventoryChainFilters,
        exportPassword: setExportPassword,
        exportIncludeLogs: setExportIncludeLogs,
        exportError: setExportError,
        exportSuccess: setExportSuccess,
        importPassword: setImportPassword,
        importFile: setImportFile,
        importError: setImportError,
        importSuccess: setImportSuccess,
        firstRunName: setFirstRunName,
        firstRunOwnerName: setFirstRunOwnerName,
        firstRunStyle: setFirstRunStyle,
        firstRunRuntimeTarget: setFirstRunRuntimeTarget,
        firstRunCloudApiKey: setFirstRunCloudApiKey,
        firstRunSmallModel: setFirstRunSmallModel,
        firstRunLargeModel: setFirstRunLargeModel,
        firstRunProvider: setFirstRunProvider,
        firstRunApiKey: setFirstRunApiKey,
        firstRunVoiceProvider: setFirstRunVoiceProvider,
        firstRunVoiceApiKey: setFirstRunVoiceApiKey,
        firstRunExistingInstallDetected: setFirstRunExistingInstallDetected,
        firstRunDetectedProviders: setFirstRunDetectedProviders,
        firstRunRemoteApiBase: setFirstRunRemoteApiBase,
        firstRunRemoteToken: setFirstRunRemoteToken,
        firstRunRemoteConnecting: setFirstRunRemoteConnecting,
        firstRunRemoteError: setFirstRunRemoteError,
        firstRunRemoteConnected: setFirstRunRemoteConnected,
        firstRunSelectedChains: setFirstRunSelectedChains,
        firstRunRpcSelections: setFirstRunRpcSelections,
        firstRunOpenRouterModel: setFirstRunOpenRouterModel,
        firstRunPrimaryModel: setFirstRunPrimaryModel,
        firstRunTelegramToken: setFirstRunTelegramToken,
        firstRunDiscordToken: setFirstRunDiscordToken,
        firstRunWhatsAppSessionPath: setFirstRunWhatsAppSessionPath,
        firstRunTwilioAccountSid: setFirstRunTwilioAccountSid,
        firstRunTwilioAuthToken: setFirstRunTwilioAuthToken,
        firstRunTwilioPhoneNumber: setFirstRunTwilioPhoneNumber,
        firstRunBlooioApiKey: setFirstRunBlooioApiKey,
        firstRunBlooioPhoneNumber: setFirstRunBlooioPhoneNumber,
        firstRunGithubToken: setFirstRunGithubToken,
        firstRunSubscriptionTab: setFirstRunSubscriptionTab,
        firstRunElizaCloudTab: setFirstRunElizaCloudTab,
        firstRunRpcKeys: setFirstRunRpcKeys,
        setupAvatar: setSetupAvatar,
        firstRunFeatureTelegram: setFirstRunFeatureTelegram,
        firstRunFeatureDiscord: setFirstRunFeatureDiscord,
        firstRunFeaturePhone: setFirstRunFeaturePhone,
        firstRunFeatureCrypto: setFirstRunFeatureCrypto,
        firstRunFeatureBrowser: setFirstRunFeatureBrowser,
        firstRunFeatureComputerUse: setFirstRunFeatureComputerUse,
        firstRunFeatureOAuthPending: setFirstRunFeatureOAuthPending,
        elizaCloudEnabled: setElizaCloudEnabled,
        elizaCloudVoiceProxyAvailable: setElizaCloudVoiceProxyAvailable,
        cloudDashboardView: setCloudDashboardView,
        selectedVrmIndex: setSelectedVrmIndex,
        customVrmUrl: setCustomVrmUrl,
        customVrmPreviewUrl: setCustomVrmPreviewUrl,
        customBackgroundUrl: setCustomBackgroundUrl,
        customCatchphrase: setCustomCatchphrase,
        customVoicePresetId: setCustomVoicePresetId,
        activePackId: setActivePackId,
        customWorldUrl: setCustomWorldUrl,
        commandQuery: setCommandQuery,
        commandActiveIndex: setCommandActiveIndex,
        emotePickerOpen: setEmotePickerOpen,
        analysisMode: setAnalysisMode,
        storeSearch: setStoreSearch,
        storeFilter: setStoreFilter,
        storeSubTab: setStoreSubTab,
        catalogSearch: setCatalogSearch,
        catalogSort: setCatalogSort,
        catalogPage: setCatalogPage,
        skillReviewId: setSkillReviewId,
        skillReviewReport: setSkillReviewReport,
        appRuns: setAppRuns,
        activeGameRunId: setActiveGameRunId,
        gameOverlayEnabled: setGameOverlayEnabled,
        companionAppRunning: (v: boolean) =>
          setActiveOverlayApp(v ? "@elizaos/plugin-companion" : null),
        activeOverlayApp: setActiveOverlayApp,
        activeInboxChat: setActiveInboxChat,
        activeTerminalSessionId: setActiveTerminalSessionId,
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
        favoriteApps: setFavoriteApps,
        recentApps: setRecentApps,
        configRaw: setConfigRaw,
        configText: setConfigText,
        firstRunComplete: setFirstRunComplete,
      };
      const setter = setterMap[key];
      if (setter) setter(value);
    },
    [
      setSetupStep,
      setSelectedVrmIndex,
      setUiLanguage,
      setUiShellMode,
      setAutonomousRunHealthByRunId,
      setChatAgentVoiceMuted,
      setChatAvatarSpeaking,
      setChatAvatarVisible,
      setChatInput,
      setChatLastUsage,
      setCompanionMessageCutoffTs,
      setFirstRunApiKey,
      setSetupAvatar,
      setFirstRunBlooioApiKey,
      setFirstRunBlooioPhoneNumber,
      setFirstRunRuntimeTarget,
      setFirstRunDetectedProviders,
      setFirstRunDiscordToken,
      setFirstRunElizaCloudTab,
      setFirstRunExistingInstallDetected,
      setFirstRunGithubToken,
      setFirstRunLargeModel,
      setFirstRunName,
      setFirstRunOpenRouterModel,
      setFirstRunOwnerName,
      setFirstRunPrimaryModel,
      setFirstRunProvider,
      setFirstRunRemoteApiBase,
      setFirstRunRemoteConnected,
      setFirstRunRemoteConnecting,
      setFirstRunRemoteError,
      setFirstRunRemoteToken,
      setFirstRunRpcKeys,
      setFirstRunRpcSelections,
      setFirstRunSelectedChains,
      setFirstRunSmallModel,
      setFirstRunStyle,
      setFirstRunSubscriptionTab,
      setFirstRunTelegramToken,
      setFirstRunTwilioAccountSid,
      setFirstRunTwilioAuthToken,
      setFirstRunTwilioPhoneNumber,
      setFirstRunWhatsAppSessionPath,
      setFirstRunComplete,
      setStartupError,
      setFavoriteApps,
      setTab,
      setStoreUninstalling,
      setStoreSubTab,
      setCatalogSort,
      setCatalogTotal,
      setActiveOverlayApp,
      setCatalogUninstalling,
      setCloudDashboardView,
      setCommandActiveIndex,
      setCommandQuery,
      setComputerUseEnabled,
      setCustomBackgroundUrl,
      setCustomCatchphrase,
      setCustomVoicePresetId,
      setCustomVrmPreviewUrl,
      setCustomVrmUrl,
      setCustomWorldUrl,
      setDroppedFiles,
      setElizaCloudEnabled,
      setElizaCloudVoiceProxyAvailable,
      setEmotePickerOpen,
      setExportError,
      setExportIncludeLogs,
      setExportPassword,
      setExportSuccess,
      setGameOverlayEnabled,
      setImportError,
      setImportFile,
      setImportPassword,
      setImportSuccess,
      setInventoryChainFilters,
      setInventorySort,
      setInventorySortDirection,
      setInventoryView,
      setLogLevelFilter,
      setLogSourceFilter,
      setLogTagFilter,
      setMcpAction,
      setMcpAddingResult,
      setMcpAddingServer,
      setMcpConfiguredServers,
      setMcpEnvInputs,
      setMcpHeaderInputs,
      setMcpMarketplaceLoading,
      setMcpMarketplaceQuery,
      setMcpMarketplaceResults,
      setMcpServerStatuses,
      setFirstRunCloudApiKey,
      setFirstRunFeatureBrowser,
      setFirstRunFeatureComputerUse,
      setFirstRunFeatureCrypto,
      setFirstRunFeatureDiscord,
      setFirstRunFeatureOAuthPending,
      setFirstRunFeaturePhone,
      setFirstRunFeatureTelegram,
      setFirstRunVoiceApiKey,
      setFirstRunVoiceProvider,
      setPairingCodeInput,
      setPluginAdvancedOpen,
      setPluginFilter,
      setPluginSearch,
      setPluginSettingsOpen,
      setPluginStatusFilter,
      setShareIngestNotice,
      setSkillCreateDescription,
      setSkillCreateFormOpen,
      setSkillCreateName,
      setSkillReviewId,
      setSkillReviewReport,
      setSkillsMarketplaceManualGithubUrl,
      setSkillsMarketplaceQuery,
      setSkillsSubTab,
      setStoreDetailPlugin,
      setStoreError,
      setStoreFilter,
      setStoreInstalling,
      setStoreLoading,
      setStorePlugins,
      setStoreSearch,
      setCatalogTotalPages,
      setWalletEnabled,
      setCatalogSkills,
      setCatalogSearch,
      setCatalogPage,
      setCatalogLoading,
      setCatalogInstalling,
      setBrowserEnabled,
      setCatalogError,
      setAppsSubTab,
      setActiveInboxChat,
      setCatalogDetailSkill,
      setAppRuns,
      setActivePackId,
      setActiveGameRunId,
      setActiveTerminalSessionId,
      setAnalysisMode,
      setRecentApps,
      setConfigRaw,
      setPluginsSubTab,
      setDatabaseSubTab,
      setConfigText,
      setAgentSubTab,
    ],
  );

  const requestGreetingWhenRunningRef = useRef(requestGreetingWhenRunning);
  useEffect(() => {
    requestGreetingWhenRunningRef.current = requestGreetingWhenRunning;
  }, [requestGreetingWhenRunning]);

  useBackendConnectionSync({ setBackendConnection });

  // Passed to the startup coordinator so the PTY poll interval can skip API
  // calls when no sessions are active.
  const hasPtySessionsRef = useRef(ptySessions.length > 0);
  hasPtySessionsRef.current = ptySessions.length > 0;

  // ── StartupCoordinator (sole startup authority) ──────────────────────
  // Called after all dependency hooks so every setter/callback is available.
  const startupCoordinator = useStartupCoordinator({
    setConnected,
    setAgentStatus,
    setAgentStatusIfChanged,
    setStartupPhase,
    setStartupError,
    setAuthRequired,
    setFirstRunComplete,
    setFirstRunLoading,
    setPendingRestart,
    setPendingRestartReasons,
    setSystemWarnings,
    showRestartBanner,
    setPairingEnabled,
    setPairingExpiresAt,
    setFirstRunOptions,
    setFirstRunExistingInstallDetected,
    setSetupStep,
    setFirstRunRuntimeTarget,
    setFirstRunCloudApiKey,
    setFirstRunProvider,
    setFirstRunVoiceProvider,
    setFirstRunApiKey,
    setFirstRunPrimaryModel,
    setFirstRunOpenRouterModel,
    setFirstRunRemoteConnected,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteToken,
    setFirstRunSmallModel,
    setFirstRunLargeModel,
    setFirstRunCloudProvisionedContainer,
    applyDetectedProviders,
    hydrateInitialConversationState,
    loadWorkbench,
    loadPlugins,
    loadSkills,
    loadCharacter,
    loadWalletConfig,
    loadInventory,
    loadUpdateStatus,
    checkExtensionStatus,
    pollCloudCredits,
    fetchAutonomyReplay,
    appendAutonomousEvent,
    notifyAssistantEvent,
    notifyHeartbeatEvent,
    setSelectedVrmIndex,
    setCustomVrmUrl,
    setCustomBackgroundUrl,
    setWalletAddresses,
    setPtySessions,
    hasPtySessionsRef,
    setTab,
    setTabRaw,
    setConversationMessages,
    setUnreadConversations,
    setConversations,
    requestGreetingWhenRunningRef,
    firstRunCompletionCommittedRef,
    forceLocalBootstrapRef,
    initialTabSetRef,
    activeConversationIdRef,
    elizaCloudPollInterval,
    elizaCloudLoginPollTimer,
    uiLanguage,
    firstRunMode,
  });

  // Wire coordinator refs so callbacks defined before the coordinator can reach it
  coordinatorRetryRef.current = startupCoordinator.retry;
  coordinatorResetRef.current = startupCoordinator.reset;
  coordinatorFirstRunCompleteRef.current = startupCoordinator.firstRunComplete;

  // Memoize the coordinator handle so that unrelated re-renders (e.g. chatInput
  // keystrokes) don't produce a new object reference and bust the value useMemo below.
  // The coordinator's computed fields (legacyPhase, loading, terminal, target, phase)
  // all derive from its reducer state, so state is the only dep we need.
  // biome-ignore lint/correctness/useExhaustiveDependencies: coordinator fields all derive from state
  const stableStartupCoordinator = useMemo(
    () => startupCoordinator as AppContextValue["startupCoordinator"],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [startupCoordinator.state],
  );

  const switchAgentProfile = useCallback(
    (profileId: string) => {
      const profile = loadAgentProfileRegistry().profiles.find(
        (p) => p.id === profileId,
      );
      if (!profile) return;

      setActiveProfileId(profileId);

      // Conversation ids are per-account, so saved drafts from the old
      // profile would re-attach to whatever conversation happens to land
      // on the same id after the switch. Wipe them.
      clearAllChatDrafts();

      const server = createPersistedActiveServer({
        kind: profile.kind,
        apiBase: profile.apiBase,
        accessToken: profile.accessToken,
        label: profile.label,
      });
      savePersistedActiveServer(server);

      if (profile.apiBase) {
        client.setBaseUrl(profile.apiBase);
      }
      if (profile.accessToken) {
        client.setToken(profile.accessToken);
      }

      const target =
        profile.kind === "cloud"
          ? "cloud-managed"
          : profile.kind === "remote"
            ? "remote-backend"
            : "embedded-local";
      startupCoordinator.dispatch({
        type: "SWITCH_AGENT",
        target: target as RuntimeTarget,
      });
    },
    [startupCoordinator],
  );

  useAgentGreetingEffects({
    agentState: agentStatus?.state,
    loadWorkbench,
    activeConversationId,
    conversationMessages,
    chatSending,
    fetchGreeting,
    activeConversationIdRef,
    conversationMessagesRef,
    greetingFiredRef,
    greetingInFlightConversationRef,
  });

  // ── Capacitor app lifecycle (APP_RESUME / APP_PAUSE) ────────────────
  // Bridges native lifecycle events into the chat pipeline: aborts
  // in-flight streams before iOS suspends the process, persists the
  // active conversation id, and re-probes /api/health on resume so the
  // renderer notices a respawned FGS / dev server on a new port.
  useAppLifecycleEvents({
    activeConversationIdRef,
    conversationMessagesRef,
    chatAbortRef,
    setConversationMessages,
  });

  // ── Chat composer draft persistence ────────────────────────────────
  // Restores the textarea content when the user revisits a conversation
  // (a common mobile pattern: open the app, start typing, switch apps,
  // come back later). Drafts are scoped per conversation id and are
  // cleared after a successful send or when the user switches accounts.
  useChatComposerDraftPersistence({
    activeConversationId,
    chatInput,
    setChatInput,
  });

  // ── Context value ──────────────────────────────────────────────────

  // t is provided by TranslationContext (useTranslation() above)

  // Cloud auth-rejected effect is now inside useCloudState.

  const companionSceneConfig = useMemo(
    () => ({
      selectedVrmIndex,
      customVrmUrl,
      customWorldUrl,
      uiTheme,
      tab,
      companionVrmPowerMode,
      companionHalfFramerateMode,
      companionAnimateWhenHidden,
    }),
    [
      selectedVrmIndex,
      customVrmUrl,
      customWorldUrl,
      uiTheme,
      tab,
      companionVrmPowerMode,
      companionHalfFramerateMode,
      companionAnimateWhenHidden,
    ],
  );

  // chatInput/chatSending/chatPendingImages live in ChatComposerContext so that
  // keystrokes don't cascade through AppContext to all subscribers.
  const composerValue = useMemo(
    () => ({
      chatInput,
      chatSending,
      chatPendingImages,
      setChatInput,
      setChatPendingImages,
    }),
    [
      chatInput,
      chatSending,
      chatPendingImages,
      setChatInput,
      setChatPendingImages,
    ],
  );

  // ptySessions lives in PtySessionsContext so the 5-second poll doesn't
  // cascade through AppContext to all subscribers.
  const ptySessionsValue = useMemo(() => ({ ptySessions }), [ptySessions]);

  // The AppContext value is memoized and does NOT include chatInput/chatSending/
  // chatPendingImages (in ChatComposerCtx) or ptySessions (in PtySessionsCtx).
  // autonomousEvents/autonomousLatestEventId/autonomousRunHealthByRunId are also
  // excluded — they update on every heartbeat WS event but no component reads them
  // directly from useApp(). Excluding them prevents heartbeat events from re-rendering
  // all AppContext subscribers (CompanionViewOverlay, App, etc.).
  // NOTE: this dep array must stay in sync with the fields in the value object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value: AppContextValue = useMemo(
    () => ({
      // Translations
      t,
      // State
      tab,
      uiShellMode,
      uiLanguage,
      uiTheme,
      companionVrmPowerMode,
      companionAnimateWhenHidden,
      companionHalfFramerateMode,
      connected,
      agentStatus,
      firstRunComplete,
      firstRunUiRevealNonce,
      firstRunLoading,
      startupPhase,
      startupStatus,
      startupError,
      // StartupCoordinator — the sole startup authority
      startupCoordinator: stableStartupCoordinator,
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
      // chatInput/chatSending/chatPendingImages are stale here — read via useChatComposer()
      chatInput,
      chatSending,
      chatFirstTokenReceived,
      chatLastUsage,
      chatAvatarVisible,
      chatAgentVoiceMuted,
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
      triggersLoaded,
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
      logLoadError,
      browserEnabled,
      computerUseEnabled,
      walletEnabled,
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
      inventorySortDirection,
      inventoryChainFilters,
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
      wallets,
      walletPrimary,
      walletPrimaryRestarting,
      walletPrimaryPending,
      cloudRefreshing,
      setWalletPrimary,
      refreshCloudWallets,
      characterData,
      characterLoading,
      characterSaving,
      characterSaveSuccess,
      characterSaveError,
      characterDraft,
      selectedVrmIndex,
      customVrmUrl,
      customVrmPreviewUrl,
      customBackgroundUrl,
      customCatchphrase,
      customVoicePresetId,
      activePackId,
      customWorldUrl,
      elizaCloudEnabled,
      elizaCloudVoiceProxyAvailable,
      elizaCloudConnected,
      elizaCloudHasPersistedKey,
      elizaCloudCredits,
      elizaCloudCreditsLow,
      elizaCloudCreditsCritical,
      elizaCloudAuthRejected,
      elizaCloudCreditsError,
      elizaCloudTopUpUrl,
      elizaCloudUserId,
      elizaCloudStatusReason,
      ownerName,
      cloudDashboardView,
      elizaCloudLoginBusy,
      elizaCloudLoginError,
      elizaCloudLoginFallbackUrl,
      elizaCloudDisconnecting,
      activeAgentProfile: getActiveProfile(),
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
      setupStep,
      firstRunMode,
      firstRunActiveGuide,
      firstRunDeferredTasks,
      postFirstRunChecklistDismissed,
      firstRunOptions,
      firstRunName,
      firstRunOwnerName,
      firstRunStyle,
      firstRunRuntimeTarget,
      firstRunCloudApiKey,
      firstRunSmallModel,
      firstRunLargeModel,
      firstRunProvider,
      firstRunApiKey,
      firstRunVoiceProvider,
      firstRunVoiceApiKey,
      firstRunExistingInstallDetected,
      firstRunDetectedProviders,
      firstRunRemoteApiBase,
      firstRunRemoteToken,
      firstRunRemoteConnecting,
      firstRunRemoteError,
      firstRunRemoteConnected,
      firstRunOpenRouterModel,
      firstRunPrimaryModel,
      firstRunTelegramToken,
      firstRunDiscordToken,
      firstRunWhatsAppSessionPath,
      firstRunTwilioAccountSid,
      firstRunTwilioAuthToken,
      firstRunTwilioPhoneNumber,
      firstRunBlooioApiKey,
      firstRunBlooioPhoneNumber,
      firstRunGithubToken,
      firstRunSubscriptionTab,
      firstRunElizaCloudTab,
      firstRunSelectedChains,
      firstRunRpcSelections,
      firstRunRpcKeys,
      setupAvatar,
      firstRunFeatureTelegram,
      firstRunFeatureDiscord,
      firstRunFeaturePhone,
      firstRunFeatureCrypto,
      firstRunFeatureBrowser,
      firstRunFeatureComputerUse,
      firstRunFeatureOAuthPending,
      firstRunCloudProvisionedContainer,
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
      analysisMode,
      setAnalysisMode,
      appRuns,
      activeGameRunId,
      activeGameApp,
      activeGameDisplayName,
      activeGameViewerUrl,
      activeGameSandbox,
      activeGamePostMessageAuth,
      activeGameSession,
      gameOverlayEnabled,
      companionAppRunning,
      activeOverlayApp,
      activeInboxChat,
      activeTerminalSessionId,
      appsSubTab,
      agentSubTab,
      pluginsSubTab,
      databaseSubTab,
      favoriteApps,
      recentApps,
      configRaw,
      configText,
      activeGamePostMessagePayload,

      // Actions
      setTab,
      setUiShellMode,
      switchUiShellMode,
      switchShellView,
      navigation,
      setUiLanguage,
      setUiTheme,
      setCompanionVrmPowerMode,
      setCompanionAnimateWhenHidden,
      setCompanionHalfFramerateMode,
      handleStart,
      handleStop,

      handleRestart,
      handleReset,
      handleResetAppliedFromMain,
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
      suggestConversationTitle,
      sendActionMessage,
      sendChatText,
      loadTriggers,
      ensureTriggersLoaded,
      createTrigger,
      updateTrigger,
      deleteTrigger,
      runTriggerNow,
      loadTriggerRuns,
      loadTriggerHealth,
      handlePairingSubmit,
      loadPlugins,
      ensurePluginsLoaded,
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
      enableMarketplaceSkill,
      disableMarketplaceSkill,
      copyMarketplaceSkillSource,
      loadLogs,
      loadInventory,
      loadWalletConfig,
      loadBalances,
      loadNfts,
      executeBscTrade,
      executeBscTransfer,
      getBscTradePreflight,
      getBscTradeQuote,
      getBscTradeTxStatus,
      getStewardStatus,
      getStewardAddresses,
      getStewardBalance,
      getStewardTokens,
      getStewardWebhookEvents,
      getStewardHistory,
      getStewardPending,
      approveStewardTx,
      rejectStewardTx,
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
      handleFirstRunNext,
      handleFirstRunBack,
      handleFirstRunJumpToStep,
      goToFirstRunStep,
      handleFirstRunRemoteConnect,
      handleFirstRunUseLocalBackend,
      completeFirstRun,
      handleCloudLogin,
      handleCloudDisconnect,
      switchAgentProfile,
      handleCloudFirstRunFinish,
      vincentConnected,
      vincentLoginBusy,
      vincentLoginError,
      handleVincentLogin,
      handleVincentDisconnect,
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
    }),
    // prettier-ignore
    [
      t,
      tab,
      uiShellMode,
      uiLanguage,
      uiTheme,
      companionVrmPowerMode,
      companionAnimateWhenHidden,
      companionHalfFramerateMode,
      connected,
      agentStatus,
      firstRunComplete,
      firstRunUiRevealNonce,
      firstRunLoading,
      startupPhase,
      startupStatus,
      startupError,
      stableStartupCoordinator,
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
      chatFirstTokenReceived,
      chatLastUsage,
      chatAvatarVisible,
      chatAgentVoiceMuted,
      chatAvatarSpeaking,
      conversations,
      activeConversationId,
      companionMessageCutoffTs,
      conversationMessages,
      autonomousEvents,
      autonomousLatestEventId,
      autonomousRunHealthByRunId,
      // NOTE: ptySessions intentionally EXCLUDED — provided fresh via PtySessionsCtx.
      unreadConversations,
      triggers,
      triggersLoaded,
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
      logLoadError,
      browserEnabled,
      computerUseEnabled,
      walletEnabled,
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
      inventorySortDirection,
      inventoryChainFilters,
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
      wallets,
      walletPrimary,
      walletPrimaryRestarting,
      walletPrimaryPending,
      cloudRefreshing,
      setWalletPrimary,
      refreshCloudWallets,
      characterData,
      characterLoading,
      characterSaving,
      characterSaveSuccess,
      characterSaveError,
      characterDraft,
      selectedVrmIndex,
      customVrmUrl,
      customVrmPreviewUrl,
      customBackgroundUrl,
      customCatchphrase,
      customVoicePresetId,
      activePackId,
      customWorldUrl,
      elizaCloudEnabled,
      elizaCloudVoiceProxyAvailable,
      elizaCloudConnected,
      elizaCloudHasPersistedKey,
      elizaCloudCredits,
      elizaCloudCreditsLow,
      elizaCloudCreditsCritical,
      elizaCloudAuthRejected,
      elizaCloudCreditsError,
      elizaCloudTopUpUrl,
      elizaCloudUserId,
      elizaCloudStatusReason,
      ownerName,
      cloudDashboardView,
      elizaCloudLoginBusy,
      elizaCloudLoginError,
      elizaCloudLoginFallbackUrl,
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
      setupStep,
      firstRunMode,
      firstRunActiveGuide,
      firstRunDeferredTasks,
      postFirstRunChecklistDismissed,
      firstRunOptions,
      firstRunName,
      firstRunOwnerName,
      firstRunStyle,
      firstRunRuntimeTarget,
      firstRunCloudApiKey,
      firstRunSmallModel,
      firstRunLargeModel,
      firstRunProvider,
      firstRunApiKey,
      firstRunVoiceProvider,
      firstRunVoiceApiKey,
      firstRunExistingInstallDetected,
      firstRunDetectedProviders,
      firstRunRemoteApiBase,
      firstRunRemoteToken,
      firstRunRemoteConnecting,
      firstRunRemoteError,
      firstRunRemoteConnected,
      firstRunOpenRouterModel,
      firstRunPrimaryModel,
      firstRunTelegramToken,
      firstRunDiscordToken,
      firstRunWhatsAppSessionPath,
      firstRunTwilioAccountSid,
      firstRunTwilioAuthToken,
      firstRunTwilioPhoneNumber,
      firstRunBlooioApiKey,
      firstRunBlooioPhoneNumber,
      firstRunGithubToken,
      firstRunSubscriptionTab,
      firstRunElizaCloudTab,
      firstRunSelectedChains,
      firstRunRpcSelections,
      firstRunRpcKeys,
      setupAvatar,
      firstRunFeatureTelegram,
      firstRunFeatureDiscord,
      firstRunFeaturePhone,
      firstRunFeatureCrypto,
      firstRunFeatureBrowser,
      firstRunFeatureComputerUse,
      firstRunFeatureOAuthPending,
      firstRunCloudProvisionedContainer,
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
      appRuns,
      activeGameRunId,
      activeGameApp,
      activeGameDisplayName,
      activeGameViewerUrl,
      activeGameSandbox,
      activeGamePostMessageAuth,
      activeGameSession,
      gameOverlayEnabled,
      companionAppRunning,
      activeOverlayApp,
      activeInboxChat,
      activeTerminalSessionId,
      appsSubTab,
      agentSubTab,
      pluginsSubTab,
      databaseSubTab,
      favoriteApps,
      recentApps,
      configRaw,
      configText,
      activeGamePostMessagePayload,
      systemWarnings,
      setTab,
      setUiShellMode,
      switchUiShellMode,
      switchShellView,
      navigation,
      setUiLanguage,
      setUiTheme,
      setCompanionVrmPowerMode,
      setCompanionAnimateWhenHidden,
      setCompanionHalfFramerateMode,
      handleStart,
      handleStop,
      handleRestart,
      handleReset,
      handleResetAppliedFromMain,
      retryStartup,
      dismissRestartBanner,
      showRestartBanner,
      triggerRestart,
      relaunchDesktop,
      dismissBackendDisconnectedBanner,
      retryBackendConnection,
      restartBackend,
      dismissSystemWarning,
      handleChatSend,
      handleChatStop,
      handleChatRetry,
      handleChatEdit,
      handleChatClear,
      handleStartDraftConversation,
      handleNewConversation,
      handleSelectConversation,
      handleDeleteConversation,
      handleRenameConversation,
      suggestConversationTitle,
      sendActionMessage,
      sendChatText,
      loadTriggers,
      ensureTriggersLoaded,
      createTrigger,
      updateTrigger,
      deleteTrigger,
      runTriggerNow,
      loadTriggerRuns,
      loadTriggerHealth,
      handlePairingSubmit,
      loadPlugins,
      ensurePluginsLoaded,
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
      enableMarketplaceSkill,
      disableMarketplaceSkill,
      copyMarketplaceSkillSource,
      loadLogs,
      loadInventory,
      loadWalletConfig,
      loadBalances,
      loadNfts,
      executeBscTrade,
      executeBscTransfer,
      getBscTradePreflight,
      getBscTradeQuote,
      getBscTradeTxStatus,
      getStewardStatus,
      getStewardAddresses,
      getStewardBalance,
      getStewardTokens,
      getStewardWebhookEvents,
      getStewardHistory,
      getStewardPending,
      approveStewardTx,
      rejectStewardTx,
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
      handleFirstRunNext,
      handleFirstRunBack,
      handleFirstRunJumpToStep,
      goToFirstRunStep,
      handleFirstRunRemoteConnect,
      handleFirstRunUseLocalBackend,
      completeFirstRun,
      handleCloudLogin,
      handleCloudDisconnect,
      switchAgentProfile,
      handleCloudFirstRunFinish,
      vincentConnected,
      vincentLoginBusy,
      vincentLoginError,
      handleVincentLogin,
      handleVincentDisconnect,
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
      chatPendingImages,
      setChatPendingImages,
      chatSending,
      ptySessions, // chatInput/chatSending/chatPendingImages are stale here — read via useChatComposer()
      chatInput,
      analysisMode,
      setAnalysisMode,
    ],
  );

  // TEMP-DIAG(F3): log which AppContext value keys change between commits to
  // pin the ~1/sec app-wide re-render driver. Remove after diagnosis.
  const __ctxDiagPrev = useRef<Record<string, unknown> | null>(null);
  useEffect(() => {
    const cur = value as unknown as Record<string, unknown>;
    const prev = __ctxDiagPrev.current;
    if (prev) {
      const changed: string[] = [];
      for (const k of Object.keys(cur)) {
        if (prev[k] !== cur[k]) changed.push(k);
      }
      if (changed.length > 0) {
        console.warn(`[CTX-DIAG] ${Date.now()} changed: ${changed.join(",")}`);
      }
    }
    __ctxDiagPrev.current = cur;
  });

  const bootConfig = getBootConfig();
  const bootConfigValue = useMemo(
    () => ({
      ...bootConfig,
      branding: { ...bootConfig.branding, ...brandingOverride },
    }),
    [bootConfig, brandingOverride],
  );
  const mergedBranding = useMemo(
    () => ({ ...DEFAULT_BRANDING, ...bootConfigValue.branding }),
    [bootConfigValue],
  );

  return (
    <AppBootContext.Provider value={bootConfigValue}>
      <BrandingContext.Provider value={mergedBranding}>
        <CompanionSceneConfigCtx.Provider value={companionSceneConfig}>
          <PtySessionsCtx.Provider value={ptySessionsValue}>
            <ChatInputRefCtx.Provider value={chatInputRef}>
              <ChatComposerCtx.Provider value={composerValue}>
                <AppContext.Provider value={value}>
                  {children}
                  <ConfirmDialog {...modalProps} />
                  <PromptDialog {...promptModalProps} />
                </AppContext.Provider>
              </ChatComposerCtx.Provider>
            </ChatInputRefCtx.Provider>
          </PtySessionsCtx.Provider>
        </CompanionSceneConfigCtx.Provider>
      </BrandingContext.Provider>
    </AppBootContext.Provider>
  );
}
