/**
 * Inline token rendering utilities for Markdown component.
 */

import type { Token } from "marked";
import type { InlineStyleContext, MarkdownTheme } from "./types.js";

/**
 * Context for inline rendering operations.
 */
export interface InlineRenderContext {
	theme: MarkdownTheme;
	getDefaultInlineStyleContext: () => InlineStyleContext;
}

/**
 * Render inline tokens to styled text.
 *
 * @param tokens - Array of inline tokens to render
 * @param context - Rendering context with theme and default style accessor
 * @param styleContext - Optional style context for custom styling
 * @returns Rendered styled text
 */
export function renderInlineTokens(
	tokens: Token[],
	context: InlineRenderContext,
	styleContext?: InlineStyleContext,
): string {
	let result = "";
	const resolvedStyleContext = styleContext ?? context.getDefaultInlineStyleContext();
	const { applyText, stylePrefix } = resolvedStyleContext;
	const applyTextWithNewlines = (text: string): string => {
		const segments: string[] = text.split("\n");
		return segments.map((segment: string) => applyText(segment)).join("\n");
	};

	for (const token of tokens) {
		switch (token.type) {
			case "text":
				// Text tokens in list items can have nested tokens for inline formatting
				if (token.tokens && token.tokens.length > 0) {
					result += renderInlineTokens(token.tokens, context, resolvedStyleContext);
				} else {
					result += applyTextWithNewlines(token.text);
				}
				break;

			case "paragraph":
				// Paragraph tokens contain nested inline tokens
				result += renderInlineTokens(token.tokens || [], context, resolvedStyleContext);
				break;

			case "strong": {
				const boldContent = renderInlineTokens(token.tokens || [], context, resolvedStyleContext);
				result += context.theme.bold(boldContent) + stylePrefix;
				break;
			}

			case "em": {
				const italicContent = renderInlineTokens(token.tokens || [], context, resolvedStyleContext);
				result += context.theme.italic(italicContent) + stylePrefix;
				break;
			}

			case "codespan":
				result += context.theme.code(token.text) + stylePrefix;
				break;

			case "link": {
				const linkText = renderInlineTokens(token.tokens || [], context, resolvedStyleContext);
				// If link text matches href, only show the link once
				// Compare raw text (token.text) not styled text (linkText) since linkText has ANSI codes
				// For mailto: links, strip the prefix before comparing (autolinked emails have
				// text="foo@bar.com" but href="mailto:foo@bar.com")
				const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
				if (token.text === token.href || token.text === hrefForComparison) {
					result += context.theme.link(context.theme.underline(linkText)) + stylePrefix;
				} else {
					result +=
						context.theme.link(context.theme.underline(linkText)) +
						context.theme.linkUrl(` (${token.href})`) +
						stylePrefix;
				}
				break;
			}

			case "br":
				result += "\n";
				break;

			case "del": {
				const delContent = renderInlineTokens(token.tokens || [], context, resolvedStyleContext);
				result += context.theme.strikethrough(delContent) + stylePrefix;
				break;
			}

			case "html":
				// Render inline HTML as plain text
				if ("raw" in token && typeof token.raw === "string") {
					result += applyTextWithNewlines(token.raw);
				}
				break;

			default:
				// Handle any other inline token types as plain text
				if ("text" in token && typeof token.text === "string") {
					result += applyTextWithNewlines(token.text);
				}
		}
	}

	return result;
}
