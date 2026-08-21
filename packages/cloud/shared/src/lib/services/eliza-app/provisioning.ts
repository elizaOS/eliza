// Coordinates cloud service provisioning behavior behind route handlers.
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { jobsRepository } from "../../../db/repositories/jobs";
import type { AgentSandbox, AgentSandboxStatus } from "../../../db/schemas/agent-sandboxes";
import { ApiError } from "../../api/cloud-worker-errors";
import { containersEnv } from "../../config/containers-env";
import { getMaxNonTerminalAgentsForOrg } from "../../constants/agent-sandbox-quota";
import { logger } from "../../utils/logger";
import { checkAgentCreditGate } from "../agent-billing-gate";
import { elizaSandboxService } from "../eliza-sandbox";
import { provisioningJobService } from "../provisioning-jobs";

const DEFAULT_AGENT_NAME = "Eliza";
// Use the canonical managed-agent image so the daemon pulls from ghcr.io
// (the source of truth), not Docker Hub where the image does not exist.
// A bare name like "elizaos/eliza:latest" causes Docker to resolve against
// docker.io, producing an "unauthorized" / "pull access denied" error.
const DEFAULT_DOCKER_IMAGE = containersEnv.defaultAgentImage();

/**
 * Minimum gap between two onboarding-driven provision attempts for one sandbox.
 *
 * Without it, an organization whose provisioning is genuinely broken would
 * enqueue a fresh attempt on every inbound message, turning one stuck user into
 * a container-build storm against the shared fleet. Measured against the last
 * attempt's own terminal timestamp, so a node outage costs at most one build
 * per window per organization.
 */
const ELIZA_APP_REPROVISION_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * What the onboarding path should do with the organization's newest sandbox.
 *
 * `reuse` covers every state that is already heading toward a working agent.
 * `reprovision` covers states where the row is still the user's agent but its
 * compute is gone, so the same row is re-armed with a new provision job.
 * `replace` covers rows being torn down, where a NEW row is the only correct
 * answer — reviving one mid-deletion would race the teardown.
 */
type ElizaAppSandboxDisposition = "reuse" | "reprovision" | "replace";

export function classifyElizaAppSandbox(status: AgentSandboxStatus): ElizaAppSandboxDisposition {
  // Exhaustive by design, with no `default`: a tenth status must fail the build
  // here rather than silently inherit whichever branch happens to be last. The
  // old guard's bug was exactly this kind of silent catch-all.
  switch (status) {
    case "pending":
    case "provisioning":
    case "running":
    case "stopped":
    case "sleeping":
      return "reuse";
    case "error":
    case "disconnected":
      return "reprovision";
    case "deletion_pending":
    case "deletion_failed":
      return "replace";
  }
}

/**
 * A 409 from the enqueue means another lifecycle operation owns this agent —
 * a deletion in flight, or an unresolved replacement-cleanup fence. Re-arming
 * has to stand down and let that finish; it is a state of the world, not a
 * fault. Anything else is a real failure and must escape.
 */
function isLifecycleConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

/**
 * Whether enough time has passed since this sandbox's last provision attempt.
 *
 * Keyed on the JOB's terminal timestamp, never `sandbox.updated_at`: heartbeat,
 * reconciler and billing writers all bump the row, and any of them would keep
 * pushing the deadline outward — re-creating the permanent lockout this whole
 * change exists to remove. No prior job means nothing has been attempted for
 * this row, so the caller may proceed.
 */
async function elizaAppReprovisionCooldownElapsed(
  sandbox: AgentSandbox,
  nowMs: number,
): Promise<boolean> {
  const last = await jobsRepository.findLatestAgentLifecycleJob({
    type: "agent_provision",
    organizationId: sandbox.organization_id,
    agentId: sandbox.id,
  });
  if (!last) return true;
  const settledAt = last.completed_at ?? last.updated_at;
  if (!settledAt) return false;
  return nowMs - new Date(settledAt).getTime() >= ELIZA_APP_REPROVISION_COOLDOWN_MS;
}

export interface ElizaAppProvisioningStatus {
  status: string;
  agentId: string | null;
  bridgeUrl: string | null;
  sandbox: AgentSandbox | null;
}

export function toElizaAppProvisioningStatus(
  sandbox: Pick<AgentSandbox, "id" | "status" | "bridge_url"> | null | undefined,
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
    sandbox: sandbox as AgentSandbox,
  };
}

export function publicElizaAppProvisioningPayload(status: ElizaAppProvisioningStatus) {
  return {
    status: status.status,
    ...(status.agentId ? { agentId: status.agentId } : {}),
    ...(status.bridgeUrl ? { bridgeUrl: status.bridgeUrl } : {}),
  };
}

export async function getElizaAppProvisioningStatus(
  organizationId: string,
): Promise<ElizaAppProvisioningStatus> {
  const sandboxes = await agentSandboxesRepository.listByOrganization(organizationId);
  return toElizaAppProvisioningStatus(sandboxes[0]);
}

