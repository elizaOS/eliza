/**
 * Browser-unavailable Capacitor-llama adapter. Browsers cannot run
 * `libllama.so` directly; callers should proxy through a server or switch
 * providers. All model handlers throw with a clear message.
 */

import type {
	GenerateTextParams,
	IAgentRuntime,
	ImageDescriptionParams,
	Plugin,
	TextEmbeddingParams,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";

type ImageDescriptionResult = { title: string; description: string };

const pluginName = "local-ai";
const unsupportedMessage =
	"Local AI is not supported in browsers. Use a server proxy or switch providers.";

const warnUnsupported = (modelType: string): void => {
	logger.warn(
		`[plugin-${pluginName}] ${modelType} is not available in browsers.`,
	);
};

const unsupportedText = (
	modelType: string,
	params?: GenerateTextParams,
): string => {
	warnUnsupported(modelType);
	if (params && (params.tools || params.responseSchema || params.toolChoice)) {
		throw new Error(
			`[plugin-${pluginName}] Tool calling and structured output require the Node/Bun or Capacitor mobile runtime. ` +
				"Browsers cannot execute llama.cpp directly — switch providers or proxy through a server.",
		);
	}
	return unsupportedMessage;
};

const unsupportedImageDescription = (
	modelType: string,
): ImageDescriptionResult => {
	warnUnsupported(modelType);
	throw new Error(`[plugin-${pluginName}] ${modelType}: ${unsupportedMessage}`);
};

export const localAiPlugin: Plugin = {
	name: pluginName,
	description: "Local AI plugin (unavailable in browsers; use a server proxy)",
	async init(_config, _runtime: IAgentRuntime): Promise<void> {
		logger.warn(
			`[plugin-${pluginName}] Capacitor-llama adapter is not supported directly in browsers.`,
		);
	},
	models: {
		[ModelType.TEXT_SMALL]: async (
			_runtime: IAgentRuntime,
			params: GenerateTextParams,
		): Promise<string> => unsupportedText(ModelType.TEXT_SMALL, params),
		[ModelType.TEXT_LARGE]: async (
			_runtime: IAgentRuntime,
			params: GenerateTextParams,
		): Promise<string> => unsupportedText(ModelType.TEXT_LARGE, params),
		[ModelType.TEXT_EMBEDDING]: async (
			_runtime: IAgentRuntime,
			_params: TextEmbeddingParams | string | null,
		): Promise<number[]> => {
			warnUnsupported(ModelType.TEXT_EMBEDDING);
			throw new Error(
				`[plugin-${pluginName}] ${ModelType.TEXT_EMBEDDING}: ${unsupportedMessage}`,
			);
		},
		[ModelType.IMAGE_DESCRIPTION]: async (
			_runtime: IAgentRuntime,
			_params: ImageDescriptionParams | string,
		): Promise<ImageDescriptionResult> =>
			unsupportedImageDescription(ModelType.IMAGE_DESCRIPTION),
	},
};

export default localAiPlugin;
