// ---------------------------------------------------------------------------
// Cloud types — Cloud*, App*, Trajectory*, Registry*, Whitelist*,
// Verification*, Wallet display types, CodingAgent*, Pty*
// ---------------------------------------------------------------------------

import type {
  TrajectoryExportOptions as CoreTrajectoryExportOptions,
  TrajectoryListOptions as CoreTrajectoryListOptions,
  TrajectoryListResult as CoreTrajectoryListResult,
  TrajectoryLlmCallRecord as CoreTrajectoryLlmCallRecord,
  TrajectoryProviderAccessRecord as CoreTrajectoryProviderAccessRecord,
  TrajectorySummaryRecord as CoreTrajectorySummaryRecord,
} from "@elizaos/core";
import type {
  AppSessionConfig,
  AppUiExtensionConfig,
  AppViewerConfig,
  RegistryAppInfo,
} from "@elizaos/shared";
import type { TrajectoryExportFormat } from "./client-types-core";

export type {
  AppSessionConfig,
  AppUiExtensionConfig,
  AppViewerConfig,
  RegistryAppInfo,
};

// Cloud
export interface CloudStatus {
  connected: boolean;
  enabled?: boolean;
  cloudVoiceProxyAvailable?: boolean;
  hasApiKey?: boolean;
  userId?: string;
  organizationId?: string;
  topUpUrl?: string;
  reason?: string;
}

export interface CloudCredits {
  connected: boolean;
  balance: number | null;
  /** True when the cloud API rejected the stored API key (same as chat 401). */
  authRejected?: boolean;
  error?: string;
  low?: boolean;
  critical?: boolean;
  topUpUrl?: string;
}

export interface CloudBillingPaymentMethod {
  id: string;
  type: string;
  label?: string;
  brand?: string;
  last4?: string;
  expiryMonth?: number;
  expiryYear?: number;
  isDefault?: boolean;
  walletAddress?: string;
  network?: string;
}

export interface CloudBillingHistoryItem {
  id: string;
  kind?: string;
  provider?: string;
  status: string;
  amount: number;
  currency: string;
  description?: string;
  receiptUrl?: string;
  createdAt: string;
}

export interface CloudBillingSummary {
  balance: number | null;
  currency?: string;
  low?: boolean;
  critical?: boolean;
  topUpUrl?: string;
  embeddedCheckoutEnabled?: boolean;
  hostedCheckoutEnabled?: boolean;
  cryptoEnabled?: boolean;
  paymentMethods?: CloudBillingPaymentMethod[];
  history?: CloudBillingHistoryItem[];
  [key: string]: unknown;
}

export interface CloudBillingSettings {
  success?: boolean;
  message?: string;
  error?: string;
  settings?: {
    autoTopUp?: {
      enabled?: boolean;
      amount?: number | null;
      threshold?: number | null;
      hasPaymentMethod?: boolean;
    };
    limits?: {
      minAmount?: number;
      maxAmount?: number;
      minThreshold?: number;
      maxThreshold?: number;
    };
  };
  [key: string]: unknown;
}

export interface CloudBillingSettingsUpdateRequest {
  autoTopUp?: {
    enabled?: boolean;
    amount?: number;
    threshold?: number;
  };
}

export interface CloudBillingCheckoutRequest {
  amountUsd: number;
  mode?: "embedded" | "hosted";
}

export interface CloudBillingCheckoutResponse {
  success?: boolean;
  provider?: string;
  mode?: "embedded" | "hosted";
  checkoutUrl?: string;
  url?: string;
  publishableKey?: string;
  clientSecret?: string;
  sessionId?: string;
  message?: string;
  [key: string]: unknown;
}

export interface CloudBillingCryptoQuoteRequest {
  amountUsd: number;
  currency?: string;
  network?: string;
  walletAddress?: string;
}

export interface CloudBillingCryptoQuoteResponse {
  success?: boolean;
  provider?: string;
  invoiceId?: string;
  network?: string;
  currency?: string;
  amount?: string;
  amountUsd?: number;
  payToAddress?: string;
  tokenAddress?: string;
  paymentLinkUrl?: string;
  expiresAt?: string;
  memo?: string;
  [key: string]: unknown;
}

export interface CloudLoginResponse {
  ok: boolean;
  sessionId: string;
  browserUrl: string;
  error?: string;
}

