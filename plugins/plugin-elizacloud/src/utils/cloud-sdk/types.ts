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
export const DEFAULT_ELIZA_CLOUD_API_ORIGIN = "https://api.elizacloud.ai";
export const DEFAULT_ELIZA_CLOUD_API_BASE_URL = `${DEFAULT_ELIZA_CLOUD_API_ORIGIN}/api/v1`;

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

export interface CreateCreditsCheckoutRequest {
  credits: number;
  success_url: string;
  cancel_url: string;
}

export interface CreateCreditsCheckoutResponse extends Record<string, unknown> {
  url?: string | null;
  sessionId?: string;
  checkoutUrl?: string | null;
}

export interface AppCreditsBalanceResponse extends Record<string, unknown> {
  success: boolean;
  balance?: number;
  totalPurchased?: number;
  totalSpent?: number;
  isLow?: boolean;
  error?: string;
}

export interface CreateAppCreditsCheckoutRequest {
  app_id: string;
  amount: number;
  success_url: string;
  cancel_url: string;
}

export interface CreateAppCreditsCheckoutResponse extends Record<string, unknown> {
  success: boolean;
  url?: string | null;
  sessionId?: string;
  error?: string;
}

export interface VerifyAppCreditsCheckoutResponse extends Record<string, unknown> {
  success: boolean;
  amount?: number;
  message?: string;
  status?: string;
  error?: string;
}

export type AppChargeProvider = "stripe" | "oxapay";
export type AppChargePaymentContext = "verified_payer" | "any_payer";
export type AppChargeStatus = "requested" | "pending" | "confirmed" | "expired" | string;

export interface PaymentCallbackChannel extends Record<string, unknown> {
  roomId?: string;
  room_id?: string;
  agentId?: string;
  agent_id?: string;
  source?: string;
}

export interface AppChargeRequestView extends Record<string, unknown> {
  id: string;
  appId: string;
  amountUsd: number;
  description: string | null;
  providers: AppChargeProvider[];
  paymentContext: AppChargePaymentContext;
  paymentUrl: string;
  status: AppChargeStatus;
  paidAt: string | null;
  paidProvider?: AppChargeProvider;
  providerPaymentId?: string;
  payerUserId?: string;
  payerOrganizationId?: string;
  expiresAt: string;
  createdAt: string;
  successUrl?: string;
  cancelUrl?: string;
  metadata: Record<string, unknown>;
}

export interface CreateAppChargeRequest {
  amount: number;
  description?: string;
  providers?: AppChargeProvider[];
  payment_context?: AppChargePaymentContext;
  success_url?: string;
  cancel_url?: string;
  callback_url?: string;
  callback_secret?: string;
  callback_channel?: PaymentCallbackChannel;
  callback_metadata?: Record<string, unknown>;
  lifetime_seconds?: number;
  metadata?: Record<string, unknown>;
}

export interface CreateAppChargeResponse extends Record<string, unknown> {
  success: boolean;
  charge: AppChargeRequestView;
}

export interface ListAppChargesResponse extends Record<string, unknown> {
  success: boolean;
  charges: AppChargeRequestView[];
}

export interface GetAppChargeResponse extends Record<string, unknown> {
  success: boolean;
  charge: AppChargeRequestView;
  app?: {
    id: string;
    name: string;
    description?: string | null;
    logo_url?: string | null;
    website_url?: string | null;
  };
}

export type OxaPayNetwork = "ERC20" | "TRC20" | "BEP20" | "POLYGON" | "SOL" | "BASE" | "ARB" | "OP";

export interface CreateAppChargeCheckoutRequest {
  provider: AppChargeProvider;
  success_url?: string;
  cancel_url?: string;
  return_url?: string;
  payCurrency?: string;
  network?: OxaPayNetwork;
}

export interface CreateAppChargeCheckoutResponse extends Record<string, unknown> {
  success: boolean;
  checkout: Record<string, unknown> & {
    provider: AppChargeProvider;
    url?: string | null;
    sessionId?: string;
    paymentId?: string;
    trackId?: string;
    payLink?: string;
    expiresAt?: string;
  };
}

