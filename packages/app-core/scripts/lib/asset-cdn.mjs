import process from "node:process";

export const MILADY_GITHUB_REPOSITORY = "milady-ai/milady";
const CDN_ORIGIN = "https://cdn.jsdelivr.net/gh";
const RAW_GITHUB_ORIGIN = "https://raw.githubusercontent.com";
const HOMEPAGE_ASSET_ROOT = "apps/homepage/public";

function normalizeReleaseTag(value) {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  return normalized.startsWith("v") ? normalized : `v${normalized}`;
}

export function resolveMiladyReleaseTag({ env = process.env } = {}) {
  return normalizeReleaseTag(
    env.MILADY_RELEASE_TAG || env.RELEASE_TAG || env.GITHUB_REF_NAME,
  );
}

export function resolveMiladyAssetRepository({ env = process.env } = {}) {
  const configured =
    env.MILADY_ASSET_GITHUB_REPOSITORY?.trim() || env.GITHUB_REPOSITORY?.trim();
  return configured || MILADY_GITHUB_REPOSITORY;
}

export function isCanonicalMiladyRepository(repository) {
  return repository === MILADY_GITHUB_REPOSITORY;
}

export function buildJsDelivrAssetBase({
  repository = MILADY_GITHUB_REPOSITORY,
  releaseTag,
  assetRoot,
}) {
  if (!releaseTag || !assetRoot) {
    return "";
  }
  const normalizedRoot = assetRoot.replace(/^\/+|\/+$/g, "");
  return `${CDN_ORIGIN}/${repository}@${releaseTag}/${normalizedRoot}/`;
}

export function buildRawGitHubAssetBase({
  repository = MILADY_GITHUB_REPOSITORY,
  releaseTag,
  assetRoot,
}) {
  if (!releaseTag || !assetRoot) {
    return "";
  }
  const normalizedRoot = assetRoot.replace(/^\/+|\/+$/g, "");
  return `${RAW_GITHUB_ORIGIN}/${repository}/${releaseTag}/${normalizedRoot}/`;
}

export function buildManagedAssetUrl({
  repository = MILADY_GITHUB_REPOSITORY,
  releaseTag,
  assetRoot,
  assetPath,
}) {
  if (!releaseTag || !assetRoot || !assetPath) {
    return "";
  }

  const normalizedAssetPath = assetPath.replace(/^\/+/, "");
  const base = buildRawGitHubAssetBase({ repository, releaseTag, assetRoot });
  if (!base) return "";
  return new URL(normalizedAssetPath, base).toString();
}

export function buildReleaseValidationAssetUrl({
  repository = MILADY_GITHUB_REPOSITORY,
  releaseTag,
  assetRoot,
  assetPath,
}) {
  if (!releaseTag || !assetRoot || !assetPath) {
    return "";
  }

  const normalizedAssetPath = assetPath.replace(/^\/+/, "");
  const base = buildRawGitHubAssetBase({ repository, releaseTag, assetRoot });
  if (!base) return "";
  return new URL(normalizedAssetPath, base).toString();
}

export function resolveMiladyAssetBaseUrls({
  env = process.env,
  releaseTag = resolveMiladyReleaseTag({ env }),
  repository = resolveMiladyAssetRepository({ env }),
} = {}) {
  const explicitAppBase =
    env.VITE_ASSET_BASE_URL?.trim() || env.MILADY_ASSET_BASE_URL?.trim() || "";
  const explicitHomepageBase =
    env.VITE_HOMEPAGE_ASSET_BASE_URL?.trim() ||
    env.HOMEPAGE_ASSET_BASE_URL?.trim() ||
    "";

  return {
    releaseTag,
    appAssetBaseUrl:
      explicitAppBase ||
      buildJsDelivrAssetBase({
        repository,
        releaseTag,
        assetRoot: "apps/app/public",
      }),
    homepageAssetBaseUrl:
      explicitHomepageBase ||
      buildJsDelivrAssetBase({
        repository,
        releaseTag,
        assetRoot: HOMEPAGE_ASSET_ROOT,
      }),
  };
}
