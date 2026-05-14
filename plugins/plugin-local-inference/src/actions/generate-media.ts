/**
 * @module plugin-local-inference/actions/generate-media
 *
 * Unified `GENERATE_MEDIA` agent action.
 *
 * Routes a single user-facing intent to the appropriate `runtime.useModel(...)`
 * call:
 *
 *   - image  → `ModelType.IMAGE`            (WS3 arbiter, returns PNG bytes)
 *   - audio  → `ModelType.TEXT_TO_SPEECH`   (Eliza-1 / local TTS, returns PCM/WAV/MP3)
 *   - video  → not yet supported; refuses with a clean message
 *
 * Intent classification is keyword-first (cheap, deterministic) with an
 * optional `ModelType.TEXT_SMALL` JSON fallback for ambiguous prompts. The
 * prompt body is extracted by stripping any leading imperative ("draw me a ",
 * "say ", "speak in spanish: ") so that downstream models see a clean
 * description.
 *
 * Trajectory hook: result `data.computerUseAction` is set to a stable
 * marker (`GENERATE_MEDIA_IMAGE` / `GENERATE_MEDIA_AUDIO`) so the trajectory
 * logger picks the action up exactly the way it picks up
 * `plugin-computeruse` actions.
 */

import {
	type Action,
	type ActionResult,
	type Content,
	ContentType,
	type HandlerCallback,
	type IAgentRuntime,
	type ImageGenerationResult,
	logger,
	type Media,
	type Memory,
	ModelType,
} from "@elizaos/core";

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

export type MediaKind = "image" | "audio" | "video";

interface IntentDetection {
	kind: MediaKind;
	prompt: string;
	source: "keyword" | "classifier";
}

interface KeywordRule {
	kind: MediaKind;
	pattern: RegExp;
	/** Optional explicit strip pattern to remove the leading imperative. */
	strip?: RegExp;
}

/**
 * Keyword rules, ordered most-specific-first. Matching is case-insensitive
 * and anchored to the start of a sanitized prompt (after lowercase + trim).
 * Each rule maps to a media kind and optionally strips a leading imperative
 * from the prompt before dispatch.
 */
const KEYWORD_RULES: readonly KeywordRule[] = [
	// Image rules (most-common first).
	{
		kind: "image",
		pattern: /\b(draw|sketch|paint|illustrate)\b/i,
		strip:
			/^\s*(please\s+)?(draw|sketch|paint|illustrate)(\s+me)?(\s+an?)?\s+(of\s+)?/i,
	},
	{
		kind: "image",
		pattern:
			/\b(generate|create|make)\s+(an?\s+|the\s+)?(image|picture|photo|photograph|drawing|illustration)\b/i,
		strip:
			/^\s*(please\s+)?(generate|create|make)\s+(an?\s+|the\s+)?(image|picture|photo|photograph|drawing|illustration)(\s+of)?\s*/i,
	},
	{
		kind: "image",
		pattern: /\b(image|picture|photo|photograph)\s+of\b/i,
		strip: /^\s*(an?\s+|the\s+)?(image|picture|photo|photograph)\s+of\s+/i,
	},
	{
		kind: "image",
		pattern: /\brender\b/i,
		strip: /^\s*(please\s+)?render(\s+me)?(\s+an?)?\s+(of\s+)?/i,
	},
	// Audio rules.
	{
		kind: "audio",
		pattern: /\b(say|speak|read\s+aloud|read\s+out|narrate)\b/i,
		strip:
			/^\s*(please\s+)?(say|speak|read\s+aloud|read\s+out|narrate)(\s+aloud)?(\s+this)?(\s+in\s+\w+)?[:,]?\s+/i,
	},
	{
		kind: "audio",
		pattern: /\b(text\s*to\s*speech|tts|voice\s+this|voice\s+over)\b/i,
		strip:
			/^\s*(please\s+)?(do\s+)?(text\s*to\s*speech|tts|voice\s+this|voice\s+over)[:,]?\s*/i,
	},
	{
		kind: "audio",
		pattern: /\bgenerate\s+(an?\s+|some\s+)?(audio|speech|voice)\b/i,
		strip:
			/^\s*(please\s+)?generate\s+(an?\s+|some\s+)?(audio|speech|voice)\s+(of|for|saying)?\s*/i,
	},
	// Video rules. We detect them only to refuse cleanly.
	{
		kind: "video",
		pattern: /\b(video|animate|animation|movie|clip)\b/i,
		strip:
			/^\s*(please\s+)?(generate|create|make|render)?\s*(an?\s+|the\s+)?(video|animation|movie|clip)(\s+of)?\s*/i,
	},
];

type ClassifierFn = (prompt: string) => Promise<MediaKind | null>;

