/**
 * Stored registry model-path resolution shared by the iOS stdio bridge and
 * the mobile device-bridge bootstrap.
 *
 * `local-inference/registry.json` rows persist model paths relative to the
 * current `local-inference/` root because mobile app containers are
 * re-created with a new absolute root on install/update (iOS rotates the
 * data-container UUID; #11669). Legacy rows may still hold absolute paths
 * from a dead container; those are re-anchored by their `/local-inference/`
 * suffix and only accepted when the artifact actually exists on disk.
 */

import { existsSync } from "node:fs";
import path from "node:path";

function looksAbsolute(input: string): boolean {
	return (
		path.isAbsolute(input) ||
		/^[A-Za-z]:[\\/]/.test(input) ||
		input.startsWith("\\\\")
	);
}

/** Normalize a stored container-relative row to `a/b/c` form, or null. */
export function normalizeStoredRelativeModelPath(input: string): string | null {
	const normalized = input.trim().replaceAll("\\", "/");
	if (!normalized || normalized.includes("\0") || looksAbsolute(normalized)) {
		return null;
	}
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length === 0) return null;
	if (parts.some((part) => part === "." || part === "..")) return null;
	return parts.join("/");
}

/** Convert an absolute path under `currentRoot` to its stored relative form. */
export function toStoredModelPath(
	target: string,
	currentRoot: string,
): string | null {
	const root = path.resolve(currentRoot);
	const resolved = path.resolve(target);
	const relative = path.relative(root, resolved);
	if (
		relative === "" ||
		relative.startsWith("..") ||
		path.isAbsolute(relative)
	) {
		return null;
	}
	return relative.split(path.sep).join("/");
}

/** Candidate absolute locations for a stored registry row, most likely first. */
export function storedModelPathCandidates(
	stored: string,
	currentRoot: string,
): string[] {
	const trimmed = stored.trim();
	if (!trimmed || trimmed.includes("\0")) return [];
	const candidates = new Set<string>();
	const relative = normalizeStoredRelativeModelPath(trimmed);
	if (relative) {
		candidates.add(path.join(currentRoot, ...relative.split("/")));
	}
	if (looksAbsolute(trimmed)) {
		candidates.add(trimmed);
		// The iOS simulator exposes the data root as both /private/var and /var.
		candidates.add(trimmed.replace(/^\/private\/var\//, "/var/"));
		const normalizedAbsolute = trimmed.replaceAll("\\", "/");
		const marker = "/local-inference/";
		const markerIndex = normalizedAbsolute.indexOf(marker);
		if (markerIndex >= 0) {
			const legacyRelative = normalizeStoredRelativeModelPath(
				normalizedAbsolute.slice(markerIndex + marker.length),
			);
			if (legacyRelative) {
				candidates.add(path.join(currentRoot, ...legacyRelative.split("/")));
			}
		}
	}
	return [...candidates];
}

/**
 * Resolve a stored registry path against the CURRENT local-inference root,
 * returning the first candidate that exists on disk. Returns null when the
 * artifact is genuinely absent so callers surface a real not-downloaded
 * state instead of loading against a dead container path.
 *
 * `exists` is injectable because the iOS stdio bridge must probe through the
 * mobile fs sandbox proxy rather than raw `node:fs`.
 */
export function resolveStoredModelPath(
	stored: string,
	currentRoot: string,
	exists: (candidate: string) => boolean = existsSync,
): string | null {
	for (const candidate of storedModelPathCandidates(stored, currentRoot)) {
		try {
			if (exists(candidate)) return candidate;
		} catch {
			// error-policy:J3 untrusted-input sanitizing — `exists` is an injected
			// sandbox-fs probe that may throw on a malformed candidate path; treat a
			// throwing probe as "not this candidate" and try the next one.
		}
	}
	return null;
}
