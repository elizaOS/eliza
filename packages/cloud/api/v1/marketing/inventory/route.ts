/**
 * Ad inventory (SSP) — publisher slot management (#10687).
 *
 * GET  /api/v1/marketing/inventory        — list the org's ad slots
 * POST /api/v1/marketing/inventory        — create a slot on one of the org's apps
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { adInventoryService } from "@/lib/services/ad-inventory";
import { mintAdTagToken } from "@/lib/services/ad-tag-token";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CreateSlotSchema = z.object({
  appId: z.string().uuid(),
  name: z.string().min(1).max(100),
  format: z.enum(["banner", "native", "interstitial", "feed"]),
  floorCpm: z.number().positive().max(1000).optional(),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const slots = await adInventoryService.listSlots(user.organization_id);
    return c.json({ success: true, slots });
  } catch (error) {
    logger.error("[Ad Inventory API] list failed:", error);
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = CreateSlotSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request",
          details: parsed.error.flatten(),
        },
        400,
      );
    }

    const foundApp = await appsService.getById(parsed.data.appId);
    if (!foundApp)
      return c.json({ success: false, error: "App not found" }, 404);
    if (foundApp.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const slot = await adInventoryService.createSlot({
      appId: parsed.data.appId,
      organizationId: user.organization_id,
      name: parsed.data.name,
      format: parsed.data.format,
      // Default = the minimum billable floor (the advertiser debit is whole
      // cents, so a slot only fills at a CPM of at least $10).
      floorCpm: parsed.data.floorCpm ?? 10,
    });
    logger.info("[Ad Inventory API] created slot", {
      slotId: slot.id,
      appId: slot.app_id,
    });
    // The signed capability the public serve endpoint requires. Null when
    // ELIZA_AD_TAG_SECRET is unconfigured (serving is then disabled).
    const adTagToken = await mintAdTagToken({
      slotId: slot.id,
      appId: slot.app_id,
    });
    return c.json({ success: true, slot, adTagToken }, 201);
  } catch (error) {
    logger.error("[Ad Inventory API] create failed:", error);
    return failureResponse(c, error);
  }
});

export default app;
