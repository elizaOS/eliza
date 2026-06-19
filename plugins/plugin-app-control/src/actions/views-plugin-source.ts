/**
 * @module plugin-app-control/actions/views-plugin-source
 *
 * Resolve a view's on-disk plugin source directory from its registry summary.
 * Shared by the create, edit, and icon sub-handlers so plugin-path resolution
 * lives in one place.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
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
	const candidates = [
		...PLUGIN_SOURCE_DIR_CANDIDATES.map((dir) =>
			path.join(repoRoot, dir, pluginBasename),
		),
		path.join(repoRoot, "eliza", "apps", pluginBasename),
	];
	for (const candidate of candidates) {
		const stat = await fs.stat(candidate).catch(() => null);
		if (stat?.isDirectory()) return candidate;
	}
	return null;
}
