/**
 * Shared script library for Asset Cdn capture and packaging helpers used by
 * app automation.
 */
export {
  buildJsDelivrAssetBase,
  buildManagedAssetUrl,
  buildRawGitHubAssetBase,
  buildReleaseValidationAssetUrl,
  ELIZA_GITHUB_REPOSITORY,
  isCanonicalElizaRepository,
  resolveElizaAssetBaseUrls,
  resolveElizaAssetRepository,
  resolveElizaReleaseTag,
} from "../../../app-core/scripts/lib/asset-cdn.mjs";
