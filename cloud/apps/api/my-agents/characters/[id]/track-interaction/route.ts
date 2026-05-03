/**
 * POST /api/my-agents/characters/:id/track-interaction
 * Returns 410 — this endpoint went away with the marketplace tracking
 * backend. Kept around so existing clients get a clear "gone" rather than 404.
 */

import { Hono } from "hono";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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
        error: "Character interaction tracking was removed with the marketplace service",
      },
      410,
    );
  } catch {
    return c.json({ success: false, error: "Failed to track interaction" }, 500);
  }
});

export default app;
