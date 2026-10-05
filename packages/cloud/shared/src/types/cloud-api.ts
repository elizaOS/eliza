/** Backend records and strict producer contracts; public DTOs belong to the SDK. */
import type {
  AdminUserDto,
  AgentActiveJobDto,
  AgentAdminDetailsDto,
  AgentDatabaseStatus,
  AgentExecutionTier,
  AgentSandboxStatus,
  AgentWalletStatus,
  ApiSuccessEnvelope,
  CurrentUserDto,
  CurrentUserOrganizationDto,
  DateLike,
  IsoDateString,
} from "@elizaos/cloud-sdk/contracts";

export type {
  AdminModerationAction,
  AdminModerationActionName,
  AdminModerationActionRequest,
  AdminModerationAdminsResponse,
  AdminModerationCombinedResponse,
  AdminModerationOverviewResponse,
  AdminModerationStatusResponse,
  AdminModerationStatusValue,
  AdminModerationUserDetailResponse,
  AdminModerationUserStatusDto,
  AdminModerationUserSummaryDto,
  AdminModerationUsersResponse,
  AdminModerationViolationDto,
  AdminModerationViolationsResponse,
  AdminRole,
  AdminUserDto,
  AgentActiveJobDto,
  AgentAdminDetailsDto,
  AgentDatabaseStatus,
  AgentExecutionTier,
  AgentSandboxStatus,
  AgentWalletStatus,
  AnalyticsAlertEventDto,
  AnalyticsCostTrendingDto,
  AnalyticsDataDto,
  AnalyticsModelBreakdownDto,
  AnalyticsProjectionAlertDto,
  AnalyticsProjectionPointDto,
  AnalyticsProviderBreakdownDto,
  AnalyticsTimeGranularity,
  AnalyticsTimeRange,
  AnalyticsTimeSeriesPointDto,
  AnalyticsTrendDto,
  AnalyticsUsageStatsDto,
  AnalyticsUserBreakdownDto,
  ApiSuccessEnvelope,
  CreditBalanceResponse,
  CurrentUserDto,
  CurrentUserOrganizationDto,
  CurrentUserResponse,
  DateLike,
  EnhancedAnalyticsDataDto,
  IsoDateString,
  OrganizationSubscriptionCancellationDto,
  OrganizationSubscriptionCancellationRequest,
  OrganizationSubscriptionCancellationResponse,
  PendingOrganizationPlanChangeCommandsDto,
  PendingSubscriptionCommandsDto,
  PendingSubscriptionCommandsResponse,
  ProjectionsDataDto,
  SubscriptionAllowanceDto,
  SubscriptionBillingInterval,
  SubscriptionCatalogVersion,
  SubscriptionCurrency,
  SubscriptionFundingClass,
  SubscriptionPlanDto,
  SubscriptionPlanKey,
  SubscriptionPlansDto,
  SubscriptionRateEnvelopeDto,
  SubscriptionResourceCeilingsDto,
  UpdatedUserDto,
  UpdatedUserResponse,
} from "@elizaos/cloud-sdk/contracts";
export { ADMIN_ROLE_RANK, adminRoleRank, isAdminRole } from "@elizaos/cloud-sdk/contracts";

export type OrganizationDto = CurrentUserOrganizationDto & {
  settings?: Record<string, unknown> | null;
  stripe_customer_id?: string | null;
  stripe_payment_method_id?: string | null;
  stripe_default_payment_method?: string | null;
  auto_top_up_enabled?: boolean | null;
  auto_top_up_threshold?: string | null;
  auto_top_up_amount?: string | null;
  pay_as_you_go_from_earnings?: boolean;
  steward_tenant_id?: string | null;
  steward_tenant_api_key?: string | null;
};

export type UserWithOrganizationDto = CurrentUserDto & {
  organization_id: string;
  organization: CurrentUserOrganizationDto;
};

export interface InvoiceDto {
  id: string;
  organization_id: string;
  stripe_invoice_id: string;
  stripe_customer_id: string;
  stripe_payment_intent_id: string | null;
  amount_due: string | number;
  amount_paid: string | number;
  currency: string;
  status: string;
  invoice_type: string;
  invoice_number: string | null;
  invoice_pdf: string | null;
  hosted_invoice_url: string | null;
  credits_added: string | number | null;
  metadata: Record<string, unknown> | null;
  created_at: DateLike;
  updated_at: DateLike;
  due_date: DateLike | null;
  paid_at: DateLike | null;
}

