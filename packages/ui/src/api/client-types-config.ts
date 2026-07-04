// ---------------------------------------------------------------------------
// Config types — Config*, Plugin*, Secret*, Connector*, Trigger*, Training*,
// Update*, Extension*, Workbench*, Character*, Voice*, Skill*
// ---------------------------------------------------------------------------

import type { AppShellBackgroundPolicy, ViewKind } from "@elizaos/core";
import type { MessageExampleContent, PluginParamDef } from "@elizaos/shared";
import type { ConfigUiHint } from "../types";
import type {
  ConversationScope,
  ReleaseChannel,
  ScheduledTaskView,
  TriggerRunRecord,
  TriggerSummary,
} from "./client-types-core";

export type {
  CloudCodingAgent,
  CloudCodingContainerSession,
  CloudCodingContainerStatus,
  CloudCodingPatch,
  CloudCodingPatchFormat,
  CloudCodingPromotion,
  CloudCodingSyncDirection,
  CloudCodingSyncResult,
  CloudContainerArchitecture,
  CloudVfsBundle,
  CloudVfsDeletedFile,
  CloudVfsFile,
  CloudVfsFileEncoding,
  CloudVfsSourceKind,
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
  PostWorkbenchVfsPromoteToCloudRequest,
  PromoteVfsToCloudContainerRequest,
  PromoteVfsToCloudContainerResponse,
  RequestCodingAgentContainerRequest,
  RequestCodingAgentContainerResponse,
  SelectLifeOpsGoogleConnectorPreferenceRequest,
  SendLifeOpsGmailReplyRequest,
  SnoozeLifeOpsOccurrenceRequest,
  StartLifeOpsGoogleConnectorRequest,
  StartLifeOpsGoogleConnectorResponse,
  SyncCloudCodingContainerRequest,
  SyncCloudCodingContainerResponse,
  UpdateLifeOpsDefinitionRequest,
  UpdateLifeOpsGoalRequest,
} from "@elizaos/shared";
export type {
  BrowserBridgeCompanionPackageStatus,
  BrowserBridgeCompanionStatus,
  BrowserBridgePageContext,
  BrowserBridgeSettings,
  BrowserBridgeTabSummary,
  SyncBrowserBridgeStateRequest,
  UpdateBrowserBridgeSettingsRequest,
} from "./browser-contracts";

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

