/**
 * Text chunking utilities for markdown-aware splitting.
 *
 * Provides functions to split text into chunks while respecting:
 * - Fenced code blocks
 * - Paragraph boundaries
 * - Word boundaries
 *
 * @module markdown/chunk
 */

import {
	findFenceSpanAt,
	isSafeFenceBreak,
	parseFenceSpans,
} from "./fences.js";

/**
 * Split text into chunks of maximum length.
 *
 * Prefers breaking at:
 * 1. Newlines (outside parentheses)
 * 2. Whitespace (word boundaries)
 * 3. Hard break at limit as fallback
 *
 * @param text - The text to chunk
 * @param limit - Maximum chunk length
 * @returns Array of text chunks
 */
export function chunkText(text: string, limit: number): string[] {
	if (!text) {
		return [];
	}
	if (limit <= 0) {
		return [text];
	}
	if (text.length <= limit) {
		return [text];
	}

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > limit) {
		const window = remaining.slice(0, limit);

		// 1) Prefer a newline break inside the window (outside parentheses).
		const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(window);

		// 2) Otherwise prefer the last whitespace (word boundary) inside the window.
		let breakIdx = lastNewline > 0 ? lastNewline : lastWhitespace;

		// 3) Fallback: hard break exactly at the limit.
		if (breakIdx <= 0) {
			breakIdx = limit;
		}

		const rawChunk = remaining.slice(0, breakIdx);
		const chunk = rawChunk.trimEnd();
		if (chunk.length > 0) {
			chunks.push(chunk);
		}

		// If we broke on whitespace/newline, skip that separator; for hard breaks keep it.
		const brokeOnSeparator =
			breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
		const nextStart = Math.min(
			remaining.length,
			breakIdx + (brokeOnSeparator ? 1 : 0),
		);
		remaining = remaining.slice(nextStart).trimStart();
	}

	if (remaining.length) {
		chunks.push(remaining);
	}

	return chunks;
}

/**
 * Split text into chunks on paragraph boundaries (blank lines).
 *
 * - Only breaks at paragraph separators ("\n\n" or more)
 * - Packs multiple paragraphs into a single chunk up to `limit`
 * - Falls back to length-based splitting when a paragraph exceeds `limit`
 *
 * @param text - The text to chunk
 * @param limit - Maximum chunk length
 * @param opts - Options for controlling splitting behavior
 * @returns Array of text chunks
 */
export function chunkByParagraph(
	text: string,
	limit: number,
	opts?: { splitLongParagraphs?: boolean },
): string[] {
	if (!text) {
		return [];
	}
	if (limit <= 0) {
		return [text];
	}
	const splitLongParagraphs = opts?.splitLongParagraphs !== false;

	// Normalize to \n so blank line detection is consistent.
	const normalized = text.replace(/\r\n?/g, "\n");

	// Fast-path: if there are no blank-line paragraph separators, do not split.
	const paragraphRe = /\n[\t ]*\n+/;
	if (!paragraphRe.test(normalized)) {
		if (normalized.length <= limit) {
			return [normalized];
		}
		if (!splitLongParagraphs) {
			return [normalized];
		}
		return chunkText(normalized, limit);
	}

	const spans = parseFenceSpans(normalized);

	const parts: string[] = [];
	const re = /\n[\t ]*\n+/g; // paragraph break: blank line(s), allowing whitespace
	let lastIndex = 0;
	for (const match of normalized.matchAll(re)) {
		const idx = match.index ?? 0;

		// Do not split on blank lines that occur inside fenced code blocks.
		if (!isSafeFenceBreak(spans, idx)) {
			continue;
		}

		parts.push(normalized.slice(lastIndex, idx));
		lastIndex = idx + match[0].length;
	}
	parts.push(normalized.slice(lastIndex));

	const chunks: string[] = [];
	for (const part of parts) {
		const paragraph = part.replace(/\s+$/g, "");
		if (!paragraph.trim()) {
			continue;
		}
		if (paragraph.length <= limit) {
			chunks.push(paragraph);
		} else if (!splitLongParagraphs) {
			chunks.push(paragraph);
		} else {
			chunks.push(...chunkText(paragraph, limit));
		}
	}

	return chunks;
}

/**
 * Split markdown text with awareness of code fences.
 *
 * When a chunk must be split inside a code fence, properly closes
 * the fence in the current chunk and reopens it in the next.
 *
 * @param text - The markdown text to chunk
 * @param limit - Maximum chunk length
 * @returns Array of text chunks
 */
