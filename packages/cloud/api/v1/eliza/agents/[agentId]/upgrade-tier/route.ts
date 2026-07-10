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
 *    live migration target (the `__agentUpgradedFrom` marker): a retry or a
 *    second tab must resume the SAME upgrade, never mint a second container.
 */

import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { getMaxNonTerminalAgentsForOrg } from "@/lib/constants/agent-sandbox-quota";
import { checkAgentTierUpgradeCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import {
  AGENT_UPGRADED_FROM_KEY,
  readUpgradedFromAgentId,
} from "@/lib/services/eliza-agent-config";
import { prepareManagedElizaEnvironment } from "@/lib/services/eliza-managed-launch";
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

/** Statuses under which an existing migration target still owns the upgrade. */
const LIVE_TARGET_STATUSES = new Set([
  "pending",
  "provisioning",
  "running",
  "stopped",
  "sleeping",
]);

type AgentRow = NonNullable<
  Awaited<ReturnType<typeof elizaSandboxService.getAgentForWrite>>
>;

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
 * The org's live migration target for this shared agent, if one exists.
 * Best-effort dedup for the realistic retry cases (double-click, client retry,
 * reload mid-provision); a sub-second concurrent race can still double-mint,
 * bounded by the per-org agent quota the create enforces.
 */
async function findLiveUpgradeTarget(
  organizationId: string,
  sharedAgentId: string,
): Promise<AgentRow | null> {
  const agents =
    await agentSandboxesRepository.listByOrganization(organizationId);
  return (
    agents.find(
      (agent) =>
        agent.id !== sharedAgentId &&
        // The marker alone is not proof of a migration target: agent_config is
        // PATCHable, so a marker planted on a non-dedicated row must never be
        // reattached to — only a dedicated-always row can own the upgrade.
        agent.execution_tier === "dedicated-always" &&
        LIVE_TARGET_STATUSES.has(agent.status) &&
        readUpgradedFromAgentId(asConfigRecord(agent.agent_config)) ===
          sharedAgentId,
    ) ?? null
  );
}

/**
 * Run the post-create span and delete the just-minted target if any step
 * throws, so an error between the insert and the provision-job enqueue never
 * leaves a `pending` row no worker will ever claim (same rationale as the
 * create route's orphan cleanup; the cleanup-stuck-provisioning cron is the
 * safety net for rows that slip through).
 */
async function withUpgradeOrphanCleanup<T>(
  dedicatedAgentId: string,
  organizationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    try {
      await agentSandboxesRepository.delete(dedicatedAgentId, organizationId);
      logger.info(
        "[agent-upgrade-tier] Cleaned up migration target after create→enqueue failure",
        { agentId: dedicatedAgentId, orgId: organizationId },
      );
    } catch (cleanupErr) {
      // error-policy:J6 best-effort teardown of the just-created row; the
      // original failure below is what the caller must see.
      logger.error(
        "[agent-upgrade-tier] Failed to clean up migration target after create→enqueue failure",
        {
          agentId: dedicatedAgentId,
          orgId: organizationId,
          error:
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr),
        },
      );
    }
    throw err;
  }
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
    // No credit gate here — nothing new is minted, and blocking the reattach
    // would strand a user whose balance dipped AFTER the (gated) mint while
    // the container is already provisioned/billing. Ongoing solvency is owned
    // by the billing cron + low-credit shutdown, not this route.
    const existingTarget = await findLiveUpgradeTarget(
      user.organization_id,
      agentId,
    );
    if (existingTarget) {
      logger.info("[agent-upgrade-tier] Reattaching to in-flight upgrade", {
        sharedAgentId: agentId,
        dedicatedAgentId: existingTarget.id,
        orgId: user.organization_id,
        status: existingTarget.status,
      });
      if (existingTarget.status === "running") {
        return json({
          success: true,
          created: false,
          alreadyInProgress: true,
          data: {
            id: existingTarget.id,
            agentId: existingTarget.id,
            dedicatedAgentId: existingTarget.id,
            sharedAgentId: agentId,
            agentName: existingTarget.agent_name,
            status: existingTarget.status,
            executionTier: existingTarget.execution_tier,
          },
        });
      }
      // pending/provisioning (or stopped/sleeping after an interrupted boot):
      // hand back the active provision job — enqueue reuses an in-flight job
      // and only mints a new one when the previous attempt died.
      const reattach = await provisioningJobService.enqueueAgentProvisionOnce({
        agentId: existingTarget.id,
        organizationId: user.organization_id,
        userId: user.id,
        agentName: existingTarget.agent_name ?? existingTarget.id,
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
            id: existingTarget.id,
            agentId: existingTarget.id,
            dedicatedAgentId: existingTarget.id,
            sharedAgentId: agentId,
            agentName: existingTarget.agent_name,
            status: reattach.job.status,
            jobId: reattach.job.id,
            estimatedCompletionAt: reattach.job.estimated_completion_at,
            executionTier: existingTarget.execution_tier,
          },
          polling: pollingBody(reattach.job.id),
        },
        202,
      );
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

    // ── Mint the dedicated migration target, copying identity server-side. ──
    // Reserved platform env keys are stripped from the copy so the new agent
    // gets ITS OWN minted tokens/identity (ELIZA_API_TOKEN, ELIZA_CLOUD_AGENT_ID,
    // PUBLIC_BASE_URL, …) while the user's BYO env — including `enc:v1:`
    // ciphertext, which the storage encryptor passes through untouched and the
    // same-org materialization path decrypts — survives verbatim.
    const sourceConfig = asConfigRecord(shared.agent_config);
    const sourceEnv = stripReservedEnvKeys(
      asEnvRecord(shared.environment_vars),
    );
    let created: Awaited<ReturnType<typeof elizaSandboxService.createAgent>>;
    try {
      created = await elizaSandboxService.createAgent({
        organizationId: user.organization_id,
        userId: user.id,
        agentName: shared.agent_name ?? agentId,
        ...(shared.character_id ? { characterId: shared.character_id } : {}),
        agentConfig: sourceConfig,
        environmentVars: sourceEnv,
        executionTier: "dedicated-always",
        // The shared source is itself a live non-terminal agent — the reuse
        // guard would hand it straight back, so the migration target must be a
        // forced fresh record, bounded by the balance-tiered org quota.
        reuseExistingNonTerminal: false,
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
    const dedicated = created.agent;

    return await withUpgradeOrphanCleanup(
      dedicated.id,
      user.organization_id,
      async () => {
        // Persist the upgrade marker FIRST so a crash after this point still
        // leaves a reattachable target (the marker is what retries key on).
        // buildAgentInsertData strips the reserved `__agent` namespace from
        // caller config, so the marker must be written post-create.
        await agentSandboxesRepository.update(dedicated.id, {
          agent_config: {
            ...asConfigRecord(dedicated.agent_config),
            [AGENT_UPGRADED_FROM_KEY]: agentId,
          },
        });

        const managedEnvironment = await prepareManagedElizaEnvironment({
          existingEnv: sourceEnv,
          organizationId: user.organization_id,
          userId: user.id,
          agentSandboxId: dedicated.id,
        });
        if (managedEnvironment.changed) {
          await elizaSandboxService.updateAgentEnvironment(
            dedicated.id,
            user.organization_id,
            managedEnvironment.environmentVars,
          );
        }

        // Only the cold provisioning job needs a live worker; check at the
        // enqueue boundary. A dead worker rolls the fresh row back explicitly
        // (returning is success to the cleanup wrapper) so the org is not left
        // holding an unclaimable `pending` target. The warm-pool fast path is
        // intentionally skipped: upgrades are not latency-critical and always
        // take the async job path.
        const workerHealth = await checkProvisioningWorkerHealth();
        if (!workerHealth.ok) {
          await agentSandboxesRepository.delete(
            dedicated.id,
            user.organization_id,
          );
          logger.warn(
            "[agent-upgrade-tier] Upgrade blocked: provisioning worker unavailable",
            {
              sharedAgentId: agentId,
              dedicatedAgentId: dedicated.id,
              orgId: user.organization_id,
              code: workerHealth.code,
            },
          );
          return json(
            provisioningWorkerFailureBody(workerHealth),
            workerHealth.status,
          );
        }

        const job = await provisioningJobService.enqueueAgentProvision({
          agentId: dedicated.id,
          organizationId: user.organization_id,
          userId: user.id,
          agentName: dedicated.agent_name ?? dedicated.id,
        });

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
      },
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
