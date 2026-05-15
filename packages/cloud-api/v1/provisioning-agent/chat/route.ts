/**
 * POST /api/v1/provisioning-agent/chat
 *
 * Chat with the serverless provisioning placeholder agent while the user's
 * dedicated container is being set up. Uses Cerebras for ultra-fast inference.
 * Conversation history is stored in Redis per user (TTL 7 days, capped at 20
 * messages). When the container is ready the response includes bridgeUrl so
 * the client can hand off.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, ValidationError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { provisioningAgentChat } from "@/lib/services/provisioning-agent-chat";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const chatBodySchema = z.object({
  message: z.string().min(1).max(4000),
  agentId: z.string().uuid().optional(),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const body = await c.req.json().catch(() => {
      throw ValidationError("Invalid JSON");
    });

    const parsed = chatBodySchema.safeParse(body);
    if (!parsed.success) {
      throw ValidationError("Invalid request data", { issues: parsed.error.issues });
    }

    const result = await provisioningAgentChat(
      user.id,
      user.organization_id,
      parsed.data.message,
      parsed.data.agentId,
    );

    logger.info("[provisioning-agent] chat turn complete", {
      userId: user.id,
      containerStatus: result.containerStatus,
    });

    return c.json({
      success: true,
      data: {
        reply: result.reply,
        containerStatus: result.containerStatus,
        ...(result.bridgeUrl ? { bridgeUrl: result.bridgeUrl } : {}),
        history: result.history,
      },
    });
  } catch (error) {
    logger.error("[provisioning-agent] POST chat error", { error });
    return failureResponse(c, error);
  }
});

export default app;
