/**
 * DELETE /api/v1/gallery/:id
 *
 * Soft-deletes a media item from the gallery. Verifies ownership, removes
 * the underlying R2 object if the storage URL is a trusted blob URL, then
 * marks the generation record as `deleted`.
 */

import { Hono } from "hono";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { deleteBlob, isValidBlobUrl } from "@/lib/blob";
import { generationsService } from "@/lib/services/generations";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

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
        // the gallery even if the R2 object cleanup fails. An out-of-band
        // sweeper can reconcile orphaned objects later.
        logger.error("[GALLERY API] R2 delete failed; marking generation deleted only", {
          id,
          storageUrl: generation.storage_url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await generationsService.updateStatus(id, "deleted");

    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
