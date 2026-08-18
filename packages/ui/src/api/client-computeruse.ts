/**
 * ElizaClient extension and wire types for computer-use: approval modes, pending
 * approvals, and the verbs that resolve them.
 */
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
  // Optional: the server may omit this in partial/error snapshots served during
  // recovery windows. Consumers must default it (see ComputerUseApprovalOverlay).
  pendingApprovals?: ComputerUsePendingApproval[];
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

/** Approvals GET — existing 10s REST budget, independent hop. */
export const COMPUTER_USE_GET_APPROVALS_FETCH_TIMEOUT_MS = 10_000;
/** Respond POST — existing 10s REST budget, independent hop. */
export const COMPUTER_USE_RESPOND_FETCH_TIMEOUT_MS = 10_000;
/** Approval-mode POST — existing 10s REST budget, independent hop. */
export const COMPUTER_USE_SET_MODE_FETCH_TIMEOUT_MS = 10_000;

declare module "./client-base" {
  interface ElizaClient {
    getComputerUseApprovals(
      timeoutMs?: number,
    ): Promise<ComputerUseApprovalSnapshot>;
    respondToComputerUseApproval(
      id: string,
      approved: boolean,
      reason?: string,
      timeoutMs?: number,
    ): Promise<ComputerUseApprovalResolution>;
    setComputerUseApprovalMode(
      mode: ComputerUseApprovalMode,
      timeoutMs?: number,
    ): Promise<{ mode: ComputerUseApprovalMode }>;
  }
}

ElizaClient.prototype.getComputerUseApprovals = async function (
  this: ElizaClient,
  timeoutMs: number = COMPUTER_USE_GET_APPROVALS_FETCH_TIMEOUT_MS,
) {
  return this.fetch("/api/computer-use/approvals", undefined, { timeoutMs });
};

ElizaClient.prototype.respondToComputerUseApproval = async function (
  this: ElizaClient,
  id: string,
  approved: boolean,
  reason?: string,
  timeoutMs: number = COMPUTER_USE_RESPOND_FETCH_TIMEOUT_MS,
) {
  return this.fetch(
    `/api/computer-use/approvals/${encodeURIComponent(id)}`,
    {
      method: "POST",
      body: JSON.stringify({ approved, reason }),
    },
    { timeoutMs },
  );
};

ElizaClient.prototype.setComputerUseApprovalMode = async function (
  this: ElizaClient,
  mode: ComputerUseApprovalMode,
  timeoutMs: number = COMPUTER_USE_SET_MODE_FETCH_TIMEOUT_MS,
) {
  return this.fetch(
    "/api/computer-use/approval-mode",
    {
      method: "POST",
      body: JSON.stringify({ mode }),
    },
    { timeoutMs },
  );
};
