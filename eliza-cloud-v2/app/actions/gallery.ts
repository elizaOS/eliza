"use server";

import { requireAuthWithOrg } from "@/lib/auth";
import { logger } from "@/lib/utils/logger";
import { generationsService } from "@/lib/services/generations";
import { deleteBlob } from "@/lib/blob";
import { revalidatePath } from "next/cache";

export interface GalleryItem {
  id: string;
  type: "image" | "video";
  url: string;
  thumbnailUrl?: string;
  prompt: string;
  model: string;
  status: string;
  createdAt: Date;
  completedAt?: Date;
  dimensions?: {
    width?: number;
    height?: number;
    duration?: number;
  };
  mimeType?: string;
  fileSize?: bigint;
}

/**
 * Lists all completed media items for the authenticated user's organization.
 *
 * @param options - Optional filters for type, limit, and pagination offset.
 * @returns Array of gallery items with metadata.
 */
export async function listUserMedia(options?: {
  type?: "image" | "video";
  limit?: number;
  offset?: number;
}): Promise<GalleryItem[]> {
  const user = await requireAuthWithOrg();

  // Fetch with database-level filtering
  const generations = await generationsService.listByOrganizationAndStatus(
    user.organization_id!,
    "completed",
    {
      userId: user.id,
      type: options?.type,
      limit: options?.limit,
      offset: options?.offset,
    },
  );

  // Filter out generations without storage_url
  const filtered = generations.filter((gen) => gen.storage_url);

  return filtered.map((gen) => ({
    id: gen.id,
    type: gen.type as "image" | "video",
    url: gen.storage_url!,
    thumbnailUrl: gen.thumbnail_url || undefined,
    prompt: gen.prompt,
    model: gen.model,
    status: gen.status,
    createdAt: gen.created_at,
    completedAt: gen.completed_at || undefined,
    dimensions: gen.dimensions || undefined,
    mimeType: gen.mime_type || undefined,
    fileSize: gen.file_size || undefined,
  }));
}

/**
 * Deletes a media item from the gallery and blob storage.
 *
 * @param generationId - The ID of the generation/media item to delete.
 * @returns True if deletion was successful.
 * @throws If the media is not found or access is denied.
 */
export async function deleteMedia(generationId: string): Promise<boolean> {
  const user = await requireAuthWithOrg();

  // Get the generation to verify ownership
  const generation = await generationsService.getById(generationId);

  if (!generation || generation.user_id !== user.id) {
    throw new Error("Media not found or access denied");
  }

  // Delete from Vercel Blob if it's a blob URL
  if (
    generation.storage_url &&
    generation.storage_url.includes("blob.vercel-storage.com")
  ) {
    try {
      await deleteBlob(generation.storage_url);
    } catch (error) {
      logger.error("Failed to delete from Vercel Blob:", error);
      // Continue anyway to mark as deleted in DB
    }
  }

  // Update the generation record to mark as deleted
  await generationsService.updateStatus(generationId, "deleted");

  revalidatePath("/dashboard/gallery");
  return true;
}

/**
 * Gets media statistics for the authenticated user.
 *
 * @returns Statistics including total images, videos, and total file size.
 */
/**
 * Lists random public images for the explore/discover section.
 * Does not require authentication.
 *
 * @param limit - Maximum number of images to return (default 20).
 * @returns Array of gallery items from random users.
 */
export async function listExploreImages(
  limit: number = 20,
): Promise<GalleryItem[]> {
  const generations = await generationsService.listRandomPublicImages(limit);

  return generations.map((gen) => ({
    id: gen.id,
    type: gen.type as "image" | "video",
    url: gen.storage_url!,
    thumbnailUrl: gen.thumbnail_url || undefined,
    prompt: gen.prompt,
    model: gen.model,
    status: gen.status,
    createdAt: gen.created_at,
    completedAt: gen.completed_at || undefined,
    dimensions: gen.dimensions || undefined,
    mimeType: gen.mime_type || undefined,
    fileSize: gen.file_size || undefined,
  }));
}

export async function getUserMediaStats(): Promise<{
  totalImages: number;
  totalVideos: number;
  totalSize: number;
}> {
  const user = await requireAuthWithOrg();

  // Get completed generations for the user with storage_url
  const generations = await generationsService.listByOrganizationAndStatus(
    user.organization_id!,
    "completed",
    {
      userId: user.id,
    },
  );

  const userGenerations = generations.filter((gen) => gen.storage_url);

  const totalImages = userGenerations.filter(
    (gen) => gen.type === "image",
  ).length;
  const totalVideos = userGenerations.filter(
    (gen) => gen.type === "video",
  ).length;
  const totalSize = userGenerations.reduce(
    (acc, gen) => acc + Number(gen.file_size || 0),
    0,
  );

  return {
    totalImages,
    totalVideos,
    totalSize,
  };
}
