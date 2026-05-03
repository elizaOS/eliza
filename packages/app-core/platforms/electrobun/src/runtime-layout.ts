import fs from "node:fs";
import path from "node:path";
import { readBuiltPreloadScript } from "./preload-validation";

type ExistsSyncLike = Pick<typeof fs, "existsSync">;

function usesWindowsPathSyntax(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\");
}

function joinPortable(base: string, ...parts: string[]): string {
	return usesWindowsPathSyntax(base)
		? path.win32.join(base, ...parts)
		: path.posix.join(base, ...parts);
}

function resolveRelativePortable(base: string, relativePath: string): string {
	return usesWindowsPathSyntax(base)
		? path.win32.resolve(base, relativePath)
		: path.posix.resolve(base, relativePath);
}

function dirnamePortable(value: string): string {
	return usesWindowsPathSyntax(value)
		? path.win32.dirname(value)
		: path.posix.dirname(value);
}

function isMacAppBundle(
	bundlePath: string,
	platform: NodeJS.Platform,
): boolean {
	return (
		platform === "darwin" && bundlePath.replaceAll("\\", "/").endsWith(".app")
	);
}

function resolvePackagedBundlePath(
	execPath: string,
	platform: NodeJS.Platform,
): string | null {
	const normalizedExecPath = execPath.replaceAll("\\", "/");
	const appBundleMatch = normalizedExecPath.match(/^(.*?\.app)(?:\/|$)/);
	if (appBundleMatch) {
		return usesWindowsPathSyntax(execPath)
			? appBundleMatch[1].replaceAll("/", "\\")
			: appBundleMatch[1];
	}

	if (platform !== "win32" && !normalizedExecPath.includes("/bin/")) {
		return null;
	}

	const binSegment = normalizedExecPath.lastIndexOf("/bin/");
	if (binSegment < 0) {
		return null;
	}

	const bundlePath = normalizedExecPath.slice(0, binSegment);
	if (!bundlePath) {
		return null;
	}

	return usesWindowsPathSyntax(execPath)
		? bundlePath.replaceAll("/", "\\")
		: bundlePath;
}

function getPackagedAppRootCandidates(
	execPath: string,
	platform: NodeJS.Platform,
): string[] {
	const bundlePath = resolvePackagedBundlePath(execPath, platform);
	if (!bundlePath) {
		return [];
	}

	if (isMacAppBundle(bundlePath, platform)) {
		return [joinPortable(bundlePath, "Contents", "Resources", "app")];
	}

	return [
		joinPortable(bundlePath, "resources", "app"),
		joinPortable(bundlePath, "Resources", "app"),
	];
}

function chooseFirstExisting(
	candidates: string[],
	existsSync: ExistsSyncLike["existsSync"],
): string | null {
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return candidates[0] ?? null;
}

export function resolveRendererAssetDir(
	moduleDir: string,
	execPath: string = process.execPath,
	platform: NodeJS.Platform = process.platform,
	fileSystem: ExistsSyncLike = fs,
): string {
	const candidates = [
		...getPackagedAppRootCandidates(execPath, platform).map((root) =>
			joinPortable(root, "renderer"),
		),
		resolveRelativePortable(moduleDir, "../renderer"),
	];

	return (
		chooseFirstExisting(candidates, fileSystem.existsSync) ??
		candidates[candidates.length - 1] ??
		"renderer"
	);
}

export function readResolvedPreloadScript(
	moduleDir: string,
	execPath: string = process.execPath,
	platform: NodeJS.Platform = process.platform,
	fileSystem: ExistsSyncLike = fs,
): string {
	return readBuiltPreloadScript(
		resolvePreloadBaseDir(moduleDir, execPath, platform, fileSystem),
	);
}

export function resolvePreloadBaseDir(
	moduleDir: string,
	execPath: string = process.execPath,
	platform: NodeJS.Platform = process.platform,
	fileSystem: ExistsSyncLike = fs,
): string {
	const candidates = [
		...getPackagedAppRootCandidates(execPath, platform).map((root) =>
			joinPortable(root, "bun"),
		),
		moduleDir,
	];
	const preloadPath = chooseFirstExisting(
		candidates.map((candidate) => joinPortable(candidate, "preload.js")),
		fileSystem.existsSync,
	);
	return preloadPath
		? dirnamePortable(preloadPath)
		: (candidates[candidates.length - 1] ?? moduleDir);
}
