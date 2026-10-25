/**
 * Filesystem path resolvers for the local-inference state tree (root, models
 * dir, registry.json, downloads staging), all anchored under `resolveStateDir()`
 * so `ELIZA_STATE_DIR` relocates them. Includes the containment check used to
 * keep downloads and registry writes inside the local-inference root.
 */
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";

export function localInferenceRoot(): string {
	return path.join(resolveStateDir(), "local-inference");
}

export function elizaModelsDir(): string {
	return path.join(localInferenceRoot(), "models");
}

export function registryPath(): string {
	return path.join(localInferenceRoot(), "registry.json");
}

export function downloadsStagingDir(): string {
	return path.join(localInferenceRoot(), "downloads");
}

export function isWithinElizaRoot(target: string): boolean {
	const root = path.resolve(localInferenceRoot());
	const resolved = path.resolve(target);
	return isSubpath(resolved, root);
}

function isSubpath(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	return (
		relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
	);
}

function looksAbsolute(input: string): boolean {
	return (
		path.isAbsolute(input) ||
		/^[A-Za-z]:[\\/]/.test(input) ||
		input.startsWith("\\\\")
	);
}

function normalizeRelativeStoredPath(input: string): string | null {
	const normalized = input.trim().replaceAll("\\", "/");
	if (!normalized || normalized.includes("\0") || looksAbsolute(normalized)) {
		return null;
	}
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length === 0) return null;
	if (parts.some((part) => part === "." || part === "..")) return null;
	return parts.join("/");
}

/**
 * Convert an Eliza-owned artifact path to a stable registry value.
 *
 * Mobile app containers can be re-created with a new absolute root on every
 * install, so owned model artifacts must be persisted relative to the current
 * `local-inference/` root and re-anchored on read.
 */
export function toLocalInferenceStoredPath(target: string): string | null {
	const root = path.resolve(localInferenceRoot());
	const resolved = path.resolve(target);
	if (!isSubpath(resolved, root)) return null;
	return path.relative(root, resolved).split(path.sep).join("/");
}

/**
 * Hydrate a persisted model artifact path against the current local-inference
 * root. Accepts the new relative format and legacy absolute rows whose
 * container prefix changed but still contain a `/local-inference/...` suffix.
 */
export function resolveLocalInferenceStoredPath(stored: string): string | null {
	const trimmed = stored.trim();
	if (!trimmed || trimmed.includes("\0")) return null;
	const root = path.resolve(localInferenceRoot());
	const relative = normalizeRelativeStoredPath(trimmed);
	if (relative) return path.join(root, ...relative.split("/"));

	const resolved = path.resolve(trimmed);
	if (isSubpath(resolved, root)) return resolved;

	const marker = "/local-inference/";
	const normalizedAbsolute = trimmed.replaceAll("\\", "/");
	const markerIndex = normalizedAbsolute.indexOf(marker);
	if (markerIndex < 0) return null;

	const legacyRelative = normalizeRelativeStoredPath(
		normalizedAbsolute.slice(markerIndex + marker.length),
	);
	return legacyRelative ? path.join(root, ...legacyRelative.split("/")) : null;
}
