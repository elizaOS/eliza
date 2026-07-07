/**
 * ElizaClient extension for background-image upload re-hosting into the
 * content-addressed media store. Agent-driven image generation stays behind
 * the server-side BACKGROUND action, while the client API owns only the
 * durable upload handle used by the wallpaper picker and undo history.
 */
import { ElizaClient } from "./client-base";

// ---------------------------------------------------------------------------
// Declaration merging
// ---------------------------------------------------------------------------

declare module "./client-base" {
  interface ElizaClient {
    /**
     * Re-host a user-picked wallpaper (downscaled data URL) into the
     * content-addressed media store, returning a durable same-origin
     * `/api/media/<hash>` URL. Persisting the media URL keeps the config and
     * undo history tiny instead of stacking multi-MB data URLs into the
     * ~5 MB localStorage quota (where writes fail silently and the wallpaper
     * reverts on reload).
     */
    uploadBackgroundImage(dataUrl: string): Promise<{ url: string }>;
  }
}

// ---------------------------------------------------------------------------
// Prototype augmentation
// ---------------------------------------------------------------------------

ElizaClient.prototype.uploadBackgroundImage = async function (
  this: ElizaClient,
  dataUrl,
) {
  return this.fetch<{ url: string }>("/api/background/upload-image", {
    method: "POST",
    body: JSON.stringify({ dataUrl }),
  });
};
