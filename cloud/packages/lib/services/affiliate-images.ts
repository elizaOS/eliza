/**
 * Service for processing and uploading affiliate character images.
 */

import { TRUSTED_BLOB_HOSTS, uploadBase64Image, uploadFromUrl } from "@/lib/blob";
import type {
  AffiliateImageReference,
  AffiliateMetadata,
  ProcessedAffiliateImages,
} from "@/lib/types/affiliate";
import { logger } from "@/lib/utils/logger";

/**
 * Maximum number of images allowed.
 */
const MAX_IMAGES = 10;

/**
 * Maximum concurrent uploads.
 */
const MAX_CONCURRENT_UPLOADS = 3;

/**
 * Upload timeout in milliseconds.
 */
const UPLOAD_TIMEOUT_MS = 30000;

/**
 * Checks if a string is a base64 data URL.
 *
 * @param str - String to check.
 * @returns True if string is a base64 data URL.
 */
function isBase64DataUrl(str: string): boolean {
  return typeof str === "string" && str.startsWith("data:image/");
}

/**
 * Checks if a string is a valid HTTP/HTTPS URL.
 *
 * @param str - String to check.
 * @returns True if string is a valid HTTP URL.
 */
function isValidHttpUrl(str: string): boolean {
  if (!str || typeof str !== "string") return false;
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Checks if a URL is hosted on our managed R2 blob storage.
 *
 * @param str - URL string to check.
 * @returns True if URL hostname matches a trusted blob host.
 */
function isManagedBlobUrl(str: string): boolean {
  if (!isValidHttpUrl(str)) return false;
  try {
    const url = new URL(str);
    return TRUSTED_BLOB_HOSTS.some((host) => url.hostname === host);
  } catch {
    return false;
  }
}

/**
 * Uploads with timeout protection.
 *
 * @param promise - Upload promise.
 * @param timeoutMs - Timeout in milliseconds.
 * @returns Upload result.
 */
async function uploadWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Upload timeout")), timeoutMs);
  });
  return Promise.race([promise, timeout]);
}

/**
 * Uploads a single image to blob storage.
 *
 * @param imageData - Image data (base64 or URL).
 * @param index - Image index.
 * @param characterId - Character ID.
 * @param isAvatar - Whether this is an avatar image.
 * @returns Uploaded image URL or null if failed.
 */
async function uploadSingleImage(
  imageData: string,
  index: number,
  characterId: string,
  isAvatar: boolean,
): Promise<string | null> {
  const prefix = isAvatar ? "avatar" : `ref-${index}`;
  const filename = `${prefix}-${Date.now()}.png`;

  if (isBase64DataUrl(imageData)) {
    logger.debug(`[AffiliateImages] Uploading base64 image ${index} to blob storage`);
    const result = await uploadWithTimeout(
      uploadBase64Image(imageData, {
        filename,
        folder: `affiliate/${characterId}`,
      }),
      UPLOAD_TIMEOUT_MS,
    );
    logger.info(
      `[AffiliateImages] Uploaded base64 image ${index}: ${result.url.substring(0, 60)}...`,
    );
    return result.url;
  } else if (isValidHttpUrl(imageData)) {
    if (isManagedBlobUrl(imageData)) {
      logger.debug(`[AffiliateImages] URL image ${index} already on managed blob storage`);
      return imageData;
    }

    logger.info(`[AffiliateImages] Re-uploading external URL ${index} to blob storage`);
    const result = await uploadWithTimeout(
      uploadFromUrl(imageData, {
        filename,
        folder: `affiliate/${characterId}`,
      }),
      UPLOAD_TIMEOUT_MS,
    );
    logger.info(
      `[AffiliateImages] Re-uploaded URL image ${index}: ${result.url.substring(0, 60)}...`,
    );
    return result.url;
  } else {
    logger.warn(`[AffiliateImages] Invalid image data at index ${index}`);
    return null;
  }
}

/**
 * Processes and uploads affiliate character images.
 *
 * @param metadata - Affiliate metadata with image references.
 * @param characterId - Character ID.
 * @returns Processed images with uploaded URLs.
 */
