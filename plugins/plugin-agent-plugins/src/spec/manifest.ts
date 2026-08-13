/**
 * Parse and validate Agent Plugins 1.0.0 plugin.json (§5).
 *
 * Unknown top-level fields are reported and ignored. Other schema violations
 * reject the plugin.
 */

import {
	CLOSED_MANIFEST_FIELDS,
	PLUGIN_SCHEMA_1_0_0,
	type AgentPluginAuthor,
	type AgentPluginManifest,
	type ManifestParseResult,
} from "../types";
import { pluginNameError } from "./names";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
	value: unknown,
	field: string,
	errors: string[],
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		errors.push(`${field} must be a string`);
		return undefined;
	}
	return value;
}

function parseAuthor(
	value: unknown,
	errors: string[],
): AgentPluginAuthor | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		errors.push("author must be an object");
		return undefined;
	}
	const allowed = new Set(["name", "email", "url"]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			errors.push(`author has unknown field "${key}"`);
		} else if (typeof value[key] !== "string") {
			errors.push(`author.${key} must be a string`);
		}
	}
	if (errors.some((e) => e.startsWith("author"))) {
		return undefined;
	}
	return {
		name: typeof value.name === "string" ? value.name : undefined,
		email: typeof value.email === "string" ? value.email : undefined,
		url: typeof value.url === "string" ? value.url : undefined,
	};
}

export function parseManifest(raw: unknown): ManifestParseResult {
	if (!isRecord(raw)) {
		return { ok: false, errors: ["plugin.json must be a JSON object"] };
	}

	const errors: string[] = [];
	const warnings: string[] = [];

	const known = new Set<string>(CLOSED_MANIFEST_FIELDS);
	for (const key of Object.keys(raw)) {
		if (!known.has(key)) {
			warnings.push(`unknown top-level field "${key}" ignored`);
		}
	}

	if (raw.$schema === undefined) {
		errors.push("$schema is required");
	} else if (typeof raw.$schema !== "string") {
		errors.push("$schema must be a string");
	} else if (raw.$schema !== PLUGIN_SCHEMA_1_0_0) {
		errors.push(
			`$schema must be ${PLUGIN_SCHEMA_1_0_0} (unsupported version: ${raw.$schema})`,
		);
	}

	const nameError = pluginNameError(raw.name);
	if (nameError) errors.push(nameError);

	const version = optionalString(raw.version, "version", errors);
	const description = optionalString(raw.description, "description", errors);
	const homepage = optionalString(raw.homepage, "homepage", errors);
	const repository = optionalString(raw.repository, "repository", errors);
	const license = optionalString(raw.license, "license", errors);
	const author = parseAuthor(raw.author, errors);

	let keywords: string[] | undefined;
	if (raw.keywords !== undefined) {
		if (
			!Array.isArray(raw.keywords) ||
			!raw.keywords.every((item) => typeof item === "string")
		) {
			errors.push("keywords must be an array of strings");
		} else {
			keywords = raw.keywords;
		}
	}

	let extensions: Record<string, Record<string, unknown>> | undefined;
	if (raw.extensions !== undefined) {
		if (!isRecord(raw.extensions)) {
			warnings.push("extensions is not an object and was ignored");
		} else {
			extensions = raw.extensions as Record<string, Record<string, unknown>>;
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	const manifest: AgentPluginManifest = {
		$schema: PLUGIN_SCHEMA_1_0_0,
		name: raw.name as string,
	};
	if (version !== undefined) manifest.version = version;
	if (description !== undefined) manifest.description = description;
	if (author !== undefined) manifest.author = author;
	if (homepage !== undefined) manifest.homepage = homepage;
	if (repository !== undefined) manifest.repository = repository;
	if (license !== undefined) manifest.license = license;
	if (keywords !== undefined) manifest.keywords = keywords;
	if (extensions !== undefined) manifest.extensions = extensions;

	return { ok: true, manifest, warnings };
}

export function parseManifestJson(text: string): ManifestParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, errors: ["plugin.json is not valid JSON"] };
	}
	return parseManifest(parsed);
}
