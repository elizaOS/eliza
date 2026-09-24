/** Public surface for Markdown parsing, intermediate representation, and safe chunking. */

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
	DEFAULT_FRONTMATTER_MAX_DEPTH,
	type FrontmatterDocumentResult,
	type FrontmatterParseErrorCode,
	type ParsedFrontmatter,
	type ParseFrontmatterDocumentOptions,
	parseFrontmatterBlock,
	parseFrontmatterDocument,
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
