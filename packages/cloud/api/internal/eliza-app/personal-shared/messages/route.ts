/** Runs a trusted Telegram delivery through one rowless personal Shared turn. */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { elizaAppUserService } from "@/lib/services/eliza-app";
import { personalSharedAgent } from "@/lib/services/shared-runtime/personal-shared-agent";
import { resolveSharedRuntimeWorkerRequestContext } from "@/lib/services/shared-runtime/resolve-shared-agent";
import { sharedRestMessageSend } from "@/lib/services/shared-runtime/shared-rest-adapter";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";

const telegramMessageSchema = z.object({
  platform: z.literal("telegram"),
  telegramUserId: z
    .string()
    .trim()
    .regex(/^\d{1,20}$/),
  telegramUsername: z.string().trim().min(1).max(64).optional(),
  displayName: z.string().trim().min(1).max(128).optional(),
  messageId: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(4000),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;
    if (
      auth.service !== "webhook-gateway" &&
      auth.service !== "shared-secret"
    ) {
      return jsonError(c, 403, "Forbidden", "access_denied");
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      // error-policy:J3 malformed provider input is explicitly invalid.
      return jsonError(c, 400, "Invalid Telegram message", "validation_error");
    }
    const parsed = telegramMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError(c, 400, "Invalid Telegram message", "validation_error");
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

    const account = await elizaAppUserService.findOrCreateByTelegram({
      telegramId: parsed.data.telegramUserId,
      username: parsed.data.telegramUsername,
      displayName: parsed.data.displayName,
    });
    const agent = personalSharedAgent({
      userId: account.user.id,
      organizationId: account.organization.id,
    });
    const result = await sharedRestMessageSend(
      agent,
      agent.id,
      parsed.data.message,
      agent.agent_name ?? "Eliza",
      worker.executionCtx,
      worker.namespace,
      parsed.data.messageId,
      "platform",
    );

    return c.json({
      success: true,
      data: {
        identity: { id: agent.id, runtime: "shared" as const },
        account: {
          userId: account.user.id,
          organizationId: account.organization.id,
        },
        reply: result.text,
      },
    });
  } catch (error) {
    // error-policy:J1 the internal HTTP boundary emits one structured failure.
    return failureResponse(c, error);
  }
});

export default app;