/** Payment rails represented by the unified payment-request transport. */
export type PaymentRequestProviderDto = "stripe" | "oxapay" | "x402" | "wallet_native";

/** Persisted payment-request lifecycle states exposed to creators. */
export type PaymentRequestStatusDto =
  | "pending"
  | "delivered"
  | "settled"
  | "failed"
  | "expired"
  | "canceled";

/**
 * Creator-facing payment-request projection. Provider payloads, callback
 * credentials, payer identities, settlement proof, and arbitrary metadata
 * never cross this transport boundary.
 */
export interface PaymentRequestDto {
  id: string;
  agentId: string | null;
  appId: string | null;
  provider: PaymentRequestProviderDto;
  amountCents: number;
  currency: string;
  reason: string | null;
  status: PaymentRequestStatusDto;
  hostedUrl: string | null;
  settledAt: IsoDateString | null;
  expiresAt: IsoDateString;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
}

export type AppDeploymentStatus = "draft" | "building" | "deploying" | "deployed" | "failed";
export type AppReviewStatus = "draft" | "submitted" | "under_review" | "approved" | "rejected";
export type UserDatabaseStatus = "none" | "provisioning" | "ready" | "error";

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
  referral_bonus_credits: string | number | null;
  total_requests: number;
  total_users: number;
  total_credits_used: string | number | null;
  logo_url: string | null;
  website_url: string | null;
  contact_email: string | null;
  metadata: Record<string, unknown>;
  deployment_status: AppDeploymentStatus;
  production_url: string | null;
  last_deployed_at: DateLike | null;
  github_repo: string | null;
  linked_character_ids: string[] | null;
  monetization_enabled: boolean;
  inference_markup_percentage: number | null;
  purchase_share_percentage: number | null;
  platform_offset_amount: number | null;
  custom_pricing_enabled: boolean | null;
  total_creator_earnings: string | number | null;
  total_platform_revenue: string | number | null;
  discord_automation: unknown;
  telegram_automation: unknown;
  twitter_automation: unknown;
  promotional_assets: unknown;
  user_database_status: UserDatabaseStatus;
  user_database_uri: string | null;
  user_database_region: string | null;
  user_database_error: string | null;
  email_notifications: boolean | null;
  response_notifications: boolean | null;
  is_active: boolean;
  is_approved: boolean;
  review_status: AppReviewStatus;
  review_content_hash: string | null;
  reviewed_at: DateLike | null;
  created_at: DateLike;
  updated_at: DateLike;
  last_used_at: DateLike | null;
}

