import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { pressReleaseService } from "@/lib/services/press-releases";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  pressReleaseErrorStatus,
  resolveNewswireProvider,
} from "../../_shared";

const app = new Hono<AppEnv>();

// Submit a ready press release for distribution.
//
// Fail-closed: no newswire provider is wired yet (choosing one is the #11362
// human dependency), so this endpoint verifies ownership + readiness and then
// returns 503 rather than fake a distribution. It never claims success without
// a real provider actually accepting the release. When a provider is configured
// (`NEWSWIRE_PROVIDER`), this is where `pressReleaseService.recordSubmission` +
// the provider call attach — a separate slice (#11362 child).
app.post("/", async (c) => {
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
    if (!["ready", "submitted"].includes(release.status)) {
      const error = "Press release is not ready for submission";
      return c.json({ success: false, error }, pressReleaseErrorStatus(error));
    }

    const provider = resolveNewswireProvider(c.env);
    if (!provider) {
      logger.warn(
        "[MarketingPR] Submit blocked — no newswire provider configured",
        { releaseId: release.id, organizationId: user.organization_id },
      );
      return c.json(
        {
          success: false,
          error:
            "Press distribution is not available yet: no newswire provider is configured. The release stays ready and can be submitted once distribution is enabled.",
          status: "provider_unavailable",
        },
        503,
      );
    }

    // Unreachable until a provider is wired; the provider-backed submission
    // (recordSubmission + external call) lands with that slice, not here.
    return c.json(
      {
        success: false,
        error: "Press distribution provider is configured but not yet wired.",
        status: "provider_unavailable",
      },
      503,
    );
  } catch (error) {
    logger.error("[MarketingPR] Failed to submit press release:", error);
    return failureResponse(c, error);
  }
});

app.all("*", (c) =>
  c.json({ success: false, error: "Method not allowed" }, 405),
);

export default app;
