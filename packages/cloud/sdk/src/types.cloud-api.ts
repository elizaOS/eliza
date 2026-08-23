/**
 * DTOs mirrored from the Cloud API schema (`CurrentUserDto`, `AgentDetailDto`,
 * the `ApiSuccessEnvelope`/`ApiErrorEnvelope` wrappers, etc.). These must stay in
 * exact sync with the actual API responses — do not add computed or client-only
 * fields here.
 */

export type IsoDateString = string;
type DateLike = Date | IsoDateString;

export interface ApiSuccessEnvelope<TData> {
  success: true;
  data: TData;
}

export interface CurrentUserOrganizationDto {
  id: string;
  name: string;
  slug: string;
  credit_balance: string;
  billing_email: string | null;
  is_active: boolean;
  created_at: DateLike;
  updated_at: DateLike;
}

export interface CurrentUserDto {
  id: string;
  email: string | null;
  email_verified: boolean | null;
  wallet_address: string | null;
  wallet_chain_type: string | null;
  wallet_verified: boolean;
  name: string | null;
  avatar: string | null;
  organization_id: string | null;
  role: string;
  steward_user_id: string;
  telegram_id: string | null;
  telegram_username: string | null;
  telegram_first_name: string | null;
  telegram_photo_url: string | null;
  discord_id: string | null;
  discord_username: string | null;
  discord_global_name: string | null;
  discord_avatar_url: string | null;
  whatsapp_id: string | null;
  whatsapp_name: string | null;
  phone_number: string | null;
  phone_verified: boolean | null;
  is_anonymous: boolean;
  anonymous_session_id: string | null;
  expires_at: DateLike | null;
  nickname: string | null;
  work_function: string | null;
  preferences: string | null;
  email_notifications: boolean | null;
  response_notifications: boolean | null;
  is_active: boolean;
  created_at: DateLike;
  updated_at: DateLike;
  organization: CurrentUserOrganizationDto | null;
}

export type CurrentUserResponse = ApiSuccessEnvelope<CurrentUserDto>;

export type UpdatedUserDto = Omit<CurrentUserDto, "organization">;

export interface UpdatedUserResponse
  extends ApiSuccessEnvelope<UpdatedUserDto> {
  message: string;
}

export interface CreditBalanceResponse {
  balance: number;
}

export type SubscriptionCatalogVersion = "v1";
export type SubscriptionPlanKey = "plus_monthly" | "pro_monthly";
export type SubscriptionBillingInterval = "month";
export type SubscriptionCurrency = "usd";
export type SubscriptionFundingClass = "allowance_eligible" | "cash_only";

export interface SubscriptionRateEnvelopeDto {
  completionsRpm: number;
  embeddingsRpm: number;
  standardRpm: number;
  strictRpm: number;
}

export interface SubscriptionResourceCeilingsDto {
  cloudCharacters: number;
  agentSandboxes: number;
  containers: number;
  storageGiB: number;
  apps: number;
}

export interface SubscriptionAllowanceDto {
  amountUsd: string;
  fundingClass: "allowance_eligible";
  rollover: false;
  expiresAt: "billing_period_end";
}

export interface SubscriptionPlanDto {
  key: SubscriptionPlanKey;
  name: "Plus" | "Pro";
  catalogVersion: SubscriptionCatalogVersion;
  active: true;
  interval: SubscriptionBillingInterval;
  intervalCount: 1;
  currency: SubscriptionCurrency;
  amountCents: number;
  allowance: SubscriptionAllowanceDto;
  fundingClasses: readonly SubscriptionFundingClass[];
  rateLimits: SubscriptionRateEnvelopeDto;
  resourceCeilings: null;
}

export interface SubscriptionPlansDto {
  catalogVersion: SubscriptionCatalogVersion;
  plans: readonly SubscriptionPlanDto[];
}

export type SubscriptionPlansResponse =
  ApiSuccessEnvelope<SubscriptionPlansDto>;

export type SubscriptionPublicState =
  | "active"
  | "grace"
  | "past_due"
  | "unpaid"
  | "canceled";

