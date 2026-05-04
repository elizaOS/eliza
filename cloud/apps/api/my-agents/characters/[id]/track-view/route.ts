/**
 * POST /api/my-agents/characters/:id/track-view
 * Returns 410 — companion to track-interaction; the underlying marketplace
 * counter service was retired.
 */

import { Hono } from "hono";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", (c) => {
  const id = c.req.param("id") ?? "";
  logger.warn("[My Agents API] Rejecting removed track-view route", { characterId: id });
  return c.json(
    {
      success: false,
      error: "Character view tracking was removed with the marketplace service",
    },
    410,
  );
});

export default app;