export type { PluginParamDef };

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
  directory?: string | null;
  registryKind?: string;
  origin?: "builtin" | "third-party" | string;
  registrySource?: string;
  support?: "first-party" | "community" | string;
  builtIn?: boolean;
  firstParty?: boolean;
  thirdParty?: boolean;
  status?: string;
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
    viewKind?: ViewKind;
    componentExport?: string;
    defaultWidget?: "notifications" | "messages" | "activity";
    signalKinds?: readonly string[];
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
    viewKind?: ViewKind;
    visibleInAppStore?: boolean;
    navTabs?: Array<{
      id: string;
      label: string;
      icon?: string;
      path: string;
      tabAffinity?: string;
      order?: number;
      developerOnly?: boolean;
      viewKind?: ViewKind;
      group?: string;
      backgroundPolicy?: AppShellBackgroundPolicy;
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

/** UI-facing capability toggles persisted under `ui.capabilities`. */
export interface AppConfigCapabilities {
  wallet?: boolean;
  browser?: boolean;
  computerUse?: boolean;
  [key: string]: unknown;
}

/** The `ui` sub-object of the agent config that the dashboard reads/writes. */
export interface AppConfigUi {
  ownerName?: string;
  avatarIndex?: number;
  presetId?: string;
  language?: string;
  capabilities?: AppConfigCapabilities;
  [key: string]: unknown;
}

/**
 * Response of `GET /api/config`. The underlying agent config is open-ended,
 * so unknown keys remain accessible via the index signature; the fields the
 * dashboard relies on are declared explicitly.
 */
export interface AppConfigResponse {
  ui?: AppConfigUi;
  cloud?: Record<string, unknown>;
  [key: string]: unknown;
}

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

export type TrainingAnalysisArtifactKind =
  | "trajectory_bundle"
  | "trajectory_dataset"
  | "scenario_run"
  | "collection_run"
  | "training_run"
  | "eval"
  | "benchmark_matrix"
  | "model";

export interface TrainingAnalysisArtifact {
  id: string;
  kind: TrainingAnalysisArtifactKind;
  title: string;
  path: string;
  generatedAt?: string;
  summary: Record<string, unknown>;
  payload: unknown;
}

export interface TrainingAnalysisCoverageSummary {
  dataSources: {
    huggingFace: number;
    feed: number;
    natural: number;
    scenarios: number;
    tests: number;
    trainingJsonl: number;
  };
  readableSamples: {
    huggingFace: number;
    feed: number;
    natural: number;
    scenarios: number;
    tests: number;
    trainingJsonl: number;
    total: number;
  };
  evals: {
    artifacts: number;
    comparisons: number;
    scoredComparisons: number;
  };
  benchmarks: {
    matrices: number;
    comparisons: number;
    scoredComparisons: number;
    caseSamples: number;
    tiers: string[];
    allEliza1TiersCovered: boolean;
    tierCoverage: Array<{
      tier: string;
      hasBase: boolean;
      hasTrained: boolean;
      hasReference: boolean;
      hasImprovement: boolean;
      benchmarkCount: number;
      comparisonCount: number;
    }>;
  };
  models: {
    artifacts: number;
    stagedBundles: number;
    inventory: Array<{
      model: string | null;
      tier: string | null;
      variant: string | null;
      baseModel: string | null;
      outputPath: string | null;
      baseEvalScore: number | null;
      trainedEvalScore: number | null;
      evalImprovementPercent: number | null;
    }>;
  };
}

export interface TrainingAnalysisIndexManifest {
  schema: string;
  schemaVersion: number;
  generatedAt: string;
  roots: string[];
  outputDir: string;
  indexHtmlPath: string;
  manifestPath: string;
  counts: Record<string, number>;
  coverage: TrainingAnalysisCoverageSummary;
  artifacts: TrainingAnalysisArtifact[];
}

export interface BuildTrainingAnalysisIndexOptions {
  roots?: string[];
  outputDir?: string;
  maxDepth?: number;
}

export interface TrainingAnalysisIndexResponse {
  outputDir: string;
  indexHtmlPath: string;
  manifestPath: string;
  manifest: TrainingAnalysisIndexManifest;
}

export type TrainingReadinessStatus = "ready" | "partial" | "missing";

export interface TrainingReadinessCheck {
  id: string;
  label: string;
  status: TrainingReadinessStatus;
  artifactCount: number;
  artifactPaths: string[];
  note: string;
  recommendedAction: TrainingReadinessAction | null;
}

export interface TrainingReadinessAction {
  label: string;
  capability: string;
  params: Record<string, unknown>;
}

export interface TrainingReadinessReport {
  schema: string;
  schemaVersion: number;
  generatedAt: string;
  outputDir: string;
  reportPath: string;
  analysisManifestPath: string;
  analysisIndexHtmlPath: string;
  status: TrainingReadinessStatus;
  counts: Record<string, number>;
  checks: TrainingReadinessCheck[];
}

export interface BuildTrainingReadinessReportOptions
  extends BuildTrainingAnalysisIndexOptions {
  reportOutputDir?: string;
  reportPath?: string;
}

export interface TrainingReadinessReportResponse {
  outputDir: string;
  reportPath: string;
  report: TrainingReadinessReport;
}

export interface IngestHuggingFaceDatasetOptions {
  repoId?: string;
  revision?: string;
  files?: string[];
  outputDir?: string;
  token?: string;
  dryRun?: boolean;
}

export interface HuggingFaceDatasetFileReceipt {
  hfPath: string;
  url: string;
  localPath: string;
  bytes: number;
  sha256: string | null;
  rows: number | null;
  contentType: string | null;
  status: "downloaded" | "dry_run";
}

export interface HuggingFaceDatasetIngestResponse {
  outputDir: string;
  manifestPath: string;
  manifest: {
    schema: string;
    schemaVersion: number;
    generatedAt: string;
    source: {
      kind: "huggingface_dataset";
      repoId: string;
      revision: string;
    };
    outputDir: string;
    manifestPath: string;
    counts: Record<string, number>;
    files: HuggingFaceDatasetFileReceipt[];
  };
}

export type BenchmarkMatrixVariant = "reference" | "base" | "trained";

export interface BenchmarkMatrixRowInput {
  modelId: string;
  benchmark: string;
  score: number;
  variant: BenchmarkMatrixVariant;
  tier?: string;
  provider?: string;
  datasetVersion?: string;
  codeCommit?: string;
  ts?: number | string;
  metrics?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface BenchmarkMatrixArtifact {
  schema: string;
  version: number;
  generatedAt: string;
  source: Record<string, unknown>;
  referenceModelId: string | null;
  tiers: string[];
  benchmarks: string[];
  counts: Record<string, number>;
  rows: Array<Record<string, unknown>>;
  comparisons: Array<Record<string, unknown>>;
}

export interface WriteBenchmarkMatrixOptions {
  rows: BenchmarkMatrixRowInput[];
  outputDir?: string;
  generatedAt?: string;
  referenceModelId?: string;
  source?: Record<string, unknown>;
}

export interface BenchmarkMatrixResponse {
  outputDir: string;
  artifactPath: string;
  artifact: BenchmarkMatrixArtifact;
}

export interface BenchmarkMatrixArtifactSource {
  path: string;
  modelId?: string;
  benchmark?: string;
  variant?: BenchmarkMatrixVariant;
  tier?: string;
  provider?: string;
  datasetVersion?: string;
  codeCommit?: string;
  useMocks?: boolean;
}

export interface WriteBenchmarkMatrixFromArtifactsOptions {
  artifacts: BenchmarkMatrixArtifactSource[];
  outputDir?: string;
  generatedAt?: string;
  referenceModelId?: string;
  source?: Record<string, unknown>;
}

export interface RunBenchmarkVsCerebrasOptions {
  trainingRoot?: string;
  python?: string;
  tiers?: string;
  benchmark?: "eliza_harness_action_selection" | "clawbench" | "hermes" | "all";
  variants?: "trained" | "base" | "both";
  cerebrasModel?: string;
  maxSamples?: number;
  outputDir?: string;
  checkpointsDir?: string;
  trainedModelPath?: string;
  dryRun?: boolean;
  resultsDb?: string;
  datasetVersion?: string;
  codeCommit?: string;
  matrixOutputDir?: string;
}

export interface RunBenchmarkVsCerebrasResponse {
  trainingRoot: string;
  outputDir: string;
  matrixOutputDir: string | null;
  matrixArtifactPath: string | null;
  resultsDb: string | null;
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface StageEliza1BundleOptions {
  trainingRoot?: string;
  python?: string;
  repoId?: string;
  tier?: string;
  localDir?: string;
  outputDir?: string;
  maxBytes?: number;
  apply?: boolean;
}

export interface StageEliza1BundleResponse {
  trainingRoot: string;
  outputDir: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  plan: Record<string, unknown> | null;
}

export interface RunActionBenchmarkOptions {
  workspaceRoot?: string;
  bun?: string;
  outputDir?: string;
  useMocks?: boolean;
  forceTrajectoryCapture?: boolean;
  filter?: string;
  runsPerCase?: number;
  provider?: string;
  modelId?: string;
  runtimeModel?: string;
  smallModel?: string;
  largeModel?: string;
  baseUrl?: string;
  variant?: "reference" | "base" | "trained";
  tier?: string;
  benchmark?: string;
  datasetVersion?: string;
  codeCommit?: string;
  dryRun?: boolean;
}

export interface RunActionBenchmarkResponse {
  workspaceRoot: string;
  appCoreRoot: string;
  outputDir: string;
  reportMarkdownPath: string;
  reportJsonPath: string;
  trajectoryDir: string;
  command: string[];
  env: Record<string, string>;
  stdout: string;
  stderr: string;
  exitCode: number;
  matrixSource: BenchmarkMatrixArtifactSource | null;
}

export interface RunFeedGenerationOptions {
  workspaceRoot?: string;
  bun?: string;
  archetypes?: string;
  numAgents?: number;
  ticks?: number;
  parallel?: number;
  managerId?: string;
  cleanup?: boolean;
  dryRun?: boolean;
  outputDir?: string;
}

export interface RunFeedGenerationResponse {
  workspaceRoot: string;
  feedCliRoot: string;
  outputDir: string;
  artifacts: Array<{
    schema: string | null;
    manifestPath: string;
    exportPath: string | null;
    outputDir: string | null;
    sourceKind: string | null;
    trajectories: number | null;
    archetypes: unknown;
    generatedAt: string | null;
  }>;
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunScenarioOptions {
  workspaceRoot?: string;
  bun?: string;
  scenarioDir?: string;
  outputDir?: string;
  runId?: string;
  scenario?: string;
  fileGlobs?: string[];
  exportNative?: boolean;
  useDeterministicProxy?: boolean;
  dryRun?: boolean;
}

export interface RunScenarioResponse {
  workspaceRoot: string;
  scenarioRunnerRoot: string;
  scenarioDir: string;
  outputDir: string;
  runId: string;
  matrixPath: string;
  viewerHtmlPath: string;
  nativeJsonlPath: string | null;
  nativeManifestPath: string | null;
  command: string[];
  env: Record<string, string>;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunLocalEvalComparisonOptions {
  trainingRoot?: string;
  python?: string;
  manifestPath?: string;
  model?: string;
  trainedModelPath?: string;
  backend?: "mlx" | "cuda" | "cpu";
  promptFile?: string;
  maxTokens?: number;
  systemPrompt?: string;
  outputPath?: string;
  outputDir?: string;
  dryRun?: boolean;
}

export interface RunLocalEvalComparisonResponse {
  outputDir: string;
  artifactPath: string;
  artifact: Record<string, unknown>;
  trainingRoot: string;
  command: string[];
  reportPath: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunTrainingCollectionOptions {
  preflightOnly?: boolean;
  preflightProbe?: boolean;
  outputDir?: string;
  workspaceRoot?: string;
  includeHuggingFace?: boolean;
  includeFeed?: boolean;
  includeNaturalTrajectories?: boolean;
  includeTestTrajectories?: boolean;
  includeScenarios?: boolean;
  includeEvalComparison?: boolean;
  includeActionBenchmark?: boolean;
  includeBenchmarkVsCerebras?: boolean;
  includeEliza1ModelRegistry?: boolean;
  includeEliza1BundleStage?: boolean;
  includeBenchmarkMatrix?: boolean;
  huggingFace?: IngestHuggingFaceDatasetOptions;
  feed?: RunFeedGenerationOptions;
  naturalTrajectories?: {
    outputDir?: string;
    trajectoryIds?: string[];
    runId?: string;
    limit?: number;
    rawJsonlPath?: string;
    sanitizedJsonlPath?: string;
    includeRawJsonl?: boolean;
    tasks?: string[];
    source?: Record<string, unknown>;
    privacy?: Record<string, unknown>;
    uploadToHuggingFace?: boolean | Record<string, unknown>;
  };
  testTrajectories?: {
    roots?: string[];
    outputDir?: string;
    workspaceRoot?: string;
    limit?: number;
    generatedAt?: string;
  };
  scenarios?: RunScenarioOptions;
  evalComparison?: RunLocalEvalComparisonOptions;
  actionBenchmark?: RunActionBenchmarkOptions;
  actionBenchmarkPair?: {
    label?: string;
    tier?: string;
    base?: RunActionBenchmarkOptions;
    trained?: RunActionBenchmarkOptions;
  };
  actionBenchmarkPairs?:
    | string
    | Array<{
        label?: string;
        tier?: string;
        base?: RunActionBenchmarkOptions;
        trained?: RunActionBenchmarkOptions;
      }>;
  benchmarkVsCerebras?: RunBenchmarkVsCerebrasOptions;
  eliza1BundleStage?: StageEliza1BundleOptions;
  benchmarkMatrix?: WriteBenchmarkMatrixFromArtifactsOptions;
  analysis?: BuildTrainingAnalysisIndexOptions;
}

export interface TrainingCollectionStep {
  id:
    | "huggingface"
    | "feed"
    | "natural_trajectories"
    | "test_trajectories"
    | "scenarios"
    | "eval_comparison"
    | "action_benchmark"
    | "benchmark_vs_cerebras"
    | "eliza1_model_registry"
    | "eliza1_bundle_stage"
    | "benchmark_matrix";
  status: "skipped" | "succeeded" | "failed";
  outputDir: string | null;
  error: string | null;
  result: unknown;
}

export interface TrainingCollectionSourceSample {
  title: string;
  path: string;
  schema: string | null;
  sourceKind: string | null;
  trajectoryId: string | null;
  scenarioId: string | null;
  task: string | null;
  input: unknown;
  output: unknown;
  model: string | null;
  systemPrompt?: unknown;
  callId?: string | null;
}

export interface TrainingCollectionEvalComparison {
  title: string;
  path: string;
  baseModel: string | null;
  trainedModel: string | null;
  backend: string | null;
  baseScore: number | null;
  trainedScore: number | null;
  improvementAbsolute: number | null;
  improvementPercent: number | null;
  baseLatencyMs: number | null;
  trainedLatencyMs: number | null;
  latencyDeltaMs: number | null;
  promptCount: number | null;
  distinctResponseCount: number | null;
  reportPath: string | null;
}

export interface TrainingCollectionCoverageSummary {
  dataSources: {
    huggingFace: number;
    feed: number;
    natural: number;
    scenarios: number;
    tests: number;
    trainingJsonl: number;
  };
  readableSamples: {
    huggingFace: number;
    feed: number;
    natural: number;
    scenarios: number;
    tests: number;
    trainingJsonl: number;
    total: number;
  };
  evals: {
    artifacts: number;
    comparisons: number;
    scoredComparisons: number;
  };
  benchmarks: {
    matrices: number;
    comparisons: number;
    scoredComparisons: number;
    caseSamples: number;
    tiers: string[];
    allEliza1TiersCovered: boolean;
    tierCoverage: Array<{
      tier: string;
      hasBase: boolean;
      hasTrained: boolean;
      hasReference: boolean;
      hasImprovement: boolean;
      benchmarkCount: number;
      comparisonCount: number;
    }>;
  };
  models: {
    artifacts: number;
    stagedBundles: number;
    inventoryCount: number;
  };
}

export interface TrainingCollectionPreflightSummary {
  liveRequired: boolean;
  checks: Array<{
    id: string;
    label: string;
    status: "ok" | "missing" | "warning" | "skipped";
    detail: string;
    path?: string | null;
  }>;
}

export interface RunTrainingCollectionPreflightResponse {
  preflight: TrainingCollectionPreflightSummary;
}

export interface TrainingCollectionRunSummary {
  generatedAt: string;
  outputDir: string;
  manifestPath: string;
  readmePath: string;
  analysisIndexHtmlPath: string;
  readinessStatus: TrainingReadinessStatus;
  readiness: {
    ready: number;
    partial: number;
    missing: number;
  };
  readinessGaps: Array<{
    id: string;
    label: string;
    status: TrainingReadinessStatus;
    note: string;
    recommendedCapability: string | null;
    recommendedParams: Record<string, unknown> | null;
  }>;
  artifactCount: number;
  stepCounts: Record<string, number>;
  dataSources: {
    huggingFaceDatasets: number;
    feedDatasets: number;
    naturalTrajectoryBundles: number;
    scenarioRuns: number;
    scenarioNativeDatasets: number;
    testTrajectories: number;
    trainingJsonlDatasets: number;
  };
  sourceSamples?: {
    huggingFace: TrainingCollectionSourceSample[];
    feed: TrainingCollectionSourceSample[];
    natural: TrainingCollectionSourceSample[];
    scenarios: TrainingCollectionSourceSample[];
    tests: TrainingCollectionSourceSample[];
    trainingJsonl: TrainingCollectionSourceSample[];
  };
  sourceArtifacts: Array<{
    category:
      | "huggingface"
      | "feed"
      | "natural"
      | "scenario"
      | "test"
      | "training_jsonl";
    title: string;
    path: string;
    schema: string | null;
  }>;
  evidenceArtifacts: Array<{
    category: "eval" | "benchmark" | "model";
    title: string;
    path: string;
    schema: string | null;
  }>;
  training: {
    trainingRuns: number;
    models: number;
    modelInventory: Array<{
      title: string;
      path: string;
      schema: string | null;
      model: string | null;
      tier: string | null;
      variant: string | null;
      outputPath: string | null;
      baseModel: string | null;
      repoId: string | null;
      baseEvalScore: number | null;
      trainedEvalScore: number | null;
      evalImprovementPercent: number | null;
    }>;
  };
  benchmarks: {
    actionBenchmarkPairs: number;
    benchmarkComparisons: number;
    caseSamples: number;
    tiers: string[];
    comparisonInventory: Array<{
      tier: string | null;
      benchmark: string | null;
      baseModelId: string | null;
      trainedModelId: string | null;
      referenceModelId: string | null;
      baseScore: number | null;
      trainedScore: number | null;
      improvementPercent: number | null;
      referenceScore: number | null;
      trainedVsReferencePercent: number | null;
      dryRun: boolean;
      useMocks: boolean;
      modelBacked: boolean;
    }>;
    baselineProgress: {
      tierOrder: string[];
      establishedTiers: string[];
      remainingTiers: string[];
      nextTier: string | null;
      smallestTierEstablished: boolean;
      allTiersEstablished: boolean;
    };
  };
  evals: {
    evalArtifacts: number;
    evalComparisons: number;
    actionBenchmarks: number;
    benchmarkMatrices: number;
    comparisonInventory: TrainingCollectionEvalComparison[];
  };
  coverage?: TrainingCollectionCoverageSummary;
}

export interface ListTrainingCollectionsResponse {
  root: string;
  indexJsonPath: string;
  indexHtmlPath: string;
  collections: TrainingCollectionRunSummary[];
}

export interface RunTrainingCollectionResponse {
  outputDir: string;
  manifestPath: string;
  readmePath: string;
  collectionIndex: ListTrainingCollectionsResponse & {
    schema: string;
    schemaVersion: number;
    generatedAt: string;
  };
  manifest: {
    schema: string;
    schemaVersion: number;
    generatedAt: string;
    outputDir: string;
    manifestPath: string;
    readmePath: string;
    provenance: {
      generatedBy: string;
      workspaceRoot: string | null;
      trainingStateRoot: string;
      analysisRoots: string[];
      outputLayout: {
        collection: string;
        analysis: string;
        steps: string;
      };
    };
    recipe: {
      include: Record<string, boolean>;
      sources: Record<string, Record<string, unknown>>;
      evals: {
        evalComparison: Record<string, unknown>;
        actionBenchmark: Record<string, unknown>;
        actionBenchmarkPair: Record<string, unknown> | null;
        actionBenchmarkPairs: Record<string, unknown>[];
        benchmarkVsCerebras: Record<string, unknown>;
        benchmarkMatrix: Record<string, unknown>;
      };
      training: Record<string, Record<string, unknown>>;
    };
    analysis: {
      outputDir: string;
      indexHtmlPath: string;
      manifestPath: string;
      artifactCount: number;
    };
    readiness: {
      outputDir: string;
      reportPath: string;
      status: TrainingReadinessStatus;
      ready: number;
      partial: number;
      missing: number;
    };
    evidence: {
      preflight?: TrainingCollectionPreflightSummary;
      viewerHtmlPath: string;
      analysisManifestPath: string;
      readinessReportPath: string;
      artifactCounts: Record<string, number>;
      stepCounts: Record<string, number>;
      stepArtifacts?: Array<{
        stepId: string;
        status: string;
        outputDir: string | null;
        command: string[] | null;
        exitCode: number | null;
        stdout?: string | null;
        stderr?: string | null;
        paths: Array<{
          label: string;
          path: string;
        }>;
      }>;
      dataSources: {
        huggingFaceDatasets: number;
        feedDatasets: number;
        naturalTrajectoryBundles: number;
        scenarioRuns: number;
        scenarioNativeDatasets: number;
        testTrajectories: number;
        trainingJsonlDatasets: number;
      };
      feed?: {
        runs: Array<{
          title: string;
          path: string;
          schema: string | null;
          sourceKind: string | null;
          archetype: string | null;
          archetypes: unknown;
          trajectories: number | null;
          totalTicks: number | null;
          durationMs: number | null;
          errors: number | null;
          exportPath: string | null;
          outputDir: string | null;
        }>;
        archetypeStats: Array<{
          title: string;
          path: string;
          archetype: string;
          agents: number | null;
          trajectories: number | null;
          avgTicksPerAgent: number | null;
        }>;
        trajectorySamples: Array<{
          title: string;
          path: string;
          trajectoryId: string | null;
          agentId: string | null;
          archetype: string | null;
          scenarioId: string | null;
          score: number | null;
          finalPnl: number | null;
          steps: number | null;
          firstStep: unknown;
          firstInput: unknown;
          firstOutput: unknown;
          reasoning: unknown;
        }>;
      };
      sourceSamples?: {
        huggingFace: TrainingCollectionSourceSample[];
        feed: TrainingCollectionSourceSample[];
        natural: TrainingCollectionSourceSample[];
        scenarios: TrainingCollectionSourceSample[];
        tests: TrainingCollectionSourceSample[];
        trainingJsonl: TrainingCollectionSourceSample[];
      };
      evals: {
        evalArtifacts: number;
        actionBenchmarks: number;
        evalComparisons: number;
        benchmarkMatrices: number;
        comparisonInventory: TrainingCollectionEvalComparison[];
      };
      coverage?: TrainingCollectionCoverageSummary;
      artifactLinks: Array<{
        category:
          | "huggingface"
          | "feed"
          | "natural"
          | "scenario"
          | "test"
          | "training_jsonl"
          | "eval"
          | "benchmark"
          | "model"
          | "other";
        kind: TrainingAnalysisArtifactKind;
        title: string;
        path: string;
        schema: string | null;
      }>;
      evidenceArtifacts: Array<{
        category: "eval" | "benchmark" | "model";
        title: string;
        path: string;
        schema: string | null;
      }>;
      training: {
        trainingRuns: number;
        models: number;
        modelInventory: Array<{
          title: string;
          path: string;
          schema: string | null;
          model: string | null;
          tier: string | null;
          variant: string | null;
          outputPath: string | null;
          baseModel: string | null;
          repoId: string | null;
          baseEvalScore: number | null;
          trainedEvalScore: number | null;
          evalImprovementPercent: number | null;
        }>;
      };
      benchmarks: {
        actionBenchmarkPairs: number;
        actionBenchmarkMatrixSources: number;
        benchmarkRows: number;
        benchmarkComparisons: number;
        tiers: string[];
        comparisonInventory: Array<{
          tier: string | null;
          benchmark: string | null;
          baseModelId: string | null;
          trainedModelId: string | null;
          referenceModelId: string | null;
          baseScore: number | null;
          trainedScore: number | null;
          improvementPercent: number | null;
          referenceScore: number | null;
          trainedVsReferencePercent: number | null;
          dryRun: boolean;
          useMocks: boolean;
          modelBacked: boolean;
        }>;
        improvementComparisons: Array<{
          tier: string | null;
          benchmark: string | null;
          baseScore: number | null;
          trainedScore: number | null;
          improvementPercent: number | null;
          referenceScore: number | null;
          trainedVsReferencePercent: number | null;
          modelBacked: boolean;
        }>;
        baselineProgress: {
          tierOrder: string[];
          establishedTiers: string[];
          remainingTiers: string[];
          nextTier: string | null;
          smallestTierEstablished: boolean;
          allTiersEstablished: boolean;
        };
        caseSamples?: Array<{
          tier: string | null;
          variant: string | null;
          modelId: string | null;
          benchmark: string | null;
          score: number | null;
          caseId: string | null;
          prompt: string | null;
          expectedAction: string | null;
          actualAction: string | null;
          pass: boolean;
          response: string | null;
          latencyMs: number | null;
          trajectoryPath: string | null;
          useMocks: boolean;
        }>;
      };
      benchmarkReadiness: {
        smallestTier: TrainingReadinessStatus;
        allEliza1Tiers: TrainingReadinessStatus;
        allEliza1TierImprovements: TrainingReadinessStatus;
        cerebrasReference: TrainingReadinessStatus;
        baseTrainedImprovement: TrainingReadinessStatus;
      };
      readinessGaps: Array<{
        id: string;
        label: string;
        status: TrainingReadinessStatus;
        note: string;
        recommendedCapability: string | null;
        recommendedParams: Record<string, unknown> | null;
      }>;
    };
    steps: TrainingCollectionStep[];
  };
  analysis: TrainingAnalysisIndexResponse;
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
  updateAuthority?:
    | "package-manager"
    | "os-package-manager"
    | "developer"
    | "operator";
  nextAction?:
    | "run-package-manager-command"
    | "run-git-pull"
    | "review-installation"
    | "none";
  canAutoUpdate?: boolean;
  canExecuteUpdate?: boolean;
  remoteDisplay?: boolean;
  updateCommand?: string | null;
  updateInstructions?: string;
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
  directory?: string | null;
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
  kind?: string;
  registryKind?: string;
  origin?: "builtin" | "third-party" | string;
  source?: string;
  support?: "first-party" | "community" | string;
  builtIn?: boolean;
  firstParty?: boolean;
  thirdParty?: boolean;
  status?: string;
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
  origin?: string;
  support?: string;
  builtIn?: boolean;
  firstParty?: boolean;
  thirdParty?: boolean;
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
  origin?: string;
  support?: string;
  builtIn?: boolean;
  firstParty?: boolean;
  thirdParty?: boolean;
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

export interface WorkbenchVfsEntry {
  path: string;
  type: "file" | "directory";
  size: number;
  mtimeMs: number;
}

export interface WorkbenchVfsSnapshot {
  id: string;
  projectId: string;
  createdAt: string;
  filesBytes: number;
  fileCount: number;
  note?: string;
}

export interface WorkbenchVfsQuota {
  usedBytes: number;
  fileCount: number;
  quotaBytes: number;
  maxFileBytes: number;
}

export interface WorkbenchVfsProject {
  projectId: string;
}

export interface WorkbenchVfsDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  before?: WorkbenchVfsEntry;
  after?: WorkbenchVfsEntry;
}

export interface WorkbenchVfsCompileResult {
  outFile: string;
  format: "esm" | "cjs";
  target: string;
  warnings: unknown[];
  durationMs: number;
}

export interface WorkbenchLoadedVfsPlugin {
  pluginName: string;
  vfsPath: string;
  projectId: string | null;
  loadedAt: number;
}

export type AutomationType =
  | "coordinator_text"
  | "workflow"
  | "automation_draft";
export type AutomationSource =
  | "workbench_task"
  | "trigger"
  | "workflow"
  | "workflow_draft"
  | "workflow_shadow"
  | "automation_draft"
  | "scheduled_task";
export type AutomationStatus =
  | "active"
  | "paused"
  | "completed"
  | "draft"
  | "system";
// The automation-node catalog contract is owned by @elizaos/shared so the Node
// API can type its route handlers without importing this React-adjacent module.
export type {
  AutomationNodeCatalogResponse,
  AutomationNodeClass,
  AutomationNodeDescriptor,
} from "@elizaos/shared";

export interface AutomationRoomBinding {
  conversationId: string | null;
  roomId: string;
  scope: ConversationScope;
  sourceConversationId?: string;
  terminalBridgeConversationId?: string;
}

export interface AutomationLastExecution {
  status: "success" | "error" | "running" | "waiting" | "unknown";
  startedAt: string;
  stoppedAt?: string | null;
  errorMessage?: string;
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
  workflow?: import("./client-types-chat").WorkflowDefinition;
  /**
   * Raw LifeOps scheduled task this item was adapted from, when
   * `source === "scheduled_task"`. Lets a scheduled-task editor read the
   * original record without re-fetching. Absent for workflow/task/trigger
   * items.
   */
  scheduledTask?: ScheduledTaskView;
  schedules: TriggerSummary[];
  room?: AutomationRoomBinding | null;
  lastExecution?: AutomationLastExecution;
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
  workflowStatus: import("./client-types-chat").WorkflowStatusResponse | null;
  workflowFetchError: string | null;
}

export type { LifeOpsOccurrenceActionResult } from "@elizaos/shared";

// Voice / TTS config
export type VoiceProvider =
  | "elevenlabs"
  | "robot-voice"
  | "edge"
  | "local-inference";
export type VoiceMode = "cloud" | "own-key";

/**
 * Speech-to-text provider. The legacy `whisper.cpp` pipeline has been
 * retired; on-device transcription now flows through the same local-inference
 * runtime that hosts the LLM (Gemma ASR bundle). Settings UI surfaces an
 * advanced override so users can switch to Eliza Cloud or OpenAI Whisper.
 */
export type AsrProvider = "local-inference" | "eliza-cloud" | "openai";

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
  /**
   * Optional ASR (speech-to-text) configuration. When unset, the runtime
   * falls back to the device+mode default resolved by
   * `pickDefaultVoiceProvider`.
   */
  asr?: {
    provider: AsrProvider;
    /** Optional override model id (e.g. `whisper-1` for OpenAI). */
    modelId?: string;
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
