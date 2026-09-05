/**
 * Skill Parser
 *
 * Parses and validates SKILL.md files according to the Agent Skills specification.
 *
 * @see https://agentskills.io/specification
 */

import type {
	SkillFrontmatter,
	SkillMetadata,
	SkillValidationError,
	SkillValidationResult,
	SkillValidationWarning,
} from "./types";

import {
	SKILL_BIN_NAME_PATTERN,
	SKILL_COMPATIBILITY_MAX_LENGTH,
	SKILL_DESCRIPTION_MAX_LENGTH,
	SKILL_NAME_MAX_LENGTH,
	SKILL_NAME_PATTERN,
} from "./types";

// ============================================================
// FRONTMATTER PARSING
// ============================================================

/**
 * Parse YAML frontmatter from SKILL.md content.
 *
 * Extracts the YAML block between --- markers and parses it.
 * Does NOT use a full YAML parser to avoid dependencies - handles
 * the subset of YAML commonly used in skill files.
 */
export function parseFrontmatter(content: string): {
	frontmatter: SkillFrontmatter | null;
	body: string;
	raw: string;
} {
	// Match frontmatter block regardless of line-ending style.
	const match = content.match(/^---(?:\r?\n)([\s\S]*?)(?:\r?\n)---(?:\r?\n)?/);

	if (!match) {
		return { frontmatter: null, body: content, raw: "" };
	}

	const raw = match[1];
	const body = content.slice(match[0].length).trim();

	try {
		const parsed = parseYamlSubset(raw);
		const frontmatter = toSkillFrontmatter(parsed);
		return { frontmatter, body, raw };
	} catch {
		return { frontmatter: null, body, raw };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSkillMetadata(value: unknown): value is SkillMetadata {
	if (!isRecord(value)) {
		return false;
	}
	return Object.values(value).every(
		(item) =>
			item === undefined ||
			typeof item === "string" ||
			typeof item === "number" ||
			typeof item === "boolean" ||
			isRecord(item),
	);
}

function toSkillFrontmatter(
	value: Record<string, unknown>,
): SkillFrontmatter | null {
	if (
		typeof value.name !== "string" ||
		typeof value.description !== "string"
	) {
		return null;
	}
	const frontmatter: SkillFrontmatter = {
		name: value.name,
		description: value.description,
	};
	if (typeof value.license === "string") {
		frontmatter.license = value.license;
	}
	if (typeof value.compatibility === "string") {
		frontmatter.compatibility = value.compatibility;
	}
	if (isSkillMetadata(value.metadata)) {
		frontmatter.metadata = value.metadata;
	}
	if (typeof value["allowed-tools"] === "string") {
		frontmatter["allowed-tools"] = value["allowed-tools"];
	}
	if (typeof value.homepage === "string") {
		frontmatter.homepage = value.homepage;
	}
	return frontmatter;
}

/**
 * Parse a subset of YAML sufficient for skill frontmatter.
 * Handles strings, numbers, booleans, nested objects, and embedded JSON.
 */
function parseYamlSubset(yaml: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = yaml.split("\n");

	let _currentKey = "";
	let _currentIndent = 0;
	const stack: { obj: Record<string, unknown>; indent: number }[] = [
		{ obj: result, indent: -1 },
	];

	// Track multiline JSON parsing
	let collectingJson = false;
	let jsonBuffer = "";
	let jsonDepth = 0;
	let jsonKey = "";
	let jsonParent: Record<string, unknown> | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// If we're collecting a multiline JSON object
		if (collectingJson) {
			// Skip empty lines within JSON
			if (!trimmed) continue;

			jsonBuffer += trimmed;

			// Count braces/brackets (ignoring those inside strings)
			let inString = false;
			let isEscaped = false;
			for (const char of trimmed) {
				if (isEscaped) {
					isEscaped = false;
					continue;
				}
				if (char === "\\") {
					isEscaped = true;
					continue;
				}
				if (char === '"') {
					inString = !inString;
					continue;
				}
				if (!inString) {
					if (char === "{" || char === "[") jsonDepth++;
					else if (char === "}" || char === "]") jsonDepth--;
				}
			}

			// If we've closed all braces, parse the complete JSON
			if (jsonDepth === 0) {
				try {
					// Remove trailing commas before ] or } (JSON5-style cleanup)
					const cleanedJson = jsonBuffer.replace(/,(\s*[}\]])/g, "$1");
					if (jsonParent) {
						jsonParent[jsonKey] = JSON.parse(cleanedJson);
					}
				} catch {
					// If JSON parse fails, store as string
					if (jsonParent) {
						jsonParent[jsonKey] = jsonBuffer;
					}
				}
				collectingJson = false;
				jsonBuffer = "";
				jsonKey = "";
				jsonParent = null;
			}
			continue;
		}

		// Skip empty lines and comments
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Calculate indentation
		const indent = line.search(/\S/);

		// Handle key-value pairs
		const kvMatch = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)/);
		if (kvMatch) {
			const [, key, valueStr] = kvMatch;

			// Pop stack until we find appropriate parent
			while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
				stack.pop();
			}

			const parent = stack[stack.length - 1].obj;

			if (valueStr === "" || valueStr === "|" || valueStr === ">") {
				// Could be object, multiline string, or multiline JSON
				// Check the first meaningful line. Blank lines and YAML comments
				// carry no structure, so skip both: a comment between an empty key
				// and its first `- ` item must not misroute a block sequence to the
				// nested-object path (which merges the list into one mapping).
				let nextLineIdx = i + 1;
				while (
					nextLineIdx < lines.length &&
					(!lines[nextLineIdx].trim() ||
						lines[nextLineIdx].trim().startsWith("#"))
				) {
					nextLineIdx++;
				}
				const nextTrimmed =
					nextLineIdx < lines.length ? lines[nextLineIdx].trim() : "";

				if (nextTrimmed.startsWith("{") || nextTrimmed.startsWith("[")) {
					// Multiline JSON - set up to collect it
					jsonKey = key;
					jsonParent = parent;
					jsonBuffer = "";
					jsonDepth = 0;
					collectingJson = true;
				} else if (
					nextTrimmed === "-" ||
					nextTrimmed.startsWith("- ")
				) {
					// YAML block sequence (`- item` lines). Collect the list into an
					// array so a documented `metadata.otto.install` list survives as
					// OttoInstallOption[] instead of being merged into one object.
					const listIndent = lines[nextLineIdx].search(/\S/);
					const { items, nextIdx } = parseListBlock(
						lines,
						nextLineIdx,
						listIndent,
					);
					parent[key] = items;
					i = nextIdx - 1;
				} else {
					// Regular nested object
					const childObj: Record<string, unknown> = {};
					parent[key] = childObj;
					stack.push({ obj: childObj, indent });
					_currentKey = key;
					_currentIndent = indent;
				}
			} else if (valueStr.startsWith("{") || valueStr.startsWith("[")) {
				// Could be inline JSON or start of multiline JSON
				// Count braces to determine (ignoring those inside strings)
				let depth = 0;
				let inString = false;
				let isEscaped = false;
				for (const char of valueStr) {
					if (isEscaped) {
						isEscaped = false;
						continue;
					}
					if (char === "\\") {
						isEscaped = true;
						continue;
					}
					if (char === '"') {
						inString = !inString;
						continue;
					}
					if (!inString) {
						if (char === "{" || char === "[") depth++;
						else if (char === "}" || char === "]") depth--;
					}
				}

				if (depth === 0) {
					// Complete inline JSON
					try {
						const cleanedJson = valueStr.replace(/,(\s*[}\]])/g, "$1");
						parent[key] = JSON.parse(cleanedJson);
					} catch {
						parent[key] = valueStr;
					}
				} else {
					// Start of multiline JSON
					jsonKey = key;
					jsonParent = parent;
					jsonBuffer = valueStr;
					jsonDepth = depth;
					collectingJson = true;
				}
			} else {
				// Simple value
				parent[key] = parseYamlValue(valueStr);
			}
		}
	}

	return result;
}

