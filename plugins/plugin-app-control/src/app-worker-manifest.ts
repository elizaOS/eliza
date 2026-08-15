/**
 * Defines the explicit agent-side worker surface declared by an app manifest.
 * An absent field is reserved for legacy packages; new manifests either opt
 * out with `false` or name the package-relative plugin entry to launch.
 */

import path from "node:path";

export type AppWorkerCapability = false | { entry: string };

export type ParseAppWorkerCapabilityResult =
	| { ok: true; capability: AppWorkerCapability | undefined }
	| { ok: false; path: "elizaos.app.worker"; reason: string };

function validPackageRelativeEntry(value: string): boolean {
	const normalized = value.replace(/\\/g, "/");
	return (
		normalized.length > 0 &&
		!path.posix.isAbsolute(normalized) &&
		!path.win32.isAbsolute(value) &&
		!normalized.split("/").includes("..") &&
		!normalized.includes(":")
	);
}

/** Parses `elizaos.app.worker`; `undefined` alone enables legacy discovery. */
export function parseAppWorkerCapability(
	value: unknown,
): ParseAppWorkerCapabilityResult {
	if (value === undefined) return { ok: true, capability: undefined };
	if (value === false) return { ok: true, capability: false };
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {
			ok: false,
			path: "elizaos.app.worker",
			reason: 'must be false or an object with a package-relative "entry"',
		};
	}
	const entry = (value as Record<string, unknown>).entry;
	if (typeof entry !== "string" || !validPackageRelativeEntry(entry.trim())) {
		return {
			ok: false,
			path: "elizaos.app.worker",
			reason: 'entry must be a non-empty package-relative path without ".."',
		};
	}
	return { ok: true, capability: { entry: entry.trim() } };
}
