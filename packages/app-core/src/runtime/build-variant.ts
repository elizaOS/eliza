/** Host distribution policy, shared by native loaders and the application host. */

export {
  _resetBuildVariantForTests,
  BUILD_VARIANTS,
  type BuildVariant,
  DEFAULT_BUILD_VARIANT,
  getBuildVariant,
  getDirectDownloadUrl,
  isDirectBuild,
  isStoreBuild,
} from "@elizaos/shared/platform/build-variant";
