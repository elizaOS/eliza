/**
 * POST /api/v1/agents/[agentId]/message
 *
 * Service-key-authed SYNCHRONOUS patron chat proxy. waifu-core's
 * ElizaCloudClient.sendAgentMessage posts here with `{ userId, text,
 * sessionId? }` and awaits the reply text.
 *
 * Why a job (not a direct bridge fetch from the worker): the CF edge worker
 * can only fetch standard ports (80/443/8080/8443), but the agent bridge runs
 * on a raw high port. So the worker can't reach the container directly. The
 * daemon (eliza-1) CAN, so we enqueue an `agent_message` job, trigger the
 * daemon immediately, then poll the job row for the reply within a timeout —
 * giving the caller a synchronous response while routing through the only
 * component that can actually reach the bridge. Same pattern as the logs
 * route, but synchronous (we wait for the result instead of returning a 202).
 *
 * Auth: X-Service-Key (WAIFU_SERVICE_KEY) — same as provision. Org/user are
 * mapped from WAIFU_SERVICE_ORG_ID / WAIFU_SERVICE_USER_ID, so a service
 * caller can only chat agents owned by the service org.
 */
import { z } from "zod";
import { Hono } from "hono";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import type { AgentMessageJobResult } from "@/lib/services/provisioning-jobs";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const messageRequestSchema = z.object({
  text: z.string().min(1).max(8000),
  userId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  roomId: z.string().min(1).optional(),
});

// How long to wait for the daemon to deliver the turn + return the reply.
const MAX_WAIT_MS = 75_000;
const POLL_INTERVAL_MS = 1_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function __hono_POST(c: AppContext) {
  try {
    const identity = await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";
    const body = await c.req.json().catch(() => null);

    const parsed = messageRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid message request",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const { text, userId, sessionId, roomId } = parsed.data;

    // Agent must exist under the service org before we enqueue.
    const agent = await elizaSandboxService.getAgent(
      agentId,
      identity.organizationId,
    );
    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const { job } = await provisioningJobService.enqueueAgentMessage({
      agentId,
      organizationId: identity.organizationId,
      userId: identity.userId,
      text,
      ...(userId ? { senderId: userId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(roomId ? { roomId } : {}),
    });

    void provisioningJobService.triggerImmediate(c.env).catch(() => {
      // Logged inside the service.
    });

    // Poll the job row for the daemon-delivered reply.
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const current = await provisioningJobService.getJobForOrg(
        job.id,
        identity.organizationId,
      );
      if (!current) continue;

      if (current.status === "completed") {
        const result = (current.result ?? {}) as AgentMessageJobResult;
        // Flatten so callers reading top-level `text` work directly.
        return c.json({
          success: true,
          text: result.text ?? "",
          ...(result.reason ? { reason: result.reason } : {}),
          jobId: job.id,
        });
      }

      if (current.status === "failed") {
        const result = (current.result ?? {}) as AgentMessageJobResult;
        logger.warn("[agents/message] job failed", {
          agentId,
          jobId: job.id,
          error: result.error,
        });
        return c.json(
          { success: false, error: result.error ?? "agent message failed", jobId: job.id },
          502,
        );
      }
    }

    // Timed out waiting for the daemon. The job may still complete; caller can
    // retry. Return 504 so waifu-core surfaces a transient failure.
    logger.warn("[agents/message] timed out waiting for reply", {
      agentId,
      jobId: job.id,
    });
    return c.json(
      { success: false, error: "Timed out waiting for agent reply", jobId: job.id },
      504,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", (c) => __hono_POST(c));
export default __hono_app;
