/**
 * Token image generation for the launchpad engine.
 *
 * Wraps the existing media provider pipeline used by the GENERATE_IMAGE
 * action so the launchpad runner doesn't have to dispatch a top-level
 * action just to get an image. Returns a URL the engine drops into the
 * launchpad's file input.
 */

import { type IAgentRuntime, logger } from "@elizaos/core";
import { isElizaCloudServiceSelectedInConfig } from "@elizaos/shared";
import { loadElizaConfig } from "../../config/config.js";
import { createImageProvider } from "../../providers/media-provider.js";

export interface GeneratedTokenImage {
  /** Direct image URL (when the provider returns one). */
  imageUrl: string | null;
  /** Base64 fallback when the provider returns inline bytes only. */
  imageBase64: string | null;
}

/**
 * Run image generation directly against the configured media provider.
 * Returns null on failure so the caller can decide whether to abort the
 * launchpad run or fall back to a default placeholder.
 */
export async function runLaunchpadImageGeneration(
  _runtime: IAgentRuntime,
  prompt: string,
): Promise<GeneratedTokenImage | null> {
  const config = loadElizaConfig();
  const cloudMediaSelected = isElizaCloudServiceSelectedInConfig(
    config as Record<string, unknown>,
    "media",
  );
  const provider = createImageProvider(config.media?.image, {
    elizaCloudBaseUrl: config.cloud?.baseUrl ?? "https://elizacloud.ai/api/v1",
    elizaCloudApiKey: config.cloud?.apiKey,
    cloudMediaDisabled: !cloudMediaSelected,
  });

  try {
    const result = await provider.generate({
      prompt,
      size: "1024x1024",
      quality: "standard",
    });
    if (!result.success || !result.data) {
      logger.warn(
        `[launchpad] image-generator failed: ${result.error ?? "unknown error"}`,
      );
      return null;
    }
    return {
      imageUrl: result.data.imageUrl ?? null,
      imageBase64: result.data.imageBase64 ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[launchpad] image-generator threw: ${message}`);
    return null;
  }
}
