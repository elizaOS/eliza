/**
 * DELETE /api/v1/advertising/campaigns/[id]/report/share/[shareId] — revoke a report token.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { advertisingService } from "@elizaos/cloud-shared/lib/services/advertising";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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
