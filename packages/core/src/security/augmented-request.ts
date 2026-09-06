/**
 * Recovers the user's request from a message text that document
 * augmentation wrapped in its instruction preamble. Augmentation (in the
 * agent's API chat path) rewrites `content.text` into a preamble plus
 * `<contextual_documents>` and a trailing `<user_request>` block; relevance
 * and detection gates that run afterwards must score the request, not the
 * wrapper (live 2026-09-06: the wrapper's own words matched a recall keyword
 * on every API turn). Text without the wrapper is returned unchanged.
 */

const USER_REQUEST_BLOCK = /<user_request>\n?([\s\S]*?)\n?<\/user_request>\s*$/;

export function userRequestFromAugmentedText(text: string): string {
	const match = USER_REQUEST_BLOCK.exec(text);
	return match ? match[1].trim() : text;
}
