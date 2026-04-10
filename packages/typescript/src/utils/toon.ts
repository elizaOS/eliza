import { decode as decodeToon, encode as encodeToon } from "@toon-format/toon";
import type { ActionParameters, ActionParameterValue } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripFencedBlock(text: string): string {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:toon|json)?\s*([\s\S]*?)\s*```$/i);
	return fenced?.[1]?.trim() ?? trimmed;
}

function stripOptionalToonLabel(text: string): string {
	const lines = text.trim().split(/\r?\n/);
	if (lines.length < 2) {
		return text.trim();
	}

	const [firstLine, ...rest] = lines;
	if (!/^TOON(?:\s+DOCUMENT)?[:\s-]*$/i.test(firstLine.trim())) {
		return text.trim();
	}

	return rest.join("\n").trim();
}

function looksLikeToonDocument(text: string): boolean {
	if (!text) return false;
	if (text.includes("<response>") || text.includes("</response>")) return false;

	const lines = text
		.trim()
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0);
	if (lines.length === 0) {
		return false;
	}

	const firstLine = lines[0]?.trim() ?? "";
	if (/^TOON(?:\s+DOCUMENT)?[:\s-]*$/i.test(firstLine)) {
		return lines
			.slice(1)
			.some((line) => SIMPLE_TOON_KEY_RE.test(line.trim()));
	}

	if (!SIMPLE_TOON_KEY_RE.test(firstLine)) {
		return false;
	}

	if (lines.length === 1) {
		const [, value = ""] = firstLine.split(/:(.*)/s);
		const trimmedValue = value.trim();
		return !(trimmedValue.startsWith("{") && trimmedValue.endsWith("}"));
	}

	let structuredFieldCount = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (SIMPLE_TOON_KEY_RE.test(trimmed)) {
			structuredFieldCount += 1;
			continue;
		}
		if (/^[\t ]+/.test(line)) {
			continue;
		}
		return false;
	}

	return structuredFieldCount > 0;
}

const SIMPLE_TOON_KEY_RE =
	/^([A-Za-z_][A-Za-z0-9_.-]*(?:\[[^\]\n]*\])?(?:\{[^\n]*\})?):(?:\s?(.*))?$/;

export function tryParseToonValue(text: string): unknown | null {
	const trimmed = stripOptionalToonLabel(stripFencedBlock(text));
	if (!looksLikeToonDocument(trimmed)) {
		return null;
	}

	try {
		return decodeToon(trimmed);
	} catch {
		return null;
	}
}

export function tryParseLooseToonRecord(
	text: string,
): Record<string, unknown> | null {
	const trimmed = stripOptionalToonLabel(stripFencedBlock(text));
	if (!looksLikeToonDocument(trimmed)) {
		return null;
	}

	const result: Record<string, unknown> = {};
	let currentKey: string | null = null;
	let parsedAnyField = false;

	for (const line of trimmed.split(/\r?\n/)) {
		const match = line.match(SIMPLE_TOON_KEY_RE);
		if (match) {
			const [, key, value = ""] = match;
			currentKey = key.trim();
			result[currentKey] = value.trim();
			parsedAnyField = true;
			continue;
		}

		if (!currentKey) {
			if (!line.trim()) {
				continue;
			}
			return null;
		}

		const previousValue =
			typeof result[currentKey] === "string"
				? (result[currentKey] as string)
				: "";
		const continuation = line.trimEnd();
		result[currentKey] =
			previousValue.length > 0
				? `${previousValue}\n${continuation}`
				: continuation;
	}

	return parsedAnyField ? result : null;
}

export function encodeToonValue(value: unknown): string {
	return encodeToon(value);
}

export function normalizeStructuredRecord(
	value: unknown,
): Record<string, unknown> | null {
	if (!isRecord(value)) {
		return null;
	}

	const result: Record<string, unknown> = {};

	for (const [key, rawValue] of Object.entries(value)) {
		if (key === "actions" || key === "providers" || key === "evaluators") {
			if (Array.isArray(rawValue)) {
				result[key] = rawValue.map((entry) =>
					typeof entry === "string" ? entry.trim() : entry,
				);
				continue;
			}
			if (typeof rawValue === "string") {
				result[key] =
					rawValue.trim().length > 0
						? rawValue
								.split(",")
								.map((entry) => entry.trim())
								.filter(Boolean)
						: [];
				continue;
			}
		}

		if (key === "simple") {
			result[key] =
				rawValue === true ||
				(typeof rawValue === "string" &&
					rawValue.trim().toLowerCase() === "true");
			continue;
		}

		result[key] = rawValue;
	}

	return Object.keys(result).length > 0 ? result : null;
}

function toActionParameterValue(value: unknown): ActionParameters[string] {
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null
	) {
		return value as ActionParameterValue;
	}

	if (Array.isArray(value)) {
		return value.map((entry) => toActionParameterValue(entry));
	}

	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				toActionParameterValue(entry),
			]),
		);
	}

	return value === undefined ? null : String(value);
}

export function parseToonActionParams(
	input: unknown,
): Map<string, ActionParameters> {
	const parsed =
		typeof input === "string" ? tryParseToonValue(input) : (input ?? null);
	if (!isRecord(parsed)) {
		return new Map();
	}

	const candidate = isRecord(parsed.params) ? parsed.params : parsed;
	const result = new Map<string, ActionParameters>();

	for (const [actionName, paramsValue] of Object.entries(candidate)) {
		if (!isRecord(paramsValue)) continue;

		const params: ActionParameters = {};
		for (const [paramName, paramValue] of Object.entries(paramsValue)) {
			params[paramName] = toActionParameterValue(paramValue);
		}

		if (Object.keys(params).length > 0) {
			result.set(actionName.trim().toUpperCase(), params);
		}
	}

	return result;
}
