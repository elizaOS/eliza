/**
 * Text layout and word wrapping utilities for the Editor component.
 */

import { getSegmenter, isWhitespaceChar, visibleWidth } from "../../utils.js";
import type { EditorState, LayoutLine, TextChunk, VisualLineMapping } from "./types.js";

const segmenter = getSegmenter();

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @returns Array of chunks with text and position information
 */
export function wordWrapLine(line: string, maxWidth: number): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}

	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];
	const segments = [...segmenter.segment(line)];

	let currentWidth = 0;
	let chunkStart = 0;

	// Wrap opportunity: the position after the last whitespace before a non-whitespace
	// grapheme, i.e. where a line break is allowed.
	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const grapheme = seg.segment;
		const gWidth = visibleWidth(grapheme);
		const charIndex = seg.index;
		const isWs = isWhitespaceChar(grapheme);

		// Overflow check before advancing.
		if (currentWidth + gWidth > maxWidth) {
			if (wrapOppIndex >= 0) {
				// Backtrack to last wrap opportunity.
				chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
				chunkStart = wrapOppIndex;
				currentWidth -= wrapOppWidth;
			} else if (chunkStart < charIndex) {
				// No wrap opportunity: force-break at current position.
				chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
				chunkStart = charIndex;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
		}

		// Advance.
		currentWidth += gWidth;

		// Record wrap opportunity: whitespace followed by non-whitespace.
		// Multiple spaces join (no break between them); the break point is
		// after the last space before the next word.
		const next = segments[i + 1];
		if (isWs && next && !isWhitespaceChar(next.segment)) {
			wrapOppIndex = next.index;
			wrapOppWidth = currentWidth;
		}
	}

	// Push final chunk.
	chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });

	return chunks;
}

/**
 * Layout text into visual lines for rendering.
 *
 * @param state - Current editor state
 * @param contentWidth - Maximum width for content
 * @returns Array of layout lines ready for rendering
 */
export function layoutText(state: EditorState, contentWidth: number): LayoutLine[] {
	const layoutLines: LayoutLine[] = [];

	if (state.lines.length === 0 || (state.lines.length === 1 && state.lines[0] === "")) {
		// Empty editor
		layoutLines.push({
			text: "",
			hasCursor: true,
			cursorPos: 0,
		});
		return layoutLines;
	}

	// Process each logical line
	for (let i = 0; i < state.lines.length; i++) {
		const line = state.lines[i] as string;
		const isCurrentLine = i === state.cursorLine;
		const lineVisibleWidth = visibleWidth(line);

		if (lineVisibleWidth <= contentWidth) {
			// Line fits in one layout line
			if (isCurrentLine) {
				layoutLines.push({
					text: line,
					hasCursor: true,
					cursorPos: state.cursorCol,
				});
			} else {
				layoutLines.push({
					text: line,
					hasCursor: false,
				});
			}
		} else {
			// Line needs wrapping - use word-aware wrapping
			const chunks = wordWrapLine(line, contentWidth);

			for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
				const chunk = chunks[chunkIndex];
				if (!chunk) continue;

				const cursorPos = state.cursorCol;
				const isLastChunk = chunkIndex === chunks.length - 1;

				// Determine if cursor is in this chunk
				let hasCursorInChunk = false;
				let adjustedCursorPos = 0;

				if (isCurrentLine) {
					if (isLastChunk) {
						// Last chunk: cursor belongs here if >= startIndex
						hasCursorInChunk = cursorPos >= chunk.startIndex;
						adjustedCursorPos = cursorPos - chunk.startIndex;
					} else {
						// Non-last chunk: cursor belongs here if in range [startIndex, endIndex)
						hasCursorInChunk = cursorPos >= chunk.startIndex && cursorPos < chunk.endIndex;
						if (hasCursorInChunk) {
							adjustedCursorPos = cursorPos - chunk.startIndex;
							// Clamp to text length (in case cursor was in trimmed whitespace)
							if (adjustedCursorPos > chunk.text.length) {
								adjustedCursorPos = chunk.text.length;
							}
						}
					}
				}

				layoutLines.push({
					text: chunk.text,
					hasCursor: hasCursorInChunk,
					cursorPos: hasCursorInChunk ? adjustedCursorPos : undefined,
				});
			}
		}
	}

	return layoutLines;
}

/**
 * Build a mapping from visual lines to logical positions.
 *
 * @param state - Current editor state
 * @param width - Maximum width for content
 * @returns Array where each element represents a visual line
 */
export function buildVisualLineMap(state: EditorState, width: number): VisualLineMapping[] {
	const visualLines: VisualLineMapping[] = [];

	for (let i = 0; i < state.lines.length; i++) {
		const line = state.lines[i] as string;
		const lineVisWidth = visibleWidth(line);
		if (line.length === 0) {
			// Empty line still takes one visual line
			visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
		} else if (lineVisWidth <= width) {
			visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
		} else {
			// Line needs wrapping - use word-aware wrapping
			const chunks = wordWrapLine(line, width);
			for (const chunk of chunks) {
				visualLines.push({
					logicalLine: i,
					startCol: chunk.startIndex,
					length: chunk.endIndex - chunk.startIndex,
				});
			}
		}
	}

	return visualLines;
}

/**
 * Find the visual line index for the current cursor position.
 *
 * @param visualLines - Visual line mappings
 * @param cursorLine - Current logical line
 * @param cursorCol - Current column position
 * @returns Visual line index
 */
export function findCurrentVisualLine(
	visualLines: VisualLineMapping[],
	cursorLine: number,
	cursorCol: number,
): number {
	for (let i = 0; i < visualLines.length; i++) {
		const vl = visualLines[i];
		if (!vl) continue;
		if (vl.logicalLine === cursorLine) {
			const colInSegment = cursorCol - vl.startCol;
			// Cursor is in this segment if it's within range
			// For the last segment of a logical line, cursor can be at length (end position)
			const isLastSegmentOfLine =
				i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;
			if (colInSegment >= 0 && (colInSegment < vl.length || (isLastSegmentOfLine && colInSegment <= vl.length))) {
				return i;
			}
		}
	}
	// Fallback: return last visual line
	return visualLines.length - 1;
}
