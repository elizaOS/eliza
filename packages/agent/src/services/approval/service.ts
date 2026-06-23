/**
 * ApprovalService — the runtime-owned owner-approval queue, exposed as a
 * registered runtime service.
 *
 * The approval queue is a runtime primitive: any plugin (LifeOps outbound
 * sends, document signatures, travel booking, …) consumes it via
 * `runtime.getService(...)` rather than constructing the DB-backed queue
 * itself. The service is a thin factory over {@link PgApprovalQueue}, backed by
 * the `approval_requests` table owned by `@elizaos/plugin-sql` (public schema);
 * the `agentId` is the multi-tenant partition key and defaults to
 * `runtime.agentId`.
 *
 * Mirrors `KnowledgeGraphService` (lifecycle + getService accessor).
 */

import { type IAgentRuntime, Service } from "@elizaos/core";
import { createApprovalQueue } from "./store.ts";
import type { ApprovalQueue } from "./types.ts";

export const APPROVAL_SERVICE = "eliza_approval";

export class ApprovalService extends Service {
  static override serviceType = APPROVAL_SERVICE;

  override capabilityDescription =
    "Runtime owner-approval queue: enqueue/list/resolve outbound-action approvals over the plugin-sql approval_requests table";

  static async start(runtime: IAgentRuntime): Promise<ApprovalService> {
    return new ApprovalService(runtime);
  }

  async stop(): Promise<void> {}

  /**
   * Per-agent approval queue. `agentId` partitions the queue; it defaults to
   * the runtime's agent id and may be overridden for admin/multi-tenant
   * access.
   */
  getQueue(agentId: string = this.runtime.agentId): ApprovalQueue {
    return createApprovalQueue(this.runtime, { agentId });
  }
}

/**
 * Resolve the registered {@link ApprovalService}. Returns `null` when the
 * runtime has not registered it (e.g. the "eliza" plugin is absent).
 */
export function resolveApprovalService(
  runtime: IAgentRuntime,
): ApprovalService | null {
  return runtime.getService<ApprovalService>(APPROVAL_SERVICE);
}
