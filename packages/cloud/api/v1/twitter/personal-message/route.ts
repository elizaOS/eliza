/**
 * Accepts DM turns from the platform X DM router and routes the sender to
 * personal Shared or Dedicated Eliza. The sender id comes from the request
 * body and is trusted only because the caller's organization is listed in
 * X_PERSONAL_DM_ROUTER_ORG_IDS; every other caller gets 403 before any lookup.
 * The reply is returned to the router, which sends it as the DM.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  failureResponse,
  jsonError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  type RateLimitConfig,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  findOrCreateXPersonalAccount,
  isXPersonalDmRouterOrg,
} from "@elizaos/cloud-shared/lib/services/eliza-app/x-personal-identity";
import { deliverPersonalTextMessage } from "@elizaos/cloud-shared/lib/services/personal-message-delivery";
import { resolveSharedRuntimeWorkerRequestContext } from "@elizaos/cloud-shared/lib/services/shared-runtime/resolve-shared-agent";
import { twitterAutomationService } from "@elizaos/cloud-shared/lib/services/twitter-automation";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { type Context, Hono } from "hono";
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

/** Per router organization, so one leaked router key cannot spray sender ids. */
const ROUTER_ORG_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 300,
  redisUnavailableFallback: { namespace: "x-personal-message" },
};

/** Admits one delivery against the router organization's bucket, or answers 429/503. */
async function admitRouterDelivery(
  c: Context<AppEnv>,
  organizationId: string,
): Promise<Response | null> {
  let admitted = false;
  const limiter = rateLimit({
    ...ROUTER_ORG_LIMIT,
    keyGenerator: () => `x-personal-message:org:${organizationId}`,
  });
  const blocked = await limiter(c, async () => {
    admitted = true;
  });
  if (admitted) return null;
  return (
    blocked ??
    jsonError(c, 503, "Rate limiter unavailable", "service_unavailable")
  );
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const authenticated = await requireUserOrApiKeyWithOrg(c);
    if (!isXPersonalDmRouterOrg(c.env ?? {}, authenticated.organization_id)) {
      return jsonError(
        c,
        403,
        "Only the platform X DM router can deliver personal messages",
        "access_denied",
      );
    }
    const limited = await admitRouterDelivery(c, authenticated.organization_id);
    if (limited) return limited;
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
