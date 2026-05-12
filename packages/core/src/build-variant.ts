/**
 * Build variant — store vs direct.
 *
 * `store` builds (Mac App Store, Microsoft Store, Flathub, etc.) run inside
 * an OS sandbox that forbids forking arbitrary user-installed binaries and
 * restricts filesystem reach to the app's container plus user-granted folders.
 *
 * `direct` builds are the unrestricted user-download artifacts.
 *
 * Resolution: `ELIZA_BUILD_VARIANT` (legacy `MILADY_BUILD_VARIANT` honored) →
 * default `direct`. The variant is decided at process start; we do not refresh
 * it mid-run.
 */

import { readEnv } from "./utils/read-env.ts";

export const BUILD_VARIANTS = ["store", "direct"] as const;
export type BuildVariant = (typeof BUILD_VARIANTS)[number];

export const DEFAULT_BUILD_VARIANT: BuildVariant = "direct";

const VARIANT_VALUES: ReadonlySet<BuildVariant> = new Set(BUILD_VARIANTS);

const DIRECT_DOWNLOAD_URL = "https://eliza.so/download";

let resolvedVariant: BuildVariant | null = null;

function readVariantFromEnv(): BuildVariant {
	if (typeof process === "undefined") return "direct";
	const raw =
		readEnv("ELIZA_BUILD_VARIANT", ["MILADY_BUILD_VARIANT"]) ?? "";
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
