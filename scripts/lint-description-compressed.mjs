#!/usr/bin/env node
/**
 * Ad-hoc CI lint: walks `plugins/` for hand-authored `descriptionCompressed`
 * literals and runs them through a JS twin of `lintDescriptionCompressed` from
 * `@elizaos/core`. Prints `<plugin>:<file>:<line> [violation]: "<text>"` for
 * each violation and exits with status 1 if any are found.
 *
 * The lint rules MUST stay in sync with
 * `packages/core/src/utils/description-compressed-lint.ts`. The TS version is
 * the canonical export; this file mirrors it because the script runs under
 * plain `node` (no TypeScript loader).
 *
 * This script does NOT fail any package build today — it is plugged into the
 * root-level `lint:descriptions` script and intended to be wired into CI as a
 * standalone job. Sweep work tracked in P5.4 of the plugin-action audit.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PLUGINS_ROOT = path.join(REPO_ROOT, "plugins");

const SKIPPED_DIR_NAMES = new Set([
	"node_modules",
	"dist",
	".turbo",
	".cache",
	"coverage",
]);

const MAX_DESCRIPTION_LENGTH = 160;

const BANNED_PHRASES = [
	{ phrase: "in order to", pattern: /\bin order to\b/i },
	{ phrase: "please", pattern: /\bplease\b/i },
	{ phrase: "simply", pattern: /\bsimply\b/i },
	{ phrase: "basically", pattern: /\bbasically\b/i },
	{ phrase: "actually", pattern: /\bactually\b/i },
	{ phrase: "currently", pattern: /\bcurrently\b/i },
	{ phrase: "this action", pattern: /\bthis action\b/i },
	{ phrase: "use this action", pattern: /\buse this action\b/i },
	{ phrase: "the user", pattern: /\bthe user\b/i },
	{ phrase: "the agent", pattern: /\bthe agent\b/i },
];

const BANNED_WORDS = [
	{ word: "messages", pattern: /\bmessages\b/i, replacement: "msgs" },
	{
		word: "configuration",
		pattern: /\bconfiguration\b/i,
		replacement: "config",
	},
];

const NON_IMPERATIVE_LEADING_WORDS = new Set([
	"It",
	"This",
	"Helps",
	"Allows",
	"Should",
	"Provides",
	"Retrieves",
	"Returns",
	"Generates",
	"Creates",
	"Updates",
	"Deletes",
	"Sends",
	"Extracts",
	"Identifies",
	"Summarizes",
	"Compresses",
	"Automatically",
]);

/**
 * @param {string} text
 * @returns {{ ok: boolean; violations: string[] }}
 */
function lintDescriptionCompressed(text) {
	const violations = [];

	if (typeof text !== "string" || !text.trim()) {
		violations.push("empty: descriptionCompressed must be non-empty");
		return { ok: false, violations };
	}

	const value = text;

	if (value.length > MAX_DESCRIPTION_LENGTH) {
		violations.push(
			`length: descriptionCompressed is ${value.length} chars (max ${MAX_DESCRIPTION_LENGTH})`,
		);
	}

	for (const { phrase, pattern } of BANNED_PHRASES) {
		if (pattern.test(value)) {
			violations.push(
				`banned-phrase: descriptionCompressed contains "${phrase}" (compressor would strip/replace)`,
			);
		}
	}

	for (const { word, pattern, replacement } of BANNED_WORDS) {
		if (pattern.test(value)) {
			violations.push(
				`banned-word: descriptionCompressed uses "${word}" (use "${replacement}" instead)`,
			);
		}
	}

	const firstWordMatch = value.trim().match(/^([A-Za-z][A-Za-z0-9_-]*)/);
	if (firstWordMatch) {
		const firstWord = firstWordMatch[1];
		if (NON_IMPERATIVE_LEADING_WORDS.has(firstWord)) {
			violations.push(
				`non-imperative: descriptionCompressed starts with "${firstWord}" — use an imperative verb (e.g. "Send", "Get", "List")`,
			);
		}
	}

	return { ok: violations.length === 0, violations };
}

const DESCRIPTION_COMPRESSED_PATTERN =
	/descriptionCompressed\s*:\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)(?:\s*\+\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`))*)/g;

const STRING_LITERAL_PATTERN =
	/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;

/** @param {string} raw */
function parseStringLiteral(raw) {
	const quote = raw[0];
	const body = raw.slice(1, -1);
	if (quote === '"') {
		return JSON.parse(raw);
	}
	return body
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\`/g, "`")
		.replace(/\\'/g, "'")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

/**
 * @param {string} dir
 * @returns {Generator<string>}
 */
function* walkTypeScriptFiles(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
			yield* walkTypeScriptFiles(full);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
		if (entry.name.endsWith(".d.ts")) continue;
		yield full;
	}
}

/**
 * @param {string} source
 * @returns {Array<{ value: string; line: number }>}
 */
function extractDescriptionCompressedLiterals(source) {
	const entries = [];
	DESCRIPTION_COMPRESSED_PATTERN.lastIndex = 0;
	let match;
	while ((match = DESCRIPTION_COMPRESSED_PATTERN.exec(source))) {
		const rawInitializer = match[1];
		const literals = rawInitializer.match(STRING_LITERAL_PATTERN) ?? [];
		const value = literals.map(parseStringLiteral).join("");
		const line = source.slice(0, match.index).split(/\r?\n/).length;
		entries.push({ value, line });
	}
	return entries;
}

/**
 * @param {string} absoluteFile
 * @returns {{ pluginName: string; relativeFile: string }}
 */
function locatePlugin(absoluteFile) {
	const rel = path.relative(PLUGINS_ROOT, absoluteFile);
	const segments = rel.split(path.sep);
	const pluginName = segments[0] ?? "";
	return {
		pluginName,
		relativeFile: path.join("plugins", ...segments),
	};
}

function main() {
	if (!fs.existsSync(PLUGINS_ROOT)) {
		console.error(
			`[lint:descriptions] plugins root not found at ${PLUGINS_ROOT}`,
		);
		process.exit(2);
	}

	let scannedFiles = 0;
	let scannedDescriptions = 0;
	const lines = [];

	for (const absoluteFile of walkTypeScriptFiles(PLUGINS_ROOT)) {
		scannedFiles += 1;
		let source;
		try {
			source = fs.readFileSync(absoluteFile, "utf8");
		} catch (err) {
			console.error(
				`[lint:descriptions] failed to read ${absoluteFile}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			continue;
		}
		const literals = extractDescriptionCompressedLiterals(source);
		if (literals.length === 0) continue;

		const { pluginName, relativeFile } = locatePlugin(absoluteFile);

		for (const { value, line } of literals) {
			scannedDescriptions += 1;
			const result = lintDescriptionCompressed(value);
			if (result.ok) continue;
			for (const violation of result.violations) {
				const tag = violation.split(":", 1)[0];
				lines.push(
					`${pluginName}:${relativeFile}:${line} [${tag}]: ${JSON.stringify(value)}`,
				);
			}
		}
	}

	if (lines.length === 0) {
		console.log(
			`[lint:descriptions] OK — scanned ${scannedDescriptions} descriptionCompressed literal(s) across ${scannedFiles} file(s).`,
		);
		process.exit(0);
	}

	for (const line of lines) {
		console.log(line);
	}
	console.error(
		`\n[lint:descriptions] ${lines.length} violation(s) across ${scannedDescriptions} descriptionCompressed literal(s) in ${scannedFiles} file(s).`,
	);
	process.exit(1);
}

main();
