// Coordinates cloud service provisioning behavior behind route handlers.
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { creditTransactionsRepository } from "../../../db/repositories/credit-transactions";
import type { AgentSandbox } from "../../../db/schemas/agent-sandboxes";
import { containersEnv } from "../../config/containers-env";
import { logger } from "../../utils/logger";
import { checkAgentCreditGate } from "../agent-billing-gate";
import { creditsService } from "../credits";
import { elizaSandboxService } from "../eliza-sandbox";
import { provisioningJobService } from "../provisioning-jobs";

const DEFAULT_AGENT_NAME = "Eliza";
// Use the canonical managed-agent image so the daemon pulls from ghcr.io
// (the source of truth), not Docker Hub where the image does not exist.
// A bare name like "elizaos/eliza:latest" causes Docker to resolve against
// docker.io, producing an "unauthorized" / "pull access denied" error.
const DEFAULT_DOCKER_IMAGE = containersEnv.defaultAgentImage();
const ELIZA_APP_INITIAL_CREDITS = 5.0;

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

async function ensureElizaAppStarterCredits(params: {
  organizationId: string;
  userId: string;
}): Promise<void> {
  if (ELIZA_APP_INITIAL_CREDITS <= 0) return;

  const hasStarterCredits = await creditTransactionsRepository.hasElizaAppInitialFreeCredits(
    params.organizationId,
  );
  if (hasStarterCredits) return;

  await creditsService.addCredits({
    organizationId: params.organizationId,
    amount: ELIZA_APP_INITIAL_CREDITS,
    description: "Eliza App - Welcome bonus",
    metadata: {
      type: "initial_free_credits",
      source: "eliza-app-onboarding",
      userId: params.userId,
    },
    stripePaymentIntentId: `eliza-app-initial-free-credits:${params.organizationId}`,
  });
}

export async function ensureElizaAppProvisioning(params: {
  organizationId: string;
  userId: string;
}): Promise<ElizaAppProvisioningStatus> {
  await ensureElizaAppStarterCredits(params);

  const existing = await getElizaAppProvisioningStatus(params.organizationId);
  if (existing.sandbox) {
    return existing;
  }

  // Every other create/provision/resume path runs the credit gate before
  // createAgent; this onboarding entry point must too. Fresh orgs just
  // received the starter grant above so they pass, and an org with a live
  // sandbox already returned early — the gate only blocks NEW provisioning
  // for a drained returning org. Return a non-provisioning status instead of
  // throwing: runOnboardingChat has no enclosing try/catch, so a throw here
  // would 500 the whole onboarding turn.
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

  const { agent: sandbox, idempotent } = await elizaSandboxService.createAgent({
    organizationId: params.organizationId,
    userId: params.userId,
    agentName: DEFAULT_AGENT_NAME,
    dockerImage: DEFAULT_DOCKER_IMAGE,
    reuseExistingNonTerminal: true,
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
