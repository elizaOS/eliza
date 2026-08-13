/**
 * Path containment for Agent Plugins 1.0.0 (§4.1).
 *
 * Plugin-relative paths MUST start with `./` and stay inside the plugin root
 * after resolution. realpath MUST remain inside the plugin root (reject
 * escaping symlinks).
 */

import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function isPluginRelativePath(value: string): boolean {
	return value.startsWith("./") && !value.startsWith("./../");
}

export function isInsideRoot(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	if (rel === "") return true;
	if (isAbsolute(rel)) return false;
	if (rel === "..") return false;
	if (rel.startsWith(`..${sep}`)) return false;
	return true;
}

/**
 * Resolve `relativeOrAbsolute` against `pluginRoot` and require the
 * filesystem-resolved path to stay inside the plugin root.
 *
 * Missing targets are allowed if every existing ancestor stays inside the
 * root and the lexical path does not escape.
 */
export async function resolveContained(
	pluginRoot: string,
	target: string,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
	let resolvedRoot: string;
	try {
		resolvedRoot = await realpath(pluginRoot);
	} catch {
		return { ok: false, reason: "plugin root is not resolvable" };
	}

	const absolute = isAbsolute(target) ? target : resolve(pluginRoot, target);
	if (!isInsideRoot(resolvedRoot, absolute) && !isInsideRoot(pluginRoot, absolute)) {
		return { ok: false, reason: `path escapes plugin root: ${target}` };
	}

	try {
		const resolved = await realpath(absolute);
		if (!isInsideRoot(resolvedRoot, resolved)) {
			return { ok: false, reason: `resolved path escapes plugin root: ${target}` };
		}
		return { ok: true, path: resolved };
	} catch {
		// File may not exist yet (e.g. `./bin/echo` declared but not shipped).
		// Walk up to the nearest existing ancestor and ensure it stays inside.
		let cursor = absolute;
		for (;;) {
			const parent = resolve(cursor, "..");
			if (parent === cursor) break;
			try {
				const ancestor = await realpath(parent);
				if (!isInsideRoot(resolvedRoot, ancestor)) {
					return {
						ok: false,
						reason: `resolved ancestor escapes plugin root: ${target}`,
					};
				}
				const remainder = relative(parent, absolute);
				const reconstructed = resolve(ancestor, remainder);
				if (!isInsideRoot(resolvedRoot, reconstructed)) {
					return { ok: false, reason: `path escapes plugin root: ${target}` };
				}
				return { ok: true, path: reconstructed };
			} catch {
				cursor = parent;
			}
		}
		if (!isInsideRoot(resolvedRoot, absolute)) {
			return { ok: false, reason: `path escapes plugin root: ${target}` };
		}
		return { ok: true, path: absolute };
	}
}

export async function isRegularFile(path: string): Promise<boolean> {
	try {
		const stat = await lstat(path);
		return stat.isFile();
	} catch {
		return false;
	}
}

export async function isDirectory(path: string): Promise<boolean> {
	try {
		const stat = await lstat(path);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

export async function isSymlink(path: string): Promise<boolean> {
	try {
		const stat = await lstat(path);
		return stat.isSymbolicLink();
	} catch {
		return false;
	}
}
