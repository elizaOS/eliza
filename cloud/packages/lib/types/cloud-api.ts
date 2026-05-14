export type IsoDateString = string;
export type DateLike = Date | IsoDateString;

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

export interface UpdatedUserResponse extends ApiSuccessEnvelope<UpdatedUserDto> {
  message: string;
}

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

export type AppDeploymentStatus = "draft" | "building" | "deploying" | "deployed" | "failed";
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
  user_database_project_id: string | null;
  user_database_branch_id: string | null;
  user_database_region: string | null;
  user_database_error: string | null;
  email_notifications: boolean | null;
  response_notifications: boolean | null;
  is_active: boolean;
  is_approved: boolean;
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
  organization: {
    creditBalance: string | number;
  };
}

export interface EnhancedAnalyticsDataDto extends AnalyticsDataDto {
  filters: AnalyticsDataDto["filters"] & {
    timeRange: AnalyticsTimeRange;
  };
  providerBreakdown: AnalyticsProviderBreakdownDto[];
  modelBreakdown: AnalyticsModelBreakdownDto[];
  trends: AnalyticsTrendDto;
}

export interface AnalyticsProjectionPointDto extends AnalyticsTimeSeriesPointDto {
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

export interface CreditBalanceResponse {
  balance: number;
}

export type AgentSandboxStatus =
  | "pending"
  | "provisioning"
  | "running"
  | "stopped"
  | "disconnected"
  | "error";

export type AgentDatabaseStatus = "none" | "provisioning" | "ready" | "error";

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
}

export interface AgentAdminDetailsDto {
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

export type AgentsResponse = ApiSuccessEnvelope<AgentListItemDto[]>;
export type AgentResponse = ApiSuccessEnvelope<AgentDetailDto>;

export type AdminRole = "super_admin" | "moderator" | "viewer";
export type AdminModerationStatusValue = "clean" | "warned" | "spammer" | "scammer" | "banned";
export type AdminModerationAction = "refused" | "warned" | "flagged_for_ban" | "banned";

export type AdminModerationView = "overview" | "violations" | "users" | "admins" | "user-detail";

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
  currentAdmin: {
    wallet: string | null;
    role: AdminRole | null;
  };
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

/**
 * Combined response for `GET /api/v1/admin/moderation?view=a,b,c`.
 *
 * Each requested view is keyed under its own field; views that were not
 * requested are absent. Lets the admin page issue a single round trip
 * instead of four separate ones.
 */
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

export interface AdminModerationActionResponse {
  success: true;
  message: string;
  admin?: Pick<AdminUserDto, "id" | "walletAddress" | "role">;
}
