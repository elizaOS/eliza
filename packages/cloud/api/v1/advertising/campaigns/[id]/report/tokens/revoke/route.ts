/**
 * POST /api/v1/advertising/campaigns/[id]/report/tokens/revoke — revoke a public report token.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import type { AppEnv } from "@/types/cloud-worker-env";

const RevokeTokenSchema = z.object({
  tokenId: z.string().min(1),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const body = await c.req.json();
    const parsed = RevokeTokenSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        400,
      );
    }

    await advertisingService.revokeCampaignReportToken(
      id,
      user.organization_id,
      parsed.data.tokenId,
    );

    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
