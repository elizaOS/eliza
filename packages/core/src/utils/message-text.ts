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
	const raw =
		typeof message?.content === "string"
			? message.content
			: typeof message?.content?.text === "string"
				? message.content.text
				: "";
	return extractUserText(raw);
}

export function normalizeUserMessageText(
	message: Pick<Memory, "content"> | null | undefined,
): string {
	return getUserMessageText(message).toLowerCase().replace(/\s+/g, " ").trim();
}
