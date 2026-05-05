import fs from "node:fs";
import path from "node:path";

type ExistsSyncLike = Pick<typeof fs, "existsSync" | "readFileSync">;

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

function trimToNull(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function resolveBundlePathPortable(
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

function readVersionFromJson(
	versionFilePath: string,
	fileSystem: ExistsSyncLike,
): string | null {
	if (!fileSystem.existsSync(versionFilePath)) {
		return null;
	}

	try {
		const parsed = JSON.parse(
			fileSystem.readFileSync(versionFilePath, "utf8"),
		) as { version?: unknown };
		return typeof parsed.version === "string"
			? trimToNull(parsed.version)
			: null;
	} catch {
		return null;
	}
}

export function resolveDesktopBundleVersion(
	moduleDir: string,
	execPath: string = process.execPath,
	platform: NodeJS.Platform = process.platform,
	fileSystem: ExistsSyncLike = fs,
): string | null {
	const bundlePath = resolveBundlePathPortable(execPath, platform);
	const resourceCandidates = bundlePath
		? platform === "darwin" && bundlePath.replaceAll("\\", "/").endsWith(".app")
			? [joinPortable(bundlePath, "Contents", "Resources", "version.json")]
			: [
					joinPortable(bundlePath, "Resources", "version.json"),
					joinPortable(bundlePath, "resources", "version.json"),
				]
		: [];

	for (const candidate of resourceCandidates) {
		const version = readVersionFromJson(candidate, fileSystem);
		if (version) {
			return version;
		}
	}

	return readVersionFromJson(
		resolveRelativePortable(moduleDir, "../package.json"),
		fileSystem,
	);
}

export function shouldResetWindowsCefProfile(args: {
	currentVersion: string | null;
	previousVersion: string | null;
	cefDirExists: boolean;
}): boolean {
	if (!args.cefDirExists) return false;
	const currentVersion = trimToNull(args.currentVersion);
	if (!currentVersion || currentVersion === "unknown") return false;
	const previousVersion = trimToNull(args.previousVersion);
	return previousVersion !== currentVersion;
}

export function shouldWriteWindowsCefProfileMarker(
	currentVersion: string | null,
): boolean {
	const normalized = trimToNull(currentVersion);
	return Boolean(normalized && normalized !== "unknown");
}