/**
 * Parse one YAML block sequence into an array of items.
 *
 * Called from {@link parseYamlSubset} when a key's value is empty and the next
 * non-empty line at deeper indent is a `- ` item. Each item is one of:
 * a mapping (the dash remainder is the first `key: value`, following
 * deeper-indented lines are more entries), a nested block (bare `-` then
 * deeper-indented lines), or a scalar/inline-JSON (`- gh`, `- ["gh"]`). Mapping
 * and nested items recurse through `parseYamlSubset` so existing scalar,
 * nested-object, and inline/multiline JSON handling applies unchanged inside a
 * list item. Returns the parsed items and the index of the first line past the
 * sequence so the caller can resume.
 */
function parseListBlock(
	lines: string[],
	startIdx: number,
	listIndent: number,
): { items: unknown[]; nextIdx: number } {
	const items: unknown[] = [];
	let i = startIdx;

	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		if (!trimmed || trimmed.startsWith("#")) {
			i++;
			continue;
		}

		const indent = line.search(/\S/);
		// A dedent below the list column, or a deeper/non-`-` line, ends the list.
		if (indent < listIndent) break;
		if (indent > listIndent || !(trimmed === "-" || trimmed.startsWith("- "))) {
			break;
		}

		const remainder = trimmed.replace(/^-\s*/, "");

		// Gather continuation lines that belong to this item (deeper indent).
		const itemLines: string[] = [];
		let j = i + 1;
		while (j < lines.length) {
			const l = lines[j];
			const t = l.trim();
			if (!t || t.startsWith("#")) {
				itemLines.push(l);
				j++;
				continue;
			}
			if (l.search(/\S/) <= listIndent) break;
			itemLines.push(l);
			j++;
		}

		if (remainder === "") {
			// Bare `-`: the item is defined entirely by its continuation lines.
			items.push(
				itemLines.length ? parseYamlSubset(itemLines.join("\n")) : null,
			);
		} else if (/^[A-Za-z0-9_-]+:(\s|$)/.test(remainder)) {
			// Mapping item: the dash remainder is the first `key: value` pair.
			const firstKeyPad = " ".repeat(listIndent + 2);
			const block = [`${firstKeyPad}${remainder}`, ...itemLines].join("\n");
			items.push(parseYamlSubset(block));
		} else {
			// Scalar (or inline JSON) list item, e.g. `- gh` or `- ["gh"]`.
			items.push(parseListScalar(remainder));
		}

		i = j;
	}

	return { items, nextIdx: i };
}

