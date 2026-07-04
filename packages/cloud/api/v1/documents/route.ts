// Handles v1 cloud API v1 documents route traffic with route-local auth expectations.
import { Hono } from "hono";

import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  createDocumentRecord,
  listDocumentRecords,
  resolveDocumentScope,
} from "./_worker-documents";

interface CreateDocumentBody {
  content?: string;
  filename?: string;
  contentType?: string;
  characterId?: string;
}

const app = new Hono<AppEnv>();

// error-policy:J1 every handler in the v1/documents/* dir wraps its body in one
// outermost try/catch that translates exceptions into a structured failure via
// failureResponse(c, error) (or a 4xx for validation/not-found). No catch in
// this directory fabricates a success/empty on a failed DB/BLOB call. The
// `.catch(() => null)` sites are J3 request-body parse guards (invalid JSON ->
// 400), and the retrying blob-delete throws its last error rather than swallow.
app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const scope = await resolveDocumentScope(user, c.req.query("characterId"));
    if (scope instanceof Response) return scope;

    const limit = Math.min(
      Number.parseInt(c.req.query("limit") ?? "100", 10) || 100,
      200,
    );
    const offset = Math.max(
      Number.parseInt(c.req.query("offset") ?? "0", 10) || 0,
      0,
    );
    const documents = await listDocumentRecords(scope, limit, offset);

    return c.json({
      success: true,
      documents,
      total: documents.length,
    });
  } catch (error) {
    logger.error("[DocumentsRoute] Failed to list documents", {
      error:
        error instanceof Error ? error.stack || error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = (await c.req
      .json()
      .catch(() => null)) as CreateDocumentBody | null;
    if (!body)
      return c.json(
        { success: false, error: "Request body must be JSON" },
        400,
      );

    const content = body.content?.trim();
    if (!content)
      return c.json({ success: false, error: "content is required" }, 400);

    const scope = await resolveDocumentScope(user, body.characterId);
    if (scope instanceof Response) return scope;

    const document = await createDocumentRecord(user, scope, {
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
    logger.error("[DocumentsRoute] Failed to create document", {
      error:
        error instanceof Error ? error.stack || error.message : String(error),
      cause:
        error instanceof Error && error.cause instanceof Error
          ? error.cause.stack || error.cause.message
          : undefined,
    });
    return failureResponse(c, error);
  }
});

export default app;
