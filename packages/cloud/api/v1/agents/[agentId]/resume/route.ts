/**
 * POST /api/v1/agents/[agentId]/resume
 *
 * Service-to-service: re-provision a stopped/suspended agent.
 * Auth: X-Service-Key header.
 */

import { Hono } from "hono";
import { agentBillingRepository } from "@/db/repositories/agent-billing";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";
    const agent = await elizaSandboxService.getAgentById(agentId);
    if (!agent) throw NotFoundError("Agent not found");

    const creditCheck = await checkAgentCreditGate(agent.organization_id);
    if (!creditCheck.allowed) {
      logger.warn("[service-api] Resume blocked: insufficient credits", {
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

    logger.info("[service-api] Resuming agent", { agentId });

    const result = await elizaSandboxService.provision(
      agentId,
      agent.organization_id,
    );
    if (!result.success) {
      const status =
        result.error === "Agent not found"
          ? 404
          : result.error === "Agent is already being provisioned"
            ? 409
            : 500;
      return c.json(
        {
          success: false,
          status: result.sandboxRecord?.status ?? "error",
          error: result.error,
        },
        status,
      );
    }

    await agentBillingRepository.reactivateSandboxBillingAfterFunding(
      agentId,
      new Date(),
    );

    return c.json({
      success: true,
      status: result.sandboxRecord.status,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