export interface IntentDetectorOptions {
	/**
	 * Optional override for the text-classifier fallback. Tests inject a
	 * deterministic stub; in production this is bound to
	 * `runtime.useModel(ModelType.TEXT_SMALL, ...)`.
	 */
	classifier?: ClassifierFn;
}

function stripPrompt(rule: KeywordRule, text: string): string {
	if (!rule.strip) return text.trim();
	return text.replace(rule.strip, "").trim();
}

function tryKeywordMatch(text: string): IntentDetection | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	for (const rule of KEYWORD_RULES) {
		if (rule.pattern.test(trimmed)) {
			const prompt = stripPrompt(rule, trimmed);
			return {
				kind: rule.kind,
				prompt: prompt || trimmed,
				source: "keyword",
			};
		}
	}
	return null;
}

/**
 * Detect the media intent from a user message.
 *
 * Algorithm:
 *   1. Try keyword rules first (cheap, deterministic).
 *   2. If nothing matched and a classifier is provided, ask it for a JSON
 *      label. Trust the classifier only when it returns one of our three
 *      kinds; otherwise return `null` so the caller can decline.
 */
export async function detectMediaIntent(
	text: string,
	options: IntentDetectorOptions = {},
): Promise<IntentDetection | null> {
	const keyword = tryKeywordMatch(text);
	if (keyword) return keyword;
	if (!options.classifier) return null;
	const label = await options.classifier(text);
	if (label === "image" || label === "audio" || label === "video") {
		return { kind: label, prompt: text.trim(), source: "classifier" };
	}
	return null;
}

const CLASSIFIER_INSTRUCTION = [
	"Classify the following user message into exactly one media kind:",
	'  - "image" if the user wants a picture, drawing, photo, or rendering.',
	'  - "audio" if the user wants speech, narration, or text-to-speech output.',
	'  - "video" if the user wants a video, animation, or motion clip.',
	'Respond with ONLY a JSON object of the form {"kind":"image"} (one key).',
	'If the request is none of these, respond with {"kind":"none"}.',
	"",
	"User message:",
].join("\n");

function parseClassifierOutput(raw: string): MediaKind | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const match = trimmed.match(/\{[\s\S]*\}/);
	if (!match) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[0]);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const kind = (parsed as { kind?: unknown }).kind;
	if (kind === "image" || kind === "audio" || kind === "video") return kind;
	return null;
}

function makeRuntimeClassifier(runtime: IAgentRuntime): ClassifierFn {
	return async (prompt) => {
		const response = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: `${CLASSIFIER_INSTRUCTION}${prompt}`,
			maxTokens: 32,
			temperature: 0,
		});
		return parseClassifierOutput(response);
	};
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

interface DispatchSuccessImage {
	kind: "image";
	bytes: Uint8Array;
	mime: "image/png" | "image/jpeg";
	url: string;
}

interface DispatchSuccessAudio {
	kind: "audio";
	bytes: Uint8Array;
	mime: "audio/wav" | "audio/mpeg" | "audio/pcm";
	url: string;
}

type DispatchSuccess = DispatchSuccessImage | DispatchSuccessAudio;

function normalizeAudioBytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}
	if (
		typeof Buffer !== "undefined" &&
		value !== null &&
		typeof value === "object" &&
		value instanceof Buffer
	) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	throw new Error(
		"[generate-media] TEXT_TO_SPEECH backend returned non-binary audio output",
	);
}

function detectAudioMime(bytes: Uint8Array): DispatchSuccessAudio["mime"] {
	if (bytes.length >= 4) {
		// "RIFF" header → WAV.
		if (
			bytes[0] === 0x52 &&
			bytes[1] === 0x49 &&
			bytes[2] === 0x46 &&
			bytes[3] === 0x46
		) {
			return "audio/wav";
		}
		// "ID3" → MP3 with ID3 tag.
		if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
			return "audio/mpeg";
		}
		// MP3 frame sync (0xFFE0 mask).
		if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
			return "audio/mpeg";
		}
	}
	return "audio/pcm";
}

function detectImageMimeFromDataUrl(
	url: string,
): { mime: "image/png" | "image/jpeg"; bytes: Uint8Array } | null {
	const match = url.match(/^data:(image\/(?:png|jpeg));base64,(.*)$/);
	if (!match) return null;
	const mime = match[1] === "image/jpeg" ? "image/jpeg" : "image/png";
	const bytes = new Uint8Array(Buffer.from(match[2], "base64"));
	return { mime, bytes };
}

