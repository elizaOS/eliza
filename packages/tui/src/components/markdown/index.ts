/**
 * Markdown component module exports.
 */

// Re-export the main Markdown component from parent directory
export { Markdown } from "../markdown.js";

// Export types
export type { DefaultTextStyle, InlineStyleContext, MarkdownTheme } from "./types.js";
export { getStylePrefix } from "./types.js";

// Export list rendering utilities
export type { ListRenderContext } from "./list-renderer.js";
export { renderList, renderListItem } from "./list-renderer.js";

// Export table rendering utilities
export type { TableRenderContext } from "./table-renderer.js";
export { getLongestWordWidth, renderTable, wrapCellText } from "./table-renderer.js";

// Export inline rendering utilities
export type { InlineRenderContext } from "./inline-renderer.js";
export { renderInlineTokens } from "./inline-renderer.js";