export interface CloudLoginPollResponse {
  status: "pending" | "authenticated" | "expired" | "error";
  /**
   * Cloud API key, returned only on `status: "authenticated"`. The renderer
   * uses this to populate `globalThis.__ELIZA_CLOUD_AUTH_TOKEN__` so the
   * direct cloud path (`/api/v1/eliza/...`) can be used for agent
   * provisioning. Without it the renderer falls back to the proxy compat
   * path whose queue doesn't drain.
   */
  token?: string;
  keyPrefix?: string;
  organizationId?: string;
  userId?: string;
  error?: string;
}

export interface CloudLoginPersistResponse {
  ok: boolean;
  error?: string;
}

// Cloud Compat (Eliza Cloud v2 thin-client types)
export interface CloudCompatAgent {
  agent_id: string;
  agent_name: string;
  node_id: string | null;
  container_id: string | null;
  headscale_ip: string | null;
  bridge_url: string | null;
  web_ui_url: string | null;
  status: string;
  agent_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  containerUrl: string;
  webUiUrl: string | null;
  database_status: string;
  error_message: string | null;
  last_heartbeat_at: string | null;
}

export interface CloudCompatAgentStatus {
  status: string;
  lastHeartbeat: string | null;
  bridgeUrl: string | null;
  webUiUrl: string | null;
  currentNode: string | null;
  suspendedReason: string | null;
  databaseStatus: string;
}

export interface CloudCompatAgentProvisionResponse {
  success: boolean;
  created?: boolean;
  alreadyInProgress?: boolean;
  message?: string;
  error?: string;
  requiredBalance?: number;
  currentBalance?: number;
  data?: {
    id?: string;
    agentId?: string;
    agentName?: string;
    status?: string;
    jobId?: string;
    bridgeUrl?: string | null;
    webUiUrl?: string | null;
    runtimeUrl?: string | null;
    containerUrl?: string | null;
    healthUrl?: string | null;
    estimatedCompletionAt?: string | null;
  };
  polling?: {
    endpoint?: string;
    intervalMs?: number;
    expectedDurationMs?: number;
  };
}

export interface CloudCompatManagedDiscordStatus {
  applicationId: string | null;
  configured: boolean;
  connected: boolean;
  developerPortalUrl: string;
  guildId: string | null;
  guildName: string | null;
  adminDiscordUserId: string | null;
  adminDiscordUsername: string | null;
  adminDiscordDisplayName: string | null;
  adminDiscordAvatarUrl: string | null;
  adminElizaUserId: string | null;
  botNickname: string | null;
  connectedAt: string | null;
  restarted?: boolean;
}

/** Discord plugin config shape exposed to cloud dashboard. */
export interface CloudCompatDiscordConfig {
  dm?: {
    enabled?: boolean;
    policy?: "open" | "pairing" | "allowlist";
    allowFrom?: Array<string | number>;
    groupEnabled?: boolean;
  };
  requireMention?: boolean;
  reactionNotifications?: "off" | "own" | "all" | "allowlist";
  actions?: {
    reactions?: boolean;
    stickers?: boolean;
    emojiUploads?: boolean;
    stickerUploads?: boolean;
    polls?: boolean;
    permissions?: boolean;
    messages?: boolean;
    threads?: boolean;
    pins?: boolean;
    search?: boolean;
    memberInfo?: boolean;
    roleInfo?: boolean;
    roles?: boolean;
    channelInfo?: boolean;
    voiceStatus?: boolean;
    events?: boolean;
    moderation?: boolean;
    channels?: boolean;
    presence?: boolean;
  };
  maxLinesPerMessage?: number;
  textChunkLimit?: number;
  intents?: {
    presence?: boolean;
    guildMembers?: boolean;
  };
  pluralkit?: {
    enabled?: boolean;
  };
  execApprovals?: {
    enabled?: boolean;
  };
}

export interface CloudCompatManagedGithubStatus {
  configured: boolean;
  connected: boolean;
  mode?: "cloud-managed" | "shared-owner" | null;
  connectionId: string | null;
  connectionRole?: CloudOAuthConnectionRole | null;
  githubUserId: string | null;
  githubUsername: string | null;
  githubDisplayName: string | null;
  githubAvatarUrl: string | null;
  githubEmail: string | null;
  scopes: string[];
  source?: CloudOAuthConnectionSource | null;
  adminElizaUserId: string | null;
  connectedAt: string | null;
  restarted?: boolean;
}

