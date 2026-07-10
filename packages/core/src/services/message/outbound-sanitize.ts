/**
 * Shared outbound text sanitizer: strips model reasoning/thinking tags
 * (`<thinking>`, `<reasoning>`, …), end-of-turn sentinels (`<|im_end|>`,
 * `<STOP/>`, …), and native model tool-call syntax (`<tool_call>`,
 * `<function_call>`) from agent-generated text before it leaves the runtime
 * toward any connector, while preserving fenced code blocks.
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
// every shape SELF_CLOSING_ARTIFACTS_RE strips: the Discord original omitted
// `eot_id` here, so a lone `<|eot_id|>`/`<eot_id>` sentinel slipped through
// the filter and reached the wire — fixed in the move to core (#15888).
const QUICK_TAG_RE =
	/<\/?(?:thinking|reasoning|reflection|thought|antthinking|tool_call|function_call|final|STOP|END|end_turn|eot_id)\b|<\|(?:end|stop|im_end|eot_id)/i;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
// NUL never occurs in model text, so the sentinel cannot collide with content.
const CODE_BLOCK_SENTINEL_PREFIX = "\x00CB";

/**
 * Strip machine syntax from outbound agent text. Paired tags are removed with
 * their contents; an unclosed tag is removed to end-of-text (the live-observed
 * drift shape); `<final>` wrappers are unwrapped keeping their contents;
 * fenced ``` blocks pass through untouched so documentation examples of the
 * syntax survive. Idempotent — sanitizing already-sanitized text is a no-op.
 */
export function sanitizeOutboundText(text: string): string {
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

	for (const tag of MACHINE_SYNTAX_TAGS) {
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
