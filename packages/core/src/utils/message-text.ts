/**
 * Extracts the user's actual request text from a message `Memory`. Unwraps the
 * document-augmentation `<user_request>` envelope, strips a trailing
 * `[language instruction: ...]` suffix, and caps oversized input. Prefers a
 * connector's `currentMessageText` over the rendered `text`, and offers a
 * lowercased, whitespace-collapsed variant for matching.
 */
import type { Memory } from "../types/memory";

const DOCUMENT_AUGMENTATION_PREFIX =
	"Answer the user request using the contextual documents";
const USER_REQUEST_WRAPPER = /<user_request>\s*([\s\S]*?)\s*<\/user_request>/i;
const LANGUAGE_INSTRUCTION_SUFFIX = /\n*\[language instruction:[^\]]*\]\s*$/i;

export function extractUserText(raw: string): string {
	let text = raw.length > 100_000 ? raw.slice(0, 100_000) : raw;
	if (text.trimStart().startsWith(DOCUMENT_AUGMENTATION_PREFIX)) {
		const match = text.match(USER_REQUEST_WRAPPER);
		if (match?.[1]) {
			text = match[1];
		}
	}
	return text.replace(LANGUAGE_INSTRUCTION_SUFFIX, "").trim();
}

export function getUserMessageText(
	message: Pick<Memory, "content"> | null | undefined,
): string {
	const content = message?.content;
	const contentObject =
		content && typeof content === "object"
			? (content as { currentMessageText?: unknown; text?: unknown })
			: null;
	const raw =
		typeof content === "string"
			? content
			: typeof contentObject?.currentMessageText === "string"
				? contentObject.currentMessageText
				: typeof contentObject?.text === "string"
					? contentObject.text
					: "";
	return extractUserText(raw);
}

export function normalizeUserMessageText(
	message: Pick<Memory, "content"> | null | undefined,
): string {
	return getUserMessageText(message).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Returns true when a message's rendered `content.text` carries the document
 * augmentation envelope (the `Answer the user request using the contextual
 * documents ...` preamble wrapping the real text in `<user_request>` tags).
 *
 * The envelope is a model-facing wrapper: it is added right before the LLM
 * prompt is assembled so retrieved document context reaches the model. It must
 * never be persisted or echoed back to a client, or it renders as raw XML in
 * the user's own chat bubble and re-enters context on later turns as history.
 */
export function hasDocumentAugmentationEnvelope(text: unknown): boolean {
	if (typeof text !== "string") return false;
	return text.trimStart().startsWith(DOCUMENT_AUGMENTATION_PREFIX);
}

/**
 * Produces a persist-safe copy of an inbound user `Memory` whose `content.text`
 * has been stripped of the document augmentation envelope. The wrapper is added
 * transiently for the current turn's LLM prompt; the stored memory (and its
 * embedding) must hold the clean user text so the UI echo, message history, and
 * subsequent-turn context all see what the user actually typed.
 *
 * Returns the original reference unchanged when there is no envelope to strip,
 * so callers on the hot path pay nothing for the common (unaugmented) case and
 * the live in-flight message keeps its wrap for the current LLM call.
 */
export function stripAugmentationForPersistence<
	T extends Pick<Memory, "content">,
>(message: T): T {
	const content = message?.content;
	if (!content || typeof content !== "object") return message;
	const rendered = (content as { text?: unknown }).text;
	if (!hasDocumentAugmentationEnvelope(rendered)) return message;
	const clean = extractUserText(rendered as string);
	if (clean === rendered) return message;
	return {
		...message,
		content: {
			...(content as Record<string, unknown>),
			text: clean,
		},
	} as T;
}
