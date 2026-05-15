/**
 * OAuth intents — collection routes (Wave C).
 *
 * POST  /api/v1/oauth-intents        Create a new oauth intent (authed creator).
 * GET   /api/v1/oauth-intents        List oauth intents for the caller's org.
 *
 * Atomic primitive that pairs with SensitiveRequestDispatchRegistry to deliver
 * the resulting authorization link across channels and with OAuthCallbackBus
 * for the bind/await loop.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getOAuthIntentsService } from "@/lib/services/oauth-intents-default";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ProviderSchema = z.enum(["google", "discord", "linkedin", "linear", "shopify", "calendly"]);
const StatusSchema = z.enum(["pending", "bound", "denied", "expired", "canceled"]);

const CreateOAuthIntentSchema = z.object({
  provider: ProviderSchema,
  scopes: z.array(z.string().min(1).max(256)).max(64),
  expectedIdentityId: z.string().min(1).max(256).optional(),
  stateTokenHash: z.string().min(16).max(512),
  pkceVerifierHash: z.string().min(16).max(512).optional(),
  hostedUrl: z.string().url().optional(),
  callbackUrl: z.string().url().optional(),
  expiresInMs: z
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60 * 1000)
    .optional(),
  agentId: z.string().min(1).max(256).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const ListQuerySchema = z.object({
  status: StatusSchema.optional(),
  provider: ProviderSchema.optional(),
  agentId: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const body = await c.req.json().catch(() => null);
    const parsed = CreateOAuthIntentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: "Invalid request", details: parsed.error.issues },
        400,
      );
    }

    const service = getOAuthIntentsService(c.env);
    const oauthIntent = await service.create({
      organizationId: user.organization_id,
      agentId: parsed.data.agentId,
      provider: parsed.data.provider,
      scopes: parsed.data.scopes,
      expectedIdentityId: parsed.data.expectedIdentityId,
      stateTokenHash: parsed.data.stateTokenHash,
      pkceVerifierHash: parsed.data.pkceVerifierHash,
      hostedUrl: parsed.data.hostedUrl,
      callbackUrl: parsed.data.callbackUrl,
      expiresInMs: parsed.data.expiresInMs,
      metadata: parsed.data.metadata,
    });

    return c.json({ success: true, oauthIntent });
  } catch (error) {
    logger.error("[OAuthIntents API] Failed to create oauth intent", { error });
    return failureResponse(c, error);
  }
});

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const parsed = ListQuerySchema.safeParse({
      status: c.req.query("status"),
      provider: c.req.query("provider"),
      agentId: c.req.query("agentId"),
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    if (!parsed.success) {
      return c.json({ success: false, error: "Invalid query", details: parsed.error.issues }, 400);
    }

    const service = getOAuthIntentsService(c.env);
    const oauthIntents = await service.list(user.organization_id, {
      status: parsed.data.status,
      provider: parsed.data.provider,
      agentId: parsed.data.agentId,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    return c.json({ success: true, oauthIntents });
  } catch (error) {
    logger.error("[OAuthIntents API] Failed to list oauth intents", { error });
    return failureResponse(c, error);
  }
});

export default app;
