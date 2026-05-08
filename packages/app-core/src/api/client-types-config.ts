// ---------------------------------------------------------------------------
// Config types — Config*, Plugin*, Secret*, Connector*, Trigger*, Training*,
// Update*, Extension*, Workbench*, Character*, Voice*, Skill*
// ---------------------------------------------------------------------------

import type {
  CreateTriggerRequest as _CreateTriggerRequest,
  TriggerHealthSnapshot as _TriggerHealthSnapshot,
  TriggerRunRecord as _TriggerRunRecord,
  TriggerSummary as _TriggerSummary,
  UpdateTriggerRequest as _UpdateTriggerRequest,
  ConversationScope,
  ReleaseChannel,
} from "@elizaos/agent";
import type { MessageExampleContent } from "@elizaos/shared";
import type { ConfigUiHint } from "../types";

export type {
  BrowserBridgeCompanionPackageStatus,
  BrowserBridgeCompanionStatus,
  BrowserBridgePageContext,
  BrowserBridgeSettings,
  BrowserBridgeTabSummary,
  SyncBrowserBridgeStateRequest,
  UpdateBrowserBridgeSettingsRequest,
} from "@elizaos/plugin-browser/contracts";
export type {
  CompleteLifeOpsBrowserSessionRequest as CompleteBrowserBridgeSessionRequest,
  CompleteLifeOpsOccurrenceRequest,
  ConfirmLifeOpsBrowserSessionRequest as ConfirmBrowserBridgeSessionRequest,
  CreateLifeOpsBrowserSessionRequest as CreateBrowserBridgeSessionRequest,
  CreateLifeOpsCalendarEventRequest,
  CreateLifeOpsDefinitionRequest,
  CreateLifeOpsGmailReplyDraftRequest,
  CreateLifeOpsGoalRequest,
  DisconnectLifeOpsGoogleConnectorRequest,
  GetLifeOpsCalendarFeedRequest,
  GetLifeOpsGmailTriageRequest,
  LifeOpsBrowserSession as BrowserBridgeSession,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsDefinitionRecord,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailReplyDraft,
  LifeOpsGmailTriageFeed,
  LifeOpsGoalRecord,
  LifeOpsGoalReview,
  LifeOpsGoogleConnectorStatus,
  LifeOpsNextCalendarEventContext,
  LifeOpsOccurrenceExplanation,
  LifeOpsOccurrenceView,
  LifeOpsOverview,
  LifeOpsReminderInspection,
  LifeOpsReminderPlan,
  LifeOpsTaskDefinition,
  SelectLifeOpsGoogleConnectorPreferenceRequest,
  SendLifeOpsGmailReplyRequest,
  SnoozeLifeOpsOccurrenceRequest,
  StartLifeOpsGoogleConnectorRequest,
  StartLifeOpsGoogleConnectorResponse,
  UpdateLifeOpsDefinitionRequest,
  UpdateLifeOpsGoalRequest,
} from "@elizaos/shared";

export interface SecretInfo {
  key: string;
  description: string;
  category: string;
  sensitive: boolean;
  required: boolean;
  isSet: boolean;
  maskedValue: string | null;
  usedBy: Array<{ pluginId: string; pluginName: string; enabled: boolean }>;
}

export interface PluginParamDef {
  key: string;
  type: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  default?: string;
  /** Predefined options for dropdown selection (e.g. model names). */
  options?: string[];
  currentValue: string | null;
  isSet: boolean;
}

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  enabled: boolean;
  configured: boolean;
  envKey: string | null;
  category:
    | "ai-provider"
    | "connector"
    | "streaming"
    | "database"
    | "app"
    | "feature";
  source: "bundled" | "store";
  parameters: PluginParamDef[];
  validationErrors: Array<{ field: string; message: string }>;
  validationWarnings: Array<{ field: string; message: string }>;
  npmName?: string;
  version?: string;
  releaseStream?: "latest" | "beta";
  requestedVersion?: string;
  latestVersion?: string | null;
  betaVersion?: string | null;
  pluginDeps?: string[];
  /** Whether this plugin is actually loaded and running in the runtime. */
  isActive?: boolean;
  /** Error message when plugin is installed but failed to load. */
  loadError?: string;
  /** Server-provided UI hints for plugin configuration fields. */
  configUiHints?: Record<string, ConfigUiHint>;
  /** Optional icon URL or emoji for the plugin card header. */
  icon?: string | null;
  /**
   * Lucide icon name (e.g. "Send", "Brain") sourced from the registry.
   * Replaces the frontend-side DEFAULT_ICONS lookup table.
   */
  iconName?: string;
  /**
   * Display group from the registry (e.g. "ai-provider", "voice").
   * Replaces the frontend-side FEATURE_SUBGROUP lookup.
   */
  group?: string;
  /**
   * Sort order within the display group. Replaces SUBGROUP_DISPLAY_ORDER.
   */
  groupOrder?: number;
  /**
   * Whether this entry is user-visible. Replaces VISIBLE_CONNECTOR_IDS.
   */
  visible?: boolean;
  homepage?: string;
  repository?: string;
  setupGuideUrl?: string;
  /** Widget declarations for this plugin (rendered by the UI widget system). */
  widgets?: Array<{
    id: string;
    pluginId: string;
    slot: string;
    label: string;
    icon?: string;
    order?: number;
    defaultEnabled?: boolean;
    navGroup?: string;
    developerOnly?: boolean;
    componentExport?: string;
  }>;
  /**
   * App metadata declared by the plugin (`Plugin.app`). Surfaces nav-tab
   * registrations, developer-mode gating, and app-store visibility so the
   * shell can wire pages dynamically without app-core hard-coding them.
   */
  app?: {
    displayName?: string;
    category?: string;
    icon?: string | null;
    developerOnly?: boolean;
    visibleInAppStore?: boolean;
    navTabs?: Array<{
      id: string;
      label: string;
      icon?: string;
      path: string;
      order?: number;
      developerOnly?: boolean;
      group?: string;
      componentExport?: string;
    }>;
  };
}

