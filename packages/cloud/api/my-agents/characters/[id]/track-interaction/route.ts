/**
 * POST /api/my-agents/characters/:id/track-interaction
 * Returns 410 — this endpoint went away with the marketplace tracking
 * backend. Kept around so existing clients get a clear "gone" rather than 404.
 */

import { requireUserWithOrg } from "@elizaos/cloud-shared/auth";
import {
  ApiError,
  failureResponse,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    await requireUserWithOrg(c);
    const id = c.req.param("id") ?? "";
    logger.warn("[My Agents API] Rejecting removed track-interaction route", {
      characterId: id,
    });
    return c.json(
      {
        success: false,
        error:
          "Character interaction tracking was removed with the marketplace service",
      },
      410,
    );
  } catch (error) {
    // A rejected credential or inactive account is a typed 401/403, not a
    // server fault; only an authenticated caller reaches the 410 below.
    if (error instanceof ApiError) {
      return failureResponse(c, error);
    }
    return c.json(
      { success: false, error: "Failed to track interaction" },
      500,
    );
  }
});

export default app;
