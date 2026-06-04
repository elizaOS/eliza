/**
 * POST /api/v1/agents/[agentId]/restart
 *
 * Service-to-service: enqueue an `agent_restart` job. The orchestrator
 * daemon SSH-stops the existing container and runs a full `provision()`
 * to recreate it (URLs restored from the fresh sandbox handle). Atomic
 * on the daemon side so concurrent restarts can't interleave.
 *
 * Replaces the Worker-side `shutdown()` + `provision()` sequence which
 * silently no-op'd the stop from CF Workers (no SSH) and could leave
 * the old container running alongside the new one.
 */

import { Hono } from "hono";
import { agentBillingRepository } from "@/db/repositories/agent-billing";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";
    const agent = await elizaSandboxService.getAgentById(agentId);
    if (!agent) throw NotFoundError("Agent not found");

    const creditCheck = await checkAgentCreditGate(agent.organization_id);
    if (!creditCheck.allowed) {
      logger.warn("[service-api] Restart blocked: insufficient credits", {
        agentId,
        orgId: agent.organization_id,
        balance: creditCheck.balance,
        required: AGENT_PRICING.MINIMUM_DEPOSIT,
      });
      return c.json(
        {
          success: false,
          error: creditCheck.error,
          requiredBalance: AGENT_PRICING.MINIMUM_DEPOSIT,
          currentBalance: creditCheck.balance,
        },
        402,
      );
    }

    logger.info("[service-api] Restart requested", { agentId });

    const writableAgent = await elizaSandboxService.getAgentForWrite(
      agentId,
      agent.organization_id,
    );
    if (!writableAgent) {
      throw NotFoundError("Agent not found");
    }

    if (writableAgent.status === "provisioning") {
      return c.json(
        { success: false, error: "Agent provisioning is in progress" },
        409,
      );
    }

    const enqueueResult = await provisioningJobService.enqueueAgentRestartOnce({
      agentId,
      organizationId: agent.organization_id,
      userId: agent.user_id,
    });

    await agentBillingRepository.reactivateSandboxBillingAfterFunding(
      agentId,
      new Date(),
    );

    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
