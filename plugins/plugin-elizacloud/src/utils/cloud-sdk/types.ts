export type {
  AgentDatabaseStatus,
  AgentDetailDto,
  AgentDetailDto as Agent,
  AgentListItemDto,
  AgentResponse,
  AgentSandboxStatus,
  AgentsResponse as AgentListResponse,
  AgentWalletStatus,
  ApiSuccessEnvelope,
  CreditBalanceResponse,
  CurrentUserDto,
  CurrentUserOrganizationDto,
  CurrentUserResponse,
  CurrentUserResponse as UserProfileResponse,
  IsoDateString,
  UpdatedUserDto,
  UpdatedUserResponse,
} from "./types.cloud-api.js";

export const DEFAULT_ELIZA_CLOUD_BASE_URL = "https://www.elizacloud.ai";
export const DEFAULT_ELIZA_CLOUD_API_BASE_URL = `${DEFAULT_ELIZA_CLOUD_BASE_URL}/api/v1`;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export type QueryValue = boolean | number | string | null | undefined;
export type QueryParams = URLSearchParams | Record<string, QueryValue | QueryValue[]>;

export interface CloudApiErrorBody {
  success: false;
  error: string;
  details?: Record<string, unknown>;
  requiredCredits?: number;
  quota?: { current: number; max: number };
}

export interface CloudRequestOptions {
  query?: QueryParams;
  headers?: HeadersInit;
  json?: unknown;
  body?: BodyInit | null;
  skipAuth?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ElizaCloudClientOptions {
  baseUrl?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
  defaultHeaders?: HeadersInit;
}

export interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
  tags?: Array<Record<string, unknown>>;
}

export interface EndpointCallOptions extends CloudRequestOptions {
  pathParams?: Record<string, string | number>;
}

export interface CliLoginStartOptions {
  sessionId?: string;
  returnTo?: string;
}

export interface CliLoginStartResponse {
  sessionId: string;
  browserUrl: string;
  status?: string;
  expiresAt?: string;
}

export interface CliLoginPollResponse {
  status: "pending" | "authenticated" | "expired" | "error" | string;
  apiKey?: string;
  token?: string;
  keyPrefix?: string;
  expiresAt?: string;
  userId?: string;
  error?: string;
}

export interface PairingTokenResponse {
  token: string;
  redirectUrl: string;
  expiresIn: number;
}

export interface AuthPairResponse {
  message: string;
  apiKey: string | null;
  agentName: string;
}

export interface ModelListEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface ModelListResponse {
  object: "list" | string;
  data: ModelListEntry[];
}

export interface ResponsesCreateRequest extends Record<string, unknown> {
  model: string;
  input?: unknown;
}

export interface ResponsesCreateResponse extends Record<string, unknown> {
  id?: string;
  status?: string;
  output?: unknown;
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    type?: string;
  };
}

export interface ChatCompletionRequest extends Record<string, unknown> {
  model?: string;
  messages: unknown[];
}

export interface ChatCompletionResponse extends Record<string, unknown> {
  id?: string;
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface EmbeddingsRequest {
  model: string;
  input: string | string[];
  dimensions?: number;
}

export interface EmbeddingsResponse {
  object?: string;
  data: Array<{ embedding: number[]; index: number; object?: string }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export interface GenerateImageRequest {
  prompt: string;
  numImages?: number;
  aspectRatio?: string;
  model?: string;
  [key: string]: unknown;
}

export interface GenerateImageResponse {
  images: Array<{ url?: string; image?: string }>;
  numImages?: number;
}

export interface CreditSummaryResponse extends Record<string, unknown> {
  success: true;
  organization: {
    id: string;
    name: string;
    creditBalance: number;
    autoTopUpEnabled?: boolean;
    autoTopUpThreshold?: number | null;
    autoTopUpAmount?: number | null;
    hasPaymentMethod?: boolean;
  };
}

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
  /** Full image reference (e.g. `ghcr.io/owner/repo:tag`). The Hetzner-Docker backend pulls it directly. */
  image: string;
}

export interface UpdateContainerRequest extends Partial<CreateContainerRequest> {
  status?: ContainerStatus;
}

export interface CreateContainerResponse {
  success: boolean;
  data: CloudContainer;
  message?: string;
  creditsDeducted?: number;
  creditsRemaining?: number;
  polling?: {
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

export interface ContainerHealthResponse {
  success: boolean;
  data: {
    status: string;
    healthy: boolean;
    lastCheck: string | null;
    uptime: number | null;
  };
}

export interface ContainerQuotaResponse extends Record<string, unknown> {
  success?: boolean;
}

export interface ContainerCredentialsResponse extends Record<string, unknown> {
  success?: boolean;
}

export interface CreateAgentRequest {
  agentName: string;
  characterId?: string;
  agentConfig?: Record<string, unknown>;
  environmentVars?: Record<string, string>;
}

export interface CreateAgentResponse {
  success: boolean;
  data: {
    id: string;
    agentName: string | null;
    status: import("./types.cloud-api.js").AgentSandboxStatus;
    createdAt?: string;
  };
}

export interface AgentLifecycleResponse extends Record<string, unknown> {
  success?: boolean;
  data?: Record<string, unknown>;
  jobId?: string;
}

export type SnapshotType = "manual" | "auto" | "pre-eviction";

export interface AgentSnapshot {
  id: string;
  containerId?: string;
  organizationId?: string;
  snapshotType?: SnapshotType | string;
  storageUrl?: string;
  sizeBytes?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  created_at?: string;
}

export interface SnapshotListResponse {
  success: boolean;
  data: AgentSnapshot[];
}

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
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
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

export interface JobStatus {
  id: string;
  status: "pending" | "in_progress" | "completed" | "failed" | string;
  result?: unknown;
  error?: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  description?: string | null;
  key_prefix: string;
  created_at: string;
  permissions?: string[];
  rate_limit?: number | null;
  expires_at?: string | null;
}

export interface ApiKeyCreateRequest {
  name: string;
  description?: string;
  permissions?: string[];
  rate_limit?: number;
  expires_at?: string | null;
}

export interface ApiKeyCreateResponse {
  apiKey: ApiKeySummary;
  plainKey: string;
}

export interface ApiKeyListResponse {
  keys: ApiKeySummary[];
}
