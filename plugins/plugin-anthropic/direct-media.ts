/** Stateless own-key vision adapter with explicit provider output-budget validation. */
import {type VisionAnalysisOptions, type VisionAnalysisProvider, type VisionAnalysisResult, type MediaProviderResult, fetchMediaProviderResponse as fetchWithTimeout, withMediaProviderErrorBoundary as withProviderErrorBoundary, resolveVisionImageInput, isMediaProviderResult} from "@elizaos/host/protocol";
import {ElizaError} from "@elizaos/core";
import { type VisionConfig } from "@elizaos/contracts";
export class AnthropicVisionProvider implements VisionAnalysisProvider {
  name = "anthropic";
  private apiKey: string;
  private model: string;
  private modelMaxOutputTokens?: number;

  constructor(config: NonNullable<VisionConfig["anthropic"]>) {
    if (!config.apiKey) {
      throw new Error(`${this.name} API key is required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "claude-opus-4-7";
  }

  private async resolveModelMaxOutputTokens(signal?: AbortSignal): Promise<number> {
    if (this.modelMaxOutputTokens !== undefined) {
      return this.modelMaxOutputTokens;
    }
    const response = await fetchWithTimeout(
      `https://api.anthropic.com/v1/models/${encodeURIComponent(this.model)}`,
      {
        signal,

        method: "GET",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Anthropic model metadata error: ${response.status} ${text}`,
      );
    }
    const data = (await response.json()) as { max_tokens?: unknown };
    if (
      typeof data.max_tokens !== "number" ||
      !Number.isSafeInteger(data.max_tokens) ||
      data.max_tokens <= 0
    ) {
      throw new Error(
        `Anthropic model metadata omitted max_tokens for ${this.model}`,
      );
    }
    this.modelMaxOutputTokens = data.max_tokens;
    return data.max_tokens;
  }

  async analyze(
    options: VisionAnalysisOptions,
  ): Promise<MediaProviderResult<VisionAnalysisResult>> {
    const imageInput = resolveVisionImageInput(this.name, options);
    if (isMediaProviderResult(imageInput)) return imageInput;
    const imageSource =
      imageInput.type === "base64"
        ? {
            type: "base64" as const,
            media_type: "image/jpeg" as const,
            data: imageInput.value,
          }
        : { type: "url" as const, url: imageInput.value };

    return withProviderErrorBoundary(this.name, async () => {
      if (
        options.maxTokens !== undefined &&
        (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)
      ) {
        throw new ElizaError(
          `Requested Anthropic output tokens must be a positive safe integer; received ${options.maxTokens}`,
          {
            code: "VISION_OUTPUT_BUDGET_INVALID",
            context: {
              model: this.model,
              requestedMaxTokens: options.maxTokens,
            },
          },
        );
      }
      const modelMaxOutputTokens = await this.resolveModelMaxOutputTokens(options.signal);
      if (
        options.maxTokens !== undefined &&
        options.maxTokens > modelMaxOutputTokens
      ) {
        throw new ElizaError(
          `Requested ${options.maxTokens} output tokens for Anthropic model ${this.model}, which supports at most ${modelMaxOutputTokens}`,
          {
            code: "VISION_OUTPUT_BUDGET_UNSUPPORTED",
            context: {
              model: this.model,
              requestedMaxTokens: options.maxTokens,
              supportedMaxTokens: modelMaxOutputTokens,
            },
          },
        );
      }
      const response = await fetchWithTimeout(
        "https://api.anthropic.com/v1/messages",
        {
          signal: options.signal,

          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: options.maxTokens ?? modelMaxOutputTokens,
            messages: [
              {
                role: "user",
                content: [
                  { type: "image", source: imageSource },
                  {
                    type: "text",
                    text: options.prompt ?? "Describe this image in detail.",
                  },
                ],
              },
            ],
          }),
        },
      );

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Anthropic error: ${text}` };
      }

      const data = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
        stop_reason?: string;
      };
      if (data.stop_reason === "max_tokens") {
        return {
          success: false,
          error:
            "Anthropic returned an incomplete vision description after reaching max_tokens",
        };
      }
      const textBlock = data.content?.find((c) => c.type === "text");
      if (!textBlock?.text) {
        return {
          success: false,
          error: "No description returned from Anthropic",
        };
      }

      return {
        success: true,
        data: { description: textBlock.text },
      };
    });
  }
}
