import { Hono } from "hono";

import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  createKnowledgeDocument,
  listKnowledgeDocuments,
  resolveKnowledgeScope,
} from "./_worker-knowledge";

interface CreateKnowledgeBody {
  content?: string;
  filename?: string;
  contentType?: string;
  characterId?: string;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const scope = await resolveKnowledgeScope(user, c.req.query("characterId"));
    if (scope instanceof Response) return scope;

    const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "100", 10) || 100, 200);
    const offset = Math.max(Number.parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const documents = await listKnowledgeDocuments(scope, limit, offset);

    return c.json({
      success: true,
      documents,
      total: documents.length,
    });
  } catch (error) {
    logger.error("[KnowledgeRoute] Failed to list knowledge documents", {
      error: error instanceof Error ? error.stack || error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = (await c.req.json().catch(() => null)) as CreateKnowledgeBody | null;
    if (!body) return c.json({ success: false, error: "Request body must be JSON" }, 400);

    const content = body.content?.trim();
    if (!content) return c.json({ success: false, error: "content is required" }, 400);

    const scope = await resolveKnowledgeScope(user, body.characterId);
    if (scope instanceof Response) return scope;

    const document = await createKnowledgeDocument(user, scope, {
      filename: body.filename || "text-document.txt",
      contentType: body.contentType || "text/plain",
      size: new TextEncoder().encode(content).byteLength,
      text: content,
    });

    return c.json({
      success: true,
      message: "Document uploaded successfully",
      document,
    });
  } catch (error) {
    logger.error("[KnowledgeRoute] Failed to create knowledge document", {
      error: error instanceof Error ? error.stack || error.message : String(error),
      cause:
        error instanceof Error && error.cause instanceof Error
          ? error.cause.stack || error.cause.message
          : undefined,
    });
    return failureResponse(c, error);
  }
});

export default app;