export interface SubscriptionDto {
  catalogVersion: SubscriptionCatalogVersion;
  planKey: SubscriptionPlanKey;
  state: SubscriptionPublicState;
  currentPeriodStartsAt: IsoDateString;
  currentPeriodEndsAt: IsoDateString;
  cancelAtPeriodEnd: boolean;
  pendingPlanKey: SubscriptionPlanKey | null;
  allowanceGrantedUsd: string;
  allowanceRemainingUsd: string;
  allowanceExpiresAt: IsoDateString;
  rateLimits: SubscriptionRateEnvelopeDto;
  /** Unavailable (`null`) until the resource-enforcement policy is ratified. */
  resourceCeilings: SubscriptionResourceCeilingsDto | null;
}

export type AgentSandboxStatus =
  | "pending"
  | "provisioning"
  | "running"
  | "stopped"
  | "sleeping"
  | "disconnected"
  | "deletion_pending"
  | "deletion_failed"
  | "error";

export type AgentDatabaseStatus = "none" | "provisioning" | "ready" | "error";
export type AgentExecutionTier =
  | "shared"
  | "dedicated-lazy"
  | "dedicated-always"
  | "custom";

/** A server-owned lifecycle job that clients can resume polling after reload. */
export interface AgentActiveJobDto {
  id: string;
  type: string;
  status: "pending" | "in_progress";
  attempts: number;
  maxAttempts: number;
  estimatedCompletionAt: IsoDateString | null;
  scheduledFor: IsoDateString;
  startedAt: IsoDateString | null;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
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
  dockerImage?: string | null;
  executionTier?: string;
  webUiUrl?: string | null;
  activeJob?: AgentActiveJobDto | null;
}

/**
 * Strict projection produced after validating the current agents-list payload.
 * Keep {@link AgentListItemDto} permissive for existing SDK consumers.
 */
export interface NormalizedAgentListItemDto
  extends Omit<
    AgentListItemDto,
    "dockerImage" | "executionTier" | "webUiUrl" | "activeJob"
  > {
  dockerImage: string | null;
  executionTier: AgentExecutionTier;
  webUiUrl: string | null;
  activeJob: AgentActiveJobDto | null;
}

interface AgentAdminDetailsDto {
  nodeId: string | null;
  containerName: string | null;
  headscaleIp: string | null;
  bridgePort: number | null;
  webUiPort: number | null;
  dockerImage: string | null;
  isDockerBacked: boolean;
  webUiUrl: string | null;
  sshCommand: string | null;
}

export type AgentWalletStatus = "active" | "pending" | "none" | "error";

export interface AgentDetailDto extends AgentListItemDto {
  bridgeUrl: string | null;
  errorCount: number;
  walletAddress: string | null;
  walletProvider: string | null;
  walletStatus: AgentWalletStatus;
  adminDetails: AgentAdminDetailsDto | null;
}

/** Strict current-response projection for validated agent detail payloads. */
export interface NormalizedAgentDetailDto
  extends Omit<
    AgentDetailDto,
    "dockerImage" | "executionTier" | "webUiUrl" | "activeJob"
  > {
  dockerImage: string | null;
  executionTier: AgentExecutionTier;
  webUiUrl: string | null;
  activeJob: AgentActiveJobDto | null;
}

export type AgentsResponse = ApiSuccessEnvelope<AgentListItemDto[]>;
export type AgentResponse = ApiSuccessEnvelope<AgentDetailDto>;
export type NormalizedAgentsResponse = ApiSuccessEnvelope<
  NormalizedAgentListItemDto[]
>;
export type NormalizedAgentResponse =
  ApiSuccessEnvelope<NormalizedAgentDetailDto>;

export type AnalyticsTimeGranularity = "hour" | "day" | "week" | "month";
export type AnalyticsTimeRange = "daily" | "weekly" | "monthly";

export interface AnalyticsUsageStatsDto {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  successRate: number;
}

export interface AnalyticsTimeSeriesPointDto {
  timestamp: DateLike;
  totalRequests: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  successRate: number;
  successRatePercent: number;
}

export interface AnalyticsUserBreakdownDto {
  userId: string;
  userName: string | null;
  userEmail: string;
  totalRequests: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  lastActive: DateLike | null;
}

