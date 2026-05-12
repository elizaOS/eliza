/**
 * Agent domain methods — lifecycle, auth, config, connectors, triggers,
 * training, plugins, streaming/PTY, logs, character, permissions, updates.
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
  isElizaSettingsDebugEnabled,
  sanitizeForSettingsDebug,
  settingsDebugCloudSummary,
} from "@elizaos/shared";
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import {
  type AppBlockerInstalledApp,
  type AppBlockerPermissionResult,
  type AppBlockerStatusResult,
  getAppBlockerPlugin,
  getWebsiteBlockerPlugin,
  type WebsiteBlockerPermissionResult,
  type WebsiteBlockerStatusResult,
} from "../bridge/native-plugins";
import { TERMINAL_STATUSES } from "../chat/coding-agent-session-state";
import { ElizaClient } from "./client-base";
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
  RawPtySession,
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
import {
  mapPtySessionsToCodingAgentSessions,
  mapTaskThreadsToCodingAgentSessions,
} from "./client-types";

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function clientSettingsDebug(): boolean {
  let viteEnv: Record<string, unknown> | undefined;
  try {
    viteEnv = import.meta.env as Record<string, unknown>;
  } catch {
    viteEnv = undefined;
  }
  return isElizaSettingsDebugEnabled({
    importMetaEnv: viteEnv,
    env: typeof process !== "undefined" ? process.env : undefined,
  });
}

const WEBSITE_BLOCKING_PERMISSION_ID = "website-blocking" as const;

function getNativeWebsiteBlockerPluginIfAvailable() {
  const plugin = getWebsiteBlockerPlugin();
  return typeof plugin.getStatus === "function" &&
    typeof plugin.startBlock === "function" &&
    typeof plugin.stopBlock === "function" &&
    typeof plugin.checkPermissions === "function" &&
    typeof plugin.requestPermissions === "function" &&
    typeof plugin.openSettings === "function"
    ? plugin
    : null;
}

function getNativeAppBlockerPluginIfAvailable() {
  const plugin = getAppBlockerPlugin();
  return typeof plugin.getStatus === "function" &&
    typeof plugin.checkPermissions === "function" &&
    typeof plugin.requestPermissions === "function" &&
    typeof plugin.getInstalledApps === "function" &&
    typeof plugin.selectApps === "function" &&
    typeof plugin.blockApps === "function" &&
    typeof plugin.unblockApps === "function"
    ? plugin
    : null;
}

function mapWebsiteBlockerPermissionResult(
  permission: WebsiteBlockerPermissionResult,
): PermissionState {
  return {
    id: WEBSITE_BLOCKING_PERMISSION_ID,
    status: permission.status,
    canRequest: permission.canRequest,
    reason: permission.reason,
    lastChecked: Date.now(),
    platform: currentClientPlatform(),
  };
}

function mapWebsiteBlockerStatusToPermission(
  status: WebsiteBlockerStatusResult,
): PermissionState {
  return {
    id: WEBSITE_BLOCKING_PERMISSION_ID,
    status:
      status.permissionStatus ??
      (status.available ? "granted" : "not-determined"),
    canRequest: status.canRequestPermission ?? status.supportsElevationPrompt,
    reason: status.reason,
    lastChecked: Date.now(),
    platform: currentClientPlatform(),
  };
}

function currentClientPlatform(): "darwin" | "win32" | "linux" {
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) return "darwin";
    if (ua.includes("win")) return "win32";
  }
  return "linux";
}

function logSettingsClient(
  phase: string,
  detail: Record<string, unknown>,
): void {
  if (!clientSettingsDebug()) return;
  console.debug(
    `[eliza][settings][client] ${phase}`,
    sanitizeForSettingsDebug(detail),
  );
}

const SETTINGS_MUTATION_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Bootstrap exchange types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Multi-account routes (WS3) — surfaced under `/api/accounts/*` and the
// per-provider `/api/providers/:providerId/strategy` endpoint. The on-disk
// `LinkedAccountConfig` records are joined with a `hasCredential` flag so
// the UI can spot orphan metadata.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Connector account routes — UI-facing connector multi-account management.
// Connector config still uses `/api/connectors`; account inventory lives under
// `/api/connectors/:provider/accounts`.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Declaration merging
// ---------------------------------------------------------------------------

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
    setAutomationMode(
      mode: "connectors-only" | "full",
    ): Promise<{ mode: string }>;
    setTradeMode(
      mode: string,
    ): Promise<{ ok: boolean; tradePermissionMode: string }>;
    playEmote(emoteId: string): Promise<{ ok: boolean }>;
    runTerminalCommand(command: string): Promise<{ ok: boolean }>;
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
    pair(code: string): Promise<{ token: string }>;
    getOnboardingOptions(): Promise<OnboardingOptions>;
    submitOnboarding(data: Record<string, unknown>): Promise<void>;
    startAnthropicLogin(): Promise<{ authUrl: string }>;
    exchangeAnthropicCode(code: string): Promise<{
      success: boolean;
      expiresAt?: string;
      error?: string;
    }>;
    submitAnthropicSetupToken(token: string): Promise<{ success: boolean }>;
    getSubscriptionStatus(): Promise<SubscriptionStatusResponse>;
    deleteSubscription(provider: string): Promise<{ success: boolean }>;
    switchProvider(
      provider: string,
      apiKey?: string,
      primaryModel?: string,
      options?: { useLocalEmbeddings?: boolean },
    ): Promise<{ success: boolean; provider: string; restarting: boolean }>;
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
    restart(): Promise<{ ok: boolean }>;
    getConfig(): Promise<Record<string, unknown>>;
    getConfigSchema(): Promise<ConfigSchemaResponse>;
    updateConfig(
      patch: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
    listAccounts(): Promise<AccountsListResponse>;
    createApiKeyAccount(
      providerId: LinkedAccountProviderId,
      body: { label: string; apiKey: string },
    ): Promise<LinkedAccountConfig>;
    patchAccount(
      providerId: LinkedAccountProviderId,
      accountId: string,
      body: Partial<{ label: string; enabled: boolean; priority: number }>,
    ): Promise<LinkedAccountConfig>;
    deleteAccount(
      providerId: LinkedAccountProviderId,
      accountId: string,
    ): Promise<{ deleted: boolean }>;
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
      body: { label: string },
    ): Promise<AccountOAuthStartResult>;
    submitAccountOAuthCode(
      providerId: LinkedAccountProviderId,
      body: { sessionId: string; code: string },
    ): Promise<{ accepted: boolean }>;
    cancelAccountOAuth(
      providerId: LinkedAccountProviderId,
      body: { sessionId: string },
    ): Promise<{ cancelled: boolean }>;
    patchProviderStrategy(
      providerId: LinkedAccountProviderId,
      body: { strategy: AccountStrategy },
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
    ): Promise<{ connectors: Record<string, ConnectorConfig> }>;
    deleteConnector(
      name: string,
    ): Promise<{ connectors: Record<string, ConnectorConfig> }>;
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
    getTriggers(): Promise<{ triggers: TriggerSummary[] }>;
    getTrigger(id: string): Promise<{ trigger: TriggerSummary }>;
    createTrigger(
      request: CreateTriggerRequest,
    ): Promise<{ trigger: TriggerSummary }>;
    updateTrigger(
      id: string,
      request: UpdateTriggerRequest,
    ): Promise<{ trigger: TriggerSummary }>;
    deleteTrigger(id: string): Promise<{ ok: boolean }>;
    runTriggerNow(id: string): Promise<{
      ok: boolean;
      result: {
        status: TriggerLastStatus;
        error?: string;
        taskDeleted: boolean;
      };
      trigger?: TriggerSummary;
    }>;
    getTriggerRuns(id: string): Promise<{ runs: TriggerRunRecord[] }>;
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
    getTrainingTrajectory(
      trajectoryId: string,
    ): Promise<{ trajectory: TrainingTrajectoryDetail }>;
    listTrainingDatasets(): Promise<{ datasets: TrainingDatasetRecord[] }>;
    buildTrainingDataset(options?: {
      limit?: number;
      minLlmCallsPerTrajectory?: number;
    }): Promise<{ dataset: TrainingDatasetRecord }>;
    listTrainingJobs(): Promise<{ jobs: TrainingJobRecord[] }>;
    startTrainingJob(
      options?: StartTrainingOptions,
    ): Promise<{ job: TrainingJobRecord }>;
    getTrainingJob(jobId: string): Promise<{ job: TrainingJobRecord }>;
    cancelTrainingJob(jobId: string): Promise<{ job: TrainingJobRecord }>;
    listTrainingModels(): Promise<{ models: TrainingModelRecord[] }>;
    importTrainingModelToOllama(
      modelId: string,
      options?: {
        modelName?: string;
        baseModel?: string;
        ollamaUrl?: string;
      },
    ): Promise<{ model: TrainingModelRecord }>;
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
    getPlugins(): Promise<{ plugins: PluginInfo[] }>;
    fetchModels(
      provider: string,
      refresh?: boolean,
    ): Promise<{ provider: string; models: ProviderModelRecord[] }>;
    getCorePlugins(): Promise<CorePluginsResponse>;
    toggleCorePlugin(
      npmName: string,
      enabled: boolean,
    ): Promise<PluginMutationResult>;
    updatePlugin(
      id: string,
      config: Record<string, unknown>,
    ): Promise<PluginMutationResult>;
    getSecrets(): Promise<{ secrets: SecretInfo[] }>;
    updateSecrets(
      secrets: Record<string, string>,
    ): Promise<{ ok: boolean; updated: string[] }>;
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
    acceptRelationshipsCandidate(
      candidateId: string,
    ): Promise<{ id: string; status: string }>;
    rejectRelationshipsCandidate(
      candidateId: string,
    ): Promise<{ id: string; status: string }>;
    proposeRelationshipsLink(
      sourceEntityId: string,
      targetEntityId: string,
      evidence?: Record<string, unknown>,
    ): Promise<{ id: string; status: string }>;
    getCharacter(): Promise<{
      character: CharacterData;
      agentName: string;
    }>;
    getRandomName(): Promise<{ name: string }>;
    generateCharacterField(
      field: string,
      context: {
        name?: string;
        system?: string;
        bio?: string;
        topics?: string[];
        style?: { all?: string[]; chat?: string[]; post?: string[] };
        postExamples?: string[];
      },
      mode?: "append" | "replace",
    ): Promise<{ generated: string }>;
    updateCharacter(
      character: CharacterData,
    ): Promise<{ ok: boolean; character: CharacterData; agentName: string }>;
    listCharacterHistory(options?: {
      limit?: number;
      offset?: number;
    }): Promise<CharacterHistoryResponse>;
    listExperiences(
      options?: ExperienceListQuery,
    ): Promise<ExperienceListResponse>;
    getExperienceGraph(
      options?: ExperienceListQuery,
    ): Promise<{ graph: ExperienceGraphResponse }>;
    runExperienceMaintenance(options?: {
      deleteDuplicates?: boolean;
      limit?: number;
    }): Promise<{ result: ExperienceMaintenanceResult }>;
    getExperience(id: string): Promise<{ experience: ExperienceRecord }>;
    updateExperience(
      id: string,
      data: ExperienceUpdateInput,
    ): Promise<{ experience: ExperienceRecord }>;
    deleteExperience(id: string): Promise<{ ok: boolean }>;
    getUpdateStatus(force?: boolean): Promise<UpdateStatus>;
    setUpdateChannel(
      channel: "stable" | "beta" | "nightly",
    ): Promise<{ channel: string }>;
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
    getInstalledAppsToBlock(): Promise<{ apps: AppBlockerInstalledApp[] }>;
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
    spawnShellSession(workdir?: string): Promise<{ sessionId: string }>;
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
    streamGoOffline(): Promise<{ ok: boolean; live: boolean }>;
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
      destination?: { id: string; name: string } | null;
    }>;
    getStreamingDestinations(): Promise<{
      ok: boolean;
      destinations: Array<{ id: string; name: string }>;
    }>;
    setActiveDestination(destinationId: string): Promise<{
      ok: boolean;
      destination?: { id: string; name: string };
    }>;
    setStreamVolume(
      volume: number,
    ): Promise<{ ok: boolean; volume: number; muted: boolean }>;
    muteStream(): Promise<{ ok: boolean; muted: boolean; volume: number }>;
    unmuteStream(): Promise<{ ok: boolean; muted: boolean; volume: number }>;
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
      voice: { enabled: boolean; autoSpeak: boolean };
    }>;
    streamVoiceSpeak(text: string): Promise<{ ok: boolean; speaking: boolean }>;
    getOverlayLayout(
      destinationId?: string | null,
    ): Promise<{ ok: boolean; layout: unknown; destinationId?: string }>;
    saveOverlayLayout(
      layout: unknown,
      destinationId?: string | null,
    ): Promise<{ ok: boolean; layout: unknown; destinationId?: string }>;
    getStreamSource(): Promise<{
      source: { type: string; url?: string };
    }>;
    setStreamSource(
      sourceType: string,
      customUrl?: string,
    ): Promise<{ ok: boolean; source: { type: string; url?: string } }>;
    getStreamSettings(): Promise<{
      ok: boolean;
      settings: { theme?: string; avatarIndex?: number };
    }>;
    saveStreamSettings(settings: {
      theme?: string;
      avatarIndex?: number;
    }): Promise<{ ok: boolean; settings: unknown }>;
  }
}

// ---------------------------------------------------------------------------
// Prototype augmentation
// ---------------------------------------------------------------------------

ElizaClient.prototype.getStatus = async function (this: ElizaClient) {
  try {
    const viaRpc = await invokeDesktopBridgeRequest<AgentStatus>({
      rpcMethod: "getAgentStatus",
      ipcChannel: "agent",
    });
    if (viaRpc) return viaRpc;
  } catch {
    /* fall through */
  }
  return this.fetch("/api/status");
};

