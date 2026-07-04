// Handles v1 cloud API v1 files id route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { cloudFilesService } from "@/lib/services/cloud-files";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

const fileIdSchema = z.string().uuid();

function toClientFile(
  file: NonNullable<Awaited<ReturnType<typeof cloudFilesService.get>>>,
) {
  return {
    id: file.id,
    source: file.source,
    kind: file.kind,
    filename: file.filename,
    mimeType: file.mime_type,
    sizeBytes: Number(file.size_bytes),
    sha256: file.sha256,
    url: file.storage_url,
    generationId: file.generation_id,
    metadata: file.metadata,
    createdAt: file.created_at,
    updatedAt: file.updated_at,
  };
}

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const fileId = fileIdSchema.parse(c.req.param("id"));
    const file = await cloudFilesService.get(user.organization_id, fileId);
    if (!file) return jsonError(c, 404, "File not found", "resource_not_found");
    return c.json({ success: true, file: toClientFile(file) });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const fileId = fileIdSchema.parse(c.req.param("id"));
    const deleted = await cloudFilesService.delete(
      c.env,
      user.organization_id,
      fileId,
    );
    if (!deleted)
      return jsonError(c, 404, "File not found", "resource_not_found");
    return c.json({ success: true, deleted: true, id: deleted.id });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
