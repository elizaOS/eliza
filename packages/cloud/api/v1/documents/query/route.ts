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
  resolveDocumentScope,
  scanDocumentRecords,
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
    // Every document in the scope is scored: the match is decided here, not
    // by the repository, so a newest-first page would hide older documents.
    // Only the best `limit` matches are kept while the pages stream past.
    type Match = {
      id: string;
      content: string;
      similarity: number;
      metadata: unknown;
    };
    const best: Match[] = [];
    let total = 0;
    for await (const page of scanDocumentRecords(scope)) {
      for (const doc of page) {
        const similarity = scoreDocumentText(doc.content.text, query);
        if (similarity <= 0) continue;
        total += 1;
        // Insert after every equal score: ties keep the newest-first scan
        // order, as the stable sort over the whole scope did.
        const at = best.findIndex((match) => match.similarity < similarity);
        if (at === -1) {
          if (best.length >= limit) continue;
          best.push({
            id: doc.id,
            content: doc.content.text,
            similarity,
            metadata: doc.metadata,
          });
          continue;
        }
        best.splice(at, 0, {
          id: doc.id,
          content: doc.content.text,
          similarity,
          metadata: doc.metadata,
        });
        if (best.length > limit) best.pop();
      }
    }

    return c.json({
      success: true,
      results: best,
      total,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
