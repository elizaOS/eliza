import type {
  ImageDescriptionParams as CoreImageDescParams,
  ImageGenerationParams as CoreImageParams,
  IAgentRuntime,
} from "@elizaos/core";
import { GatewayClient } from "../providers/client";
import type {
  ImageDescriptionResult,
  ImageGenerationResult,
  ImageQuality,
  ImageSize,
  ImageStyle,
} from "../types";
import { buildConfig, getImageModel } from "../utils/config";

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
