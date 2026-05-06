/**
 * GET/POST /api/compat/agents — thin-client compat layer.
 *
 * Auth precedence:
 *   1. X-Service-Key (eliza-cloud S2S)
 *   2. Service JWT (waifu-core bridge)
 *   3. Standard Steward / API-key auth
 *
 * Response shape uses `envelope(...)` to remain compatible with both
 * AgentClient and the dashboard. CORS handled globally.
 */

import { Hono } from "hono";
import { z } from "zod";
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  envelope,
  errorEnvelope,
  toCompatAgent,
  toCompatCreateResult,
} from "@/lib/api/compat-envelope";
import { validateServiceKey } from "@/lib/auth/service-key-hono-worker";
import { authenticateWaifuBridge } from "@/lib/auth/waifu-bridge";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { stripReservedElizaConfigKeys } from "@/lib/services/eliza-agent-config";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

interface CompatAuthResult {
  user: {
    id: string;
    organization_id: string;
  };
  authMethod: "service_key" | "service_jwt" | "standard";
}

async function requireCompatAuth(c: AppContext): Promise<CompatAuthResult> {
  // 1. X-Service-Key (eliza-cloud S2S)
  const serviceKeyHeader = c.req.header("X-Service-Key") || c.req.header("x-service-key");
  if (serviceKeyHeader) {
    const identity = await validateServiceKey(c);
    if (!identity) {
      throw new ApiError(401, "authentication_required", "Invalid service key");
    }
    return {
      user: { id: identity.userId, organization_id: identity.organizationId },
      authMethod: "service_key",
    };
  }

  // 2. Service JWT (waifu-core bridge). The helper reads headers off a Fetch
  // Request — Hono's `c.req.raw` IS a Fetch Request.
  const bridge = await authenticateWaifuBridge(c.req.raw);
  if (bridge) {
    return {
      user: {
        id: bridge.user.id,
        organization_id: bridge.user.organization_id,
      },
      authMethod: "service_jwt",
    };
  }

  // 3. Standard Steward / API-key auth.
  const user = await requireUserOrApiKeyWithOrg(c);
  return {
    user: { id: user.id, organization_id: user.organization_id },
    authMethod: "standard",
  };
}

const createAgentSchema = z.object({
  agentName: z.string().min(1).max(100),
  agentConfig: z.record(z.string(), z.unknown()).optional(),
  environmentVars: z.record(z.string(), z.string()).optional(),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const { user } = await requireCompatAuth(c);
    const agents = await elizaSandboxService.listAgents(user.organization_id);
    return c.json(envelope(agents.map((a) => toCompatAgent(a))));
  } catch (err) {
    if (err instanceof ApiError) {
      return c.json(errorEnvelope(err.message), err.status as 400);
    }
    if (err instanceof Error) {
      logger.error("[compat/agents] GET error", { error: err.message });
    }
    return failureResponse(c, err);
  }
});

app.post("/", async (c) => {
  try {
    const { user } = await requireCompatAuth(c);
    const body = await c.req.json();

    const parsed = createAgentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request data",
          details: parsed.error.issues,
        },
        400,
      );
    }

    // Strip reserved __agent* keys from user-supplied agentConfig to prevent
    // callers from spoofing internal lifecycle flags.
    const sanitizedConfig = stripReservedElizaConfigKeys(parsed.data.agentConfig);
    const autoProvision =
      (c.env as { WAIFU_AUTO_PROVISION?: string }).WAIFU_AUTO_PROVISION === "true";

    if (autoProvision) {
      const workerHealth = await checkProvisioningWorkerHealth();
      if (!workerHealth.ok) {
        logger.warn("[compat] Agent creation blocked: provisioning worker unavailable", {
          orgId: user.organization_id,
          code: workerHealth.code,
        });
        return c.json(provisioningWorkerFailureBody(workerHealth), workerHealth.status);
      }
    }

    let agent = await elizaSandboxService.createAgent({
      organizationId: user.organization_id,
      userId: user.id,
      agentName: parsed.data.agentName,
      agentConfig: sanitizedConfig,
      environmentVars: parsed.data.environmentVars,
    });

    logger.info("[compat] Agent created", {
      agentId: agent.id,
      orgId: user.organization_id,
    });

    let provisioningJobId: string | undefined;
    if (autoProvision) {
      try {
        const { job } = await provisioningJobService.enqueueAgentProvisionOnce({
          agentId: agent.id,
          organizationId: user.organization_id,
          userId: user.id,
          agentName: agent.agent_name ?? agent.id,
          expectedUpdatedAt: agent.updated_at,
        });
        provisioningJobId = job.id;
      } catch (provErr) {
        logger.error("[compat] Auto-provision failed", {
          agentId: agent.id,
          error: provErr instanceof Error ? provErr.message : String(provErr),
        });
        return c.json(
          {
            success: false,
            code: "PROVISIONING_ENQUEUE_FAILED",
            error: "Agent was created, but provisioning could not be started. Retry provisioning.",
            retryable: true,
            data: toCompatCreateResult(agent),
          },
          503,
        );
      }
    }

    const data = toCompatCreateResult(agent);
    const responseBody = provisioningJobId
      ? {
          ...envelope(data),
          provisioningJobId,
          polling: {
            endpoint: `/api/compat/jobs/${agent.id}`,
            intervalMs: 5000,
            expectedDurationMs: 90000,
          },
        }
      : envelope(data);

    return c.json(responseBody, autoProvision ? 202 : 201);
  } catch (err) {
    if (err instanceof ApiError) {
      return c.json(errorEnvelope(err.message), err.status as 400);
    }
    if (err instanceof Error) {
      logger.error("[compat/agents] POST error", { error: err.message });
    }
    return failureResponse(c, err);
  }
});

export default app;
