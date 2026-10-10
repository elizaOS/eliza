/**
 * Cloud-specific types for ElizaCloud integration.
 *
 * These types mirror the eliza-cloud-v2 database schemas and API contracts
 * for containers, auth, credits, and bridge messaging.
 */

export { type CloudCodingContainerService, type CloudCodingAgent, type CloudCodingContainerSession, type CloudCodingContainerStatus, type CloudCodingPatch, type CloudCodingPatchFormat, type CloudCodingPromotion, type CloudCodingSyncDirection, type CloudCodingSyncResult, type CloudVfsBundle, type CloudVfsDeletedFile, type CloudVfsFile, type CloudVfsFileEncoding, type CloudVfsSourceKind, type PromoteVfsToCloudContainerRequest, type PromoteVfsToCloudContainerResponse, type RequestCodingAgentContainerRequest, type RequestCodingAgentContainerResponse, type SyncCloudCodingContainerRequest, type SyncCloudCodingContainerResponse } from "@elizaos/contracts";

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

// ─── Auth Types ─────────────────────────────────────────────────────────────

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

// ─── Cloud Config Types ─────────────────────────────────────────────────────

export type InferenceMode = "cloud" | "byok" | "local";

export interface CloudPluginConfig {
  /** Enable ElizaCloud integration. */
  enabled: boolean;
  /** ElizaCloud API base URL. */
  baseUrl: string;
  /** Stored API key for authenticated requests. */
  apiKey?: string;
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
}

export const DEFAULT_CLOUD_CONFIG: CloudPluginConfig = {
  enabled: false,
  baseUrl: "https://api.eliza.app/api/v1",
  inferenceMode: "cloud",
  autoProvision: false,
  bridge: {
    reconnectIntervalMs: 3000,
    maxReconnectAttempts: 20,
    heartbeatIntervalMs: 30_000,
  },
};

// ─── API Error Types ────────────────────────────────────────────────────────

export type { CloudApiErrorBody } from "@elizaos/cloud-sdk";
export {
  CloudApiError,
  InsufficientCreditsError,
} from "@elizaos/cloud-sdk";