export interface CorePluginEntry {
  npmName: string;
  id: string;
  name: string;
  isCore: boolean;
  loaded: boolean;
  enabled: boolean;
}

export interface CorePluginsResponse {
  core: CorePluginEntry[];
  optional: CorePluginEntry[];
}

export interface ConfigSchemaResponse {
  schema: unknown;
  uiHints: Record<string, unknown>;
  version: string;
  generatedAt: string;
}

export type TriggerSummary = _TriggerSummary;
export type TriggerRunRecord = _TriggerRunRecord;
export type TriggerHealthSnapshot = _TriggerHealthSnapshot;
export type CreateTriggerRequest = _CreateTriggerRequest;
export type UpdateTriggerRequest = _UpdateTriggerRequest;

export interface TriggerEventDispatchResponse {
  ok: boolean;
  eventKind: string;
  matched: number;
  results: Array<{
    taskId?: string;
    result: {
      status: TriggerRunRecord["status"];
      error?: string;
      taskDeleted: boolean;
      executionId?: string;
    };
    trigger?: TriggerSummary | null;
  }>;
}

// Fine-tuning / training
export type TrainingJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TrainingStatus {
  runningJobs: number;
  queuedJobs: number;
  completedJobs: number;
  failedJobs: number;
  modelCount: number;
  datasetCount: number;
  runtimeAvailable: boolean;
}

export interface TrainingTrajectorySummary {
  id: string;
  trajectoryId: string;
  agentId: string;
  archetype: string | null;
  createdAt: string;
  totalReward: number | null;
  aiJudgeReward: number | null;
  episodeLength: number | null;
  hasLlmCalls: boolean;
  llmCallCount: number;
}

export interface TrainingTrajectoryDetail extends TrainingTrajectorySummary {
  stepsJson: string;
  aiJudgeReasoning: string | null;
}

export interface TrainingTrajectoryList {
  available: boolean;
  reason?: string;
  total: number;
  trajectories: TrainingTrajectorySummary[];
}

export interface TrainingDatasetRecord {
  id: string;
  createdAt: string;
  jsonlPath: string;
  trajectoryDir: string;
  metadataPath: string;
  sampleCount: number;
  trajectoryCount: number;
}

export interface StartTrainingOptions {
  datasetId?: string;
  maxTrajectories?: number;
  backend?: "mlx" | "cuda" | "cpu";
  model?: string;
  iterations?: number;
  batchSize?: number;
  learningRate?: number;
}

export interface TrainingJobRecord {
  id: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  status: TrainingJobStatus;
  phase: string;
  progress: number;
  error: string | null;
  exitCode: number | null;
  signal: string | null;
  options: StartTrainingOptions;
  datasetId: string;
  pythonRoot: string;
  scriptPath: string;
  outputDir: string;
  logPath: string;
  modelPath: string | null;
  adapterPath: string | null;
  modelId: string | null;
  logs: string[];
}

export interface TrainingModelRecord {
  id: string;
  createdAt: string;
  jobId: string;
  outputDir: string;
  modelPath: string;
  adapterPath: string | null;
  sourceModel: string | null;
  backend: "mlx" | "cuda" | "cpu";
  ollamaModel: string | null;
  active: boolean;
  benchmark: {
    status: "not_run" | "passed" | "failed";
    lastRunAt: string | null;
    output: string | null;
  };
}

