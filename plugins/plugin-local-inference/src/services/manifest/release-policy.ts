/**
 * Classifies bundle manifests by the release guarantees they claim. Runtime
 * consumers and manifest validation share this boundary so candidate artifacts
 * remain testable without weakening the provenance bar for production releases.
 */

const STRICT_RELEASE_STATES: ReadonlySet<string> = new Set([
	"base-v1",
	"finetuned-v2",
	"final",
]);

const STAGING_VERSION_TOKENS: ReadonlySet<string> = new Set([
	"candidate",
	"staged",
	"dev",
	"local",
]);

function isStagingManifestVersion(version: string): boolean {
	const prerelease = version.match(
		/^[0-9]+\.[0-9]+\.[0-9]+-([^+]+)(?:\+.*)?$/,
	)?.[1];
	if (!prerelease) return false;
	return prerelease
		.split(/[.-]/)
		.some((token) => STAGING_VERSION_TOKENS.has(token.toLowerCase()));
}

export function claimsStrictRelease(
	input: unknown,
	options: { allowVersionStaging?: boolean } = {},
): boolean {
	if (!input || typeof input !== "object") return true;
	const manifest = input as {
		defaultEligible?: unknown;
		version?: unknown;
		provenance?: unknown;
	};
	if (manifest.defaultEligible === true) return true;

	const provenance =
		manifest.provenance && typeof manifest.provenance === "object"
			? (manifest.provenance as { releaseState?: unknown })
			: undefined;
	const releaseState = provenance?.releaseState;
	if (typeof releaseState === "string") {
		return STRICT_RELEASE_STATES.has(releaseState);
	}

	return !(
		options.allowVersionStaging === true &&
		typeof manifest.version === "string" &&
		isStagingManifestVersion(manifest.version)
	);
}
