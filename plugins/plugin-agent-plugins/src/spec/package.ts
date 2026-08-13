/**
 * Load an Agent Plugin package from a directory root.
 */

import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LoadAgentPluginResult, LoadedMcpState, PluginSource } from "../types";
import { parseManifestJson } from "./manifest";
import { parseMcpJsonText } from "./mcp";
import { isDirectory, isRegularFile, resolveContained } from "./paths";
import { discoverSkills } from "./skills";

function emptyMcp(overrides: Partial<LoadedMcpState> = {}): LoadedMcpState {
	return {
		present: false,
		configValid: true,
		servers: [],
		invalidServers: [],
		errors: [],
		...overrides,
	};
}

export async function loadAgentPlugin(
	root: string,
	source: PluginSource = "path",
): Promise<LoadAgentPluginResult> {
	if (!(await isDirectory(root))) {
		return { ok: false, root, errors: ["plugin root is not a directory"] };
	}

	let resolvedRoot: string;
	try {
		resolvedRoot = await realpath(root);
	} catch {
		return { ok: false, root, errors: ["plugin root is not resolvable"] };
	}

	const manifestContained = await resolveContained(resolvedRoot, "./plugin.json");
	if (!manifestContained.ok) {
		return {
			ok: false,
			root: resolvedRoot,
			errors: ["plugin.json does not resolve within the plugin root"],
		};
	}

	let manifestIsFile = await isRegularFile(manifestContained.path);
	if (!manifestIsFile) {
		try {
			const st = await stat(manifestContained.path);
			manifestIsFile = st.isFile();
		} catch {
			return {
				ok: false,
				root: resolvedRoot,
				errors: ["plugin.json is missing"],
			};
		}
	}
	if (!manifestIsFile) {
		return {
			ok: false,
			root: resolvedRoot,
			errors: ["plugin.json is not a regular file"],
		};
	}

	let text: string;
	try {
		text = await readFile(manifestContained.path, "utf8");
	} catch {
		return {
			ok: false,
			root: resolvedRoot,
			errors: ["plugin.json could not be read"],
		};
	}

	const parsed = parseManifestJson(text);
	if (!parsed.ok) {
		return { ok: false, root: resolvedRoot, errors: parsed.errors };
	}

	const warnings = [...parsed.warnings];
	const skills = await discoverSkills(resolvedRoot);
	warnings.push(...skills.warnings);

	const mcp = await loadMcp(resolvedRoot, parsed.manifest.$schema);

	return {
		ok: true,
		plugin: {
			root: resolvedRoot,
			manifest: parsed.manifest,
			skills: skills.skills,
			skillsLocationInvalid: skills.locationInvalid,
			mcp,
			warnings,
			source,
		},
	};
}

async function loadMcp(
	root: string,
	pluginSchema: string,
): Promise<LoadedMcpState> {
	const mcpPath = join(root, "mcp.json");
	try {
		const st = await lstat(mcpPath);
		if (!st.isFile() && !st.isSymbolicLink()) {
			return emptyMcp({
				present: true,
				configValid: false,
				errors: ["mcp.json exists but is not a regular file"],
			});
		}
	} catch {
		return emptyMcp();
	}

	const contained = await resolveContained(root, "./mcp.json");
	if (!contained.ok) {
		return emptyMcp({
			present: true,
			configValid: false,
			errors: ["mcp.json escapes the plugin root"],
		});
	}

	let text: string;
	try {
		text = await readFile(contained.path, "utf8");
	} catch {
		return emptyMcp({
			present: true,
			configValid: false,
			errors: ["mcp.json could not be read"],
		});
	}

	return parseMcpJsonText(text, root, pluginSchema);
}