export interface AffiliateCodeView extends Record<string, unknown> {
  id?: string;
  code?: string;
  userId?: string;
  markupPercent?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface AffiliateCodeResponse extends Record<string, unknown> {
  code: AffiliateCodeView | string | null;
}

export interface UpsertAffiliateCodeRequest {
  markupPercent: number;
}

export interface LinkAffiliateRequest {
  code: string;
}

export interface LinkAffiliateResponse extends Record<string, unknown> {
  success: boolean;
  link?: Record<string, unknown>;
  error?: string;
}

export interface X402SupportedResponse extends Record<string, unknown> {
  success: boolean;
  version?: string;
  kinds?: unknown[];
  schemes?: string[];
  networks?: string[];
  addresses?: Record<string, string>;
  error?: string;
  code?: string;
}

export interface X402FacilitatorPaymentRequest {
  paymentPayload: unknown;
  paymentRequirements: unknown;
}

export interface X402VerifyResponse extends Record<string, unknown> {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface X402SettleResponse extends Record<string, unknown> {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

export interface X402PaymentRequestView extends Record<string, unknown> {
  id: string;
  status: string;
  paid: boolean;
  amountUsd: number;
  platformFeeUsd: number;
  serviceFeeUsd: number;
  totalChargedUsd: number;
  network: string;
  asset: string;
  payTo: string;
  description: string;
  appId?: string;
  callbackUrl?: string;
  transaction?: string | null;
  payer?: string;
  createdAt: string;
  expiresAt: string;
  paidAt?: string | null;
}

export interface CreateX402PaymentRequest {
  amountUsd: number;
  network?: string;
  description?: string;
  callbackUrl?: string;
  callback_channel?: PaymentCallbackChannel;
  appId?: string;
  metadata?: Record<string, unknown>;
  expiresInSeconds?: number;
}

export interface CreateX402PaymentRequestResponse extends Record<string, unknown> {
  success: boolean;
  paymentRequest: X402PaymentRequestView;
  paymentRequired: Record<string, unknown>;
  paymentRequiredHeader: string;
}

export interface ListX402PaymentRequestsResponse extends Record<string, unknown> {
  success: boolean;
  paymentRequests: X402PaymentRequestView[];
}

export interface GetX402PaymentRequestResponse extends Record<string, unknown> {
  success: boolean;
  paymentRequest: X402PaymentRequestView;
}

export interface SettleX402PaymentRequestResponse extends Record<string, unknown> {
  success: boolean;
  paymentRequest: X402PaymentRequestView;
}

export type RedemptionNetwork = "ethereum" | "base" | "bnb" | "bsc" | "solana";

export interface CreateRedemptionRequest {
  appId?: string;
  pointsAmount: number;
  network: RedemptionNetwork;
  payoutAddress: string;
  signature?: string;
  idempotencyKey?: string;
}

export interface CreateRedemptionResponse extends Record<string, unknown> {
  success: boolean;
  redemptionId?: string;
  quote?: Record<string, unknown>;
  warnings?: string[];
  message?: string;
  error?: string;
}

export interface ListRedemptionsResponse extends Record<string, unknown> {
  success: boolean;
  redemptions: Array<Record<string, unknown>>;
  paused?: boolean;
}

export interface RedemptionBalanceResponse extends Record<string, unknown> {
  success: boolean;
  balance?: Record<string, unknown>;
  earningsBySource?: Array<Record<string, unknown>>;
  recentEarnings?: Array<Record<string, unknown>>;
  error?: string;
}

export interface RedemptionQuoteResponse extends Record<string, unknown> {
  success: boolean;
  quote?: Record<string, unknown>;
  canRedeem?: boolean;
  availableNetworks?: string[];
  error?: string;
}

export interface RedemptionStatusResponse extends Record<string, unknown> {
  success: boolean;
  operational?: boolean;
  canRedeem?: boolean;
  message?: string;
  availableNetworks?: string[];
  unavailableNetworks?: string[];
  wallets?: Record<string, unknown>;
  networks?: Array<Record<string, unknown>>;
  warnings?: string[];
  lastChecked?: string;
}

export interface AppEarningsResponse extends Record<string, unknown> {
  success: boolean;
  earnings?: Record<string, unknown>;
  monetization?: Record<string, unknown>;
  error?: string;
}

export interface AppEarningsHistoryResponse extends Record<string, unknown> {
  success: boolean;
  transactions?: Array<Record<string, unknown>>;
  pagination?: Record<string, unknown>;
  error?: string;
}

export interface WithdrawAppEarningsRequest {
  amount: number;
  idempotency_key?: string;
}

export interface WithdrawAppEarningsResponse extends Record<string, unknown> {
  success: boolean;
  message?: string;
  transactionId?: string;
  newBalance?: number;
  error?: string;
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
