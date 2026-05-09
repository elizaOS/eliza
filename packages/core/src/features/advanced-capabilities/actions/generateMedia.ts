import { v4 } from "uuid";
import type { ActionDoc } from "../../../generated/action-docs.ts";
import { getActionSpec } from "../../../generated/spec-helpers.ts";
import { logger } from "../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	IMediaGenerationService,
	MediaGenerationAudioKind,
	MediaGenerationMediaType,
	MediaGenerationRequest,
	MediaGenerationResponse,
	Memory,
	State,
} from "../../../types/index.ts";
import { ContentType, ModelType, ServiceType } from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";

const spec: ActionDoc = getActionSpec("GENERATE_MEDIA") ?? {
	name: "GENERATE_MEDIA",
	description:
		"Generate or process images, audio, or video from a user prompt.",
	descriptionCompressed: "generate media image audio video prompt",
	similes: [
		"GENERATE_IMAGE",
		"CREATE_IMAGE",
		"GENERATE_VIDEO",
		"GENERATE_AUDIO",
	],
};

const MEDIA_CONTEXTS = ["media", "files"] as const;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "ogg", "opus"]);

function readParams(options?: HandlerOptions): Record<string, unknown> {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: {};
}

function messageText(message: Memory): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return typeof content?.text === "string" ? content.text : "";
}

function readPrompt(
	message: Memory,
	options?: HandlerOptions,
): string | undefined {
	const params = readParams(options);
	const prompt = params.prompt ?? message.content.prompt;
	if (typeof prompt === "string" && prompt.trim()) return prompt.trim();
	const text = messageText(message);
	return text.trim() ? text.trim() : undefined;
}