export interface UserCharacterDto {
  id: string;
  organization_id: string;
  user_id: string;
  name: string;
  username: string | null;
  system: string | null;
  bio: string | string[];
  message_examples: Record<string, unknown>[][];
  post_examples: string[];
  topics: string[];
  adjectives: string[];
  knowledge: (string | { path: string; shared?: boolean })[] | null;
  plugins: string[] | null;
  settings: Record<string, unknown>;
  secrets: Record<string, string | boolean | number> | null;
  style: { all?: string[]; chat?: string[]; post?: string[] } | null;
  character_data: Record<string, unknown>;
  is_template: boolean;
  is_public: boolean;
  avatar_url: string | null;
  category: string | null;
  tags: string[] | null;
  featured: boolean;
  view_count: number;
  interaction_count: number;
  popularity_score: number;
  source: string;
  token_address: string | null;
  token_chain: string | null;
  token_name: string | null;
  token_ticker: string | null;
  erc8004_registered: boolean;
  erc8004_network: string | null;
  erc8004_agent_id: number | null;
  erc8004_agent_uri: string | null;
  erc8004_tx_hash: string | null;
  erc8004_registered_at: DateLike | null;
  monetization_enabled: boolean;
  inference_markup_percentage: string | number;
  payout_wallet_address: string | null;
  total_inference_requests: number;
  total_creator_earnings: string | number;
  total_platform_revenue: string | number;
  a2a_enabled: boolean;
  mcp_enabled: boolean;
  created_at: DateLike;
  updated_at: DateLike;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface ApiRouteMetaDto {
  id: string;
  name: string;
  description: string;
  category: string;
  requiresAuth: boolean;
  pricing?: string | { type?: string; [key: string]: unknown };
  rateLimit?: string | { requests: number; window: string; [key: string]: unknown };
  tags?: string[];
}

export interface DiscoveredApiRouteDto {
  path: string;
  methods: HttpMethod[];
  filePath: string;
  meta?: ApiRouteMetaDto;
  metaByMethod?: Partial<Record<HttpMethod, ApiRouteMetaDto>>;
}

export interface AgentListItemDto {
  id: string;
  agentName: string | null;
  status: AgentSandboxStatus;
  databaseStatus: AgentDatabaseStatus;
  lastBackupAt: IsoDateString | null;
  lastHeartbeatAt: IsoDateString | null;
  errorMessage: string | null;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  token_address: string | null;
  token_chain: string | null;
  token_name: string | null;
  token_ticker: string | null;
  dockerImage: string | null;
  executionTier: AgentExecutionTier;
  webUiUrl: string | null;
  activeJob: AgentActiveJobDto | null;
}

export interface AgentDetailDto extends AgentListItemDto {
  errorCount: number;
  /** True when the control plane has persisted private mesh routing authority. */
  meshAddressPresent: boolean;
  walletAddress: string | null;
  walletProvider: string | null;
  walletStatus: AgentWalletStatus;
  adminDetails: AgentAdminDetailsDto | null;
}

export type AgentsResponse = ApiSuccessEnvelope<AgentListItemDto[]>;
export type AgentResponse = ApiSuccessEnvelope<AgentDetailDto>;

export type AdminModerationView = "overview" | "violations" | "users" | "admins" | "user-detail";

export interface AdminModerationActionResponse {
  success: true;
  message: string;
  admin?: Pick<AdminUserDto, "id" | "walletAddress" | "role">;
}

// ---------------------------------------------------------------------------
// Admin engagement metrics DTOs
// Shapes returned by GET /api/v1/admin/metrics
// ---------------------------------------------------------------------------

export interface AdminDailyMetricDto {
  date: string;
  platform: string | null;
  dau: number;
  new_signups: number;
  total_messages: number;
  messages_per_user: string;
}

export interface AdminRetentionCohortDto {
  cohort_date: string;
  platform: string | null;
  cohort_size: number;
  d1_retained: number | null;
  d7_retained: number | null;
  d30_retained: number | null;
}

export interface AdminPlatformDistributionDto {
  key: string;
  count: number;
  percent: number;
}

export interface AdminRetentionRatePointDto {
  cohortDate: string;
  cohortSize: number;
  d1: number | null;
  d7: number | null;
  d30: number | null;
}

export interface AdminOAuthRateDto {
  total_users: number;
  connected_users: number;
  rate: number;
  /** rate rendered as 0..100 percent, rounded to one decimal. */
  ratePercent: number;
  byService: Record<string, number>;
}

export interface AdminMetricsOverviewDto {
  dau: number;
  wau: number;
  mau: number;
  newSignupsToday: number;
  newSignups7d: number;
  avgMessagesPerUser: number;
  platformBreakdown: Record<string, number>;
  platformDistribution: AdminPlatformDistributionDto[];
  oauthRate: AdminOAuthRateDto;
  dailyTrend: AdminDailyMetricDto[];
  retentionCohorts: AdminRetentionCohortDto[];
  retentionRates: AdminRetentionRatePointDto[];
}

// ---------------------------------------------------------------------------
// Organization member and invite DTOs
// Shapes returned by GET /api/organizations/members and /api/organizations/invites
// ---------------------------------------------------------------------------

export interface OrgMemberDto {
  id: string;
  name: string | null;
  email: string | null;
  wallet_address: string | null;
  wallet_chain_type: string | null;
  role: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrgInviteDto {
  id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string;
  created_at: string;
  inviter: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
  accepted_at: string | null;
}

// ---------------------------------------------------------------------------
// Session usage DTOs
// Shapes returned by GET /api/sessions/current
// ---------------------------------------------------------------------------

export interface SessionStatsDto {
  credits_used: number;
  requests_made: number;
  tokens_consumed: number;
}
