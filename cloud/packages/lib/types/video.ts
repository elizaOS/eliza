/**
 * Video generation type definitions
 */

/**
 * Response data from Fal.ai video generation API.
 */
export interface FalVideoData {
  video: {
    url: string;
    content_type?: string;
    file_name?: string;
    file_size?: number;
    width?: number;
    height?: number;
  };
  seed?: number;
  has_nsfw_concepts?: boolean[];
  timings?: Record<string, number> | null;
  requestId?: string;
}

/**
 * Extended Fal video response with additional fields for UI.
 * Video field is optional and may have slightly different structure.
 */
export type FalVideoResponse = {
  video?: {
    url?: string;
    width?: number;
    height?: number;
    file_name?: string;
    file_size?: number;
    content_type?: string;
  };
  seed?: number;
  has_nsfw_concepts?: boolean[];
  timings?: Record<string, number> | null;
  requestId?: string;
  isFallback?: boolean;
  originalError?: string;
};
