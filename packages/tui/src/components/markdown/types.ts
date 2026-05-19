/**
 * Type definitions for the Markdown component.
 */

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/** Prefix applied to each rendered code block line (default: "  ") */
	codeBlockIndent?: string;
}

/**
 * Context for inline token rendering, carrying style functions and prefixes.
 */
export interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

/**
 * Get the style prefix from a styling function.
 * Uses a sentinel character to extract the ANSI prefix codes.
 */
export function getStylePrefix(styleFn: (text: string) => string): string {
	const sentinel = "\u0000";
	const styled = styleFn(sentinel);
	const sentinelIndex = styled.indexOf(sentinel);
	return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
}