export interface AnalyticsCostTrendingDto {
  currentDailyBurn: number;
  previousDailyBurn: number;
  burnChangePercent: number;
  projectedMonthlyBurn: number;
  daysUntilBalanceZero: number | null;
  monthlyBurnPercent: number;
  monthlyBurnPercentClamped: number;
  burnAlertThresholdExceeded: boolean;
}

export interface AnalyticsProviderBreakdownDto {
  provider: string;
  totalRequests: number;
  totalCost: number;
  totalTokens: number;
  successRate: number;
  percentage: number;
}

export interface AnalyticsModelBreakdownDto {
  model: string;
  provider: string;
  totalRequests: number;
  totalCost: number;
  totalTokens: number;
  avgCostPerToken: number;
  successRate: number;
}

export interface AnalyticsTrendDto {
  requestsChange: number;
  costChange: number;
  tokensChange: number;
  successRateChange: number;
  period: string;
}

export interface AnalyticsDataDto {
  filters: {
    startDate: DateLike;
    endDate: DateLike;
    granularity: AnalyticsTimeGranularity;
    timeRange?: AnalyticsTimeRange;
  };
  overallStats: AnalyticsUsageStatsDto;
  timeSeriesData: AnalyticsTimeSeriesPointDto[];
  userBreakdown: AnalyticsUserBreakdownDto[];
  costTrending: AnalyticsCostTrendingDto;
  organization: { creditBalance: string | number };
}

export interface EnhancedAnalyticsDataDto extends AnalyticsDataDto {
  filters: AnalyticsDataDto["filters"] & { timeRange: AnalyticsTimeRange };
  providerBreakdown: AnalyticsProviderBreakdownDto[];
  modelBreakdown: AnalyticsModelBreakdownDto[];
  trends: AnalyticsTrendDto;
}

export interface AnalyticsProjectionPointDto
  extends AnalyticsTimeSeriesPointDto {
  isProjected: boolean;
  confidence?: number;
}

export interface AnalyticsProjectionAlertDto {
  type: "warning" | "danger" | "info";
  title: string;
  message: string;
  projectedValue?: number;
  projectedDate?: DateLike;
  eventId?: string;
  severity?: "warning" | "critical" | "info";
  status?: string;
}

export interface AnalyticsAlertEventDto {
  id: string;
  organization_id: string;
  policy_id: string;
  severity: "warning" | "critical" | "info" | string;
  status: string;
  source: string;
  title: string;
  message: string;
  evidence: Record<string, unknown>;
  dedupe_key: string;
  evaluated_at: DateLike;
  created_at: DateLike;
}

export interface ProjectionsDataDto {
  historicalData: AnalyticsTimeSeriesPointDto[];
  projections: AnalyticsProjectionPointDto[];
  alerts: AnalyticsProjectionAlertDto[];
  alertEvents?: AnalyticsAlertEventDto[];
  creditBalance: number;
}

export type AdminRole = "super_admin" | "moderator" | "viewer";

export const ADMIN_ROLE_RANK: Record<AdminRole, number> = {
  viewer: 0,
  moderator: 1,
  super_admin: 2,
};

export function isAdminRole(value: unknown): value is AdminRole {
  return value === "super_admin" || value === "moderator" || value === "viewer";
}

export function adminRoleRank(role: AdminRole | null | undefined): number {
  return role && isAdminRole(role) ? ADMIN_ROLE_RANK[role] : -1;
}

export type AdminModerationStatusValue =
  | "clean"
  | "warned"
  | "spammer"
  | "scammer"
  | "banned";
export type AdminModerationAction =
  | "refused"
  | "warned"
  | "flagged_for_ban"
  | "banned";

export interface AdminModerationViolationDto {
  id: string;
  userId: string;
  roomId: string | null;
  messageText: string;
  categories: string[];
  scores: Record<string, number>;
  action: AdminModerationAction;
  reviewedBy: string | null;
  reviewedAt: IsoDateString | null;
  reviewNotes: string | null;
  createdAt: IsoDateString;
}

