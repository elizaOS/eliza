#!/usr/bin/env node
/**
 * Plugin Discord Spec Generator
 *
 * Reads specs from prompts/specs/** and generates language-native docs modules for:
 * - typescript
 * - python
 * - rust
 *
 * This is adapted from packages/prompts/scripts/generate-action-docs.js
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLUGIN_ROOT = path.resolve(__dirname, "../..");
const PROMPTS_ROOT = path.resolve(__dirname, "..");

const ACTIONS_SPEC_PATH = path.join(PROMPTS_ROOT, "actions.json");
const PROVIDERS_SPEC_PATH = path.join(PROMPTS_ROOT, "providers.json");

function readJson(filePath) {
	if (!fs.existsSync(filePath)) {
		return { version: "1.0.0", actions: [], providers: [] };
	}
	const raw = fs.readFileSync(filePath, "utf-8");
	return JSON.parse(raw);
}

function _listJsonFiles(rootDir) {
	const out = [];
	if (!fs.existsSync(rootDir)) {
		return out;
	}
	const stack = [rootDir];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) break;
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".json")) {
				out.push(full);
			}
		}
	}
	return out.sort((a, b) => a.localeCompare(b));
}

function loadSpecs(specPath, kind) {
	if (!fs.existsSync(specPath)) {
		return {
			core: { version: "1.0.0", items: [] },
			all: { version: "1.0.0", items: [] },
		};
	}

	const root = readJson(specPath);
	const items = kind === "actions" ? root.actions : root.providers;

	return {
		core: {
			version: root.version || "1.0.0",
			items: items,
		},
		all: {
			version: root.version || "1.0.0",
			items: items,
		},
	};
}

/**
 * Ensures a directory exists, creating it and parent directories if necessary.
 * @param {string} dir - The directory path to ensure exists
 * @throws {Error} If the directory path is empty or whitespace-only
 */
function ensureDir(dir) {
	if (!dir || dir.trim() === "") {
		throw new Error("Directory path cannot be empty");
	}
	fs.mkdirSync(dir, { recursive: true });
}

function escapeRustRawString(content) {
	let hashCount = 1;
	while (content.includes(`"${"#".repeat(hashCount)}`)) {
		hashCount++;
	}
	return { content, hashCount };
}

function escapePythonTripleQuoted(content) {
	return content.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
}

