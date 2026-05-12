/**
 * Code fence parsing utilities for markdown.
 *
 * Parses fenced code blocks (``` or ~~~) and provides utilities
 * to check if a position is inside a fence or if a break is safe.
 *
 * @module markdown/fences
 */

/**
 * Represents a fenced code block span in the text.
 */
export type FenceSpan = {
	/** Start offset of the fence in the text */
	start: number;
	/** End offset of the fence in the text */
	end: number;
	/** The opening line of the fence (e.g., "```typescript") */
	openLine: string;
	/** The marker characters (e.g., "```" or "~~~") */
	marker: string;
	/** Leading whitespace/indent before the marker */
	indent: string;
};

/**
 * Parse all fenced code block spans from a string.
 *
 * Handles both backtick (```) and tilde (~~~) fences,
 * with proper matching of closing markers.
 *
 * @param buffer - The text to parse
 * @returns Array of fence spans found
 */
export function parseFenceSpans(buffer: string): FenceSpan[] {
	const spans: FenceSpan[] = [];
	let open:
		| {
				start: number;
				markerChar: string;
				markerLen: number;
				openLine: string;
				marker: string;
				indent: string;
		  }
		| undefined;

	let offset = 0;
	while (offset <= buffer.length) {
		const nextNewline = buffer.indexOf("\n", offset);
		const lineEnd = nextNewline === -1 ? buffer.length : nextNewline;
		const line = buffer.slice(offset, lineEnd);

		const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
		if (match) {
			const indent = match[1];
			const marker = match[2];
			const markerChar = marker[0];
			const markerLen = marker.length;
			if (!open) {
				open = {
					start: offset,
					markerChar,
					markerLen,
					openLine: line,
					marker,
					indent,
				};
			} else if (
				open.markerChar === markerChar &&
				markerLen >= open.markerLen
			) {
				const end = lineEnd;
				spans.push({
					start: open.start,
					end,
					openLine: open.openLine,
					marker: open.marker,
					indent: open.indent,
				});
				open = undefined;
			}
		}

		if (nextNewline === -1) {
			break;
		}
		offset = nextNewline + 1;
	}

	if (open) {
		spans.push({
			start: open.start,
			end: buffer.length,
			openLine: open.openLine,
			marker: open.marker,
			indent: open.indent,
		});
	}

	return spans;
}

/**
 * Find the fence span that contains a given index.
 *
 * @param spans - Array of fence spans to search
 * @param index - Position to check
 * @returns The fence span containing the index, or undefined
 */
export function findFenceSpanAt(
	spans: FenceSpan[],
	index: number,
): FenceSpan | undefined {
	return spans.find((span) => index > span.start && index < span.end);
}

/**
 * Check if it's safe to break text at a given index (not inside a fence).
 *
 * @param spans - Array of fence spans
 * @param index - Position to check
 * @returns True if safe to break (not inside a fence)
 */
export function isSafeFenceBreak(spans: FenceSpan[], index: number): boolean {
	return !findFenceSpanAt(spans, index);
}
