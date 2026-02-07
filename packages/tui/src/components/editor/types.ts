/**
 * Type definitions for the Editor component.
 */

import type { SelectListTheme } from "../select-list.js";

/**
 * Editor state containing the text content and cursor position.
 */
export interface EditorState {
	/** Lines of text in the editor */
	lines: string[];
	/** Current logical line index (0-based) */
	cursorLine: number;
	/** Current column position within the line */
	cursorCol: number;
}

/**
 * A single layout line after word wrapping.
 */
export interface LayoutLine {
	/** The text content of this layout line */
	text: string;
	/** Whether this line contains the cursor */
	hasCursor: boolean;
	/** Position of cursor within this line (if hasCursor is true) */
	cursorPos?: number;
}

/**
 * Theme configuration for the Editor component.
 */
export interface EditorTheme {
	/** Function to apply border color styling */
	borderColor: (str: string) => string;
	/** Theme for the autocomplete dropdown */
	selectList: SelectListTheme;
}

/**
 * Options for the Editor component.
 */
export interface EditorOptions {
	/** Horizontal padding (default: 0) */
	paddingX?: number;
	/** Maximum visible items in autocomplete dropdown (default: 5) */
	autocompleteMaxVisible?: number;
}

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks both the text content and its position in the original line.
 */
export interface TextChunk {
	/** The text content of this chunk */
	text: string;
	/** Starting index in the original line */
	startIndex: number;
	/** Ending index in the original line */
	endIndex: number;
}

/**
 * Visual line mapping for cursor navigation.
 */
export interface VisualLineMapping {
	/** Index into the logical lines array */
	logicalLine: number;
	/** Starting column in the logical line */
	startCol: number;
	/** Length of this visual line segment */
	length: number;
}
