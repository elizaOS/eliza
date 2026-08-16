// Handles internal cloud API internal discord eliza app messages route traffic with service-to-service auth.
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { agentGatewayRouterService } from "@/lib/services/agent-gateway-router";
import {
  authorizeManagedDiscordGuildVoice,
  runManagedDiscordGuildTextTurn,
} from "@/lib/services/managed-discord-guild-voice";
import { resolveSharedRuntimeWorkerRequestContext } from "@/lib/services/shared-runtime/resolve-shared-agent";
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
      if (result.handled || result.reason !== "not_linked") {
        return c.json(result);
      }

      // An unbound guild belongs to the managed system bot, not a Dedicated
      // agent. Only an already-linked canonical owner may use personal Shared
      // Eliza here, and the public room is isolated from every private channel.
      const identity = await authorizeManagedDiscordGuildVoice(body.sender.id);
      if (!identity.allowed || !identity.userId || !identity.organizationId) {
        return c.json(result);
      }
      const worker = resolveSharedRuntimeWorkerRequestContext(c);
      if ("error" in worker) {
        return c.json(
          {
            success: false,
            error: worker.error,
            code: worker.code,
            retryable: worker.retryable,
          },
          worker.status,
          { "Retry-After": "1" },
        );
      }
      const shared = await runManagedDiscordGuildTextTurn(
        {
          discordUserId: body.sender.id,
          discordUsername: body.sender.username,
          displayName: body.sender.displayName,
          guildId: body.guildId,
          channelId: body.channelId,
          messageId: body.messageId,
          message: body.content,
          userId: identity.userId,
          organizationId: identity.organizationId,
        },
        {
          namespace: worker.namespace,
          executionCtx: worker.executionCtx,
        },
      );
      return c.json({ handled: true, ...shared });
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
