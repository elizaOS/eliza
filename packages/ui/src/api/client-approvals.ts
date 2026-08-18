/**
 * ElizaClient extension for the "actions requiring your response" surface. The
 * agent route projects pending ApprovalService tasks into PendingUserActions;
 * this client only fetches that read model — no transformation.
 */
import type { PendingUserAction } from "@elizaos/core";
import { ElizaClient } from "./client-base";

/**
 * Typed client for the canonical "actions requiring your response" surface
 * (#9449 PILLAR C). The agent route (`GET /api/approvals`) already projects the
 * pending ApprovalService tasks into {@link PendingUserAction}s; the client just
 * fetches that read model — no transformation here.
 */
export interface PendingActionsResponse {
  pending: PendingUserAction[];
}

/** Approvals list GET — existing 10s REST budget, independent hop. */
export const APPROVALS_LIST_FETCH_TIMEOUT_MS = 10_000;

declare module "./client-base" {
  interface ElizaClient {
    listPendingActions(timeoutMs?: number): Promise<PendingActionsResponse>;
  }
}

ElizaClient.prototype.listPendingActions = async function (
  this: ElizaClient,
  timeoutMs: number = APPROVALS_LIST_FETCH_TIMEOUT_MS,
): Promise<PendingActionsResponse> {
  return this.fetch<PendingActionsResponse>("/api/approvals", undefined, {
    timeoutMs,
  });
};
