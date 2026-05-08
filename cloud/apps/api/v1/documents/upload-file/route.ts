import { Hono } from "hono";

import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  createDocumentRecord,
  fileToDocumentInput,
  resolveDocumentScope,
  validateDocumentFiles,
} from "../_worker-documents";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ success: false, error: "multipart/form-data is required" }, 400);

    const characterId = form.get("characterId");
    const scope = await resolveDocumentScope(
      user,
      typeof characterId === "string" ? characterId : null,
    );
    if (scope instanceof Response) return scope;

    const files = form.getAll("files").filter((value): value is File => value instanceof File);
    const invalid = validateDocumentFiles(files);
    if (invalid) return invalid;

    const documents = [];
    for (const file of files) {
      documents.push(await createDocumentRecord(user, scope, await fileToDocumentInput(file)));
    }

    return c.json({
      success: true,
      message: `Successfully uploaded ${documents.length} file(s)`,
      successCount: documents.length,
      failedCount: 0,
      documents,
    });
  } catch (error) {
    logger.error("[DocumentsRoute] Failed to upload document files", {
      error: error instanceof Error ? error.stack || error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
