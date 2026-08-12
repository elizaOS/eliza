/**
 * GET /api/v1/gallery/:id — owner poll for generation status (incl. pending music).
 * DELETE /api/v1/gallery/:id — soft-delete owned gallery media.
 *
 * GET verifies ownership and returns status + storage URL when ready so clients
 * can complete a 202 pending generate-music response (#18436).
 */

import { Hono } from "hono";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { deleteBlob, isValidBlobUrl } from "@/lib/blob";
import { generationsService } from "@/lib/services/generations";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id") ?? "";

    const generation = await generationsService.getById(id);
    // Owner user OR same-organization API key may poll (pending music path).
    if (
      !generation ||
      (generation.user_id !== user.id &&
        generation.organization_id !== user.organization_id)
    ) {
      throw NotFoundError("Media not found or access denied");
    }

    return c.json({
      success: true,
      id: generation.id,
      type: generation.type,
      status: generation.status,
      storage_url: generation.storage_url,
      mime_type: generation.mime_type,
      file_name:
        typeof generation.result === "object" &&
        generation.result !== null &&
        "file_name" in generation.result
          ? (generation.result as { file_name?: string }).file_name
          : undefined,
      error: generation.error,
      job_id: generation.job_id,
      requestId: generation.job_id,
      completed_at: generation.completed_at,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id") ?? "";

    const generation = await generationsService.getById(id);
    if (!generation || generation.user_id !== user.id) {
      throw NotFoundError("Media not found or access denied");
    }

    if (generation.storage_url && isValidBlobUrl(generation.storage_url)) {
      try {
        await deleteBlob(generation.storage_url);
      } catch (error) {
        // Log and proceed with the soft delete so the row is removed from
        // the gallery even if R2 object deletion fails. An out-of-band
        // sweeper can reconcile orphaned objects later.
        logger.error(
          "[GALLERY API] R2 delete failed; marking generation deleted only",
          {
            id,
            storageUrl: generation.storage_url,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    await generationsService.updateStatus(id, "deleted");

    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
