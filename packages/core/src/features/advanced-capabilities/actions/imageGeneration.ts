import { v4 } from "uuid";
import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import {
	collectKeywordTermMatches,
	getValidationKeywordTerms,
} from "../../../i18n/validation-keywords.ts";
import { logger } from "../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { ContentType, ModelType } from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";

// Get text content from centralized specs
const spec = requireActionSpec("GENERATE_IMAGE");
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const IMAGE_STRONG_TERMS = getValidationKeywordTerms(
	"action.generateImage.strong",
	{
		includeAllLocales: true,
	},
);
const IMAGE_WEAK_TERMS = getValidationKeywordTerms(
	"action.generateImage.weak",
	{
		includeAllLocales: true,
	},
);

const getFileExtension = (url: string): string => {
	const urlPath = new URL(url).pathname;
	const lastDot = urlPath.lastIndexOf(".");
	if (lastDot === -1 || lastDot === urlPath.length - 1) {
		return "png";
	}
	const extension = urlPath.slice(lastDot + 1).toLowerCase();
	return IMAGE_EXTENSIONS.has(extension) ? extension : "png";
};

function readImagePrompt(
	message: Memory,
	options?: HandlerOptions,
): string | undefined {
	const params =
		options?.parameters && typeof options.parameters === "object"
			? (options.parameters as Record<string, unknown>)
			: {};
	const prompt = params.prompt ?? message.content.prompt;
	if (typeof prompt === "string" && prompt.trim()) return prompt.trim();
	const text = message.content.text;
	return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

function hasImageGenerationModel(runtime: IAgentRuntime): boolean {
	return typeof runtime.getModel(ModelType.IMAGE) === "function";
}

export const generateImageAction = {
	name: spec.name,
	contexts: ["media", "files"],
	roleGate: { minRole: "USER" },
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
	) => {
		if (!hasImageGenerationModel(_runtime)) return false;
		const prompt = readImagePrompt(message, options);
		if (prompt && options?.parameters) return true;
		const text =
			typeof message?.content === "string"
				? message.content
				: (message?.content?.text ?? "");
		if (!text) return false;
		if (collectKeywordTermMatches([text], IMAGE_STRONG_TERMS).size > 0) {
			return true;
		}
		return (
			collectKeywordTermMatches([text], IMAGE_WEAK_TERMS).size > 0 ||
			hasActionContextOrKeyword(message, _state, {
				contexts: ["media", "files"],
				keywords: ["generate image", "create image", "draw", "make a picture"],
			})
		);
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
		_responses?: Memory[],
	): Promise<ActionResult> => {
		const imagePrompt = readImagePrompt(message, _options);
		if (!imagePrompt) {
			return {
				text: "Image prompt is required",
				values: { success: false, error: "MISSING_PROMPT" },
				data: { actionName: "GENERATE_IMAGE", error: "Missing prompt" },
				success: false,
			};
		}
		if (!hasImageGenerationModel(runtime)) {
			return {
				text: "Image generation is not configured",
				values: { success: false, error: "IMAGE_MODEL_UNAVAILABLE" },
				data: {
					actionName: "GENERATE_IMAGE",
					error: "No image generation model is registered",
				},
				success: false,
			};
		}

		const imageResponse = await runtime.useModel(ModelType.IMAGE, {
			prompt: imagePrompt,
		});
		const imageResults = Array.isArray(imageResponse)
			? imageResponse
			: typeof imageResponse === "string"
				? [imageResponse]
				: [];
		const firstImage = imageResults[0];
		const firstImageUrl =
			typeof firstImage === "string" ? firstImage : firstImage?.url;

		if (imageResults.length === 0 || !firstImageUrl) {
			logger.error(
				{
					src: "plugin:advanced-capabilities:action:image_generation",
					agentId: runtime.agentId,
					imagePrompt,
				},
				"Image generation failed - no valid response received",
			);
			return {
				text: "Image generation failed",
				values: {
					success: false,
					error: "IMAGE_GENERATION_FAILED",
					prompt: imagePrompt,
				},
				data: {
					actionName: "GENERATE_IMAGE",
					prompt: imagePrompt,
					rawResponse: imageResults.map((image) => ({
						url: typeof image === "string" ? image : image.url,
					})),
				},
				success: false,
			};
		}

		const imageUrl = firstImageUrl;

		logger.info(
			{
				src: "plugin:advanced-capabilities:action:image_generation",
				agentId: runtime.agentId,
				imageUrl,
			},
			"Received image URL",
		);

		const extension = getFileExtension(imageUrl);
		const timestamp = new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.slice(0, 19);
		const fileName = `Generated_Image_${timestamp}.${extension}`;
		const attachmentId = v4();

		const responseContent = {
			attachments: [
				{
					id: attachmentId,
					url: imageUrl,
					title: fileName,
					contentType: ContentType.IMAGE,
				},
			],
			thought: `Generated an image based on: "${imagePrompt}"`,
			actions: ["GENERATE_IMAGE"],
			text: imagePrompt,
		};

		if (callback) {
			await callback(responseContent);
		}

		return {
			text: "Generated image",
			values: {
				success: true,
				imageGenerated: true,
				imageUrl,
				prompt: imagePrompt,
			},
			data: {
				actionName: "GENERATE_IMAGE",
				imageUrl,
				prompt: imagePrompt,
			},
			success: true,
		};
	},
	parameters: [
		{
			name: "prompt",
			description: "Detailed image generation prompt.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
	],
	examples: (spec.examples ?? []) as ActionExample[][],
} as Action;