export function chunkMarkdownText(text: string, limit: number): string[] {
	if (!text) {
		return [];
	}
	if (limit <= 0) {
		return [text];
	}
	if (text.length <= limit) {
		return [text];
	}

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > limit) {
		const spans = parseFenceSpans(remaining);
		const window = remaining.slice(0, limit);

		const softBreak = pickSafeBreakIndex(window, spans);
		let breakIdx = softBreak > 0 ? softBreak : limit;

		const initialFence = isSafeFenceBreak(spans, breakIdx)
			? undefined
			: findFenceSpanAt(spans, breakIdx);

		let fenceToSplit = initialFence;
		if (initialFence) {
			const closeLine = `${initialFence.indent}${initialFence.marker}`;
			const maxIdxIfNeedNewline = limit - (closeLine.length + 1);

			if (maxIdxIfNeedNewline <= 0) {
				fenceToSplit = undefined;
				breakIdx = limit;
			} else {
				const minProgressIdx = Math.min(
					remaining.length,
					initialFence.start + initialFence.openLine.length + 2,
				);
				const maxIdxIfAlreadyNewline = limit - closeLine.length;

				let pickedNewline = false;
				let lastNewline = remaining.lastIndexOf(
					"\n",
					Math.max(0, maxIdxIfAlreadyNewline - 1),
				);
				while (lastNewline !== -1) {
					const candidateBreak = lastNewline + 1;
					if (candidateBreak < minProgressIdx) {
						break;
					}
					const candidateFence = findFenceSpanAt(spans, candidateBreak);
					if (candidateFence && candidateFence.start === initialFence.start) {
						breakIdx = Math.max(1, candidateBreak);
						pickedNewline = true;
						break;
					}
					lastNewline = remaining.lastIndexOf("\n", lastNewline - 1);
				}

				if (!pickedNewline) {
					if (minProgressIdx > maxIdxIfAlreadyNewline) {
						fenceToSplit = undefined;
						breakIdx = limit;
					} else {
						breakIdx = Math.max(minProgressIdx, maxIdxIfNeedNewline);
					}
				}
			}

			const fenceAtBreak = findFenceSpanAt(spans, breakIdx);
			fenceToSplit =
				fenceAtBreak && fenceAtBreak.start === initialFence.start
					? fenceAtBreak
					: undefined;
		}

		let rawChunk = remaining.slice(0, breakIdx);
		if (!rawChunk) {
			break;
		}

		const brokeOnSeparator =
			breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
		const nextStart = Math.min(
			remaining.length,
			breakIdx + (brokeOnSeparator ? 1 : 0),
		);
		let next = remaining.slice(nextStart);

		if (fenceToSplit) {
			const closeLine = `${fenceToSplit.indent}${fenceToSplit.marker}`;
			rawChunk = rawChunk.endsWith("\n")
				? `${rawChunk}${closeLine}`
				: `${rawChunk}\n${closeLine}`;
			next = `${fenceToSplit.openLine}\n${next}`;
		} else {
			next = stripLeadingNewlines(next);
		}

		chunks.push(rawChunk);
		remaining = next;
	}

	if (remaining.length) {
		chunks.push(remaining);
	}
	return chunks;
}

function stripLeadingNewlines(value: string): string {
	let i = 0;
	while (i < value.length && value[i] === "\n") {
		i++;
	}
	return i > 0 ? value.slice(i) : value;
}

function pickSafeBreakIndex(
	window: string,
	spans: ReturnType<typeof parseFenceSpans>,
): number {
	const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(
		window,
		(index) => isSafeFenceBreak(spans, index),
	);

	if (lastNewline > 0) {
		return lastNewline;
	}
	if (lastWhitespace > 0) {
		return lastWhitespace;
	}
	return -1;
}

function scanParenAwareBreakpoints(
	window: string,
	isAllowed: (index: number) => boolean = () => true,
): { lastNewline: number; lastWhitespace: number } {
	let lastNewline = -1;
	let lastWhitespace = -1;
	let depth = 0;

	for (let i = 0; i < window.length; i++) {
		if (!isAllowed(i)) {
			continue;
		}
		const char = window[i];
		if (char === "(") {
			depth += 1;
			continue;
		}
		if (char === ")" && depth > 0) {
			depth -= 1;
			continue;
		}
		if (depth !== 0) {
			continue;
		}
		if (char === "\n") {
			lastNewline = i;
		} else if (/\s/.test(char)) {
			lastWhitespace = i;
		}
	}

	return { lastNewline, lastWhitespace };
}
