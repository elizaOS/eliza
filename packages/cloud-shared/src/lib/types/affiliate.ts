/**
 * Affiliate type definitions for character creation from affiliate sources.
 */

/**
 * Available vibe types for affiliate characters.
 */
export type AffiliateVibe =
  | "playful"
  | "mysterious"
  | "romantic"
  | "bold"
  | "shy"
  | "flirty"
  | "intellectual"
  | "spicy";

/**
 * Reference image for affiliate character.
 */
export interface AffiliateImageReference {
  url: string;
  isProfilePic?: boolean;
  width?: number;
  height?: number;
  uploadedAt?: string;
}

/**
 * Social media post from affiliate source.
 */
export interface AffiliateSocialPost {
  caption: string;
  timestamp?: string;
  likeCount?: number;
  commentCount?: number;
}

/**
 * Complete affiliate data for character creation.
 */
export interface AffiliateData {
  affiliateId: string;
  source?: string;
  vibe?: AffiliateVibe | string;
  autoImage?: boolean;
  backstory?: string;
  instagram?: string;
  twitter?: string;
  socialContent?: string;
  imageUrls: string[];
  referenceImages?: AffiliateImageReference[];
  topPosts?: AffiliateSocialPost[];
  createdAt: string;
  appearanceDescription?: string;
}

/**
 * Metadata extracted from affiliate source.
 */
export interface AffiliateMetadata {
  source?: string;
  vibe?: AffiliateVibe | string;
  backstory?: string;
  instagram?: string;
  twitter?: string;
  socialContent?: string;
  imageUrls?: string[];
  imageBase64s?: string[];
  images?: Array<{ type: "url" | "base64"; data: string }>;
  avatarBase64?: string;
}

/**
 * Result of processing affiliate images.
 */
export interface ProcessedAffiliateImages {
  avatarUrl: string | null;
  referenceImageUrls: string[];
  failedUploads: number;
}

/**
 * Type guard to check if a string is a valid affiliate vibe.
 *
 * @param vibe - String to check.
 * @returns True if the string is a valid vibe.
 */
export function isValidAffiliateVibe(vibe: string): vibe is AffiliateVibe {
  return [
    "playful",
    "mysterious",
    "romantic",
    "bold",
    "shy",
    "flirty",
    "intellectual",
    "spicy",
  ].includes(vibe);
}

/**
 * Type guard to check if data is valid affiliate data.
 *
 * @param data - Data to check.
 * @returns True if data is valid affiliate data.
 */
export function isAffiliateData(data: unknown): data is AffiliateData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.affiliateId === "string" &&
    Array.isArray(d.imageUrls) &&
    typeof d.createdAt === "string"
  );
}
