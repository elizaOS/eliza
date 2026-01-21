/**
 * Asset URL utilities for static files
 *
 * @description Handles URLs for both local development and production deployment
 * with CDN storage. Provides utilities for profile images, organization images,
 * and banner images.
 */

/**
 * Check if a URL is already absolute (CDN URL, external URL, or data URL)
 *
 * @param {string} url - URL to check
 * @returns {boolean} True if the URL is absolute
 */
export function isAbsoluteUrl(url: string): boolean {
  return /^(https?:|data:|blob:)/i.test(url);
}

/**
 * Get the base URL for static assets
 *
 * @description In Next.js, files in /public are served from the root path /.
 * This function supports both:
 * - Legacy public folder assets (during migration)
 * - CDN assets (Vercel Blob in production, MinIO in dev)
 *
 * @param {string} path - Path to the asset
 * @param {string} [cdnBaseUrl] - Optional CDN base URL (defaults to NEXT_PUBLIC_STATIC_ASSETS_URL)
 * @returns {string} Full URL to the asset
 */
export function getStaticAssetUrl(path: string, cdnBaseUrl?: string): string {
  // If already an absolute URL (CDN, external, or data), return as-is
  if (isAbsoluteUrl(path)) {
    return path;
  }

  // Ensure path starts with /
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  // Use provided CDN URL or environment variable
  const staticAssetsUrl =
    cdnBaseUrl ||
    (typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_STATIC_ASSETS_URL
      : undefined);

  // In production with CDN configured, use CDN URL
  if (staticAssetsUrl) {
    return `${staticAssetsUrl}${normalizedPath}`;
  }

  // For local development with MinIO, CDN assets will already be absolute URLs
  // from the storage client, so this mainly handles public folder fallbacks
  return normalizedPath;
}

/**
 * Get deterministic fallback profile image based on ID
 *
 * @description Returns a random-looking but deterministic profile image from
 * the user-profiles set based on a hash of the ID.
 *
 * @param {string} id - User or entity ID
 * @param {string} [cdnBaseUrl] - Optional CDN base URL
 * @returns {string} URL to fallback profile image
 */
export function getFallbackProfileImageUrl(
  id: string,
  cdnBaseUrl?: string,
): string {
  // Hash the id to get a number between 1-100
  const hash = Array.from(id).reduce(
    (acc, char) => acc + char.charCodeAt(0),
    0,
  );
  const profileNum = (hash % 100) + 1;
  return getStaticAssetUrl(
    `/assets/user-profiles/profile-${profileNum}.jpg`,
    cdnBaseUrl,
  );
}

/**
 * Get actor/user profile image URL
 *
 * @description Tries multiple sources in order:
 * 1. Uploaded profile image URL (from CDN storage - Vercel Blob or MinIO)
 * 2. Static actor image from CDN or public/images/actors/
 * 3. Returns null if not found (Avatar component will handle fallback on error)
 *
 * @param {string | null | undefined} profileImageUrl - Uploaded profile image URL
 * @param {string | null | undefined} userId - User or actor ID
 * @param {boolean} [isActor=true] - Whether this is an actor profile
 * @param {string} [cdnBaseUrl] - Optional CDN base URL
 * @returns {string | null} Profile image URL or null
 */
export function getProfileImageUrl(
  profileImageUrl: string | null | undefined,
  userId: string | null | undefined,
  isActor = true,
  cdnBaseUrl?: string,
): string | null {
  // If profile image URL is provided (uploaded image from CDN), use it
  if (profileImageUrl) {
    // If it's already a CDN URL, return as-is
    if (isAbsoluteUrl(profileImageUrl)) {
      return profileImageUrl;
    }
    // Otherwise, normalize it through getStaticAssetUrl
    return getStaticAssetUrl(profileImageUrl, cdnBaseUrl);
  }

  // For actors, try to use static image
  // This could be from CDN (after migration) or public folder (legacy)
  if (userId && isActor) {
    return getStaticAssetUrl(`/images/actors/${userId}.jpg`, cdnBaseUrl);
  }

  // No image available - Avatar component will handle fallback
  return null;
}

/**
 * Get organization image URL
 *
 * @description Handles both CDN URLs and legacy public folder paths
 *
 * @param {string | null | undefined} imageUrl - Organization image URL
 * @param {string | null | undefined} orgId - Organization ID
 * @param {string} [cdnBaseUrl] - Optional CDN base URL
 * @returns {string | null} Organization image URL or null
 */
export function getOrganizationImageUrl(
  imageUrl: string | null | undefined,
  orgId: string | null | undefined,
  cdnBaseUrl?: string,
): string | null {
  // If image URL is provided, use it
  if (imageUrl) {
    // If it's already a CDN URL, return as-is
    if (isAbsoluteUrl(imageUrl)) {
      return imageUrl;
    }
    // Otherwise, normalize it
    return getStaticAssetUrl(imageUrl, cdnBaseUrl);
  }

  // For organizations, try to use static image
  if (orgId) {
    return getStaticAssetUrl(`/images/organizations/${orgId}.jpg`, cdnBaseUrl);
  }

  return null;
}

/**
 * Get banner image URL (for actors, organizations, or users)
 *
 * @description Handles both CDN URLs and legacy public folder paths
 *
 * @param {string | null | undefined} bannerUrl - Banner image URL
 * @param {string | null | undefined} entityId - Entity ID
 * @param {'actor' | 'organization' | 'user'} [entityType='actor'] - Entity type
 * @param {string} [cdnBaseUrl] - Optional CDN base URL
 * @returns {string | null} Banner image URL or null
 */
export function getBannerImageUrl(
  bannerUrl: string | null | undefined,
  entityId: string | null | undefined,
  entityType: "actor" | "organization" | "user" = "actor",
  cdnBaseUrl?: string,
): string | null {
  // If banner URL is provided, use it
  if (bannerUrl) {
    // If it's already a CDN URL, return as-is
    if (isAbsoluteUrl(bannerUrl)) {
      return bannerUrl;
    }
    // Otherwise, normalize it
    return getStaticAssetUrl(bannerUrl, cdnBaseUrl);
  }

  // For actors/organizations, try to use static banner image
  if (entityId) {
    if (entityType === "actor") {
      return getStaticAssetUrl(
        `/images/actor-banners/${entityId}.jpg`,
        cdnBaseUrl,
      );
    }
    if (entityType === "organization") {
      return getStaticAssetUrl(
        `/images/org-banners/${entityId}.jpg`,
        cdnBaseUrl,
      );
    }
  }

  return null;
}
