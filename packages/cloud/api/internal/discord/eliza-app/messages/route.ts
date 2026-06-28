import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { agentGatewayRouterService } from "@/lib/services/agent-gateway-router";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";

const messageSchema = z.object({
  guildId: z.string().trim().min(1).optional(),
  channelId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  content: z.string(),
  sender: z.object({
    id: z.string().trim().min(1),
    username: z.string().trim().min(1),
    displayName: z.string().trim().min(1).optional(),
    avatar: z.string().url().nullable().optional(),
  }),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    const body = messageSchema.parse(await c.req.json());
    const result = await agentGatewayRouterService.routeDiscordMessage({
      guildId: body.guildId,
      channelId: body.channelId,
      messageId: body.messageId,
      content: body.content,
      sender: body.sender,
    });
    return c.json(result);
  } catch (err) {
    logger.error("[internal/discord/eliza-app/messages]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