export async function ensureElizaAppProvisioning(params: {
  organizationId: string;
  userId: string;
}): Promise<ElizaAppProvisioningStatus> {
  const existing = await getElizaAppProvisioningStatus(params.organizationId);
  // Only a sandbox still heading toward a working agent short-circuits here.
  // Testing the ROW'S EXISTENCE instead of its state is what stranded every
  // organization whose newest row had died: the reaper marks a wedged row
  // `error` precisely so the user can re-provision, and this guard was what
  // stopped them (#17924).
  const disposition = existing.sandbox ? classifyElizaAppSandbox(existing.sandbox.status) : null;
  if (existing.sandbox && disposition === "reuse") {
    return existing;
  }

  // Every create/provision/resume path runs the credit gate before minting
  // compute; this onboarding entry point must too. It now covers BOTH
  // remaining branches — re-arming a dead row builds a container just as a
  // fresh row does, so neither may skip it. Return a non-provisioning status
  // instead of throwing: runOnboardingChat has no enclosing try/catch, so a
  // throw here would 500 the whole onboarding turn.
  const creditGate = await checkAgentCreditGate(params.organizationId);
  if (!creditGate.allowed) {
    logger.warn("[eliza-app provisioning] Credit gate blocked provisioning", {
      orgId: params.organizationId,
      balance: creditGate.balance,
    });
    return {
      status: "insufficient_credits",
      agentId: null,
      bridgeUrl: null,
      sandbox: null,
    };
  }

  if (existing.sandbox && disposition === "reprovision") {
    const sandbox = existing.sandbox;
    if (!(await elizaAppReprovisionCooldownElapsed(sandbox, Date.now()))) {
      logger.info("[eliza-app provisioning] Re-provision held by cooldown", {
        agentId: sandbox.id,
        orgId: params.organizationId,
      });
      return existing;
    }

    try {
      await provisioningJobService.enqueueAgentProvision({
        agentId: sandbox.id,
        organizationId: params.organizationId,
        userId: params.userId,
        agentName: DEFAULT_AGENT_NAME,
      });
      logger.info("[eliza-app provisioning] Re-armed a dead sandbox", {
        agentId: sandbox.id,
        orgId: params.organizationId,
        fromStatus: sandbox.status,
      });
    } catch (err) {
      // error-policy:J4 the enqueue refuses while a lifecycle job already owns
      // this agent; that is the dedup working, not a failure, and the caller
      // has no try/catch. Any other error is a real fault and must escape.
      if (!isLifecycleConflict(err)) throw err;
      logger.info("[eliza-app provisioning] Re-provision already queued", {
        agentId: sandbox.id,
        orgId: params.organizationId,
      });
    }

    // Returned unchanged, still `error`: the row only becomes `provisioning`
    // when the daemon claims the job and calls trySetProvisioning. Reporting
    // progress here would invent a state the database does not have.
    return toElizaAppProvisioningStatus(sandbox);
  }

  const { agent: sandbox, idempotent } = await elizaSandboxService.createAgent({
    organizationId: params.organizationId,
    userId: params.userId,
    agentName: DEFAULT_AGENT_NAME,
    dockerImage: DEFAULT_DOCKER_IMAGE,
    reuseExistingNonTerminal: true,
    maxNonTerminalAgents: getMaxNonTerminalAgentsForOrg(creditGate.balance),
  });

  // The org-scoped guard reused an in-flight sandbox; its provision job is
  // already queued, so don't enqueue a second one.
  if (!idempotent) {
    // createAgent committed a `pending` row, but the daemon only claims rows
    // that already have an `agent_provision` job. A throw here would strand the
    // row, and the reuse guard would then hand that job-less row back on every
    // later call (idempotent:true → skip enqueue), making it permanent. Delete
    // the just-created row on failure so a retry mints a fresh agent + job.
    try {
      await provisioningJobService.enqueueAgentProvision({
        agentId: sandbox.id,
        organizationId: params.organizationId,
        userId: params.userId,
        agentName: DEFAULT_AGENT_NAME,
      });
    } catch (err) {
      // error-policy:J6 best-effort teardown of the just-created row so the reuse
      // guard can't hand this job-less sandbox back forever. The compensating
      // delete must never mask the real enqueue failure: the original error is
      // always rethrown, and a failed cleanup is only logged.
      await agentSandboxesRepository
        .delete(sandbox.id, params.organizationId)
        .catch((cleanupErr) => {
          logger.error(
            "[eliza-app provisioning] Failed to delete stranded sandbox row after enqueue failure",
            { agentId: sandbox.id, orgId: params.organizationId, cleanupErr },
          );
        });
      throw err;
    }
  }

  logger.info(
    idempotent
      ? "[eliza-app provisioning] Reusing in-flight sandbox"
      : "[eliza-app provisioning] Provisioning kicked off",
    {
      agentId: sandbox.id,
      orgId: params.organizationId,
    },
  );

  return toElizaAppProvisioningStatus(sandbox);
}
