// Handles v1 cloud API v1 documents query route traffic with route-local auth expectations.

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import {
  listDocumentRecords,
  resolveDocumentScope,
  scoreDocumentText,
} from "../_worker-documents";

interface DocumentQueryBody {
  query?: string;
  limit?: number;
  characterId?: string;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = (await c.req
      .json()
      .catch(() => null)) as DocumentQueryBody | null;
    if (!body)
      return c.json(
        { success: false, error: "Request body must be JSON" },
        400,
      );

    const query = body.query?.trim();
    if (!query)
      return c.json({ success: false, error: "query is required" }, 400);

    const scope = await resolveDocumentScope(user, body.characterId);
    if (scope instanceof Response) return scope;

    const limit = Math.min(Math.max(body.limit ?? 5, 1), 25);
    const documents = await listDocumentRecords(scope, 200, 0);
    const results = documents
      .map((doc) => ({
        id: doc.id,
        content: doc.content.text,
        similarity: scoreDocumentText(doc.content.text, query),
        metadata: doc.metadata,
      }))
      .filter((result) => result.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    return c.json({
      success: true,
      results,
      total: results.length,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
