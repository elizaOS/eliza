/**
 * Canonical bounded YAML-frontmatter parser for Markdown documents.
 *
 * It preserves the complete body, distinguishes absent from malformed input,
 * rejects NULs and excessive nesting before YAML traversal, and exposes legacy
 * string coercion only as an explicit adapter.
 */
import YAML from "yaml";

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
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exceedsNestBound(text: string, maxDepth: number): boolean {
	let flowDepth = 0;
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (inSingle) {
			if (char === "'" && text[index + 1] === "'") index += 1;
			else if (char === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inDouble = false;
			continue;
		}
		if (char === "'") inSingle = true;
		else if (char === '"') inDouble = true;
		else if (char === "{" || char === "[") {
			flowDepth += 1;
			if (flowDepth > maxDepth) return true;
		} else if (char === "}" || char === "]") {
			flowDepth = Math.max(0, flowDepth - 1);
		}
	}

	let blockScalarIndent: number | null = null;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		const indent = line.length - line.trimStart().length;
		if (blockScalarIndent !== null) {
			if (trimmed === "" || indent > blockScalarIndent) continue;
			blockScalarIndent = null;
		}
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		if (Math.floor(indent / 2) > maxDepth) return true;
		if (/[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$/.test(trimmed)) {
			blockScalarIndent = indent;
		}
	}
	return false;
}

/** Parse one complete Markdown document without truncating its body. */
export function parseFrontmatterDocument(
	content: string,
	options: ParseFrontmatterDocumentOptions = {},
): FrontmatterDocumentResult {
	const normalized = normalizeNewlines(content);
	if (!/^---[ \t]*(?:\n|$)/.test(normalized)) {
		return { kind: "none", body: normalized };
	}
	const lines = normalized.split("\n");
	let closingLine = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (/^---[ \t]*$/.test(lines[index])) {
			closingLine = index;
			break;
		}
	}
	if (closingLine === -1) {
		return { kind: "invalid", code: "invalid-delimiter", body: normalized };
	}
	const raw = lines.slice(1, closingLine).join("\n");
	const body = lines.slice(closingLine + 1).join("\n");
	if (raw.includes("\0")) {
		return { kind: "invalid", code: "nul-byte", body, raw };
	}
	const maxDepth = options.maxDepth ?? DEFAULT_FRONTMATTER_MAX_DEPTH;
	if (
		!Number.isInteger(maxDepth) ||
		maxDepth < 1 ||
		exceedsNestBound(raw, maxDepth)
	) {
		return { kind: "invalid", code: "nest-bound", body, raw };
	}
	let parsed: unknown;
	try {
		parsed = YAML.parse(raw, { maxAliasCount: 100, uniqueKeys: true });
	} catch (cause) {
		// error-policy:J3 malformed untrusted frontmatter is an explicit result.
		return { kind: "invalid", code: "invalid-yaml", body, raw, cause };
	}
	if (parsed == null) {
		return { kind: "parsed", frontmatter: {}, body, raw };
	}
	if (!isPlainRecord(parsed)) {
		return { kind: "invalid", code: "invalid-root", body, raw };
	}
	return { kind: "parsed", frontmatter: parsed, body, raw };
}

/** Legacy Markdown metadata representation with explicitly coerced values. */
export type ParsedFrontmatter = Record<string, string>;

function coerceFrontmatterValue(value: unknown): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (typeof value === "object") return JSON.stringify(value);
	return undefined;
}

function parseLegacyLineMetadata(raw: string): ParsedFrontmatter {
	const result: ParsedFrontmatter = {};
	const lines = raw.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const match = lines[index].match(/^([\w-]+):\s*(.*)$/);
		if (!match) continue;
		const [, key, inline] = match;
		if (inline.trim()) {
			result[key] = inline.trim().replace(/^(?:"|')|(?:"|')$/g, "");
			continue;
		}
		const continuation: string[] = [];
		while (
			index + 1 < lines.length &&
			(lines[index + 1].startsWith(" ") || lines[index + 1].startsWith("\t"))
		) {
			continuation.push(lines[index + 1]);
			index += 1;
		}
		const value = continuation.join("\n").trim();
		if (value) result[key] = value;
	}
	return result;
}

/** Compatibility adapter for callers that consume only string metadata. */
export function parseFrontmatterBlock(content: string): ParsedFrontmatter {
	const parsed = parseFrontmatterDocument(content);
	if (parsed.kind === "invalid") {
		return parsed.raw ? parseLegacyLineMetadata(parsed.raw) : {};
	}
	if (parsed.kind === "none") return {};
	const result: ParsedFrontmatter = {};
	for (const [rawKey, value] of Object.entries(parsed.frontmatter)) {
		const key = rawKey.trim();
		const coerced = coerceFrontmatterValue(value);
		if (key && coerced !== undefined) result[key] = coerced;
	}
	return result;
}
