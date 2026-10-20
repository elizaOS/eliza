/**
 * GET /api/v1/models
 * Lists available AI models in OpenAI-compatible format. Public — auth probe
 * is best-effort, never makes the catalog read fail closed.
 */

import { getCurrentUser } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { isLegacyMiniMaxTextModel } from "@elizaos/cloud-shared/lib/models";
import {
  getAiProviderConfigurationError,
  hasAnyAiProviderConfigured,
} from "@elizaos/cloud-shared/lib/providers/language-model";
import { getCachedMergedModelCatalog } from "@elizaos/cloud-shared/lib/services/model-catalog";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    // Resolve optional identity for request telemetry and first-session user sync.
    // The catalog remains public when identity resolution is unavailable.
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

    const data = (await getCachedMergedModelCatalog()).filter(
      (model) => !isLegacyMiniMaxTextModel(model),
    );
    // A cached pre-Flash catalog can put M3 before the new static Flash row.
    const flashIndex = data.findIndex(
      (model) => model.id === "minimax/minimax-m3.1-flash:free",
    );
    const m3Index = data.findIndex(
      (model) => model.id === "minimax/minimax-m3",
    );
    if (m3Index >= 0 && flashIndex > m3Index) {
      [data[m3Index], data[flashIndex]] = [data[flashIndex], data[m3Index]];
    }
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
