/** POST /api/v1/marketing/pr/:releaseId/submit - paid/provider-backed distribution gate (#11819). */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  configuredPressProvider,
  invalidRequest,
  loadPressReleaseForOrg,
} from "../../common";

const SubmitSchema = z.object({
  confirmPaidDistribution: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(255).optional(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const { release, error } = await loadPressReleaseForOrg(c);
    if (error) return error;
    const parsed = SubmitSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return invalidRequest(c, parsed.error.flatten());

    if (parsed.data.confirmPaidDistribution !== true) {
      return c.json(
        {
          success: false,
          error:
            "Press release distribution may incur provider charges and requires explicit confirmation.",
          code: "confirmation_required",
          confirmationRequired: true,
        },
        409,
      );
    }

    if (release.status === "draft") {
      return c.json(
        {
          success: false,
          error: "Press release must be marked ready before submission",
          code: "release_not_ready",
        },
        409,
      );
    }
    if (!["ready", "submitted"].includes(release.status)) {
      return c.json(
        {
          success: false,
          error: "Press release cannot be submitted from its current state",
          code: "invalid_release_state",
        },
        409,
      );
    }

    const provider = configuredPressProvider(c);
    if (!provider) {
      return c.json(
        {
          success: false,
          error:
            "No PR distribution provider is configured. No distribution was submitted and no charge was attempted.",
          code: "no_provider_configured",
        },
        503,
      );
    }

    return c.json(
      {
        success: false,
        error:
          "PR distribution provider execution is not implemented yet. No distribution was submitted and no charge was attempted.",
        code: "provider_not_implemented",
        provider,
      },
      501,
    );
  } catch (error) {
    logger.error("[Press Release API] submit failed:", error);
    return failureResponse(c, error);
  }
});

export default app;
