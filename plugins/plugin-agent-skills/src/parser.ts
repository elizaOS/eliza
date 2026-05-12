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
	// Match frontmatter block
	const match = content.match(/^---\n([\s\S]*?)\n---\n?/);

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
				// Check if next non-empty line starts with { or [
				let nextLineIdx = i + 1;
				while (nextLineIdx < lines.length && !lines[nextLineIdx].trim()) {
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
 * Parse a YAML scalar value.
 */
function parseYamlValue(value: string): string | number | boolean | null {
	const trimmed = value.trim();

	// Handle quoted strings
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
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
