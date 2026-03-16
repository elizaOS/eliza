import type {
  GenerateTextParams,
  IAgentRuntime,
  ImageDescriptionParams,
  ObjectGenerationParams,
  Plugin,
  TextEmbeddingParams,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";

// Inline types for browser compatibility (avoid import resolution issues)
type ImageDescriptionResult = {
  title: string;
  description: string;
};

type ImageGenerationResult = {
  url: string;
};

const pluginName = "local-ai";
const unsupportedMessage =
  "Local AI is not supported in browsers. Use a server proxy or switch providers.";

const warnUnsupported = (modelType: string): void => {
  logger.warn(`[plugin-${pluginName}] ${modelType} is not available in browsers.`);
};

const unsupportedText = (modelType: string): string => {
  warnUnsupported(modelType);
  return unsupportedMessage;
};

const unsupportedObject = (modelType: string): Record<string, string> => {
  warnUnsupported(modelType);
  return { error: unsupportedMessage };
};

const unsupportedImageDescription = (modelType: string): ImageDescriptionResult => {
  warnUnsupported(modelType);
  return {
    title: "Unsupported",
    description: unsupportedMessage,
  };
};

export const localAiPlugin: Plugin = {
  name: pluginName,
  description: "Local AI plugin (browser stub; use a server proxy)",
  async init(_config, _runtime: IAgentRuntime): Promise<void> {
    logger.warn(
      `[plugin-${pluginName}] This plugin is not supported directly in browsers. Use a server proxy.`
    );
  },
  models: {
    [ModelType.TEXT_SMALL]: async (
      _runtime: IAgentRuntime,
      _params: GenerateTextParams
    ): Promise<string> => unsupportedText(ModelType.TEXT_SMALL),
    [ModelType.TEXT_LARGE]: async (
      _runtime: IAgentRuntime,
      _params: GenerateTextParams
    ): Promise<string> => unsupportedText(ModelType.TEXT_LARGE),
    [ModelType.TEXT_REASONING_SMALL]: async (
      _runtime: IAgentRuntime,
      _params: GenerateTextParams
    ): Promise<string> => unsupportedText(ModelType.TEXT_REASONING_SMALL),
    [ModelType.TEXT_REASONING_LARGE]: async (
      _runtime: IAgentRuntime,
      _params: GenerateTextParams
    ): Promise<string> => unsupportedText(ModelType.TEXT_REASONING_LARGE),
    [ModelType.TEXT_COMPLETION]: async (
      _runtime: IAgentRuntime,
      _params: GenerateTextParams
    ): Promise<string> => unsupportedText(ModelType.TEXT_COMPLETION),
    [ModelType.TEXT_EMBEDDING]: async (
      _runtime: IAgentRuntime,
      _params: TextEmbeddingParams | string | null
    ): Promise<number[]> => {
      warnUnsupported(ModelType.TEXT_EMBEDDING);
      return new Array(384).fill(0);
    },
    [ModelType.TEXT_TOKENIZER_ENCODE]: async (): Promise<number[]> => {
      warnUnsupported(ModelType.TEXT_TOKENIZER_ENCODE);
      return [];
    },
    [ModelType.TEXT_TOKENIZER_DECODE]: async (): Promise<string> => {
      warnUnsupported(ModelType.TEXT_TOKENIZER_DECODE);
      return "";
    },
    [ModelType.OBJECT_SMALL]: async (
      _runtime: IAgentRuntime,
      _params: ObjectGenerationParams
    ): Promise<Record<string, string>> => unsupportedObject(ModelType.OBJECT_SMALL),
    [ModelType.OBJECT_LARGE]: async (
      _runtime: IAgentRuntime,
      _params: ObjectGenerationParams
    ): Promise<Record<string, string>> => unsupportedObject(ModelType.OBJECT_LARGE),
    [ModelType.IMAGE_DESCRIPTION]: async (
      _runtime: IAgentRuntime,
      _params: ImageDescriptionParams | string
    ): Promise<ImageDescriptionResult> => unsupportedImageDescription(ModelType.IMAGE_DESCRIPTION),
    [ModelType.TRANSCRIPTION]: async (): Promise<string> =>
      unsupportedText(ModelType.TRANSCRIPTION),
    [ModelType.TEXT_TO_SPEECH]: async (): Promise<Uint8Array> => {
      warnUnsupported(ModelType.TEXT_TO_SPEECH);
      return new Uint8Array();
    },
    [ModelType.IMAGE]: async (): Promise<ImageGenerationResult[]> => {
      warnUnsupported(ModelType.IMAGE);
      return [];
    },
  },
};

export default localAiPlugin;