async function dispatchImage(
	runtime: IAgentRuntime,
	prompt: string,
): Promise<DispatchSuccessImage> {
	const results = (await runtime.useModel(ModelType.IMAGE, {
		prompt,
		count: 1,
	})) as ImageGenerationResult[];
	const first = Array.isArray(results) ? results[0] : null;
	if (!first || typeof first.url !== "string" || first.url.length === 0) {
		throw new Error(
			"[generate-media] IMAGE backend returned no result; expected ImageGenerationResult[]",
		);
	}
	const parsed = detectImageMimeFromDataUrl(first.url);
	if (parsed) {
		return {
			kind: "image",
			bytes: parsed.bytes,
			mime: parsed.mime,
			url: first.url,
		};
	}
	// Backend returned a non-data URL (e.g. CDN). Surface as-is; consumers
	// can fetch it. Bytes are absent in that path.
	return {
		kind: "image",
		bytes: new Uint8Array(0),
		mime: "image/png",
		url: first.url,
	};
}

async function dispatchAudio(
	runtime: IAgentRuntime,
	text: string,
): Promise<DispatchSuccessAudio> {
	const raw = (await runtime.useModel(ModelType.TEXT_TO_SPEECH, {
		text,
	})) as unknown;
	const bytes = normalizeAudioBytes(raw);
	if (bytes.length === 0) {
		throw new Error(
			"[generate-media] TEXT_TO_SPEECH backend returned an empty buffer",
		);
	}
	const mime = detectAudioMime(bytes);
	const base64 = Buffer.from(bytes).toString("base64");
	return {
		kind: "audio",
		bytes,
		mime,
		url: `data:${mime};base64,${base64}`,
	};
}

// ---------------------------------------------------------------------------
// Attachment shaping
// ---------------------------------------------------------------------------

function uuidLike(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	// Fallback for environments without crypto.randomUUID (shouldn't happen
	// on Node 20+); produces a stable shape so attachment IDs stay unique.
	return `gen-media-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeAttachment(success: DispatchSuccess, prompt: string): Media {
	const contentType =
		success.kind === "image" ? ContentType.IMAGE : ContentType.AUDIO;
	return {
		id: uuidLike(),
		url: success.url,
		title: success.kind === "image" ? "Generated image" : "Generated audio",
		source: "generate-media",
		description: prompt,
		contentType,
	};
}

// ---------------------------------------------------------------------------
// Message-text extraction
// ---------------------------------------------------------------------------

function extractMessageText(message: Memory | null | undefined): string {
	const text = message?.content?.text;
	return typeof text === "string" ? text : "";
}

// ---------------------------------------------------------------------------
// Action definition
// ---------------------------------------------------------------------------

interface BuildHandlerOptions {
	/** Test seam: override the intent detector. */
	detectIntent?: typeof detectMediaIntent;
	/** Test seam: override the classifier resolver. */
	classifierFactory?: (runtime: IAgentRuntime) => ClassifierFn;
}

export function buildGenerateMediaHandler(opts: BuildHandlerOptions = {}) {
	const detect = opts.detectIntent ?? detectMediaIntent;
	const classifierFactory = opts.classifierFactory ?? makeRuntimeClassifier;
	return async function generateMediaHandler(
		runtime: IAgentRuntime,
		message: Memory,
		_state?: unknown,
		_options?: unknown,
		callback?: HandlerCallback,
	): Promise<ActionResult> {
		const raw = extractMessageText(message);
		if (!raw.trim()) {
			const errText =
				"GENERATE_MEDIA requires a non-empty message describing what to generate.";
			await callback?.({ text: errText });
			return {
				success: false,
				text: errText,
				error: errText,
				data: {
					source: "generate-media",
					computerUseAction: "GENERATE_MEDIA_INVALID",
				},
			};
		}

		let intent: IntentDetection | null;
		try {
			intent = await detect(raw, { classifier: classifierFactory(runtime) });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn({ err: msg }, "[generate-media] intent detection failed");
			const errText = `Could not classify media request: ${msg}`;
			await callback?.({ text: errText });
			return {
				success: false,
				text: errText,
				error: errText,
				data: {
					source: "generate-media",
					computerUseAction: "GENERATE_MEDIA_CLASSIFY_FAILED",
				},
			};
		}

		if (!intent) {
			const errText =
				'I couldn\'t tell whether you wanted an image, audio, or video. Try "draw me ...", "say ...", or describe the picture you want.';
			await callback?.({ text: errText });
			return {
				success: false,
				text: errText,
				error: errText,
				data: {
					source: "generate-media",
					computerUseAction: "GENERATE_MEDIA_AMBIGUOUS",
				},
			};
		}

		if (intent.kind === "video") {
			const errText = "Video generation is not yet supported. Coming soon.";
			await callback?.({ text: errText });
			return {
				success: false,
				text: errText,
				error: errText,
				data: {
					source: "generate-media",
					computerUseAction: "GENERATE_MEDIA_VIDEO_UNSUPPORTED",
					detectedKind: intent.kind,
					detectedSource: intent.source,
				},
			};
		}

		if (!intent.prompt) {
			const errText = `Detected a ${intent.kind} request but couldn't extract a prompt.`;
			await callback?.({ text: errText });
			return {
				success: false,
				text: errText,
				error: errText,
				data: {
					source: "generate-media",
					computerUseAction: "GENERATE_MEDIA_EMPTY_PROMPT",
					detectedKind: intent.kind,
				},
			};
		}

		try {
			const result =
				intent.kind === "image"
					? await dispatchImage(runtime, intent.prompt)
					: await dispatchAudio(runtime, intent.prompt);
			const attachment = makeAttachment(result, intent.prompt);
			const narration =
				result.kind === "image"
					? "Here's the image you asked for."
					: "Here's the audio you asked for.";
			const responseContent: Content = {
				text: narration,
				attachments: [attachment],
				source: "generate-media",
			};
			await callback?.(responseContent);
			return {
				success: true,
				text: narration,
				userFacingText: narration,
				values: {
					mediaKind: result.kind,
					mediaMime: result.mime,
				},
				data: {
					source: "generate-media",
					computerUseAction:
						result.kind === "image"
							? "GENERATE_MEDIA_IMAGE"
							: "GENERATE_MEDIA_AUDIO",
					detectedKind: intent.kind,
					detectedSource: intent.source,
					prompt: intent.prompt,
					mime: result.mime,
					byteLength: result.bytes.byteLength,
					attachmentId: attachment.id,
					attachmentUrl: attachment.url,
				},
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn(
				{ err: msg, kind: intent.kind },
				"[generate-media] dispatch failed",
			);
			const errText =
				intent.kind === "image"
					? `Image generation failed: ${msg}`
					: `Audio generation failed: ${msg}`;
			await callback?.({ text: errText });
			return {
				success: false,
				text: errText,
				error: err instanceof Error ? err : new Error(msg),
				data: {
					source: "generate-media",
					computerUseAction:
						intent.kind === "image"
							? "GENERATE_MEDIA_IMAGE_FAILED"
							: "GENERATE_MEDIA_AUDIO_FAILED",
					detectedKind: intent.kind,
					detectedSource: intent.source,
					prompt: intent.prompt,
				},
			};
		}
	};
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

