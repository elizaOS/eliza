import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { pressReleaseService } from "@/lib/services/press-releases";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { pressReleaseErrorStatus, updateReleaseSchema } from "../_shared";

const app = new Hono<AppEnv>();

// Get a single press release, scoped to the caller's organization.
app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Missing press release id" }, 400);
    }
    const release = await pressReleaseService.getRelease(
      id,
      user.organization_id,
    );
    if (!release) {
      return c.json({ success: false, error: "Press release not found" }, 404);
    }
    return c.json({ success: true, release });
  } catch (error) {
    logger.error("[MarketingPR] Failed to get press release:", error);
    return failureResponse(c, error);
  }
});

// Patch a draft press release. Only draft releases are editable; the service
// enforces that and the not-found/not-editable results map to 404/409.
app.patch("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Missing press release id" }, 400);
    }
    const parsed = updateReleaseSchema.safeParse(await c.req.json());
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
    // Only drafts are editable. Distinguish missing (404) from a wrong-state
    // edit (409) so a caller patching a ready/submitted release gets a precise
    // conflict rather than an ambiguous "not found".
    const existing = await pressReleaseService.getRelease(
      id,
      user.organization_id,
    );
    if (!existing) {
      return c.json({ success: false, error: "Press release not found" }, 404);
    }
    if (existing.status !== "draft") {
      return c.json(
        { success: false, error: "Press release is not editable" },
        409,
      );
    }

    const { embargoAt, ...rest } = parsed.data;
    const patch = {
      ...rest,
      ...(embargoAt !== undefined
        ? { embargoAt: embargoAt === null ? null : new Date(embargoAt) }
        : {}),
    };
    const result = await pressReleaseService.updateDraft(
      id,
      user.organization_id,
      patch,
    );
    if (!result.ok || !result.release) {
      const error = result.error ?? "Failed to update press release";
      return c.json({ success: false, error }, pressReleaseErrorStatus(error));
    }
    return c.json({ success: true, release: result.release });
  } catch (error) {
    logger.error("[MarketingPR] Failed to update press release:", error);
    return failureResponse(c, error);
  }
});

app.all("*", (c) =>
  c.json({ success: false, error: "Method not allowed" }, 405),
);

export default app;
