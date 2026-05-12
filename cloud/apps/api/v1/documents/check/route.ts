/**
 * GET /api/v1/documents/check
 *
 * Lightweight endpoint to check if an agent has documents.
 * Direct DB query — no runtime spin-up.
 */

import { Hono } from "hono";
import { memoriesRepository } from "@/db/repositories/agents/memories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKey } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";
import { resolveDocumentScope } from "../_worker-documents";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKey(c);

    const characterId = c.req.query("characterId");
    const scope = await resolveDocumentScope(user, characterId);
    if (scope instanceof Response) return scope;

    const documentCount = await memoriesRepository.countByType(
      scope.agentId,
      "documents",
      scope.roomId,
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