export type CloudOAuthConnectionRole = "owner" | "agent";
export type CloudOAuthConnectionStatus =
  | "pending"
  | "active"
  | "expired"
  | "revoked"
  | "error";
export type CloudOAuthConnectionSource = "platform_credentials" | "secrets";

export interface CloudOAuthConnection {
  id: string;
  userId?: string;
  connectionRole?: CloudOAuthConnectionRole;
  platform: string;
  platformUserId: string;
  email?: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  status: CloudOAuthConnectionStatus;
  scopes: string[];
  linkedAt: string;
  lastUsedAt?: string;
  tokenExpired: boolean;
  source: CloudOAuthConnectionSource;
}

export interface CloudOAuthInitiateResponse {
  authUrl: string;
  state?: string;
  provider?: {
    id: string;
    name: string;
  };
}

export interface CloudTwitterOAuthInitiateResponse
  extends CloudOAuthInitiateResponse {
  oauthToken?: string;
  flow?: "oauth1a" | "oauth2";
  connectionRole?: CloudOAuthConnectionRole;
}

export interface CloudCompatJob {
  jobId: string;
  type: string;
  status: "queued" | "processing" | "completed" | "failed" | "retrying";
  data: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  retryCount: number;
  id: string;
  name: string;
  state: string;
  created_on: string;
  completed_on: string | null;
}

export interface CloudCompatLaunchResult {
  agentId: string;
  agentName: string;
  appUrl: string;
  launchSessionId: string | null;
  issuedAt: string;
  connection: {
    apiBase: string;
    token: string;
  };
}

// App types
export type AppSessionMode = "viewer" | "spectate-and-steer" | "external";

export type AppSessionFeature =
  | "commands"
  | "telemetry"
  | "pause"
  | "resume"
  | "suggestions";

export type AppSessionControlAction = "pause" | "resume";
export type AppRunViewerAttachment = "attached" | "detached" | "unavailable";
export type AppRunHealthState = "healthy" | "degraded" | "offline";
export type AppRunCapabilityAvailability =
  | "available"
  | "unavailable"
  | "unknown";
export type AppRunEventKind =
  | "launch"
  | "refresh"
  | "attach"
  | "detach"
  | "stop"
  | "status"
  | "summary"
  | "health";
export type AppRunEventSeverity = "info" | "warning" | "error";

export type AppSessionJsonValue =
  | string
  | number
  | boolean
  | null
  | AppSessionJsonValue[]
  | { [key: string]: AppSessionJsonValue };

export interface AppViewerAuthMessage {
  type: string;
  authToken?: string;
  sessionToken?: string;
  agentId?: string;
  characterId?: string;
  followEntity?: string;
}

// AppViewerConfig, AppUiExtensionConfig — imported from @elizaos/shared/contracts/apps

export interface AppSessionRecommendation {
  id: string;
  label: string;
  type?: string;
  reason?: string | null;
  priority?: number | null;
  command?: string | null;
}

export interface AppSessionActivityItem {
  id: string;
  type: string;
  message: string;
  timestamp?: number | null;
  severity?: "info" | "warning" | "error";
}

// AppSessionConfig — imported from @elizaos/shared/contracts/apps

export interface AppSessionState {
  sessionId: string;
  appName: string;
  mode: AppSessionMode;
  status: string;
  displayName?: string;
  agentId?: string;
  characterId?: string;
  followEntity?: string;
  canSendCommands?: boolean;
  controls?: AppSessionControlAction[];
  summary?: string | null;
  goalLabel?: string | null;
  suggestedPrompts?: string[];
  recommendations?: AppSessionRecommendation[];
  activity?: AppSessionActivityItem[];
  telemetry?: Record<string, AppSessionJsonValue> | null;
}

export interface AppSessionActionResult {
  success: boolean;
  message: string;
  session?: AppSessionState | null;
}

export interface AppRunHealth {
  state: AppRunHealthState;
  message: string | null;
}

export interface AppRunHealthFacet {
  state: AppRunHealthState | "unknown";
  message: string | null;
}

export interface AppRunHealthDetails {
  checkedAt: string | null;
  auth: AppRunHealthFacet;
  runtime: AppRunHealthFacet;
  viewer: AppRunHealthFacet;
  chat: AppRunHealthFacet;
  control: AppRunHealthFacet;
  message: string | null;
}

