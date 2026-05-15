import { Hono } from "hono";

import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  createDocumentRecord,
  type PendingDocumentFile,
  r2KeyFromBlobUrl,
  resolveDocumentScope,
} from "../_worker-documents";

interface SubmitDocumentsBody {
  characterId?: string;
  files?: PendingDocumentFile[];
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    if (!c.env.BLOB) {
      return c.json({ success: false, error: "Object storage is not configured" }, 503);
    }

    const body = (await c.req.json().catch(() => null)) as SubmitDocumentsBody | null;
    if (!body?.characterId) {
      return c.json({ success: false, error: "characterId is required" }, 400);
    }
    if (!Array.isArray(body.files) || body.files.length === 0) {
      return c.json({ success: false, error: "files are required" }, 400);
    }

    const scope = await resolveDocumentScope(user, body.characterId);
    if (scope instanceof Response) return scope;

    const results = [];
    for (const file of body.files) {
      const key = r2KeyFromBlobUrl(file.blobUrl);
      if (!key || !key.startsWith(`documents-pre-upload/${user.id}/`)) {
        results.push({ blobUrl: file.blobUrl, status: "error", error: "Invalid blobUrl" });
        continue;
      }

      const object = await c.env.BLOB.get(key);
      if (!object) {
        results.push({ blobUrl: file.blobUrl, status: "error", error: "File not found" });
        continue;
      }

      const document = await createDocumentRecord(user, scope, {
        filename: file.filename,
        contentType: file.contentType,
        size: file.size,
        text: await object.text(),
      });
      await c.env.BLOB.delete(key);
      results.push({ blobUrl: file.blobUrl, status: "success", document });
    }

    const successCount = results.filter((result) => result.status === "success").length;
    const failedCount = results.length - successCount;

    return c.json({
      success: failedCount === 0,
      successCount,
      failedCount,
      results,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
