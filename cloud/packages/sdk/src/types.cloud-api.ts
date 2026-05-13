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

export type AgentsResponse = ApiSuccessEnvelope<AgentListItemDto[]>;
export type AgentResponse = ApiSuccessEnvelope<AgentDetailDto>;
