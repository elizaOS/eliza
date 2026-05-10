const REASONING_TAGS = [
	"thinking",
	"reasoning",
	"reflection",
	"thought",
	"antthinking",
] as const;

const SELF_CLOSING_ARTIFACTS_RE =
	/<(?:STOP|END|end_turn|eot_id)\s*\/?>|<\|(?:end|stop|im_end|eot_id)\|>/gi;
const QUICK_TAG_RE =
	/<\/?(?:thinking|reasoning|reflection|thought|antthinking|final|STOP|END|end_turn)\b|<\|(?:end|stop|im_end)/i;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const PLACEHOLDER_PREFIX = "\x00CB";

export function stripReasoningTags(text: string): string {
	if (!text || !QUICK_TAG_RE.test(text)) {
		return text;
	}

	const codeBlocks: string[] = [];
	let processed = text.replace(CODE_BLOCK_RE, (match) => {
		const index = codeBlocks.length;
		codeBlocks.push(match);
		return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_PREFIX}`;
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
			`${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_PREFIX}`,
			codeBlocks[index],
		);
	}

	return processed.replace(/\n{3,}/g, "\n\n").trim();
}
