import { ElizaClient } from "./client-base";

export type ComputerUseApprovalMode =
  | "full_control"
  | "smart_approve"
  | "approve_all"
  | "off";

export interface ComputerUsePendingApproval {
  id: string;
  command: string;
  parameters: Record<string, unknown>;
  requestedAt: string;
}

export interface ComputerUseApprovalSnapshot {
  mode: ComputerUseApprovalMode;
  pendingCount: number;
  pendingApprovals: ComputerUsePendingApproval[];
}

export interface ComputerUseApprovalResolution {
  id: string;
  command: string;
  approved: boolean;
  cancelled: boolean;
  mode: ComputerUseApprovalMode;
  requestedAt: string;
  resolvedAt: string;
  reason?: string;
}

declare module "./client-base" {
  interface ElizaClient {
    getComputerUseApprovals(): Promise<ComputerUseApprovalSnapshot>;
    respondToComputerUseApproval(
      id: string,
      approved: boolean,
      reason?: string,
    ): Promise<ComputerUseApprovalResolution>;
    setComputerUseApprovalMode(
      mode: ComputerUseApprovalMode,
    ): Promise<{ mode: ComputerUseApprovalMode }>;
  }
}

ElizaClient.prototype.getComputerUseApprovals = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/computer-use/approvals");
};

ElizaClient.prototype.respondToComputerUseApproval = async function (
  this: ElizaClient,
  id: string,
  approved: boolean,
  reason?: string,
) {
  return this.fetch(`/api/computer-use/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ approved, reason }),
  });
};

ElizaClient.prototype.setComputerUseApprovalMode = async function (
  this: ElizaClient,
  mode: ComputerUseApprovalMode,
) {
  return this.fetch("/api/computer-use/approval-mode", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
};
