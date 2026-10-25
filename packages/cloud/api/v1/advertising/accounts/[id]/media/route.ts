/**
 * POST /api/v1/advertising/accounts/[id]/media — upload/map media into a provider asset library.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { advertisingService } from "@elizaos/cloud-shared/lib/services/advertising";
import { UploadMediaSchema } from "@elizaos/cloud-shared/lib/services/advertising/schemas";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const providerAssetResourceName = c.req
      .query("providerAssetResourceName")
      ?.trim();
    if (!providerAssetResourceName) {
      return c.json(
        {
          error: "Invalid request",
          details: { providerAssetResourceName: ["Required"] },
        },
        400,
      );
    }

    const result = await advertisingService.getMediaStatus(
      user.organization_id,
      id,
      providerAssetResourceName,
    );

    return c.json({
      success: true,
      providerAssetId: result.providerAssetId,
      providerAssetUrl: result.providerAssetUrl,
      providerAssetResourceName: result.providerAssetResourceName,
      status: result.status,
      ready: result.ready,
      metadata: result.metadata,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const parsed = UploadMediaSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        400,
      );
    }

    const result = await advertisingService.uploadMedia(
      user.organization_id,
      id,
      parsed.data,
    );

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
