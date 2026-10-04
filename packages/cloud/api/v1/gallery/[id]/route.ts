/**
 * DELETE /api/v1/gallery/:id
 *
 * Soft-deletes a media item from the gallery. Verifies ownership, removes
 * the underlying R2 object if the storage URL is a trusted blob URL, then
 * marks the generation record as `deleted`. Generated media counts toward the
 * organization storage quota (#20956), so its reservation is released once the
 * object is confirmed deleted and the record transitions to `deleted`.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  ApiError,
  failureResponse,
  NotFoundError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { deleteBlob, isValidBlobUrl } from "@elizaos/cloud-shared/lib/blob";
import { generationsService } from "@elizaos/cloud-shared/lib/services/generations";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id") ?? "";

    const generation = await generationsService.getById(id);
    if (!generation || generation.user_id !== user.id) {
      throw NotFoundError("Media not found or access denied");
    }

    const storageQuotaBytes = generation.result?.storageQuotaBytes;
    const reservedBytes =
      typeof storageQuotaBytes === "string" && /^\d+$/.test(storageQuotaBytes)
        ? storageQuotaBytes
        : undefined;
    const trustedObject =
      generation.storage_url && isValidBlobUrl(generation.storage_url);
    if (reservedBytes && BigInt(reservedBytes) > 0n && !trustedObject) {
      throw new ApiError({
        status: 503,
        code: "service_unavailable",
        message:
          "Stored media cannot be deleted with the current storage configuration",
      });
    }
    if (trustedObject && generation.storage_url) {
      // Keep the row retryable when deletion fails. Object deletion is
      // idempotent if the subsequent database transaction must be retried.
      await deleteBlob(generation.storage_url);
    }
    await generationsService.markDeletedOnce(
      id,
      trustedObject ? reservedBytes : undefined,
    );

    return c.json({ success: true });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
