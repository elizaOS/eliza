/**
 * GET /api/v1/agents/[agentId]/logs
 *
 * Service-to-service: enqueue an `agent_logs` job. The orchestrator
 * daemon SSH-runs `docker logs --tail N <container>` on the assigned
 * core and persists the captured output to `jobs.result`. Caller polls
 * `/api/v1/jobs/<id>` for the logs once `status === "completed"`.
 *
 * Previously this route called `fetch(bridge_url + "/logs")` directly
 * from the Worker, which returned empty for any non-running container
 * (the bridge HTTP endpoint is gone when the agent is stopped or
 * crashed). The daemon path works for stopped + crashed agents too.
 *
 * Auth: X-Service-Key header.
 *
 * Query params:
 *   tail - number of log lines to return (default 100, max 5000)
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const identity = await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";

    const agent = await elizaSandboxService.getAgent(
      agentId,
      identity.organizationId,
    );
    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const rawTail = parseInt(c.req.query("tail") ?? "100", 10);
    const tail = Math.max(
      1,
      Math.min(Number.isFinite(rawTail) ? rawTail : 100, 5000),
    );

    const enqueueResult = await provisioningJobService.enqueueAgentLogsOnce({
      agentId,
      organizationId: identity.organizationId,
      userId: identity.userId,
      tail,
    });

    void provisioningJobService.triggerImmediate(c.env).catch(() => {
      // Logged inside the service.
    });

    logger.info("[service-api] Logs job enqueued", {
      agentId,
      tail,
      jobId: enqueueResult.job.id,
      created: enqueueResult.created,
    });

    return c.json(
      {
        success: true,
        created: enqueueResult.created,
        alreadyInProgress: !enqueueResult.created,
        data: {
          agentId,
          jobId: enqueueResult.job.id,
          status: enqueueResult.job.status,
          tail,
          agentStatus: agent.status,
        },
        polling: {
          endpoint: `/api/v1/jobs/${enqueueResult.job.id}`,
          intervalMs: 2_000,
          expectedDurationMs: 15_000,
        },
      },
      202,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
