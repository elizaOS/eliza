/**
 * @module plugin-app-control/protected-apps
 *
 * Resolves the canonical set of "protected" app names that callers must not
 * be able to override via `APP load_from_directory` (or any future
 * delete/uninstall flow).
 *
 * The protected set is the union of two sources:
 *
 *   1. `ELIZA_PROTECTED_APPS` — comma-separated names the operator has
 *      explicitly locked.
 *   2. First-party apps shipped in this repo under `eliza/apps/` — every
 *      subdirectory there is implicitly protected so a malicious or careless
 *      `load_from_directory` cannot register a foreign package under a
 *      first-party slug (e.g., `@elizaos/app-companion`).
 *
 * Lookups are case-insensitive and accept the full package name
 * (`@scope/app-foo`), the package basename (`app-foo`), or the suffix
 * without the `app-` prefix (`foo`). Whichever form the caller's
 * package.json declares, a collision against any of these forms blocks
 * registration.
 *
 * This module is the single source of truth for the protected-apps logic.
 * Other plugin code must call `resolveProtectedApps` / `isProtected` rather
 * than re-splitting the env var or re-scanning `eliza/apps/` itself.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface ProtectedAppsResolution {
	/**
	 * Raw, trimmed, non-empty contributions from `ELIZA_PROTECTED_APPS`.
	 * Surfaced as a diagnostic field so the rejection log entry can attribute
	 * a refusal to env vs. first-party-dir; not used at the lookup hot path.
	 */
	fromEnv: string[];
	/**
	 * Discovered first-party app subdir names from `eliza/apps/`. Same
	 * diagnostic role as `fromEnv` — kept on the public type so rejection
	 * logs and tests can introspect which source seeded the protected name.
	 */
	fromFirstPartyDir: string[];
	/**
	 * Canonical lookup set, lowercased. For every contributing name we add
	 * the full string and — when applicable — both the package basename
	 * (after stripping `@scope/`) and the basename with the `app-` prefix
	 * removed. `isProtected` consults this set.
	 */
	set: Set<string>;
}

function splitEnvList(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function packageBasename(name: string): string {
	return name.replace(/^@[^/]+\//, "").trim();
}

function expansionsFor(name: string): string[] {
	const lower = name.toLowerCase();
	const out = new Set<string>([lower]);
	const basename = packageBasename(lower);
	if (basename.length > 0) {
		out.add(basename);
		if (basename.startsWith("app-")) {
			const suffix = basename.slice("app-".length);
			if (suffix.length > 0) out.add(suffix);
		}
	}
	return Array.from(out);
}

async function listFirstPartyApps(repoRoot: string): Promise<string[]> {
	const appsDir = path.join(repoRoot, "eliza", "apps");
	const stat = await fs.stat(appsDir).catch(() => null);
	if (!stat?.isDirectory()) return [];

	const entries = await fs.readdir(appsDir, { withFileTypes: true });
	const names: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name.startsWith(".")) continue;
		names.push(entry.name);
	}
	return names;
}

export async function resolveProtectedApps(
	repoRoot: string,
): Promise<ProtectedAppsResolution> {
	const fromEnv = splitEnvList(process.env.ELIZA_PROTECTED_APPS);
	const fromFirstPartyDir = await listFirstPartyApps(repoRoot);

	const set = new Set<string>();
	for (const name of [...fromEnv, ...fromFirstPartyDir]) {
		for (const form of expansionsFor(name)) {
			set.add(form);
		}
	}

	return { fromEnv, fromFirstPartyDir, set };
}

export function isProtected(
	name: string,
	resolution: ProtectedAppsResolution,
): boolean {
	if (typeof name !== "string") return false;
	const trimmed = name.trim();
	if (trimmed.length === 0) return false;
	for (const form of expansionsFor(trimmed)) {
		if (resolution.set.has(form)) return true;
	}
	return false;
}
