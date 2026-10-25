/**
 * GET /api/v1/documents/check
 *
 * Lightweight endpoint to check if an agent has documents.
 * Direct DB query — no runtime spin-up.
 */

import { requireUserOrApiKey } from "@elizaos/cloud-shared/auth";
import { memoriesRepository } from "@elizaos/cloud-shared/db/repositories/agents/memories";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
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
