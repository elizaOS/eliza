import { Hono } from "hono";

import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  publicBlobUrl,
  r2KeyFromBlobUrl,
  sanitizeFilename,
  validateDocumentFiles,
} from "../_worker-documents";

interface DeletePreUploadBody {
  blobUrl?: string;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    if (!c.env.BLOB) {
      return c.json({ success: false, error: "Object storage is not configured" }, 503);
    }

    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ success: false, error: "multipart/form-data is required" }, 400);

    const files = form.getAll("files").filter((value): value is File => value instanceof File);
    const invalid = validateDocumentFiles(files);
    if (invalid) return invalid;

    const uploaded = [];
    for (const file of files) {
      const filename = sanitizeFilename(file.name || "document.txt");
      const key = `documents-pre-upload/${user.id}/${Date.now()}-${crypto.randomUUID()}-${filename}`;
      await c.env.BLOB.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
        customMetadata: {
          userId: user.id,
          filename,
          size: String(file.size),
        },
      });
      uploaded.push({
        id: crypto.randomUUID(),
        filename,
        blobUrl: publicBlobUrl(c, key),
        contentType: file.type || "application/octet-stream",
        size: file.size,
        uploadedAt: Date.now(),
      });
    }

    return c.json({
      success: true,
      files: uploaded,
      successCount: uploaded.length,
      failedCount: 0,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    if (!c.env.BLOB) {
      return c.json({ success: false, error: "Object storage is not configured" }, 503);
    }

    const body = (await c.req.json().catch(() => null)) as DeletePreUploadBody | null;
    const key = body?.blobUrl ? r2KeyFromBlobUrl(body.blobUrl) : null;
    if (!key) return c.json({ success: false, error: "blobUrl is required" }, 400);
    if (!key.startsWith(`documents-pre-upload/${user.id}/`)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    await c.env.BLOB.delete(key);
    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
