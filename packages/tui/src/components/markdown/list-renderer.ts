/**
 * List rendering utilities for Markdown component.
 */

import type { Token } from "marked";
import type { ListToken } from "../../types/marked-tokens.js";
import {
  hasNestedTokens,
  type InlineStyleContext,
  type MarkdownTheme,
} from "./types.js";

/**
 * Context for list rendering operations.
 */
export interface ListRenderContext {
  theme: MarkdownTheme;
  renderInlineTokens: (
    tokens: Token[],
    styleContext?: InlineStyleContext,
  ) => string;
}

/**
 * A rendered list-item line, tagged with whether it came from a nested list
 * (nested-list lines already carry their own full indentation).
 */
interface ListItemLine {
  text: string;
  nested: boolean;
}

/**
 * Render a list with proper nesting support.
 *
 * @param token - The list token to render
 * @param depth - Current nesting depth (0 for top-level)
 * @param context - Rendering context with theme and inline renderer
 * @returns Array of rendered lines
 */
export function renderList(
  token: ListToken,
  depth: number,
  context: ListRenderContext,
): string[] {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  // Use the list's start property (defaults to 1 for ordered lists)
  const startNumber = typeof token.start === "number" ? token.start : 1;

  for (let i = 0; i < token.items.length; i++) {
    const item = token.items[i];
    const bullet = token.ordered ? `${startNumber + i}. ` : "- ";

    // Process item tokens to handle nested lists
    const itemLines = renderListItemLines(item.tokens || [], depth, context);

    if (itemLines.length > 0) {
      // First line - nested-list lines are already fully indented
      const firstLine = itemLines[0];

      if (firstLine.nested) {
        // This is a nested list, just add it as-is (already has full indent)
        lines.push(firstLine.text);
      } else {
        // Regular text content - add indent and bullet
        lines.push(indent + context.theme.listBullet(bullet) + firstLine.text);
      }

      // Rest of the lines
      for (let j = 1; j < itemLines.length; j++) {
        const line = itemLines[j];

        if (line.nested) {
          // Nested list line - already has full indent
          lines.push(line.text);
        } else {
          // Regular content - add parent indent + 2 spaces for continuation
          lines.push(`${indent}  ${line.text}`);
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
export function renderListItem(
  tokens: Token[],
  parentDepth: number,
  context: ListRenderContext,
): string[] {
  return renderListItemLines(tokens, parentDepth, context).map(
    (line) => line.text,
  );
}

/**
 * Render list item tokens to lines tagged with nested-list provenance, so
 * renderList() can tell nested-list lines (already fully indented) apart from
 * regular content without sniffing for theme-specific ANSI color codes.
 */
function renderListItemLines(
  tokens: Token[],
  parentDepth: number,
  context: ListRenderContext,
): ListItemLine[] {
  const lines: ListItemLine[] = [];
  const push = (text: string) => lines.push({ text, nested: false });

  for (const token of tokens) {
    if (token.type === "list") {
      // Nested list - render with one additional indent level
      // These lines will have their own indent, so we just add them as-is
      const nestedLines = renderList(
        token as ListToken,
        parentDepth + 1,
        context,
      );
      for (const nestedLine of nestedLines) {
        lines.push({ text: nestedLine, nested: true });
      }
    } else if (token.type === "text") {
      // Text content (may have inline tokens)
      const text =
        hasNestedTokens(token) && token.tokens.length > 0
          ? context.renderInlineTokens(token.tokens)
          : "text" in token && typeof token.text === "string"
            ? token.text
            : "";
      push(text);
    } else if (token.type === "paragraph") {
      // Paragraph in list item
      const text = context.renderInlineTokens(token.tokens || []);
      push(text);
    } else if (token.type === "code") {
      // Code block in list item
      const indent = context.theme.codeBlockIndent ?? "  ";
      push(context.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
      if (context.theme.highlightCode) {
        const highlightedLines = context.theme.highlightCode(
          token.text,
          token.lang,
        );
        for (const hlLine of highlightedLines) {
          push(`${indent}${hlLine}`);
        }
      } else {
        const codeLines = token.text.split("\n");
        for (const codeLine of codeLines) {
          push(`${indent}${context.theme.codeBlock(codeLine)}`);
        }
      }
      push(context.theme.codeBlockBorder("```"));
    } else {
      // Other token types - try to render as inline
      const text = context.renderInlineTokens([token]);
      if (text) {
        push(text);
      }
    }
  }

  return lines;
}
