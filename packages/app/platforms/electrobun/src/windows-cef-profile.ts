import fs from "node:fs";
import {
	joinPortable,
	resolvePackagedBundlePath,
	resolveRelativePortable,
} from "./runtime-layout";

type ExistsSyncLike = Pick<typeof fs, "existsSync" | "readFileSync">;

function trimToNull(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
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
		// error-policy:J3 invalid version JSON -> no version
		return null;
	}
}

export function resolveDesktopBundleVersion(
	moduleDir: string,
	execPath: string = process.execPath,
	platform: NodeJS.Platform = process.platform,
	fileSystem: ExistsSyncLike = fs,
): string | null {
	const bundlePath = resolvePackagedBundlePath(execPath, platform);
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