export type TrainingEventKind =
  | "job_started"
  | "job_progress"
  | "job_log"
  | "job_completed"
  | "job_failed"
  | "job_cancelled"
  | "dataset_built"
  | "model_activated"
  | "model_imported";

export interface TrainingStreamEvent {
  kind: TrainingEventKind;
  ts: number;
  message: string;
  jobId?: string;
  modelId?: string;
  datasetId?: string;
  progress?: number;
  phase?: string;
}

// Software Updates
export interface UpdateStatus {
  currentVersion: string;
  channel: ReleaseChannel;
  installMethod: string;
  updateAvailable: boolean;
  latestVersion: string | null;
  channels: Record<ReleaseChannel, string | null>;
  distTags: Record<ReleaseChannel, string>;
  lastCheckAt: string | null;
  error: string | null;
}

// Registry / Plugin Store types
export interface RegistryPlugin {
  name: string;
  gitRepo: string;
  gitUrl: string;
  description: string;
  homepage: string | null;
  topics: string[];
  stars: number;
  language: string;
  npm: {
    package: string;
    v0Version: string | null;
    v1Version: string | null;
    v2Version: string | null;
  };
  git: {
    v0Branch: string | null;
    v1Branch: string | null;
    v2Branch: string | null;
  };
  supports: { v0: boolean; v1: boolean; v2: boolean };
  installed: boolean;
  installedVersion: string | null;
  loaded: boolean;
  bundled: boolean;
  compatibility?: {
    releaseAvailability: "bundled" | "post-release";
    installSurface: "runtime" | "app";
    postReleaseInstallable: boolean;
    requiresDesktopRuntime: boolean;
    requiresLocalRuntime: boolean;
    note?: string;
  };
}

export interface RegistrySearchResult {
  name: string;
  description: string;
  score: number;
  tags: string[];
  latestVersion: string | null;
  stars: number;
  supports: { v0: boolean; v1: boolean; v2: boolean };
  repository: string;
}

export interface InstalledPlugin {
  name: string;
  version: string;
  installPath: string;
  installedAt: string;
  releaseStream?: "latest" | "beta";
  requestedVersion?: string;
  latestVersion?: string | null;
  betaVersion?: string | null;
}

export type PluginMutationApplyMode =
  | "none"
  | "config_apply"
  | "plugin_reload"
  | "runtime_reload"
  | "restart_required";

export interface PluginMutationResult {
  ok: boolean;
  pluginName?: string;
  applied?: PluginMutationApplyMode;
  requiresRestart?: boolean;
  restartedRuntime?: boolean;
  loadedPackages?: string[];
  unloadedPackages?: string[];
  reloadedPackages?: string[];
  vaultMirrorFailures?: string[];
  message?: string;
  error?: string;
}

export interface PluginInstallResult {
  ok: boolean;
  pluginName?: string;
  plugin?: { name: string; version: string; installPath: string };
  applied?: PluginMutationApplyMode;
  requiresRestart?: boolean;
  restartedRuntime?: boolean;
  loadedPackages?: string[];
  unloadedPackages?: string[];
  reloadedPackages?: string[];
  releaseStream?: "latest" | "beta";
  requestedVersion?: string;
  latestVersion?: string | null;
  betaVersion?: string | null;
  message?: string;
  error?: string;
}

// Registry plugin (non-app entries from the registry)
export interface RegistryPluginItem {
  name: string;
  description: string;
  stars: number;
  repository: string;
  topics: string[];
  latestVersion: string | null;
  supports: { v0: boolean; v1: boolean; v2: boolean };
  npm: {
    package: string;
    v0Version: string | null;
    v1Version: string | null;
    v2Version: string | null;
  };
}

// Workbench
export interface WorkbenchTask {
  id: string;
  name: string;
  description: string;
  tags: string[];
  isCompleted: boolean;
  updatedAt?: number;
}

export interface WorkbenchTodo {
  id: string;
  name: string;
  description: string;
  priority: number | null;
  isUrgent: boolean;
  isCompleted: boolean;
  type: string;
}

export interface WorkbenchOverview {
  tasks: WorkbenchTask[];
  triggers: TriggerSummary[];
  todos: WorkbenchTodo[];
  autonomy?: {
    enabled: boolean;
    thinking: boolean;
    lastEventAt?: number | null;
  };
}

export type AutomationType =
  | "coordinator_text"
  | "n8n_workflow"
  | "automation_draft";
export type AutomationSource =
  | "workbench_task"
  | "trigger"
  | "n8n_workflow"
  | "workflow_draft"
  | "workflow_shadow"
  | "automation_draft";
