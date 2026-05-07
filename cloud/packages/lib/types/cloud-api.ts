export type IsoDateString = string;

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
  created_at: IsoDateString;
  updated_at: IsoDateString;
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
  steward_user_id: string | null;
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
  expires_at: IsoDateString | null;
  nickname: string | null;
  work_function: string | null;
  preferences: string | null;
  email_notifications: boolean | null;
  response_notifications: boolean | null;
  is_active: boolean;
  created_at: IsoDateString;
  updated_at: IsoDateString;
  organization: CurrentUserOrganizationDto | null;
}

export type CurrentUserResponse = ApiSuccessEnvelope<CurrentUserDto>;

export type UpdatedUserDto = Omit<CurrentUserDto, "organization">;

export interface UpdatedUserResponse extends ApiSuccessEnvelope<UpdatedUserDto> {
  message: string;
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