/**
 * Parse a single scalar list item, honoring inline JSON before YAML scalars.
 */
function parseListScalar(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return JSON.parse(trimmed.replace(/,(\s*[}\]])/g, "$1"));
		} catch {
			// error-policy:J3 untrusted-input sanitizing — not valid JSON, keep the
			// raw scalar text rather than fabricating a structured value.
			return trimmed;
		}
	}
	return parseYamlValue(trimmed);
}

/**
 * Decode a single-line YAML frontmatter scalar into its exact string value.
 *
 * A double-quoted scalar is decoded as a strict JSON string literal so the
 * standard escapes (`\"`, `\\`, `\n`, `\uXXXX`, ...) round-trip back to the
 * precise source string; this is what lets a generated `description` survive
 * embedded quotes, backslashes, Unicode, and control characters without
 * corruption or YAML type coercion. When the quoted text is not a valid JSON
 * string literal the function falls back to the historical delimiter strip so
 * hand-authored frontmatter that only used quotes as plain delimiters keeps its
 * prior behavior. Single-quoted scalars have their delimiters stripped; a bare
 * scalar is returned trimmed. Shared by the frontmatter parser and the
 * filesystem discovery scan so both read a written scalar identically.
 */
export function decodeFrontmatterScalarString(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			const decoded = JSON.parse(trimmed);
			if (typeof decoded === "string") return decoded;
		} catch {
			// error-policy:J3 untrusted-input sanitizing — not a valid JSON string
			// literal, fall back to the legacy delimiter strip below.
		}
		return trimmed.slice(1, -1);
	}
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/**
 * Parse a YAML scalar value.
 */
function parseYamlValue(value: string): string | number | boolean | null {
	const trimmed = value.trim();

	// Handle quoted strings
	if (
		(trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return decodeFrontmatterScalarString(trimmed);
	}

	// Handle booleans
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;

	// Handle null
	if (trimmed === "null" || trimmed === "~") return null;

	// Handle numbers
	if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
	if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);

	// Default to string
	return trimmed;
}

// ============================================================
// VALIDATION
// ============================================================

/**
 * Collect invalid binary names declared in Otto metadata.
 *
 * `requires.bins` and `install[].bins` entries are passed to `which`/`where`
 * probes at eligibility-check and dependency-install time, so they must be
 * bare executable names matching SKILL_BIN_NAME_PATTERN. Anything else
 * (shell metacharacters, whitespace, path separators, leading dashes,
 * non-strings) is reported so callers can reject the skill. Shared by
 * validateFrontmatter and the security scanner.
 */
export function findInvalidSkillBinNames(
	frontmatter: SkillFrontmatter,
): Array<{ field: string; bin: unknown }> {
	const invalid: Array<{ field: string; bin: unknown }> = [];
	const otto = frontmatter.metadata?.otto;

	const check = (field: string, bins: unknown): void => {
		if (!Array.isArray(bins)) return;
		for (const bin of bins) {
			if (typeof bin !== "string" || !SKILL_BIN_NAME_PATTERN.test(bin)) {
				invalid.push({ field, bin });
			}
		}
	};

	check("metadata.otto.requires.bins", otto?.requires?.bins);
	if (Array.isArray(otto?.install)) {
		for (let i = 0; i < otto.install.length; i++) {
			check(`metadata.otto.install[${i}].bins`, otto.install[i]?.bins);
		}
	}

	return invalid;
}

/**
 * Validate a skill's frontmatter according to the Agent Skills specification.
 */