export type AutomationStatus =
  | "active"
  | "paused"
  | "completed"
  | "draft"
  | "system";
export type AutomationNodeClass =
  | "trigger"
  | "action"
  | "context"
  | "integration"
  | "agent"
  | "flow-control";

export interface AutomationRoomBinding {
  conversationId: string | null;
  roomId: string;
  scope: ConversationScope;
  sourceConversationId?: string;
  terminalBridgeConversationId?: string;
}

export interface AutomationItem {
  id: string;
  type: AutomationType;
  source: AutomationSource;
  title: string;
  description: string;
  status: AutomationStatus;
  enabled: boolean;
  system: boolean;
  isDraft: boolean;
  hasBackingWorkflow: boolean;
  updatedAt: string | null;
  taskId?: string;
  triggerId?: string;
  workflowId?: string;
  draftId?: string;
  task?: WorkbenchTask;
  trigger?: TriggerSummary;
  workflow?: import("./client-types-chat").N8nWorkflow;
  schedules: TriggerSummary[];
  room?: AutomationRoomBinding | null;
}

export interface AutomationSummary {
  total: number;
  coordinatorCount: number;
  workflowCount: number;
  scheduledCount: number;
  draftCount: number;
}

export interface AutomationListResponse {
  automations: AutomationItem[];
  summary: AutomationSummary;
  n8nStatus: import("./client-types-chat").N8nStatusResponse | null;
  workflowFetchError: string | null;
}

export interface AutomationNodeDescriptor {
  id: string;
  label: string;
  description: string;
  class: AutomationNodeClass;
  source: string;
  backingCapability: string;
  ownerScoped: boolean;
  requiresSetup: boolean;
  availability: "enabled" | "disabled";
  disabledReason?: string;
}

export interface AutomationNodeCatalogResponse {
  nodes: AutomationNodeDescriptor[];
  summary: {
    total: number;
    enabled: number;
    disabled: number;
  };
}

export type { LifeOpsOccurrenceActionResult } from "@elizaos/shared";

// Voice / TTS config
export type VoiceProvider = "elevenlabs" | "simple-voice" | "edge";
export type VoiceMode = "cloud" | "own-key";

export interface VoiceConfig {
  provider?: VoiceProvider;
  mode?: VoiceMode;
  elevenlabs?: {
    apiKey?: string;
    voiceId?: string;
    modelId?: string;
    stability?: number;
    similarityBoost?: number;
    speed?: number;
  };
  edge?: {
    voice?: string;
    lang?: string;
    rate?: string;
    pitch?: string;
    volume?: string;
  };
}

// Character
export interface CharacterData {
  name?: string;
  username?: string;
  bio?: string | string[];
  system?: string;
  adjectives?: string[];
  topics?: string[];
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
  messageExamples?: Array<{
    examples: Array<{ name: string; content: MessageExampleContent }>;
  }>;
  postExamples?: string[];
}

// Skill types
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  scanStatus?: "clean" | "warning" | "critical" | "blocked" | null;
}

export interface SkillScanReportSummary {
  scannedAt: string;
  status: "clean" | "warning" | "critical" | "blocked";
  summary: {
    scannedFiles: number;
    critical: number;
    warn: number;
    info: number;
  };
  findings: Array<{
    ruleId: string;
    severity: string;
    file: string;
    line: number;
    message: string;
    evidence: string;
  }>;
  manifestFindings: Array<{
    ruleId: string;
    severity: string;
    file: string;
    message: string;
  }>;
  skillPath: string;
}

// Skill Catalog types
export interface CatalogSkillStats {
  comments: number;
  downloads: number;
  installsAllTime: number;
  installsCurrent: number;
  stars: number;
  versions: number;
}

export interface CatalogSkillVersion {
  version: string;
  createdAt: number;
  changelog: string;
}

export interface CatalogSkill {
  slug: string;
  displayName: string;
  summary: string | null;
  tags: Record<string, string>;
  stats: CatalogSkillStats;
  createdAt: number;
  updatedAt: number;
  latestVersion: CatalogSkillVersion | null;
  installed?: boolean;
}

export interface CatalogSearchResult {
  slug: string;
  displayName: string;
  summary: string | null;
  score: number;
  latestVersion: string | null;
  downloads: number;
  stars: number;
  installs: number;
}

// Skills Marketplace
export interface SkillMarketplaceResult {
  id: string;
  slug?: string;
  name: string;
  description: string;
  githubUrl?: string;
  repository?: string;
  path?: string;
  tags?: string[];
  score?: number;
  source?: string;
}

export interface WalletExportResult {
  evm: { privateKey: string; address: string | null } | null;
  solana: { privateKey: string; address: string | null } | null;
}
