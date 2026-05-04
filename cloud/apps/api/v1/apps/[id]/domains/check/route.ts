/**
 * POST /api/v1/apps/:id/domains/check
 *
 * Dry-run availability + price quote for buying a domain via cloudflare.
 * Does NOT debit credits or call the cloudflare register endpoint.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appsService } from "@/lib/services/apps";
import { cloudflareRegistrarService } from "@/lib/services/cloudflare-registrar";
import { computeDomainPrice } from "@/lib/services/domain-pricing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CheckSchema = z.object({
  domain: z
    .string()
    .min(4)
    .max(253)
    .regex(/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i, "Invalid domain format")
    .transform((d) => d.toLowerCase().trim()),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const appId = c.req.param("id");
    if (!appId) return c.json({ success: false, error: "Missing app id" }, 400);

    const appRow = await appsService.getById(appId);
    if (!appRow || appRow.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "App not found" }, 404);
    }

    const parsed = CheckSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "invalid input" },
        400,
      );
    }
    const { domain } = parsed.data;

    const availability = await cloudflareRegistrarService.checkAvailability(domain);
    if (!availability.available) {
      return c.json({ success: true, domain, available: false });
    }
    const price = computeDomainPrice(availability.priceUsdCents);
    return c.json({
      success: true,
      domain,
      available: true,
      currency: availability.currency,
      years: availability.years,
      price: {
        wholesaleUsdCents: price.wholesaleUsdCents,
        marginUsdCents: price.marginUsdCents,
        totalUsdCents: price.totalUsdCents,
        marginBps: price.marginBps,
      },
    });
  } catch (error) {
    logger.warn("[Domains Check] availability check failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
