import process from "node:process";

export const ELIZA_GITHUB_REPOSITORY = "elizaos/eliza";
const CDN_ORIGIN = "https://cdn.jsdelivr.net/gh";
const RAW_GITHUB_ORIGIN = "https://raw.githubusercontent.com";
const HOMEPAGE_ASSET_ROOT = "packages/homepage/public";

function normalizeReleaseTag(value) {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  return normalized.startsWith("v") ? normalized : `v${normalized}`;
}

export function resolveElizaReleaseTag({ env = process.env } = {}) {
  return normalizeReleaseTag(
    env.ELIZA_RELEASE_TAG || env.RELEASE_TAG || env.GITHUB_REF_NAME,
  );
}

export function resolveElizaAssetRepository({ env = process.env } = {}) {
  const configured =
    env.ELIZA_ASSET_GITHUB_REPOSITORY?.trim() || env.GITHUB_REPOSITORY?.trim();
  return configured || ELIZA_GITHUB_REPOSITORY;
}

export function isCanonicalElizaRepository(repository) {
  return repository === ELIZA_GITHUB_REPOSITORY;
}

export function buildJsDelivrAssetBase({
  repository = ELIZA_GITHUB_REPOSITORY,
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
  repository = ELIZA_GITHUB_REPOSITORY,
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
  repository = ELIZA_GITHUB_REPOSITORY,
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
  repository = ELIZA_GITHUB_REPOSITORY,
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

export function resolveElizaAssetBaseUrls({
  env = process.env,
  releaseTag = resolveElizaReleaseTag({ env }),
  repository = resolveElizaAssetRepository({ env }),
} = {}) {
  const explicitAppBase =
    env.VITE_ASSET_BASE_URL?.trim() || env.ELIZA_ASSET_BASE_URL?.trim() || "";
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
        assetRoot: "packages/app/public",
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
