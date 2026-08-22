/**
 * POST /api/v1/agents/[agentId]/resume
 *
 * Service-to-service: re-provision a stopped/suspended agent.
 * Auth: X-Service-Key header.
 */

import { Hono } from "hono";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { isContainerBackedExecutionTier } from "@/lib/services/sandbox-provider-types";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";
    const agent = await elizaSandboxService.getAgentById(agentId);
    if (!agent) throw NotFoundError("Agent not found");
    if (!isContainerBackedExecutionTier(agent.execution_tier)) {
      return c.json(
        {
          success: false,
          status: agent.status,
          error:
            "Sandbox provisioning requires an explicit container-backed execution tier",
        },
        500,
      );
    }

    const creditCheck = await checkAgentCreditGate(agent.organization_id);
    if (!creditCheck.allowed) {
      return c.json(
        insufficientCredits402(
          creditCheck,
          "[service-api] Resume blocked: insufficient credits",
          { agentId, orgId: agent.organization_id },
        ),
        402,
      );
    }

    logger.info("[service-api] Resuming agent", { agentId });

    const result = await elizaSandboxService.executeResume(
      agentId,
      agent.organization_id,
    );
    if (!result.success) {
      const authoritativeAgent = result.reprovisioned
        ? await elizaSandboxService.getAgentForWrite(
            agentId,
            agent.organization_id,
          )
        : null;
      const status =
        result.error === "Agent not found"
          ? 404
          : result.error ===
              "Insufficient credits to settle accrued agent compute charges"
            ? 402
            : result.error === "Agent is already being provisioned"
              ? 409
              : 500;
      return c.json(
        {
          success: false,
          status: authoritativeAgent?.status ?? agent.status,
          error: result.error,
        },
        status,
      );
    }

    return c.json({
      success: true,
      status: "running",
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
