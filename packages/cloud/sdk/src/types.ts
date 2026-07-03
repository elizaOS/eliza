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

export const DEFAULT_ELIZA_CLOUD_BASE_URL = "https://elizacloud.ai";
export const DEFAULT_ELIZA_CLOUD_API_ORIGIN = "https://api.elizacloud.ai";
export const DEFAULT_ELIZA_CLOUD_API_BASE_URL = `${DEFAULT_ELIZA_CLOUD_API_ORIGIN}/api/v1`;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD";

export type QueryValue = boolean | number | string | null | undefined;
export type QueryParams =
  | URLSearchParams
  | Record<string, QueryValue | QueryValue[]>;

export interface CloudApiErrorBody {
  success: false;
  error: string;
  code?: string;
  type?: string;
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
  input?: JsonValue;
}

export interface ResponsesCreateResponse extends Record<string, unknown> {
  id?: string;
  status?: string;
  output?: JsonValue;
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
  messages: JsonValue[];
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

/** Audio input for {@link ElizaCloudClient.transcribeAudio}. */
export interface VoiceSttRequest {
  /**
   * Audio payload as a Blob or File. In the browser pass the File/Blob from
   * MediaRecorder; on the server wrap a Buffer, e.g.
   * `new Blob([buffer], { type: "audio/webm" })`. Max 25MB.
   */
  audio: Blob;
  /** Filename for the multipart part (the extension aids type detection). */
  filename?: string;
  /** Optional language hint forwarded to the STT provider. */
  languageCode?: string;
}

/** Result of POST /api/v1/voice/stt. */
export interface VoiceSttResponse {
  /** Transcribed text. */
  transcript: string;
  /** Audio duration in milliseconds, measured server-side. */
  duration_ms: number;
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
  /** The user's org credit balance — the single ledger app purchases fund and app inference debits. */
  balance?: number;
  isLow?: boolean;
  error?: string;
}

export interface CreateAppCreditsCheckoutRequest {
  app_id: string;
  amount: number;
  success_url: string;
  cancel_url: string;
}

export interface CreateAppCreditsCheckoutResponse
  extends Record<string, unknown> {
  success: boolean;
  url?: string | null;
  sessionId?: string;
  error?: string;
}

export interface VerifyAppCreditsCheckoutResponse
  extends Record<string, unknown> {
  success: boolean;
  amount?: number;
  message?: string;
  status?: string;
  error?: string;
}

export type AppChargeProvider = "stripe" | "oxapay";
export type AppChargePaymentContext = "verified_payer" | "any_payer";
export type AppChargeStatus =
  | "requested"
  | "pending"
  | "confirmed"
  | "expired"
  | string;

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

export type OxaPayNetwork =
  | "ERC20"
  | "TRC20"
  | "BEP20"
  | "POLYGON"
  | "SOL"
  | "BASE"
  | "ARB"
  | "OP";

export interface CreateAppChargeCheckoutRequest {
  provider: AppChargeProvider;
  success_url?: string;
  cancel_url?: string;
  return_url?: string;
  payCurrency?: string;
  network?: OxaPayNetwork;
}

export interface CreateAppChargeCheckoutResponse
  extends Record<string, unknown> {
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
  kinds?: string[];
  schemes?: string[];
  networks?: string[];
  addresses?: Record<string, string>;
  error?: string;
  code?: string;
}

export interface X402FacilitatorPaymentRequest {
  paymentPayload: JsonObject;
  paymentRequirements: JsonObject;
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

export interface CreateX402PaymentRequestResponse
  extends Record<string, unknown> {
  success: boolean;
  paymentRequest: X402PaymentRequestView;
  paymentRequired: Record<string, unknown>;
  paymentRequiredHeader: string;
}

export interface ListX402PaymentRequestsResponse
  extends Record<string, unknown> {
  success: boolean;
  paymentRequests: X402PaymentRequestView[];
}

export interface GetX402PaymentRequestResponse extends Record<string, unknown> {
  success: boolean;
  paymentRequest: X402PaymentRequestView;
}

export interface SettleX402PaymentRequestResponse
  extends Record<string, unknown> {
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
  | "deleting"
  | "deleted";

export type ContainerBillingStatus =
  | "active"
  | "warning"
  | "suspended"
  | "shutdown_pending"
  | "archived";
export type ContainerArchitecture = "arm64" | "x86_64";

/**
 * Public, redacted container shape returned by `/api/v1/containers`.
 *
 * Must stay in EXACT field agreement with the API's `toContainerDto`
 * (`packages/cloud/api/v1/containers/route.ts`). The API deliberately omits
 * org-internal and secret columns — `organization_id`, `user_id`,
 * `environment_vars`, `deployment_log`, `metadata`, `api_key_id`, `node_id`,
 * `volume_path` — so they are NOT present here. Timestamps are ISO strings.
 *
 * Fields are nullable where the deploy response (a sparse provisioning summary)
 * cannot populate them; the list/get reads return the full row.
 */
export interface CloudContainer {
  id: string;
  name: string;
  project_name: string;
  description: string | null;
  load_balancer_url: string | null;
  public_hostname: string | null;
  status: ContainerStatus;
  image_tag: string | null;
  desired_count: number | null;
  cpu: number | null;
  memory: number | null;
  port: number | null;
  health_check_path: string | null;
  last_deployed_at: string | null;
  last_health_check: string | null;
  error_message: string | null;
  billing_status: ContainerBillingStatus | null;
  last_billed_at: string | null;
  next_billing_at: string | null;
  shutdown_warning_sent_at: string | null;
  scheduled_shutdown_at: string | null;
  total_billed: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Body for `POST /api/v1/containers`.
 *
 * Field names MUST match the server zod schema (`CreateContainerSchema` in
 * `packages/cloud/api/v1/containers/route.ts`) verbatim — the server is
 * camelCase. The server validates with `z.object`, which strips unknown keys,
 * so a snake_case body (`project_name`, `environment_vars`, …) is silently
 * dropped before the handler ever runs. That previously discarded
 * `environmentVars.ELIZA_APP_ID` (per-app monetization attribution) and
 * `projectName` (the sticky deploy key) on every container create, even on the
 * happy path. Keep this in exact camelCase agreement with the server.
 */
export interface CreateContainerRequest {
  /** Human-readable container name (1–100 chars). */
  name: string;
  /** Full image reference (e.g. `ghcr.io/owner/repo:tag`). The Hetzner-Docker backend pulls it directly. */
  image: string;
  /** Stable project key (sticky scheduling/volumes). Defaults to a slug of `name` server-side. */
  projectName?: string;
  port?: number;
  cpu?: number;
  memoryMb?: number;
  /**
   * Caller-supplied environment. Carries `ELIZA_APP_ID` for per-app
   * monetization attribution; platform-reserved keys are rejected server-side.
   */
  environmentVars?: Record<string, string>;
  healthCheckPath?: string;
}

/**
 * Body for `PATCH /api/v1/containers/:id`. Mirrors the server's
 * action-discriminated union (`PatchSchema` in
 * `packages/cloud/api/v1/containers/[id]/route.ts`): restart | setEnv | scale.
 * The server rejects any body without a recognized `action`, so this is a
 * discriminated union, not a partial of the create body.
 */
export type UpdateContainerRequest =
  | { action: "restart" }
  | { action: "setEnv"; environmentVars: Record<string, string> }
  | { action: "scale"; desiredCount: number };

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

// ─── Apps (Eliza Cloud Apps product) ────────────────────────────────────────
// DTOs mirror the server apps routes (`packages/cloud/api/v1/apps/**`) and the
// `apps` Drizzle table (`packages/cloud/shared/src/db/schemas/apps.ts`). The app
// payload is snake_case (it serializes the row directly via
// `appsService.withDatabaseState`); the monetization payload is camelCase
// (`appCreditsService.getMonetizationSettings`). Match the server exactly.

/** Deployment lifecycle of an app (server enum `app_deployment_status`). */
export type AppDeploymentStatus =
  | "draft"
  | "building"
  | "deploying"
  | "deployed"
  | "failed";

/** Discord social-automation config stored on an app (jsonb column). */
export interface AppDiscordAutomation {
  enabled: boolean;
  guildId?: string;
  channelId?: string;
  autoAnnounce: boolean;
  announceIntervalMin: number;
  announceIntervalMax: number;
  vibeStyle?: string;
  lastAnnouncementAt?: string;
  totalMessages?: number;
}

/** Telegram social-automation config stored on an app (jsonb column). */
export interface AppTelegramAutomation {
  enabled: boolean;
  botUsername?: string;
  channelId?: string;
  groupId?: string;
  autoReply: boolean;
  autoAnnounce: boolean;
  announceIntervalMin: number;
  announceIntervalMax: number;
  welcomeMessage?: string;
  vibeStyle?: string;
  lastAnnouncementAt?: string;
  totalMessages?: number;
}

/** X/Twitter social-automation config stored on an app (jsonb column). */
export interface AppTwitterAutomation {
  enabled: boolean;
  autoPost: boolean;
  autoReply: boolean;
  autoEngage: boolean;
  discovery: boolean;
  postIntervalMin: number;
  postIntervalMax: number;
  vibeStyle?: string;
  topics?: string[];
  lastPostAt?: string;
  totalPosts?: number;
  agentCharacterId?: string;
}

/** A generated promotional asset stored on an app (jsonb column). */
export interface AppPromotionalAsset {
  type: "social_card" | "banner";
  url: string;
  size: { width: number; height: number };
  generatedAt: string;
}

/**
 * An Eliza Cloud App as returned by the apps routes. Mirrors the `apps` Drizzle
 * row serialized over the wire: timestamps are ISO strings, `numeric` columns
 * are decimal strings, and `real` columns are numbers. Field names are
 * snake_case to match the server payload exactly.
 */
export interface AppDto {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  organization_id: string;
  created_by_user_id: string;
  app_url: string;
  allowed_origins: string[];
  api_key_id: string | null;
  affiliate_code: string | null;
  /** `numeric` decimal string. */
  referral_bonus_credits: string | null;
  total_requests: number;
  total_users: number;
  /** `numeric` decimal string. */
  total_credits_used: string | null;
  logo_url: string | null;
  website_url: string | null;
  contact_email: string | null;
  metadata: Record<string, unknown>;
  deployment_status: AppDeploymentStatus;
  production_url: string | null;
  last_deployed_at: string | null;
  github_repo: string | null;
  linked_character_ids: string[] | null;
  monetization_enabled: boolean;
  inference_markup_percentage: number | null;
  purchase_share_percentage: number | null;
  platform_offset_amount: number | null;
  custom_pricing_enabled: boolean | null;
  /** `numeric` decimal string. */
  total_creator_earnings: string | null;
  /** `numeric` decimal string. */
  total_platform_revenue: string | null;
  discord_automation: AppDiscordAutomation | null;
  telegram_automation: AppTelegramAutomation | null;
  twitter_automation: AppTwitterAutomation | null;
  promotional_assets: AppPromotionalAsset[] | null;
  email_notifications: boolean | null;
  response_notifications: boolean | null;
  is_active: boolean;
  is_approved: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

/** `GET /api/v1/apps` */
export interface ListAppsResponse {
  success: boolean;
  apps: AppDto[];
}

/** Single-app envelope: `GET /api/v1/apps/:id`, `PUT|PATCH /api/v1/apps/:id`. */
export interface AppResponse {
  success: boolean;
  app: AppDto;
}

/** `POST /api/v1/apps` request body (snake_case — matches `CreateAppSchema`). */
export interface CreateAppInput {
  name: string;
  description?: string;
  app_url: string;
  website_url?: string;
  contact_email?: string;
  allowed_origins?: string[];
  logo_url?: string;
  /** Skip provisioning a GitHub repo for the app. */
  skipGitHubRepo?: boolean;
  /** Apply monetization at creation, saving a follow-up call. */
  monetization_enabled?: boolean;
  /** Inference markup percentage, 0–1000. */
  inference_markup_percentage?: number;
}

/** `POST /api/v1/apps` response. */
export interface CreateAppResponse {
  success: boolean;
  app: AppDto;
  /** Plaintext app API key — returned once, at creation. */
  apiKey: string;
  githubRepo?: string;
  warnings?: string[];
}

/** `PATCH /api/v1/apps/:id` request body (snake_case — matches `UpdateAppSchema`). */
export interface UpdateAppInput {
  name?: string;
  description?: string;
  app_url?: string;
  website_url?: string;
  contact_email?: string;
  allowed_origins?: string[];
  logo_url?: string;
  is_active?: boolean;
  /** Up to 4 linked character UUIDs. */
  linked_character_ids?: string[];
}

/**
 * App monetization settings, returned by `GET /api/v1/apps/:id/monetization`
 * and `PUT .../monetization` (server `appCreditsService.getMonetizationSettings`).
 */
export interface AppMonetizationSettings {
  monetizationEnabled: boolean;
  inferenceMarkupPercentage: number;
  purchaseSharePercentage: number;
  platformOffsetAmount: number;
  totalCreatorEarnings: number;
}

/**
 * `PUT /api/v1/apps/:id/monetization` request body (camelCase — matches
 * `UpdateMonetizationSchema`).
 */
export interface UpdateAppMonetizationInput {
  monetizationEnabled?: boolean;
  /** Inference markup percentage, 0–1000. */
  inferenceMarkupPercentage?: number;
  /** Purchase share percentage, 0–100. */
  purchaseSharePercentage?: number;
}

/** `GET|PUT /api/v1/apps/:id/monetization` response. */
export interface AppMonetizationResponse {
  success: boolean;
  monetization: AppMonetizationSettings | null;
}

/** `POST /api/v1/apps/:id/deploy` request body — all fields optional. */
export interface DeployAppInput {
  repoUrl?: string;
  ref?: string;
  dockerfile?: string;
  env?: Record<string, string>;
}

/**
 * `POST /api/v1/apps/:id/deploy` response (202 Accepted). `status` is the
 * server-side deployment status string (the deploy lifecycle is polled via
 * {@link AppDeployStatusResponse}).
 */
export interface DeployAppResponse {
  success: boolean;
  deploymentId: string;
  status: string;
  startedAt: string;
}

/** `GET /api/v1/apps/:id/deploy/status` response. */
export interface AppDeployStatusResponse {
  success: boolean;
  deploymentId: string | null;
  status: string;
  vercelUrl: string | null;
  error: string | null;
  startedAt: string | null;
}

// ---- Managed frontend hosting (#10690) -----------------------------------

/** One file in a frontend deploy bundle. `content` is UTF-8 unless base64. */
export interface FrontendUploadFileInput {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  contentType?: string;
}

/** `POST /api/v1/apps/:id/frontend` body — publish a static site in one call. */
export interface DeployAppFrontendInput {
  files: FrontendUploadFileInput[];
  /** Document served for "/" and (with spaFallback) unmatched routes. Default "index.html". */
  entrypoint?: string;
  /** Fall back to the entrypoint for unmatched extensionless routes. Default true. */
  spaFallback?: boolean;
  /** Activate immediately after finalize. Default true. */
  activate?: boolean;
  buildMeta?: {
    source?: string | null;
    framework?: string | null;
    gitCommit?: string | null;
    note?: string | null;
  };
}

/** A managed frontend deployment record. */
export interface AppFrontendDeploymentDto {
  id: string;
  app_id: string;
  version: number;
  status:
    | "pending"
    | "uploading"
    | "ready"
    | "active"
    | "superseded"
    | "failed";
  r2_prefix: string;
  content_hash: string | null;
  file_count: number;
  total_bytes: number;
  error: string | null;
  created_at: string;
  activated_at: string | null;
}

/** `POST /api/v1/apps/:id/frontend` response (201). */
export interface DeployAppFrontendResponse {
  success: boolean;
  deployment: AppFrontendDeploymentDto;
}

/** `GET /api/v1/apps/:id/frontend` response. */
export interface ListAppFrontendDeploymentsResponse {
  success: boolean;
  active_deployment_id: string | null;
  deployments: AppFrontendDeploymentDto[];
}

/** `POST /api/v1/apps/:id/frontend/:deploymentId/activate` response. */
export interface ActivateAppFrontendResponse {
  success: boolean;
  deployment: AppFrontendDeploymentDto;
}

/** Per-resource counts the cleanup pass reports on app deletion. */
export interface AppCleanupSummary {
  domainsRemoved: number;
  githubRepoDeleted: boolean;
  secretBindingsRemoved: number;
  managedDomainsUnlinked: number;
  containersTornDown: number;
}

/** `DELETE /api/v1/apps/:id` response. */
export interface DeleteAppResponse {
  success: boolean;
  message: string;
  cleaned?: AppCleanupSummary;
  errors?: string[];
}

/**
 * `POST /api/v1/apps/:id/regenerate-api-key` response.
 *
 * SECURITY: `apiKey` is the new plaintext app API key, returned ONCE. The
 * previous key is invalidated immediately. Surface it to the user a single time
 * and never log or persist it.
 */
export interface RegenerateAppApiKeyResponse {
  success: boolean;
  apiKey?: string;
  message?: string;
  error?: string;
}

/** `POST /api/v1/apps/:id/domains/buy` request body. */
export interface BuyAppDomainInput {
  domain: string;
}

/**
 * `POST /api/v1/apps/:id/domains/buy` response. Covers all three success
 * branches: a fresh purchase (carries `debited` + `expiresAt`), a server-side
 * idempotent replay of an earlier success (`alreadyRegistered`), and the
 * recovery of a purchase that charged + registered but failed to persist
 * (`recoveredFromRegistrar` — assigned without a new charge).
 */
export interface BuyAppDomainResponse {
  success: boolean;
  domain?: string;
  /** The managed-domain attachment row id. */
  appDomainId?: string;
  /** Cloudflare zone id; null until the zone finishes provisioning. */
  zoneId?: string | null;
  status?: string;
  verified?: boolean;
  expiresAt?: string | null;
  /**
   * True when Cloudflare accepted the registration but the zone (and the
   * automatic DNS record pointing the domain at the app) is not provisioned
   * yet — poll `getAppDomainStatus` until it goes live.
   */
  pendingZoneProvisioning?: boolean;
  /** Present only when this call actually debited the org credit balance. */
  debited?: { totalUsdCents: number; currency: string };
  /** True when the org already owned the domain — nothing was charged. */
  alreadyRegistered?: boolean;
  /**
   * True when an earlier interrupted purchase (charged + registered, persist
   * failed) was recovered and attached without a new charge.
   */
  recoveredFromRegistrar?: boolean;
  error?: string;
}

/** `POST /api/v1/apps/:id/domains/check` request body. */
export interface CheckAppDomainInput {
  domain: string;
}

/** Marked-up price quote returned by the domain availability check. */
export interface AppDomainPriceQuote {
  wholesaleUsdCents: number;
  marginUsdCents: number;
  totalUsdCents: number;
  marginBps: number;
}

/**
 * `POST /api/v1/apps/:id/domains/check` response. A dry run — never charges,
 * never registers. `price`/`renewal` are present only when `available`;
 * `renewal.totalUsdCents` is the annual price the renewal cron will re-charge.
 */
export interface CheckAppDomainResponse {
  success: boolean;
  domain: string;
  available: boolean;
  currency?: string;
  years?: number;
  price?: AppDomainPriceQuote;
  renewal?: { totalUsdCents: number };
  error?: string;
}

/** One domain attachment row from `GET /api/v1/apps/:id/domains`. */
export interface AppDomainDto {
  id: string;
  domain: string;
  registrar: "external" | "cloudflare";
  status: "pending" | "active" | "expired" | "suspended" | "transferring";
  verified: boolean;
  /** Nullable: the ssl_status column has a default but no NOT NULL constraint. */
  sslStatus: "pending" | "provisioning" | "active" | "error" | null;
  expiresAt: string | null;
  cloudflareZoneId: string | null;
  /**
   * The TXT verification token — non-null only for unverified external
   * domains (so the client can re-render the `_eliza-cloud-verify` record).
   */
  verificationToken: string | null;
}

/** `GET /api/v1/apps/:id/domains` response. */
export interface ListAppDomainsResponse {
  success: boolean;
  domains: AppDomainDto[];
  error?: string;
}

/** `POST /api/v1/apps/:id/domains/status` request body. */
export interface AppDomainStatusInput {
  domain: string;
}

/**
 * `POST /api/v1/apps/:id/domains/status` response. `live` (real-time registrar
 * registration status) is populated only for cloudflare-registered domains and
 * is always null for external ones; the top-level `status` prefers the live
 * value when present.
 */
export interface AppDomainStatusResponse {
  success: boolean;
  domain: string;
  registrar?: "external" | "cloudflare";
  status?: string;
  verified?: boolean;
  sslStatus?: string;
  expiresAt?: string | null;
  live?: {
    status: string;
    completedAt: string | null;
    failureReason: string | null;
  } | null;
  error?: string;
}

export interface CreateAgentRequest {
  agentName: string;
  characterId?: string;
  agentConfig?: Record<string, unknown>;
  environmentVars?: Record<string, string>;
  dockerImage?: string;
  alwaysOn?: boolean;
  statefulRuntime?: boolean;
  modelTooLargeForShared?: boolean;
  autoProvision?: boolean;
}

export interface CreateAgentResponse {
  success: boolean;
  data?: {
    id: string;
    agentId?: string;
    agentName: string | null;
    status: import("./types.cloud-api.js").AgentSandboxStatus;
    executionTier?: string;
    jobId?: string;
    createdAt?: string;
  };
  id?: string;
  agentId?: string;
  jobId?: string;
  executionTier?: string;
}

export interface AgentLifecycleResponse extends Record<string, unknown> {
  success?: boolean;
  data?: JsonObject;
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
    data?: JsonValue;
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
  result?: JsonValue;
  error?: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  description?: string | null;
  key_prefix: string;
  created_at: string;
  rate_limit?: number | null;
  expires_at?: string | null;
}

export interface ApiKeyCreateRequest {
  name: string;
  description?: string;
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

// ---- Ad inventory / SSP (#10687) ----

export type AdSlotFormat = "banner" | "native" | "interstitial" | "feed";

export interface AdSlotDto {
  id: string;
  app_id: string;
  name: string;
  format: AdSlotFormat;
  status: "active" | "paused";
  floor_cpm: string;
  total_impressions: number;
  total_clicks: number;
  total_revenue: string;
}

export interface CreateAdSlotInput {
  appId: string;
  name: string;
  format: AdSlotFormat;
  floorCpm?: number;
}

export interface CreateAdSlotResponse {
  success: boolean;
  slot: AdSlotDto;
  /**
   * Signed capability the public serve endpoint requires (`&token=` on the ad
   * tag). Null when the deployment has no `ELIZA_AD_TAG_SECRET` configured.
   */
  adTagToken: string | null;
}

export interface ListAdSlotsResponse {
  success: boolean;
  slots: AdSlotDto[];
}

// ---- Advertising campaign management (#11599) ----

export interface CampaignDaypartingWindow {
  /** 0=Sunday .. 6=Saturday (JS `Date#getDay` / Meta adset_schedule convention). */
  daysOfWeek: number[];
  /** `HH:mm`, 24-hour, in the schedule's timezone. */
  startTime: string;
  /** `HH:mm` exclusive end; `"24:00"` = end of day. Must be after startTime. */
  endTime: string;
}

export interface CampaignDaypartingSchedule {
  /** IANA timezone the windows are evaluated in (never server-local time). */
  timezone: string;
  windows: CampaignDaypartingWindow[];
}

export interface AdCampaignDto {
  id: string;
  name: string;
  platform: string;
  objective: string;
  status: string;
  budgetType: string;
  budgetAmount: string;
  budgetCurrency?: string;
  creditsAllocated?: string;
  externalCampaignId?: string | null;
  dayparting?: CampaignDaypartingSchedule | null;
  sourceCampaignId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CampaignDaypartingResponse {
  success: boolean;
  campaignId: string;
  status?: string;
  dayparting: CampaignDaypartingSchedule | null;
  updatedAt?: string;
}

export interface UpdateCampaignDaypartingInput {
  dayparting: CampaignDaypartingSchedule | null;
}

export interface DuplicateAdCampaignInput {
  name?: string;
}

export interface DuplicateAdCampaignResponse {
  success: boolean;
  campaign: AdCampaignDto;
  creativesCopied: number;
}

export interface AdCampaignAttributionInstall {
  pixelHtml: string;
  webhook: {
    url: string;
    method: "POST";
    body: Record<string, unknown>;
  };
}

export interface AdCampaignAttributionResponse {
  success: boolean;
  campaignId: string;
  appId: string | null;
  token: string;
  pixelEndpoint: string;
  webhookEndpoint: string;
  install: AdCampaignAttributionInstall;
}

export type CampaignReportFormat = "json" | "csv";

export interface CampaignPerformanceReportSummary {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpc: number;
  cpm: number;
  conversionRate: number;
  costPerConversion: number;
  budgetUtilization: number;
  conversionValue: number;
}

export interface CampaignPerformanceReport {
  generatedAt: string;
  campaign: {
    id: string;
    name: string;
    platform: string;
    objective: string;
    status: string;
    externalCampaignId: string | null;
    appId: string | null;
    budgetType: string;
    budgetAmount: number;
    budgetCurrency: string;
    creditsAllocated: number;
    creditsSpent: number;
    startDate: string | null;
    endDate: string | null;
    createdAt: string;
    updatedAt: string;
  };
  dateRange: { start: string; end: string } | null;
  summary: CampaignPerformanceReportSummary;
  provider: {
    platform: string;
    accountId: string;
    externalAccountId: string;
    externalCampaignId: string | null;
  };
}

export interface GetCampaignPerformanceReportOptions {
  format?: CampaignReportFormat;
  startDate?: string;
  endDate?: string;
}

export interface CampaignPerformanceReportResponse {
  success: boolean;
  report: CampaignPerformanceReport;
}

export interface CreateCampaignReportShareInput {
  expiresAt?: string;
  expiresInHours?: number;
}

export interface CampaignReportShareDto {
  id: string;
  campaignId: string;
  token: string;
  publicPath: string;
  publicUrl: string;
  expiresAt: string;
}

export interface CreateCampaignReportShareResponse {
  success: boolean;
  share: CampaignReportShareDto;
}

export interface RevokeCampaignReportShareResponse {
  success: boolean;
  share: {
    id: string;
    status: string;
    revokedAt: string | null;
  };
}

// ---- Influencer marketplace (#10687) ----

export interface InfluencerProfileDto {
  id: string;
  display_name: string;
  niche: string | null;
  bio: string | null;
  platforms: Array<{ platform: string; handle: string; followers: number }>;
  status: "active" | "inactive";
}

export interface CreateInfluencerProfileInput {
  displayName: string;
  niche?: string;
  bio?: string;
  platforms?: Array<{ platform: string; handle: string; followers: number }>;
  rateCard?: Record<string, unknown>;
}

export interface CreateInfluencerProfileResponse {
  success: boolean;
  profile: InfluencerProfileDto;
}

export interface ListInfluencersResponse {
  success: boolean;
  profiles: InfluencerProfileDto[];
}

export interface InfluencerBookingDto {
  id: string;
  advertiser_org_id: string;
  influencer_profile_id: string;
  amount: string;
  status:
    | "funding"
    | "offered"
    | "accepted"
    | "delivered"
    // Claim states: the atomic delivered→approving/refunding CAS fences the
    // money fork (#11116); list/get can surface a booking mid-claim or
    // crash-stuck in one of these.
    | "approving"
    | "refunding"
    | "approved"
    | "rejected"
    | "cancelled";
  brief: string;
}

export interface CreateBookingInput {
  profileId: string;
  brief: string;
  amount: number;
  /** Optional create key: a retry with the same key returns the original booking instead of funding twice. */
  idempotencyKey?: string;
}

export interface CreateBookingResponse {
  success: boolean;
  booking?: InfluencerBookingDto;
  error?: string;
}

// ---- App config backup / restore (#10204) ----

export interface AppBackupSnapshot {
  version: number;
  exportedAt: string;
  app: {
    name: string;
    description: string | null;
    app_url: string;
    allowed_origins: string[];
    logo_url: string | null;
    website_url: string | null;
    contact_email: string | null;
    linked_character_ids: string[];
  };
  monetization: {
    enabled: boolean;
    inference_markup_percentage: number;
    purchase_share_percentage: number;
  };
  active_frontend_content_hash?: string | null;
}

export interface ExportAppBackupResponse {
  success: boolean;
  backup: AppBackupSnapshot;
}

export interface RestoreAppBackupResponse {
  success: boolean;
  app: { id: string; name: string; slug: string };
  apiKey: string;
}