ElizaClient.prototype.getAgentSelfStatus = async function (this: ElizaClient) {
  try {
    const viaRpc = await invokeDesktopBridgeRequest<AgentSelfStatusSnapshot>({
      rpcMethod: "getAgentSelfStatus",
      ipcChannel: "agent",
    });
    if (viaRpc) return viaRpc;
  } catch {
    /* fall through */
  }
  return this.fetch("/api/agent/self-status");
};

ElizaClient.prototype.getRuntimeSnapshot = async function (
  this: ElizaClient,
  opts?,
) {
  try {
    const viaRpc = await invokeDesktopBridgeRequest<RuntimeDebugSnapshot>({
      rpcMethod: "getRuntimeSnapshot",
      ipcChannel: "agent",
      params: opts,
    });
    if (viaRpc) return viaRpc;
  } catch {
    /* fall through */
  }
  const params = new URLSearchParams();
  if (typeof opts?.depth === "number") params.set("depth", String(opts.depth));
  if (typeof opts?.maxArrayLength === "number") {
    params.set("maxArrayLength", String(opts.maxArrayLength));
  }
  if (typeof opts?.maxObjectEntries === "number") {
    params.set("maxObjectEntries", String(opts.maxObjectEntries));
  }
  if (typeof opts?.maxStringLength === "number") {
    params.set("maxStringLength", String(opts.maxStringLength));
  }
  const qs = params.toString();
  return this.fetch(`/api/runtime${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.setAutomationMode = async function (
  this: ElizaClient,
  mode,
) {
  return this.fetch("/api/permissions/automation-mode", {
    method: "PUT",
    body: JSON.stringify({ mode }),
  });
};

ElizaClient.prototype.setTradeMode = async function (this: ElizaClient, mode) {
  return this.fetch("/api/permissions/trade-mode", {
    method: "PUT",
    body: JSON.stringify({ mode }),
  });
};

ElizaClient.prototype.playEmote = async function (this: ElizaClient, emoteId) {
  return this.fetch("/api/emote", {
    method: "POST",
    body: JSON.stringify({ emoteId }),
  });
};

ElizaClient.prototype.runTerminalCommand = async function (
  this: ElizaClient,
  command,
) {
  return this.fetch("/api/terminal/run", {
    method: "POST",
    body: JSON.stringify({ command }),
  });
};

ElizaClient.prototype.getOnboardingStatus = async function (this: ElizaClient) {
  // Prefer typed Electrobun RPC. The bun-side composer throws
  // AgentNotReadyError if the agent has no port yet; we catch and
  // fall through to HTTP so the renderer's polling loop sees the
  // same "transport not ready" semantic as before RPC was wired.
  // Server contract: eliza/packages/agent/src/api/onboarding-routes.ts.
  try {
    const viaRpc = await invokeDesktopBridgeRequest<{
      complete: boolean;
      cloudProvisioned?: boolean;
    }>({ rpcMethod: "getOnboardingStatus", ipcChannel: "agent" });
    if (viaRpc) return viaRpc;
  } catch {
    /* AgentNotReadyError or any RPC failure → fall through to HTTP */
  }
  return this.fetch("/api/onboarding/status");
};

ElizaClient.prototype.getWalletKeys = async function (this: ElizaClient) {
  return this.fetch("/api/wallet/keys");
};

ElizaClient.prototype.getWalletOsStoreStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/wallet/os-store");
};

ElizaClient.prototype.postWalletOsStoreAction = async function (
  this: ElizaClient,
  action,
) {
  return this.fetch("/api/wallet/os-store", {
    method: "POST",
    body: JSON.stringify({ action }),
  });
};

ElizaClient.prototype.getAuthStatus = async function (this: ElizaClient) {
  // Prefer typed Electrobun RPC. Throws AgentNotReadyError when the
  // agent has no port yet — we catch and fall through to HTTP so the
  // existing retry/backoff loop handles the "not ready" semantic
  // exactly as it did before RPC was in the picture. NEVER fabricates
  // a 401-shaped placeholder (see the auth-client.ts authMe wrapper
  // history if you need the bug story).
  try {
    const viaRpc = await invokeDesktopBridgeRequest<{
      required: boolean;
      pairingEnabled: boolean;
      expiresAt: number | null;
      authenticated?: boolean;
      loginRequired?: boolean;
      bootstrapRequired?: boolean;
      localAccess?: boolean;
      passwordConfigured?: boolean;
    }>({ rpcMethod: "getAuthStatus", ipcChannel: "agent" });
    if (viaRpc) return viaRpc;
  } catch {
    /* AgentNotReadyError or any RPC failure → fall through to HTTP */
  }

  const maxRetries = 3;
  const baseBackoffMs = 1000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await this.fetch("/api/auth/status");
    } catch (err: unknown) {
      const status = (err as Error & { status?: number })?.status;
      if (status === 401) {
        return { required: true, pairingEnabled: false, expiresAt: null };
      }
      if (status === 404) {
        return { required: false, pairingEnabled: false, expiresAt: null };
      }
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, baseBackoffMs * 2 ** attempt));
      }
    }
  }
  throw lastErr;
};

ElizaClient.prototype.postBootstrapExchange = async function (
  this: ElizaClient,
  token: string,
): Promise<BootstrapExchangeResult> {
  // Use allowNonOk so 401/429/503 bodies are parsed rather than thrown.
  const body = await this.fetch<{
    sessionId?: string;
    expiresAt?: number;
    identityId?: string;
    error?: string;
    reason?: string;
  }>(
    "/api/auth/bootstrap/exchange",
    {
      method: "POST",
      body: JSON.stringify({ token }),
    },
    { allowNonOk: true },
  );

  if (
    typeof body.sessionId === "string" &&
    typeof body.expiresAt === "number" &&
    typeof body.identityId === "string"
  ) {
    return {
      ok: true,
      sessionId: body.sessionId,
      expiresAt: body.expiresAt,
      identityId: body.identityId,
    };
  }

  // Map reason to an HTTP status bucket for the UI layer.
  const reason = body.reason;
  const status: 400 | 401 | 429 | 503 =
    reason === "rate_limited"
      ? 429
      : reason === "db_unavailable" ||
          reason === "missing_issuer_env" ||
          reason === "missing_container_env"
        ? 503
        : reason === "missing_token"
          ? 400
          : 401;
  return {
    ok: false,
    status,
    error: body.error ?? "exchange_failed",
    reason,
  };
};

ElizaClient.prototype.pair = async function (this: ElizaClient, code) {
  const res = await this.fetch<{ token: string }>("/api/auth/pair", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
  return res;
};

ElizaClient.prototype.getOnboardingOptions = async function (
  this: ElizaClient,
) {
  try {
    const viaRpc = await invokeDesktopBridgeRequest<OnboardingOptions>({
      rpcMethod: "getOnboardingOptions",
      ipcChannel: "agent",
    });
    if (viaRpc) return viaRpc;
  } catch {
    /* AgentNotReadyError or any RPC failure → fall through to HTTP */
  }
  return this.fetch("/api/onboarding/options");
};

ElizaClient.prototype.submitOnboarding = async function (
  this: ElizaClient,
  data,
) {
  await this.fetch("/api/onboarding", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.startAnthropicLogin = async function (this: ElizaClient) {
  return this.fetch("/api/subscription/anthropic/start", { method: "POST" });
};

ElizaClient.prototype.exchangeAnthropicCode = async function (
  this: ElizaClient,
  code,
) {
  return this.fetch("/api/subscription/anthropic/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
};

ElizaClient.prototype.submitAnthropicSetupToken = async function (
  this: ElizaClient,
  token,
) {
  return this.fetch("/api/subscription/anthropic/setup-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
};

ElizaClient.prototype.getSubscriptionStatus = async function (
  this: ElizaClient,
) {
  try {
    const viaRpc = await invokeDesktopBridgeRequest<SubscriptionStatusResponse>(
      {
        rpcMethod: "getSubscriptionStatus",
        ipcChannel: "agent",
      },
    );
    if (viaRpc) return viaRpc;
  } catch {
    /* fall through */
  }
  return this.fetch<SubscriptionStatusResponse>("/api/subscription/status");
};

ElizaClient.prototype.deleteSubscription = async function (
  this: ElizaClient,
  provider,
) {
  return this.fetch(`/api/subscription/${encodeURIComponent(provider)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.switchProvider = async function (
  this: ElizaClient,
  provider,
  apiKey?,
  primaryModel?,
  options?,
) {
  logSettingsClient("POST /api/provider/switch → start", {
    baseUrl: this.getBaseUrl(),
    provider,
    hasApiKey: Boolean(apiKey?.trim()),
    apiKey,
    hasPrimaryModel: Boolean(primaryModel?.trim()),
    primaryModel,
    useLocalEmbeddings: options?.useLocalEmbeddings,
  });
  const result = (await this.fetch("/api/provider/switch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      ...(apiKey ? { apiKey } : {}),
      ...(primaryModel ? { primaryModel } : {}),
      ...(options?.useLocalEmbeddings != null
        ? { useLocalEmbeddings: options.useLocalEmbeddings }
        : {}),
    }),
  })) as { success: boolean; provider: string; restarting: boolean };
  logSettingsClient("POST /api/provider/switch ← ok", {
    baseUrl: this.getBaseUrl(),
    result,
  });
  return result;
};

