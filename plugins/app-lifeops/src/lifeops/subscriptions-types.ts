export type LifeOpsSubscriptionAuditStatus = "completed" | "failed";

export type LifeOpsSubscriptionSource = "gmail" | "manual";

export type LifeOpsSubscriptionState = "active" | "canceled" | "uncertain";

export type LifeOpsSubscriptionCadence = "monthly" | "annual" | "unknown";

export type LifeOpsSubscriptionExecutor =
  | "user_browser"
  | "agent_browser"
  | "desktop_native";

export type LifeOpsSubscriptionCancellationStatus =
  | "draft"
  | "awaiting_confirmation"
  | "running"
  | "completed"
  | "already_canceled"
  | "needs_login"
  | "needs_mfa"
  | "needs_user_choice"
  | "retention_offer"
  | "phone_only"
  | "chat_only"
  | "unsupported_surface"
  | "blocked"
  | "failed";

export interface LifeOpsSubscriptionAudit {
  id: string;
  agentId: string;
  source: LifeOpsSubscriptionSource;
  queryWindowDays: number;
  status: LifeOpsSubscriptionAuditStatus;
  totalCandidates: number;
  activeCandidates: number;
  canceledCandidates: number;
  uncertainCandidates: number;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsSubscriptionCandidate {
  id: string;
  agentId: string;
  auditId: string;
  serviceSlug: string;
  serviceName: string;
  provider: string;
  cadence: LifeOpsSubscriptionCadence;
  state: LifeOpsSubscriptionState;
  confidence: number;
  annualCostEstimateUsd: number | null;
  managementUrl: string | null;
  latestEvidenceAt: string | null;
  evidenceJson: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsSubscriptionCancellation {
  id: string;
  agentId: string;
  auditId: string | null;
  candidateId: string | null;
  serviceSlug: string;
  serviceName: string;
  executor: LifeOpsSubscriptionExecutor;
  status: LifeOpsSubscriptionCancellationStatus;
  confirmed: boolean;
  currentStep: string | null;
  browserSessionId: string | null;
  evidenceSummary: string | null;
  artifactCount: number;
  managementUrl: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface LifeOpsSubscriptionAuditSummary {
  audit: LifeOpsSubscriptionAudit;
  candidates: LifeOpsSubscriptionCandidate[];
}

export interface LifeOpsSubscriptionCancellationSummary {
  cancellation: LifeOpsSubscriptionCancellation;
  candidate: LifeOpsSubscriptionCandidate | null;
}

export interface LifeOpsSubscriptionDiscoveryRequest {
  queryWindowDays?: number;
  serviceQuery?: string | null;
}

export interface LifeOpsSubscriptionCancellationRequest {
  candidateId?: string | null;
  serviceName?: string | null;
  serviceSlug?: string | null;
  executor?: LifeOpsSubscriptionExecutor | null;
  confirmed?: boolean;
}
