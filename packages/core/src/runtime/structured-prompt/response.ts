/** Recovers JSON response objects from raw model text, fenced blocks, and embedded objects.
 * Diagnostic recovery messages use the calling runtime logger. */
import type { Logger } from "../../logger";
import { parseJSONObjectFromText } from "../../utils";
import type { StructuredResponseFormat } from "./types";

const STRUCTURED_CODE_FENCE_PATTERN = /```([^\n`]*)\r?\n?([\s\S]*?)```/g;
const JSON_OBJECT_KEY_PATTERN =
	/(?:["'][^"'\n]+["']|[A-Za-z_][A-Za-z0-9_-]*)\s*:/;
type StructuredResponseCandidate = {
	text: string;
	formats: StructuredResponseFormat[];
	source: string;
};

export function normalizeStructuredResponse(
	responseContent: Record<string, unknown> | null,
	depth = 0,
): Record<string, unknown> | null {
	if (!responseContent) return null;

	// Safety limit to prevent infinite recursion on pathological input
	const MAX_UNWRAP_DEPTH = 3;
	if (depth >= MAX_UNWRAP_DEPTH) return responseContent;

	// If there's a nested 'response' object with the actual fields, unwrap it
	if (
		"response" in responseContent &&
		typeof responseContent.response === "object" &&
		responseContent.response !== null
	) {
		const nested = responseContent.response as Record<string, unknown>;
		// Only unwrap if nested has fields (not empty)
		if (Object.keys(nested).length > 0) {
			// Recursively unwrap in case of multiple nesting levels
			return normalizeStructuredResponse(nested, depth + 1);
		}
	}
	return responseContent;
}

export function parseStructuredResponse(
	response: string,
	expectedFormat: StructuredResponseFormat,
	logger: Pick<Logger, "debug">,
): Record<string, unknown> | null {
	const candidates = extractStructuredResponseCandidates(response);

	for (const candidate of candidates) {
		if (!candidate.formats.includes("JSON")) {
			continue;
		}

		const parsed = parseJSONObjectFromText(candidate.text);
		if (parsed) {
			if (candidate.source !== "raw" || expectedFormat !== "JSON") {
				logger.debug(
					`dynamicPromptExecFromState recovered JSON from ${candidate.source}`,
				);
			}
			return parsed;
		}
	}

	return null;
}

export function extractStructuredResponseCandidates(
	response: string,
): StructuredResponseCandidate[] {
	const seen = new Set<string>();
	const candidates: StructuredResponseCandidate[] = [];

	const addCandidate = (
		text: string,
		source: string,
		hints: StructuredResponseFormat[] = [],
	): void => {
		const trimmed = text.trim();
		if (!trimmed || seen.has(trimmed)) {
			return;
		}

		const formats = Array.from(
			new Set([...hints, ...detectStructuredResponseFormats(trimmed)]),
		);
		if (formats.length === 0) {
			return;
		}

		seen.add(trimmed);
		candidates.push({ text: trimmed, formats, source });
	};

	addCandidate(response, "raw");

	for (const match of response.matchAll(STRUCTURED_CODE_FENCE_PATTERN)) {
		const label = match[1]?.trim().toLowerCase() ?? "";
		const content = match[2]?.trim() ?? "";
		const hints: StructuredResponseFormat[] =
			label === "json" || label === "json5" ? ["JSON"] : [];
		addCandidate(content, label ? `fence:${label}` : "fence", hints);
	}

	const embeddedJson = extractEmbeddedJsonObject(response);
	if (embeddedJson) {
		addCandidate(embeddedJson, "embedded-json", ["JSON"]);
	}

	return candidates;
}

export function detectStructuredResponseFormats(
	text: string,
): StructuredResponseFormat[] {
	const trimmed = text.trim();
	const formats: StructuredResponseFormat[] = [];

	if (looksLikeJsonObject(trimmed)) {
		formats.push("JSON");
	}
	return formats;
}

export function looksLikeJsonObject(text: string): boolean {
	const trimmed = text.trim();
	return (
		trimmed.startsWith("{") &&
		trimmed.includes("}") &&
		JSON_OBJECT_KEY_PATTERN.test(trimmed)
	);
}

export function extractEmbeddedJsonObject(text: string): string | null {
	const trimmed = text.trim();
	if (looksLikeJsonObject(trimmed)) {
		return trimmed;
	}

	for (
		let start = text.indexOf("{");
		start !== -1;
		start = text.indexOf("{", start + 1)
	) {
		const candidate = extractBalancedJsonObject(text, start);
		if (candidate && looksLikeJsonObject(candidate)) {
			return candidate.trim();
		}
	}

	return null;
}

export function extractBalancedJsonObject(
	text: string,
	startIndex: number,
): string | null {
	let depth = 0;
	let inString = false;
	let stringQuote = "";
	let escaped = false;

	for (let index = startIndex; index < text.length; index++) {
		const char = text[index] ?? "";

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === stringQuote) {
				inString = false;
				stringQuote = "";
			}
			continue;
		}

		if (char === '"' || char === "'") {
			inString = true;
			stringQuote = char;
			continue;
		}

		if (char === "{") {
			depth += 1;
			continue;
		}

		if (char !== "}") {
			continue;
		}

		depth -= 1;
		if (depth === 0) {
			return text.slice(startIndex, index + 1);
		}
		if (depth < 0) {
			return null;
		}
	}

	return null;
}
