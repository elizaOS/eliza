/**
 * POST /api/v1/advertising/accounts/[id]/media — upload/map media into a provider asset library.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import { UploadMediaSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const parsed = UploadMediaSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
    }

    const result = await advertisingService.uploadMedia(user.organization_id, id, parsed.data);

    logger.info("[Advertising API] Media uploaded", {
      adAccountId: id,
      type: parsed.data.type,
      providerAssetId: result.providerAssetId,
    });

    return c.json({
      success: true,
      providerAssetId: result.providerAssetId,
      providerAssetUrl: result.providerAssetUrl,
      providerAssetResourceName: result.providerAssetResourceName,
      metadata: result.metadata,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
