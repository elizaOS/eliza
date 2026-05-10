/**
 * Re-export of @elizaos/core's build-variant module so callers can import
 * from the conventional `app-core/src/runtime/build-variant` path. The
 * canonical implementation lives in @elizaos/core to avoid any layer that
 * needs the variant having to take a hard dependency on app-core.
 */

export {
  _resetBuildVariantForTests,
  type BuildVariant,
  getBuildVariant,
  getDirectDownloadUrl,
} from "@elizaos/core";
