"use server";

/**
 * Server actions for app-related operations.
 * Includes promotional asset upload and deletion.
 */

import { requireAuthWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { appsRepository } from "@/db/repositories/apps";
import { uploadToBlob, deleteBlob, isValidBlobUrl } from "@/lib/blob";
import { logger } from "@/lib/utils/logger";

interface PromotionalAsset {
  type: "social_card" | "banner" | "custom";
  url: string;
  size: { width: number; height: number };
  generatedAt: string;
}

/**
 * Uploads a promotional asset image for an app.
 *
 * @param appId - The app ID to add the asset to.
 * @param formData - Form data containing the image file.
 * @returns Success status with the uploaded asset info, or error details.
 */
export async function uploadPromotionalAsset(
  appId: string,
  formData: FormData,
) {
  try {
    const user = await requireAuthWithOrg();
    const file = formData.get("file") as File;

    if (!file) {
      return { success: false, error: "No file provided" };
    }

    // Validate file type
    if (!file.type.startsWith("image/")) {
      return {
        success: false,
        error: "Invalid file type. Please upload an image.",
      };
    }

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      return { success: false, error: "File too large. Maximum size is 10MB." };
    }

    // Verify app ownership
    const app = await appsService.getById(appId);
    if (!app || app.organization_id !== user.organization_id) {
      return { success: false, error: "App not found" };
    }

    // Upload to blob storage
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { url } = await uploadToBlob(buffer, {
      filename: file.name,
      contentType: file.type,
      folder: "promotional-assets",
      userId: user.id,
    });

    // Get image dimensions from form data if provided by client, otherwise use defaults
    // Client can extract dimensions using browser's Image API before upload
    const widthStr = formData.get("width") as string | null;
    const heightStr = formData.get("height") as string | null;
    const width = widthStr ? parseInt(widthStr, 10) : 1200;
    const height = heightStr ? parseInt(heightStr, 10) : 630;

    const newAsset: PromotionalAsset = {
      type: "custom",
      url,
      size: { width, height },
      generatedAt: new Date().toISOString(),
    };

    // Atomically append to existing assets (avoids race conditions)
    await appsRepository.appendPromotionalAsset(appId, newAsset);

    logger.info("[Apps Action] Uploaded promotional asset", {
      appId,
      url,
      userId: user.id,
    });

    return { success: true, asset: newAsset };
  } catch (error) {
    logger.error("[Apps Action] Error uploading promotional asset:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to upload asset",
    };
  }
}

/**
 * Deletes a promotional asset from an app.
 *
 * @param appId - The app ID to remove the asset from.
 * @param assetUrl - The URL of the asset to delete.
 * @returns Success status or error details.
 */
export async function deletePromotionalAsset(appId: string, assetUrl: string) {
  try {
    const user = await requireAuthWithOrg();

    // Verify app ownership
    const app = await appsService.getById(appId);
    if (!app || app.organization_id !== user.organization_id) {
      return { success: false, error: "App not found" };
    }

    // Atomically remove the asset (avoids race conditions)
    const { removedAsset } = await appsRepository.removePromotionalAsset(
      appId,
      assetUrl,
    );

    if (!removedAsset) {
      return { success: false, error: "Asset not found" };
    }

    // Try to delete from blob storage if it's our blob URL
    const assetWithUrl = removedAsset as { url: string };
    if (isValidBlobUrl(assetWithUrl.url)) {
      try {
        await deleteBlob(assetWithUrl.url);
        logger.info("[Apps Action] Deleted blob for promotional asset", {
          appId,
          url: assetWithUrl.url,
        });
      } catch (blobError) {
        // Log but don't fail - the database is already updated
        logger.warn(
          "[Apps Action] Failed to delete blob, continuing:",
          blobError,
        );
      }
    }

    logger.info("[Apps Action] Deleted promotional asset", {
      appId,
      assetUrl,
      userId: user.id,
    });

    return { success: true };
  } catch (error) {
    logger.error("[Apps Action] Error deleting promotional asset:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to delete asset",
    };
  }
}