export interface AdminModerationUserStatusDto {
  id: string;
  userId: string;
  status: AdminModerationStatusValue;
  totalViolations: number;
  warningCount: number;
  riskScore: number;
  bannedBy: string | null;
  bannedAt: IsoDateString | null;
  banReason: string | null;
  lastViolationAt: IsoDateString | null;
  lastWarningAt: IsoDateString | null;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
}

export interface AdminUserDto {
  id: string;
  userId: string | null;
  walletAddress: string;
  role: AdminRole;
  isActive: boolean;
  grantedBy: string | null;
  grantedByWallet: string | null;
  notes: string | null;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  revokedAt: IsoDateString | null;
}

export interface AdminModerationOverviewResponse {
  recentViolations: AdminModerationViolationDto[];
  totalViolations: number;
  flaggedUsers: number;
  bannedUsers: number;
  adminCount: number;
  currentAdmin: { wallet: string | null; role: AdminRole | null };
}

export interface AdminModerationViolationsResponse {
  violations: AdminModerationViolationDto[];
  total: number;
}

export interface AdminModerationUsersResponse {
  flaggedUsers: AdminModerationUserStatusDto[];
  bannedUsers: AdminModerationUserStatusDto[];
  totalFlagged: number;
  totalBanned: number;
}

export interface AdminModerationAdminsResponse {
  admins: AdminUserDto[];
  total: number;
  canManageAdmins: boolean;
}

export interface AdminModerationUserSummaryDto {
  id: string;
  email: string | null;
  wallet_address: string | null;
  name: string | null;
  created_at: IsoDateString;
}

export interface AdminModerationUserDetailResponse {
  user: AdminModerationUserSummaryDto | null;
  moderationStatus: AdminModerationUserStatusDto | null;
  violations: AdminModerationViolationDto[];
  generationsCount: number;
}

export interface AdminModerationStatusResponse {
  isAdmin: boolean;
  role: AdminRole | null;
}

export interface AdminModerationCombinedResponse {
  overview?: AdminModerationOverviewResponse;
  violations?: AdminModerationViolationsResponse;
  users?: AdminModerationUsersResponse;
  admins?: AdminModerationAdminsResponse;
}

export type AdminModerationActionName =
  | "ban"
  | "unban"
  | "mark_spammer"
  | "mark_scammer"
  | "clear_status"
  | "clear_flags"
  | "add_admin"
  | "revoke_admin";

export interface AdminModerationActionRequest {
  action: AdminModerationActionName;
  userId?: string;
  targetUserId?: string;
  walletAddress?: string;
  targetWalletAddress?: string;
  role?: AdminRole;
  reason?: string;
  notes?: string;
}

/**
 * Shared connected-capability projection served by
 * `GET /api/v1/connections/accounts`. Mirrors the provider-neutral
 * `ConnectedAccount` contract from `@elizaos/core`; account IDs are opaque
 * capability handles, never credential row IDs, and no secret material is
 * ever present.
 */
export type ConnectedAccountModeDto =
  | "cloud"
  | "connector"
  | "local"
  | "native";

export type ConnectedAccountStatusDto =
  | "connected"
  | "disabled"
  | "error"
  | "reauth_required"
  | "revoked"
  | "unavailable";

export type ConnectedCapabilityStatusDto =
  | "available"
  | "account_disabled"
  | "account_error"
  | "account_revoked"
  | "cost_blocked"
  | "needs_admin"
  | "needs_review"
  | "needs_scope"
  | "not_configured"
  | "provider_unavailable"
  | "unsupported";

export interface ConnectedAccountCapabilityDto {
  capabilityId: string;
  riskLevel: "R0" | "R1" | "R2" | "R3";
  status: ConnectedCapabilityStatusDto;
}

export interface ConnectedAccountDto {
  contractVersion: number;
  accountId: string;
  providerId: string;
  mode: ConnectedAccountModeDto;
  status: ConnectedAccountStatusDto;
  displayName: string | null;
  capabilities: ConnectedAccountCapabilityDto[];
  lastUsedAt: IsoDateString | null;
}

export interface ConnectedAccountPageDto {
  accounts: ConnectedAccountDto[];
  total: number;
  limit: number;
  offset: number;
}

export interface ConnectedAccountDetailDto {
  account: ConnectedAccountDto;
}