function generateTypeScript(actionsSpec, providersSpec) {
	const outDir = path.join(PLUGIN_ROOT, "typescript", "generated", "specs");
	ensureDir(outDir);

	const actionsJson = JSON.stringify(
		{ version: actionsSpec.core.version, actions: actionsSpec.core.items },
		null,
		2,
	);
	const actionsAllJson = JSON.stringify(
		{ version: actionsSpec.all.version, actions: actionsSpec.all.items },
		null,
		2,
	);
	const providersJson = JSON.stringify(
		{
			version: providersSpec.core.version,
			providers: providersSpec.core.items,
		},
		null,
		2,
	);
	const providersAllJson = JSON.stringify(
		{ version: providersSpec.all.version, providers: providersSpec.all.items },
		null,
		2,
	);

	const content = `/**
 * Auto-generated canonical action/provider docs for plugin-local-ai.
 * DO NOT EDIT - Generated from prompts/specs/**.
 */

export type ActionDoc = {
  name: string;
  description: string;
  similes?: readonly string[];
  parameters?: readonly unknown[];
  examples?: readonly (readonly unknown[])[];
};

export type ProviderDoc = {
  name: string;
  description: string;
  position?: number;
  dynamic?: boolean;
};

export const coreActionsSpec = ${actionsJson} as const;
export const allActionsSpec = ${actionsAllJson} as const;
export const coreProvidersSpec = ${providersJson} as const;
export const allProvidersSpec = ${providersAllJson} as const;

export const coreActionDocs: readonly ActionDoc[] = coreActionsSpec.actions;
export const allActionDocs: readonly ActionDoc[] = allActionsSpec.actions;
export const coreProviderDocs: readonly ProviderDoc[] = coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] = allProvidersSpec.providers;
`;

	fs.writeFileSync(path.join(outDir, "specs.ts"), content);

	// Generate spec-helpers.ts
	const helpersContent = `/**
 * Helper functions to lookup action/provider specs by name.
 * These allow language-specific implementations to import their text content
 * (description, similes, examples) from the centralized specs.
 *
 * DO NOT EDIT the spec data - update prompts/actions.json, prompts/providers.json and regenerate.
 */

import {
  coreActionDocs,
  coreProviderDocs,
  allActionDocs,
  allProviderDocs,
  type ActionDoc,
  type ProviderDoc,
} from "./specs";

// Build lookup maps for O(1) access
const coreActionMap = new Map<string, ActionDoc>(
  coreActionDocs.map((doc) => [doc.name, doc])
);
const allActionMap = new Map<string, ActionDoc>(
  allActionDocs.map((doc) => [doc.name, doc])
);
const coreProviderMap = new Map<string, ProviderDoc>(
  coreProviderDocs.map((doc) => [doc.name, doc])
);
const allProviderMap = new Map<string, ProviderDoc>(
  allProviderDocs.map((doc) => [doc.name, doc])
);

/**
 * Get an action spec by name from the core specs.
 * @param name - The action name
 * @returns The action spec or undefined if not found
 */
export function getActionSpec(name: string): ActionDoc | undefined {
  return coreActionMap.get(name) ?? allActionMap.get(name);
}

/**
 * Get an action spec by name, throwing if not found.
 * @param name - The action name
 * @returns The action spec
 * @throws Error if the action is not found
 */
export function requireActionSpec(name: string): ActionDoc {
  const spec = getActionSpec(name);
  if (!spec) {
    throw new Error(\`Action spec not found: \${name}\`);
  }
  return spec;
}

/**
 * Get a provider spec by name from the core specs.
 * @param name - The provider name
 * @returns The provider spec or undefined if not found
 */
export function getProviderSpec(name: string): ProviderDoc | undefined {
  return coreProviderMap.get(name) ?? allProviderMap.get(name);
}

/**
 * Get a provider spec by name, throwing if not found.
 * @param name - The provider name
 * @returns The provider spec
 * @throws Error if the provider is not found
 */
export function requireProviderSpec(name: string): ProviderDoc {
  const spec = getProviderSpec(name);
  if (!spec) {
    throw new Error(\`Provider spec not found: \${name}\`);
  }
  return spec;
}

// Re-export types for convenience
export type { ActionDoc, ProviderDoc };
`;

	fs.writeFileSync(path.join(outDir, "spec-helpers.ts"), helpersContent);
}

function generatePython(actionsSpec, providersSpec) {
	const outDir = path.join(
		PLUGIN_ROOT,
		"python",
		"elizaos_plugin_local-ai",
		"generated",
		"specs",
	);
	ensureDir(outDir);

	const initPath = path.join(outDir, "__init__.py");
	if (!fs.existsSync(initPath)) {
		fs.writeFileSync(initPath, '"""Auto-generated module package."""\n');
	}

	const actionsJson = JSON.stringify(
		{ version: actionsSpec.core.version, actions: actionsSpec.core.items },
		null,
		2,
	);
	const actionsAllJson = JSON.stringify(
		{ version: actionsSpec.all.version, actions: actionsSpec.all.items },
		null,
		2,
	);
	const providersJson = JSON.stringify(
		{
			version: providersSpec.core.version,
			providers: providersSpec.core.items,
		},
		null,
		2,
	);
	const providersAllJson = JSON.stringify(
		{ version: providersSpec.all.version, providers: providersSpec.all.items },
		null,
		2,
	);

	const content = `"""
Auto-generated canonical action/provider docs for plugin-local-ai.
DO NOT EDIT - Generated from prompts/specs/**.
"""

from __future__ import annotations

import json
from typing import TypedDict

class ActionDoc(TypedDict, total=False):
    name: str
    description: str
    similes: list[str]
    parameters: list[object]
    examples: list[list[object]]

class ProviderDoc(TypedDict, total=False):
    name: str
    description: str
    position: int
    dynamic: bool


_CORE_ACTION_DOCS_JSON = """${escapePythonTripleQuoted(actionsJson)}"""
_ALL_ACTION_DOCS_JSON = """${escapePythonTripleQuoted(actionsAllJson)}"""
_CORE_PROVIDER_DOCS_JSON = """${escapePythonTripleQuoted(providersJson)}"""
_ALL_PROVIDER_DOCS_JSON = """${escapePythonTripleQuoted(providersAllJson)}"""

core_action_docs: dict[str, object] = json.loads(_CORE_ACTION_DOCS_JSON)
all_action_docs: dict[str, object] = json.loads(_ALL_ACTION_DOCS_JSON)
core_provider_docs: dict[str, object] = json.loads(_CORE_PROVIDER_DOCS_JSON)
all_provider_docs: dict[str, object] = json.loads(_ALL_PROVIDER_DOCS_JSON)

__all__ = [
    "ActionDoc",
    "ProviderDoc",
    "core_action_docs",
    "all_action_docs",
    "core_provider_docs",
    "all_provider_docs",
]
`;

	fs.writeFileSync(path.join(outDir, "specs.py"), content);
}

