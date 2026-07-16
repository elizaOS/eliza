/**
 * GET /api/v1/models
 * Lists available AI models in OpenAI-compatible format. Public — auth probe
 * is best-effort, never makes the catalog read fail closed.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getCurrentUser } from "@/lib/auth/workers-hono-auth";
import {
  getAiProviderConfigurationError,
  hasAnyAiProviderConfigured,
} from "@/lib/providers/language-model";
import { getCachedMergedModelCatalog } from "@/lib/services/model-catalog";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    // Probe auth/session — failure here must not turn a catalog read into 500.
    await getCurrentUser(c).catch(() => null);

    if (!hasAnyAiProviderConfigured()) {
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          error: {
            message: getAiProviderConfigurationError(),
            type: "service_unavailable",
          },
        },
        503,
      );
    }

    const data = await getCachedMergedModelCatalog();
    c.header(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=7200",
    );
    return c.json({
      object: "list",
      data,
    });
  } catch (error) {
    // error-policy:J1 route boundary — every catch in v1/models/* translates a thrown error into a structured HTTP failure via failureResponse (never a fabricated 200/empty catalog).
    logger.error("Error fetching models:", error);
    c.header("Cache-Control", "no-store");
    return failureResponse(c, error);
  }
});

export default app;
