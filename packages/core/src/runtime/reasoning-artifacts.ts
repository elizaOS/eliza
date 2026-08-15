/**
 * Canonical reasoning-tag grammar for model-output recovery and final egress.
 * Completed prefixes may be removed before structured parsing; any surviving
 * tag is unsafe for user-visible delivery. The grammar accepts the reasoning
 * dialects used by supported providers and tolerates case and tag whitespace.
 */

const REASONING_TAG_NAME = String.raw`(?:think|thinking|reasoning)`;
const REASONING_TAG = new RegExp(
	`<\\s*\\/?\\s*${REASONING_TAG_NAME}\\b[^>]*>`,
	"i",
);
const REASONING_CLOSE_TAG = new RegExp(
	`<\\s*\\/\\s*${REASONING_TAG_NAME}\\s*>`,
	"gi",
);
const PAIRED_REASONING_BLOCK = new RegExp(
	`<\\s*${REASONING_TAG_NAME}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${REASONING_TAG_NAME}\\s*>`,
	"gi",
);
const DANGLING_REASONING_OPEN = new RegExp(
	`<\\s*${REASONING_TAG_NAME}\\b[^>]*>[\\s\\S]*$`,
	"gi",
);

/** Remove all complete leading reasoning sections before structured parsing. */
export function stripCompletedReasoningPrefix(text: string): string {
	REASONING_CLOSE_TAG.lastIndex = 0;
	let visibleStart = -1;
	for (
		let match = REASONING_CLOSE_TAG.exec(text);
		match;
		match = REASONING_CLOSE_TAG.exec(text)
	) {
		visibleStart = match.index + match[0].length;
	}
	REASONING_CLOSE_TAG.lastIndex = 0;
	return visibleStart >= 0 ? text.slice(visibleStart) : text;
}

/** True when text still contains provider reasoning markup of any known dialect. */
export function containsReasoningMarkup(text: string): boolean {
	return REASONING_TAG.test(text);
}

/**
 * Strip complete reasoning blocks, close-only prefixes, and dangling open
 * blocks from a model-authored prose candidate.
 */
export function stripReasoningArtifacts(text: string): string {
	let cleaned = text.replace(PAIRED_REASONING_BLOCK, "");
	cleaned = stripCompletedReasoningPrefix(cleaned);
	cleaned = cleaned.replace(DANGLING_REASONING_OPEN, "");
	return cleaned.trim();
}