export function validateFrontmatter(
	frontmatter: SkillFrontmatter,
	directoryName?: string,
): SkillValidationResult {
	const errors: SkillValidationError[] = [];
	const warnings: SkillValidationWarning[] = [];

	// Required: name
	if (!frontmatter.name) {
		errors.push({
			field: "name",
			message: "name is required",
			code: "MISSING_NAME",
		});
	} else {
		// Validate name format
		if (frontmatter.name.length > SKILL_NAME_MAX_LENGTH) {
			errors.push({
				field: "name",
				message: `name must be ${SKILL_NAME_MAX_LENGTH} characters or less`,
				code: "NAME_TOO_LONG",
			});
		}

		if (!SKILL_NAME_PATTERN.test(frontmatter.name)) {
			errors.push({
				field: "name",
				message:
					"name must contain only lowercase letters, numbers, and hyphens, cannot start/end with hyphen or have consecutive hyphens",
				code: "INVALID_NAME_FORMAT",
			});
		}

		if (frontmatter.name.startsWith("-") || frontmatter.name.endsWith("-")) {
			errors.push({
				field: "name",
				message: "name cannot start or end with a hyphen",
				code: "NAME_INVALID_HYPHEN",
			});
		}

		if (frontmatter.name.includes("--")) {
			errors.push({
				field: "name",
				message: "name cannot contain consecutive hyphens",
				code: "NAME_CONSECUTIVE_HYPHENS",
			});
		}

		// Check directory name matches
		if (directoryName && directoryName !== frontmatter.name) {
			errors.push({
				field: "name",
				message: `name "${frontmatter.name}" must match directory name "${directoryName}"`,
				code: "NAME_MISMATCH",
			});
		}
	}

	// Required: description
	if (!frontmatter.description) {
		errors.push({
			field: "description",
			message: "description is required",
			code: "MISSING_DESCRIPTION",
		});
	} else {
		if (frontmatter.description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
			errors.push({
				field: "description",
				message: `description must be ${SKILL_DESCRIPTION_MAX_LENGTH} characters or less`,
				code: "DESCRIPTION_TOO_LONG",
			});
		}

		// Warn about poor descriptions
		if (frontmatter.description.length < 20) {
			warnings.push({
				field: "description",
				message:
					"description is very short; consider adding more detail about when to use this skill",
				code: "DESCRIPTION_TOO_SHORT",
			});
		}
	}

	// Optional: compatibility
	if (frontmatter.compatibility) {
		if (frontmatter.compatibility.length > SKILL_COMPATIBILITY_MAX_LENGTH) {
			errors.push({
				field: "compatibility",
				message: `compatibility must be ${SKILL_COMPATIBILITY_MAX_LENGTH} characters or less`,
				code: "COMPATIBILITY_TOO_LONG",
			});
		}
	}

	// Optional: otto bin names reach `which`/`where` probes, so they must be
	// bare executable names — registry-controlled frontmatter is untrusted.
	for (const { field, bin } of findInvalidSkillBinNames(frontmatter)) {
		errors.push({
			field,
			message: `invalid binary name ${JSON.stringify(bin)} in ${field}: must contain only letters, digits, and . _ + -, starting with a letter or digit`,
			code: "INVALID_BIN_NAME",
		});
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

/**
 * Validate a complete skill directory.
 */
export function validateSkillDirectory(
	_path: string,
	content: string,
	directoryName: string,
): SkillValidationResult {
	const errors: SkillValidationError[] = [];
	const warnings: SkillValidationWarning[] = [];

	// Parse frontmatter
	const { frontmatter } = parseFrontmatter(content);

	if (!frontmatter) {
		errors.push({
			field: "frontmatter",
			message: "SKILL.md must have valid YAML frontmatter",
			code: "MISSING_FRONTMATTER",
		});
		return { valid: false, errors, warnings };
	}

	// Validate frontmatter
	const fmResult = validateFrontmatter(frontmatter, directoryName);
	errors.push(...fmResult.errors);
	warnings.push(...fmResult.warnings);

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

// ============================================================
// SKILL BODY EXTRACTION
// ============================================================

/**
 * Extract the body (instructions) from SKILL.md content.
 * Removes frontmatter and returns only the markdown body.
 */
export function extractBody(content: string): string {
	const { body } = parseFrontmatter(content);
	return body;
}

/**
 * Estimate token count for a body of text.
 * Uses a simple heuristic: ~4 characters per token.
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ============================================================
// PROMPT GENERATION
// ============================================================

/**
 * Generate JSON for skill metadata to include in agent prompts.
 */
export function generateSkillsJson(
	skills: Array<{ name: string; description: string; location?: string }>,
	options: { includeLocation?: boolean } = {},
): string {
	if (skills.length === 0) {
		return "";
	}

	return JSON.stringify({
		availableSkills: skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			...(options.includeLocation && skill.location
				? { location: skill.location }
				: {}),
		})),
	});
}
