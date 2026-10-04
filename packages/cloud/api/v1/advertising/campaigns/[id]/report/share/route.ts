/**
 * POST /api/v1/advertising/campaigns/[id]/report/share — create a public report token.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { advertisingService } from "@elizaos/cloud-shared/lib/services/advertising";
import { decodeOptionalRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const MAX_SHARE_TTL_HOURS = 24 * 90;

const ShareBodySchema = z
  .object({
    expiresAt: z.string().datetime().optional(),
    expiresInHours: z
      .number()
      .int()
      .positive()
      .max(MAX_SHARE_TTL_HOURS)
      .optional(),
  })
  .refine((data) => !(data.expiresAt && data.expiresInHours), {
    message: "Provide either expiresAt or expiresInHours, not both",
  });

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const decodedBody = await decodeOptionalRequestJson(c.req);
    if (!decodedBody.ok) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = ShareBodySchema.safeParse(decodedBody.value);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid share request", details: parsed.error.flatten() },
        400,
      );
    }

    const expiresAt = parsed.data.expiresAt
      ? new Date(parsed.data.expiresAt)
      : new Date(
          Date.now() + (parsed.data.expiresInHours ?? 24 * 7) * 60 * 60 * 1000,
        );

    const share = await advertisingService.createCampaignReportShare({
      campaignId: id,
      organizationId: user.organization_id,
      userId: user.id,
      expiresAt,
    });
    const publicUrl = new URL(share.publicPath, c.req.url).toString();

    return c.json(
      {
        success: true,
        share: {
          id: share.id,
          campaignId: share.campaignId,
          token: share.token,
          publicPath: share.publicPath,
          publicUrl,
          expiresAt: share.expiresAt,
        },
      },
      201,
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
