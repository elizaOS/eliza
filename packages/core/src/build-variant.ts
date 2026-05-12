/**
 * Build variant — store vs direct.
 *
 * `store` builds (Mac App Store, Microsoft Store, Flathub, etc.) run inside
 * an OS sandbox that forbids forking arbitrary user-installed binaries and
 * restricts filesystem reach to the app's container plus user-granted folders.
 *
 * `direct` builds are the unrestricted user-download artifacts.
 *
 * Resolution: `MILADY_BUILD_VARIANT` → `ELIZA_BUILD_VARIANT` → default `direct`.
 * The variant is decided at process start; we do not refresh it mid-run.
 */

export const BUILD_VARIANTS = ["store", "direct"] as const;
export type BuildVariant = (typeof BUILD_VARIANTS)[number];

export const DEFAULT_BUILD_VARIANT: BuildVariant = "direct";

const VARIANT_VALUES: ReadonlySet<BuildVariant> = new Set(BUILD_VARIANTS);

const DIRECT_DOWNLOAD_URL = "https://milady.so/download";

let resolvedVariant: BuildVariant | null = null;

function readVariantFromEnv(): BuildVariant {
	const raw =
		(typeof process !== "undefined" &&
			(process.env?.MILADY_BUILD_VARIANT ??
				process.env?.ELIZA_BUILD_VARIANT)) ||
		"";
	const normalized = raw.trim().toLowerCase();
	if (VARIANT_VALUES.has(normalized as BuildVariant)) {
		return normalized as BuildVariant;
	}
	return "direct";
}

export function getBuildVariant(): BuildVariant {
	if (resolvedVariant === null) {
		resolvedVariant = readVariantFromEnv();
	}
	return resolvedVariant;
}

export function getDirectDownloadUrl(): string {
	return DIRECT_DOWNLOAD_URL;
}

export function isStoreBuild(): boolean {
	return getBuildVariant() === "store";
}

export function isDirectBuild(): boolean {
	return getBuildVariant() === "direct";
}

/** Test hook only. Resets cached variant so tests can swap env vars. */
export function _resetBuildVariantForTests(): void {
	resolvedVariant = null;
}