function generateRust(actionsSpec, providersSpec) {
	const outDir = path.join(PLUGIN_ROOT, "rust", "src", "generated", "specs");
	ensureDir(outDir);

	const actionsJson = JSON.stringify(
		{ version: actionsSpec.core.version, actions: actionsSpec.core.items },
		null,
		2,
	);
	const actionsAllJson = JSON.stringify(
		{ version: actionsSpec.all.version, actions: actionsSpec.all.items },
		null,
		2,
	);
	const providersJson = JSON.stringify(
		{
			version: providersSpec.core.version,
			providers: providersSpec.core.items,
		},
		null,
		2,
	);
	const providersAllJson = JSON.stringify(
		{ version: providersSpec.all.version, providers: providersSpec.all.items },
		null,
		2,
	);

	const { content: actionsContent, hashCount: actionsHashCount } =
		escapeRustRawString(actionsJson);
	const { content: actionsAllContent, hashCount: actionsAllHashCount } =
		escapeRustRawString(actionsAllJson);
	const { content: providersContent, hashCount: providersHashCount } =
		escapeRustRawString(providersJson);
	const { content: providersAllContent, hashCount: providersAllHashCount } =
		escapeRustRawString(providersAllJson);

	const actionsDelim = "#".repeat(actionsHashCount);
	const actionsAllDelim = "#".repeat(actionsAllHashCount);
	const providersDelim = "#".repeat(providersHashCount);
	const providersAllDelim = "#".repeat(providersAllHashCount);

	const content = `//! Auto-generated canonical action/provider docs for plugin-local-ai.
//! DO NOT EDIT - Generated from prompts/specs/**.

pub const CORE_ACTION_DOCS_JSON: &str = r${actionsDelim}"${actionsContent}"${actionsDelim};
pub const ALL_ACTION_DOCS_JSON: &str = r${actionsAllDelim}"${actionsAllContent}"${actionsAllDelim};
pub const CORE_PROVIDER_DOCS_JSON: &str = r${providersDelim}"${providersContent}"${providersDelim};
pub const ALL_PROVIDER_DOCS_JSON: &str = r${providersAllDelim}"${providersAllContent}"${providersAllDelim};
`;

	fs.writeFileSync(path.join(outDir, "specs.rs"), content);

	const modPath = path.join(outDir, "mod.rs");
	const modContent = `//! Auto-generated specs module.\n\npub mod specs;\n`;
	fs.writeFileSync(modPath, modContent);
}

function main() {
	const actionsSpec = loadSpecs(ACTIONS_SPEC_PATH, "actions");
	const providersSpec = loadSpecs(PROVIDERS_SPEC_PATH, "providers");

	generateTypeScript(actionsSpec, providersSpec);
	generatePython(actionsSpec, providersSpec);
	generateRust(actionsSpec, providersSpec);

	console.log("Generated plugin-local-ai action/provider docs.");
}

main();
