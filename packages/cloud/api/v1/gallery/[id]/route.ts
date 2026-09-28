/**
 * DELETE /api/v1/gallery/:id
 *
 * Soft-deletes a media item from the gallery. Verifies ownership, removes
 * the underlying R2 object if the storage URL is a trusted blob URL, then
 * marks the generation record as `deleted`. Generated media counts toward the
 * organization storage quota (#20956), so its reservation is released once the
 * object is confirmed deleted and the record transitions to `deleted`.
 */

import { Hono } from "hono";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { deleteBlob, isValidBlobUrl } from "@/lib/blob";
import { generationsService } from "@/lib/services/generations";
import { releaseGeneratedMediaStorage } from "@/lib/storage/generated-media-storage";
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

    let objectDeleted = false;
    if (generation.storage_url && isValidBlobUrl(generation.storage_url)) {
      try {
        await deleteBlob(generation.storage_url);
        objectDeleted = true;
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

    const transitioned = await generationsService.markDeletedOnce(id);
    // Release only reserved media whose object is confirmed gone; a failed R2
    // delete keeps the bytes counted so usage is never undercounted.
    const storageQuotaBytes = generation.result?.storageQuotaBytes;
    if (
      transitioned &&
      objectDeleted &&
      typeof storageQuotaBytes === "string"
    ) {
      await releaseGeneratedMediaStorage(
        generation.organization_id,
        storageQuotaBytes,
      );
    }

    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