export interface AppRunEvent {
  eventId: string;
  kind: AppRunEventKind;
  severity: AppRunEventSeverity;
  message: string;
  createdAt: string;
  status?: string | null;
  details?: Record<string, AppSessionJsonValue> | null;
}

export interface AppRunAwaySummary {
  generatedAt: string;
  message: string;
  eventCount: number;
  since: string | null;
  until: string | null;
}

export interface AppRunSummary {
  runId: string;
  appName: string;
  displayName: string;
  pluginName: string;
  launchType: string;
  launchUrl: string | null;
  viewer: AppViewerConfig | null;
  session: AppSessionState | null;
  characterId?: string | null;
  agentId?: string | null;
  status: string;
  summary: string | null;
  startedAt: string;
  updatedAt: string;
  lastHeartbeatAt: string | null;
  supportsBackground: boolean;
  supportsViewerDetach?: boolean;
  chatAvailability?: AppRunCapabilityAvailability;
  controlAvailability?: AppRunCapabilityAvailability;
  viewerAttachment: AppRunViewerAttachment;
  recentEvents?: AppRunEvent[];
  awaySummary?: AppRunAwaySummary | null;
  health: AppRunHealth;
  healthDetails?: AppRunHealthDetails;
}

export interface AppRunActionResult {
  success: boolean;
  message: string;
  run?: AppRunSummary | null;
}

export type AppLaunchDiagnosticSeverity = "info" | "warning" | "error";

export interface AppLaunchDiagnostic {
  code: string;
  severity: AppLaunchDiagnosticSeverity;
  message: string;
}

// RegistryAppInfo — imported from @elizaos/shared/contracts/apps

export interface InstalledAppInfo {
  name: string;
  displayName: string;
  version: string;
  installPath: string;
  installedAt: string;
  isRunning: boolean;
}

export interface AppLaunchResult {
  pluginInstalled: boolean;
  needsRestart: boolean;
  displayName: string;
  launchType: string;
  launchUrl: string | null;
  viewer: AppViewerConfig | null;
  session: AppSessionState | null;
  run: AppRunSummary | null;
  diagnostics?: AppLaunchDiagnostic[];
}

export interface AppStopResult {
  success: boolean;
  appName: string;
  runId: string | null;
  stoppedAt: string;
  pluginUninstalled: boolean;
  needsRestart: boolean;
  stopScope: "plugin-uninstalled" | "viewer-session" | "no-op";
  message: string;
}

// Trajectories
export interface TrajectoryRecord extends CoreTrajectorySummaryRecord {
  roomId: string | null;
  entityId: string | null;
  conversationId: string | null;
  metadata: Record<string, TrajectoryJsonValue | undefined>;
  updatedAt: string;
}

export interface TrajectoryLlmCall extends CoreTrajectoryLlmCallRecord {
  id: string;
  trajectoryId: string;
  stepId: string;
  timestamp: number;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  temperature: number;
  maxTokens: number;
  purpose: string;
  actionType: string;
  latencyMs: number;
  createdAt: string;
}

export interface TrajectoryProviderAccess
  extends CoreTrajectoryProviderAccessRecord {
  id: string;
  trajectoryId: string;
  stepId: string;
  providerName: string;
  purpose: string;
  data: Record<string, unknown>;
  timestamp: number;
  createdAt: string;
}

export type TrajectoryJsonValue =
  | string
  | number
  | boolean
  | null
  | TrajectoryJsonValue[]
  | { [key: string]: TrajectoryJsonValue };

export type ContextEventType =
  | "message"
  | "memory"
  | "provider"
  | "tool"
  | "instruction"
  | "segment"
  | "metadata"
  | (string & {});

export type ContextEventRole =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | (string & {});

export interface ContextEventBase {
  id: string;
  type: ContextEventType;
  createdAt?: number;
  source?: string;
  metadata?: Record<string, TrajectoryJsonValue | undefined>;
}

export interface ContextMessageEvent extends ContextEventBase {
  type: "message";
  message: {
    id?: string;
    role: ContextEventRole;
    content: string | TrajectoryJsonValue;
    name?: string;
    metadata?: Record<string, TrajectoryJsonValue | undefined>;
  };
}

export interface ContextMemoryEvent extends ContextEventBase {
  type: "memory";
  memory: Record<string, unknown>;
}

export interface ContextProviderEvent extends ContextEventBase {
  type: "provider";
  name: string;
  text?: string;
  values?: Record<string, TrajectoryJsonValue | undefined>;
  data?: Record<string, unknown>;
}

