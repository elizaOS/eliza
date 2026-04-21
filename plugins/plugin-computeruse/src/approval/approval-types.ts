export type ApprovalMode =
  | "full_control"
  | "smart_approve"
  | "approve_all"
  | "off";

export interface ApprovalRequest {
  id: string;
  command: string;
  parameters: Record<string, unknown>;
  requestedAt: Date;
}

export interface ApprovalResolution extends ApprovalRequest {
  approved: boolean;
  cancelled: boolean;
  mode: ApprovalMode;
  resolvedAt: Date;
  reason?: string;
}

export interface PendingApproval extends ApprovalRequest {
  promise: Promise<ApprovalResolution>;
}

export interface ApprovalManagerOptions {
  mode?: ApprovalMode;
}
