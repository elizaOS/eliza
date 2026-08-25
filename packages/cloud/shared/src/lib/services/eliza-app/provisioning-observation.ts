/** Pure authority and payload helpers for observation-only onboarding status. */
import type { AgentSandbox, AgentSandboxStatus } from "../../../db/schemas/agent-sandboxes";

/**
 * Actively-deleting rows cannot be a current target. `deletion_failed` is NOT
 * one of them: the schema contract says deletion retries are exhausted, the
 * container may still be running, and "row stays so the failure is visible".
 * Excluding it made a newer failed row invisible and silently promoted an
 * OLDER running row to canonical — which is both a hidden lifecycle failure
 * and a transcript handoff into the wrong agent.
 */
const ACTIVELY_DELETING_STATUSES = new Set<AgentSandboxStatus>(["deletion_pending"]);

function isElizaAppProvisioningTarget(sandbox: AgentSandbox, userId: string): boolean {
  return (
    sandbox.user_id === userId &&
    sandbox.execution_tier !== "shared" &&
    sandbox.pool_status == null &&
    sandbox.deleted_at == null &&
    // Every user-written `deletion_failed` row carries a non-null attempt id
    // (eliza-sandbox.ts sets the status under a WHERE bound to it), so the
    // attempt-id check would exclude it a second time.
    (sandbox.deletion_attempt_id == null || sandbox.status === "deletion_failed") &&
    !ACTIVELY_DELETING_STATUSES.has(sandbox.status)
  );
}

/**
 * Select the latest user-owned Dedicated target independently of input order.
 * Lifecycle failures (including `deletion_failed`) and stopped/sleeping states
 * remain observable; only rows that cannot be a current user target (Shared,
 * pool, deleted, or actively deleting) are excluded. UUID order is the stable tie-break for equal creation timestamps.
 */
export function selectElizaAppProvisioningTarget(
  sandboxes: readonly AgentSandbox[],
  userId: string,
): AgentSandbox | undefined {
  let selected: AgentSandbox | undefined;
  for (const sandbox of sandboxes) {
    if (!isElizaAppProvisioningTarget(sandbox, userId)) continue;
    if (!selected) {
      selected = sandbox;
      continue;
    }

    const createdDelta = sandbox.created_at.getTime() - selected.created_at.getTime();
    if (createdDelta > 0 || (createdDelta === 0 && sandbox.id > selected.id)) {
      selected = sandbox;
    }
  }
  return selected;
}

export interface ElizaAppProvisioningStatus {
  status: AgentSandboxStatus | "none";
  agentId: string | null;
  bridgeUrl: string | null;
  sandbox: AgentSandbox | null;
}

export function toElizaAppProvisioningStatus(
  sandbox: AgentSandbox | null | undefined,
): ElizaAppProvisioningStatus {
  if (!sandbox) {
    return {
      status: "none",
      agentId: null,
      bridgeUrl: null,
      sandbox: null,
    };
  }

  return {
    status: sandbox.status,
    agentId: sandbox.id,
    bridgeUrl: sandbox.status === "running" ? (sandbox.bridge_url ?? null) : null,
    sandbox,
  };
}

export function publicElizaAppProvisioningPayload(status: ElizaAppProvisioningStatus) {
  return {
    status: status.status,
    ...(status.agentId ? { agentId: status.agentId } : {}),
    ...(status.bridgeUrl ? { bridgeUrl: status.bridgeUrl } : {}),
  };
}
