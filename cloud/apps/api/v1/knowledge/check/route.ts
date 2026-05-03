/**
 * GET /api/v1/knowledge/check
 *
 * Lightweight endpoint to check if an agent has knowledge documents.
 * Direct DB query — no runtime spin-up.
 */

import { Hono } from "hono";
import { memoriesRepository } from "@/db/repositories/agents/memories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKey } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    await requireUserOrApiKey(c);

    const characterId = c.req.query("characterId");
    if (!characterId) {
      return c.json({ error: "characterId is required" }, 400);
    }

    const documentCount = await memoriesRepository.countByType(
      characterId,
      "documents",
      characterId,
    );

    return c.json({
      hasDocuments: documentCount > 0,
      count: documentCount,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
