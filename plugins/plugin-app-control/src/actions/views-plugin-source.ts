/**
 * Resolves a registered view's owning plugin to editable local source.
 * Checkout and packaged-install locations share this path so create, edit, and
 * icon operations agree on where a plugin lives.
 */

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { ElizaError, resolveStateDir } from "@elizaos/core";
import type { ViewSummary } from "./views-client.js";

/** Where plugin sources live relative to the repo root, in lookup order. */
const PLUGIN_SOURCE_DIR_CANDIDATES = ["eliza/plugins", "plugins"] as const;

/**
 * Locate the source directory for `view`'s owning plugin under `repoRoot`.
 * Returns the absolute path, or `null` when the plugin is not present as local
 * source (e.g. installed only from npm).
 */
export async function locatePluginSourceDir(
	repoRoot: string,
	view: ViewSummary,
): Promise<string | null> {
	const pluginBasename = view.pluginName.replace(/^@[^/]+\//, "").trim();
	if (
		pluginBasename.length === 0 ||
		pluginBasename === "." ||
		pluginBasename === ".." ||
		pluginBasename.includes("/") ||
		pluginBasename.includes("\\") ||
		pluginBasename.includes("\0")
	) {
		throw new ElizaError("View plugin name is not a safe directory name", {
			code: "VIEW_PLUGIN_NAME_INVALID",
			context: { pluginName: view.pluginName },
		});
	}
	const directoryBasenames = [
		pluginBasename,
		pluginBasename.startsWith("plugin-")
			? pluginBasename.slice("plugin-".length)
			: `plugin-${pluginBasename}`,
	];
	const candidates = directoryBasenames.flatMap((basename) => [
		...PLUGIN_SOURCE_DIR_CANDIDATES.map((dir) =>
			path.join(repoRoot, dir, basename),
		),
		path.join(repoRoot, "eliza", "apps", basename),
		path.join(resolveStateDir(), "plugins", basename),
	]);
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		if ((await fs.stat(candidate)).isDirectory()) return candidate;
	}
	return null;
}
