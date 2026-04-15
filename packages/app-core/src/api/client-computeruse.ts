import { ElizaClient } from "./client-base";

export interface ComputerUsePendingApproval {
  id: string;
  command: string;
  parameters: Record<string, unknown>;
  requestedAt: string;
}

export interface ComputerUseApprovalSnapshot {
  mode: string;
  pendingCount: number;
  pendingApprovals: ComputerUsePendingApproval[];
}

export interface ComputerUseApprovalResolution {
  id: string;
  command: string;
  approved: boolean;
  cancelled: boolean;
  mode: string;
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
