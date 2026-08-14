/**
 * POST /api/v1/eliza/agents/[agentId]/upgrade-tier
 *
 * First-class shared→dedicated tier upgrade (#15355). The shared agent keeps
 * serving the user throughout: this route only mints and provisions the
 * SEPARATE dedicated migration target; the client-side handoff machinery
 * (readiness poll → idempotent transcript import → repoint, see
 * `packages/ui/src/cloud/handoff/`) performs the actual switch once the
 * container is running, and only a confirmed switch deletes the shared bridge.
 *
 * Distinct from `agent_upgrade`/`[agentId]/downgrade`, which are IMAGE
 * blue/green swap/rollback for an existing container — this route changes the
 * agent's execution tier by minting a new dedicated record.
 *
 * Contract:
 *  - 404 unknown agent OR another org's agent (org-scoped read; no oracle).
 *  - 409 when the agent is not shared-tier (nothing to upgrade).
 *  - 402 canonical insufficient-credits body when the org cannot fund
 *    {@link AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS} days of dedicated hosting —
 *    a dedicated agent burns credits continuously, so the gate demands runway,
 *    not the bare create minimum.
 *  - 202 `created:true` + jobId/polling on a fresh mint. Identity is copied
 *    SERVER-side (agent_name / character_id / agent_config / environment_vars):
 *    the compat create route never reads the source row, and clients must not
 *    reconstruct identity from DTOs (onboarding-created shared agents keep
 *    name/bio only in agent_config).
 *  - 2xx `alreadyInProgress:true` reattach when this shared agent already has a
 *    live migration target (the `__agentUpgradedFrom` marker): the single-flight
 *    service (per-source database lock spanning target creation through the
 *    provision enqueue, #15943) makes retries and concurrent tabs resume the
 *    SAME upgrade, with target and job committed atomically — so a reattach
 *    never prepares credentials or environment state; it only reads (or
 *    re-arms, for stopped/sleeping/dead-job targets) durable state.
 */

