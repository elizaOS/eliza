// Handles internal cloud API internal discord eliza app messages route traffic with service-to-service auth.
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { agentGatewayRouterService } from "@/lib/services/agent-gateway-router";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";
import personalSharedMessagesApp from "../../../eliza-app/personal-shared/messages/route";

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
    if (body.guildId) {
      const result = await agentGatewayRouterService.routeDiscordMessage({
        guildId: body.guildId,
        channelId: body.channelId,
        messageId: body.messageId,
        content: body.content,
        sender: body.sender,
      });
      return c.json(result);
    }

    const response = await personalSharedMessagesApp.request(
      "/",
      {
        method: "POST",
        headers: {
          authorization: c.req.header("authorization") ?? "",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          platform: "discord",
          discordUserId: body.sender.id,
          discordUsername: body.sender.username,
          displayName: body.sender.displayName,
          avatarUrl: body.sender.avatar,
          messageId: `discord:${body.messageId}`,
          message: body.content,
        }),
      },
      c.env,
      c.executionCtx,
    );
    const payload = (await response.json()) as {
      success?: boolean;
      error?: string;
      code?: string;
      data?: {
        identity: { id: string };
        account: { userId: string; organizationId: string };
        reply: string;
      };
    };
    if (!response.ok || !payload.success || !payload.data) {
      return c.json(
        payload,
        response.status as 400 | 401 | 402 | 403 | 500 | 503,
      );
    }
    return c.json({
      handled: true,
      replyText: payload.data.reply,
      agentId: payload.data.identity.id,
      roomId: payload.data.identity.id,
      userId: payload.data.account.userId,
      organizationId: payload.data.account.organizationId,
    });
  } catch (err) {
    logger.error("[internal/discord/eliza-app/messages]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
