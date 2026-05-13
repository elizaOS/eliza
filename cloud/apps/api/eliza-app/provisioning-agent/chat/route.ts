/**
 * POST /api/eliza-app/provisioning-agent/chat
 *
 * Sends a message to the serverless provisioning placeholder agent (Cerebras).
 * Auth: eliza-app session Bearer token.
 */

import { Hono } from "hono";
import { z } from "zod";
import { elizaAppSessionService } from "@/lib/services/eliza-app";
import { provisioningAgentChat } from "@/lib/services/provisioning-agent-chat";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  agentId: z.string().uuid().optional(),
});

app.post("/", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return c.json({ error: "Authorization required", code: "UNAUTHORIZED" }, 401);
  }

  const session = await elizaAppSessionService.validateAuthHeader(authHeader);
  if (!session) {
    return c.json({ error: "Invalid or expired session", code: "INVALID_SESSION" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  try {
    const result = await provisioningAgentChat(
      session.userId,
      session.organizationId,
      parsed.data.message,
      parsed.data.agentId,
    );

    const bridgeUrl = result.bridgeUrl ?? undefined;

    return c.json({
      success: true,
      data: {
        reply: result.reply,
        containerStatus: result.containerStatus,
        ...(bridgeUrl ? { bridgeUrl } : {}),
        agentId: result.agentId,
      },
    });
  } catch (err) {
    logger.error("[eliza-app provisioning-agent/chat] Error", { error: err });
    return c.json({ success: false, error: "Chat failed" }, 500);
  }
});

export default app;
