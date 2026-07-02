/**
 * GET  /api/v1/advertising/campaigns/[id]/attribution — signed tracking token + install snippets.
 * POST /api/v1/advertising/campaigns/[id]/attribution — create a stored UTM URL.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import { CreateAttributionLinkSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

function trackingUrl(origin: string, token: string) {
  const url = new URL("/api/v1/advertising/conversions/track", origin);
  url.searchParams.set("token", token);
  return url.toString();
}

function webhookUrl(origin: string) {
  return new URL("/api/v1/advertising/conversions/track", origin).toString();
}

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const attribution = await advertisingService.getAttributionToken(
      id,
      user.organization_id,
    );
    const origin = new URL(c.req.url).origin;
    const pixelEndpoint = trackingUrl(origin, attribution.token);
    const webhookEndpoint = webhookUrl(origin);

    return c.json({
      success: true,
      campaignId: attribution.campaignId,
      appId: attribution.appId,
      token: attribution.token,
      pixelEndpoint,
      webhookEndpoint,
      endpoints: {
        pixel: pixelEndpoint,
        webhook: webhookEndpoint,
      },
      install: {
        pixelHtml:
          `<img src="${pixelEndpoint}&eventType=conversion&dedupeKey=ORDER_OR_EVENT_ID"` +
          ` width="1" height="1" style="display:none" alt="" />`,
        webhook: {
          method: "POST",
          url: webhookEndpoint,
          body: {
            token: attribution.token,
            eventType: "purchase",
            dedupeKey: "ORDER_OR_EVENT_ID",
            value: 0,
            currency: "USD",
          },
        },
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const body = await c.req.json();
    const parsed = CreateAttributionLinkSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        400,
      );
    }

    const link = await advertisingService.createAttributionLink({
      campaignId: id,
      organizationId: user.organization_id,
      destinationUrl: parsed.data.destinationUrl,
      creativeId: parsed.data.creativeId,
      source: parsed.data.source,
      medium: parsed.data.medium,
      content: parsed.data.content,
      term: parsed.data.term,
    });

    logger.info("[Advertising API] Attribution link created", {
      campaignId: id,
      attributionLinkId: link.id,
    });

    return c.json({ link }, 201);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
