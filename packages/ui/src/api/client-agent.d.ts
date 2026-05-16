/**
 * Agent domain methods — lifecycle, auth, config, connectors, triggers,
 * training, plugins, streaming, logs, character, permissions, updates.
 */
import type {
  AllPermissionsState,
  OnboardingConnectorConfig as ConnectorConfig,
  LinkedAccountConfig,
  LinkedAccountProviderId,
  OnboardingOptions,
  PermissionId,
  PermissionState,
  ServiceRouteAccountStrategy,
  SubscriptionStatusResponse,
} from "@elizaos/shared";
import {
  type AppBlockerInstalledApp,
  type AppBlockerPermissionResult,
  type AppBlockerStatusResult,
} from "../bridge/native-plugins";
import type {
  AgentAutomationMode,
  AgentAutomationModeResponse,
  AgentEventsResponse,
  AgentSelfStatusSnapshot,
  AgentStatus,
  CharacterData,
  CharacterHistoryResponse,
  CodingAgentScratchWorkspace,
  CodingAgentStatus,
  CodingAgentTaskThread,
  CodingAgentTaskThreadDetail,
  ConfigSchemaResponse,
  CorePluginsResponse,
  CreateTriggerRequest,
  ExperienceGraphResponse,
  ExperienceListQuery,
  ExperienceListResponse,
  ExperienceMaintenanceResult,
  ExperienceRecord,
  ExperienceUpdateInput,
  ExtensionStatus,
  LogsFilter,
  LogsResponse,
  PluginInfo,
  PluginMutationResult,
  ProviderModelRecord,
  RelationshipsActivityResponse,
  RelationshipsGraphQuery,
  RelationshipsGraphSnapshot,
  RelationshipsGraphStats,
  RelationshipsMergeCandidate,
  RelationshipsPersonDetail,
  RelationshipsPersonSummary,
  RuntimeDebugSnapshot,
  SecretInfo,
  SecurityAuditFilter,
  SecurityAuditResponse,
  SecurityAuditStreamEvent,
  StartTrainingOptions,
  TradePermissionMode,
  TradePermissionModeResponse,
  TrainingDatasetRecord,
  TrainingJobRecord,
  TrainingModelRecord,
  TrainingStatus,
  TrainingTrajectoryDetail,
  TrainingTrajectoryList,
  TriggerEventDispatchResponse,
  TriggerHealthSnapshot,
  TriggerLastStatus,
  TriggerRunRecord,
  TriggerSummary,
  UpdateStatus,
  UpdateTriggerRequest,
} from "./client-types";
/** Successful response from POST /api/auth/bootstrap/exchange. */
export interface BootstrapExchangeSuccess {
  ok: true;
  sessionId: string;
  expiresAt: number;
  identityId: string;
}
/** Failure response from POST /api/auth/bootstrap/exchange. */
export interface BootstrapExchangeFailure {
  ok: false;
  status: 400 | 401 | 429 | 503;
  error: string;
  reason?: string;
}
export type BootstrapExchangeResult =
  | BootstrapExchangeSuccess
  | BootstrapExchangeFailure;
export type AccountStrategy = ServiceRouteAccountStrategy;
export interface AccountWithCredentialFlag extends LinkedAccountConfig {
  hasCredential: boolean;
}
export interface AccountsListProvider {
  providerId: LinkedAccountProviderId;
  strategy: AccountStrategy;
  accounts: AccountWithCredentialFlag[];
}
export interface AccountsListResponse {
  providers: AccountsListProvider[];
}
export interface AccountTestResult {
  ok: boolean;
  latencyMs?: number;
  status?: number;
  error?: string;
}
export interface AccountRefreshUsageResult {
  account: LinkedAccountConfig;
  source: "pool" | "inline-probe";
}
export interface AccountOAuthStartResult {
  sessionId: string;
  authUrl: string;
  needsCodeSubmission: boolean;
}
export type ConnectorAccountRole = "OWNER" | "AGENT" | "TEAM";
export type ConnectorAccountPurpose =
  | "messaging"
  | "posting"
  | "reading"
  | "admin"
  | "automation"
  | (string & {});