export async function processAffiliateImages(
  metadata: AffiliateMetadata | undefined,
  characterId: string,
): Promise<ProcessedAffiliateImages> {
  const result: ProcessedAffiliateImages = {
    avatarUrl: null,
    referenceImageUrls: [],
    failedUploads: 0,
  };

  if (!metadata) {
    return result;
  }

  logger.info("[AffiliateImages] Processing affiliate images", {
    hasAvatarBase64: !!metadata.avatarBase64,
    imageUrlsCount: metadata.imageUrls?.length || 0,
    imageBase64sCount: metadata.imageBase64s?.length || 0,
    imagesCount: metadata.images?.length || 0,
  });

  const allImages: Array<{ data: string; isAvatar: boolean }> = [];

  if (metadata.avatarBase64 && isBase64DataUrl(metadata.avatarBase64)) {
    allImages.push({ data: metadata.avatarBase64, isAvatar: true });
  }

  if (metadata.images && Array.isArray(metadata.images)) {
    for (const img of metadata.images) {
      if (img.type === "base64" && isBase64DataUrl(img.data)) {
        allImages.push({ data: img.data, isAvatar: false });
      } else if (img.type === "url" && isValidHttpUrl(img.data)) {
        allImages.push({ data: img.data, isAvatar: false });
      }
    }
  }

  if (metadata.imageBase64s && Array.isArray(metadata.imageBase64s)) {
    for (const base64 of metadata.imageBase64s) {
      if (isBase64DataUrl(base64)) {
        allImages.push({ data: base64, isAvatar: false });
      }
    }
  }

  if (metadata.imageUrls && Array.isArray(metadata.imageUrls)) {
    for (const url of metadata.imageUrls) {
      if (isValidHttpUrl(url)) {
        allImages.push({ data: url, isAvatar: false });
      } else if (isBase64DataUrl(url)) {
        allImages.push({ data: url, isAvatar: false });
      }
    }
  }

  const uniqueImages = allImages.filter(
    (img, index, self) => index === self.findIndex((i) => i.data === img.data),
  );

  const imagesToProcess = uniqueImages.slice(0, MAX_IMAGES);
  logger.info(`[AffiliateImages] Processing ${imagesToProcess.length} unique images`);

  const chunks: Array<typeof imagesToProcess> = [];
  for (let i = 0; i < imagesToProcess.length; i += MAX_CONCURRENT_UPLOADS) {
    chunks.push(imagesToProcess.slice(i, i + MAX_CONCURRENT_UPLOADS));
  }

  let processedIndex = 0;
  for (const chunk of chunks) {
    const uploadPromises = chunk.map((img, chunkIndex) =>
      uploadSingleImage(img.data, processedIndex + chunkIndex, characterId, img.isAvatar),
    );

    const results = await Promise.all(uploadPromises);

    for (let i = 0; i < results.length; i++) {
      const url = results[i];
      const img = chunk[i];

      if (url) {
        if (img.isAvatar && !result.avatarUrl) {
          result.avatarUrl = url;
        } else {
          result.referenceImageUrls.push(url);
        }
      } else {
        result.failedUploads++;
      }
    }

    processedIndex += chunk.length;
  }

  if (!result.avatarUrl && result.referenceImageUrls.length > 0) {
    result.avatarUrl = result.referenceImageUrls[0];
    logger.info("[AffiliateImages] Using first reference image as avatar fallback");
  }

  logger.info("[AffiliateImages] Processing complete", {
    avatarUrl: result.avatarUrl ? result.avatarUrl.substring(0, 60) + "..." : null,
    referenceCount: result.referenceImageUrls.length,
    failedCount: result.failedUploads,
  });

  return result;
}

export function buildAffiliateImageReferences(urls: string[]): AffiliateImageReference[] {
  return urls.map((url, index) => ({
    url,
    isProfilePic: index === 0,
    uploadedAt: new Date().toISOString(),
  }));
}

export function extractSafeImageUrls(
  affiliateData: { imageUrls?: unknown; [key: string]: unknown } | undefined,
): string[] {
  if (!affiliateData) return [];

  const imageUrls = affiliateData.imageUrls;
  if (!Array.isArray(imageUrls)) return [];

  return imageUrls.filter((url): url is string => typeof url === "string" && isValidHttpUrl(url));
}

export function hasValidReferenceImages(
  affiliateData: { imageUrls?: unknown; [key: string]: unknown } | undefined,
): boolean {
  const urls = extractSafeImageUrls(affiliateData);
  return urls.length > 0;
}
