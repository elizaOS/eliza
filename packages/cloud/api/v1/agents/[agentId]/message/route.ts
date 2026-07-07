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
 * Auth: X-Service-Key (WAIFU_SERVICE_KEY) — same as provision. The service
 * key authorizes the caller, but the message job is owned by the agent's
 * persisted org/user so wallet-owned agents are reachable and billed to the
 * actual owner.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { logger } from "@/lib/utils/logger";
import { notifyAgentReply } from "@/lib/web-push";
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

function getWaitUntil(
  c: AppContext,
): ((promise: Promise<unknown>) => void) | undefined {
  try {
    const executionCtx = c.executionCtx;
    if (typeof executionCtx?.waitUntil !== "function") return undefined;
    return executionCtx.waitUntil.bind(executionCtx);
  } catch {
    // error-policy:J4 Hono local/test contexts omit ExecutionContext; push remains a non-fatal side effect.
    return undefined;
  }
}

async function __hono_POST(c: AppContext) {
  try {
    await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";
    const body = await c.req.json().catch(() => {
      // error-policy:J3 malformed JSON is invalid input for this request body.
      return null;
    });

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

    // Resolve by id, then attribute the daemon job to the actual agent owner.
    const agent = await elizaSandboxService.getAgentById(agentId);
    if (!agent) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const { job } = await provisioningJobService.enqueueAgentMessage({
      agentId,
      organizationId: agent.organization_id,
      userId: agent.user_id,
      text,
      ...(userId ? { senderId: userId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(roomId ? { roomId } : {}),
    });

    void provisioningJobService.triggerImmediate(c.env).catch(() => {
      // error-policy:J5 fire-and-forget provisioning kick; the rejection is observed and logged inside provisioningJobService.
    });

    // Poll the job row for the daemon-delivered reply.
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const current = await provisioningJobService.getJobForOrg(
        job.id,
        agent.organization_id,
      );
      if (!current) continue;

      if (current.status === "completed") {
        const result = (current.result ?? {}) as Record<string, unknown>;
        const replyText = typeof result.text === "string" ? result.text : "";

        // Agent-reply → Web Push: if the patron has installed the PWA and has
        // no live foreground client, surface the reply as a push. Never throws —
        // a push failure must not break the reply; the notify service no-ops
        // when VAPID isn't configured. Keyed to the sending user (subscription
        // owner) + this agent. Registered with `executionCtx.waitUntil` so the
        // Cloudflare Worker keeps the send + dead-subscription prune alive AFTER
        // the chat response returns (a bare fire-and-forget can be dropped when
        // the Worker finishes the request — the exact path this feature needs).
        if (userId && replyText) {
          const pushWork = notifyAgentReply(
            {
              userId,
              agentId,
              replyText,
              title: agent.agent_name ?? "New message",
              ...(sessionId ? { conversationId: sessionId } : {}),
            },
            { env: c.env },
          ).catch(() => {
            // error-policy:J5 non-fatal; notify-service already logs internally.
          });
          const waitUntil = getWaitUntil(c);
          if (waitUntil) {
            waitUntil(pushWork);
          } else {
            void pushWork;
          }
        }

        const reason =
          typeof result.reason === "string" ? result.reason : undefined;
        // Flatten so callers reading top-level `text` work directly.
        return c.json({
          success: true,
          text: replyText,
          ...(reason ? { reason } : {}),
          jobId: job.id,
        });
      }

      if (current.status === "failed") {
        const result = (current.result ?? {}) as Record<string, unknown>;
        const errMsg =
          typeof result.error === "string"
            ? result.error
            : "agent message failed";
        logger.warn("[agents/message] job failed", {
          agentId,
          jobId: job.id,
          error: errMsg,
        });
        return c.json({ success: false, error: errMsg, jobId: job.id }, 502);
      }
    }

    // Timed out waiting for the daemon. The job may still complete; caller can
    // retry. Return 504 so waifu-core surfaces a transient failure.
    logger.warn("[agents/message] timed out waiting for reply", {
      agentId,
      jobId: job.id,
    });
    return c.json(
      {
        success: false,
        error: "Timed out waiting for agent reply",
        jobId: job.id,
      },
      504,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", (c) => __hono_POST(c));
export default __hono_app;
