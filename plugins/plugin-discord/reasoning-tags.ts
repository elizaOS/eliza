/**
 * Strips model reasoning/thinking tags (`<thinking>`, `<reasoning>`, …) and
 * end-of-turn sentinels from generated text before it is sent to Discord,
 * preserving the contents of fenced code blocks.
 */
const REASONING_TAGS = [
	"thinking",
	"reasoning",
	"reflection",
	"thought",
	"antthinking",
	// Native model tool-call syntax (glm/qwen-family `<tool_call>`, gemini-style
	// `<function_call>`): a model that drifts out of the eliza response grammar
	// mid-turn emits these as visible text (observed live: "…Let me try the
	// weather action.<tool_call>get_weather" delivered verbatim). They are
	// machine syntax, never user-facing prose — strip them like reasoning tags.
	"tool_call",
	"function_call",
] as const;

const SELF_CLOSING_ARTIFACTS_RE =
	/<(?:STOP|END|end_turn|eot_id)\s*\/?>|<\|(?:end|stop|im_end|eot_id)\|>/gi;
const QUICK_TAG_RE =
	/<\/?(?:thinking|reasoning|reflection|thought|antthinking|tool_call|function_call|final|STOP|END|end_turn)\b|<\|(?:end|stop|im_end)/i;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const CODE_BLOCK_SENTINEL_PREFIX = "\x00CB";

export function stripReasoningTags(text: string): string {
	if (!text || !QUICK_TAG_RE.test(text)) {
		return text;
	}

	const codeBlocks: string[] = [];
	let processed = text.replace(CODE_BLOCK_RE, (match) => {
		const index = codeBlocks.length;
		codeBlocks.push(match);
		return `${CODE_BLOCK_SENTINEL_PREFIX}${index}${CODE_BLOCK_SENTINEL_PREFIX}`;
	});

	processed = processed.replace(SELF_CLOSING_ARTIFACTS_RE, "");

	for (const tag of REASONING_TAGS) {
		const paired = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
		processed = processed.replace(paired, "");

		const unclosed = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "gi");
		processed = processed.replace(unclosed, "");
	}

	processed = processed.replace(/<final\b[^>]*>([\s\S]*?)<\/final>/gi, "$1");

	for (let index = 0; index < codeBlocks.length; index++) {
		processed = processed.replace(
			`${CODE_BLOCK_SENTINEL_PREFIX}${index}${CODE_BLOCK_SENTINEL_PREFIX}`,
			codeBlocks[index],
		);
	}

	return processed.replace(/\n{3,}/g, "\n\n").trim();
}
