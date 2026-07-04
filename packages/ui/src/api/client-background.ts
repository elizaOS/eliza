/**
 * ElizaClient extension for background-image generation: the server runs the
 * agent's image provider, persists to the content-addressed media store, and
 * returns a durable /api/media/<hash> URL.
 */
import { ElizaClient } from "./client-base";

// ---------------------------------------------------------------------------
// Declaration merging
// ---------------------------------------------------------------------------

declare module "./client-base" {
  interface ElizaClient {
    /**
     * Generate a background image from a text prompt. The server runs the
     * agent's image provider and persists the result to the content-addressed
     * media store, returning a durable same-origin `/api/media/<hash>` URL the
     * caller can store and render directly.
     */
    generateBackgroundImage(
      prompt: string,
      size?: string,
    ): Promise<{ url: string }>;
    /**
     * Re-host a user-picked wallpaper (downscaled data URL) into the
     * content-addressed media store, returning a durable same-origin
     * `/api/media/<hash>` URL. Persisting THAT keeps the background config +
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

ElizaClient.prototype.generateBackgroundImage = async function (
  this: ElizaClient,
  prompt,
  size,
) {
  return this.fetch<{ url: string }>("/api/background/generate-image", {
    method: "POST",
    body: JSON.stringify({ prompt, ...(size ? { size } : {}) }),
  });
};

ElizaClient.prototype.uploadBackgroundImage = async function (
  this: ElizaClient,
  dataUrl,
) {
  return this.fetch<{ url: string }>("/api/background/upload-image", {
    method: "POST",
    body: JSON.stringify({ dataUrl }),
  });
};