export type ConnectorAccountPrivacy =
  | "owner_only"
  | "team_visible"
  | "semi_public"
  | "public";
export type ConnectorAccountStatus =
  | "connected"
  | "pending"
  | "needs-reauth"
  | "disconnected"
  | "error"
  | "unknown";
export interface ConnectorAccountRecord {
  id: string;
  provider: string;
  connectorId: string;
  label: string;
  handle?: string | null;
  externalId?: string | null;
  avatarUrl?: string | null;
  status?: ConnectorAccountStatus;
  statusDetail?: string | null;
  role?: ConnectorAccountRole;
  purpose?: ConnectorAccountPurpose[];
  privacy?: ConnectorAccountPrivacy;
  isDefault?: boolean;
  enabled?: boolean;
  createdAt?: number;
  updatedAt?: number;
  lastSyncedAt?: number;
  metadata?: Record<string, unknown>;
}
export interface ConnectorAccountsListResponse {
  provider: string;
  connectorId: string;
  defaultAccountId?: string | null;
  accounts: ConnectorAccountRecord[];
}
export interface ConnectorAccountCreateInput {
  label?: string;
  role?: ConnectorAccountRole;
  purpose?: ConnectorAccountPurpose | ConnectorAccountPurpose[];
  privacy?: ConnectorAccountPrivacy;
  metadata?: Record<string, unknown>;
  confirmation?: {
    role?: string;
    privacy?: string;
    publicAcknowledged?: boolean;
  };
}
export interface ConnectorAccountUpdateInput {
  label?: string;
  role?: ConnectorAccountRole;
  purpose?: ConnectorAccountPurpose | ConnectorAccountPurpose[];
  privacy?: ConnectorAccountPrivacy;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
  confirmation?: {
    role?: string;
    privacy?: string;
    publicAcknowledged?: boolean;
  };
}
export interface ConnectorAccountOAuthStartInput {
  redirectUri?: string;
  accountId?: string;
  label?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}
export interface ConnectorAccountActionResult {
  ok: boolean;
  account?: ConnectorAccountRecord;
  accounts?: ConnectorAccountRecord[];
  defaultAccountId?: string | null;
  authUrl?: string;
  flow?: Record<string, unknown>;
  status?: ConnectorAccountStatus | string;
  error?: string;
}
export interface ConnectorAccountAuditEventRecord {
  id: string;
  accountId?: string | null;
  agentId?: string;
  provider: string;
  actorId?: string | null;
  action: string;
  outcome: "success" | "failure" | string;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}
