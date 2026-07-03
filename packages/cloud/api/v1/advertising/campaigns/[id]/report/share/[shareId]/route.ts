/**
 * DELETE /api/v1/advertising/campaigns/[id]/report/share/[shareId] — revoke a report token.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const shareId = c.req.param("shareId")!;
    const result = await advertisingService.revokeCampaignReportShare(
      shareId,
      user.organization_id,
    );
    return c.json({ success: true, share: result });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