async function validate(
	_runtime: IAgentRuntime,
	message: Memory,
): Promise<boolean> {
	// Cheap pre-validation: any non-empty text message is a candidate. The
	// keyword + classifier run inside the handler so the planner can pick
	// GENERATE_MEDIA without paying the classifier cost upfront.
	return extractMessageText(message).trim().length > 0;
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

export const generateMediaAction: Action = {
	name: "GENERATE_MEDIA",
	similes: [
		"DRAW_IMAGE",
		"MAKE_PICTURE",
		"CREATE_IMAGE",
		"RENDER_IMAGE",
		"SPEAK",
		"SAY_ALOUD",
		"TEXT_TO_SPEECH",
		"GENERATE_AUDIO",
		"GENERATE_VIDEO",
	],
	description:
		"Generate an image, audio (TTS), or video from a natural-language prompt. Routes to the appropriate local model via the runtime model registry. Video is not yet supported and is refused cleanly.",
	descriptionCompressed:
		"GENERATE_MEDIA image|audio|future-video prompt; routes IMAGE|TEXT_TO_SPEECH",
	routingHint:
		"explicit ask to draw/picture/photo/say/speak/read-aloud/animate -> GENERATE_MEDIA; not for general text replies",
	suppressPostActionContinuation: true,
	validate,
	handler: buildGenerateMediaHandler(),
	examples: [
		[
			{
				name: "{{user1}}",
				content: { text: "Draw me a sunset over a mountain lake." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Here's the image you asked for.",
					actions: ["GENERATE_MEDIA"],
				},
			},
		],
		[
			{
				name: "{{user1}}",
				content: { text: "Say hello in spanish." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Here's the audio you asked for.",
					actions: ["GENERATE_MEDIA"],
				},
			},
		],
		[
			{
				name: "{{user1}}",
				content: { text: "Generate a picture of a cyberpunk city at night." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Here's the image you asked for.",
					actions: ["GENERATE_MEDIA"],
				},
			},
		],
		[
			{
				name: "{{user1}}",
				content: { text: "Make a 10-second video of a cat dancing." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Video generation is not yet supported. Coming soon.",
					actions: ["GENERATE_MEDIA"],
				},
			},
		],
	],
};

export default generateMediaAction;
