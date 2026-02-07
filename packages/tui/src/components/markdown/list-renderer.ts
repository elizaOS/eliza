/**
 * List rendering utilities for Markdown component.
 */

import type { Token } from "marked";
import type { ListToken } from "../../types/marked-tokens.js";
import type { InlineStyleContext, MarkdownTheme } from "./types.js";

/**
 * Context for list rendering operations.
 */
export interface ListRenderContext {
	theme: MarkdownTheme;
	renderInlineTokens: (tokens: Token[], styleContext?: InlineStyleContext) => string;
}

/**
 * Render a list with proper nesting support.
 *
 * @param token - The list token to render
 * @param depth - Current nesting depth (0 for top-level)
 * @param context - Rendering context with theme and inline renderer
 * @returns Array of rendered lines
 */
export function renderList(token: ListToken, depth: number, context: ListRenderContext): string[] {
	const lines: string[] = [];
	const indent = "  ".repeat(depth);
	// Use the list's start property (defaults to 1 for ordered lists)
	const startNumber = typeof token.start === "number" ? token.start : 1;

	for (let i = 0; i < token.items.length; i++) {
		const item = token.items[i];
		const bullet = token.ordered ? `${startNumber + i}. ` : "- ";

		// Process item tokens to handle nested lists
		const itemLines = renderListItem(item.tokens || [], depth, context);

		if (itemLines.length > 0) {
			// First line - check if it's a nested list
			// A nested list will start with indent (spaces) followed by cyan bullet
			const firstLine = itemLines[0];
			const isNestedList = /^\s+\x1b\[36m[-\d]/.test(firstLine); // starts with spaces + cyan + bullet char

			if (isNestedList) {
				// This is a nested list, just add it as-is (already has full indent)
				lines.push(firstLine);
			} else {
				// Regular text content - add indent and bullet
				lines.push(indent + context.theme.listBullet(bullet) + firstLine);
			}

			// Rest of the lines
			for (let j = 1; j < itemLines.length; j++) {
				const line = itemLines[j];
				const isNestedListLine = /^\s+\x1b\[36m[-\d]/.test(line); // starts with spaces + cyan + bullet char

				if (isNestedListLine) {
					// Nested list line - already has full indent
					lines.push(line);
				} else {
					// Regular content - add parent indent + 2 spaces for continuation
					lines.push(`${indent}  ${line}`);
				}
			}
		} else {
			lines.push(indent + context.theme.listBullet(bullet));
		}
	}

	return lines;
}

/**
 * Render list item tokens, handling nested lists.
 * Returns lines WITHOUT the parent indent (renderList will add it).
 *
 * @param tokens - Tokens from the list item
 * @param parentDepth - Depth of the parent list
 * @param context - Rendering context with theme and inline renderer
 * @returns Array of rendered lines
 */
export function renderListItem(tokens: Token[], parentDepth: number, context: ListRenderContext): string[] {
	const lines: string[] = [];

	for (const token of tokens) {
		if (token.type === "list") {
			// Nested list - render with one additional indent level
			// These lines will have their own indent, so we just add them as-is
			const nestedLines = renderList(token as ListToken, parentDepth + 1, context);
			lines.push(...nestedLines);
		} else if (token.type === "text") {
			// Text content (may have inline tokens)
			const text =
				token.tokens && token.tokens.length > 0 ? context.renderInlineTokens(token.tokens) : token.text || "";
			lines.push(text);
		} else if (token.type === "paragraph") {
			// Paragraph in list item
			const text = context.renderInlineTokens(token.tokens || []);
			lines.push(text);
		} else if (token.type === "code") {
			// Code block in list item
			const indent = context.theme.codeBlockIndent ?? "  ";
			lines.push(context.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
			if (context.theme.highlightCode) {
				const highlightedLines = context.theme.highlightCode(token.text, token.lang);
				for (const hlLine of highlightedLines) {
					lines.push(`${indent}${hlLine}`);
				}
			} else {
				const codeLines = token.text.split("\n");
				for (const codeLine of codeLines) {
					lines.push(`${indent}${context.theme.codeBlock(codeLine)}`);
				}
			}
			lines.push(context.theme.codeBlockBorder("```"));
		} else {
			// Other token types - try to render as inline
			const text = context.renderInlineTokens([token]);
			if (text) {
				lines.push(text);
			}
		}
	}

	return lines;
}
