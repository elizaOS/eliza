/**
 * Image model handlers for Vercel AI Gateway plugin.
 */

import type { IAgentRuntime, ImageGenerationParams as CoreImageParams, ImageDescriptionParams as CoreImageDescParams } from "@elizaos/core";
import { GatewayClient } from "../providers/client";
import type { ImageGenerationResult, ImageDescriptionResult, ImageSize, ImageQuality, ImageStyle } from "../types";
import { buildConfig, getImageModel } from "../utils/config";

/**
 * Handle IMAGE model requests (image generation).
 */
export async function handleImageGeneration(
  runtime: IAgentRuntime,
  params: CoreImageParams
): Promise<ImageGenerationResult[]> {
  const config = buildConfig(runtime);
  const client = new GatewayClient(config);

  const model = getImageModel(runtime);

  const extendedParams = params as { quality?: string; style?: string };
  return client.generateImage({
    prompt: params.prompt,
    model,
    n: params.count,
    size: params.size as ImageSize | undefined,
    quality: extendedParams.quality as ImageQuality | undefined,
    style: extendedParams.style as ImageStyle | undefined,
  });
}

/**
 * Handle IMAGE_DESCRIPTION model requests.
 */
export async function handleImageDescription(
  runtime: IAgentRuntime,
  params: CoreImageDescParams | string
): Promise<ImageDescriptionResult> {
  const config = buildConfig(runtime);
  const client = new GatewayClient(config);

  let imageUrl: string;
  let prompt: string | undefined;

  if (typeof params === "string") {
    imageUrl = params;
  } else {
    imageUrl = params.imageUrl;
    prompt = params.prompt;
  }

  return client.describeImage({
    imageUrl,
    prompt,
  });
}