function readStringParam(
	params: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = params[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumberParam(
	params: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = params[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function readBooleanParam(
	params: Record<string, unknown>,
	key: string,
): boolean | undefined {
	const value = params[key];
	return typeof value === "boolean" ? value : undefined;
}

function normalizeMediaType(
	value: unknown,
): MediaGenerationMediaType | undefined {
	if (value === "image" || value === "video" || value === "audio") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "image" ||
		normalized === "video" ||
		normalized === "audio"
	) {
		return normalized;
	}
	return undefined;
}

function normalizeAudioKind(
	value: unknown,
): MediaGenerationAudioKind | undefined {
	if (value === "music" || value === "sfx" || value === "tts") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "music" || normalized === "sfx" || normalized === "tts") {
		return normalized;
	}
	if (normalized === "sound_effect" || normalized === "sound-effect")
		return "sfx";
	if (
		normalized === "speech" ||
		normalized === "voice" ||
		normalized === "voiceover"
	) {
		return "tts";
	}
	return undefined;
}

function inferMediaType(
	params: Record<string, unknown>,
	text: string,
): MediaGenerationMediaType {
	const explicit = normalizeMediaType(params.mediaType);
	if (explicit) return explicit;

	const lower = text.toLowerCase();
	if (/\b(video|clip|film|movie|animate|animation)\b/.test(lower))
		return "video";
	if (
		/\b(audio|music|song|sound effect|sfx|tts|text to speech|speech|voiceover|beat|track|compose)\b/.test(
			lower,
		)
	) {
		return "audio";
	}
	return "image";
}

function inferAudioKind(
	params: Record<string, unknown>,
	text: string,
): MediaGenerationAudioKind | undefined {
	const explicit = normalizeAudioKind(params.audioKind ?? params.kind);
	if (explicit) return explicit;

	const lower = text.toLowerCase();
	if (/\b(sound effect|sfx|foley)\b/.test(lower)) return "sfx";
	if (
		/\b(tts|text to speech|speech|voiceover|narrat(e|ion)|say this)\b/.test(
			lower,
		)
	) {
		return "tts";
	}
	if (/\b(music|song|instrumental|beat|track|compose)\b/.test(lower)) {
		return "music";
	}
	return undefined;
}

function buildRequest(
	message: Memory,
	options?: HandlerOptions,
): MediaGenerationRequest | null {
	const params = readParams(options);
	const prompt = readPrompt(message, options);
	if (!prompt) return null;

	const mediaType = inferMediaType(params, prompt);
	return {
		mediaType,
		prompt,
		audioKind:
			mediaType === "audio"
				? (inferAudioKind(params, prompt) ?? "music")
				: undefined,
		size: readStringParam(params, "size"),
		quality:
			params.quality === "standard" || params.quality === "hd"
				? params.quality
				: undefined,
		style:
			params.style === "natural" || params.style === "vivid"
				? params.style
				: undefined,
		negativePrompt: readStringParam(params, "negativePrompt"),
		seed: readNumberParam(params, "seed"),
		duration: readNumberParam(params, "duration"),
		aspectRatio: readStringParam(params, "aspectRatio"),
		imageUrl: readStringParam(params, "imageUrl"),
		instrumental: readBooleanParam(params, "instrumental"),
		genre: readStringParam(params, "genre"),
		voice: readStringParam(params, "voice"),
	};
}

function contentTypeFor(mediaType: MediaGenerationMediaType): ContentType {
	if (mediaType === "video") return ContentType.VIDEO;
	if (mediaType === "audio") return ContentType.AUDIO;
	return ContentType.IMAGE;
}

function defaultMimeType(mediaType: MediaGenerationMediaType): string {
	if (mediaType === "video") return "video/mp4";
	if (mediaType === "audio") return "audio/mpeg";
	return "image/png";
}

function resultUrl(result: MediaGenerationResponse): string | undefined {
	if (result.url) return result.url;
	if (result.mediaType === "image") {
		if (result.imageUrl) return result.imageUrl;
		if (result.imageBase64)
			return `data:image/png;base64,${result.imageBase64}`;
	}
	if (result.mediaType === "video") return result.videoUrl;
	return result.audioUrl;
}

function extensionFor(
	url: string,
	mediaType: MediaGenerationMediaType,
): string {
	if (url.startsWith("data:image/")) return "png";
	if (url.startsWith("data:audio/")) return "mp3";
	if (url.startsWith("data:video/")) return "mp4";
	try {
		const extension =
			new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
		if (mediaType === "image" && IMAGE_EXTENSIONS.has(extension))
			return extension;
		if (mediaType === "video" && VIDEO_EXTENSIONS.has(extension))
			return extension;
		if (mediaType === "audio" && AUDIO_EXTENSIONS.has(extension))
			return extension;
	} catch {
		// Fall through to media defaults.
	}
	if (mediaType === "video") return "mp4";
	if (mediaType === "audio") return "mp3";
	return "png";
}

function titleFor(
	result: MediaGenerationResponse,
	request: MediaGenerationRequest,
	url: string,
): string {
	if (result.title?.trim()) return result.title.trim();
	const prefix =
		request.mediaType === "image"
			? "Generated_Image"
			: request.mediaType === "video"
				? "Generated_Video"
				: "Generated_Audio";
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	return `${prefix}_${timestamp}.${extensionFor(url, request.mediaType)}`;
}

async function fallbackGenerateImage(
	runtime: IAgentRuntime,
	request: MediaGenerationRequest,
): Promise<MediaGenerationResponse> {
	const imageResponse = await runtime.useModel(ModelType.IMAGE, {
		prompt: request.prompt,
		size: request.size,
		count: 1,
	});
	const imageResults = Array.isArray(imageResponse)
		? imageResponse
		: typeof imageResponse === "string"
			? [imageResponse]
			: [];
	const firstImage = imageResults[0];
	const firstImageUrl =
		typeof firstImage === "string" ? firstImage : firstImage?.url;
	if (!firstImageUrl) {
		throw new Error("Image generation failed - no valid response received");
	}
	return {
		mediaType: "image",
		imageUrl: firstImageUrl,
		url: firstImageUrl,
	};
}

async function generateWithService(
	runtime: IAgentRuntime,
	request: MediaGenerationRequest,
): Promise<MediaGenerationResponse> {
	const service = runtime.getService<IMediaGenerationService>(
		ServiceType.MEDIA_GENERATION,
	);
	if (service) return service.generateMedia(request);

	if (request.mediaType === "image") {
		return fallbackGenerateImage(runtime, request);
	}

	throw new Error(
		"Media generation service is not available for video or audio generation.",
	);
}

export const generateMediaAction = {
	name: spec.name,
	contexts: [...MEDIA_CONTEXTS],
	roleGate: { minRole: "USER" },
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	descriptionCompressed: spec.descriptionCompressed,
	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	) => {
		const params = readParams(options);
		const prompt = readPrompt(message, options);
		if (prompt && normalizeMediaType(params.mediaType)) return true;

		return hasActionContextOrKeyword(message, state, {
			contexts: [...MEDIA_CONTEXTS],
		});
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
		_responses?: Memory[],
	): Promise<ActionResult> => {
		const request = buildRequest(message, options);
		if (!request) {
			return {
				text: "Media prompt is required",
				values: { success: false, error: "MISSING_PROMPT" },
				data: { actionName: "GENERATE_MEDIA", error: "Missing prompt" },
				success: false,
			};
		}

		let result: MediaGenerationResponse;
		try {
			result = await generateWithService(runtime, request);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				{
					src: "plugin:advanced-capabilities:action:generate_media",
					agentId: runtime.agentId,
					mediaType: request.mediaType,
					error: errorMessage,
				},
				"Media generation failed",
			);
			return {
				text: `Media generation failed: ${errorMessage}`,
				values: {
					success: false,
					error: "MEDIA_GENERATION_FAILED",
					mediaType: request.mediaType,
					prompt: request.prompt,
				},
				data: {
					actionName: "GENERATE_MEDIA",
					mediaType: request.mediaType,
					prompt: request.prompt,
					error: errorMessage,
				},
				success: false,
			};
		}

		const url = resultUrl(result);
		if (!url) {
			return {
				text: "Media generation failed: no media URL returned",
				values: {
					success: false,
					error: "MEDIA_GENERATION_MISSING_URL",
					mediaType: request.mediaType,
					prompt: request.prompt,
				},
				data: {
					actionName: "GENERATE_MEDIA",
					mediaType: request.mediaType,
					prompt: request.prompt,
				},
				success: false,
			};
		}

		const title = titleFor(result, request, url);
		const attachment = {
			id: v4(),
			url,
			title,
			contentType: contentTypeFor(request.mediaType),
			description: result.revisedPrompt ?? request.prompt,
		};

		const label =
			request.mediaType === "image"
				? "image"
				: request.mediaType === "video"
					? "video"
					: request.audioKind === "tts"
						? "speech audio"
						: request.audioKind === "sfx"
							? "sound effect"
							: "audio";
		const responseText = `Generated ${label}`;
		const responseContent = {
			attachments: [attachment],
			thought: `Generated ${label} based on: "${request.prompt}"`,
			actions: ["GENERATE_MEDIA"],
			text: responseText,
		};

		if (callback) {
			await callback(responseContent);
		}

		return {
			text: responseText,
			values: {
				success: true,
				mediaGenerated: true,
				mediaType: request.mediaType,
				audioKind: request.audioKind,
				mediaUrl: url,
				prompt: request.prompt,
			},
			data: {
				actionName: "GENERATE_MEDIA",
				mediaType: request.mediaType,
				audioKind: request.audioKind,
				mediaUrl: url,
				imageUrl: result.imageUrl,
				imageBase64: result.imageBase64,
				videoUrl: result.videoUrl,
				audioUrl: result.audioUrl,
				thumbnailUrl: result.thumbnailUrl,
				revisedPrompt: result.revisedPrompt,
				title,
				duration: result.duration,
				mimeType: result.mimeType ?? defaultMimeType(request.mediaType),
				provider: result.provider,
				prompt: request.prompt,
			},
			success: true,
		};
	},
	parameters: [
		{
			name: "mediaType",
			description: "The kind of media to generate.",
			required: true,
			schema: {
				type: "string" as const,
				enum: ["image", "video", "audio"],
			},
		},
		{
			name: "prompt",
			description: "Detailed generation prompt describing the desired media.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
		{
			name: "audioKind",
			description: "For audio generation, choose music, sfx, or tts.",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["music", "sfx", "tts"],
			},
		},
		{
			name: "duration",
			description: "Optional target duration in seconds for video or audio.",
			required: false,
			schema: { type: "number" as const },
		},
		{
			name: "aspectRatio",
			description: "Optional video aspect ratio such as 16:9, 9:16, or 1:1.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "size",
			description: "Optional image size or image provider size preset.",
			required: false,
			schema: { type: "string" as const },
		},
	],
	examples: (spec.examples ?? []) as ActionExample[][],
} as Action;