ElizaClient.prototype.startOpenAILogin = async function (this: ElizaClient) {
  return this.fetch("/api/subscription/openai/start", { method: "POST" });
};

ElizaClient.prototype.exchangeOpenAICode = async function (
  this: ElizaClient,
  code,
) {
  return this.fetch("/api/subscription/openai/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
};

ElizaClient.prototype.startAgent = async function (this: ElizaClient) {
  const res = await this.fetch<{ status: AgentStatus }>("/api/agent/start", {
    method: "POST",
  });
  return res.status;
};

ElizaClient.prototype.stopAgent = async function (this: ElizaClient) {
  const res = await this.fetch<{ status: AgentStatus }>("/api/agent/stop", {
    method: "POST",
  });
  return res.status;
};

ElizaClient.prototype.pauseAgent = async function (this: ElizaClient) {
  const res = await this.fetch<{ status: AgentStatus }>("/api/agent/pause", {
    method: "POST",
  });
  return res.status;
};

ElizaClient.prototype.resumeAgent = async function (this: ElizaClient) {
  const res = await this.fetch<{ status: AgentStatus }>("/api/agent/resume", {
    method: "POST",
  });
  return res.status;
};

ElizaClient.prototype.restartAgent = async function (this: ElizaClient) {
  try {
    const res = await this.fetch<{ status: AgentStatus }>(
      "/api/agent/restart",
      {
        method: "POST",
      },
    );
    return res.status;
  } catch {
    // Back-compat for older runtimes that still expose only the process-level
    // restart endpoint.
    await this.fetch<{ ok: boolean }>("/api/restart", { method: "POST" });
    return {
      state: "restarting",
      agentName: "Eliza",
      model: undefined,
      uptime: undefined,
      startedAt: undefined,
    };
  }
};

ElizaClient.prototype.restartAndWait = async function (
  this: ElizaClient,
  maxWaitMs = 30000,
) {
  const t0 = Date.now();
  console.info("[eliza][reset][client] restartAndWait: begin", {
    baseUrl: this.getBaseUrl(),
    maxWaitMs,
  });
  try {
    await this.restartAgent();
    console.info("[eliza][reset][client] restartAndWait: restart accepted");
  } catch (e: unknown) {
    console.info(
      "[eliza][reset][client] restartAndWait: initial restart call failed (often 409 while restarting)",
      e,
    );
  }
  const start = Date.now();
  const interval = 1000;
  let pollN = 0;
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, interval));
    pollN += 1;
    try {
      const status = await this.getStatus();
      if (status.state === "running") {
        console.info("[eliza][reset][client] restartAndWait: running", {
          pollN,
          waitedMs: Date.now() - t0,
          port: status.port,
        });
        return status;
      }
      if (pollN === 1 || pollN % 5 === 0) {
        console.debug("[eliza][reset][client] restartAndWait: poll", {
          pollN,
          state: status.state,
          waitedMs: Date.now() - t0,
        });
      }
    } catch (pollErr) {
      if (pollN === 1 || pollN % 5 === 0) {
        console.debug(
          "[eliza][reset][client] restartAndWait: getStatus error while polling",
          { pollN, waitedMs: Date.now() - t0 },
          pollErr,
        );
      }
    }
  }
  const final = await this.getStatus();
  console.warn(
    "[eliza][reset][client] restartAndWait: timed out — returning last status",
    {
      state: final.state,
      waitedMs: Date.now() - t0,
      maxWaitMs,
    },
  );
  return final;
};

ElizaClient.prototype.resetAgent = async function (this: ElizaClient) {
  console.info("[eliza][reset][client] POST /api/agent/reset", {
    baseUrl: this.getBaseUrl(),
  });
  await this.fetch("/api/agent/reset", { method: "POST" });
  console.info("[eliza][reset][client] POST /api/agent/reset OK");
};

ElizaClient.prototype.restart = async function (this: ElizaClient) {
  return this.fetch("/api/restart", { method: "POST" });
};

ElizaClient.prototype.getConfig = async function (this: ElizaClient) {
  logSettingsClient("GET /api/config → start", {
    baseUrl: this.getBaseUrl(),
  });
  let viaRpc: Record<string, unknown> | null = null;
  try {
    viaRpc = await invokeDesktopBridgeRequest<Record<string, unknown>>({
      rpcMethod: "getConfig",
      ipcChannel: "agent",
    });
  } catch {
    /* AgentNotReadyError or any RPC failure → fall through to HTTP */
  }
  const r =
    viaRpc ?? ((await this.fetch("/api/config")) as Record<string, unknown>);
  const cloud = r.cloud as Record<string, unknown> | undefined;
  logSettingsClient("GET /api/config ← ok", {
    baseUrl: this.getBaseUrl(),
    topKeys: Object.keys(r).sort(),
    cloud: settingsDebugCloudSummary(cloud),
    transport: viaRpc ? "rpc" : "http",
  });
  return r;
};

ElizaClient.prototype.getConfigSchema = async function (this: ElizaClient) {
  try {
    const viaRpc = await invokeDesktopBridgeRequest<ConfigSchemaResponse>({
      rpcMethod: "getConfigSchema",
      ipcChannel: "agent",
    });
    if (viaRpc) return viaRpc;
  } catch {
    /* fall through */
  }
  return this.fetch("/api/config/schema");
};

ElizaClient.prototype.updateConfig = async function (this: ElizaClient, patch) {
  logSettingsClient("PUT /api/config → start", {
    baseUrl: this.getBaseUrl(),
    patch,
  });
  const out = (await this.fetch(
    "/api/config",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
    {
      timeoutMs: SETTINGS_MUTATION_TIMEOUT_MS,
    },
  )) as Record<string, unknown>;
  const cloud = out.cloud as Record<string, unknown> | undefined;
  logSettingsClient("PUT /api/config ← ok", {
    baseUrl: this.getBaseUrl(),
    topKeys: Object.keys(out).sort(),
    cloud: settingsDebugCloudSummary(cloud),
  });
  return out;
};

ElizaClient.prototype.uploadCustomVrm = async function (
  this: ElizaClient,
  file,
) {
  const buf = await file.arrayBuffer();
  await this.fetch("/api/avatar/vrm", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: buf,
  });
};

ElizaClient.prototype.hasCustomVrm = async function (this: ElizaClient) {
  try {
    const res = await this.rawRequest(
      "/api/avatar/vrm",
      { method: "HEAD" },
      { allowNonOk: true },
    );
    return res.ok;
  } catch {
    return false;
  }
};

ElizaClient.prototype.uploadCustomBackground = async function (
  this: ElizaClient,
  file,
) {
  const buf = await file.arrayBuffer();
  await this.fetch("/api/avatar/background", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: buf,
  });
};

ElizaClient.prototype.hasCustomBackground = async function (this: ElizaClient) {
  try {
    const res = await this.rawRequest(
      "/api/avatar/background",
      { method: "HEAD" },
      { allowNonOk: true },
    );
    return res.ok;
  } catch {
    return false;
  }
};

