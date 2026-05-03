/**
 * Markdown utilities for elizaOS.
 *
 * Provides:
 * - Code fence parsing
 * - Inline code span detection
 * - YAML frontmatter extraction
 * - Markdown to IR conversion
 * - Markdown-aware text chunking
 *
 * @module markdown
 */

export { chunkByParagraph, chunkMarkdownText, chunkText } from "./chunk.js";

export {
	buildCodeSpanIndex,
	type CodeSpanIndex,
	createInlineCodeState,
	type InlineCodeState,
} from "./code-spans.js";
export {
	type FenceSpan,
	findFenceSpanAt,
	isSafeFenceBreak,
	parseFenceSpans,
} from "./fences.js";
export {
	type ParsedFrontmatter,
	parseFrontmatterBlock,
} from "./frontmatter.js";

export {
	chunkMarkdownIR,
	type MarkdownIR,
	type MarkdownLinkSpan,
	type MarkdownParseOptions,
	type MarkdownStyle,
	type MarkdownStyleSpan,
	type MarkdownTableMode,
	markdownToIR,
	markdownToIRWithMeta,
} from "./ir.js";
