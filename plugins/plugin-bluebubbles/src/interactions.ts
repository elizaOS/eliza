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
	parseInteractionBlocks,
	toPlainTextFallback,
} from "@elizaos/core";

export function renderBlueBubblesInteractionText(
	content: Content,
	appBaseUrl?: string,
): string {
	const text = typeof content.text === "string" ? content.text : "";
	const { blocks, cleanedText } = parseInteractionBlocks(text);
	if (blocks.length === 0) {
		return text;
	}

	const resolver = buildInteractionUrlResolver(appBaseUrl);
	const fallbackLines = blocks
		.map((block) => toPlainTextFallback(block, resolver))
		.filter((line): line is string => Boolean(line?.trim()));

	return [cleanedText, ...fallbackLines]
		.filter((part) => part.trim().length > 0)
		.join("\n\n");
}
