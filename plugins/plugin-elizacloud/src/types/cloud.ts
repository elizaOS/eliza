/**
 * Cloud-specific types for ElizaCloud integration.
 *
 * These types mirror the eliza-cloud-v2 database schemas and API contracts
 * for containers, auth, credits, bridge messaging, and agent state snapshots.
 */

// ─── Container Types ────────────────────────────────────────────────────────

export type ContainerStatus =
  | "pending"
  | "building"
  | "deploying"
  | "running"
  | "stopped"
  | "failed"
  | "suspended";

export type ContainerBillingStatus =
  | "active"
  | "warning"
  | "suspended"
  | "shutdown_pending"
  | "archived";

export type ContainerArchitecture = "arm64" | "x86_64";

export interface CloudContainer {
  id: string;
  name: string;
  project_name: string;
  description: string | null;
  organization_id: string;
  user_id: string;
  status: ContainerStatus;
  image_tag: string | null;
  port: number;
  desired_count: number;
  cpu: number;
  memory: number;
  architecture: ContainerArchitecture;
  environment_vars: Record<string, string>;
  health_check_path: string;
  load_balancer_url: string | null;
  ecr_repository_uri: string | null;
  ecr_image_tag: string | null;
  cloudformation_stack_name: string | null;
  billing_status: ContainerBillingStatus;
  total_billed: string;
  last_deployed_at: string | null;
  last_health_check: string | null;
  deployment_log: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateContainerRequest {
  name: string;
  project_name: string;
  description?: string;
  port?: number;
  desired_count?: number;
  cpu?: number;
  memory?: number;
  environment_vars?: Record<string, string>;
  health_check_path?: string;
  ecr_image_uri: string;
  ecr_repository_uri?: string;
  image_tag?: string;
  architecture?: ContainerArchitecture;
}

export interface CreateContainerResponse {
  success: boolean;
  data: CloudContainer;
  message: string;
  creditsDeducted: number;
  creditsRemaining: number;
  stackName: string;
  polling: {
    endpoint: string;
    intervalMs: number;
    expectedDurationMs: number;
  };
}

export interface ContainerListResponse {
  success: boolean;
  data: CloudContainer[];
}

export interface ContainerGetResponse {
  success: boolean;
  data: CloudContainer;
}

export interface ContainerDeleteResponse {
  success: boolean;
  message?: string;
}

export interface ContainerHealthResponse {
  success: boolean;
  data: {
    status: string;
    healthy: boolean;
    lastCheck: string | null;
    uptime: number | null;
  };
}

// ─── Coding Container Promotion / Sync Types ───────────────────────────────

export type CloudCodingAgent = "claude" | "codex" | "opencode";

export type CloudCodingContainerStatus =
  | "requested"
  | "pending"
  | "building"
  | "running"
  | "failed"
  | "stopped"
  | "stubbed";

export type CloudVfsSourceKind = "project" | "workspace";

export type CloudVfsFileEncoding = "utf8" | "base64";

export interface CloudVfsFile {
  path: string;
  contents?: string;
  encoding?: CloudVfsFileEncoding;
  size?: number;
  sha256?: string;
  mode?: string;
  mtimeMs?: number;
}

export interface CloudVfsDeletedFile {
  path: string;
  sha256?: string;
}

export interface CloudVfsBundle {
  sourceKind: CloudVfsSourceKind;
  projectId?: string;
  workspaceId?: string;
  rootPath?: string;
  snapshotId?: string;
  revision?: string;
  files?: CloudVfsFile[];
  deletedFiles?: CloudVfsDeletedFile[];
  manifest?: {
    fileCount?: number;
    totalBytes?: number;
    ignoredPaths?: string[];
  };
  metadata?: Record<string, unknown>;
}

export interface PromoteVfsToCloudContainerRequest {
  source: CloudVfsBundle;
  name?: string;
  description?: string;
  preferredAgent?: CloudCodingAgent;
  target?: {
    containerId?: string;
    workspacePath?: string;
    branchName?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface CloudCodingPromotion {
  promotionId: string;
  status: "accepted" | "uploaded" | "stubbed";
  source: CloudVfsBundle;
  workspacePath: string;
  uploadUrl?: string;
  expiresAt?: string | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface PromoteVfsToCloudContainerResponse {
  success: boolean;
  stubbed?: boolean;
  data: CloudCodingPromotion;
  message?: string;
}

export interface RequestCodingAgentContainerRequest {
  agent: CloudCodingAgent;
  promotionId?: string;
  source?: CloudVfsBundle;
  prompt?: string;
  container?: {
    name?: string;
    image?: string;
    cpu?: number;
    memory?: number;
    architecture?: ContainerArchitecture;
    environmentVars?: Record<string, string>;
  };
  workspacePath?: string;
  metadata?: Record<string, unknown>;
}

export interface CloudCodingContainerSession {
  containerId: string;
  status: CloudCodingContainerStatus;
  agent: CloudCodingAgent;
  promotionId?: string;
  workspacePath: string;
  url?: string | null;
  branchName?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface RequestCodingAgentContainerResponse {
  success: boolean;
  stubbed?: boolean;
  data: CloudCodingContainerSession;
  message?: string;
}

export type CloudCodingSyncDirection = "pull" | "push" | "roundtrip";

export type CloudCodingPatchFormat = "unified-diff" | "json-patch";

export interface CloudCodingPatch {
  path: string;
  format: CloudCodingPatchFormat;
  patch: string;
  baseSha256?: string;
  afterSha256?: string;
}

export interface SyncCloudCodingContainerRequest {
  direction?: CloudCodingSyncDirection;
  target: {
    sourceKind: CloudVfsSourceKind;
    projectId?: string;
    workspaceId?: string;
    baseRevision?: string;
    targetRevision?: string;
  };
  changedFiles?: CloudVfsFile[];
  deletedFiles?: CloudVfsDeletedFile[];
  patches?: CloudCodingPatch[];
  metadata?: Record<string, unknown>;
}

export interface CloudCodingSyncResult {
  syncId: string;
  containerId: string;
  status: "accepted" | "applied" | "ready" | "stubbed";
  direction: CloudCodingSyncDirection;
  target: SyncCloudCodingContainerRequest["target"];
  changedFiles: CloudVfsFile[];
  deletedFiles: CloudVfsDeletedFile[];
  patches: CloudCodingPatch[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface SyncCloudCodingContainerResponse {
  success: boolean;
  stubbed?: boolean;
  data: CloudCodingSyncResult;
  message?: string;
}

// ─── Auth Types ─────────────────────────────────────────────────────────────

export type DevicePlatform = "ios" | "android" | "macos" | "windows" | "linux" | "web";

export interface DeviceAuthRequest {
  deviceId: string;
  platform: DevicePlatform;
  appVersion: string;
  deviceName?: string;
}

export interface DeviceAuthResponse {
  success: boolean;
  data: {
    apiKey: string;
    userId: string;
    organizationId: string;
    credits: number;
    isNew: boolean;
  };
}

export interface CloudCredentials {
  apiKey: string;
  userId: string;
  organizationId: string;
  authenticatedAt: number;
}

// ─── Credits Types ──────────────────────────────────────────────────────────

export interface CreditBalanceResponse {
  success: boolean;
  data: {
    balance: number;
    currency: string;
  };
}

export interface CreditSummaryResponse {
  success: boolean;
  data: {
    balance: number;
    totalSpent: number;
    totalAdded: number;
    recentTransactions: CreditTransaction[];
  };
}

export interface CreditTransaction {
  id: string;
  amount: number;
  description: string;
  type: "credit" | "debit";
  created_at: string;
}

// ─── Bridge Types ───────────────────────────────────────────────────────────

export type BridgeConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface BridgeMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: BridgeError;
}

export interface BridgeError {
  code: number;
  message: string;
  data?: unknown;
}

export type BridgeMessageHandler = (message: BridgeMessage) => void;

export interface BridgeConnection {
  containerId: string;
  state: BridgeConnectionState;
  connectedAt: number | null;
  lastHeartbeat: number | null;
  reconnectAttempts: number;
}

// ─── Managed Gateway Relay Types ───────────────────────────────────────────

export interface GatewayRelaySession {
  id: string;
  organizationId: string;
  userId: string;
  runtimeAgentId: string;
  agentName: string | null;
  platform: "local-runtime";
  createdAt: string;
  lastSeenAt: string;
}

export interface GatewayRelayRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface GatewayRelayResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: Record<string, unknown>;
  error?: BridgeError;
}

export interface GatewayRelayRequestEnvelope {
  requestId: string;
  rpc: GatewayRelayRequest;
  queuedAt: string;
}

export interface RegisterGatewayRelaySessionResponse {
  success: boolean;
  data: {
    session: GatewayRelaySession;
  };
}

export interface PollGatewayRelayResponse {
  success: boolean;
  data: {
    request: GatewayRelayRequestEnvelope | null;
  };
}

// ─── Snapshot / Backup Types ────────────────────────────────────────────────

export type SnapshotType = "manual" | "auto" | "pre-eviction";

export interface AgentSnapshot {
  id: string;
  containerId: string;
  organizationId: string;
  snapshotType: SnapshotType;
  storageUrl: string;
  sizeBytes: number;
  agentConfig: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CreateSnapshotRequest {
  snapshotType?: SnapshotType;
  metadata?: Record<string, unknown>;
}

export interface CreateSnapshotResponse {
  success: boolean;
  data: AgentSnapshot;
}

export interface SnapshotListResponse {
  success: boolean;
  data: AgentSnapshot[];
}

export interface RestoreSnapshotRequest {
  snapshotId: string;
}

export interface RestoreSnapshotResponse {
  success: boolean;
  message: string;
}

// ─── Cloud Config Types ─────────────────────────────────────────────────────

export type InferenceMode = "cloud" | "byok" | "local";

export interface CloudPluginConfig {
  /** Enable ElizaCloud integration. */
  enabled: boolean;
  /** ElizaCloud API base URL. */
  baseUrl: string;
  /** Stored API key for authenticated requests. */
  apiKey?: string;
  /** Device ID used for auto-signup authentication. */
  deviceId?: string;
  /** Platform identifier. */
  platform?: DevicePlatform;
  /** Inference mode: cloud (ElizaCloud proxied), byok (user keys), local (no cloud). */
  inferenceMode: InferenceMode;
  /** Auto-deploy agents to cloud on creation. */
  autoProvision: boolean;
  /** Bridge reconnection settings. */
  bridge: {
    reconnectIntervalMs: number;
    maxReconnectAttempts: number;
    heartbeatIntervalMs: number;
  };
  /** Auto-backup settings. */
  backup: {
    autoBackupIntervalMs: number;
    maxSnapshots: number;
  };
  /** Default container settings for new deployments. */
  container: {
    defaultImage: string;
    defaultArchitecture: ContainerArchitecture;
    defaultCpu: number;
    defaultMemory: number;
    defaultPort: number;
  };
}

export const DEFAULT_CLOUD_CONFIG: CloudPluginConfig = {
  enabled: false,
  baseUrl: "https://www.elizacloud.ai/api/v1",
  inferenceMode: "cloud",
  autoProvision: false,
  bridge: {
    reconnectIntervalMs: 3000,
    maxReconnectAttempts: 20,
    heartbeatIntervalMs: 30_000,
  },
  backup: {
    autoBackupIntervalMs: 3_600_000, // 1 hour
    maxSnapshots: 10,
  },
  container: {
    defaultImage: "elizaos/agent:latest",
    defaultArchitecture: "arm64",
    defaultCpu: 1792,
    defaultMemory: 1792,
    defaultPort: 3000,
  },
};

// ─── API Error Types ────────────────────────────────────────────────────────

export type { CloudApiErrorBody } from "@elizaos/cloud-sdk";
export {
  CloudApiError,
  InsufficientCreditsError,
} from "@elizaos/cloud-sdk";
