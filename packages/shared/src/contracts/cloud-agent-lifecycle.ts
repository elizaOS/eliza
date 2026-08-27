/**
 * Browser-safe Cloud agent lifecycle value sets shared by persistence,
 * transport DTOs, SDK consumers, API routes, and operational tooling.
 */

export const AGENT_SANDBOX_STATUSES = [
  "pending",
  "provisioning",
  "running",
  "stopped",
  "sleeping",
  "disconnected",
  "error",
  "deletion_pending",
  "deletion_failed",
] as const;

export type AgentSandboxStatus = (typeof AGENT_SANDBOX_STATUSES)[number];

export const AGENT_EXECUTION_TIERS = [
  "shared",
  "dedicated-lazy",
  "dedicated-always",
  "custom",
] as const;

export type AgentExecutionTier = (typeof AGENT_EXECUTION_TIERS)[number];

/** Explicit allowlist for lifecycle operations that require a real container. */
export const CONTAINER_BACKED_EXECUTION_TIERS = [
  "dedicated-lazy",
  "dedicated-always",
  "custom",
] as const satisfies readonly AgentExecutionTier[];

export type ContainerBackedAgentExecutionTier =
  (typeof CONTAINER_BACKED_EXECUTION_TIERS)[number];

export type CloudAgentDatabaseStatus =
  | "none"
  | "provisioning"
  | "ready"
  | "error";

/** A server-owned lifecycle job that clients can resume polling after reload. */
export interface CloudAgentActiveJobDto {
  id: string;
  type: string;
  status: "pending" | "in_progress";
  attempts: number;
  maxAttempts: number;
  estimatedCompletionAt: string | null;
  scheduledFor: string;
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Strict current wire shape returned by Cloud agent list endpoints. */
export interface CloudAgentListItemDto {
  id: string;
  agentName: string | null;
  status: AgentSandboxStatus;
  databaseStatus: CloudAgentDatabaseStatus;
  lastBackupAt: string | null;
  lastHeartbeatAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  token_address: string | null;
  token_chain: string | null;
  token_name: string | null;
  token_ticker: string | null;
  dockerImage: string | null;
  executionTier: AgentExecutionTier;
  webUiUrl: string | null;
  activeJob: CloudAgentActiveJobDto | null;
}

export interface CloudAgentAdminDetailsDto {
  nodeId: string | null;
  containerName: string | null;
  internalBridgeUrl: string | null;
  headscaleIp: string | null;
  bridgePort: number | null;
  webUiPort: number | null;
  dockerImage: string | null;
  isDockerBacked: boolean;
  webUiUrl: string | null;
  sshCommand: string | null;
}

export type CloudAgentWalletStatus = "active" | "pending" | "none" | "error";

/** Strict current wire shape returned by a Cloud agent detail endpoint. */
export interface CloudAgentDetailDto extends CloudAgentListItemDto {
  errorCount: number;
  walletAddress: string | null;
  walletProvider: string | null;
  walletStatus: CloudAgentWalletStatus;
  adminDetails: CloudAgentAdminDetailsDto | null;
}

export function isAgentSandboxStatus(
  value: unknown,
): value is AgentSandboxStatus {
  return (
    typeof value === "string" &&
    AGENT_SANDBOX_STATUSES.some((status) => status === value)
  );
}

export function isAgentExecutionTier(
  value: unknown,
): value is AgentExecutionTier {
  return (
    typeof value === "string" &&
    AGENT_EXECUTION_TIERS.some((tier) => tier === value)
  );
}
