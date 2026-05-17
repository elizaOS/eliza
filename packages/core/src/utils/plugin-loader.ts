import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const moduleCache = new Map<string, unknown>();

export interface LoadPluginOptions {
	/** Absolute path to repo root — used to probe local plugin directories */
	repoRoot?: string;
	/** npm scope, defaults to "@elizaos" */
	npmScope?: string;
}

/**
 * Dynamically loads a plugin module, probing in order:
 * 1. Absolute path / relative path (if nameOrPath starts with . or /)
 * 2. Local workspace: <repoRoot>/plugins/<name>/src/index.ts
 * 3. Local workspace: <repoRoot>/packages/<name>/src/index.ts
 * 4. npm: <npmScope>/<name>
 *
 * Results are cached by (nameOrPath + options) so repeated calls pay no extra
 * import cost.
 */
export async function loadPluginModule<T = unknown>(
	nameOrPath: string,
	options: LoadPluginOptions = {},
): Promise<T> {
	const cacheKey = nameOrPath + JSON.stringify(options);
	if (moduleCache.has(cacheKey)) {
		return moduleCache.get(cacheKey) as T;
	}

	const { repoRoot, npmScope = "@elizaos" } = options;
	const errors: string[] = [];

	// Direct path import
	if (nameOrPath.startsWith(".") || nameOrPath.startsWith("/")) {
		const mod = await import(/* @vite-ignore */ resolve(nameOrPath));
		moduleCache.set(cacheKey, mod);
		return mod as T;
	}

	// Strip scope prefix to get bare plugin name
	const bareName = nameOrPath.startsWith("@")
		? nameOrPath.split("/").slice(1).join("/")
		: nameOrPath;

	// Try local workspace paths (local checkout mode)
	if (repoRoot) {
		for (const base of ["plugins", "packages"]) {
			const localPath = join(repoRoot, base, bareName);
			if (existsSync(localPath)) {
				try {
					const mod = await import(/* @vite-ignore */ localPath);
					moduleCache.set(cacheKey, mod);
					return mod as T;
				} catch (e) {
					errors.push(`local ${localPath}: ${e}`);
				}
			}
		}
	}

	// Try npm package
	const npmPath = nameOrPath.startsWith("@")
		? nameOrPath
		: `${npmScope}/${bareName}`;
	try {
		const mod = await import(/* @vite-ignore */ npmPath);
		moduleCache.set(cacheKey, mod);
		return mod as T;
	} catch (e) {
		errors.push(`npm ${npmPath}: ${e}`);
	}

	throw new Error(
		`Failed to load plugin module "${nameOrPath}":\n${errors.join("\n")}`,
	);
}
