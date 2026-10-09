/**
 * Ad inventory slot detail (#10687).
 *
 * GET    /api/v1/marketing/inventory/:slotId  — fetch a slot
 * PATCH  /api/v1/marketing/inventory/:slotId  — update name/status/floorCpm
 * DELETE /api/v1/marketing/inventory/:slotId  — delete the slot
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { adInventoryService } from "@elizaos/cloud-shared/lib/services/ad-inventory";
import { mintAdTagToken } from "@elizaos/cloud-shared/lib/services/ad-tag-token";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const UpdateSlotSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.enum(["active", "paused"]).optional(),
  floorCpm: z.number().positive().max(1000).optional(),
});

async function loadOwnedSlot(c: AppContext) {
  const user = await requireUserOrApiKeyWithOrg(c);
  const slotId = c.req.param("slotId");
  if (!slotId)
    return { error: c.json({ success: false, error: "Missing slot id" }, 400) };
  const slot = await adInventoryService.getSlot(slotId);
  if (!slot)
    return { error: c.json({ success: false, error: "Slot not found" }, 404) };
  if (slot.organization_id !== user.organization_id) {
    return { error: c.json({ success: false, error: "Access denied" }, 403) };
  }
  return { slot };
}

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const { slot, error } = await loadOwnedSlot(c);
    if (error) return error;
    // The signed capability the public serve endpoint requires. Null when
    // ELIZA_AD_TAG_SECRET is unconfigured (serving is then disabled).
    const adTagToken = await mintAdTagToken({
      slotId: slot.id,
      appId: slot.app_id,
    });
    return c.json({ success: true, slot, adTagToken });
  } catch (error) {
    logger.error("[Ad Inventory API] get failed:", error);
    return failureResponse(c, error);
  }
});

app.patch("/", async (c) => {
  try {
    const { slot, error } = await loadOwnedSlot(c);
    if (error) return error;
    const parsed = UpdateSlotSchema.safeParse(
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
    const updated = await adInventoryService.updateSlot(slot.id, parsed.data);
    return c.json({ success: true, slot: updated });
  } catch (error) {
    logger.error("[Ad Inventory API] update failed:", error);
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const { slot, error } = await loadOwnedSlot(c);
    if (error) return error;
    await adInventoryService.deleteSlot(slot.id);
    return c.json({ success: true });
  } catch (error) {
    logger.error("[Ad Inventory API] delete failed:", error);
    return failureResponse(c, error);
  }
});

export default app;
