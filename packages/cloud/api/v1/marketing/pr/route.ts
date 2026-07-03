import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { pressReleaseService } from "@/lib/services/press-releases";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { createReleaseSchema, pressReleaseErrorStatus } from "./_shared";

const app = new Hono<AppEnv>();

// List press releases for the caller's organization.
app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const releases = await pressReleaseService.listReleases(
      user.organization_id,
    );
    return c.json({ success: true, releases });
  } catch (error) {
    logger.error("[MarketingPR] Failed to list press releases:", error);
    return failureResponse(c, error);
  }
});

// Create a draft press release.
app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = createReleaseSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request data",
          details: parsed.error.format(),
        },
        400,
      );
    }
    const d = parsed.data;
    const result = await pressReleaseService.createRelease({
      organizationId: user.organization_id,
      userId: user.id,
      title: d.title,
      body: d.body,
      summary: d.summary,
      boilerplate: d.boilerplate,
      targetAudience: d.targetAudience,
      targetRegions: d.targetRegions,
      assets: d.assets,
      embargoAt: d.embargoAt ? new Date(d.embargoAt) : undefined,
      idempotencyKey: d.idempotencyKey,
      metadata: d.metadata,
    });
    if (!result.ok || !result.release) {
      const error = result.error ?? "Failed to create press release";
      return c.json({ success: false, error }, pressReleaseErrorStatus(error));
    }
    return c.json({ success: true, release: result.release }, 201);
  } catch (error) {
    logger.error("[MarketingPR] Failed to create press release:", error);
    return failureResponse(c, error);
  }
});

app.all("*", (c) =>
  c.json({ success: false, error: "Method not allowed" }, 405),
);

export default app;
