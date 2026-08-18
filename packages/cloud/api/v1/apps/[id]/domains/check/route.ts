/**
 * POST /api/v1/apps/:id/domains/check
 *
 * Dry-run availability + price quote for buying a domain via cloudflare.
 * Does NOT debit credits or call the cloudflare register endpoint.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { cloudflareRegistrarService } from "@/lib/services/cloudflare-registrar";
import { computeDomainPrice } from "@/lib/services/domain-pricing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { loadOwnedApp } from "../guards";
import { domainBodySchema as CheckSchema } from "../schemas";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const ctx = await loadOwnedApp(c);
    if ("error" in ctx)
      return c.json({ success: false, error: ctx.error }, ctx.status);

    const parsed = CheckSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "invalid input",
        },
        400,
      );
    }
    const { domain } = parsed.data;

    const availability =
      await cloudflareRegistrarService.checkAvailability(domain);
    if (!availability.available) {
      return c.json({ success: true, domain, available: false });
    }
    const price = computeDomainPrice(availability.priceUsdCents);
    const renewal = computeDomainPrice(
      availability.renewalUsdCents ?? availability.priceUsdCents,
    );
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
      // Annual renewal price the org will be re-charged for by the renewal cron.
      renewal: {
        totalUsdCents: renewal.totalUsdCents,
      },
    });
  } catch (error) {
    logger.warn("[Domains Check] availability check failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
