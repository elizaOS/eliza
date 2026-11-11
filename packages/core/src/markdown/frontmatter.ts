/** Parses bounded YAML frontmatter without losing document content. Rejects NULs and excessive nesting. */
import YAML from "yaml";
import { isPlainObject } from "../utils/type-guards.ts";

export const DEFAULT_FRONTMATTER_MAX_DEPTH = 32;

export type FrontmatterParseErrorCode =
	| "invalid-delimiter"
	| "invalid-yaml"
	| "invalid-root"
	| "nest-bound"
	| "nul-byte";

export type FrontmatterDocumentResult =
	| { kind: "none"; body: string }
	| {
			kind: "parsed";
			frontmatter: Record<string, unknown>;
			body: string;
			raw: string;
	  }
	| {
			kind: "invalid";
			code: FrontmatterParseErrorCode;
			body: string;
			raw?: string;
			cause?: unknown;
	  };

export interface ParseFrontmatterDocumentOptions {
	maxDepth?: number;
}

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function preflightFrontmatter(
	text: string,
	maxDepth: number,
): FrontmatterParseErrorCode | undefined {
	const parser = new YAML.Parser();
	const lexer = new YAML.Lexer();
	for (const lexeme of lexer.lex(text)) {
		for (const token of parser.next(lexeme)) {
			// A failed CST must never be passed to the recursive composer.
			if (token.type === "error") return "invalid-yaml";
		}
		// Existing callers count nesting below the implicit block root; an explicit
		// flow collection is itself one nesting level even at the document root.
		let depth = 0;
		let implicitRoot = false;
		for (const token of parser.stack) {
			if (
				token.type !== "block-map" &&
				token.type !== "block-seq" &&
				token.type !== "flow-collection"
			) {
				continue;
			}
			if (depth === 0) implicitRoot = token.type !== "flow-collection";
			depth += 1;
		}
		if (depth - (implicitRoot ? 1 : 0) > maxDepth) return "nest-bound";
	}
	return undefined;
}

/** Parse one complete Markdown document without truncating its body. */
export function parseFrontmatterDocument(
	content: string,
	options: ParseFrontmatterDocumentOptions = {},
): FrontmatterDocumentResult {
	const normalized = normalizeNewlines(content);
	const document = normalized.startsWith("\uFEFF")
		? normalized.slice(1)
		: normalized;
	if (!/^---[ \t]*(?:\n|$)/.test(document)) {
		return { kind: "none", body: document };
	}
	const lines = document.split("\n");
	let closingLine = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (/^---[ \t]*$/.test(lines[index])) {
			closingLine = index;
			break;
		}
	}
	if (closingLine === -1) {
		return { kind: "invalid", code: "invalid-delimiter", body: document };
	}
	const raw = lines.slice(1, closingLine).join("\n");
	const body = lines.slice(closingLine + 1).join("\n");
	if (raw.includes("\0")) {
		return { kind: "invalid", code: "nul-byte", body, raw };
	}
	const maxDepth = options.maxDepth ?? DEFAULT_FRONTMATTER_MAX_DEPTH;
	if (!Number.isInteger(maxDepth) || maxDepth < 1) {
		return { kind: "invalid", code: "nest-bound", body, raw };
	}
	let parsed: unknown;
	try {
		const preflightError = preflightFrontmatter(raw, maxDepth);
		if (preflightError)
			return { kind: "invalid", code: preflightError, body, raw };
		parsed = YAML.parse(raw, { maxAliasCount: 100, uniqueKeys: true });
	} catch (cause) {
		// error-policy:J3 malformed untrusted frontmatter is an explicit result.
		return { kind: "invalid", code: "invalid-yaml", body, raw, cause };
	}
	if (parsed == null) {
		return { kind: "parsed", frontmatter: {}, body, raw };
	}
	if (!isPlainObject(parsed)) {
		return { kind: "invalid", code: "invalid-root", body, raw };
	}
	return { kind: "parsed", frontmatter: parsed, body, raw };
}
