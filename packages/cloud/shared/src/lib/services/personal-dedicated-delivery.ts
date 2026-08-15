/**
 * Prepares an authoritative personal Dedicated runtime for a connector turn.
 *
 * Connector delivery may arrive while paid compute is stopped or sleeping.
 * This service reuses the existing credit, worker-health, and idempotent
 * lifecycle-job contracts so messaging can request recovery without ever
 * reopening the archived Shared conversation.
 */

import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import type { AppEnv } from "../../types/cloud-worker-env";
import { checkAgentCreditGate } from "./agent-billing-gate";
import { provisioningJobService } from "./provisioning-jobs";
import { checkProvisioningWorkerHealth } from "./provisioning-worker-health";

export const PERSONAL_DEDICATED_RETRY_AFTER_SECONDS = 5;

export type PersonalDedicatedDeliveryPreparation =
  | { state: "ready" }
  | {
      state: "starting";
      action: "resume" | "wake";
      created: boolean;
      jobId: string;
      previousStatus: "stopped" | "sleeping";
      retryAfterSeconds: number;
    }
  | {
      state: "blocked";
      code: "insufficient_credits";
      error: string;
      currentBalance: number;
    }
  | {
      state: "unavailable";
      code:
        | "dedicated_starting"
        | "dedicated_state_unavailable"
        | "PROVISIONING_WORKER_NOT_CONFIGURED"
        | "PROVISIONING_WORKER_UNHEALTHY"
        | "PROVISIONING_WORKER_UNREACHABLE";
      error: string;
      retryable: boolean;
      status: 502 | 503;
      retryAfterSeconds?: number;
    };

/**
 * Return ready only for a running runtime. Stopped and sleeping targets keep
 * their server-owned cutover authority while an idempotent paid-compute
 * recovery job starts; every other lifecycle state remains fail-closed.
 */
export async function preparePersonalDedicatedDelivery(
  target: Pick<AgentSandbox, "id" | "status">,
  identity: { organizationId: string; userId: string },
  env: AppEnv["Bindings"],
  executionCtx: { waitUntil(promise: Promise<unknown>): void },
): Promise<PersonalDedicatedDeliveryPreparation> {
  if (target.status === "running") return { state: "ready" };

  if (target.status === "pending" || target.status === "provisioning") {
    return {
      state: "unavailable",
      code: "dedicated_starting",
      error: "Dedicated Eliza is still starting.",
      retryable: true,
      status: 503,
      retryAfterSeconds: PERSONAL_DEDICATED_RETRY_AFTER_SECONDS,
    };
  }

  if (target.status !== "stopped" && target.status !== "sleeping") {
    return {
      state: "unavailable",
      code: "dedicated_state_unavailable",
      error: "Dedicated Eliza is temporarily unavailable.",
      retryable: false,
      status: 503,
    };
  }

  const creditCheck = await checkAgentCreditGate(identity.organizationId);
  if (!creditCheck.allowed) {
    return {
      state: "blocked",
      code: "insufficient_credits",
      error:
        creditCheck.error ??
        "Dedicated Eliza needs a funded balance before paid compute can start.",
      currentBalance: creditCheck.balance,
    };
  }

  const workerHealth = await checkProvisioningWorkerHealth();
  if (!workerHealth.ok) {
    return {
      state: "unavailable",
      code: workerHealth.code,
      error: workerHealth.error,
      retryable: true,
      status: workerHealth.status,
      retryAfterSeconds: PERSONAL_DEDICATED_RETRY_AFTER_SECONDS,
    };
  }

  const common = {
    agentId: target.id,
    organizationId: identity.organizationId,
    userId: identity.userId,
  };
  const result =
    target.status === "sleeping"
      ? await provisioningJobService.enqueueAgentWakeOnce(common)
      : await provisioningJobService.enqueueAgentResumeOnce(common);

  // The durable job is already committed. This kick only avoids waiting for
  // the periodic poller and observes its own transport failures internally.
  executionCtx.waitUntil(provisioningJobService.triggerImmediate(env));
  return {
    state: "starting",
    action: target.status === "sleeping" ? "wake" : "resume",
    created: result.created,
    jobId: result.job.id,
    previousStatus: target.status,
    retryAfterSeconds: PERSONAL_DEDICATED_RETRY_AFTER_SECONDS,
  };
}
