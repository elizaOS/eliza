/** Owns android shared tree using the shared build context and existing platform contracts. */
import path from "node:path";
import { APP, androidDir, platformsDir } from "../context.mjs";

export function packageNameToPath(packageName) {
  return path.join(...packageName.split("."));
}

export function assertSharedTreeOnlyForEliza(what) {
  if (
    APP.appId !== "ai.elizaos.app" &&
    path.resolve(androidDir) === path.resolve(platformsDir, "android")
  ) {
    throw new Error(
      `[mobile-build] Refusing to ${what} for brand '${APP.appId}' in the shared elizaOS android tree (${androidDir}). ` +
        "Whitelabel builds must use apps/app/android (set ELIZA_ANDROID_USE_APP_DIR=1); the elizaOS build owns the shared tree.",
    );
  }
}