ElizaClient.prototype.getConnectors = async function (this: ElizaClient) {
  return this.fetch("/api/connectors");
};

ElizaClient.prototype.saveConnector = async function (
  this: ElizaClient,
  name,
  config,
) {
  return this.fetch("/api/connectors", {
    method: "POST",
    body: JSON.stringify({ name, config }),
  });
};

ElizaClient.prototype.deleteConnector = async function (
  this: ElizaClient,
  name,
) {
  return this.fetch(`/api/connectors/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
};

function connectorAccountsPath(
  provider: string,
  _connectorId?: string,
  accountId?: string,
  action?: "test" | "refresh" | "default",
): string {
  const base = `/api/connectors/${encodeURIComponent(provider)}/accounts`;
  if (!accountId) return base;
  const withAccount = `${base}/${encodeURIComponent(accountId)}`;
  return action ? `${withAccount}/${action}` : withAccount;
}

function connectorAccountOAuthPath(
  provider: string,
  action: "start" | "status",
): string {
  return `/api/connectors/${encodeURIComponent(provider)}/oauth/${action}`;
}

function normalizeConnectorAccountRole(
  value: unknown,
): ConnectorAccountRole | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().toUpperCase();
  switch (normalized) {
    case "OWNER":
      return "OWNER";
    case "AGENT":
    case "SERVICE":
      return "AGENT";
    case "TEAM":
    case "ADMIN":
    case "MEMBER":
    case "VIEWER":
      return "TEAM";
    default:
      return undefined;
  }
}

function normalizeConnectorStatus(value: unknown): ConnectorAccountStatus {
  switch (value) {
    case "connected":
    case "pending":
    case "needs-reauth":
    case "disconnected":
    case "error":
      return value;
    case "disabled":
    case "revoked":
      return "disconnected";
    default:
      return "unknown";
  }
}

function isConnectorRoleValue(value: unknown): value is ConnectorAccountRole {
  return normalizeConnectorAccountRole(value) !== undefined;
}

function normalizeConnectorPurposeList(
  value: unknown,
): ConnectorAccountPurpose[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  return values
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(
      (item): item is ConnectorAccountPurpose =>
        Boolean(item) && !isConnectorRoleValue(item),
    );
}

function normalizeConnectorAccountRecord(
  provider: string,
  connectorId: string,
  raw: unknown,
): ConnectorAccountRecord {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const role =
    normalizeConnectorAccountRole(record.role) ??
    normalizeConnectorAccountRole(record.purpose) ??
    "OWNER";
  const purpose = normalizeConnectorPurposeList(record.purpose);
  const label =
    typeof record.label === "string" && record.label.trim()
      ? record.label
      : typeof record.displayHandle === "string" && record.displayHandle.trim()
        ? record.displayHandle
        : typeof record.handle === "string" && record.handle.trim()
          ? record.handle
          : typeof record.externalId === "string" && record.externalId.trim()
            ? record.externalId
            : String(record.id ?? "unknown");
  return {
    ...(record as Partial<ConnectorAccountRecord>),
    id: String(record.id ?? ""),
    provider:
      typeof record.provider === "string" && record.provider
        ? record.provider
        : provider,
    connectorId,
    label,
    handle:
      typeof record.handle === "string"
        ? record.handle
        : typeof record.displayHandle === "string"
          ? record.displayHandle
          : null,
    externalId:
      typeof record.externalId === "string" ? record.externalId : null,
    status: normalizeConnectorStatus(record.status),
    role,
    purpose,
    isDefault: record.isDefault === true,
    enabled: record.enabled !== false,
    metadata:
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : undefined,
  };
}

function normalizeConnectorAccountsListResponse(
  provider: string,
  connectorId: string,
  raw: unknown,
): ConnectorAccountsListResponse {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const accounts = Array.isArray(record.accounts)
    ? record.accounts.map((item) =>
        normalizeConnectorAccountRecord(provider, connectorId, item),
      )
    : [];
  const defaultAccountId =
    typeof record.defaultAccountId === "string"
      ? record.defaultAccountId
      : (accounts.find(
          (account) =>
            account.isDefault === true &&
            account.enabled !== false &&
            account.status === "connected",
        )?.id ?? null);
  return {
    provider:
      typeof record.provider === "string" && record.provider
        ? record.provider
        : provider,
    connectorId,
    defaultAccountId,
    accounts,
  };
}

function normalizeConnectorAccountActionResult(
  provider: string,
  connectorId: string,
  raw: unknown,
): ConnectorAccountActionResult {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const account =
    record.account ?? (typeof record.id === "string" ? record : null);
  const flow =
    record.flow &&
    typeof record.flow === "object" &&
    !Array.isArray(record.flow)
      ? (record.flow as Record<string, unknown>)
      : null;
  return {
    ...(record as Partial<ConnectorAccountActionResult>),
    ok:
      typeof record.ok === "boolean"
        ? record.ok
        : record.deleted === true || (!("error" in record) && account !== null),
    account: account
      ? normalizeConnectorAccountRecord(provider, connectorId, account)
      : undefined,
    accounts: Array.isArray(record.accounts)
      ? record.accounts.map((item) =>
          normalizeConnectorAccountRecord(provider, connectorId, item),
        )
      : undefined,
    defaultAccountId:
      typeof record.defaultAccountId === "string"
        ? record.defaultAccountId
        : null,
    flow: flow ?? undefined,
    authUrl:
      typeof record.authUrl === "string"
        ? record.authUrl
        : typeof flow?.authUrl === "string"
          ? flow.authUrl
          : undefined,
    status:
      typeof record.status === "string"
        ? normalizeConnectorStatus(record.status)
        : typeof flow?.status === "string"
          ? normalizeConnectorStatus(flow.status)
          : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

function connectorAccountAuditPath(
  provider: string,
  query: ConnectorAccountAuditEventsQuery = {},
): string {
  const params = new URLSearchParams();
  if (query.accountId) params.set("accountId", query.accountId);
  if (query.action) params.set("action", query.action);
  if (query.outcome) params.set("outcome", query.outcome);
  if (typeof query.limit === "number") {
    params.set("limit", String(query.limit));
  }
  const qs = params.toString();
  return `/api/connectors/${encodeURIComponent(provider)}/audit/events${
    qs ? `?${qs}` : ""
  }`;
}

ElizaClient.prototype.listConnectorAccounts = async function (
  this: ElizaClient,
  provider,
  connectorId = provider,
) {
  const response = await this.fetch<unknown>(
    connectorAccountsPath(provider, connectorId),
  );
  return normalizeConnectorAccountsListResponse(
    provider,
    connectorId,
    response,
  );
};

ElizaClient.prototype.addConnectorAccount = async function (
  this: ElizaClient,
  provider,
  connectorId = provider,
  body = {},
) {
  const response = await this.fetch<unknown>(
    connectorAccountsPath(provider, connectorId),
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
  return normalizeConnectorAccountActionResult(provider, connectorId, response);
};

ElizaClient.prototype.startConnectorAccountOAuth = async function (
  this: ElizaClient,
  provider,
  connectorId = provider,
  body = {},
) {
  const response = await this.fetch<unknown>(
    connectorAccountOAuthPath(provider, "start"),
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
  return normalizeConnectorAccountActionResult(provider, connectorId, response);
};

ElizaClient.prototype.patchConnectorAccount = async function (
  this: ElizaClient,
  provider,
  connectorId = provider,
  accountId,
  body,
) {
  const response = await this.fetch<unknown>(
    connectorAccountsPath(provider, connectorId, accountId),
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
  );
  return normalizeConnectorAccountRecord(provider, connectorId, response);
};

ElizaClient.prototype.testConnectorAccount = async function (
  this: ElizaClient,
  provider,
  connectorId = provider,
  accountId,
) {
  const response = await this.fetch<unknown>(
    connectorAccountsPath(provider, connectorId, accountId, "test"),
    { method: "POST" },
  );
  return normalizeConnectorAccountActionResult(provider, connectorId, response);
};

ElizaClient.prototype.refreshConnectorAccount = async function (
  this: ElizaClient,
  provider,
  connectorId = provider,
  accountId,
) {
  const response = await this.fetch<unknown>(
    connectorAccountsPath(provider, connectorId, accountId, "refresh"),
    { method: "POST" },
  );
  return normalizeConnectorAccountActionResult(provider, connectorId, response);
};

ElizaClient.prototype.deleteConnectorAccount = async function (
  this: ElizaClient,
  provider,
  connectorId = provider,
  accountId,
) {
  const response = await this.fetch<unknown>(
    connectorAccountsPath(provider, connectorId, accountId),
    { method: "DELETE" },
  );
  return normalizeConnectorAccountActionResult(provider, connectorId, response);
};

ElizaClient.prototype.makeDefaultConnectorAccount = async function (
  this: ElizaClient,
  provider,
  connectorId = provider,
  accountId,
) {
  const response = await this.fetch<unknown>(
    connectorAccountsPath(provider, connectorId, accountId, "default"),
    { method: "POST" },
  );
  return normalizeConnectorAccountActionResult(provider, connectorId, response);
};

ElizaClient.prototype.listConnectorAccountAuditEvents = async function (
  this: ElizaClient,
  provider,
  query = {},
) {
  return this.fetch<ConnectorAccountAuditEventsResponse>(
    connectorAccountAuditPath(provider, query),
  );
};

ElizaClient.prototype.getTriggers = async function (this: ElizaClient) {
  return this.fetch("/api/triggers");
};

ElizaClient.prototype.getTrigger = async function (this: ElizaClient, id) {
  return this.fetch(`/api/triggers/${encodeURIComponent(id)}`);
};

ElizaClient.prototype.createTrigger = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/triggers", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.updateTrigger = async function (
  this: ElizaClient,
  id,
  request,
) {
  return this.fetch(`/api/triggers/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.deleteTrigger = async function (this: ElizaClient, id) {
  return this.fetch(`/api/triggers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.runTriggerNow = async function (this: ElizaClient, id) {
  return this.fetch(`/api/triggers/${encodeURIComponent(id)}/execute`, {
    method: "POST",
  });
};

ElizaClient.prototype.getTriggerRuns = async function (this: ElizaClient, id) {
  return this.fetch(`/api/triggers/${encodeURIComponent(id)}/runs`);
};

ElizaClient.prototype.emitTriggerEvent = async function (
  this: ElizaClient,
  eventKind,
  payload = {},
) {
  return this.fetch(`/api/triggers/events/${encodeURIComponent(eventKind)}`, {
    method: "POST",
    body: JSON.stringify({ payload }),
  });
};

ElizaClient.prototype.getTriggerHealth = async function (this: ElizaClient) {
  try {
    const viaRpc = await invokeDesktopBridgeRequest<TriggerHealthSnapshot>({
      rpcMethod: "getTriggerHealth",
      ipcChannel: "agent",
    });
    if (viaRpc) return viaRpc;
  } catch {
    /* fall through */
  }
  return this.fetch("/api/triggers/health");
};

ElizaClient.prototype.getTrainingStatus = async function (this: ElizaClient) {
  return this.fetch("/api/training/status");
};

ElizaClient.prototype.listTrainingTrajectories = async function (
  this: ElizaClient,
  opts?,
) {
  const params = new URLSearchParams();
  if (typeof opts?.limit === "number") params.set("limit", String(opts.limit));
  if (typeof opts?.offset === "number")
    params.set("offset", String(opts.offset));
  const qs = params.toString();
  return this.fetch(`/api/training/trajectories${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.getTrainingTrajectory = async function (
  this: ElizaClient,
  trajectoryId,
) {
  return this.fetch(
    `/api/training/trajectories/${encodeURIComponent(trajectoryId)}`,
  );
};

ElizaClient.prototype.listTrainingDatasets = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/training/datasets");
};

ElizaClient.prototype.buildTrainingDataset = async function (
  this: ElizaClient,
  options?,
) {
  return this.fetch("/api/training/datasets/build", {
    method: "POST",
    body: JSON.stringify(options ?? {}),
  });
};

ElizaClient.prototype.listTrainingJobs = async function (this: ElizaClient) {
  return this.fetch("/api/training/jobs");
};

ElizaClient.prototype.startTrainingJob = async function (
  this: ElizaClient,
  options?,
) {
  return this.fetch("/api/training/jobs", {
    method: "POST",
    body: JSON.stringify(options ?? {}),
  });
};

ElizaClient.prototype.getTrainingJob = async function (
  this: ElizaClient,
  jobId,
) {
  return this.fetch(`/api/training/jobs/${encodeURIComponent(jobId)}`);
};

ElizaClient.prototype.cancelTrainingJob = async function (
  this: ElizaClient,
  jobId,
) {
  return this.fetch(`/api/training/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
};

ElizaClient.prototype.listTrainingModels = async function (this: ElizaClient) {
  return this.fetch("/api/training/models");
};

ElizaClient.prototype.importTrainingModelToOllama = async function (
  this: ElizaClient,
  modelId,
  options?,
) {
  return this.fetch(
    `/api/training/models/${encodeURIComponent(modelId)}/import-ollama`,
    {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    },
  );
};

ElizaClient.prototype.activateTrainingModel = async function (
  this: ElizaClient,
  modelId,
  providerModel?,
) {
  return this.fetch(
    `/api/training/models/${encodeURIComponent(modelId)}/activate`,
    {
      method: "POST",
      body: JSON.stringify({ providerModel }),
    },
  );
};

ElizaClient.prototype.benchmarkTrainingModel = async function (
  this: ElizaClient,
  modelId,
) {
  return this.fetch(
    `/api/training/models/${encodeURIComponent(modelId)}/benchmark`,
    { method: "POST" },
  );
};

ElizaClient.prototype.getPlugins = async function (this: ElizaClient) {
  return this.fetch("/api/plugins");
};

ElizaClient.prototype.fetchModels = async function (
  this: ElizaClient,
  provider,
  refresh = true,
) {
  const params = new URLSearchParams({ provider });
  if (refresh) params.set("refresh", "true");
  return this.fetch(`/api/models?${params.toString()}`);
};

ElizaClient.prototype.getCorePlugins = async function (this: ElizaClient) {
  try {
    const viaRpc = await invokeDesktopBridgeRequest<CorePluginsResponse>({
      rpcMethod: "getCorePlugins",
      ipcChannel: "agent",
    });
    if (viaRpc) return viaRpc;
  } catch {
    /* fall through */
  }
  return this.fetch("/api/plugins/core");
};

ElizaClient.prototype.toggleCorePlugin = async function (
  this: ElizaClient,
  npmName,
  enabled,
) {
  return this.fetch("/api/plugins/core/toggle", {
    method: "POST",
    body: JSON.stringify({ npmName, enabled }),
  });
};

ElizaClient.prototype.updatePlugin = async function (
  this: ElizaClient,
  id,
  config,
) {
  logSettingsClient(`PUT /api/plugins/${id} → start`, {
    baseUrl: this.getBaseUrl(),
    body: config,
  });
  const result = (await this.fetch(
    `/api/plugins/${id}`,
    {
      method: "PUT",
      body: JSON.stringify(config),
    },
    {
      timeoutMs: SETTINGS_MUTATION_TIMEOUT_MS,
    },
  )) as PluginMutationResult;
  logSettingsClient(`PUT /api/plugins/${id} ← ok`, {
    baseUrl: this.getBaseUrl(),
    result,
  });
  return result;
};

ElizaClient.prototype.getSecrets = async function (this: ElizaClient) {
  return this.fetch("/api/secrets");
};

ElizaClient.prototype.updateSecrets = async function (
  this: ElizaClient,
  secrets,
) {
  logSettingsClient("PUT /api/secrets → start", {
    baseUrl: this.getBaseUrl(),
    secretMeta: Object.keys(secrets)
      .sort()
      .map((key) => ({
        key,
        hasValue: Boolean(secrets[key]),
      })),
  });
  const out = (await this.fetch("/api/secrets", {
    method: "PUT",
    body: JSON.stringify({ secrets }),
  })) as { ok: boolean; updated: string[] };
  logSettingsClient("PUT /api/secrets ← ok", {
    baseUrl: this.getBaseUrl(),
    out,
  });
  return out;
};

ElizaClient.prototype.testPluginConnection = async function (
  this: ElizaClient,
  id,
) {
  return this.fetch(`/api/plugins/${encodeURIComponent(id)}/test`, {
    method: "POST",
  });
};

ElizaClient.prototype.getLogs = async function (this: ElizaClient, filter?) {
  const params = new URLSearchParams();
  if (filter?.source) params.set("source", filter.source);
  if (filter?.level) params.set("level", filter.level);
  if (filter?.tag) params.set("tag", filter.tag);
  if (filter?.since) params.set("since", String(filter.since));
  const qs = params.toString();
  return this.fetch(`/api/logs${qs ? `?${qs}` : ""}`);
};

// buildSecurityAuditParams is a private helper used only by agent audit methods
function buildSecurityAuditParams(
  filter?: SecurityAuditFilter,
  includeStream = false,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filter?.type) params.set("type", filter.type);
  if (filter?.severity) params.set("severity", filter.severity);
  if (filter?.since !== undefined) {
    const sinceValue =
      filter.since instanceof Date
        ? filter.since.toISOString()
        : String(filter.since);
    params.set("since", sinceValue);
  }
  if (filter?.limit !== undefined) params.set("limit", String(filter.limit));
  if (includeStream) params.set("stream", "1");
  return params;
}

ElizaClient.prototype.getSecurityAudit = async function (
  this: ElizaClient,
  filter?,
) {
  const qs = buildSecurityAuditParams(filter).toString();
  return this.fetch(`/api/security/audit${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.streamSecurityAudit = async function (
  this: ElizaClient,
  onEvent,
  filter?,
  signal?,
) {
  if (!this.apiAvailable) {
    throw new Error("API not available (no HTTP origin)");
  }

  const token = this.apiToken;
  const qs = buildSecurityAuditParams(filter, true).toString();
  const res = await fetch(
    `${this.baseUrl}/api/security/audit${qs ? `?${qs}` : ""}`,
    {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal,
    },
  );

  if (!res.ok) {
    const body = (await res
      .json()
      .catch(() => ({ error: res.statusText }))) as Record<
      string,
      string
    > | null;
    const err = new Error(body?.error ?? `HTTP ${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  if (!res.body) {
    throw new Error("Streaming not supported by this browser");
  }

  const parsePayload = (payload: string) => {
    if (!payload) return;
    try {
      const parsed = JSON.parse(payload) as SecurityAuditStreamEvent;
      if (parsed.type === "snapshot" || parsed.type === "entry") {
        onEvent(parsed);
      }
    } catch {
      // Ignore malformed payloads to keep stream consumption resilient.
    }
  };

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";

  const findSseEventBreak = (
    chunkBuffer: string,
  ): { index: number; length: number } | null => {
    const lfBreak = chunkBuffer.indexOf("\n\n");
    const crlfBreak = chunkBuffer.indexOf("\r\n\r\n");
    if (lfBreak === -1 && crlfBreak === -1) return null;
    if (lfBreak === -1) return { index: crlfBreak, length: 4 };
    if (crlfBreak === -1) return { index: lfBreak, length: 2 };
    return lfBreak < crlfBreak
      ? { index: lfBreak, length: 2 }
      : { index: crlfBreak, length: 4 };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let eventBreak = findSseEventBreak(buffer);
    while (eventBreak) {
      const rawEvent = buffer.slice(0, eventBreak.index);
      buffer = buffer.slice(eventBreak.index + eventBreak.length);
      for (const line of rawEvent.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        parsePayload(line.slice(5).trim());
      }
      eventBreak = findSseEventBreak(buffer);
    }
  }

  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      parsePayload(line.slice(5).trim());
    }
  }
};

ElizaClient.prototype.getAgentEvents = async function (
  this: ElizaClient,
  opts?,
) {
  const params = new URLSearchParams();
  if (opts?.afterEventId) params.set("after", opts.afterEventId);
  if (typeof opts?.limit === "number") params.set("limit", String(opts.limit));
  if (opts?.runId) params.set("runId", opts.runId);
  if (typeof opts?.fromSeq === "number")
    params.set("fromSeq", String(Math.trunc(opts.fromSeq)));
  const qs = params.toString();
  return this.fetch(`/api/agent/events${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.getExtensionStatus = async function (this: ElizaClient) {
  try {
    const viaRpc = await invokeDesktopBridgeRequest<ExtensionStatus>({
      rpcMethod: "getExtensionStatus",
      ipcChannel: "agent",
    });
    if (viaRpc) return viaRpc;
  } catch {
    /* fall through */
  }
  return this.fetch("/api/extension/status");
};

ElizaClient.prototype.getRelationshipsGraph = async function (
  this: ElizaClient,
  query,
) {
  const params = new URLSearchParams();
  if (query?.search) params.set("search", query.search);
  if (query?.platform) params.set("platform", query.platform);
  if (query?.scope) params.set("scope", query.scope);
  if (typeof query?.limit === "number")
    params.set("limit", String(query.limit));
  if (typeof query?.offset === "number")
    params.set("offset", String(query.offset));
  const qs = params.toString();
  const response = await this.fetch<{ data: RelationshipsGraphSnapshot }>(
    `/api/relationships/graph${qs ? `?${qs}` : ""}`,
  );
  return response.data;
};

ElizaClient.prototype.getRelationshipsPeople = async function (
  this: ElizaClient,
  query,
) {
  const params = new URLSearchParams();
  if (query?.search) params.set("search", query.search);
  if (query?.platform) params.set("platform", query.platform);
  if (query?.scope) params.set("scope", query.scope);
  if (typeof query?.limit === "number")
    params.set("limit", String(query.limit));
  if (typeof query?.offset === "number")
    params.set("offset", String(query.offset));
  const qs = params.toString();
  const response = await this.fetch<{
    data: RelationshipsPersonSummary[];
    stats: RelationshipsGraphStats;
  }>(`/api/relationships/people${qs ? `?${qs}` : ""}`);
  return {
    people: response.data,
    stats: response.stats,
  };
};

ElizaClient.prototype.getRelationshipsPerson = async function (
  this: ElizaClient,
  id,
) {
  const response = await this.fetch<{ data: RelationshipsPersonDetail }>(
    `/api/relationships/people/${encodeURIComponent(id)}`,
  );
  return response.data;
};

ElizaClient.prototype.getRelationshipsActivity = async function (
  this: ElizaClient,
  limit?,
  offset?,
) {
  const params = new URLSearchParams();
  if (typeof limit === "number") params.set("limit", String(limit));
  if (typeof offset === "number") params.set("offset", String(offset));
  const qs = params.toString();
  return this.fetch<RelationshipsActivityResponse>(
    `/api/relationships/activity${qs ? `?${qs}` : ""}`,
  );
};

ElizaClient.prototype.getRelationshipsCandidates = async function (
  this: ElizaClient,
) {
  const response = await this.fetch<{ data: RelationshipsMergeCandidate[] }>(
    "/api/relationships/candidates",
  );
  return response.data;
};

ElizaClient.prototype.acceptRelationshipsCandidate = async function (
  this: ElizaClient,
  candidateId,
) {
  const response = await this.fetch<{ data: { id: string; status: string } }>(
    `/api/relationships/candidates/${encodeURIComponent(candidateId)}/accept`,
    { method: "POST" },
  );
  return response.data;
};

ElizaClient.prototype.rejectRelationshipsCandidate = async function (
  this: ElizaClient,
  candidateId,
) {
  const response = await this.fetch<{ data: { id: string; status: string } }>(
    `/api/relationships/candidates/${encodeURIComponent(candidateId)}/reject`,
    { method: "POST" },
  );
  return response.data;
};

ElizaClient.prototype.proposeRelationshipsLink = async function (
  this: ElizaClient,
  sourceEntityId,
  targetEntityId,
  evidence,
) {
  const response = await this.fetch<{ data: { id: string; status: string } }>(
    `/api/relationships/people/${encodeURIComponent(sourceEntityId)}/link`,
    {
      method: "POST",
      body: JSON.stringify({
        targetEntityId,
        evidence: evidence ?? {},
      }),
      headers: { "Content-Type": "application/json" },
    },
  );
  return response.data;
};

ElizaClient.prototype.getCharacter = async function (this: ElizaClient) {
  // RPC composer forwards the `/api/character` body verbatim, so the
  // wire shape is `{ character, agentName }` — bun-side just types it
  // loosely as Record. Catch swallows AgentNotReadyError + transport
  // failure → fall through to HTTP.
  try {
    const viaRpc = await invokeDesktopBridgeRequest<{
      character: CharacterData;
      agentName: string;
    }>({ rpcMethod: "getCharacter", ipcChannel: "agent" });
    if (viaRpc) return viaRpc;
  } catch {
    /* fall through */
  }
  return this.fetch("/api/character");
};

ElizaClient.prototype.getRandomName = async function (this: ElizaClient) {
  return this.fetch("/api/character/random-name");
};

ElizaClient.prototype.generateCharacterField = async function (
  this: ElizaClient,
  field,
  context,
  mode?,
) {
  return this.fetch("/api/character/generate", {
    method: "POST",
    body: JSON.stringify({ field, context, mode }),
  });
};

ElizaClient.prototype.updateCharacter = async function (
  this: ElizaClient,
  character,
) {
  return this.fetch("/api/character", {
    method: "PUT",
    body: JSON.stringify(character),
  });
};

ElizaClient.prototype.listCharacterHistory = async function (
  this: ElizaClient,
  options,
) {
  const params = new URLSearchParams();
  if (typeof options?.limit === "number") {
    params.set("limit", String(options.limit));
  }
  if (typeof options?.offset === "number") {
    params.set("offset", String(options.offset));
  }
  const qs = params.toString();
  return this.fetch(`/api/character/history${qs ? `?${qs}` : ""}`);
};

ElizaClient.prototype.listExperiences = async function (
  this: ElizaClient,
  options,
) {
  const params = new URLSearchParams();
  const appendMulti = (key: string, value?: string | string[]) => {
    if (Array.isArray(value)) {
      value
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach((item) => {
          params.append(key, item);
        });
      return;
    }
    if (typeof value === "string" && value.trim()) {
      params.append(key, value.trim());
    }
  };

  if (typeof options?.limit === "number") {
    params.set("limit", String(options.limit));
  }
  if (typeof options?.offset === "number") {
    params.set("offset", String(options.offset));
  }
  if (typeof options?.q === "string" && options.q.trim()) {
    params.set("q", options.q.trim());
  }
  if (typeof options?.query === "string" && options.query.trim()) {
    params.set("query", options.query.trim());
  }
  if (typeof options?.minConfidence === "number") {
    params.set("minConfidence", String(options.minConfidence));
  }
  if (typeof options?.minImportance === "number") {
    params.set("minImportance", String(options.minImportance));
  }
  if (typeof options?.includeRelated === "boolean") {
    params.set("includeRelated", String(options.includeRelated));
  }
  appendMulti("type", options?.type);
  appendMulti("outcome", options?.outcome);
  appendMulti("domain", options?.domain);
  options?.tags
    ?.map((tag) => tag.trim())
    .filter(Boolean)
    .forEach((tag) => {
      params.append("tag", tag);
    });
  const qs = params.toString();
  const response = await this.fetch<{
    data: ExperienceRecord[];
    total: number;
  }>(`/api/character/experiences${qs ? `?${qs}` : ""}`);
  return {
    experiences: response.data,
    total: response.total,
  };
};

ElizaClient.prototype.getExperienceGraph = async function (
  this: ElizaClient,
  options,
) {
  const params = new URLSearchParams();
  const appendMulti = (key: string, value?: string | string[]) => {
    if (Array.isArray(value)) {
      value
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach((item) => {
          params.append(key, item);
        });
      return;
    }
    if (typeof value === "string" && value.trim()) {
      params.append(key, value.trim());
    }
  };

  if (typeof options?.limit === "number") {
    params.set("limit", String(options.limit));
  }
  if (typeof options?.q === "string" && options.q.trim()) {
    params.set("q", options.q.trim());
  }
  if (typeof options?.query === "string" && options.query.trim()) {
    params.set("query", options.query.trim());
  }
  if (typeof options?.minConfidence === "number") {
    params.set("minConfidence", String(options.minConfidence));
  }
  if (typeof options?.minImportance === "number") {
    params.set("minImportance", String(options.minImportance));
  }
  if (typeof options?.includeRelated === "boolean") {
    params.set("includeRelated", String(options.includeRelated));
  }
  appendMulti("type", options?.type);
  appendMulti("outcome", options?.outcome);
  appendMulti("domain", options?.domain);
  options?.tags
    ?.map((tag) => tag.trim())
    .filter(Boolean)
    .forEach((tag) => {
      params.append("tag", tag);
    });

  const qs = params.toString();
  const response = await this.fetch<{ data: ExperienceGraphResponse }>(
    `/api/character/experiences/graph${qs ? `?${qs}` : ""}`,
  );
  return { graph: response.data };
};

ElizaClient.prototype.runExperienceMaintenance = async function (
  this: ElizaClient,
  options,
) {
  const response = await this.fetch<{ data: ExperienceMaintenanceResult }>(
    "/api/character/experiences/maintenance",
    {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    },
  );
  return { result: response.data };
};

ElizaClient.prototype.getExperience = async function (this: ElizaClient, id) {
  const response = await this.fetch<{ data: ExperienceRecord }>(
    `/api/character/experiences/${encodeURIComponent(id)}`,
  );
  return { experience: response.data };
};

ElizaClient.prototype.updateExperience = async function (
  this: ElizaClient,
  id,
  data,
) {
  const response = await this.fetch<{ data: ExperienceRecord }>(
    `/api/character/experiences/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify(data),
    },
  );
  return { experience: response.data };
};

ElizaClient.prototype.deleteExperience = async function (
  this: ElizaClient,
  id,
) {
  return this.fetch(`/api/character/experiences/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.getUpdateStatus = async function (
  this: ElizaClient,
  force = false,
) {
  try {
    const viaRpc = await invokeDesktopBridgeRequest<UpdateStatus>({
      rpcMethod: "getUpdateStatus",
      ipcChannel: "agent",
      params: { force },
    });
    if (viaRpc) return viaRpc;
  } catch {
    /* fall through */
  }
  return this.fetch(`/api/update/status${force ? "?force=true" : ""}`);
};

ElizaClient.prototype.setUpdateChannel = async function (
  this: ElizaClient,
  channel,
) {
  return this.fetch("/api/update/channel", {
    method: "PUT",
    body: JSON.stringify({ channel }),
  });
};

ElizaClient.prototype.getAgentAutomationMode = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/permissions/automation-mode");
};

ElizaClient.prototype.setAgentAutomationMode = async function (
  this: ElizaClient,
  mode,
) {
  return this.fetch("/api/permissions/automation-mode", {
    method: "PUT",
    body: JSON.stringify({ mode }),
  });
};

ElizaClient.prototype.getTradePermissionMode = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/permissions/trade-mode");
};

ElizaClient.prototype.setTradePermissionMode = async function (
  this: ElizaClient,
  mode,
) {
  return this.fetch("/api/permissions/trade-mode", {
    method: "PUT",
    body: JSON.stringify({ mode }),
  });
};

ElizaClient.prototype.getPermissions = async function (this: ElizaClient) {
  const permissions = await this.fetch<AllPermissionsState>("/api/permissions");
  const plugin = getNativeWebsiteBlockerPluginIfAvailable();
  if (!plugin) {
    return permissions;
  }

  const permission = mapWebsiteBlockerStatusToPermission(
    await plugin.getStatus(),
  );
  return {
    ...permissions,
    [WEBSITE_BLOCKING_PERMISSION_ID]: permission,
  };
};

ElizaClient.prototype.getPermission = async function (this: ElizaClient, id) {
  if (id === WEBSITE_BLOCKING_PERMISSION_ID) {
    const plugin = getNativeWebsiteBlockerPluginIfAvailable();
    if (plugin) {
      return mapWebsiteBlockerStatusToPermission(await plugin.getStatus());
    }
  }
  return this.fetch(`/api/permissions/${id}`);
};

ElizaClient.prototype.requestPermission = async function (
  this: ElizaClient,
  id,
) {
  if (id === WEBSITE_BLOCKING_PERMISSION_ID) {
    const plugin = getNativeWebsiteBlockerPluginIfAvailable();
    if (plugin) {
      return mapWebsiteBlockerPermissionResult(
        await plugin.requestPermissions(),
      );
    }
  }
  return this.fetch(`/api/permissions/${id}/request`, { method: "POST" });
};

ElizaClient.prototype.openPermissionSettings = async function (
  this: ElizaClient,
  id,
) {
  if (id === WEBSITE_BLOCKING_PERMISSION_ID) {
    const plugin = getNativeWebsiteBlockerPluginIfAvailable();
    if (plugin) {
      await plugin.openSettings();
      return;
    }
  }
  await this.fetch(`/api/permissions/${id}/open-settings`, {
    method: "POST",
  });
};

ElizaClient.prototype.refreshPermissions = async function (this: ElizaClient) {
  const permissions = await this.fetch<AllPermissionsState>(
    "/api/permissions/refresh",
    {
      method: "POST",
    },
  );
  const plugin = getNativeWebsiteBlockerPluginIfAvailable();
  if (!plugin) {
    return permissions;
  }

  const permission = mapWebsiteBlockerStatusToPermission(
    await plugin.getStatus(),
  );
  return {
    ...permissions,
    [WEBSITE_BLOCKING_PERMISSION_ID]: permission,
  };
};

ElizaClient.prototype.setShellEnabled = async function (
  this: ElizaClient,
  enabled,
) {
  return this.fetch("/api/permissions/shell", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
};

ElizaClient.prototype.isShellEnabled = async function (this: ElizaClient) {
  const result = await this.fetch<{ enabled: boolean }>(
    "/api/permissions/shell",
  );
  return result.enabled;
};

ElizaClient.prototype.getWebsiteBlockerStatus = async function (
  this: ElizaClient,
) {
  const plugin = getNativeWebsiteBlockerPluginIfAvailable();
  if (plugin) {
    return await plugin.getStatus();
  }
  return this.fetch("/api/website-blocker");
};

ElizaClient.prototype.startWebsiteBlock = async function (
  this: ElizaClient,
  options,
) {
  const plugin = getNativeWebsiteBlockerPluginIfAvailable();
  if (plugin) {
    return await plugin.startBlock(options);
  }
  return this.fetch("/api/website-blocker", {
    method: "PUT",
    body: JSON.stringify(options),
  });
};

ElizaClient.prototype.stopWebsiteBlock = async function (this: ElizaClient) {
  const plugin = getNativeWebsiteBlockerPluginIfAvailable();
  if (plugin) {
    return await plugin.stopBlock();
  }
  return this.fetch("/api/website-blocker", {
    method: "DELETE",
  });
};

ElizaClient.prototype.getAppBlockerStatus = async function (this: ElizaClient) {
  const plugin = getNativeAppBlockerPluginIfAvailable();
  if (plugin) {
    return await plugin.getStatus();
  }
  return {
    available: false,
    active: false,
    platform: "web",
    engine: "none",
    blockedCount: 0,
    blockedPackageNames: [],
    endsAt: null,
    permissionStatus: "not-applicable",
    reason: "App blocking is only available on iPhone and Android builds.",
  } satisfies AppBlockerStatusResult;
};

ElizaClient.prototype.checkAppBlockerPermissions = async function (
  this: ElizaClient,
) {
  const plugin = getNativeAppBlockerPluginIfAvailable();
  if (plugin) {
    return await plugin.checkPermissions();
  }
  return {
    status: "not-applicable",
    canRequest: false,
    reason: "App blocking is only available on iPhone and Android builds.",
  } satisfies AppBlockerPermissionResult;
};

ElizaClient.prototype.requestAppBlockerPermissions = async function (
  this: ElizaClient,
) {
  const plugin = getNativeAppBlockerPluginIfAvailable();
  if (plugin) {
    return await plugin.requestPermissions();
  }
  return {
    status: "not-applicable",
    canRequest: false,
    reason: "App blocking is only available on iPhone and Android builds.",
  } satisfies AppBlockerPermissionResult;
};

ElizaClient.prototype.getInstalledAppsToBlock = async function (
  this: ElizaClient,
) {
  const plugin = getNativeAppBlockerPluginIfAvailable();
  if (plugin) {
    return await plugin.getInstalledApps();
  }
  return { apps: [] as AppBlockerInstalledApp[] };
};

ElizaClient.prototype.selectAppBlockerApps = async function (
  this: ElizaClient,
) {
  const plugin = getNativeAppBlockerPluginIfAvailable();
  if (plugin) {
    return await plugin.selectApps();
  }
  return {
    apps: [] as AppBlockerInstalledApp[],
    cancelled: true,
  };
};

ElizaClient.prototype.startAppBlock = async function (
  this: ElizaClient,
  options,
) {
  const plugin = getNativeAppBlockerPluginIfAvailable();
  if (plugin) {
    return await plugin.blockApps(options);
  }
  return {
    success: false,
    endsAt: null,
    blockedCount: 0,
    error: "App blocking is only available on iPhone and Android builds.",
  };
};

ElizaClient.prototype.stopAppBlock = async function (this: ElizaClient) {
  const plugin = getNativeAppBlockerPluginIfAvailable();
  if (plugin) {
    return await plugin.unblockApps();
  }
  return {
    success: false,
    error: "App blocking is only available on iPhone and Android builds.",
  };
};

ElizaClient.prototype.getCodingAgentStatus = async function (
  this: ElizaClient,
) {
  try {
    const status = await this.fetch<CodingAgentStatus>(
      "/api/coding-agents/coordinator/status",
    );
    if (
      status &&
      status.tasks.length === 0 &&
      Array.isArray(status.taskThreads) &&
      status.taskThreads.length > 0
    ) {
      status.tasks = mapTaskThreadsToCodingAgentSessions(
        status.taskThreads,
      ).filter((task) => !TERMINAL_STATUSES.has(task.status));
      status.taskCount = status.tasks.length;
    }
    if (status && !status.tasks) {
      // Only fall back to the raw PTY session list when the coordinator
      // didn't return a tasks array at all (null/undefined).  An empty
      // array means "no tasks" — no need to hit /api/coding-agents which
      // may not have a handler and would hang until timeout.
      try {
        const ptySessions =
          await this.fetch<RawPtySession[]>("/api/coding-agents");
        if (Array.isArray(ptySessions) && ptySessions.length > 0) {
          status.tasks = mapPtySessionsToCodingAgentSessions(ptySessions);
          status.taskCount = status.tasks.length;
        }
      } catch {
        // /api/coding-agents may not exist — ignore
      }
    }
    return status;
  } catch {
    return null;
  }
};

ElizaClient.prototype.listCodingAgentTaskThreads = function (
  this: ElizaClient,
  options,
) {
  const params = new URLSearchParams();
  if (options?.includeArchived) params.set("includeArchived", "true");
  if (options?.status) params.set("status", options.status);
  if (options?.search) params.set("search", options.search);
  if (typeof options?.limit === "number" && options.limit > 0) {
    params.set("limit", String(options.limit));
  }
  const query = params.toString();
  return this.fetch<CodingAgentTaskThread[]>(
    `/api/coding-agents/coordinator/threads${query ? `?${query}` : ""}`,
  );
};

ElizaClient.prototype.getCodingAgentTaskThread = function (
  this: ElizaClient,
  threadId,
) {
  return this.fetch<CodingAgentTaskThreadDetail>(
    `/api/coding-agents/coordinator/threads/${encodeURIComponent(threadId)}`,
  );
};

ElizaClient.prototype.archiveCodingAgentTaskThread = async function (
  this: ElizaClient,
  threadId,
) {
  await this.fetch(
    `/api/coding-agents/coordinator/threads/${encodeURIComponent(threadId)}/archive`,
    { method: "POST" },
  );
  return true;
};

ElizaClient.prototype.reopenCodingAgentTaskThread = async function (
  this: ElizaClient,
  threadId,
) {
  await this.fetch(
    `/api/coding-agents/coordinator/threads/${encodeURIComponent(threadId)}/reopen`,
    { method: "POST" },
  );
  return true;
};

ElizaClient.prototype.stopCodingAgent = async function (
  this: ElizaClient,
  sessionId,
) {
  try {
    await this.fetch(
      `/api/coding-agents/${encodeURIComponent(sessionId)}/stop`,
      { method: "POST" },
    );
    return true;
  } catch {
    return false;
  }
};

ElizaClient.prototype.listCodingAgentScratchWorkspaces = async function (
  this: ElizaClient,
) {
  try {
    return await this.fetch<CodingAgentScratchWorkspace[]>(
      "/api/coding-agents/scratch",
    );
  } catch (err) {
    console.warn(
      "[api-client] Failed to list coding agent scratch workspaces:",
      err,
    );
    return [];
  }
};

ElizaClient.prototype.keepCodingAgentScratchWorkspace = async function (
  this: ElizaClient,
  sessionId,
) {
  try {
    await this.fetch(
      `/api/coding-agents/${encodeURIComponent(sessionId)}/scratch/keep`,
      { method: "POST" },
    );
    return true;
  } catch {
    return false;
  }
};

ElizaClient.prototype.deleteCodingAgentScratchWorkspace = async function (
  this: ElizaClient,
  sessionId,
) {
  try {
    await this.fetch(
      `/api/coding-agents/${encodeURIComponent(sessionId)}/scratch/delete`,
      { method: "POST" },
    );
    return true;
  } catch {
    return false;
  }
};

ElizaClient.prototype.promoteCodingAgentScratchWorkspace = async function (
  this: ElizaClient,
  sessionId,
  name?,
) {
  try {
    const response = await this.fetch<{
      success: boolean;
      scratch?: CodingAgentScratchWorkspace;
    }>(`/api/coding-agents/${encodeURIComponent(sessionId)}/scratch/promote`, {
      method: "POST",
      body: JSON.stringify(name ? { name } : {}),
    });
    return response.scratch ?? null;
  } catch {
    return null;
  }
};

ElizaClient.prototype.spawnShellSession = async function (
  this: ElizaClient,
  workdir?: string,
) {
  const res = await this.fetch<{ sessionId: string }>(
    "/api/coding-agents/spawn",
    {
      method: "POST",
      body: JSON.stringify({
        agentType: "shell",
        ...(workdir ? { workdir } : {}),
      }),
    },
  );
  return { sessionId: res.sessionId };
};

ElizaClient.prototype.subscribePtyOutput = function (
  this: ElizaClient,
  sessionId,
) {
  this.sendWsMessage({ type: "pty-subscribe", sessionId });
};

ElizaClient.prototype.unsubscribePtyOutput = function (
  this: ElizaClient,
  sessionId,
) {
  this.sendWsMessage({ type: "pty-unsubscribe", sessionId });
};

ElizaClient.prototype.sendPtyInput = function (
  this: ElizaClient,
  sessionId,
  data,
) {
  this.sendWsMessage({ type: "pty-input", sessionId, data });
};

ElizaClient.prototype.resizePty = function (
  this: ElizaClient,
  sessionId,
  cols,
  rows,
) {
  this.sendWsMessage({ type: "pty-resize", sessionId, cols, rows });
};

ElizaClient.prototype.getPtyBufferedOutput = async function (
  this: ElizaClient,
  sessionId,
) {
  try {
    const res = await this.fetch<{ output: string }>(
      `/api/coding-agents/${encodeURIComponent(sessionId)}/buffered-output`,
    );
    return res.output ?? "";
  } catch {
    return "";
  }
};

ElizaClient.prototype.streamGoLive = async function (this: ElizaClient) {
  return this.fetch("/api/stream/live", { method: "POST" });
};

ElizaClient.prototype.streamGoOffline = async function (this: ElizaClient) {
  return this.fetch("/api/stream/offline", { method: "POST" });
};

ElizaClient.prototype.streamStatus = async function (this: ElizaClient) {
  return this.fetch("/api/stream/status");
};

ElizaClient.prototype.getStreamingDestinations = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/streaming/destinations");
};

ElizaClient.prototype.setActiveDestination = async function (
  this: ElizaClient,
  destinationId,
) {
  return this.fetch("/api/streaming/destination", {
    method: "POST",
    body: JSON.stringify({ destinationId }),
  });
};

ElizaClient.prototype.setStreamVolume = async function (
  this: ElizaClient,
  volume,
) {
  return this.fetch("/api/stream/volume", {
    method: "POST",
    body: JSON.stringify({ volume }),
  });
};

ElizaClient.prototype.muteStream = async function (this: ElizaClient) {
  return this.fetch("/api/stream/mute", { method: "POST" });
};

ElizaClient.prototype.unmuteStream = async function (this: ElizaClient) {
  return this.fetch("/api/stream/unmute", { method: "POST" });
};

ElizaClient.prototype.getStreamVoice = async function (this: ElizaClient) {
  return this.fetch("/api/stream/voice");
};

ElizaClient.prototype.saveStreamVoice = async function (
  this: ElizaClient,
  settings,
) {
  return this.fetch("/api/stream/voice", {
    method: "POST",
    body: JSON.stringify(settings),
  });
};

ElizaClient.prototype.streamVoiceSpeak = async function (
  this: ElizaClient,
  text,
) {
  return this.fetch("/api/stream/voice/speak", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
};

ElizaClient.prototype.getOverlayLayout = async function (
  this: ElizaClient,
  destinationId?,
) {
  const qs = destinationId
    ? `?destination=${encodeURIComponent(destinationId)}`
    : "";
  return this.fetch(`/api/stream/overlay-layout${qs}`);
};

ElizaClient.prototype.saveOverlayLayout = async function (
  this: ElizaClient,
  layout,
  destinationId?,
) {
  const qs = destinationId
    ? `?destination=${encodeURIComponent(destinationId)}`
    : "";
  return this.fetch(`/api/stream/overlay-layout${qs}`, {
    method: "POST",
    body: JSON.stringify({ layout }),
  });
};

ElizaClient.prototype.getStreamSource = async function (this: ElizaClient) {
  return this.fetch("/api/stream/source");
};

ElizaClient.prototype.setStreamSource = async function (
  this: ElizaClient,
  sourceType,
  customUrl?,
) {
  return this.fetch("/api/stream/source", {
    method: "POST",
    body: JSON.stringify({ sourceType, customUrl }),
  });
};

ElizaClient.prototype.getStreamSettings = async function (this: ElizaClient) {
  return this.fetch("/api/stream/settings");
};

ElizaClient.prototype.saveStreamSettings = async function (
  this: ElizaClient,
  settings,
) {
  return this.fetch("/api/stream/settings", {
    method: "POST",
    body: JSON.stringify({ settings }),
  });
};

// ---------------------------------------------------------------------------
// Multi-account routes (WS3)
// ---------------------------------------------------------------------------

ElizaClient.prototype.listAccounts = async function (this: ElizaClient) {
  return this.fetch<AccountsListResponse>("/api/accounts");
};

ElizaClient.prototype.createApiKeyAccount = async function (
  this: ElizaClient,
  providerId,
  body,
) {
  return this.fetch<LinkedAccountConfig>(
    `/api/accounts/${encodeURIComponent(providerId)}`,
    {
      method: "POST",
      body: JSON.stringify({ source: "api-key", ...body }),
    },
  );
};

ElizaClient.prototype.patchAccount = async function (
  this: ElizaClient,
  providerId,
  accountId,
  body,
) {
  return this.fetch<LinkedAccountConfig>(
    `/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
    },
  );
};

ElizaClient.prototype.deleteAccount = async function (
  this: ElizaClient,
  providerId,
  accountId,
) {
  return this.fetch<{ deleted: boolean }>(
    `/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}`,
    { method: "DELETE" },
  );
};

ElizaClient.prototype.testAccount = async function (
  this: ElizaClient,
  providerId,
  accountId,
) {
  return this.fetch<AccountTestResult>(
    `/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}/test`,
    { method: "POST" },
  );
};

ElizaClient.prototype.refreshAccountUsage = async function (
  this: ElizaClient,
  providerId,
  accountId,
) {
  return this.fetch<AccountRefreshUsageResult>(
    `/api/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}/refresh-usage`,
    { method: "POST" },
  );
};

ElizaClient.prototype.startAccountOAuth = async function (
  this: ElizaClient,
  providerId,
  body,
) {
  return this.fetch<AccountOAuthStartResult>(
    `/api/accounts/${encodeURIComponent(providerId)}/oauth/start`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
};

ElizaClient.prototype.submitAccountOAuthCode = async function (
  this: ElizaClient,
  providerId,
  body,
) {
  return this.fetch<{ accepted: boolean }>(
    `/api/accounts/${encodeURIComponent(providerId)}/oauth/submit-code`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
};

ElizaClient.prototype.cancelAccountOAuth = async function (
  this: ElizaClient,
  providerId,
  body,
) {
  return this.fetch<{ cancelled: boolean }>(
    `/api/accounts/${encodeURIComponent(providerId)}/oauth/cancel`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
};

ElizaClient.prototype.patchProviderStrategy = async function (
  this: ElizaClient,
  providerId,
  body,
) {
  return this.fetch<{
    providerId: LinkedAccountProviderId;
    strategy: AccountStrategy;
  }>(`/api/providers/${encodeURIComponent(providerId)}/strategy`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
};
