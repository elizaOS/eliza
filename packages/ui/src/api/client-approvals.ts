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

declare module "./client-base" {
  interface ElizaClient {
    listPendingActions(): Promise<PendingActionsResponse>;
  }
}

ElizaClient.prototype.listPendingActions = async function (
  this: ElizaClient,
): Promise<PendingActionsResponse> {
  return this.fetch<PendingActionsResponse>("/api/approvals");
};