export interface ContextToolEvent extends ContextEventBase {
  type: "tool";
  tool: {
    id?: string;
    name: string;
    description?: string;
    parameters?: unknown;
    metadata?: Record<string, TrajectoryJsonValue | undefined>;
  };
}

export interface ContextInstructionEvent extends ContextEventBase {
  type: "instruction";
  content: string;
  role?: ContextEventRole;
  stable?: boolean;
}

export interface ContextSegmentEvent extends ContextEventBase {
  type: "segment";
  segment: Record<string, unknown> & {
    id?: string;
    label?: string;
    tokenCount?: number;
  };
}

export interface ContextMetadataEvent extends ContextEventBase {
  type: "metadata";
  key: string;
  value: TrajectoryJsonValue;
}

export type ContextEvent =
  | ContextMessageEvent
  | ContextMemoryEvent
  | ContextProviderEvent
  | ContextToolEvent
  | ContextInstructionEvent
  | ContextSegmentEvent
  | ContextMetadataEvent
  | (ContextEventBase & Record<string, unknown>);

export type NativeToolCallStatus =
  | "queued"
  | "running"
  | "completed"
  | "skipped"
  | "failed";

export interface TrajectoryEventBase {
  id: string;
  trajectoryId?: string;
  stepId?: string;
  stage?: PipelineStageName;
  timestamp?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export type PipelineStageName =
  | "input"
  | "should_respond"
  | "message_handler"
  | "plan"
  | "planner"
  | "sub_planner"
  | "actions"
  | "evaluators"
  | "evaluator"
  | "context"
  | "cache"
  | (string & {});

export interface NativeToolCallEvent extends TrajectoryEventBase {
  type: "tool_call" | "tool_result" | "tool_error";
  callId?: string;
  toolCallId?: string;
  actionName?: string;
  toolName?: string;
  name?: string;
  args?: Record<string, unknown>;
  input?: Record<string, unknown>;
  result?: unknown;
  output?: unknown;
  status?: NativeToolCallStatus;
  success?: boolean;
  durationMs?: number;
  duration?: number;
  error?: string;
}

export interface TrajectoryEvaluationEvent extends TrajectoryEventBase {
  type: "evaluation" | "evaluator";
  evaluatorName?: string;
  name?: string;
  status?: NativeToolCallStatus;
  success?: boolean;
  decision?: string;
  thought?: string;
  result?: unknown;
  durationMs?: number;
  error?: string;
}

export interface TrajectoryCacheObservation extends TrajectoryEventBase {
  type: "cache_observation" | "cache";
  cacheName?: string;
  key?: string;
  scope?: string;
  hit: boolean;
  reason?: string;
  ttlMs?: number;
  ageMs?: number;
  sizeBytes?: number;
  tokenCount?: number;
}

export type ContextDiffChangeType =
  | "added"
  | "removed"
  | "changed"
  | "unchanged"
  | (string & {});

export interface TrajectoryContextDiffChange {
  type: ContextDiffChangeType;
  path?: string;
  before?: unknown;
  after?: unknown;
  summary?: string;
  tokenDelta?: number;
}

export interface TrajectoryContextDiff extends TrajectoryEventBase {
  type: "context_diff";
  label?: string;
  beforeContextId?: string;
  afterContextId?: string;
  added?: number;
  removed?: number;
  changed?: number;
  tokenDelta?: number;
  changes?: TrajectoryContextDiffChange[];
  before?: unknown;
  after?: unknown;
}

export type TrajectoryEvent =
  | NativeToolCallEvent
  | TrajectoryEvaluationEvent
  | TrajectoryCacheObservation
  | TrajectoryContextDiff
  | (TrajectoryEventBase & { type: string; [key: string]: unknown });

export interface TrajectoryCacheStatsData {
  hits: number;
  misses: number;
  total: number;
  hitRate: number;
  tokenCount?: number;
  sizeBytes?: number;
}

export type TrajectoryListOptions = CoreTrajectoryListOptions;

export interface TrajectoryListResult
  extends CoreTrajectoryListResult<TrajectoryRecord> {}

export interface TrajectoryDetailResult {
  trajectory: TrajectoryRecord;
  llmCalls: TrajectoryLlmCall[];
  providerAccesses: TrajectoryProviderAccess[];
  events?: TrajectoryEvent[];
  contextEvents?: ContextEvent[];
  toolEvents?: NativeToolCallEvent[];
  evaluationEvents?: TrajectoryEvaluationEvent[];
  cacheObservations?: TrajectoryCacheObservation[];
  cacheStats?: TrajectoryCacheStatsData;
  contextDiffs?: TrajectoryContextDiff[];
}

export interface TrajectoryStats {
  totalTrajectories: number;
  totalLlmCalls: number;
  totalProviderAccesses: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  averageDurationMs: number;
  bySource: Record<string, number>;
  byModel: Record<string, number>;
}

export interface TrajectoryConfig {
  enabled: boolean;
}

export type TrajectoryExportOptions = CoreTrajectoryExportOptions & {
  format: TrajectoryExportFormat;
};

// ERC-8004 Registry & Drop types
export interface RegistryStatus {
  registered: boolean;
  tokenId: number;
  agentName: string;
  agentEndpoint: string;
  capabilitiesHash: string;
  isActive: boolean;
  tokenURI: string;
  walletAddress: string;
  totalAgents: number;
  configured: boolean;
}

export interface RegistrationResult {
  tokenId: number;
  txHash: string;
}

export interface RegistryConfig {
  configured: boolean;
  chainId: number;
  registryAddress: string | null;
  collectionAddress: string | null;
  explorerUrl: string;
}

export interface WhitelistStatus {
  eligible: boolean;
  twitterVerified: boolean;
  ogCode: string | null;
  walletAddress: string;
}

export interface VerificationMessageResponse {
  message: string;
  walletAddress: string;
}

// Coding Agent Sessions
export interface CodingAgentSession {
  sessionId: string;
  agentType: string;
  label: string;
  originalTask: string;
  workdir: string;
  status:
    | "active"
    | "blocked"
    | "completed"
    | "stopped"
    | "error"
    | "tool_running";
  decisionCount: number;
  autoResolvedCount: number;
  /** Description of the active tool when status is "tool_running". */
  toolDescription?: string;
  /** Latest activity text for the agent activity box. */
  lastActivity?: string;
}

export interface CodingAgentScratchWorkspace {
  sessionId: string;
  label: string;
  path: string;
  status: "pending_decision" | "kept" | "promoted";
  createdAt: number;
  terminalAt: number;
  terminalEvent: "stopped" | "task_complete" | "error";
  expiresAt?: number;
}

export interface AgentPreflightResult {
  adapter?: string;
  installed?: boolean;
  installCommand?: string;
  docsUrl?: string;
  auth?: {
    status: "authenticated" | "unauthenticated" | "unknown";
    method?: string;
    detail?: string;
    loginHint?: string;
  };
}

export interface CodingAgentTaskThread {
  id: string;
  title: string;
  kind: string;
  scenarioId?: string | null;
  batchId?: string | null;
  status:
    | "open"
    | "active"
    | "waiting_on_user"
    | "blocked"
    | "validating"
    | "done"
    | "failed"
    | "archived"
    | "interrupted";
  originalRequest: string;
  summary?: string;
  sessionCount: number;
  activeSessionCount: number;
  latestSessionId?: string | null;
  latestSessionLabel?: string | null;
  latestWorkdir?: string | null;
  latestRepo?: string | null;
  latestActivityAt?: number | null;
  decisionCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  archivedAt?: string | null;
}

export interface CodingAgentTaskSessionRecord {
  id: string;
  threadId: string;
  sessionId: string;
  framework: string;
  providerSource?: string | null;
  label: string;
  originalTask: string;
  workdir: string;
  repo?: string | null;
  status: string;
  decisionCount: number;
  autoResolvedCount: number;
  registeredAt: number;
  lastActivityAt: number;
  idleCheckCount: number;
  taskDelivered: boolean;
  completionSummary?: string | null;
  lastSeenDecisionIndex: number;
  lastInputSentAt?: number | null;
  stoppedAt?: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CodingAgentTaskDecisionRecord {
  id: string;
  threadId: string;
  sessionId: string;
  event: string;
  promptText: string;
  decision: string;
  response?: string | null;
  reasoning: string;
  timestamp: number;
  createdAt: string;
}

export interface CodingAgentTaskEventRecord {
  id: string;
  threadId: string;
  sessionId?: string | null;
  eventType: string;
  timestamp: number;
  summary: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface CodingAgentTaskArtifactRecord {
  id: string;
  threadId: string;
  sessionId?: string | null;
  artifactType: string;
  title: string;
  path?: string | null;
  uri?: string | null;
  mimeType?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CodingAgentTaskTranscriptRecord {
  id: string;
  threadId: string;
  sessionId: string;
  timestamp: number;
  direction: "stdout" | "stderr" | "stdin" | "keys" | "system";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CodingAgentPendingDecisionRecord {
  sessionId: string;
  threadId: string;
  promptText: string;
  recentOutput: string;
  llmDecision: Record<string, unknown>;
  taskContext: Record<string, unknown>;
  createdAt: number;
  updatedAt: string;
}

export interface CodingAgentTaskThreadDetail extends CodingAgentTaskThread {
  roomId?: string | null;
  worldId?: string | null;
  ownerUserId?: string | null;
  scenarioId?: string | null;
  batchId?: string | null;
  summary?: string;
  acceptanceCriteria?: string[];
  currentPlan?: Record<string, unknown>;
  lastUserTurnAt?: string | null;
  lastCoordinatorTurnAt?: string | null;
  metadata?: Record<string, unknown>;
  sessions: CodingAgentTaskSessionRecord[];
  decisions: CodingAgentTaskDecisionRecord[];
  events: CodingAgentTaskEventRecord[];
  artifacts: CodingAgentTaskArtifactRecord[];
  transcripts: CodingAgentTaskTranscriptRecord[];
  pendingDecisions: CodingAgentPendingDecisionRecord[];
}

export interface CodingAgentFrameworkAvailability {
  id: string;
  label: string;
  adapter: string;
  installed: boolean;
  installCommand: string;
  docsUrl: string;
  authReady: boolean;
  available: boolean;
  score: number;
  reason: string;
  warnings: string[];
}

export interface CodingAgentStatus {
  supervisionLevel: string;
  taskCount: number;
  tasks: CodingAgentSession[];
  pendingConfirmations: number;
  taskThreadCount?: number;
  taskThreads?: CodingAgentTaskThread[];
  preferredAgentType?: string;
  preferredAgentReason?: string;
  frameworks?: CodingAgentFrameworkAvailability[];
}

/** Raw PTY session shape returned by /api/coding-agents. */
export interface RawPtySession {
  id: string;
  name?: string;
  agentType?: string;
  workdir?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Maps raw PTY sessions from /api/coding-agents into CodingAgentSession[].
 * Extracted as a pure function so it can be unit-tested without instantiating
 * the full ElizaClient.
 */
export function mapPtySessionsToCodingAgentSessions(
  ptySessions: RawPtySession[],
): CodingAgentSession[] {
  return ptySessions.map((s) => ({
    sessionId: s.id,
    agentType: s.agentType ?? "claude",
    label: (s.metadata?.label as string) ?? s.name ?? s.agentType ?? "Agent",
    originalTask: "",
    workdir: s.workdir ?? "",
    status:
      s.status === "ready" || s.status === "busy"
        ? ("active" as const)
        : s.status === "error"
          ? ("error" as const)
          : s.status === "stopped" ||
              s.status === "done" ||
              s.status === "completed" ||
              s.status === "exited"
            ? ("stopped" as const)
            : ("active" as const),
    decisionCount: 0,
    autoResolvedCount: 0,
  }));
}

/** Maps persisted coordinator task threads into the existing CodingAgentSession UI shape. */
export function mapTaskThreadsToCodingAgentSessions(
  taskThreads: CodingAgentTaskThread[],
): CodingAgentSession[] {
  return taskThreads.map((thread) => ({
    sessionId: thread.latestSessionId ?? thread.id,
    agentType: "task-thread",
    label: thread.title || thread.latestSessionLabel || "Task",
    originalTask: thread.originalRequest,
    workdir: thread.latestWorkdir ?? thread.latestRepo ?? "",
    status:
      thread.status === "failed"
        ? ("error" as const)
        : thread.status === "done"
          ? ("completed" as const)
          : thread.status === "interrupted"
            ? ("stopped" as const)
            : thread.status === "validating"
              ? ("tool_running" as const)
              : thread.status === "blocked" ||
                  thread.status === "waiting_on_user"
                ? ("blocked" as const)
                : ("active" as const),
    decisionCount: thread.decisionCount,
    autoResolvedCount: 0,
    lastActivity:
      thread.status === "interrupted"
        ? "Interrupted - reopen or resume this task"
        : thread.summary || thread.latestSessionLabel || thread.status,
  }));
}
