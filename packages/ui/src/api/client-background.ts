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