export interface ConnectorAccountAuditEventsQuery {
  accountId?: string;
  action?: string;
  outcome?: "success" | "failure";
  limit?: number;
}
export interface ConnectorAccountAuditEventsResponse {
  provider: string;
  events: ConnectorAccountAuditEventRecord[];
}
declare module "./client-base" {
  interface ElizaClient {
    getStatus(): Promise<AgentStatus>;
    getAgentSelfStatus(): Promise<AgentSelfStatusSnapshot>;
    getRuntimeSnapshot(opts?: {
      depth?: number;
      maxArrayLength?: number;
      maxObjectEntries?: number;
      maxStringLength?: number;
    }): Promise<RuntimeDebugSnapshot>;
    setAutomationMode(mode: "connectors-only" | "full"): Promise<{
      mode: string;
    }>;
    setTradeMode(mode: string): Promise<{
      ok: boolean;
      tradePermissionMode: string;
    }>;
    playEmote(emoteId: string): Promise<{
      ok: boolean;
    }>;
    runTerminalCommand(command: string): Promise<{
      ok: boolean;
    }>;
    getOnboardingStatus(): Promise<{
      complete: boolean;
      cloudProvisioned?: boolean;
    }>;
    getWalletKeys(): Promise<{
      evmPrivateKey: string;
      evmAddress: string;
      solanaPrivateKey: string;
      solanaAddress: string;
    }>;
    getWalletOsStoreStatus(): Promise<{
      backend: string;
      available: boolean;
      readEnabled: boolean;
      vaultId: string;
    }>;
    postWalletOsStoreAction(action: "migrate" | "delete"): Promise<{
      ok: boolean;
      migrated?: string[];
      failed?: string[];
      error?: string;
    }>;
    getAuthStatus(): Promise<{
      required: boolean;
      authenticated?: boolean;
      loginRequired?: boolean;
      bootstrapRequired?: boolean;
      localAccess?: boolean;
      passwordConfigured?: boolean;
      pairingEnabled: boolean;
      expiresAt: number | null;
    }>;
    postBootstrapExchange(token: string): Promise<BootstrapExchangeResult>;
    pair(code: string): Promise<{
      token: string;
    }>;
    getOnboardingOptions(): Promise<OnboardingOptions>;
    submitOnboarding(data: Record<string, unknown>): Promise<void>;
    startAnthropicLogin(): Promise<{
      authUrl: string;
    }>;
    exchangeAnthropicCode(code: string): Promise<{
      success: boolean;
      expiresAt?: string;
      error?: string;
    }>;
    submitAnthropicSetupToken(token: string): Promise<{
      success: boolean;
    }>;
    getSubscriptionStatus(): Promise<SubscriptionStatusResponse>;
    deleteSubscription(provider: string): Promise<{
      success: boolean;
    }>;
    switchProvider(
      provider: string,
      apiKey?: string,
      primaryModel?: string,
      options?: {
        useLocalEmbeddings?: boolean;
      },
    ): Promise<{
      success: boolean;
      provider: string;
      restarting: boolean;
    }>;
    startOpenAILogin(): Promise<{
      authUrl: string;
      state: string;
      instructions: string;
    }>;
    exchangeOpenAICode(code: string): Promise<{
      success: boolean;
      expiresAt?: string;
      accountId?: string;
      error?: string;
    }>;
    startAgent(): Promise<AgentStatus>;
    startAndWait(maxWaitMs?: number): Promise<AgentStatus>;
    stopAgent(): Promise<AgentStatus>;
    pauseAgent(): Promise<AgentStatus>;
    resumeAgent(): Promise<AgentStatus>;
    restartAgent(): Promise<AgentStatus>;
    restartAndWait(maxWaitMs?: number): Promise<AgentStatus>;
    resetAgent(): Promise<void>;
    restart(): Promise<{
      ok: boolean;
    }>;
    getConfig(): Promise<Record<string, unknown>>;
    getConfigSchema(): Promise<ConfigSchemaResponse>;
    updateConfig(
      patch: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
    listAccounts(): Promise<AccountsListResponse>;
    createApiKeyAccount(
      providerId: LinkedAccountProviderId,
      body: {
        label: string;
        apiKey: string;
      },
    ): Promise<LinkedAccountConfig>;
    patchAccount(
      providerId: LinkedAccountProviderId,
      accountId: string,
      body: Partial<{
        label: string;
        enabled: boolean;
        priority: number;
      }>,
    ): Promise<LinkedAccountConfig>;
    deleteAccount(
      providerId: LinkedAccountProviderId,
      accountId: string,
    ): Promise<{
      deleted: boolean;
    }>;
    testAccount(
      providerId: LinkedAccountProviderId,
      accountId: string,
    ): Promise<AccountTestResult>;
    refreshAccountUsage(
      providerId: LinkedAccountProviderId,
      accountId: string,
    ): Promise<AccountRefreshUsageResult>;
    startAccountOAuth(
      providerId: LinkedAccountProviderId,
      body: {
        label: string;
      },
    ): Promise<AccountOAuthStartResult>;
    submitAccountOAuthCode(
      providerId: LinkedAccountProviderId,
      body: {
        sessionId: string;
        code: string;
      },
    ): Promise<{
      accepted: boolean;
    }>;
    cancelAccountOAuth(
      providerId: LinkedAccountProviderId,
      body: {
        sessionId: string;
      },
    ): Promise<{
      cancelled: boolean;
    }>;
    patchProviderStrategy(
      providerId: LinkedAccountProviderId,
      body: {
        strategy: AccountStrategy;
      },
    ): Promise<{
      providerId: LinkedAccountProviderId;
      strategy: AccountStrategy;
    }>;
    uploadCustomVrm(file: File): Promise<void>;
    hasCustomVrm(): Promise<boolean>;
    uploadCustomBackground(file: File): Promise<void>;
    hasCustomBackground(): Promise<boolean>;
    getConnectors(): Promise<{
      connectors: Record<string, ConnectorConfig>;
    }>;
    saveConnector(
      name: string,
      config: ConnectorConfig,
    ): Promise<{
      connectors: Record<string, ConnectorConfig>;
    }>;
    deleteConnector(name: string): Promise<{
      connectors: Record<string, ConnectorConfig>;
    }>;
    listConnectorAccounts(
      provider: string,
      connectorId?: string,
    ): Promise<ConnectorAccountsListResponse>;
    addConnectorAccount(
      provider: string,
      connectorId: string | undefined,
      body?: ConnectorAccountCreateInput,
    ): Promise<ConnectorAccountActionResult>;
    startConnectorAccountOAuth(
      provider: string,
      connectorId: string | undefined,
      body?: ConnectorAccountOAuthStartInput,
    ): Promise<ConnectorAccountActionResult>;
    patchConnectorAccount(
      provider: string,
      connectorId: string | undefined,
      accountId: string,
      body: ConnectorAccountUpdateInput,
    ): Promise<ConnectorAccountRecord>;
    testConnectorAccount(
      provider: string,
      connectorId: string | undefined,
      accountId: string,
    ): Promise<ConnectorAccountActionResult>;
    refreshConnectorAccount(
      provider: string,
      connectorId: string | undefined,
      accountId: string,
    ): Promise<ConnectorAccountActionResult>;
    deleteConnectorAccount(
      provider: string,
      connectorId: string | undefined,
      accountId: string,
    ): Promise<ConnectorAccountActionResult>;
    makeDefaultConnectorAccount(
      provider: string,
      connectorId: string | undefined,
      accountId: string,
    ): Promise<ConnectorAccountActionResult>;
    listConnectorAccountAuditEvents(
      provider: string,
      query?: ConnectorAccountAuditEventsQuery,
    ): Promise<ConnectorAccountAuditEventsResponse>;
    getTriggers(): Promise<{
      triggers: TriggerSummary[];
    }>;
    getTrigger(id: string): Promise<{
      trigger: TriggerSummary;
    }>;
    createTrigger(request: CreateTriggerRequest): Promise<{
      trigger: TriggerSummary;
    }>;
    updateTrigger(
      id: string,
      request: UpdateTriggerRequest,
    ): Promise<{
      trigger: TriggerSummary;
    }>;
    deleteTrigger(id: string): Promise<{
      ok: boolean;
    }>;
    runTriggerNow(id: string): Promise<{
      ok: boolean;
      result: {
        status: TriggerLastStatus;
        error?: string;
        taskDeleted: boolean;
      };
      trigger?: TriggerSummary;
    }>;
    getTriggerRuns(id: string): Promise<{
      runs: TriggerRunRecord[];
    }>;
    emitTriggerEvent(
      eventKind: string,
      payload?: Record<string, unknown>,
    ): Promise<TriggerEventDispatchResponse>;
    getTriggerHealth(): Promise<TriggerHealthSnapshot>;
    getTrainingStatus(): Promise<TrainingStatus>;
    listTrainingTrajectories(opts?: {
      limit?: number;
      offset?: number;
    }): Promise<TrainingTrajectoryList>;
    getTrainingTrajectory(trajectoryId: string): Promise<{
      trajectory: TrainingTrajectoryDetail;
    }>;
    listTrainingDatasets(): Promise<{
      datasets: TrainingDatasetRecord[];
    }>;
    buildTrainingDataset(options?: {
      limit?: number;
      minLlmCallsPerTrajectory?: number;
    }): Promise<{
      dataset: TrainingDatasetRecord;
    }>;
    listTrainingJobs(): Promise<{
      jobs: TrainingJobRecord[];
    }>;
    startTrainingJob(options?: StartTrainingOptions): Promise<{
      job: TrainingJobRecord;
    }>;
    getTrainingJob(jobId: string): Promise<{
      job: TrainingJobRecord;
    }>;
    cancelTrainingJob(jobId: string): Promise<{
      job: TrainingJobRecord;
    }>;
    listTrainingModels(): Promise<{
      models: TrainingModelRecord[];
    }>;
    importTrainingModelToOllama(
      modelId: string,
      options?: {
        modelName?: string;
        baseModel?: string;
        ollamaUrl?: string;
      },
    ): Promise<{
      model: TrainingModelRecord;
    }>;
    activateTrainingModel(
      modelId: string,
      providerModel?: string,
    ): Promise<{
      modelId: string;
      providerModel: string;
      needsRestart: boolean;
    }>;
    benchmarkTrainingModel(modelId: string): Promise<{
      status: "passed" | "failed";
      output: string;
    }>;
    getPlugins(): Promise<{
      plugins: PluginInfo[];
    }>;
    fetchModels(
      provider: string,
      refresh?: boolean,
    ): Promise<{
      provider: string;
      models: ProviderModelRecord[];
    }>;
    getCorePlugins(): Promise<CorePluginsResponse>;
    toggleCorePlugin(
      npmName: string,
      enabled: boolean,
    ): Promise<PluginMutationResult>;
    updatePlugin(
      id: string,
      config: Record<string, unknown>,
    ): Promise<PluginMutationResult>;
    getSecrets(): Promise<{
      secrets: SecretInfo[];
    }>;
    updateSecrets(secrets: Record<string, string>): Promise<{
      ok: boolean;
      updated: string[];
    }>;
    testPluginConnection(id: string): Promise<{
      success: boolean;
      pluginId: string;
      message?: string;
      error?: string;
      durationMs: number;
    }>;
    getLogs(filter?: LogsFilter): Promise<LogsResponse>;
    getSecurityAudit(
      filter?: SecurityAuditFilter,
    ): Promise<SecurityAuditResponse>;
    streamSecurityAudit(
      onEvent: (event: SecurityAuditStreamEvent) => void,
      filter?: SecurityAuditFilter,
      signal?: AbortSignal,
    ): Promise<void>;
    getAgentEvents(opts?: {
      afterEventId?: string;
      limit?: number;
      runId?: string;
      fromSeq?: number;
    }): Promise<AgentEventsResponse>;
    getExtensionStatus(): Promise<ExtensionStatus>;
    getRelationshipsGraph(
      query?: RelationshipsGraphQuery,
    ): Promise<RelationshipsGraphSnapshot>;
    getRelationshipsPeople(query?: RelationshipsGraphQuery): Promise<{
      people: RelationshipsPersonSummary[];
      stats: RelationshipsGraphStats;
    }>;
    getRelationshipsPerson(id: string): Promise<RelationshipsPersonDetail>;
    getRelationshipsActivity(
      limit?: number,
      offset?: number,
    ): Promise<RelationshipsActivityResponse>;
    getRelationshipsCandidates(): Promise<RelationshipsMergeCandidate[]>;
    acceptRelationshipsCandidate(candidateId: string): Promise<{
      id: string;
      status: string;
    }>;
    rejectRelationshipsCandidate(candidateId: string): Promise<{
      id: string;
      status: string;
    }>;
    proposeRelationshipsLink(
      sourceEntityId: string,
      targetEntityId: string,
      evidence?: Record<string, unknown>,
    ): Promise<{
      id: string;
      status: string;
    }>;
    getCharacter(): Promise<{
      character: CharacterData;
      agentName: string;
    }>;
    getRandomName(): Promise<{
      name: string;
    }>;
    generateCharacterField(
      field: string,
      context: {
        name?: string;
        system?: string;
        bio?: string;
        topics?: string[];
        style?: {
          all?: string[];
          chat?: string[];
          post?: string[];
        };
        postExamples?: string[];
      },
      mode?: "append" | "replace",
    ): Promise<{
      generated: string;
    }>;
    updateCharacter(character: CharacterData): Promise<{
      ok: boolean;
      character: CharacterData;
      agentName: string;
    }>;
    listCharacterHistory(options?: {
      limit?: number;
      offset?: number;
    }): Promise<CharacterHistoryResponse>;
    listExperiences(
      options?: ExperienceListQuery,
    ): Promise<ExperienceListResponse>;
    getExperienceGraph(options?: ExperienceListQuery): Promise<{
      graph: ExperienceGraphResponse;
    }>;
    runExperienceMaintenance(options?: {
      deleteDuplicates?: boolean;
      limit?: number;
    }): Promise<{
      result: ExperienceMaintenanceResult;
    }>;
    getExperience(id: string): Promise<{
      experience: ExperienceRecord;
    }>;
    updateExperience(
      id: string,
      data: ExperienceUpdateInput,
    ): Promise<{
      experience: ExperienceRecord;
    }>;
    deleteExperience(id: string): Promise<{
      ok: boolean;
    }>;
    getUpdateStatus(force?: boolean): Promise<UpdateStatus>;
    setUpdateChannel(channel: "stable" | "beta" | "nightly"): Promise<{
      channel: string;
    }>;
    getAgentAutomationMode(): Promise<AgentAutomationModeResponse>;
    setAgentAutomationMode(
      mode: AgentAutomationMode,
    ): Promise<AgentAutomationModeResponse>;
    getTradePermissionMode(): Promise<TradePermissionModeResponse>;
    setTradePermissionMode(
      mode: TradePermissionMode,
    ): Promise<TradePermissionModeResponse>;
    getPermissions(): Promise<AllPermissionsState>;
    getPermission(id: PermissionId): Promise<PermissionState>;
    requestPermission(id: PermissionId): Promise<PermissionState>;
    openPermissionSettings(id: PermissionId): Promise<void>;
    refreshPermissions(): Promise<AllPermissionsState>;
    setShellEnabled(enabled: boolean): Promise<PermissionState>;
    isShellEnabled(): Promise<boolean>;
    getWebsiteBlockerStatus(): Promise<{
      available: boolean;
      active: boolean;
      hostsFilePath: string | null;
      endsAt: string | null;
      websites: string[];
      canUnblockEarly: boolean;
      requiresElevation: boolean;
      engine:
        | "hosts-file"
        | "vpn-dns"
        | "network-extension"
        | "content-blocker";
      platform: string;
      supportsElevationPrompt: boolean;
      elevationPromptMethod:
        | "osascript"
        | "pkexec"
        | "powershell-runas"
        | "vpn-consent"
        | "system-settings"
        | null;
      permissionStatus?: PermissionState["status"];
      canRequestPermission?: boolean;
      canOpenSystemSettings?: boolean;
      reason?: string;
    }>;
    startWebsiteBlock(options: {
      websites?: string[] | string;
      durationMinutes?: number | string | null;
      text?: string;
    }): Promise<
      | {
          success: true;
          endsAt: string | null;
          request: {
            websites: string[];
            durationMinutes: number | null;
          };
        }
      | {
          success: false;
          error: string;
          status?: {
            active: boolean;
            endsAt: string | null;
            websites: string[];
            requiresElevation: boolean;
          };
        }
    >;
    stopWebsiteBlock(): Promise<
      | {
          success: true;
          removed: boolean;
          status: {
            active: boolean;
            endsAt: string | null;
            websites: string[];
            canUnblockEarly: boolean;
            requiresElevation: boolean;
          };
        }
      | {
          success: false;
          error: string;
          status?: {
            active: boolean;
            endsAt: string | null;
            websites: string[];
            canUnblockEarly: boolean;
            requiresElevation: boolean;
          };
        }
    >;
    getAppBlockerStatus(): Promise<AppBlockerStatusResult>;
    checkAppBlockerPermissions(): Promise<AppBlockerPermissionResult>;
    requestAppBlockerPermissions(): Promise<AppBlockerPermissionResult>;
    getInstalledAppsToBlock(): Promise<{
      apps: AppBlockerInstalledApp[];
    }>;
    selectAppBlockerApps(): Promise<{
      apps: AppBlockerInstalledApp[];
      cancelled: boolean;
    }>;
    startAppBlock(options: {
      appTokens?: string[];
      packageNames?: string[];
      durationMinutes?: number | null;
    }): Promise<{
      success: boolean;
      endsAt: string | null;
      blockedCount: number;
      error?: string;
    }>;
    stopAppBlock(): Promise<{
      success: boolean;
      error?: string;
    }>;
    getCodingAgentStatus(): Promise<CodingAgentStatus | null>;
    listCodingAgentTaskThreads(options?: {
      includeArchived?: boolean;
      status?: string;
      search?: string;
      limit?: number;
    }): Promise<CodingAgentTaskThread[]>;
    getCodingAgentTaskThread(
      threadId: string,
    ): Promise<CodingAgentTaskThreadDetail | null>;
    archiveCodingAgentTaskThread(threadId: string): Promise<boolean>;
    reopenCodingAgentTaskThread(threadId: string): Promise<boolean>;
    stopCodingAgent(sessionId: string): Promise<boolean>;
    listCodingAgentScratchWorkspaces(): Promise<CodingAgentScratchWorkspace[]>;
    keepCodingAgentScratchWorkspace(sessionId: string): Promise<boolean>;
    deleteCodingAgentScratchWorkspace(sessionId: string): Promise<boolean>;
    promoteCodingAgentScratchWorkspace(
      sessionId: string,
      name?: string,
    ): Promise<CodingAgentScratchWorkspace | null>;
    spawnShellSession(workdir?: string): Promise<{
      sessionId: string;
    }>;
    subscribePtyOutput(sessionId: string): void;
    unsubscribePtyOutput(sessionId: string): void;
    sendPtyInput(sessionId: string, data: string): void;
    resizePty(sessionId: string, cols: number, rows: number): void;
    getPtyBufferedOutput(sessionId: string): Promise<string>;
    streamGoLive(): Promise<{
      ok: boolean;
      live: boolean;
      rtmpUrl?: string;
      inputMode?: string;
      audioSource?: string;
      message?: string;
      destination?: string;
    }>;
    streamGoOffline(): Promise<{
      ok: boolean;
      live: boolean;
    }>;
    streamStatus(): Promise<{
      ok: boolean;
      running: boolean;
      ffmpegAlive: boolean;
      uptime: number;
      frameCount: number;
      volume: number;
      muted: boolean;
      audioSource: string;
      inputMode: string | null;
      destination?: {
        id: string;
        name: string;
      } | null;
    }>;
    getStreamingDestinations(): Promise<{
      ok: boolean;
      destinations: Array<{
        id: string;
        name: string;
      }>;
    }>;
    setActiveDestination(destinationId: string): Promise<{
      ok: boolean;
      destination?: {
        id: string;
        name: string;
      };
    }>;
    setStreamVolume(volume: number): Promise<{
      ok: boolean;
      volume: number;
      muted: boolean;
    }>;
    muteStream(): Promise<{
      ok: boolean;
      muted: boolean;
      volume: number;
    }>;
    unmuteStream(): Promise<{
      ok: boolean;
      muted: boolean;
      volume: number;
    }>;
    getStreamVoice(): Promise<{
      ok: boolean;
      enabled: boolean;
      autoSpeak: boolean;
      provider: string | null;
      configuredProvider: string | null;
      hasApiKey: boolean;
      isSpeaking: boolean;
      isAttached: boolean;
    }>;
    saveStreamVoice(settings: {
      enabled?: boolean;
      autoSpeak?: boolean;
      provider?: string;
    }): Promise<{
      ok: boolean;
      voice: {
        enabled: boolean;
        autoSpeak: boolean;
      };
    }>;
    streamVoiceSpeak(text: string): Promise<{
      ok: boolean;
      speaking: boolean;
    }>;
    getOverlayLayout(destinationId?: string | null): Promise<{
      ok: boolean;
      layout: unknown;
      destinationId?: string;
    }>;
    saveOverlayLayout(
      layout: unknown,
      destinationId?: string | null,
    ): Promise<{
      ok: boolean;
      layout: unknown;
      destinationId?: string;
    }>;
    getStreamSource(): Promise<{
      source: {
        type: string;
        url?: string;
      };
    }>;
    setStreamSource(
      sourceType: string,
      customUrl?: string,
    ): Promise<{
      ok: boolean;
      source: {
        type: string;
        url?: string;
      };
    }>;
    getStreamSettings(): Promise<{
      ok: boolean;
      settings: {
        theme?: string;
        avatarIndex?: number;
      };
    }>;
    saveStreamSettings(settings: {
      theme?: string;
      avatarIndex?: number;
    }): Promise<{
      ok: boolean;
      settings: unknown;
    }>;
  }
}
//# sourceMappingURL=client-agent.d.ts.map
