/**
 * Compatibility intent adapters for callers of the former local media action.
 * Registered media behavior belongs to the assistant; local inference supplies
 * model handlers. Legacy helpers delegate generation and delivery to that action.
 */
import {
	type ActionResult,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	ModelType,
} from "@elizaos/core";
import { generateMediaAction } from "@elizaos/plugin-assistant/actions/generate-media";

export { generateMediaAction };

export type MediaKind = "image" | "audio" | "video";

interface IntentDetection {
	kind: MediaKind;
	prompt: string;
	source: "keyword" | "classifier";
}

interface KeywordRule {
	kind: MediaKind;
	pattern: RegExp;
	/** Explicit strip pattern to remove the leading imperative. */
	strip: RegExp;
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
	 * deterministic classifier; in production this is bound to
	 * `runtime.useModel(ModelType.TEXT_SMALL, ...)`.
	 */
	classifier?: ClassifierFn;
}

function stripPrompt(rule: KeywordRule, text: string): string {
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
			temperature: 0,
		});
		return parseClassifierOutput(response);
	};
}

interface BuildHandlerOptions {
	detectIntent: typeof detectMediaIntent;
	classifierFactory: (runtime: IAgentRuntime) => ClassifierFn;
}

/** Legacy text-only callers are adapted to the canonical structured action. */
export function buildGenerateMediaHandler(
	opts: Partial<BuildHandlerOptions> = {},
) {
	return async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: unknown,
		_options?: unknown,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const text = message.content.text;
		if (typeof text !== "string" || !text.trim()) {
			return {
				success: false,
				text: "GENERATE_MEDIA requires a non-empty message.",
			};
		}
		const intent = await (opts.detectIntent ?? detectMediaIntent)(text, {
			classifier: (opts.classifierFactory ?? makeRuntimeClassifier)(runtime),
		});
		if (!intent) {
			return {
				success: false,
				text: "Specify image, video or speech generation.",
			};
		}
		return generateMediaAction.handler(
			runtime,
			message,
			undefined,
			{
				parameters: {
					mediaType: intent.kind,
					...(intent.kind === "audio" ? { audioKind: "tts" } : {}),
					prompt: intent.prompt,
				},
			},
			callback,
		);
	};
}
