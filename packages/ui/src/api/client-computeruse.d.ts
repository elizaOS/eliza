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
    setComputerUseApprovalMode(mode: ComputerUseApprovalMode): Promise<{
      mode: ComputerUseApprovalMode;
    }>;
  }
}
//# sourceMappingURL=client-computeruse.d.ts.map
