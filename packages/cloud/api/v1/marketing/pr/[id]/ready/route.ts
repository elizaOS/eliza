import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { pressReleaseService } from "@/lib/services/press-releases";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { pressReleaseErrorStatus } from "../../_shared";

const app = new Hono<AppEnv>();

// Move a draft press release to `ready` (validated + submittable).
app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Missing press release id" }, 400);
    }
    const result = await pressReleaseService.markReady(
      id,
      user.organization_id,
    );
    if (!result.ok || !result.release) {
      const error = result.error ?? "Failed to mark press release ready";
      return c.json({ success: false, error }, pressReleaseErrorStatus(error));
    }
    return c.json({ success: true, release: result.release });
  } catch (error) {
    logger.error("[MarketingPR] Failed to mark press release ready:", error);
    return failureResponse(c, error);
  }
});

app.all("*", (c) =>
  c.json({ success: false, error: "Method not allowed" }, 405),
);

export default app;