import { Hono } from "hono";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { getMaxNonTerminalAgentsForOrg } from "@/lib/constants/agent-sandbox-quota";
import { checkAgentTierUpgradeCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import {
  createTierUpgradeTargetWithProvision,
  findLiveTierUpgradeTarget,
} from "@/lib/services/agent-tier-upgrade-target";
import {
  AgentQuotaExceededError,
  elizaSandboxService,
} from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { stripReservedEnvKeys } from "@/lib/services/reserved-env-keys";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

type AgentRow = NonNullable<
  Awaited<ReturnType<typeof elizaSandboxService.getAgentForWrite>>
>;

type AuthedUser = Awaited<
  ReturnType<typeof requireAuthOrApiKeyWithOrg>
>["user"];

function json(body: unknown, status = 200): Response {
  return applyCorsHeaders(Response.json(body, { status }), CORS_METHODS);
}

function pollingBody(jobId: string) {
  return {
    endpoint: `/api/v1/jobs/${jobId}`,
    intervalMs: 5000,
    expectedDurationMs: 90000,
  };
}

function asConfigRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asEnvRecord(value: unknown): Record<string, string> {
  const record = asConfigRecord(value);
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * Respond for a live migration target that already owns this upgrade — both
 * the pre-checked reattach and the race loser whose single-flight call
 * returned another request's committed target. Running and
 * already-provisioning targets reattach without a second credit gate: nothing
 * new starts billing. Resuming a stopped/sleeping target does start compute
 * again, so that path must prove the same dedicated runway as a fresh upgrade
 * before it may enqueue work. The enqueue is safe from any state because a
 * committed target's environment was fully prepared at creation — re-arming a
 * dead job never re-mints credentials.
 */
async function respondToLiveTarget(
  target: AgentRow,
  sharedAgentId: string,
  user: AuthedUser,
  env: AppEnv["Bindings"],
): Promise<Response> {
  logger.info("[agent-upgrade-tier] Reattaching to in-flight upgrade", {
    sharedAgentId,
    dedicatedAgentId: target.id,
    orgId: user.organization_id,
    status: target.status,
  });
  if (target.status === "running") {
    return json({
      success: true,
      created: false,
      alreadyInProgress: true,
      data: {
        id: target.id,
        agentId: target.id,
        dedicatedAgentId: target.id,
        sharedAgentId,
        agentName: target.agent_name,
        status: target.status,
        executionTier: target.execution_tier,
      },
    });
  }
  if (target.status === "stopped" || target.status === "sleeping") {
    const resumeCreditCheck = await checkAgentTierUpgradeCreditGate(
      user.organization_id,
    );
    if (!resumeCreditCheck.allowed) {
      return json(
        insufficientCredits402(
          resumeCreditCheck,
          "[agent-upgrade-tier] Resume blocked: insufficient hosting runway",
          {
            sharedAgentId,
            dedicatedAgentId: target.id,
            orgId: user.organization_id,
          },
          { requiredBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE },
        ),
        402,
      );
    }
  }
  // pending/provisioning (or stopped/sleeping after an interrupted boot):
  // hand back the active provision job — enqueue reuses an in-flight job
  // and only mints a new one when the previous attempt died.
  const reattach = await provisioningJobService.enqueueAgentProvisionOnce({
    agentId: target.id,
    organizationId: user.organization_id,
    userId: user.id,
    agentName: target.agent_name ?? target.id,
  });
  if (reattach.created) {
    void provisioningJobService.triggerImmediate(env).catch(() => {
      // error-policy:J5 fire-and-forget nudge; the job is persisted and the
      // provisioning cron is the safety net (failure logged in the service).
    });
  }
  return json(
    {
      success: true,
      created: false,
      alreadyInProgress: true,
      data: {
        id: target.id,
        agentId: target.id,
        dedicatedAgentId: target.id,
        sharedAgentId,
        agentName: target.agent_name,
        status: reattach.job.status,
        jobId: reattach.job.id,
        estimatedCompletionAt: reattach.job.estimated_completion_at,
        executionTier: target.execution_tier,
      },
      polling: pollingBody(reattach.job.id),
    },
    202,
  );
}

async function __hono_POST(
  request: Request,
  env: AppEnv["Bindings"],
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    const shared = await elizaSandboxService.getAgentForWrite(
      agentId,
      user.organization_id,
    );
    if (!shared) {
      return json({ success: false, error: "Agent not found" }, 404);
    }

    if (shared.execution_tier !== "shared") {
      return json(
        {
          success: false,
          code: "not_shared_tier",
          error:
            "Only shared-tier agents can be upgraded to dedicated. This agent already runs on its own container.",
        },
        409,
      );
    }

    // A shared row is `running` from creation; anything else (deletion in
    // flight, error) is not a healthy source to migrate a user off of.
    if (shared.status !== "running") {
      return json(
        {
          success: false,
          code: "agent_not_running",
          error: "Agent is not running and cannot be upgraded right now.",
        },
        409,
      );
    }

    // ── Reattach: an upgrade for this shared agent is already under way. ──
    const existingTarget = await findLiveTierUpgradeTarget(
      user.organization_id,
      agentId,
    );
    if (existingTarget) {
      return await respondToLiveTarget(existingTarget, agentId, user, env);
    }

    // ── Credit gate: N days of dedicated hosting runway, not the bare create
    // minimum. Same canonical 402 body every other gate emits, carrying the
    // stricter threshold so clients render the real number.
    const creditCheck = await checkAgentTierUpgradeCreditGate(
      user.organization_id,
    );
    if (!creditCheck.allowed) {
      return json(
        insufficientCredits402(
          creditCheck,
          "[agent-upgrade-tier] Upgrade blocked: insufficient hosting runway",
          { sharedAgentId: agentId, orgId: user.organization_id },
          { requiredBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE },
        ),
        402,
      );
    }

    // ── Worker health, BEFORE anything durable is minted. The single-flight
    // service commits the target together with its provision job, so a dead
    // worker checked here means nothing gets created at all — no fresh row to
    // roll back, no compensation window. (A worker dying between this check
    // and the commit leaves a valid job the recovering worker picks up.)
    const workerHealth = await checkProvisioningWorkerHealth();
    if (!workerHealth.ok) {
      logger.warn(
        "[agent-upgrade-tier] Upgrade blocked: provisioning worker unavailable",
        {
          sharedAgentId: agentId,
          orgId: user.organization_id,
          code: workerHealth.code,
        },
      );
      return json(
        provisioningWorkerFailureBody(workerHealth),
        workerHealth.status,
      );
    }

    // ── Mint the dedicated migration target, copying identity server-side. ──
    // Reserved platform env keys are stripped from the copy so the new agent
    // gets ITS OWN minted tokens/identity (ELIZA_API_TOKEN, ELIZA_CLOUD_AGENT_ID,
    // PUBLIC_BASE_URL, …) while the user's BYO env — including `enc:v1:`
    // ciphertext, which the storage encryptor passes through untouched and the
    // same-org materialization path decrypts — survives verbatim. Environment
    // preparation, target insert, and provision enqueue all happen inside the
    // service's single-flight boundary.
    const sourceConfig = asConfigRecord(shared.agent_config);
    const sourceEnv = stripReservedEnvKeys(
      asEnvRecord(shared.environment_vars),
    );
    let result: Awaited<
      ReturnType<typeof createTierUpgradeTargetWithProvision>
    >;
    try {
      result = await createTierUpgradeTargetWithProvision({
        sourceAgentId: agentId,
        organizationId: user.organization_id,
        userId: user.id,
        agentName: shared.agent_name ?? agentId,
        ...(shared.character_id ? { characterId: shared.character_id } : {}),
        agentConfig: sourceConfig,
        environmentVars: sourceEnv,
        maxNonTerminalAgents: getMaxNonTerminalAgentsForOrg(
          creditCheck.balance,
        ),
      });
    } catch (error) {
      if (error instanceof AgentQuotaExceededError) {
        logger.warn("[agent-upgrade-tier] Upgrade blocked: org quota", {
          sharedAgentId: agentId,
          orgId: user.organization_id,
          count: error.count,
          max: error.max,
        });
        return json(
          {
            success: false,
            code: "agent_quota_exceeded",
            error: error.message,
            currentAgents: error.count,
            maxAgents: error.max,
          },
          429,
        );
      }
      throw error;
    }

    // Race loser: another request committed the target (and its job) while
    // this one was in flight — reattach to that durable state.
    if (!result.created) {
      return await respondToLiveTarget(result.agent, agentId, user, env);
    }
    const dedicated = result.agent;
    const job = result.job;

    void provisioningJobService.triggerImmediate(env).catch(() => {
      // error-policy:J5 fire-and-forget nudge; the job is persisted and the
      // provisioning cron is the safety net (failure logged in the service).
    });

    logger.info("[agent-upgrade-tier] Upgrade started", {
      sharedAgentId: agentId,
      dedicatedAgentId: dedicated.id,
      orgId: user.organization_id,
      jobId: job.id,
      balance: creditCheck.balance,
    });

    return json(
      {
        success: true,
        created: true,
        message:
          "Dedicated agent created. Provisioning job started — poll the job endpoint, then run the conversation handoff.",
        data: {
          id: dedicated.id,
          agentId: dedicated.id,
          dedicatedAgentId: dedicated.id,
          sharedAgentId: agentId,
          agentName: dedicated.agent_name,
          status: job.status,
          jobId: job.id,
          estimatedCompletionAt: job.estimated_completion_at,
          executionTier: dedicated.execution_tier,
        },
        polling: pollingBody(job.id),
      },
      202,
    );
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, c.env, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
export default __hono_app;
