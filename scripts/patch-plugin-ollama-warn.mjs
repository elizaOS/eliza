#!/usr/bin/env node
/**
 * patch-plugin-ollama-warn.mjs
 *
 * @elizaos/plugin-ollama 1.2.x logs a warning with "${baseURL}" inside a double-quoted
 * string, so the URL never interpolates. Replace that argument with a template literal.
 * Idempotent: skips if already patched or needle missing.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const NEEDLE =
	'"Ollama functionality will be limited until a valid endpoint is provided - Make sure Ollama is running at ${baseURL}"';

const REPLACEMENT = `\`Ollama functionality will be limited until a valid endpoint is provided - Make sure Ollama is running at \${baseURL}\``;

function patchFile(filePath) {
	if (!existsSync(filePath)) return false;
	let s = readFileSync(filePath, "utf8");
	if (!s.includes(NEEDLE)) return false;
	s = s.replace(NEEDLE, REPLACEMENT);
	writeFileSync(filePath, s);
	console.log(`[patch-plugin-ollama-warn] Patched ${filePath}`);
	return true;
}

function walkBunPluginOllama() {
	const bunDir = join(repoRoot, "node_modules", ".bun");
	if (!existsSync(bunDir)) return;
	for (const entry of readdirSync(bunDir)) {
		if (!entry.startsWith("@elizaos+plugin-ollama@")) continue;
		const candidate = join(
			bunDir,
			entry,
			"node_modules",
			"@elizaos",
			"plugin-ollama",
			"dist",
			"index.js",
		);
		patchFile(candidate);
	}
}

patchFile(join(repoRoot, "agent", "node_modules", "@elizaos", "plugin-ollama", "dist", "index.js"));
patchFile(join(repoRoot, "node_modules", "@elizaos", "plugin-ollama", "dist", "index.js"));
walkBunPluginOllama();
