/**
 * POST /api/my-agents/characters/:id/track-view
 * Returns 410 — companion to track-interaction; the underlying marketplace
 * counter service was retired.
 */

import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.post("/", (c) => {
  const id = c.req.param("id") ?? "";
  logger.warn("[My Agents API] Rejecting removed track-view route", {
    characterId: id,
  });
  return c.json(
    {
      success: false,
      error: "Character view tracking was removed with the marketplace service",
    },
    410,
  );
});

export default app;
