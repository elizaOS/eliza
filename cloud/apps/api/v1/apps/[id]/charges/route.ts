/**
 * App charge requests.
 *
 * POST creates a reusable charge request for an app/agent. The payer later
 * checks out through Stripe or OxaPay and receives app credits; creator
 * earnings are credited through the existing app-credit earnings ledger.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { appChargeRequestsService } from "@/lib/services/app-charge-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ProviderSchema = z.enum(["stripe", "oxapay"]);
const CreateChargeSchema = z.object({
  amount: z.number().min(1).max(10000),
  description: z.string().max(500).optional(),
  providers: z.array(ProviderSchema).min(1).max(2).optional(),
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
  lifetime_seconds: z.number().int().min(60).max(30 * 24 * 60 * 60).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const appId = c.req.param("id");
    if (!appId) return c.json({ success: false, error: "Missing app id" }, 400);

    const body = await c.req.json().catch(() => null);
    const parsed = CreateChargeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: "Invalid request", details: parsed.error.issues },
        400,
      );
    }

    const charge = await appChargeRequestsService.create({
      appId,
      creatorUserId: user.id,
      creatorOrganizationId: user.organization_id,
      amountUsd: parsed.data.amount,
      description: parsed.data.description,
      providers: parsed.data.providers,
      successUrl: parsed.data.success_url,
      cancelUrl: parsed.data.cancel_url,
      lifetimeSeconds: parsed.data.lifetime_seconds,
      metadata: parsed.data.metadata,
    });

    return c.json({ success: true, charge });
  } catch (error) {
    logger.error("[AppCharges API] Failed to create charge request", { error });
    return failureResponse(c, error);
  }
});

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const appId = c.req.param("id");
    if (!appId) return c.json({ success: false, error: "Missing app id" }, 400);

    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
    const charges = await appChargeRequestsService.listForApp(
      appId,
      user.organization_id,
      Number.isFinite(limit) ? limit : 50,
    );

    return c.json({ success: true, charges });
  } catch (error) {
    logger.error("[AppCharges API] Failed to list charge requests", { error });
    return failureResponse(c, error);
  }
});

export default app;
