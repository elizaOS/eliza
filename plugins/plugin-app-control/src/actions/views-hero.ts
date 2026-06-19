/**
 * @module plugin-app-control/actions/views-hero
 *
 * Self-contained hero/icon assets for view plugins. A view's hero lives in its
 * own plugin at `assets/hero.svg` and is served by the agent at
 * `/api/views/<id>/hero`. This module writes that asset using the shared,
 * deterministic, no-blue branded generator (`@elizaos/shared`) — the same art
 * the agent's runtime fallback and `scripts/generate-view-heroes.mjs` produce —
 * so a scaffolded or regenerated view always ships a cohesive icon.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { generateViewHeroSvgFor, type ViewHeroSource } from "@elizaos/shared";

/** Hero extensions the agent's registry probes, in its preference order. */
const HERO_EXTENSIONS = [".webp", ".png", ".jpg", ".jpeg", ".svg"] as const;

/** Relative path of the generated SVG hero within a plugin. */
export const HERO_SVG_RELPATH = path.join("assets", "hero.svg");

/** Return the absolute path of the first existing `assets/hero.*` file, if any. */
async function findExistingHero(pluginDir: string): Promise<string | null> {
	const assetsDir = path.join(pluginDir, "assets");
	for (const ext of HERO_EXTENSIONS) {
		const candidate = path.join(assetsDir, `hero${ext}`);
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			// Not present — try the next extension.
		}
	}
	return null;
}

export interface WriteViewHeroResult {
	/** Whether a new hero SVG was written. */
	written: boolean;
	/** Absolute path of the resolved hero asset. */
	absPath: string;
}

/**
 * Write a generated branded hero SVG to `<pluginDir>/assets/hero.svg`.
 *
 * - With `overwrite: false` (default): no-op when the plugin already has any
 *   `assets/hero.*` file, preserving a hand-authored hero.
 * - With `overwrite: true`: regenerates `hero.svg` and removes any other
 *   `assets/hero.*` variants so the freshly generated icon is the one served
 *   (the registry probes `.webp/.png/.jpg/.jpeg` ahead of `.svg`).
 *
 * Also lists `assets` in the plugin's npm `files` so the hero ships with the
 * published package, not just in the source tree.
 */
export async function writeViewHeroAsset(
	pluginDir: string,
	source: ViewHeroSource,
	opts: { overwrite?: boolean } = {},
): Promise<WriteViewHeroResult> {
	if (!opts.overwrite) {
		const existing = await findExistingHero(pluginDir);
		if (existing) return { written: false, absPath: existing };
	}

	const svgPath = path.join(pluginDir, HERO_SVG_RELPATH);
	await fs.mkdir(path.dirname(svgPath), { recursive: true });
	await fs.writeFile(svgPath, generateViewHeroSvgFor(source), "utf8");

	if (opts.overwrite) {
		// Drop higher-priority variants so the regenerated SVG is what gets served.
		for (const ext of HERO_EXTENSIONS) {
			if (ext === ".svg") continue;
			await fs.rm(path.join(pluginDir, "assets", `hero${ext}`), {
				force: true,
			});
		}
	}

	await ensureViewHeroAssetsPublished(pluginDir);
	return { written: true, absPath: svgPath };
}

/**
 * Ensure the plugin's `package.json` `files` array lists `assets`, so the hero
 * is included in the published npm tarball. Returns true when a change was made.
 * Touches only the `files` array region to keep the diff minimal; returns false
 * when there is no `files` array or `assets` is already present.
 */
export async function ensureViewHeroAssetsPublished(
	pluginDir: string,
): Promise<boolean> {
	const pkgPath = path.join(pluginDir, "package.json");
	const raw = await fs.readFile(pkgPath, "utf8");
	const match = raw.match(/(\n([ \t]*)"files"\s*:\s*\[)([\s\S]*?)(\n\2\])/);
	if (!match) return false;

	const [whole, head, baseIndent, body, tail] = match;
	const values = body
		.split("\n")
		.map((line) => line.trim().replace(/,$/, ""))
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as unknown;
			} catch {
				return null;
			}
		})
		.filter((value): value is string => typeof value === "string");

	if (values.includes("assets")) return false;

	const itemIndent = `${baseIndent}  `;
	const rebuiltBody = `\n${["assets", ...values]
		.map((value) => `${itemIndent}${JSON.stringify(value)}`)
		.join(",\n")}`;
	await fs.writeFile(
		pkgPath,
		raw.replace(whole, `${head}${rebuiltBody}${tail}`),
	);
	return true;
}
