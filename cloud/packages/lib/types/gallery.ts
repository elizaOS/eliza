/**
 * Shared media-gallery types used by the API and the SPA.
 *
 * Originally lived inline in `frontend/_legacy_actions/gallery.ts`. Moved
 * here so both the Hono routes and the React consumers can import the same
 * shape.
 */

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
