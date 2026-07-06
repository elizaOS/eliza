/**
 * Text-only projection for interaction blocks sent through BlueBubbles.
 *
 * BlueBubbles ultimately delivers SMS/iMessage text, so it cannot carry the
 * dashboard's bracket-marker widgets directly. This helper strips markers and
 * appends readable fallbacks before the REST send path sees the message body.
 */

import {
	buildInteractionUrlResolver,
	type Content,
	renderContentInteractionsAsPlainText,
} from "@elizaos/core";

export function renderBlueBubblesInteractionText(
	content: Content,
	appBaseUrl?: string,
): string {
	return renderContentInteractionsAsPlainText(
		content,
		buildInteractionUrlResolver(appBaseUrl),
	).text;
}
