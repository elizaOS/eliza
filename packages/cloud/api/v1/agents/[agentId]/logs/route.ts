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

const DEFAULT_TAIL = 100;
const MAX_TAIL = 5000;
const CANONICAL_POSITIVE_INTEGER = /^[1-9]\d*$/;

function parseTail(rawTail: string | undefined): number | null {
  if (rawTail === undefined) {
    return DEFAULT_TAIL;
  }
  if (!CANONICAL_POSITIVE_INTEGER.test(rawTail)) {
    return null;
  }

  const tail = Number(rawTail);
  return Number.isSafeInteger(tail) && tail <= MAX_TAIL ? tail : null;
}

app.get("/", async (c) => {
  try {
    await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";
    const agent = await elizaSandboxService.getAgentById(agentId);

    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const tail = parseTail(c.req.query("tail"));
    if (tail === null) {
      // error-policy:J3 reject malformed request input instead of coercing or clamping it.
      return c.json(
        {
          success: false,
          error: `tail must be a whole number between 1 and ${MAX_TAIL}`,
        },
        400,
      );
    }

    const enqueueResult = await provisioningJobService.enqueueAgentLogsOnce({
      agentId,
      organizationId: agent.organization_id,
      userId: agent.user_id,
      tail,
    });

    void provisioningJobService.triggerImmediate(c.env).catch(() => {
      // error-policy:J5 fire-and-forget provisioning kick; the rejection is observed and logged inside provisioningJobService.
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
