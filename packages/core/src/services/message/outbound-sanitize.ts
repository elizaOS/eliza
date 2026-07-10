/**
 * Shared outbound text sanitizer: strips model reasoning/thinking tags
 * (`<thinking>`, `<reasoning>`, …), end-of-turn sentinels (`<|im_end|>`,
 * `<STOP/>`, …), and native model tool-call syntax (`<tool_call>`,
 * `<function_call>`) from agent-generated text before it leaves the runtime
 * toward any connector, while preserving fenced code blocks and inline code
 * spans.
 *
 * A model that drifts out of the eliza response grammar mid-turn emits its
 * native machine syntax as visible prose (observed live on a cerebras
 * zai-glm-4.7 planner turn: "…Let me try the weather action.<tool_call>
 * get_weather" delivered verbatim — #15812). Sanitizing per-connector left
 * every surface except Discord exposed, so the sanitizer lives at the shared
 * post-model, pre-channel boundaries instead (#15888): the per-turn visible
 * callback wrap in `services/message.ts`, the mandatory
 * `outgoing_before_deliver` pipeline phase, and `sendMessageToTarget` — every
 * text connector receives sanitized prose without carrying its own copy.
 *
 * The behavior is the Discord sanitizer's, moved verbatim except for four
 * deliberate deltas fixed at the promotion moment (each carried the same bug
 * byte-for-byte in the original, and each is covered by a dedicated test):
 *   1. the quick pre-filter recognizes `eot_id`, so a lone `<|eot_id|>` /
 *      `<eot_id>` sentinel no longer bypasses sanitization;
 *   2. code-block restoration uses a function replacement, so `$$`/`$&`-style
 *      replacement patterns inside saved code are restored literally instead
 *      of being interpreted (the original corrupted `kill -9 $$` and could
 *      leak a raw sentinel via `$&`);
 *   3. the cosmetic `\n{3,}` collapse runs BEFORE code blocks are restored,
 *      so intentional blank-line spacing inside fences survives;
 *   4. inline single/multi-backtick code spans are protected like fences, so
 *      a coding answer such as "the `<tool_call>` tag …" is no longer
 *      truncated at the span.
 * Known pass-throughs shared with the original and left as-is: bare `<think>`
 * spans are handled upstream by `stripReasoningBlocks` at model-output parse
 * time, and `<|im_start|>` framing tokens are not stripped.
 *
 * This is a delivery-boundary catch-all, distinct from the model-output parse
 * helpers (`stripReasoningBlocks` in `./fallback-reply.ts`,
 * `stripReasoningArtifacts` in `../../runtime/planner-loop.ts`) that clean
 * specific model calls. Structured planner tool calls are never routed through
 * here — the planner consumes `GenerateTextResult.toolCalls` directly, so
 * sanitizing delivered prose cannot delete a valid machine action.
 */
const MACHINE_SYNTAX_TAGS = [
	"thinking",
	"reasoning",
	"reflection",
	"thought",
	"antthinking",
	// Native model tool-call syntax (glm/qwen-family `<tool_call>`, gemini-style
	// `<function_call>`). Machine syntax, never user-facing prose — strip it
	// like reasoning tags.
	"tool_call",
	"function_call",
] as const;

const SELF_CLOSING_ARTIFACTS_RE =
	/<(?:STOP|END|end_turn|eot_id)\s*\/?>|<\|(?:end|stop|im_end|eot_id)\|>/gi;
// Cheap pre-filter so clean text (the overwhelmingly common case) returns
// without any code-block extraction or per-tag regex passes. Must recognize
// every shape SELF_CLOSING_ARTIFACTS_RE strips (delta 1: the Discord original
// omitted `eot_id` here, so a lone sentinel slipped through to the wire).
const QUICK_TAG_RE =
	/<\/?(?:thinking|reasoning|reflection|thought|antthinking|tool_call|function_call|final|STOP|END|end_turn|eot_id)\b|<\|(?:end|stop|im_end|eot_id)/i;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
// An inline code span: a backtick run, non-backtick single-line content, and a
// closing run of exactly the same length (CommonMark's matched-run rule; the
// trailing lookahead rejects a longer closing run). Runs after fence
// extraction, so any backticks still present are inline.
const INLINE_CODE_RE = /(`+)[^`\n]+?\1(?!`)/g;
// NUL cannot be produced by model tokenizers or survive the JSON transport in
// between, so the sentinel cannot collide with content. Restoration still uses
// a FUNCTION replacement (delta 2): with a string replacement, a `$&` inside
// saved code re-inserts the matched sentinel itself, delivering a raw
// NUL-marker on the wire.
const CODE_SENTINEL_PREFIX = "\x00CB";

/**
 * Strip machine syntax from outbound agent text. Paired tags are removed with
 * their contents; an unclosed tag is removed to end-of-text (the live-observed
 * drift shape); `<final>` wrappers are unwrapped keeping their contents;
 * fenced ``` blocks and inline `code` spans pass through untouched so
 * documentation examples of the syntax survive. Idempotent — sanitizing
 * already-sanitized text is a no-op.
 */
export function sanitizeOutboundText(text: string): string {
	if (!text || !QUICK_TAG_RE.test(text)) {
		return text;
	}

	const codeSpans: string[] = [];
	const saveSpan = (match: string): string => {
		const index = codeSpans.length;
		codeSpans.push(match);
		return `${CODE_SENTINEL_PREFIX}${index}${CODE_SENTINEL_PREFIX}`;
	};
	// Fences first (they may contain backticks), then inline spans (delta 4).
	let processed = text.replace(CODE_BLOCK_RE, saveSpan);
	processed = processed.replace(INLINE_CODE_RE, saveSpan);

	processed = processed.replace(SELF_CLOSING_ARTIFACTS_RE, "");

	for (const tag of MACHINE_SYNTAX_TAGS) {
		const paired = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
		processed = processed.replace(paired, "");

		const unclosed = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "gi");
		processed = processed.replace(unclosed, "");
	}

	processed = processed.replace(/<final\b[^>]*>([\s\S]*?)<\/final>/gi, "$1");

	// Collapse the whitespace stripped blocks leave behind BEFORE restoring
	// code (delta 3): running it after restoration reformatted intentional
	// blank-line spacing inside fences.
	processed = processed.replace(/\n{3,}/g, "\n\n");

	for (let index = 0; index < codeSpans.length; index++) {
		processed = processed.replace(
			`${CODE_SENTINEL_PREFIX}${index}${CODE_SENTINEL_PREFIX}`,
			() => codeSpans[index],
		);
	}

	return processed.trim();
}
