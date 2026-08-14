/**
 * Bridge between message text and the typed `Content.interactions` field.
 *
 * `normalizeContentInteractions` parses any interaction markers out of
 * `content.text` and attaches them as a typed `interactions` array, leaving the
 * original `text` untouched so the dashboard's own segment renderer (which
 * interleaves markers with prose) keeps working. Connectors that render from the
 * typed array use `stripInteractionMarkers` to get the prose to show above the
 * native controls.
 *
 * Intended to run once per outbound reply (e.g. from an `outgoing_before_deliver`
 * pipeline hook) so every surface receives the same parsed blocks.
 */

import type { Content } from "../../types/primitives";
import {
	parseInteractionBlocks,
	stripUnclaimedInteractionMarkup,
} from "./parse";

/** Message text with every interaction marker removed and whitespace tidied. */
export function stripInteractionMarkers(text: string): string {
	return parseInteractionBlocks(text).cleanedText;
}

/**
 * Attach parsed interaction blocks to `content.interactions`. Idempotent and
 * non-destructive for human prose and valid markers; terminal unclaimed
 * machinery is removed before any delivery surface receives the content.
 */
export function normalizeContentInteractions(content: Content): Content {
	if (typeof content.text !== "string" || content.text.length === 0)
		return content;
	const text = stripUnclaimedInteractionMarkup(content.text);
	if (Array.isArray(content.interactions) && content.interactions.length > 0) {
		return text === content.text ? content : { ...content, text };
	}
	const { blocks } = parseInteractionBlocks(text);
	if (blocks.length === 0) {
		return text === content.text ? content : { ...content, text };
	}
	return { ...content, text, interactions: blocks };
}
