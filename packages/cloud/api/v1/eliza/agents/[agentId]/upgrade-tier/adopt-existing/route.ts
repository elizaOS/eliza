/**
 * Quotes and explicitly confirms adoption of one existing owned Dedicated row
 * as the personal Eliza migration target. The server selects and binds the
 * target; clients cannot name a row, write markers, or start compute without a
 * target-bound current quote. Shared remains authoritative until the existing
 * cutover route confirms a healthy running target and imports personal state.
 */

import { Hono } from "hono";
import { z } from "zod";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { checkAgentTierUpgradeCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import {
  adoptPersonalDedicatedTargetWithProvision,
  PersonalDedicatedAdoptionError,
  type PersonalDedicatedAdoptionResolution,
  resolvePersonalDedicatedAdoption,
} from "@/lib/services/agent-tier-upgrade-target";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  isPersonalSharedAgentId,
  personalSharedAgentId,
} from "@/lib/services/shared-runtime/personal-shared-agent";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, POST, OPTIONS";
const ADOPTION_QUOTE_VERSION = "personal-dedicated-adoption-v1";

const AdoptionConfirmation = z
  .object({
    action: z.literal("adopt_existing_dedicated"),
    quoteId: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

type AuthedUser = Awaited<
  ReturnType<typeof requireAuthOrApiKeyWithOrg>
>["user"];

type ResolvedAdoption = Extract<
  PersonalDedicatedAdoptionResolution,
  { state: "available" | "adopted" }
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

function resolvePersonalSourceId(
  agentId: string,
  user: AuthedUser,
): string | null {
  if (!isPersonalSharedAgentId(agentId)) return null;
  const expected = personalSharedAgentId({
    userId: user.id,
    organizationId: user.organization_id,
  });
  return agentId === expected ? expected : null;
}

function startsCompute(status: ResolvedAdoption["agent"]["status"]): boolean {
  return status === "error" || status === "stopped" || status === "sleeping";
}

async function quoteIdFor(params: {
  organizationId: string;
  userId: string;
  sourceAgentId: string;
  targetId: string;
  targetStatus: ResolvedAdoption["agent"]["status"];
  lifecycleRevision: number;
  balance: number;
}): Promise<string> {
  const input = [
    ADOPTION_QUOTE_VERSION,
    params.organizationId,
    params.userId,
    params.sourceAgentId,
    params.targetId,
    params.targetStatus,
    params.lifecycleRevision.toString(10),
    params.balance.toFixed(6),
    AGENT_PRICING.RUNNING_HOURLY_RATE.toFixed(6),
    AGENT_PRICING.DAILY_RUNNING_COST.toFixed(6),
    AGENT_PRICING.UPGRADE_MINIMUM_BALANCE.toFixed(6),
    AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS.toString(10),
  ].join(":");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function adoptionQuote(
  sourceAgentId: string,
  user: AuthedUser,
  resolution: ResolvedAdoption,
) {
  const credit = await checkAgentTierUpgradeCreditGate(user.organization_id);
  const target = resolution.agent;
  const willStartCompute = startsCompute(target.status);
  const minimumBalanceUsd = AGENT_PRICING.UPGRADE_MINIMUM_BALANCE;
  const deficitUsd = Math.max(
    0,
    Math.round((minimumBalanceUsd - credit.balance) * 100) / 100,
  );
  return {
    quoteId: await quoteIdFor({
      organizationId: user.organization_id,
      userId: user.id,
      sourceAgentId,
      targetId: target.id,
      targetStatus: target.status,
      lifecycleRevision: target.lifecycle_revision,
      balance: credit.balance,
    }),
    quoteVersion: ADOPTION_QUOTE_VERSION,
    sourceAgentId,
    dedicatedAgentId: target.id,
    currentMode: "shared" as const,
    targetMode: "dedicated" as const,
    status: target.status,
    adoptionState: resolution.state,
    startsCompute: willStartCompute,
    hourlyRateUsd: AGENT_PRICING.RUNNING_HOURLY_RATE,
    dailyRateUsd: AGENT_PRICING.DAILY_RUNNING_COST,
    minimumBalanceUsd,
    minimumRunwayDays: AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS,
    balanceUsd: credit.balance,
    deficitUsd,
    canAdopt: !willStartCompute || credit.allowed,
    requiresConfirmation: true,
    action: "adopt_existing_dedicated" as const,
    ...(!credit.allowed && willStartCompute && credit.error
      ? { unavailableReason: credit.error }
      : {}),
  };
}

function resolutionError(
  resolution: PersonalDedicatedAdoptionResolution,
): Response | null {
  if (resolution.state === "unavailable") {
    return json(
      {
        success: false,
        code: "dedicated_adoption_unavailable",
        error: "Agent not found",
      },
      404,
    );
  }
  if (resolution.state === "ambiguous") {
    return json(
      {
        success: false,
        code: "dedicated_adoption_ambiguous",
        error:
          "More than one existing Dedicated agent is eligible. Resolve the inventory before adopting; no agent was changed.",
      },
      409,
    );
  }
  return null;
}

function adoptionServiceError(error: PersonalDedicatedAdoptionError): Response {
  const code =
    error.code === "PERSONAL_DEDICATED_ADOPTION_AMBIGUOUS"
      ? "dedicated_adoption_ambiguous"
      : error.code === "PERSONAL_DEDICATED_ADOPTION_UNAVAILABLE"
        ? "dedicated_adoption_unavailable"
        : "dedicated_adoption_quote_changed";
  return json(
    {
      success: false,
      code,
      error:
        code === "dedicated_adoption_quote_changed"
          ? "The existing Dedicated agent changed after quoting. Review the current quote and confirm again."
          : error.message,
    },
    409,
  );
}

async function resolveForOwner(sourceAgentId: string, user: AuthedUser) {
  return resolvePersonalDedicatedAdoption({
    organizationId: user.organization_id,
    userId: user.id,
    sourceAgentId,
  });
}

async function __hono_GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;
    const sourceAgentId = resolvePersonalSourceId(agentId, user);
    if (!sourceAgentId) {
      return json({ success: false, error: "Agent not found" }, 404);
    }

    const resolution = await resolveForOwner(sourceAgentId, user);
    const invalid = resolutionError(resolution);
    if (invalid) return invalid;
    return json({
      success: true,
      data: await adoptionQuote(
        sourceAgentId,
        user,
        resolution as ResolvedAdoption,
      ),
    });
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
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
    const sourceAgentId = resolvePersonalSourceId(agentId, user);
    if (!sourceAgentId) {
      return json({ success: false, error: "Agent not found" }, 404);
    }

    let rawConfirmation: unknown;
    try {
      rawConfirmation = await request.json();
    } catch {
      // error-policy:J3 malformed JSON is explicitly invalid confirmation.
      rawConfirmation = null;
    }
    const confirmation = AdoptionConfirmation.safeParse(rawConfirmation);
    if (!confirmation.success) {
      return json(
        {
          success: false,
          code: "dedicated_adoption_confirmation_required",
          error:
            "Review the current same-agent Dedicated quote and explicitly confirm adoption before any compute starts.",
        },
        400,
      );
    }

    const resolution = await resolveForOwner(sourceAgentId, user);
    const invalid = resolutionError(resolution);
    if (invalid) return invalid;
    const resolved = resolution as ResolvedAdoption;
    const quote = await adoptionQuote(sourceAgentId, user, resolved);
    if (confirmation.data.quoteId !== quote.quoteId) {
      return json(
        {
          success: false,
          code: "dedicated_adoption_quote_changed",
          error:
            "The existing Dedicated agent or billing quote changed. Review the current quote and confirm again.",
          data: quote,
        },
        409,
      );
    }

    if (quote.startsCompute && !quote.canAdopt) {
      const credit = await checkAgentTierUpgradeCreditGate(
        user.organization_id,
      );
      return json(
        insufficientCredits402(
          credit,
          "[agent-tier-adoption] Adoption blocked: insufficient hosting runway",
          {
            sourceAgentId,
            dedicatedAgentId: resolved.agent.id,
            orgId: user.organization_id,
          },
          { requiredBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE },
        ),
        402,
      );
    }

    if (quote.startsCompute) {
      const workerHealth = await checkProvisioningWorkerHealth();
      if (!workerHealth.ok) {
        logger.warn(
          "[agent-tier-adoption] Adoption blocked: provisioning worker unavailable",
          {
            sourceAgentId,
            dedicatedAgentId: resolved.agent.id,
            orgId: user.organization_id,
            code: workerHealth.code,
          },
        );
        return json(
          provisioningWorkerFailureBody(workerHealth),
          workerHealth.status,
        );
      }
    }

    let result: Awaited<
      ReturnType<typeof adoptPersonalDedicatedTargetWithProvision>
    >;
    try {
      result = await adoptPersonalDedicatedTargetWithProvision({
        organizationId: user.organization_id,
        userId: user.id,
        sourceAgentId,
        expectedTargetId: resolved.agent.id,
        expectedLifecycleRevision: resolved.agent.lifecycle_revision,
        expectedStatus: resolved.agent.status,
        expectedBalance: quote.balanceUsd,
        expectedHourlyRate: quote.hourlyRateUsd,
        expectedDailyRate: quote.dailyRateUsd,
        expectedMinimumBalance: quote.minimumBalanceUsd,
        expectedMinimumRunwayDays: quote.minimumRunwayDays,
      });
    } catch (error) {
      if (error instanceof PersonalDedicatedAdoptionError) {
        return adoptionServiceError(error);
      }
      throw error;
    }

    if (result.jobCreated) {
      void provisioningJobService.triggerImmediate(env).catch(() => {
        // error-policy:J5 the durable job remains observable by the worker poll.
      });
    }

    logger.info("[agent-tier-adoption] Existing Dedicated target adopted", {
      sourceAgentId,
      dedicatedAgentId: result.agent.id,
      orgId: user.organization_id,
      alreadyAdopted: result.alreadyAdopted,
      jobId: result.job?.id ?? null,
      startsCompute: quote.startsCompute,
    });

    const response = {
      success: true,
      created: false,
      alreadyAdopted: result.alreadyAdopted,
      message: result.job
        ? "Existing Dedicated agent adopted. Poll the same-id provisioning job, then run personal cutover."
        : "Existing running Dedicated agent adopted. Run personal cutover to make it authoritative.",
      data: {
        dedicatedAgentId: result.agent.id,
        sharedAgentId: sourceAgentId,
        status: result.job?.status ?? result.agent.status,
        executionTier: result.agent.execution_tier,
        runtime: "dedicated_pending_cutover" as const,
        ...(result.job
          ? {
              jobId: result.job.id,
              estimatedCompletionAt: result.job.estimated_completion_at,
            }
          : {}),
      },
      ...(result.job ? { polling: pollingBody(result.job.id) } : {}),
    };
    return json(response, result.job ? 202 : 200);
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const app = new Hono<AppEnv>();
app.options("/", () => handleCorsOptions(CORS_METHODS));
app.get("/", async (c) =>
  __hono_GET(c.req.raw, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
app.post("/", async (c) =>
  __hono_POST(c.req.raw, c.env, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);

export default app;
