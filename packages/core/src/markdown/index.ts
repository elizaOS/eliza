/** Public surface for Markdown parsing, intermediate representation, and safe chunking. */

export { chunkByParagraph, chunkMarkdownText, chunkText } from "@elizaos/core/markdown/chunk";

export {
  buildCodeSpanIndex,
  type CodeSpanIndex,
  createInlineCodeState,
  type InlineCodeState,
} from "@elizaos/core/markdown/code-spans";
export {
  type FenceSpan,
  findFenceSpanAt,
  isSafeFenceBreak,
  parseFenceSpans,
} from "@elizaos/core/markdown/fences";
export {
  DEFAULT_FRONTMATTER_MAX_DEPTH,
  type FrontmatterDocumentResult,
  type FrontmatterParseErrorCode,
  type ParsedFrontmatter,
  type ParseFrontmatterDocumentOptions,
  parseFrontmatterBlock,
  parseFrontmatterDocument,
} from "@elizaos/core/markdown/frontmatter";

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
} from "@elizaos/core/markdown/ir";
