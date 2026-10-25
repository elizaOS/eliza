/**
 * Accepts authenticated DM turns from an organization's agent-role X account
 * and routes the verified sender to personal Shared or Dedicated Eliza.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  failureResponse,
  jsonError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { findOrCreateXPersonalAccount } from "@elizaos/cloud-shared/lib/services/eliza-app/x-personal-identity";
import { deliverPersonalTextMessage } from "@elizaos/cloud-shared/lib/services/personal-message-delivery";
import { resolveSharedRuntimeWorkerRequestContext } from "@elizaos/cloud-shared/lib/services/shared-runtime/resolve-shared-agent";
import { twitterAutomationService } from "@elizaos/cloud-shared/lib/services/twitter-automation";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const inputSchema = z.object({
  recipientTwitterUserId: z
    .string()
    .trim()
    .regex(/^\d{1,20}$/),
  senderTwitterUserId: z
    .string()
    .trim()
    .regex(/^\d{1,20}$/),
  senderUsername: z.string().trim().min(1).max(64).optional(),
  displayName: z.string().trim().min(1).max(128).optional(),
  dmEventId: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(10_000),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const authenticated = await requireUserOrApiKeyWithOrg(c);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      // error-policy:J3 the connector payload is untrusted JSON.
      return jsonError(c, 400, "Invalid X DM delivery", "validation_error");
    }
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError(c, 400, "Invalid X DM delivery", "validation_error");
    }
    const connection =
      await twitterAutomationService.getStoredConnectionIdentity(
        authenticated.organization_id,
        "agent",
      );
    if (
      !connection.twitterUserId ||
      connection.twitterUserId !== parsed.data.recipientTwitterUserId
    ) {
      return jsonError(
        c,
        403,
        "The authenticated organization does not own this agent-role X identity",
        "access_denied",
      );
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
    const account = await findOrCreateXPersonalAccount({
      twitterUserId: parsed.data.senderTwitterUserId,
      username: parsed.data.senderUsername,
      displayName: parsed.data.displayName,
    });
    const result = await deliverPersonalTextMessage({
      account,
      message: parsed.data.message,
      messageId: `x-dm:${parsed.data.dmEventId}`,
      platform: "x",
      senderName:
        parsed.data.displayName ??
        parsed.data.senderUsername ??
        parsed.data.senderTwitterUserId,
      env: c.env,
      executionCtx: worker.executionCtx,
      namespace: worker.namespace,
    });
    if (!result.success) {
      return c.json(
        result,
        result.status,
        result.retryAfterSeconds
          ? { "Retry-After": String(result.retryAfterSeconds) }
          : undefined,
      );
    }
    return c.json({ success: true, data: result });
  } catch (error) {
    // error-policy:J1 the authenticated connector boundary returns one structured failure.
    return failureResponse(c, error);
  }
});

export default app;
